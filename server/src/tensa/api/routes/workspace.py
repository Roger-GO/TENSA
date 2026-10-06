"""Workspace lister, case-file upload + SLD layout sidecar endpoints.

Four endpoints:

- ``GET /workspace/files`` — enumerate supported case files in the workspace
  root (non-recursive, alphabetical, dotfiles + symlinks excluded).
- ``POST /workspace/files?name=<file>[&overwrite=true]`` — add a case file to
  the workspace root. The request body IS the file (not multipart): the cap is
  enforced while the body streams in, so an oversized upload is never buffered
  or spooled to disk first. 32 MiB cap, a file name that is safe on every
  platform and has a supported extension, and no clobbering unless asked.
- ``GET /workspace/layout?case_path=<rel>`` — read the layout sidecar JSON
  adjacent to the case file (``<case_path>.layout.json``). 200 with a JSON
  ``null`` body when absent (a missing sidecar is the normal first-run
  state, not an error — a 404 only fills the browser console with noise).
- ``PUT /workspace/layout?case_path=<rel>`` — write the layout sidecar
  atomically via tempfile + ``os.replace``, mode 0600. 2 MiB cap.

The layout's schema, its versions and the file handling live in
``tensa.core.layout``; both endpoints answer with and store the current schema
version, whichever version the file or the body was written in.

Path validation reuses the helpers in ``security.paths``: ``_reject_unsafe_input``
for the client-supplied ``case_path``, ``open_workspace_file_for_write`` for
the write path (uploads too), and the existing within-workspace check on read.
"""

from __future__ import annotations

import contextlib
import logging
import os
import stat
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, Response, status
from starlette.concurrency import run_in_threadpool
from starlette.requests import ClientDisconnect

from tensa.api.schemas import (
    ProblemDetails,
    SidecarLayout,
    UploadedWorkspaceFile,
    WorkspaceFile,
    WorkspaceFileList,
)
from tensa.core.layout import (
    LAYOUT_SIDECAR_SUFFIX,
    MAX_LAYOUT_BYTES,
    LayoutError,
    parse_layout,
    write_layout_file,
)
from tensa.security.names import legacy_names_possible, portable_name_problem
from tensa.security.paths import (
    WorkspacePathError,
    _check_within_workspace,
    _reject_unsafe_input,
    canonical_directory,
    list_workspace_files,
    open_workspace_file_for_write,
)
from tensa.security.paths import write_private_temp as _write_temp

router = APIRouter()

log = logging.getLogger("tensa.workspace")

_ALLOWED_EXTENSIONS: frozenset[str] = frozenset({".xlsx", ".raw", ".dyr", ".json", ".m"})

# Layout sidecar body cap, and what a sidecar's name adds to its case's
# (``ieee14.raw.layout.json``); both belong to the layout module.
_MAX_LAYOUT_BYTES = MAX_LAYOUT_BYTES
_LAYOUT_SIDECAR_SUFFIX = LAYOUT_SIDECAR_SUFFIX

# Case-file upload cap: 32 MiB. A RAW, xlsx or MATPOWER case of tens of thousands
# of buses is a few MB; the cap only stops a runaway body.
MAX_UPLOAD_BYTES = 32 * 1024 * 1024

# The longest file name the common file systems accept, in UTF-8 bytes.
_MAX_NAME_BYTES = 255


def _workspace(request: Request) -> Path:
    workspace = getattr(request.app.state, "workspace", None)
    if workspace is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="workspace is not configured",
        )
    if not isinstance(workspace, Path):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="workspace is misconfigured",
        )
    return workspace


def _format_for(path: Path) -> str | None:
    """Return the lister ``format`` field for a file, or None to drop it."""
    suffix = path.suffix.lower().lstrip(".")
    if suffix in {"xlsx", "raw", "dyr", "json", "m"}:
        return suffix
    return None


def _layout_sidecar_path(workspace: Path, case_path: str) -> Path:
    """Compute the resolved sidecar path for a given case file path.

    The sidecar lives at ``<case_path>.layout.json`` in the same directory as
    the case file. The case file itself does NOT need to exist for the
    sidecar to exist (e.g., the user may save a layout before pasting in the
    case data).
    """
    _reject_unsafe_input(case_path)
    workspace = canonical_directory(workspace)
    candidate = (workspace / case_path).expanduser()
    sidecar_name = candidate.name + _LAYOUT_SIDECAR_SUFFIX
    parent = candidate.parent
    try:
        parent_exists = parent.exists()
        parent_is_symlink = parent.is_symlink()
    except OSError as exc:
        # e.g. permission denied on an ancestor: a client error, not a 500.
        raise WorkspacePathError(
            f"path rejected (cannot resolve): {case_path!r}: {exc}"
        ) from exc
    if not parent_exists:
        raise WorkspacePathError(
            f"parent directory does not exist: {case_path!r}"
        )
    if parent_is_symlink:
        raise WorkspacePathError(
            f"refusing to read under a symlinked parent directory: {case_path!r}"
        )
    canonical_parent = canonical_directory(parent)
    _check_within_workspace(workspace, canonical_parent)
    return canonical_parent / sidecar_name


