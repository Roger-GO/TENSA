"""The ANDES generated-code cache: its state check, its stamp, and the background
``warm-cache`` child that ``tensa serve`` starts when the cache needs it.

The child is exercised for real (a short Python command stands in for
``tensa warm-cache``), so the pipe handling, the report and ``stop`` are the real
ones on every platform. ANDES itself is faked where ``warm-cache`` runs.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import types
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from tensa import cli
from tensa.core import codegen_cache
from tensa.core.codegen_cache import (
    STAMP_NAME,
    BackgroundWarm,
    cache_state,
    mark_cache_checked,
    pycode_dir,
    start_background_warm,
)
from tensa.core.worker_spawn import DEFAULT_WORKER_THREADS

pytestmark = pytest.mark.unit

log = logging.getLogger("tensa.test-codegen-cache")

_PYTHON = sys.executable


def _cache(tmp_path: Path, *, code: bool = True, stamp: str | None = None) -> Path:
    directory = tmp_path / "pycode"
    directory.mkdir()
    if code:
        (directory / "__init__.py").write_text("__version__ = '2.0.0'\n", encoding="utf-8")
    if stamp is not None:
        (directory / STAMP_NAME).write_text(stamp, encoding="utf-8")
    return directory


def _finished(warm: BackgroundWarm) -> None:
    """Wait for the watcher to have said how the child ended."""
    warm._watcher.join(60.0)
    assert not warm._watcher.is_alive()


# ---- where the cache is ------------------------------------------------------


def test_the_cache_dir_is_where_andes_keeps_its_generated_code() -> None:
    """The check looks in the place ANDES writes to, or it would warm the wrong one."""
    from andes.utils.paths import get_pycode_path

    assert str(pycode_dir()) == get_pycode_path(None, mkdir=False)


# ---- the state check ---------------------------------------------------------


def test_a_directory_without_generated_code_is_missing(tmp_path: Path) -> None:
    assert cache_state("2.0.0", _cache(tmp_path, code=False)) == "missing"
    assert cache_state("2.0.0", tmp_path / "does-not-exist") == "missing"


def test_code_without_a_stamp_is_unchecked(tmp_path: Path) -> None:
    """Built by ``andes prepare`` or by a TENSA from before the stamp."""
    assert cache_state("2.0.0", _cache(tmp_path)) == "unchecked"


def test_a_stamp_for_another_andes_version_is_unchecked(tmp_path: Path) -> None:
    assert cache_state("2.0.1", _cache(tmp_path, stamp="2.0.0\n")) == "unchecked"


def test_a_stamp_for_the_installed_version_is_ready(tmp_path: Path) -> None:
    assert cache_state("2.0.0", _cache(tmp_path, stamp="2.0.0\n")) == "ready"


def test_a_stamp_that_cannot_be_read_is_unchecked(tmp_path: Path) -> None:
    directory = _cache(tmp_path)
    (directory / STAMP_NAME).mkdir()  # reading a directory raises OSError
    assert cache_state("2.0.0", directory) == "unchecked"
    (directory / STAMP_NAME).rmdir()
    (directory / STAMP_NAME).write_bytes(b"\xff\xfe\x00")  # not UTF-8
    assert cache_state("2.0.0", directory) == "unchecked"


def test_a_stamp_written_by_mark_cache_checked_makes_the_cache_ready(tmp_path: Path) -> None:
    directory = _cache(tmp_path)
    mark_cache_checked("2.0.0", directory)
    assert cache_state("2.0.0", directory) == "ready"
    assert cache_state("2.0.1", directory) == "unchecked"


def test_marking_a_directory_that_cannot_be_written_is_not_an_error(tmp_path: Path) -> None:
    mark_cache_checked("2.0.0", tmp_path / "does-not-exist")


# ---- the background child ----------------------------------------------------


def test_nothing_starts_for_a_cache_that_is_ready(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    directory = _cache(tmp_path, stamp="2.0.0\n")
    with caplog.at_level(logging.INFO, logger=log.name):
        # The command would fail loudly if it ran.
        warm = start_background_warm(
            "2.0.0", log, directory=directory, command=[_PYTHON, "-c", "raise SystemExit(9)"]
        )
    assert warm is None
    assert caplog.records == []


@pytest.mark.parametrize("code", [True, False], ids=["unchecked", "missing"])
def test_a_cache_that_needs_it_runs_the_child_and_reports_when_it_is_done(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, code: bool
) -> None:
    directory = _cache(tmp_path, code=code)
    with caplog.at_level(logging.INFO, logger=log.name):
        warm = start_background_warm(
            "2.0.0", log, directory=directory, command=[_PYTHON, "-c", "pass"]
        )
        assert warm is not None
        _finished(warm)
    assert "in the background" in caplog.records[0].getMessage()
    assert ("not found" in caplog.records[0].getMessage()) is (not code)
    assert "ANDES generated code is ready" in caplog.records[-1].getMessage()


def test_a_child_that_fails_is_reported_with_the_end_of_its_stderr(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    lines = "\\n".join(f"noise {i}" for i in range(30))
    script = f"import sys; sys.stderr.write('{lines}\\nthe real reason\\n'); sys.exit(3)"
    with caplog.at_level(logging.INFO, logger=log.name):
        warm = start_background_warm(
            "2.0.0", log, directory=_cache(tmp_path), command=[_PYTHON, "-c", script]
        )
        assert warm is not None
        _finished(warm)
    (failure,) = [r for r in caplog.records if r.levelno == logging.WARNING]
    message = failure.getMessage()
    assert "exit code 3" in message
    assert "the real reason" in message
    assert "noise 29" in message
    # Only the tail, not the whole transcript.
    assert "noise 0" not in message


def test_stopping_ends_a_running_child_without_reporting_a_failure(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.INFO, logger=log.name):
        warm = start_background_warm(
            "2.0.0",
            log,
            directory=_cache(tmp_path),
            command=[_PYTHON, "-c", "import time; time.sleep(120)"],
        )
        assert warm is not None
        assert warm._process.poll() is None
        warm.stop()
        assert warm._process.poll() is not None
        warm.stop()  # a second stop is harmless
    assert [r for r in caplog.records if r.levelno >= logging.WARNING] == []
    assert "is ready" not in caplog.text


def test_stopping_kills_a_child_that_ignores_the_request_to_end(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(BackgroundWarm, "_STOP_GRACE_SECONDS", 0.5)
    warm = start_background_warm(
        "2.0.0",
        log,
        directory=_cache(tmp_path),
        command=[_PYTHON, "-c", "import time; time.sleep(120)"],
    )
    assert warm is not None
    # ``terminate`` becomes a no-op, as for a child that ignores SIGTERM.
    monkeypatch.setattr(warm._process, "terminate", lambda: None)
    warm.stop()
    assert warm._process.poll() is not None


def test_a_child_that_cannot_start_is_logged_and_skipped(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.INFO, logger=log.name):
        warm = start_background_warm(
            "2.0.0",
            log,
            directory=_cache(tmp_path),
            command=[str(tmp_path / "no-such-python")],
        )
    assert warm is None
    assert "could not start the background ANDES code generation" in caplog.text


def test_the_default_child_is_a_quick_incremental_warm_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    started: list[dict[str, Any]] = []

    class _Done:
        pid = 4242
        returncode = 0

        def communicate(self) -> tuple[None, bytes]:
            return None, b""

        def poll(self) -> int:
            return 0

    def popen(argv: list[str], **kwargs: Any) -> _Done:
        started.append({"argv": argv, "kwargs": kwargs, "threads": os.environ.get("OMP_NUM_THREADS")})
        return _Done()

    attached: list[int] = []
    monkeypatch.setattr(codegen_cache.subprocess, "Popen", popen)
    monkeypatch.setattr(codegen_cache, "attach_kill_on_close_job", attached.append)
    monkeypatch.delenv("OMP_NUM_THREADS", raising=False)
    monkeypatch.delenv("TENSA_WORKER_THREADS", raising=False)

    warm = start_background_warm("2.0.0", log, directory=_cache(tmp_path))
    assert warm is not None
    _finished(warm)

    (call,) = started
    assert call["argv"] == [_PYTHON, "-m", "tensa", "warm-cache", "--quick", "--incremental"]
    assert call["kwargs"]["stdout"] == subprocess.DEVNULL
    assert call["kwargs"]["stderr"] == subprocess.PIPE
    # Started under a worker's thread caps (ANDES spawns a process per core)...
    assert call["threads"] == str(DEFAULT_WORKER_THREADS)
    # ...which are gone from the server's own environment again.
    assert "OMP_NUM_THREADS" not in os.environ
    # And, on Windows, tied to the server's life like a worker.
    assert attached == [4242]


# ---- ``tensa warm-cache`` stamps the cache -----------------------------------


@pytest.fixture
def fake_andes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """``andes.prepare`` writes the generated code into a temporary cache."""
    directory = tmp_path / "pycode"
    state: dict[str, Any] = {"calls": [], "directory": directory, "fail": False}

    def prepare(*, quick: bool, incremental: bool) -> None:
        state["calls"].append({"quick": quick, "incremental": incremental})
        if state["fail"]:
            raise RuntimeError("code generation failed")
        directory.mkdir(exist_ok=True)
        (directory / "__init__.py").write_text("__version__ = '9.9.9'\n", encoding="utf-8")

    andes = types.ModuleType("andes")
    andes.__version__ = "9.9.9"  # type: ignore[attr-defined]
    andes.prepare = prepare  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "andes", andes)
    monkeypatch.setattr(cli, "pycode_dir", lambda: directory)
    monkeypatch.setattr(cli, "_andes_version", lambda: "9.9.9")
    return state


def test_warm_cache_stamps_the_cache_it_generated(fake_andes: dict[str, Any]) -> None:
    result = CliRunner().invoke(cli.app, ["warm-cache", "--quick", "--incremental"])
    assert result.exit_code == 0, result.output
    assert fake_andes["calls"] == [{"quick": True, "incremental": True}]
    # ``tensa serve`` now finds the cache ready and starts no child.
    assert cache_state("9.9.9", fake_andes["directory"]) == "ready"


def test_warm_cache_leaves_the_cache_unstamped_when_the_generation_fails(
    fake_andes: dict[str, Any],
) -> None:
    fake_andes["directory"].mkdir()
    (fake_andes["directory"] / "__init__.py").write_text("", encoding="utf-8")
    fake_andes["fail"] = True
    result = CliRunner().invoke(cli.app, ["warm-cache"])
    assert result.exit_code != 0
    assert cache_state("9.9.9", fake_andes["directory"]) == "unchecked"
