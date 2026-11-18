"""Example cases: the first-run seeder, and adding an entry of the catalog to a workspace.

What the cases are, and where each one comes from, is in the catalog
(``tensa.core.example_catalog``). This module does the work on a workspace:

- :func:`seed_example_cases` puts the catalog's default cases in a workspace that holds no
  case file yet, so the file list is not empty on the first start.
- :func:`add_example` copies one entry's files into a workspace, whenever the user asks.
  It never replaces a file unless it is told to, warns when an ANDES file is not the one
  the catalog was written against, and writes ``EXAMPLE-SOURCES.md`` beside the cases: the
  source, citations and licence of everything added, which is not a case file and so is
  not listed as one.
- :func:`example_statuses` is the catalog with what is true of this workspace and this
  machine: whether each case is already in the workspace, whether that file is the one
  TENSA ships (a bundled case only) and whether the file it would copy can be found.

Seeding is best-effort by design: a missing ANDES install, a missing case or a copy that
fails logs a warning and moves on, and server startup is never blocked by it.
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import logging
import os
import re
import stat
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from tensa import __version__, andes_version
from tensa.core.errors import short_repr
from tensa.core.example_catalog import (
    SUPPORTED_CASE_EXTENSIONS,
    CaseFile,
    Catalog,
    Example,
    bundled_cases_dir,
    load_catalog,
    quoted_notice,
)
from tensa.security.paths import (
    WorkspacePathError,
    list_workspace_files,
    open_workspace_file_for_write,
    write_private_temp,
)

__all__ = [
    "SOURCES_FILE",
    "SUPPORTED_CASE_EXTENSIONS",
    "AddResult",
    "AddedFile",
    "ExampleError",
    "ExampleExistsError",
    "ExampleHasNoFileError",
    "ExampleIntegrityError",
    "ExampleSourceMissingError",
    "ExampleStatus",
    "ExampleWriteError",
    "UnknownExampleError",
    "add_example",
    "example_statuses",
    "format_citations",
    "seed_example_cases",
]

log = logging.getLogger("tensa.examples")

# The file beside the cases that records where each added example came from.
SOURCES_FILE = "EXAMPLE-SOURCES.md"

# The sources file is read whole to add to it; a file this big is not one TENSA wrote.
_SOURCES_MAX_BYTES = 1024 * 1024

# Adding to the sources file is read, change, write. Adds overlap in one process (the server
# runs each in a worker thread, an agent can call several at once), and without this two of
# them read the same text and the later write drops the other's section.
_sources_lock = threading.Lock()

_SOURCES_HEADER = (
    "# Example case sources\n\n"
    "TENSA writes this file when it adds an example case to this folder. It records where each "
    "case came from, how to cite it and the licence it is under. It is not a case file. "
    "`tensa examples cite <id> --bibtex` prints the BibTeX of a case.\n"
)


class ExampleError(Exception):
    """An example could not be added; the message says why, for the person who asked."""


class UnknownExampleError(ExampleError):
    """The catalog has no entry of that id."""


class ExampleHasNoFileError(ExampleError):
    """The entry is a link to data TENSA does not hold (kind ``external``)."""


class ExampleSourceMissingError(ExampleError):
    """The file the entry names is not in the installed ANDES or in this package."""


class ExampleIntegrityError(ExampleError):
    """A bundled file is not the one the catalog recorded: the installation is damaged."""


class ExampleExistsError(ExampleError):
    """A file the entry writes is already in the workspace. ``replaceable`` says whether asking
    to replace it would help (it would not for a directory in the way)."""

    def __init__(self, message: str, *, replaceable: bool = True) -> None:
        super().__init__(message)
        self.replaceable = replaceable


class ExampleWriteError(ExampleError):
    """The workspace refused a file (permissions, a full disk)."""


@dataclass(frozen=True)
class AddedFile:
    name: str
    size_bytes: int
    replaced: bool


@dataclass(frozen=True)
class AddResult:
    """What :func:`add_example` did: the entry, each file written (the primary first) and any
    warnings (an ANDES file that differs from the recorded one, a sources file that could not
    be written)."""

    example: Example
    files: tuple[AddedFile, ...]
    warnings: tuple[str, ...]


@dataclass(frozen=True)
class ExampleStatus:
    example: Example
    in_workspace: bool
    available: bool
    # A bundled case whose file is in the workspace but holds other bytes than the one this
    # TENSA ships under that name (see ``_differs_from_shipped``).
    differs: bool = False


def _andes_cases_dir() -> Path | None:
    """Locate the installed ANDES package's ``cases/`` directory.

    ``andes/cases`` is a package directory shipped next to ``andes/__init__.py``. It is
    found without importing ANDES, which takes seconds and is not otherwise needed in the
    server process (only the workers import it). Returns ``None`` (no raise) when ANDES is
    not installed or the directory is absent.
    """
    try:
        spec = importlib.util.find_spec("andes")
    except (ImportError, ValueError):
        return None
    if spec is None:
        return None
    for location in spec.submodule_search_locations or []:
        cases = Path(location).resolve() / "cases"
        if cases.is_dir():
            return cases
    return None


def _source_dir(example: Example) -> Path | None:
    """The folder an entry's file paths are relative to."""
    if example.provenance.kind == "andes":
        return _andes_cases_dir()
    return bundled_cases_dir()