@router.get(
    "/workspace/files",
    openapi_extra={"x-tensa-gui-location": "left-sidebar"},
    operation_id="listWorkspaceFiles",
    summary="List supported case files in the workspace root.",
    response_model=WorkspaceFileList,
)
async def list_files(
    request: Request,
) -> WorkspaceFileList:
    """Return a sorted list of files in the workspace root whose extension
    matches the supported set. Non-recursive; excludes hidden files
    and symlinks.
    """
    workspace = _workspace(request)
    try:
        paths = list_workspace_files(workspace, _ALLOWED_EXTENSIONS)
    except WorkspacePathError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc
    files: list[WorkspaceFile] = []
    for p in paths:
        try:
            stat = p.stat()
        except OSError:
            continue
        fmt = _format_for(p)
        if fmt is None:
            continue
        modified = datetime.fromtimestamp(stat.st_mtime, tz=UTC).isoformat()
        files.append(
            WorkspaceFile(
                name=p.name,
                size_bytes=int(stat.st_size),
                modified_iso=modified,
                format=fmt,  # type: ignore[arg-type]
            )
        )
    return WorkspaceFileList(files=files)


class _UploadConflictError(Exception):
    """The name an upload targets is taken (or is not a file), and the caller did
    not ask to replace it."""


def _check_upload_name(name: str) -> None:
    """Refuse an upload name that is not a plain, listed, loadable file name.

    400 when the name is unsafe or is not one file name: the same portable-name
    rule as every other client-supplied name (``security.names``), plus no
    separators (the lister does not recurse, and the write check looks only at the
    last component, so it would accept ``sub/x.raw``), no leading dot (the lister
    hides such files) and the length a file system takes. 422 when the name is
    well formed but not a case format, which a layout sidecar is not: it is
    written by ``PUT /workspace/layout``, which caps and validates it.
    """
    if "/" in name or "\\" in name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"unsafe file name {name!r}: the name is a path, not a file name",
        )
    problem = portable_name_problem(name)
    if problem is None and name.startswith("."):
        problem = "starts with a dot, so the workspace would not list it"
    if problem is None and len(name.encode("utf-8")) > _MAX_NAME_BYTES:
        problem = f"is longer than {_MAX_NAME_BYTES} bytes"
    if problem is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"unsafe file name {name!r}: the name {problem}",
        )
    suffix = Path(name).suffix.lower()
    if suffix not in _ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                f"unsupported file type {suffix or '(no extension)'!r} for {name!r}: "
                f"the workspace holds {', '.join(sorted(_ALLOWED_EXTENSIONS))} files"
            ),
        )
    if name.lower().endswith(_LAYOUT_SIDECAR_SUFFIX):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                f"{name!r} is a layout sidecar, not a case: "
                "layout sidecars are written with PUT /workspace/layout"
            ),
        )


async def _read_upload_body(request: Request) -> bytes:
    """The request body, refused with 413 as soon as it passes ``MAX_UPLOAD_BYTES``.

    A declared ``Content-Length`` over the cap is refused before a byte is read,
    and a body with none (chunked) is counted as it arrives, so neither is ever
    held in memory or spooled to disk past the cap.
    """
    declared = request.headers.get("content-length", "")
    too_large = HTTPException(
        status_code=status.HTTP_413_CONTENT_TOO_LARGE,
        detail=f"upload exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB",
    )
    if declared.isdigit() and int(declared) > MAX_UPLOAD_BYTES:
        raise too_large
    chunks: list[bytes] = []
    total = 0
    try:
        async for chunk in request.stream():
            total += len(chunk)
            if total > MAX_UPLOAD_BYTES:
                raise too_large
            chunks.append(chunk)
    except ClientDisconnect as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="the upload was interrupted before the whole file arrived",
        ) from exc
    return b"".join(chunks)


