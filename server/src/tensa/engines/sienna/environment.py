"""Where the Sienna engine's Julia runtime is found, and why it cannot start.

The server process asks this module whether a Sienna session could start before it
spawns a worker. It reads the environment at call time and imports nothing of
Julia, juliacall or ANDES, so the check costs nothing on a server that never runs
Sienna. No message it returns holds a full path: a server path must not reach a
client.

A project folder that holds a Manifest is also asked for the stamp
``setup.setup_sienna`` writes when a setup finishes (the SHA-256 of the Manifest
this package ships), so a folder set up by another version of TENSA, or by hand,
is reported rather than used. A developer who manages the Julia project by hand
can say so with ``TENSA_SIENNA_SKIP_STAMP=1``, which skips that one check and no
other; the messages never mention it.
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


def dynamics_module_path() -> Path:
    """The Julia dynamics module, included only when a session needs dynamics."""
    return Path(__file__).resolve().parent / "julia" / "TensaSiennaDyn.jl"


def network_module_path() -> Path:
    """The Julia network matrix module, included only when a session asks for one."""
    return Path(__file__).resolve().parent / "julia" / "TensaSiennaNet.jl"


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
    """The first reason a Sienna session cannot start, or ``None`` when it can.

    In order: no ``juliacall``; no Julia; no Manifest in the project folder; no
    stamp of this TENSA's Manifest there (skipped when ``TENSA_SIENNA_SKIP_STAMP``
    is ``1``, for a project managed by hand); no Julia module in the package.
    """
    if not _juliacall_found():
        return 'juliacall is not installed (pip install "tensa[sienna]")'
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
    if os.environ.get("TENSA_SIENNA_SKIP_STAMP") != "1":
        from tensa.engines.sienna import setup

        if not setup.is_ready(project, setup.packaged_project() / "Manifest.toml"):
            name = Path(os.path.abspath(project)).name
            return (
                f"the Sienna Julia environment at {name} was not set up by this version "
                "of TENSA; run: tensa warm-cache --engine sienna"
            )
    if not module_path().is_file():
        return "the Sienna engine's Julia module is missing from this installation"
    return None