def _lstat(path: Path) -> os.stat_result | None:
    try:
        return os.lstat(path)
    except OSError:
        return None


def _is_regular(path: Path) -> bool:
    info = _lstat(path)
    return info is not None and stat.S_ISREG(info.st_mode)


def _differs_from_shipped(example: Example, workspace: Path) -> bool:
    """Whether a file of a bundled case that is in ``workspace`` is not the one TENSA ships.

    A workspace made by an earlier TENSA holds whatever that release put under the name (the
    WSCC 9 file of 0.5.0 is ANDES's, with no machines), and a user may have edited a copy.
    Add leaves such a file alone, so the list has to say it is not this case's. Only a bundled
    file is compared: a copy from the user's own ANDES is whatever that installation has, and
    Add already says when it is not the recorded one. A file that is not the shipped size is
    not read.
    """
    if example.provenance.kind != "bundled":
        return False
    source = bundled_cases_dir()
    for file in example.files():
        target = workspace / file.name
        found = _lstat(target)
        shipped = _lstat(source / file.path)
        if found is None or not stat.S_ISREG(found.st_mode) or shipped is None:
            continue
        if found.st_size != shipped.st_size:
            return True
        try:
            with open(target, "rb") as handle:
                data = handle.read(shipped.st_size + 1)
        except OSError:
            continue
        if hashlib.sha256(data).hexdigest() != file.sha256:
            return True
    return False


def example_statuses(workspace: Path, catalog: Catalog | None = None) -> list[ExampleStatus]:
    """Every entry of the catalog, with whether its primary file is in ``workspace``, whether
    a bundled file there differs from the one TENSA ships and whether every file it copies can
    be found (always false for an ``external`` entry)."""
    catalog = catalog or load_catalog()
    statuses: list[ExampleStatus] = []
    for example in catalog.examples:
        files = example.files()
        source = _source_dir(example)
        in_workspace = bool(files) and _is_regular(workspace / files[0].name)
        statuses.append(
            ExampleStatus(
                example=example,
                in_workspace=in_workspace,
                available=bool(files)
                and source is not None
                and all(_is_regular(source / file.path) for file in files),
                differs=in_workspace and _differs_from_shipped(example, workspace),
            )
        )
    return statuses


def _read_source(example: Example, file: CaseFile) -> tuple[bytes, str | None]:
    """The bytes of one source file, and a warning when they are not the recorded ones."""
    source = _source_dir(example)
    kind = example.provenance.kind
    if source is None:
        raise ExampleSourceMissingError(
            "ANDES is not installed here, so its example cases cannot be copied"
        )
    try:
        data = (source / file.path).read_bytes()
    except OSError as exc:
        where = f"the installed ANDES {andes_version()}" if kind == "andes" else "this TENSA"
        raise ExampleSourceMissingError(
            f"{where} has no readable {file.path!r} ({exc.strerror or exc})"
        ) from exc
    found = hashlib.sha256(data).hexdigest()
    if found == file.sha256:
        return data, None
    if kind == "bundled":
        raise ExampleIntegrityError(
            f"the bundled file {file.path!r} is not the one TENSA shipped (sha256 {found}, "
            f"expected {file.sha256}); reinstall tensa"
        )
    release = example.provenance.release or "the release it was written against"
    return data, (
        f"{file.path} in the installed ANDES {andes_version()} is not the file TENSA recorded "
        f"for {release} (sha256 {found}, recorded {file.sha256}). It was added as it is, and "
        "results can differ from the ones documented for this case."
    )