@router.post(
    "/workspace/files",
    openapi_extra={
        "x-tensa-gui-location": "left-sidebar",
        "requestBody": {
            "required": True,
            "description": (
                "The file's bytes, verbatim. Not multipart form data: a "
                "``multipart/*`` body is refused with 415."
            ),
            "content": {
                "application/octet-stream": {"schema": {"type": "string", "format": "binary"}}
            },
        },
    },
    operation_id="uploadWorkspaceFile",
    summary="Add a case file to the workspace; the request body is the file.",
    response_model=UploadedWorkspaceFile,
    status_code=status.HTTP_201_CREATED,
    responses={
        400: {
            "model": ProblemDetails,
            "description": (
                "The name is unsafe or is not a single file name: a path, a "
                "leading dot, a character or device name Windows would misread "
                "(``CON.raw``, ``a:b.raw``), a trailing dot or space, or too long."
            ),
        },
        409: {
            "model": ProblemDetails,
            "description": (
                "The workspace already has a file of that name and "
                "``overwrite`` was not set (or the name is a directory)."
            ),
        },
        413: {
            "model": ProblemDetails,
            "description": f"The body is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB.",
        },
        415: {
            "model": ProblemDetails,
            "description": "The body was sent as multipart form data instead of the raw file.",
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "The extension is not one of ``.xlsx``, ``.raw``, ``.dyr``, "
                "``.json``, ``.m``, the name is a layout sidecar "
                "(``<case>.layout.json``, written by ``PUT /workspace/layout``), "
                "or the file is empty."
            ),
        },
        500: {
            "model": ProblemDetails,
            "description": "The file could not be written (full disk, permissions).",
        },
    },
)
async def upload_file(
    request: Request,
    name: str = Query(
        ...,
        description=(
            "File name to store the upload under, in the workspace root. A "
            "single name (no directories) with one of the case extensions "
            "(``.xlsx``, ``.raw``, ``.dyr``, ``.json``, ``.m``)."
        ),
    ),
    overwrite: bool = Query(
        False,
        description=(
            "Replace a file of the same name. When ``false`` (the default) an "
            "existing file is left alone and the request answers 409."
        ),
    ),
) -> UploadedWorkspaceFile:
    """Store the request body as ``<workspace>/<name>``.

    The body is the file itself (``curl --data-binary @ieee14.raw``), written
    atomically, so a half-written case never shows up in the lister. The name goes
    through the portable-name rule, and a name that exists is never replaced
    unless ``overwrite=true``: the check happens when the file is put in place, so
    two uploads of one name cannot both win.
    """
    workspace = _workspace(request)
    _check_upload_name(name)
    if request.headers.get("content-type", "").lower().startswith("multipart/"):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=(
                "send the file's bytes as the request body, not as multipart form "
                "data (for curl: --data-binary @file)"
            ),
        )
    data = await _read_upload_body(request)
    if not data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"{name!r} is empty",
        )
    try:
        with open_workspace_file_for_write(workspace, name) as target:
            replaced = await run_in_threadpool(_store_upload, target, data, overwrite=overwrite)
            info = target.stat()
    except WorkspacePathError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except _UploadConflictError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc
    except OSError as exc:
        log.warning("could not store upload %r: %s", name, exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"could not store {name!r}: {exc}",
        ) from exc
    fmt = _format_for(target)
    assert fmt is not None  # the extension was checked above
    return UploadedWorkspaceFile(
        name=target.name,
        size_bytes=int(info.st_size),
        modified_iso=datetime.fromtimestamp(info.st_mtime, tz=UTC).isoformat(),
        format=fmt,  # type: ignore[arg-type]
        replaced=replaced,
    )


def _store_upload(target: Path, data: bytes, *, overwrite: bool) -> bool:
    """Write ``data`` as ``target`` and say whether it replaced a file.

    The bytes go to a temp file beside the target first, so a reader never sees a
    partial case. A new name is claimed with a hard link, which fails if the name
    appeared in the meantime, instead of a rename, which would replace it.
    """
    try:
        existing: os.stat_result | None = os.lstat(target)
    except FileNotFoundError:
        existing = None
    if existing is not None:
        if not stat.S_ISREG(existing.st_mode):
            raise _UploadConflictError(f"{target.name!r} exists and is not a regular file")
        if not overwrite:
            raise _UploadConflictError(
                f"{target.name!r} already exists in the workspace; "
                "send overwrite=true to replace it"
            )
    tmp_path = _write_temp(target.parent, data, prefix=".upload.")
    try:
        if existing is None:
            _publish_new(tmp_path, target)
        else:
            os.replace(tmp_path, target)
    finally:
        # Gone after a rename; still there after the link that claimed a new name.
        with contextlib.suppress(OSError):
            tmp_path.unlink()
    return existing is not None


def _publish_new(tmp_path: Path, target: Path) -> None:
    """Give ``tmp_path``'s content the name ``target``, which must not exist.

    ``os.link`` fails with ``FileExistsError`` when another request created the
    name first. A file system with no hard links (FAT, some network mounts) falls
    back to a check and a rename, which leaves a small window between the two.
    """
    try:
        os.link(tmp_path, target)
    except FileExistsError as exc:
        raise _UploadConflictError(f"{target.name!r} already exists in the workspace") from exc
    except OSError:
        if os.path.lexists(target):
            raise _UploadConflictError(
                f"{target.name!r} already exists in the workspace"
            ) from None
        os.replace(tmp_path, target)


