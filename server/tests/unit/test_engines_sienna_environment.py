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
        "juliacall is not installed (pip install juliacall)"
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
        "juliacall is not installed (pip install juliacall)"
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
    monkeypatch.setenv("TENSA_SIENNA_PROJECT", str(project))
    monkeypatch.setattr(environment, "module_path", lambda: tmp_path / "no-such" / "TensaSienna.jl")
    assert environment.sienna_unavailable_reason() == (
        "the Sienna engine's Julia module is missing from this installation"
    )


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
    monkeypatch.setattr(environment, "module_path", lambda: module)
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
