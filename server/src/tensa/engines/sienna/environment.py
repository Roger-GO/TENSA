"""Where the Sienna engine's Julia runtime is found, and why it cannot start.

The server process asks this module whether a Sienna session could start before it
spawns a worker. It reads the environment at call time and imports nothing of
Julia, juliacall or ANDES, so the check costs nothing on a server that never runs
Sienna. No message it returns holds a full path: a server path must not reach a
client.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
from pathlib import Path


def julia_executable() -> Path | None:
    """The Julia binary the user asked for, or the one on ``PATH``, or ``None``.

    ``TENSA_JULIA`` names the binary to use; a value that names no existing file
    gives ``None`` rather than falling back to ``PATH``, because the user said
    which Julia they want.
    """
    asked = os.environ.get("TENSA_JULIA")
    if asked:
        path = Path(asked)
        return path if path.is_file() else None
    found = shutil.which("julia")
    return Path(found) if found is not None else None


def sienna_project() -> Path:
    """The Julia environment the engine runs in, pinned by its manifest."""
    asked = os.environ.get("TENSA_SIENNA_PROJECT")
    if asked:
        return Path(asked)
    return Path.home() / ".tensa" / "julia" / "dyn"


def module_path() -> Path:
    """The Julia module the worker loads, shipped with this package."""
    return Path(__file__).resolve().parent / "julia" / "TensaSienna.jl"


def _juliacall_found() -> bool:
    """Whether ``juliacall`` can be imported, found without importing it.

    ``find_spec`` raises where ``sys.modules`` holds a ``juliacall`` with no
    ``__spec__`` (some test doubles) or a parent package cannot be imported; that
    counts as not installed, since the server asks while it answers a request.
    """
    try:
        return importlib.util.find_spec("juliacall") is not None
    except (ImportError, ValueError):
        return False


def sienna_unavailable_reason() -> str | None:
    """The first reason a Sienna session cannot start, or ``None`` when it can."""
    if not _juliacall_found():
        return "juliacall is not installed (pip install juliacall)"
    if julia_executable() is None:
        return "Julia was not found (set TENSA_JULIA or put julia on PATH)"
    project = sienna_project()
    if not (project / "Manifest.toml").is_file():
        # The folder's own name, also for a relative path such as ``.``, whose
        # name is empty until it is made absolute.
        name = Path(os.path.abspath(project)).name
        return (
            "the Sienna Julia environment is not set up at "
            f"{name}; run: tensa warm-cache --engine sienna"
        )
    if not module_path().is_file():
        return "the Sienna engine's Julia module is missing from this installation"
    return None
