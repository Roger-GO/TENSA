"""The ANDES generated-code cache: its state check, its stamp, and the background
``warm-cache`` child that ``tensa serve`` starts when the cache needs it.

The child is exercised for real (a short Python command stands in for
``tensa warm-cache``), so the pipe handling, the report, ``stop`` and the marker
that tells a loading worker to wait are the real ones on every platform. ANDES
itself is faked where ``warm-cache`` runs.
"""

from __future__ import annotations

import logging
import os
import signal
import subprocess
import sys
import threading
import time
import types
from pathlib import Path
from typing import Any

import pytest

from tensa import cli
from tensa.core import codegen_cache
from tensa.core.codegen_cache import (
    STAMP_NAME,
    BackgroundWarm,
    background_warm_running,
    cache_state,
    mark_cache_checked,
    pycode_dir,
    running_marker,
    start_background_warm,
    wait_for_background_warm,
)
from tensa.core.errors import CaseLoadError
from tensa.core.worker_spawn import DEFAULT_WORKER_THREADS
from tensa.core.wrapper import Wrapper
from tensa.core.wrapper import case as case_module
from tests._cli import cli_runner

pytestmark = pytest.mark.unit

log = logging.getLogger("tensa.test-codegen-cache")

_PYTHON = sys.executable


def _cache(tmp_path: Path, *, code: bool = True, stamped: str | None = None) -> Path:
    """A cache directory; ``stamped`` is the ANDES version ``warm-cache`` checked it for."""
    directory = tmp_path / "pycode"
    directory.mkdir()
    if code:
        (directory / "__init__.py").write_text("__version__ = '2.0.0'\n", encoding="utf-8")
    if stamped is not None:
        mark_cache_checked(stamped, directory)
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
    assert cache_state("2.0.1", _cache(tmp_path, stamped="2.0.0")) == "unchecked"


def test_a_stamp_for_the_installed_version_is_ready(tmp_path: Path) -> None:
    assert cache_state("2.0.0", _cache(tmp_path, stamped="2.0.0")) == "ready"


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


def test_a_stamp_that_names_only_a_version_is_unchecked(tmp_path: Path) -> None:
    """The stamp an earlier build wrote says nothing about which code it checked."""
    directory = _cache(tmp_path)
    (directory / STAMP_NAME).write_text("2.0.0\n", encoding="utf-8")
    assert cache_state("2.0.0", directory) == "unchecked"


def test_code_that_was_rewritten_after_the_stamp_is_unchecked(tmp_path: Path) -> None:
    """The directory is shared by every ANDES on the machine; one that regenerates
    code rewrites ``__init__.py``, and the stamp then no longer vouches for it."""
    directory = _cache(tmp_path, stamped="2.0.0")
    init = directory / "__init__.py"
    assert cache_state("2.0.0", directory) == "ready"

    # A different ANDES wrote a different file.
    init.write_text("__version__ = '2.1.0'\n\nfrom . import Bus  # NOQA\n", encoding="utf-8")
    assert cache_state("2.0.0", directory) == "unchecked"

    # The same bytes written again at another moment: still not what was checked.
    mark_cache_checked("2.0.0", directory)
    assert cache_state("2.0.0", directory) == "ready"
    before = init.stat().st_mtime_ns
    os.utime(init, ns=(before + 5_000_000_000, before + 5_000_000_000))
    assert cache_state("2.0.0", directory) == "unchecked"


def test_marking_a_directory_without_code_leaves_it_unstamped(tmp_path: Path) -> None:
    directory = _cache(tmp_path, code=False)
    mark_cache_checked("2.0.0", directory)
    assert not (directory / STAMP_NAME).exists()
    assert cache_state("2.0.0", directory) == "missing"


def test_marking_a_directory_that_cannot_be_written_is_not_an_error(tmp_path: Path) -> None:
    mark_cache_checked("2.0.0", tmp_path / "does-not-exist")


# ---- the background child ----------------------------------------------------


