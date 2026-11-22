"""Unit tests for the Sienna environment check (unit P4-C1).

Every branch of every function, with the environment, ``shutil.which``,
``importlib.util.find_spec`` and the module path patched. Nothing here imports
juliacall or starts Julia; the subprocess test holds that importing the module
does not either.
"""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from tensa.engines.sienna import environment


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("TENSA_JULIA", raising=False)
    monkeypatch.delenv("TENSA_SIENNA_PROJECT", raising=False)
    monkeypatch.delenv("TENSA_SIENNA_SKIP_STAMP", raising=False)


def _spec_found(name: str) -> object:
    return object() if name == "juliacall" else None


def test_julia_executable_from_tensa_julia(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    julia = tmp_path / "julia"
    julia.touch()
    monkeypatch.setenv("TENSA_JULIA", str(julia))
    monkeypatch.setattr(shutil, "which", lambda name: None)
    assert environment.julia_executable() == julia


def test_julia_executable_missing_tensa_julia_does_not_fall_back(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("TENSA_JULIA", str(tmp_path / "no-such-julia"))
    on_path = tmp_path / "julia"
    on_path.touch()
    monkeypatch.setattr(shutil, "which", lambda name: str(on_path))
    assert environment.julia_executable() is None


def test_julia_executable_tensa_julia_naming_a_directory_is_not_julia(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # A folder (the Julia install's root, say) exists but cannot be run: it is no
    # binary, and the user's choice still keeps PATH out of it.
    folder = tmp_path / "julia-1.11"
    folder.mkdir()
    monkeypatch.setenv("TENSA_JULIA", str(folder))
    on_path = tmp_path / "julia"
    on_path.touch()
    monkeypatch.setattr(shutil, "which", lambda name: str(on_path))
    assert environment.julia_executable() is None


def test_julia_executable_from_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    on_path = tmp_path / "julia"
    on_path.touch()
    monkeypatch.setattr(shutil, "which", lambda name: str(on_path))
    assert environment.julia_executable() == on_path


def test_julia_executable_not_found(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(shutil, "which", lambda name: None)
    assert environment.julia_executable() is None


def test_julia_executable_empty_tensa_julia_is_unset(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    on_path = tmp_path / "julia"
    on_path.touch()
    monkeypatch.setenv("TENSA_JULIA", "")
    monkeypatch.setattr(shutil, "which", lambda name: str(on_path))
    assert environment.julia_executable() == on_path


def test_sienna_project_from_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("TENSA_SIENNA_PROJECT", str(tmp_path / "proj"))
    assert environment.sienna_project() == tmp_path / "proj"


def test_sienna_project_default(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    assert environment.sienna_project() == tmp_path / ".tensa" / "julia" / "dyn"


def test_sienna_project_empty_env_is_unset(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("TENSA_SIENNA_PROJECT", "")
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    assert environment.sienna_project() == tmp_path / ".tensa" / "julia" / "dyn"


def test_module_path_is_beside_the_package() -> None:
    path = environment.module_path()
    assert path.name == "TensaSienna.jl"
    assert path.parent.name == "julia"
    assert path.parent.parent == Path(environment.__file__).resolve().parent


def test_dynamics_module_path_is_beside_the_module() -> None:
    path = environment.dynamics_module_path()
    assert path.name == "TensaSiennaDyn.jl"
    assert path.parent == environment.module_path().parent


def _nothing_else(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """No Julia project set up and no Julia module, whatever the machine has."""
    monkeypatch.setenv("TENSA_SIENNA_PROJECT", str(tmp_path / "no-project" / "dyn"))
    monkeypatch.setattr(environment, "module_path", lambda: tmp_path / "no" / "TensaSienna.jl")


def test_reason_juliacall_missing_first(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """With everything missing, the juliacall reason is the one reported."""
    monkeypatch.setattr(importlib.util, "find_spec", lambda name: None)
    monkeypatch.setattr(shutil, "which", lambda name: None)
    _nothing_else(monkeypatch, tmp_path)
    assert environment.sienna_unavailable_reason() == (
        'juliacall is not installed (pip install "tensa[sienna]")'
    )


@pytest.mark.parametrize(
    "error",
    [ValueError("juliacall.__spec__ is None"), ModuleNotFoundError("No module named 'x'")],
    ids=["no-spec", "no-parent"],
)
def test_reason_find_spec_raising_is_not_installed(
    monkeypatch: pytest.MonkeyPatch, error: Exception
) -> None:
    def raising(name: str) -> object:
        raise error

    monkeypatch.setattr(importlib.util, "find_spec", raising)
    assert environment.sienna_unavailable_reason() == (
        'juliacall is not installed (pip install "tensa[sienna]")'
    )


def test_reason_julia_missing(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(importlib.util, "find_spec", _spec_found)
    monkeypatch.setattr(shutil, "which", lambda name: None)
    _nothing_else(monkeypatch, tmp_path)
    assert environment.sienna_unavailable_reason() == (
        "Julia was not found (set TENSA_JULIA or put julia on PATH)"
    )


def test_reason_tensa_julia_missing_file_even_with_julia_on_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(importlib.util, "find_spec", _spec_found)
    monkeypatch.setenv("TENSA_JULIA", str(tmp_path / "no-such-julia"))
    on_path = tmp_path / "julia"
    on_path.touch()
    monkeypatch.setattr(shutil, "which", lambda name: str(on_path))
    assert environment.sienna_unavailable_reason() == (
        "Julia was not found (set TENSA_JULIA or put julia on PATH)"
    )


def test_reason_manifest_missing_names_folder_only(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(importlib.util, "find_spec", _spec_found)
    julia = tmp_path / "julia"
    julia.touch()
    monkeypatch.setenv("TENSA_JULIA", str(julia))
    project = tmp_path / "some" / "parent" / "dyn"
    project.mkdir(parents=True)
    monkeypatch.setenv("TENSA_SIENNA_PROJECT", str(project))
    monkeypatch.setattr(environment, "module_path", lambda: tmp_path / "no" / "TensaSienna.jl")
    reason = environment.sienna_unavailable_reason()
    assert reason == (
        "the Sienna Julia environment is not set up at dyn; "
        "run: tensa warm-cache --engine sienna"
    )
    assert str(project.parent) not in reason
    assert str(tmp_path) not in reason


@pytest.mark.parametrize(
    ("project", "folder"),
    [
        pytest.param("some/dyn/", "dyn", id="trailing-separator"),
        pytest.param(".", "here", id="current-folder"),
        pytest.param("some/..", "here", id="parent-step"),
    ],
)
def test_reason_manifest_missing_names_folder_of_relative_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, project: str, folder: str
) -> None:
    monkeypatch.setattr(importlib.util, "find_spec", _spec_found)
    julia = tmp_path / "julia"
    julia.touch()
    monkeypatch.setenv("TENSA_JULIA", str(julia))
    here = tmp_path / "parent" / "here"
    (here / "some" / "dyn").mkdir(parents=True)
    monkeypatch.chdir(here)
    monkeypatch.setenv("TENSA_SIENNA_PROJECT", project)
    reason = environment.sienna_unavailable_reason()
    assert reason == (
        f"the Sienna Julia environment is not set up at {folder}; "
        "run: tensa warm-cache --engine sienna"
    )
    assert str(here.parent) not in reason


def _stamp_the_project(project: Path) -> None:
    """The stamp a finished setup of this TENSA would have written into ``project``."""
    from tensa.engines.sienna import setup

    (project / setup.STAMP).write_text(
        setup.stamp_text(setup.packaged_project() / "Manifest.toml") + "\n", encoding="utf-8"
    )


def test_reason_module_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(importlib.util, "find_spec", _spec_found)
    julia = tmp_path / "julia"
    julia.touch()
    monkeypatch.setenv("TENSA_JULIA", str(julia))
    project = tmp_path / "dyn"
    project.mkdir()
    (project / "Manifest.toml").touch()
    _stamp_the_project(project)
    monkeypatch.setenv("TENSA_SIENNA_PROJECT", str(project))
    monkeypatch.setattr(environment, "module_path", lambda: tmp_path / "no-such" / "TensaSienna.jl")
    assert environment.sienna_unavailable_reason() == (
        "the Sienna engine's Julia module is missing from this installation"
    )


def _julia_and_project(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, project: Path) -> None:
    """juliacall found, a Julia file, a project with a Manifest, and a module file."""
    monkeypatch.setattr(importlib.util, "find_spec", _spec_found)
    julia = tmp_path / "julia"
    julia.touch()
    monkeypatch.setenv("TENSA_JULIA", str(julia))
    project.mkdir(parents=True)
    (project / "Manifest.toml").touch()
    monkeypatch.setenv("TENSA_SIENNA_PROJECT", str(project))
    module = tmp_path / "pkg" / "julia" / "TensaSienna.jl"
    module.parent.mkdir(parents=True)
    module.touch()
    monkeypatch.setattr(environment, "module_path", lambda: module)


_NOT_SET_UP = (
    "the Sienna Julia environment at dyn was not set up by this version of TENSA; "
    "run: tensa warm-cache --engine sienna"
)


def test_reason_stamp_missing_names_folder_only(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    project = tmp_path / "some" / "parent" / "dyn"
    _julia_and_project(monkeypatch, tmp_path, project)
    reason = environment.sienna_unavailable_reason()
    assert reason == _NOT_SET_UP
    assert str(project.parent) not in reason
    assert str(tmp_path) not in reason


def test_reason_stamp_of_another_manifest(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A folder set up by a TENSA that shipped another Manifest: run the setup again."""
    from tensa.engines.sienna import setup

    project = tmp_path / "dyn"
    _julia_and_project(monkeypatch, tmp_path, project)
    _stamp_the_project(project)
    assert environment.sienna_unavailable_reason() is None
    newer = tmp_path / "newer" / "Manifest.toml"
    newer.parent.mkdir()
    newer.write_text("julia_version = \"1.13.4\"\n# another TENSA\n", encoding="utf-8")
    monkeypatch.setattr(setup, "packaged_project", lambda: newer.parent)
    assert environment.sienna_unavailable_reason() == _NOT_SET_UP


def test_reason_stamp_ignores_the_julia_module(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The module is included from the package by its path; editing it needs no setup."""
    project = tmp_path / "dyn"
    _julia_and_project(monkeypatch, tmp_path, project)
    _stamp_the_project(project)
    environment.module_path().write_text("module TensaSienna\n# edited\nend\n", encoding="utf-8")
    assert environment.sienna_unavailable_reason() is None


def test_reason_stamp_comes_after_the_manifest_and_before_the_module(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(importlib.util, "find_spec", _spec_found)
    julia = tmp_path / "julia"
    julia.touch()
    monkeypatch.setenv("TENSA_JULIA", str(julia))
    project = tmp_path / "dyn"
    project.mkdir()
    monkeypatch.setenv("TENSA_SIENNA_PROJECT", str(project))
    monkeypatch.setattr(environment, "module_path", lambda: tmp_path / "no" / "TensaSienna.jl")
    # No Manifest: the Manifest reason, not the stamp one.
    assert environment.sienna_unavailable_reason() == (
        "the Sienna Julia environment is not set up at dyn; "
        "run: tensa warm-cache --engine sienna"
    )
    # A Manifest and no stamp: the stamp reason, ahead of the missing module.
    (project / "Manifest.toml").touch()
    assert environment.sienna_unavailable_reason() == _NOT_SET_UP
    # With the stamp, the module reason.
    _stamp_the_project(project)
    assert environment.sienna_unavailable_reason() == (
        "the Sienna engine's Julia module is missing from this installation"
    )


def test_reason_stamp_skipped_with_tensa_sienna_skip_stamp(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    project = tmp_path / "dyn"
    _julia_and_project(monkeypatch, tmp_path, project)
    monkeypatch.setenv("TENSA_SIENNA_SKIP_STAMP", "1")
    assert environment.sienna_unavailable_reason() is None
    # Only the value 1 skips it.
    for value in ("0", "yes", ""):
        monkeypatch.setenv("TENSA_SIENNA_SKIP_STAMP", value)
        assert environment.sienna_unavailable_reason() == _NOT_SET_UP


def test_tensa_sienna_skip_stamp_skips_no_other_reason(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    project = tmp_path / "dyn"
    _julia_and_project(monkeypatch, tmp_path, project)
    monkeypatch.setenv("TENSA_SIENNA_SKIP_STAMP", "1")
    module = environment.module_path()
    module.unlink()
    assert environment.sienna_unavailable_reason() == (
        "the Sienna engine's Julia module is missing from this installation"
    )
    module.touch()
    (project / "Manifest.toml").unlink()
    assert environment.sienna_unavailable_reason() == (
        "the Sienna Julia environment is not set up at dyn; "
        "run: tensa warm-cache --engine sienna"
    )
    monkeypatch.setenv("TENSA_JULIA", str(tmp_path / "no-julia"))
    assert environment.sienna_unavailable_reason() == (
        "Julia was not found (set TENSA_JULIA or put julia on PATH)"
    )
    monkeypatch.setattr(importlib.util, "find_spec", lambda name: None)
    assert environment.sienna_unavailable_reason() == (
        'juliacall is not installed (pip install "tensa[sienna]")'
    )


def test_no_reason_mentions_the_skip_variable(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    project = tmp_path / "dyn"
    _julia_and_project(monkeypatch, tmp_path, project)
    reason = environment.sienna_unavailable_reason()
    assert reason is not None and "SKIP" not in reason


def test_reason_none_when_all_hold(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(importlib.util, "find_spec", _spec_found)
    julia = tmp_path / "julia"
    julia.touch()
    monkeypatch.setenv("TENSA_JULIA", str(julia))
    project = tmp_path / "dyn"
    project.mkdir()
    (project / "Manifest.toml").touch()
    monkeypatch.setenv("TENSA_SIENNA_PROJECT", str(project))
    module = tmp_path / "pkg" / "julia" / "TensaSienna.jl"
    module.parent.mkdir(parents=True)
    module.touch()
    _stamp_the_project(project)
    monkeypatch.setattr(environment, "module_path", lambda: module)
    assert environment.sienna_unavailable_reason() is None


def test_reason_dynamics_module_missing_is_not_checked(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A missing dynamics module is no reason: it surfaces when dynamics are
    first asked for, as an include failure of ``start_dynamics``."""
    monkeypatch.setattr(importlib.util, "find_spec", _spec_found)
    julia = tmp_path / "julia"
    julia.touch()
    monkeypatch.setenv("TENSA_JULIA", str(julia))
    project = tmp_path / "dyn"
    project.mkdir()
    (project / "Manifest.toml").touch()
    monkeypatch.setenv("TENSA_SIENNA_PROJECT", str(project))
    module = tmp_path / "pkg" / "julia" / "TensaSienna.jl"
    module.parent.mkdir(parents=True)
    module.touch()
    _stamp_the_project(project)
    monkeypatch.setattr(environment, "module_path", lambda: module)
    monkeypatch.setattr(
        environment, "dynamics_module_path", lambda: tmp_path / "no" / "TensaSiennaDyn.jl"
    )
    assert environment.sienna_unavailable_reason() is None


def test_importing_the_module_imports_neither_juliacall_nor_andes() -> None:
    out = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys, tensa.engines.sienna.environment; "
            "print('juliacall' in sys.modules, 'andes' in sys.modules)",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert out.stdout.strip() == "False False"