@router.get(
    "/workspace/layout",
    openapi_extra={"x-tensa-gui-location": "workspace"},
    operation_id="getWorkspaceLayout",
    summary="Read the SLD layout sidecar JSON adjacent to a case file.",
    response_model=SidecarLayout | None,
    responses={
        400: {
            "model": ProblemDetails,
            "description": "Workspace path validation failed.",
        },
        422: {
            "model": ProblemDetails,
            "description": "Sidecar exists but does not match the SidecarLayout schema.",
        },
    },
)
async def get_layout(
    request: Request,
    case_path: str = Query(
        ...,
        description=(
            "Workspace-relative path of the case file the sidecar is paired "
            "with. The sidecar is read from ``<case_path>.layout.json``."
        ),
    ),
) -> SidecarLayout | None:
    """Read the layout sidecar for ``case_path``.

    A missing sidecar is the normal first-run state for any case, so it is
    NOT an error: the endpoint returns 200 with a JSON ``null`` body (the
    web client already maps "no sidecar" to a null layout; previously this
    was a 404, which browsers log as a console error on every case open).
    """
    workspace = _workspace(request)
    try:
        sidecar = _layout_sidecar_path(workspace, case_path)
    except WorkspacePathError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    if not sidecar.exists():
        return None
    try:
        raw = sidecar.read_text(encoding="utf-8")
    except OSError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"could not read sidecar: {exc}",
        ) from exc
    try:
        # Validated, and brought to the current schema version when the file
        # was written in an older one.
        return parse_layout(raw)
    except LayoutError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"sidecar is malformed: {exc}",
        ) from exc


def _enforce_layout_content_length(request: Request) -> None:
    """Reject oversized PUT bodies via the ``Content-Length`` header before
    FastAPI parses the body. Runs as a route dependency so a 413 short-circuits
    Pydantic body parsing.
    """
    cl_header = request.headers.get("content-length")
    if cl_header is None:
        return
    try:
        content_length = int(cl_header)
    except ValueError:
        content_length = -1
    if content_length > _MAX_LAYOUT_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=(
                f"layout body exceeds {_MAX_LAYOUT_BYTES} bytes "
                f"(got Content-Length={content_length})"
            ),
        )


@router.put(
    "/workspace/layout",
    openapi_extra={"x-tensa-gui-location": "workspace"},
    operation_id="putWorkspaceLayout",
    summary="Write the SLD layout sidecar JSON adjacent to a case file.",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={
        400: {
            "model": ProblemDetails,
            "description": "Workspace path validation failed.",
        },
        413: {
            "model": ProblemDetails,
            "description": (
                f"Body exceeds the {_MAX_LAYOUT_BYTES // (1024 * 1024)} MiB sidecar cap."
            ),
        },
        422: {
            "model": ProblemDetails,
            "description": "Body did not validate against SidecarLayout.",
        },
    },
)
async def put_layout(
    request: Request,
    layout: SidecarLayout = Body(
        ...,
        description=(
            "SLD layout sidecar payload. Validated against ``SidecarLayout``; "
            "extra fields are rejected (``extra='forbid'``)."
        ),
    ),
    case_path: str = Query(
        ...,
        description=(
            "Workspace-relative path of the case file the sidecar is paired "
            "with. The sidecar is written to ``<case_path>.layout.json``."
        ),
    ),
    _len: None = Depends(_enforce_layout_content_length),
) -> Response:
    workspace = _workspace(request)
    sidecar_rel = case_path + _LAYOUT_SIDECAR_SUFFIX
    try:
        with open_workspace_file_for_write(
            workspace,
            sidecar_rel,
            # The portable-name rule guards names the client picks; the sidecar
            # of a case file that is already in the workspace inherits its name.
            require_portable_name=not _is_existing_case_file(workspace, case_path),
        ) as target:
            write_layout_file(target, layout)
    except WorkspacePathError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _is_existing_case_file(workspace: Path, case_path: str) -> bool:
    """True when ``case_path`` already names a regular file in the workspace.

    Used only to decide which file-name rules the layout sidecar gets: a case
    whose name is legal on Linux and macOS but not portable (``case_12:30.raw``)
    still lists and loads, so its layout must stay savable. Windows cannot hold
    such a name as a plain file (``:`` would be a stream), so there the name
    check always applies, the same answer snapshot restore gets from
    ``legacy_names_possible``. The sidecar path still passes every containment
    check.
    """
    if not legacy_names_possible():
        return False
    try:
        return (workspace / case_path).is_file()
    except (OSError, ValueError):
        return False