def _claim(target: Path, data: bytes, *, overwrite: bool) -> bool:
    """Write ``data`` as ``target`` and say whether it replaced a file.

    The bytes go to a private temp file beside the target first, so a reader never sees a
    partial case. A new name is claimed with a hard link, which fails if the name appeared
    in the meantime, where a rename would replace it (the way an upload does it).
    """
    existed = _lstat(target) is not None
    if existed and not overwrite:
        raise ExampleExistsError(f"{target.name!r} already exists in the workspace")
    tmp = write_private_temp(target.parent, data, prefix=".example.")
    try:
        if existed:
            os.replace(tmp, target)
        else:
            try:
                os.link(tmp, target)
            except FileExistsError as exc:
                raise ExampleExistsError(
                    f"{target.name!r} already exists in the workspace"
                ) from exc
            except OSError:
                # No hard links here (FAT, some network mounts): check, then rename.
                if os.path.lexists(target):
                    raise ExampleExistsError(
                        f"{target.name!r} already exists in the workspace"
                    ) from None
                os.replace(tmp, target)
    finally:
        # Gone after a rename; still there after the link that claimed a new name.
        with contextlib.suppress(OSError):
            tmp.unlink()
    return existed


def add_example(
    example_id: str,
    workspace: Path,
    overwrite: bool = False,
    *,
    catalog: Catalog | None = None,
) -> AddResult:
    """Copy the files of one catalog entry into ``workspace``.

    Raises :class:`UnknownExampleError` for an id the catalog does not have,
    :class:`ExampleHasNoFileError` for a link-only entry, :class:`ExampleSourceMissingError`
    when a file cannot be found, :class:`ExampleExistsError` when a file of the entry is
    already in the workspace and ``overwrite`` is false (nothing is written then, so an
    entry is never half added), and :class:`ExampleWriteError` when the workspace refuses
    a file. A path problem in the workspace raises ``WorkspacePathError``.

    Names are the file names of the catalog, which it checked when it was loaded, and each
    goes through the same write check as an upload.
    """
    catalog = catalog or load_catalog()
    example = catalog.get(example_id)
    if example is None:
        known = ", ".join(e.id for e in catalog.examples)
        raise UnknownExampleError(
            f"there is no example case {short_repr(example_id)} (known: {known})"
        )
    if not example.has_file:
        raise ExampleHasNoFileError(
            f"{example.id!r} is a link to data TENSA does not hold, not a file to add; "
            "its links say where to get it"
        )
    warnings: list[str] = []
    sources: list[tuple[CaseFile, bytes]] = []
    for file in example.files():
        data, warning = _read_source(example, file)
        sources.append((file, data))
        if warning:
            log.warning("%s", warning)
            warnings.append(warning)

    targets: list[Path] = []
    for file, _ in sources:
        with open_workspace_file_for_write(workspace, file.name) as target:
            targets.append(target)
    for target in targets:
        info = _lstat(target)
        if info is not None and not stat.S_ISREG(info.st_mode):
            raise ExampleExistsError(
                f"{target.name!r} exists and is not a regular file", replaceable=False
            )
    taken = [target.name for target in targets if _lstat(target) is not None]
    if taken and not overwrite:
        raise ExampleExistsError(f"{', '.join(repr(name) for name in taken)} already in the workspace")

    written: list[AddedFile] = []
    created: list[Path] = []
    try:
        for (_, data), target in zip(sources, targets, strict=True):
            replaced = _claim(target, data, overwrite=overwrite)
            if not replaced:
                created.append(target)
            written.append(AddedFile(target.name, len(data), replaced))
    except (OSError, ExampleError) as exc:
        # An entry is never left half added: what this call created is taken away again
        # (a file it replaced stays replaced).
        for path in created:
            with contextlib.suppress(OSError):
                path.unlink()
        if isinstance(exc, ExampleError):
            raise
        raise ExampleWriteError(
            f"could not write {example.id!r} into the workspace: {exc.strerror or exc}"
        ) from exc

    problem = _record_sources(workspace, example, [w.name for w in written], warnings)
    if problem:
        warnings.append(problem)
    return AddResult(example=example, files=tuple(written), warnings=tuple(warnings))


def format_citations(example: Example, *, bibtex: bool = False) -> str:
    """The citations of an entry as plain text, or as BibTeX, one block after the other."""
    parts = [c.bibtex if bibtex else c.text for c in example.citations]
    return "\n\n".join(part.strip() for part in parts)


# ---- the sources file -------------------------------------------------------


