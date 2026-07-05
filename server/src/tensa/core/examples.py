"""Starter example cases for first-run users.

When ``tensa serve`` starts against a workspace that contains ZERO
supported case files, :func:`seed_example_cases` copies a small set of
well-known example cases from the installed ``andes`` package into the
workspace root so the file picker isn't empty on first launch.

Best-effort by design: a missing ``andes`` install, a missing bundled
case, or a copy failure logs a warning and moves on — server startup is
never blocked by seeding.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

from tensa.security.paths import list_workspace_files

log = logging.getLogger("tensa.examples")

# Mirrors the workspace lister's supported-extension set (see
# ``tensa.api.routes.workspace._ALLOWED_EXTENSIONS``): the workspace
# counts as "empty" only when none of these are present in its root.
SUPPORTED_CASE_EXTENSIONS: frozenset[str] = frozenset(
    {".xlsx", ".raw", ".dyr", ".json", ".m"}
)

# Bundled cases to seed, relative to the andes package's ``cases/`` dir.
# Small, well-documented systems: IEEE 14-bus, Kundur two-area, WSCC 9-bus.
_EXAMPLE_CASES: tuple[str, ...] = (
    "ieee14/ieee14_full.xlsx",
    "kundur/kundur_full.xlsx",
    "wscc9/wscc9.xlsx",
)


def _andes_cases_dir() -> Path | None:
    """Locate the installed andes package's ``cases/`` directory.

    ``andes/cases`` is a package directory shipped next to
    ``andes/__init__.py``. Returns ``None`` (no raise) when andes is not
    importable or the directory is absent.
    """
    try:
        from andes import __file__ as andes_init
    except ImportError:
        return None
    if andes_init is None:  # namespace-package edge; nothing to locate
        return None
    cases = Path(andes_init).resolve().parent / "cases"
    return cases if cases.is_dir() else None


def seed_example_cases(workspace: Path) -> list[str]:
    """Copy bundled ANDES example cases into ``workspace`` if it is empty.

    "Empty" means the workspace root contains zero files with a supported
    case extension (hidden files and symlinks excluded — same rules as the
    workspace lister). A non-empty workspace is left untouched, so the
    seeder never re-seeds or overwrites user files.

    Returns the list of filenames copied (empty when the workspace already
    had case files, andes's bundled cases couldn't be found, or every copy
    failed). Never raises — seeding is best-effort and must not crash
    ``serve`` startup.
    """
    try:
        if list_workspace_files(workspace, SUPPORTED_CASE_EXTENSIONS):
            return []
        cases_dir = _andes_cases_dir()
        if cases_dir is None:
            log.warning(
                "could not locate the andes package's bundled cases; "
                "skipping example-case seeding"
            )
            return []
        copied: list[str] = []
        for rel in _EXAMPLE_CASES:
            src = cases_dir / rel
            if not src.is_file():
                log.warning("bundled example case missing: %s", src)
                continue
            dest = workspace / src.name
            if dest.exists():
                continue
            try:
                shutil.copy2(src, dest)
            except OSError as exc:
                log.warning("could not seed example case %s: %s", src.name, exc)
                continue
            copied.append(dest.name)
        if copied:
            log.info(
                "seeded %d example case(s) into the empty workspace: %s",
                len(copied),
                ", ".join(copied),
            )
        return copied
    except Exception as exc:  # noqa: BLE001 — seeding must never crash startup
        log.warning("example-case seeding failed: %s", exc)
        return []