def test_nothing_starts_for_a_cache_that_is_ready(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    directory = _cache(tmp_path, stamped="2.0.0")
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


def test_a_child_ended_by_ctrl_c_is_not_reported_as_a_failure(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Ctrl+C reaches the child with the server, before the server stops it itself.
    The traceback it leaves ends in ``KeyboardInterrupt`` on every platform."""
    with caplog.at_level(logging.INFO, logger=log.name):
        warm = start_background_warm(
            "2.0.0",
            log,
            directory=_cache(tmp_path),
            command=[_PYTHON, "-c", "raise KeyboardInterrupt"],
        )
        assert warm is not None
        _finished(warm)
    assert [r for r in caplog.records if r.levelno >= logging.WARNING] == []
    assert "was interrupted" in caplog.text
    assert "is ready" not in caplog.text


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX signals")
@pytest.mark.parametrize("sig", [signal.SIGINT, signal.SIGTERM], ids=["SIGINT", "SIGTERM"])
def test_a_child_that_a_signal_ended_is_not_reported_as_a_failure(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, sig: signal.Signals
) -> None:
    with caplog.at_level(logging.INFO, logger=log.name):
        warm = start_background_warm(
            "2.0.0",
            log,
            directory=_cache(tmp_path),
            command=[_PYTHON, "-c", "import time; time.sleep(120)"],
        )
        assert warm is not None
        os.kill(warm._process.pid, sig)
        _finished(warm)
    assert warm._process.returncode == -sig
    assert [r for r in caplog.records if r.levelno >= logging.WARNING] == []
    assert "was interrupted" in caplog.text


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX signals")
def test_a_child_that_was_killed_is_still_reported(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Only the signals a person sends on purpose are let through: a child the
    kernel killed (out of memory) is worth a warning."""
    with caplog.at_level(logging.INFO, logger=log.name):
        warm = start_background_warm(
            "2.0.0",
            log,
            directory=_cache(tmp_path),
            command=[_PYTHON, "-c", "import time; time.sleep(120)"],
        )
        assert warm is not None
        os.kill(warm._process.pid, signal.SIGKILL)
        _finished(warm)
    (failure,) = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert "exit code -9" in failure.getMessage()


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


# ---- a loading worker waits for the child ------------------------------------


_SLEEP = [_PYTHON, "-c", "import time; time.sleep(120)"]


def test_the_marker_is_there_before_the_child_starts_and_gone_after_it_ends(
    tmp_path: Path,
) -> None:
    directory = _cache(tmp_path)
    marker = running_marker(directory)
    # Beside the cache directory, which may not exist yet.
    assert marker.parent == directory.parent
    # The child checks for the marker as its first act: a case loaded while it
    # starts up must already be told to wait.
    script = "import pathlib, sys; sys.exit(0 if pathlib.Path(sys.argv[1]).exists() else 4)"
    warm = start_background_warm(
        "2.0.0", log, directory=directory, command=[_PYTHON, "-c", script, str(marker)]
    )
    assert warm is not None
    _finished(warm)
    assert warm._process.returncode == 0
    assert not marker.exists()
    assert not background_warm_running(directory)


def test_the_marker_is_cleared_when_the_child_fails_and_when_it_cannot_start(
    tmp_path: Path,
) -> None:
    directory = _cache(tmp_path)
    warm = start_background_warm(
        "2.0.0", log, directory=directory, command=[_PYTHON, "-c", "raise SystemExit(3)"]
    )
    assert warm is not None
    _finished(warm)
    assert not running_marker(directory).exists()

    assert (
        start_background_warm(
            "2.0.0", log, directory=directory, command=[str(tmp_path / "no-such-python")]
        )
        is None
    )
    assert not running_marker(directory).exists()


def test_stopping_clears_the_marker_of_a_running_child(tmp_path: Path) -> None:
    directory = _cache(tmp_path)
    warm = start_background_warm("2.0.0", log, directory=directory, command=_SLEEP)
    assert warm is not None
    assert background_warm_running(directory)
    warm.stop()
    assert not background_warm_running(directory)
    assert not running_marker(directory).exists()


def test_a_child_that_cannot_make_its_marker_still_runs(tmp_path: Path) -> None:
    """No marker means nobody waits for it, which is the cost of an unwritable home."""
    directory = _cache(tmp_path)
    running_marker(directory).mkdir()  # touching a directory raises OSError
    warm = start_background_warm(
        "2.0.0", log, directory=directory, command=[_PYTHON, "-c", "pass"]
    )
    assert warm is not None
    _finished(warm)
    assert warm._process.returncode == 0


def test_the_marker_stays_fresh_while_the_child_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(BackgroundWarm, "_HEARTBEAT_SECONDS", 0.05)
    monkeypatch.setattr(codegen_cache, "MARKER_STALE_SECONDS", 0.5)
    directory = _cache(tmp_path)
    warm = start_background_warm("2.0.0", log, directory=directory, command=_SLEEP)
    assert warm is not None
    try:
        # Twice as long as a marker may go untouched.
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline:
            assert background_warm_running(directory)
            time.sleep(0.05)
    finally:
        warm.stop()
    assert not background_warm_running(directory)


def test_a_marker_that_nobody_refreshes_is_a_leftover(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A server that was killed cannot clear its marker; it just stops touching it."""
    monkeypatch.setattr(codegen_cache, "MARKER_STALE_SECONDS", 0.5)
    directory = _cache(tmp_path)
    marker = running_marker(directory)
    marker.touch()
    assert background_warm_running(directory)
    old = time.time() - 3600
    os.utime(marker, (old, old))
    assert not background_warm_running(directory)
    assert wait_for_background_warm(directory, timeout=30.0) == 0.0


def test_there_is_nothing_to_wait_for_without_a_marker(tmp_path: Path) -> None:
    started = time.monotonic()
    assert wait_for_background_warm(_cache(tmp_path), timeout=30.0) == 0.0
    assert time.monotonic() - started < 1.0


def test_waiting_lasts_until_the_child_is_done(tmp_path: Path) -> None:
    directory = _cache(tmp_path)
    warm = start_background_warm(
        "2.0.0",
        log,
        directory=directory,
        command=[_PYTHON, "-c", "import time; time.sleep(1.0)"],
    )
    assert warm is not None
    waited = wait_for_background_warm(directory, timeout=60.0, poll=0.05)
    assert waited > 0.3
    # The caller can now go on: the child is over and the marker gone.
    assert warm._process.poll() is not None
    assert not running_marker(directory).exists()
    _finished(warm)


def test_waiting_gives_up_after_the_bound_and_says_so(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    directory = _cache(tmp_path)
    warm = start_background_warm("2.0.0", log, directory=directory, command=_SLEEP)
    assert warm is not None
    try:
        with caplog.at_level(logging.WARNING, logger="tensa.codegen_cache"):
            waited = wait_for_background_warm(directory, timeout=0.3, poll=0.05)
        # The child still runs; the caller generates the code itself.
        assert 0.3 <= waited < 10.0
        assert warm._process.poll() is None
        assert "still running" in caplog.text
    finally:
        warm.stop()


def test_a_missing_home_directory_is_nothing_to_wait_for(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def no_home() -> Path:
        raise RuntimeError("Could not determine home directory.")

    monkeypatch.setattr(Path, "home", no_home)
    assert wait_for_background_warm() == 0.0


# ---- the wrapper waits before it builds a System --------------------------------


class _StopBuilding(Exception):
    """Raised by the fake ANDES entry points once the wait has been observed."""


@pytest.fixture
def waits(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Record ``wait`` and each ANDES call that builds a System, in order."""
    import andes

    events: list[str] = []

    def wait() -> float:
        events.append("wait")
        return 0.0

    def build(*_args: Any, **_kwargs: Any) -> Any:
        events.append("build")
        raise _StopBuilding

    monkeypatch.setattr(case_module, "wait_for_background_warm", wait)
    monkeypatch.setattr(andes, "load", build)
    monkeypatch.setattr(andes, "System", build)
    return events


def test_loading_a_case_waits_for_the_background_generation_first(
    tmp_path: Path, waits: list[str]
) -> None:
    case = tmp_path / "case.xlsx"
    case.write_bytes(b"not empty")
    with pytest.raises(CaseLoadError):
        Wrapper().load_case(case)
    assert waits == ["wait", "build"]


def test_a_case_that_cannot_be_loaded_at_all_does_not_wait(
    tmp_path: Path, waits: list[str]
) -> None:
    with pytest.raises(CaseLoadError, match="does not exist"):
        Wrapper().load_case(tmp_path / "missing.xlsx")
    assert waits == []


def test_creating_a_blank_system_waits_for_the_background_generation_first(
    waits: list[str],
) -> None:
    with pytest.raises(_StopBuilding):
        Wrapper().create_blank()
    assert waits == ["wait", "build"]


def test_reloading_a_blank_system_waits_for_the_background_generation_first(
    waits: list[str],
) -> None:
    from tensa.core.edit_log import AddOp

    wrapper = Wrapper()
    wrapper._edit_log = [AddOp("Bus", {"idx": 1})]
    with pytest.raises(_StopBuilding):
        wrapper.reload_case()
    assert waits == ["wait", "build"]


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
    result = cli_runner().invoke(cli.app, ["warm-cache", "--quick", "--incremental"])
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
    result = cli_runner().invoke(cli.app, ["warm-cache"])
    assert result.exit_code != 0
    assert cache_state("9.9.9", fake_andes["directory"]) == "unchecked"


# ---- servers that share one marker -------------------------------------------
#
# The marker sits beside ``~/.andes/pycode`` and every ``tensa serve`` on the
# machine uses the same one. A second server used to start its own child and the
# first child to end removed the marker out from under the other, so a loading
# worker stopped waiting while that child was still generating.


def _touch_command(path: Path) -> list[str]:
    """A child that proves it ran by creating ``path``."""
    return [_PYTHON, "-c", f"import pathlib; pathlib.Path({str(path)!r}).touch()"]


def test_a_second_server_leaves_the_generation_to_the_first(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    directory = _cache(tmp_path)
    first = start_background_warm("2.0.0", log, directory=directory, command=_SLEEP)
    assert first is not None
    ran = tmp_path / "second-child-ran"
    try:
        with caplog.at_level(logging.INFO, logger=log.name):
            second = start_background_warm(
                "2.0.0", log, directory=directory, command=_touch_command(ran)
            )
        assert second is None
        assert "another tensa serve is already generating" in caplog.text
        # No child of its own, and the first one's marker is untouched.
        time.sleep(0.3)
        assert not ran.exists()
        assert background_warm_running(directory)
    finally:
        first.stop()
    assert not running_marker(directory).exists()


def test_a_leftover_marker_does_not_stop_a_server_from_warming(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A server that was killed leaves its marker behind; once nobody refreshes it,
    the next server takes its place."""
    monkeypatch.setattr(codegen_cache, "MARKER_STALE_SECONDS", 0.5)
    directory = _cache(tmp_path)
    marker = running_marker(directory)
    marker.write_text("pid-of-a-dead-server", encoding="utf-8")
    old = time.time() - 3600
    os.utime(marker, (old, old))

    warm = start_background_warm("2.0.0", log, directory=directory, command=_SLEEP)
    assert warm is not None
    try:
        assert background_warm_running(directory)
        assert marker.read_text(encoding="utf-8") != "pid-of-a-dead-server"
    finally:
        warm.stop()
    assert not marker.exists()


def _start_together(directory: Path, racers: int) -> list[BackgroundWarm | None]:
    """``racers`` servers asking to warm ``directory`` at the same moment."""
    barrier = threading.Barrier(racers)
    started: list[BackgroundWarm | None] = []

    def race() -> None:
        barrier.wait()
        started.append(start_background_warm("2.0.0", log, directory=directory, command=_SLEEP))

    threads = [threading.Thread(target=race) for _ in range(racers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(60.0)
    return started


def test_servers_that_start_together_do_not_both_warm(tmp_path: Path) -> None:
    """The marker is created exclusively, so exactly one of them gets it."""
    for round_ in range(5):
        (tmp_path / f"round-{round_}").mkdir()
        directory = _cache(tmp_path / f"round-{round_}")
        started = _start_together(directory, racers=6)
        winners = [warm for warm in started if warm is not None]
        try:
            assert len(started) == 6
            assert len(winners) == 1, f"round {round_}: {len(winners)} children started"
        finally:
            for warm in winners:
                warm.stop()


def test_a_server_does_not_touch_a_marker_another_server_now_owns(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If a heartbeat stall let another server take the marker over, the original
    owner neither keeps it alive nor removes it when its own child ends."""
    monkeypatch.setattr(BackgroundWarm, "_HEARTBEAT_SECONDS", 0.05)
    directory = _cache(tmp_path)
    marker = running_marker(directory)
    warm = start_background_warm("2.0.0", log, directory=directory, command=_SLEEP)
    assert warm is not None
    try:
        marker.write_text("the-other-servers-token", encoding="utf-8")
        old = time.time() - 3600
        os.utime(marker, (old, old))
        time.sleep(0.4)  # several beats
        # Not refreshed on the other server's behalf.
        assert time.time() - marker.stat().st_mtime > 3000
    finally:
        warm.stop()
    # Still there, and still the other server's.
    assert marker.read_text(encoding="utf-8") == "the-other-servers-token"


def test_a_marker_without_a_token_is_still_removed_by_its_writer(tmp_path: Path) -> None:
    """``BackgroundWarm`` built the old way, with a marker and no token."""
    marker = tmp_path / "marker"
    marker.touch()
    process = subprocess.Popen(
        [_PYTHON, "-c", "pass"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    warm = BackgroundWarm(process, log, marker)
    _finished(warm)
    assert not marker.exists()