def _source_line(example: Example) -> str:
    prov = example.provenance
    if prov.kind == "andes":
        text = (
            f"copied from the ANDES installed on this machine (`andes/cases/{prov.path}`), "
            f"which TENSA recorded against {prov.release or 'ANDES'}"
        )
    else:
        text = f"bundled with TENSA as `{prov.path}`"
    if prov.source_url:
        text += f"; source {prov.source_url}"
    if prov.retrieved:
        text += f", retrieved {prov.retrieved.isoformat()}"
    return f"{text}. sha256 `{prov.sha256}`."


def _sources_section(example: Example, names: list[str], warnings: list[str]) -> str:
    licence = example.licence
    licence_text = licence.name + (f" ({licence.url})" if licence.url else "")
    if licence.attribution:
        licence_text += f". {licence.attribution}"
    added = datetime.now(UTC).date().isoformat()
    lines = [
        f"<!-- tensa-example:{example.id} -->",
        f"## {example.title} (`{example.id}`)",
        "",
        f"Added {added} by TENSA {__version__}.",
        "",
        f"- Files: {', '.join(f'`{name}`' for name in names)}",
        f"- Source: {_source_line(example)}",
        f"- Licence: {licence_text}",
        "- Modifications: " + ("; ".join(example.modifications) or "none") + ".",
    ]
    lines += [f"- Caveat: {caveat}" for caveat in example.caveats]
    lines += [f"- Warning: {warning}" for warning in warnings]
    if licence.notice:
        lines += [
            "",
            "The licence asks that this notice appear, in full, in every copy of the data:",
            "",
            *quoted_notice(licence.notice),
        ]
    if example.citations:
        lines += ["", "Cite:", ""]
        lines += [f"- {citation.text}" for citation in example.citations]
    lines.append(f"<!-- /tensa-example:{example.id} -->")
    return "\n".join(lines) + "\n"


def _record_sources(
    workspace: Path, example: Example, names: list[str], warnings: list[str]
) -> str | None:
    """Add (or, for a case that is added again, replace) the entry's section in the sources
    file. Returns a warning when the file could not be written: the cases are in place, so
    this never fails the add. Calls in one process take turns; two processes adding to one
    workspace at the same moment are not coordinated."""
    section = _sources_section(example, names, warnings)
    marker = re.compile(
        rf"<!-- tensa-example:{re.escape(example.id)} -->.*?"
        rf"<!-- /tensa-example:{re.escape(example.id)} -->\n?",
        re.DOTALL,
    )
    try:
        with _sources_lock, open_workspace_file_for_write(workspace, SOURCES_FILE) as target:
            info = _lstat(target)
            if info is None:
                current = _SOURCES_HEADER
            elif info.st_size > _SOURCES_MAX_BYTES:
                raise ExampleWriteError(f"{SOURCES_FILE} is over {_SOURCES_MAX_BYTES} bytes")
            else:
                current = target.read_text(encoding="utf-8", errors="replace")
            if marker.search(current):
                text = marker.sub(lambda _: section, current, count=1)
            else:
                text = current.rstrip("\n") + "\n\n" + section
            _claim(target, text.encode("utf-8"), overwrite=True)
    except (OSError, WorkspacePathError, ExampleError) as exc:
        log.warning("could not update %s: %s", SOURCES_FILE, exc)
        return f"could not update {SOURCES_FILE}: {exc}"
    return None


# ---- first run --------------------------------------------------------------


def seed_example_cases(workspace: Path) -> list[str]:
    """Copy the catalog's default cases into ``workspace`` if it is empty.

    "Empty" means the workspace root contains zero files with a supported case extension
    (hidden files and symlinks excluded, the same rules as the workspace lister). A
    non-empty workspace is left untouched, so the seeder never re-seeds or overwrites user
    files.

    Returns the filenames copied (empty when the workspace already had case files, or
    every copy failed). Never raises: seeding is best-effort and must not crash ``serve``
    startup.
    """
    try:
        if list_workspace_files(workspace, SUPPORTED_CASE_EXTENSIONS):
            return []
        catalog = load_catalog()
        copied: list[str] = []
        for example in catalog.defaults():
            try:
                result = add_example(example.id, workspace, catalog=catalog)
            except (ExampleError, OSError, WorkspacePathError) as exc:
                log.warning("could not seed example case %s: %s", example.id, exc)
                continue
            copied.extend(file.name for file in result.files)
        if copied:
            log.info(
                "seeded %d example file(s) into the empty workspace: %s",
                len(copied),
                ", ".join(copied),
            )
        return copied
    except Exception as exc:  # noqa: BLE001 - seeding must never crash startup
        log.warning("example-case seeding failed: %s", exc)
        return []
