"""Install the Sienna engine's Julia environment (``tensa warm-cache --engine sienna``).

A Sienna session needs three things on the machine: the Python package
``juliacall``, a Julia executable, and a Julia project folder in which the
Sienna packages are installed. This module installs the third: it copies the
``Project.toml`` and ``Manifest.toml`` the package ships (the exact versions
the engine was verified with) into the project folder and asks Julia to
instantiate and precompile them, which downloads the packages from Julia's
registry and takes several minutes the first time. It then checks that the
engine's Julia module loads there, and writes a stamp that
``environment.sienna_unavailable_reason`` reads.

The stamp holds the SHA-256 of the packaged Manifest, so it says which TENSA
environment was installed in the folder. A TENSA that ships another Manifest
finds the stamp stale and asks for the setup again; a change to the Julia
module alone does not, since the worker includes the module from the package
by its path and nothing about it is installed.

The two Julia children run with ``JULIA_LOAD_PATH`` holding the project and
the standard library only, as the worker's Julia does (``bridge.py``), so the
check does not pass on a package found in the user's default environment.
Paths reach Julia as arguments (``--project=`` and ``ARGS``), never inside the
code string, so no file name needs quoting.

Nothing here imports ``juliacall``, and nothing runs at import time.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path

from tensa.engines.sienna import environment

# Written into the project folder when a setup finished.
STAMP = ".tensa-sienna-ready"

# What the first child runs: install every package of the Manifest, then
# precompile them (``JULIA_PKG_PRECOMPILE_AUTO=0`` keeps ``instantiate`` from
# precompiling on its own, so it happens once, in the step that says so).
INSTALL_CODE = "using Pkg; Pkg.instantiate(); Pkg.precompile()"
# What the second runs: include the module named by the first argument and
# print the versions it reports, as one line of JSON.
CHECK_CODE = "include(ARGS[1]); print(TensaSienna.versions_json())"

_JULIA_VERSION_LINE = re.compile(r'^\s*julia_version\s*=\s*"(\d+)\.(\d+)(?:\.\d+)?')
_JULIA_VERSION_OUT = re.compile(r"^julia version (\d+)\.(\d+)\.(\d+)", re.MULTILINE)


def packaged_project() -> Path:
    """The folder of the ``Project.toml`` and ``Manifest.toml`` this package ships."""
    return Path(__file__).resolve().parent / "envs" / "dyn"


def manifest_julia_version(manifest: Path) -> tuple[int, int] | None:
    """The major and minor of the Julia the Manifest was resolved for.

    The version is the ``julia_version = "..."`` line near the top of the
    file; ``None`` when there is none or the file cannot be read.
    """
    try:
        text = manifest.read_text(encoding="utf-8")
    except OSError:
        return None
    for line in text.splitlines()[:20]:
        match = _JULIA_VERSION_LINE.match(line)
        if match is not None:
            return int(match.group(1)), int(match.group(2))
    return None


def julia_version(executable: Path) -> tuple[int, int, int] | None:
    """The version of the Julia at ``executable``, or ``None`` when it cannot be read.

    ``julia --version`` prints ``julia version 1.13.4``; a release candidate
    (``1.11.0-rc1``) or a development build (``1.14.0-DEV.123``) gives its
    three numbers.
    """
    try:
        out = subprocess.run(
            [str(executable), "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    match = _JULIA_VERSION_OUT.search(out.stdout or "")
    if match is None:
        return None
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


def stamp_text(manifest: Path) -> str:
    """The one line a stamp holds: the SHA-256 of the Manifest's bytes."""
    return hashlib.sha256(manifest.read_bytes()).hexdigest()


def is_ready(project: Path, manifest: Path) -> bool:
    """Whether the project holds the stamp of a setup run from this Manifest.

    ``manifest`` is the packaged one, not the copy in the project, which Julia
    may rewrite: the question is whether this TENSA's environment was
    installed here.
    """
    try:
        return (project / STAMP).read_text(encoding="utf-8").strip() == stamp_text(manifest)
    except OSError:
        return False


class SetupError(Exception):
    """A step of the setup failed; the message is written for the user."""


def _child_environment() -> dict[str, str]:
    """The environment of the two Julia children: the caller's, with Julia's own
    precompilation left to the install step and the load path of the worker."""
    return {
        **os.environ,
        "JULIA_PKG_PRECOMPILE_AUTO": "0",
        "JULIA_LOAD_PATH": os.pathsep.join(("@", "@stdlib")),
    }


def _version_text(version: tuple[int, ...]) -> str:
    return ".".join(str(part) for part in version)


