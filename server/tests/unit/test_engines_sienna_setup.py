"""Unit tests for the Sienna setup (unit P4-D).

No Julia runs here: ``setup_sienna`` is given a recording ``run`` callable that
returns ``CompletedProcess`` objects the test builds, and ``tmp_path`` is the
project. ``find_spec`` and ``julia_version`` are patched where a test needs
them.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from tensa.engines.sienna import environment, setup

pytestmark = pytest.mark.unit

JULIA = Path("/fake/julia")
PACKAGED_MANIFEST = setup.packaged_project() / "Manifest.toml"
# The real one: the autouse fixture below patches it for the setup tests.
_julia_version = setup.julia_version

Calls = list[tuple[list[str], dict[str, Any]]]
Run = Callable[..., subprocess.CompletedProcess[str]]

_VERSIONS = '{"julia": "1.13.4", "PowerSystems": "5.12.5"}'


def _spec_found(name: str) -> object:
    return object() if name == "juliacall" else None


@pytest.fixture(autouse=True)
def _juliacall_there_and_julia_matching(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(importlib.util, "find_spec", _spec_found)
    resolved = setup.manifest_julia_version(PACKAGED_MANIFEST)
    assert resolved is not None
    monkeypatch.setattr(setup, "julia_version", lambda exe: (*resolved, 9))


def _recording(results: list[subprocess.CompletedProcess[str]]) -> tuple[Calls, Run]:
    """A recording ``run`` that answers with ``results`` in order, and its calls."""
    calls: Calls = []

    def run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        calls.append((list(cmd), kwargs))
        return results[len(calls) - 1]

    return calls, run


def _ok(check_stdout: str = f"loading...\n{_VERSIONS}\n") -> tuple[Calls, Run]:
    """A recording ``run`` that answers success for the install and the check."""
    return _recording(
        [
            subprocess.CompletedProcess([], 0),
            subprocess.CompletedProcess([], 0, stdout=check_stdout, stderr=""),
        ]
    )


def _error(**kwargs: Any) -> str:
    with pytest.raises(setup.SetupError) as excinfo:
        setup.setup_sienna(**kwargs)
    return str(excinfo.value)


def test_no_juliacall_is_a_setup_error(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(importlib.util, "find_spec", lambda name: None)
    calls, run = _ok()
    message = _error(julia=JULIA, project=tmp_path / "dyn", run=run)
    assert message == (
        'juliacall is not installed; install TENSA with the sienna extra: '
        'pip install "tensa[sienna]"'
    )
    assert calls == []
    assert not (tmp_path / "dyn").exists()


def test_no_julia_is_a_setup_error(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(environment, "julia_executable", lambda: None)
    calls, run = _ok()
    message = _error(project=tmp_path / "dyn", run=run)
    assert message == (
        "Julia was not found. Install it (https://julialang.org/install/) or point "
        "TENSA_JULIA at the julia executable, then run this again."
    )
    assert calls == []


def test_the_defaults_are_the_environment_s(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(environment, "julia_executable", lambda: JULIA)
    monkeypatch.setattr(environment, "sienna_project", lambda: tmp_path / "default")
    calls, run = _ok()
    assert setup.setup_sienna(run=run, echo=lambda line: None) == tmp_path / "default"
    assert calls[0][0][0] == str(JULIA)
    assert calls[0][0][1] == f"--project={tmp_path / 'default'}"


def test_a_version_mismatch_names_both_versions_and_runs_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(setup, "julia_version", lambda exe: (1, 11, 3))
    resolved = setup.manifest_julia_version(PACKAGED_MANIFEST)
    assert resolved is not None
    wanted = f"{resolved[0]}.{resolved[1]}"
    calls, run = _ok()
    message = _error(julia=JULIA, project=tmp_path / "dyn", run=run)
    assert message == (
        f"Julia is 1.11.3, but the Sienna environment was resolved for Julia {wanted}. "
        f"Install Julia {wanted} (or point TENSA_JULIA at one), or run again with "
        "--allow-julia-mismatch to try anyway."
    )
    assert calls == []
    assert not (tmp_path / "dyn").exists()


def test_only_major_and_minor_count_for_the_version_rule(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    resolved = setup.manifest_julia_version(PACKAGED_MANIFEST)
    assert resolved is not None
    monkeypatch.setattr(setup, "julia_version", lambda exe: (*resolved, 0))
    echoed: list[str] = []
    _, run = _ok()
    setup.setup_sienna(julia=JULIA, project=tmp_path / "dyn", echo=echoed.append, run=run)
    assert not any(line.startswith("warning:") for line in echoed)


def test_a_version_mismatch_allowed_warns_and_goes_on(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(setup, "julia_version", lambda exe: (1, 11, 3))
    calls, run = _ok()
    echoed: list[str] = []
    setup.setup_sienna(
        julia=JULIA,
        project=tmp_path / "dyn",
        allow_julia_mismatch=True,
        echo=echoed.append,
        run=run,
    )
    warnings = [line for line in echoed if line.startswith("warning:")]
    assert len(warnings) == 1 and "1.11.3" in warnings[0] and "trying anyway" in warnings[0]
    assert len(calls) == 2
    assert (tmp_path / "dyn" / setup.STAMP).is_file()


def test_an_unreadable_version_warns_and_goes_on(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(setup, "julia_version", lambda exe: None)
    calls, run = _ok()
    echoed: list[str] = []
    setup.setup_sienna(julia=JULIA, project=tmp_path / "dyn", echo=echoed.append, run=run)
    assert any(line.startswith("warning: could not read the version") for line in echoed)
    assert len(calls) == 2


def test_a_failing_install_holds_the_exit_code_and_leaves_no_stamp(tmp_path: Path) -> None:
    project = tmp_path / "dyn"
    calls, run = _recording([subprocess.CompletedProcess([], 3)])
    message = _error(julia=JULIA, project=project, run=run)
    assert message == (
        "Julia could not install the Sienna packages (exit 3); see its output above."
    )
    assert not (project / setup.STAMP).exists()
    assert (project / "Project.toml").is_file()
    assert (project / "Manifest.toml").is_file()
    assert len(calls) == 1


def test_a_failing_module_check_reports_the_first_stderr_line(tmp_path: Path) -> None:
    project = tmp_path / "dyn"
    _, run = _recording(
        [
            subprocess.CompletedProcess([], 0),
            subprocess.CompletedProcess([], 1, stdout="", stderr="ERROR: LoadError: nope\nmore\n"),
        ]
    )
    message = _error(julia=JULIA, project=project, run=run)
    assert message == "the engine's Julia module did not load: ERROR: LoadError: nope"
    assert not (project / setup.STAMP).exists()


def test_a_module_check_that_prints_no_versions_is_a_setup_error(tmp_path: Path) -> None:
    for stdout in ("", "not json\n", "[1, 2]\n"):
        project = tmp_path / f"dyn{len(stdout)}"
        _, run = _ok(check_stdout=stdout)
        message = _error(julia=JULIA, project=project, run=run)
        assert "did not report its package versions" in message
        assert not (project / setup.STAMP).exists()


def test_a_julia_that_cannot_be_started_is_a_setup_error(tmp_path: Path) -> None:
    def run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        raise PermissionError("access denied")

    message = _error(julia=JULIA, project=tmp_path / "dyn", run=run)
    assert message.startswith("Julia could not be started:")


def test_a_project_path_that_is_a_file_is_a_setup_error(tmp_path: Path) -> None:
    project = tmp_path / "dyn"
    project.write_text("a file", encoding="utf-8")
    calls, run = _ok()
    message = _error(julia=JULIA, project=project, run=run)
    assert message.startswith(f"could not write the project folder {project}:")
    assert calls == []


def test_the_steps_come_in_order_and_the_run_calls_are_exact(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    project = tmp_path / "dyn"
    project.mkdir()
    (project / setup.STAMP).write_text(setup.stamp_text(PACKAGED_MANIFEST), encoding="utf-8")
    (project / "Manifest.toml").write_text("old", encoding="utf-8")
    events: list[str] = []
    calls: list[tuple[list[str], dict[str, Any]]] = []

    def run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        calls.append((list(cmd), kwargs))
        stamped = int((project / setup.STAMP).exists())
        copied = int(
            (project / "Manifest.toml").read_bytes() == PACKAGED_MANIFEST.read_bytes()
        )
        events.append(f"run{len(calls)}:stamp={stamped}:copied={copied}")
        if len(calls) == 1:
            return subprocess.CompletedProcess(cmd, 0)
        return subprocess.CompletedProcess(cmd, 0, stdout=_VERSIONS + "\n", stderr="")

    monkeypatch.setenv("TENSA_TEST_MARKER", "kept")
    echoed: list[str] = []
    returned = setup.setup_sienna(julia=JULIA, project=project, echo=echoed.append, run=run)
    assert returned == project
    # The stamp is gone before Julia runs and the files are in place by then.
    assert events == ["run1:stamp=0:copied=1", "run2:stamp=0:copied=1"]
    (install, install_kwargs), (check, check_kwargs) = calls
    assert install == [
        str(JULIA),
        f"--project={project}",
        "--startup-file=no",
        "-e",
        "using Pkg; Pkg.instantiate(); Pkg.precompile()",
    ]
    assert check == [
        str(JULIA),
        f"--project={project}",
        "--startup-file=no",
        "-e",
        "include(ARGS[1]); print(TensaSienna.versions_json())",
        str(environment.module_path()),
    ]
    # Julia's output of the install reaches the console; the check's is read.
    assert install_kwargs["check"] is False and install_kwargs["text"] is True
    assert "capture_output" not in install_kwargs
    assert "stdout" not in install_kwargs and "stderr" not in install_kwargs
    assert check_kwargs["capture_output"] is True and check_kwargs["check"] is False
    for kwargs in (install_kwargs, check_kwargs):
        env = kwargs["env"]
        assert env["JULIA_PKG_PRECOMPILE_AUTO"] == "0"
        assert env["JULIA_LOAD_PATH"] == os.pathsep.join(("@", "@stdlib"))
        assert env["TENSA_TEST_MARKER"] == "kept"
    assert (project / setup.STAMP).read_text(encoding="utf-8") == (
        setup.stamp_text(PACKAGED_MANIFEST) + "\n"
    )
    assert echoed[-1] == (
        f"The Sienna environment is ready in {project}; a Sienna session can now be started."
    )
    assert "  PowerSystems 5.12.5" in echoed
    assert "  julia 1.13.4" in echoed


def test_each_step_is_announced_before_it_starts(tmp_path: Path) -> None:
    echoed: list[str] = []
    seen_at_run: list[int] = []

    def run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        seen_at_run.append(len(echoed))
        if len(seen_at_run) == 1:
            return subprocess.CompletedProcess(cmd, 0)
        return subprocess.CompletedProcess(cmd, 0, stdout=_VERSIONS, stderr="")

    setup.setup_sienna(julia=JULIA, project=tmp_path / "dyn", echo=echoed.append, run=run)
    assert echoed[0].startswith("Using Julia ")
    assert echoed[1].startswith("Copying Project.toml and Manifest.toml into ")
    assert echoed[2].startswith("Installing and precompiling the Sienna packages")
    assert seen_at_run[0] == 3
    assert echoed[3].startswith("Checking that the engine's Julia module loads")
    assert seen_at_run[1] == 4


def test_an_existing_project_keeps_its_other_files(tmp_path: Path) -> None:
    project = tmp_path / "dyn"
    project.mkdir()
    (project / "Project.toml").write_text("old project", encoding="utf-8")
    (project / "Manifest.toml").write_text("old manifest", encoding="utf-8")
    (project / setup.STAMP).write_text(setup.stamp_text(PACKAGED_MANIFEST), encoding="utf-8")
    (project / "notes.txt").write_text("mine", encoding="utf-8")
    _, run = _recording([subprocess.CompletedProcess([], 1)])
    with pytest.raises(setup.SetupError):
        setup.setup_sienna(julia=JULIA, project=project, run=run)
    packaged = setup.packaged_project()
    assert (project / "Project.toml").read_bytes() == (packaged / "Project.toml").read_bytes()
    assert (project / "Manifest.toml").read_bytes() == PACKAGED_MANIFEST.read_bytes()
    # The stamp was a valid one: a failed run must still remove it.
    assert not (project / setup.STAMP).exists()
    assert (project / "notes.txt").read_text(encoding="utf-8") == "mine"


def test_manifest_julia_version_of_the_packaged_manifest() -> None:
    third_line = PACKAGED_MANIFEST.read_text(encoding="utf-8").splitlines()[2]
    assert third_line.startswith("julia_version = ")
    major, minor = third_line.split('"')[1].split(".")[:2]
    assert setup.manifest_julia_version(PACKAGED_MANIFEST) == (int(major), int(minor))


def test_manifest_julia_version_without_the_line(tmp_path: Path) -> None:
    manifest = tmp_path / "Manifest.toml"
    manifest.write_text("# no version here\n[deps]\n", encoding="utf-8")
    assert setup.manifest_julia_version(manifest) is None
    assert setup.manifest_julia_version(tmp_path / "missing.toml") is None


@pytest.mark.parametrize(
    ("output", "expected"),
    [
        ("julia version 1.13.4\n", (1, 13, 4)),
        ("julia version 1.11.0-rc1\n", (1, 11, 0)),
        ("julia version 1.14.0-DEV.123\n", (1, 14, 0)),
        ("garbage\n", None),
        ("", None),
    ],
)
def test_julia_version_parses_the_output(
    monkeypatch: pytest.MonkeyPatch, output: str, expected: tuple[int, int, int] | None
) -> None:
    def run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        assert cmd == [str(JULIA), "--version"]
        assert kwargs["timeout"] == 60
        return subprocess.CompletedProcess(cmd, 0, stdout=output, stderr="")

    monkeypatch.setattr(subprocess, "run", run)
    assert _julia_version(JULIA) == expected


@pytest.mark.parametrize(
    "error", [OSError("no such file"), subprocess.TimeoutExpired(["julia"], 60)]
)
def test_julia_version_when_julia_cannot_run(
    monkeypatch: pytest.MonkeyPatch, error: Exception
) -> None:
    def run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        raise error

    monkeypatch.setattr(subprocess, "run", run)
    assert _julia_version(JULIA) is None


def test_julia_version_when_julia_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda cmd, **kw: subprocess.CompletedProcess(cmd, 1, stdout="julia version 1.13.4"),
    )
    assert _julia_version(JULIA) is None


def test_is_ready_after_a_successful_setup(tmp_path: Path) -> None:
    project = tmp_path / "dyn"
    _, run = _ok()
    setup.setup_sienna(julia=JULIA, project=project, run=run, echo=lambda line: None)
    assert setup.is_ready(project, PACKAGED_MANIFEST)
    (project / setup.STAMP).unlink()
    assert not setup.is_ready(project, PACKAGED_MANIFEST)


def test_is_ready_follows_the_packaged_manifest_not_the_copy(tmp_path: Path) -> None:
    """Julia may rewrite the copy; a new TENSA ships another Manifest. The first
    keeps the folder ready, the second does not."""
    project = tmp_path / "dyn"
    _, run = _ok()
    setup.setup_sienna(julia=JULIA, project=project, run=run, echo=lambda line: None)
    (project / "Manifest.toml").write_text("rewritten by Julia", encoding="utf-8")
    assert setup.is_ready(project, PACKAGED_MANIFEST)
    newer = tmp_path / "Manifest.toml"
    newer.write_bytes(PACKAGED_MANIFEST.read_bytes() + b"\n# a newer TENSA\n")
    assert not setup.is_ready(project, newer)


def test_is_ready_is_false_for_a_stamp_of_another_manifest(tmp_path: Path) -> None:
    project = tmp_path / "dyn"
    project.mkdir()
    other = tmp_path / "other.toml"
    other.write_text("something else", encoding="utf-8")
    (project / setup.STAMP).write_text(setup.stamp_text(other), encoding="utf-8")
    assert not setup.is_ready(project, PACKAGED_MANIFEST)
    (project / setup.STAMP).write_text("", encoding="utf-8")
    assert not setup.is_ready(project, PACKAGED_MANIFEST)
    assert not setup.is_ready(project, tmp_path / "missing.toml")


def test_the_stamp_does_not_follow_the_julia_module() -> None:
    """The worker includes the module from the package by its path, so a change to
    it alone needs no new setup."""
    assert setup.stamp_text(PACKAGED_MANIFEST) == (
        __import__("hashlib").sha256(PACKAGED_MANIFEST.read_bytes()).hexdigest()
    )


def test_the_packaged_project_holds_what_the_wheel_must_carry() -> None:
    packaged = setup.packaged_project()
    assert (packaged / "Project.toml").is_file()
    assert PACKAGED_MANIFEST.is_file()
    assert environment.module_path().is_file()


def test_the_versions_echoed_come_from_the_last_line_of_the_check(tmp_path: Path) -> None:
    _, run = _ok(
        check_stdout="noise\n" + json.dumps({"PowerSystems": "5.12.5", "PowerFlows": "0.3.1"})
    )
    echoed: list[str] = []
    setup.setup_sienna(julia=JULIA, project=tmp_path / "dyn", echo=echoed.append, run=run)
    assert "  PowerSystems 5.12.5" in echoed
    assert "  PowerFlows 0.3.1" in echoed
