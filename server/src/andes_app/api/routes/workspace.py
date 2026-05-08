"""Workspace lister + SLD layout sidecar endpoints.

Three endpoints, all auth-gated via ``RequireToken``:

- ``GET /workspace/files`` — enumerate supported case files in the workspace
  root (non-recursive, alphabetical, dotfiles + symlinks excluded).
- ``GET /workspace/layout?case_path=<rel>`` — read the layout sidecar JSON
  adjacent to the case file (``<case_path>.layout.json``). 404 if absent.
- ``PUT /workspace/layout?case_path=<rel>`` — write the layout sidecar
  atomically via tempfile + ``os.replace``, mode 0600. 256 KB cap.

Path validation reuses the helpers in ``security.paths``: ``_reject_unsafe_input``
for the client-supplied ``case_path``, ``open_workspace_file_for_write`` for
the write path, and the existing within-workspace check on read.
"""

from __future__ import annotations

import contextlib
import logging
import os
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from pydantic import ValidationError

from andes_app.api.auth import RequireToken
from andes_app.api.schemas import (
    ProblemDetails,
    SidecarLayout,
    WorkspaceFile,
    WorkspaceFileList,
)
from andes_app.security.paths import (
    WorkspacePathError,
    list_workspace_files,
    open_workspace_file_for_write,
)

router = APIRouter()

log = logging.getLogger("andes-app.workspace")

_ALLOWED_EXTENSIONS: frozenset[str] = frozenset({".xlsx", ".raw", ".dyr", ".json", ".m"})

# Layout sidecar body cap: 256 KB. Computed once.
_MAX_LAYOUT_BYTES = 256 * 1024


def _workspace(request: Request) -> Path:
    workspace = getattr(request.app.state, "workspace", None)
    if workspace is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="workspace is not configured",
        )
    assert isinstance(workspace, Path)
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
    if "\x00" in case_path:
        raise WorkspacePathError("path contains a NUL byte")
    if Path(case_path).is_absolute():
        raise WorkspacePathError(
            f"absolute paths are not accepted from clients: {case_path!r}"
        )
    candidate = (workspace / case_path).expanduser()
    sidecar_name = candidate.name + ".layout.json"
    parent = candidate.parent
    if not parent.exists():
        raise WorkspacePathError(
            f"parent directory does not exist: {case_path!r}"
        )
    canonical_parent = parent.resolve(strict=True)
    workspace = workspace.resolve(strict=True)
    try:
        canonical_parent.relative_to(workspace)
    except ValueError as exc:
        raise WorkspacePathError(
            f"path resolves outside the workspace: {canonical_parent!s}"
        ) from exc
    return canonical_parent / sidecar_name


@router.get(
    "/workspace/files",
    operation_id="listWorkspaceFiles",
    summary="List supported case files in the workspace root.",
    response_model=WorkspaceFileList,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
    },
)
async def list_files(
    request: Request,
    _: RequireToken,
) -> WorkspaceFileList:
    """Return a sorted list of files in the workspace root whose extension
    matches the supported set. Non-recursive in v0.1; excludes hidden files
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


@router.get(
    "/workspace/layout",
    operation_id="getWorkspaceLayout",
    summary="Read the SLD layout sidecar JSON adjacent to a case file.",
    response_model=SidecarLayout,
    responses={
        400: {
            "model": ProblemDetails,
            "description": "Workspace path validation failed.",
        },
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {"model": ProblemDetails, "description": "Sidecar not found."},
        422: {
            "model": ProblemDetails,
            "description": "Sidecar exists but does not match the SidecarLayout schema.",
        },
    },
)
async def get_layout(
    request: Request,
    _: RequireToken,
    case_path: str = Query(
        ...,
        description=(
            "Workspace-relative path of the case file the sidecar is paired "
            "with. The sidecar is read from ``<case_path>.layout.json``."
        ),
    ),
) -> SidecarLayout:
    workspace = _workspace(request)
    try:
        sidecar = _layout_sidecar_path(workspace, case_path)
    except WorkspacePathError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    if not sidecar.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"layout sidecar does not exist for {case_path!r}",
        )
    try:
        raw = sidecar.read_text(encoding="utf-8")
    except OSError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"could not read sidecar: {exc}",
        ) from exc
    try:
        return SidecarLayout.model_validate_json(raw)
    except ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"sidecar is malformed: {exc.errors()}",
        ) from exc


@router.put(
    "/workspace/layout",
    operation_id="putWorkspaceLayout",
    summary="Write the SLD layout sidecar JSON adjacent to a case file.",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={
        400: {
            "model": ProblemDetails,
            "description": "Workspace path validation failed.",
        },
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        413: {
            "model": ProblemDetails,
            "description": "Body exceeds the 256 KB sidecar cap.",
        },
        422: {
            "model": ProblemDetails,
            "description": "Body did not validate against SidecarLayout.",
        },
    },
)
async def put_layout(
    request: Request,
    _: RequireToken,
    case_path: str = Query(
        ...,
        description=(
            "Workspace-relative path of the case file the sidecar is paired "
            "with. The sidecar is written to ``<case_path>.layout.json``."
        ),
    ),
) -> Response:
    # Cap by Content-Length first (cheap pre-check).
    cl_header = request.headers.get("content-length")
    if cl_header is not None:
        try:
            content_length = int(cl_header)
        except ValueError:
            content_length = -1
        if content_length > _MAX_LAYOUT_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=(
                    f"layout body exceeds {_MAX_LAYOUT_BYTES} bytes "
                    f"(got Content-Length={content_length})"
                ),
            )

    raw = await request.body()
    if len(raw) > _MAX_LAYOUT_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=(
                f"layout body exceeds {_MAX_LAYOUT_BYTES} bytes "
                f"(got {len(raw)} bytes)"
            ),
        )

    try:
        layout = SidecarLayout.model_validate_json(raw)
    except ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"invalid layout body: {exc.errors()}",
        ) from exc

    workspace = _workspace(request)
    sidecar_rel = case_path + ".layout.json"
    try:
        with open_workspace_file_for_write(workspace, sidecar_rel) as target:
            _atomic_write_json(target, layout)
    except WorkspacePathError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _atomic_write_json(target: Path, layout: SidecarLayout) -> None:
    """Write ``layout`` to ``target`` atomically with mode 0600.

    Uses ``tempfile.NamedTemporaryFile`` in the same directory (so
    ``os.replace`` is a same-filesystem rename) and chmods the temp file via
    its fd before flush. On any exception the temp file is unlinked.
    """
    parent = target.parent
    serialized = layout.model_dump_json(indent=2)
    tmp = tempfile.NamedTemporaryFile(  # noqa: SIM115 — context manager would auto-delete
        mode="w",
        encoding="utf-8",
        dir=parent,
        prefix=".layout.",
        suffix=".tmp",
        delete=False,
    )
    tmp_path = Path(tmp.name)
    try:
        # Windows or unusual filesystems may not support fchmod; fall back to
        # post-close chmod.
        with contextlib.suppress(OSError):
            os.fchmod(tmp.fileno(), 0o600)
        tmp.write(serialized)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp.close()
        with contextlib.suppress(OSError):
            os.chmod(tmp_path, 0o600)
        os.replace(tmp_path, target)
    except Exception:
        # Best-effort cleanup; never mask the original exception.
        with contextlib.suppress(Exception):
            tmp.close()
        with contextlib.suppress(OSError):
            tmp_path.unlink()
        raise