def setup_sienna(
    *,
    julia: Path | None = None,
    project: Path | None = None,
    allow_julia_mismatch: bool = False,
    echo: Callable[[str], None] = print,
    run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> Path:
    """Install the Sienna Julia environment and return the project folder.

    ``julia`` is the executable to run (default: the one
    ``environment.julia_executable`` finds) and ``project`` the folder to
    install into (default: ``environment.sienna_project``). Each step is
    announced through ``echo`` in one plain line before it starts; Julia's own
    output of the install goes straight to the console. A step that fails
    raises ``SetupError``. The stamp is removed before anything is copied and
    written only once every step passed, so a setup that fails half way never
    looks finished.
    """
    if importlib.util.find_spec("juliacall") is None:
        raise SetupError(
            "juliacall is not installed; install TENSA with the sienna extra: "
            'pip install "tensa[sienna]"'
        )
    if julia is None:
        julia = environment.julia_executable()
    if julia is None:
        raise SetupError(
            "Julia was not found. Install it (https://julialang.org/install/) or point "
            "TENSA_JULIA at the julia executable, then run this again."
        )
    if project is None:
        project = environment.sienna_project()

    packaged = packaged_project()
    packaged_manifest = packaged / "Manifest.toml"
    module = environment.module_path()

    resolved = manifest_julia_version(packaged_manifest)
    resolved_text = _version_text(resolved) if resolved is not None else "an unknown version"
    found = julia_version(julia)
    if found is None:
        echo(
            f"warning: could not read the version of {julia}; going on "
            f"(the Sienna environment was resolved for Julia {resolved_text})"
        )
    elif resolved is not None and found[:2] != resolved:
        if not allow_julia_mismatch:
            raise SetupError(
                f"Julia is {_version_text(found)}, but the Sienna environment was resolved "
                f"for Julia {resolved_text}. Install Julia {resolved_text} (or point "
                "TENSA_JULIA at one), or run again with --allow-julia-mismatch to try anyway."
            )
        echo(
            f"warning: Julia is {_version_text(found)}, but the Sienna environment was "
            f"resolved for Julia {resolved_text}; trying anyway (--allow-julia-mismatch)"
        )
    else:
        echo(f"Using Julia {_version_text(found)} at {julia}")

    echo(f"Copying Project.toml and Manifest.toml into {project}")
    stamp = project / STAMP
    try:
        project.mkdir(parents=True, exist_ok=True)
        stamp.unlink(missing_ok=True)
        shutil.copyfile(packaged / "Project.toml", project / "Project.toml")
        shutil.copyfile(packaged_manifest, project / "Manifest.toml")
    except OSError as exc:
        raise SetupError(f"could not write the project folder {project}: {exc}") from exc

    echo(
        "Installing and precompiling the Sienna packages with Julia. The first time, "
        "this downloads them and takes several minutes; Julia's output follows."
    )
    env = _child_environment()
    try:
        install = run(
            [str(julia), f"--project={project}", "--startup-file=no", "-e", INSTALL_CODE],
            check=False,
            text=True,
            env=env,
        )
    except OSError as exc:
        raise SetupError(f"Julia could not be started: {exc}") from exc
    if install.returncode != 0:
        raise SetupError(
            f"Julia could not install the Sienna packages (exit {install.returncode}); "
            "see its output above."
        )

    echo("Checking that the engine's Julia module loads in the project")
    try:
        check = run(
            [
                str(julia),
                f"--project={project}",
                "--startup-file=no",
                "-e",
                CHECK_CODE,
                str(module),
            ],
            check=False,
            text=True,
            capture_output=True,
            env=env,
        )
    except OSError as exc:
        raise SetupError(f"Julia could not be started: {exc}") from exc
    if check.returncode != 0:
        lines = (check.stderr or "").strip().splitlines()
        detail = lines[0] if lines else f"Julia exited with {check.returncode}"
        raise SetupError(f"the engine's Julia module did not load: {detail}")
    lines = (check.stdout or "").strip().splitlines()
    try:
        versions = json.loads(lines[-1]) if lines else None
    except ValueError:
        versions = None
    if not isinstance(versions, dict):
        raise SetupError(
            "the engine's Julia module loaded but did not report its package versions"
        )
    for name, version in versions.items():
        echo(f"  {name} {version}")

    try:
        stamp.write_text(stamp_text(packaged_manifest) + "\n", encoding="utf-8")
    except OSError as exc:
        raise SetupError(f"could not write {stamp}: {exc}") from exc
    echo(f"The Sienna environment is ready in {project}; a Sienna session can now be started.")
    return project
