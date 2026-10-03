"""Unit tests for ``tensa.core.session_dirs`` (unit 1.7, worker hygiene).

Covers the owner marker, the process-liveness probe (the Windows branch through a
fake ``kernel32``), the read-only-aware removal Windows needs, the startup sweep of
abandoned ``.sessions/`` dirs, and how ``SessionManager`` uses them.
"""

from __future__ import annotations

import asyncio
import errno
import os
import stat
import subprocess
import sys
import time
import uuid
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from tensa.core import session_dirs
from tensa.core.clone_manager import CloneManager
from tensa.core.session import SessionManager
from tensa.core.session_dirs import (
    OWNER_MARKER_NAME,
    SESSIONS_DIRNAME,
    OwnerMarker,
    pid_is_alive,
    pid_space,
    process_start_time,
    read_owner_marker,
    read_owner_pid,
    remove_tree,
    sweep_stale_session_dirs,
    write_owner_marker,
)

DAY = 24 * 60 * 60


# ---- helpers ----------------------------------------------------------------


def _session_dir(
    workspace: Path, owner: int | str | None = None, *, fields: tuple[str, ...] = ()
) -> Path:
    """Create ``<workspace>/.sessions/<id>/clone/x.raw``, optionally marked.

    ``owner`` alone writes the bare-pid marker of the first format; ``fields`` are
    the ``key=value`` lines of the current one.
    """
    path = workspace / SESSIONS_DIRNAME / uuid.uuid4().hex
    (path / "clone").mkdir(parents=True)
    (path / "clone" / "x.raw").write_text("case\n", encoding="utf-8")
    if owner is not None:
        text = "".join(f"{line}\n" for line in (str(owner), *fields))
        (path / OWNER_MARKER_NAME).write_text(text, encoding="utf-8")
    return path


def _age(path: Path, seconds: float) -> None:
    """Backdate ``path`` and everything under it by ``seconds``."""
    when = time.time() - seconds
    for dirpath, dirnames, filenames in os.walk(path, topdown=False):
        for name in (*filenames, *dirnames):
            os.utime(os.path.join(dirpath, name), (when, when))
    os.utime(path, (when, when))


@pytest.fixture
def dead_pid() -> int:
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid


@pytest.fixture
def live_pid() -> Iterator[int]:
    """The pid of another process that stays alive for the test."""
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    try:
        yield proc.pid
    finally:
        proc.kill()
        proc.wait()


# ---- owner marker -----------------------------------------------------------


def test_marker_round_trips_the_pid(tmp_path: Path) -> None:
    write_owner_marker(tmp_path, 4242)
    first_line = (tmp_path / OWNER_MARKER_NAME).read_text(encoding="utf-8").splitlines()[0]
    assert first_line == "4242"
    assert read_owner_pid(tmp_path) == 4242


def test_marker_defaults_to_this_process(tmp_path: Path) -> None:
    write_owner_marker(tmp_path)
    assert read_owner_pid(tmp_path) == os.getpid()


def test_marker_records_where_the_owner_runs_and_when_it_started(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(session_dirs, "pid_space", lambda: "box pid:[4026531836]")
    monkeypatch.setattr(session_dirs, "process_start_time", lambda pid: f"t{pid}")
    write_owner_marker(tmp_path, 4242)
    assert (tmp_path / OWNER_MARKER_NAME).read_text(encoding="utf-8") == (
        "4242\nspace=box pid:[4026531836]\nstart=t4242\n"
    )
    assert read_owner_marker(tmp_path) == OwnerMarker(4242, "box pid:[4026531836]", "t4242")


def test_marker_omits_what_the_os_cannot_tell(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(session_dirs, "pid_space", lambda: None)
    monkeypatch.setattr(session_dirs, "process_start_time", lambda pid: None)
    write_owner_marker(tmp_path, 4242)
    assert (tmp_path / OWNER_MARKER_NAME).read_text(encoding="utf-8") == "4242\n"
    assert read_owner_marker(tmp_path) == OwnerMarker(4242, None, None)


def test_a_marker_that_holds_only_a_pid_still_reads(tmp_path: Path) -> None:
    """The first format: a bare pid, with or without the newline."""
    (tmp_path / OWNER_MARKER_NAME).write_text("4242", encoding="utf-8")
    assert read_owner_marker(tmp_path) == OwnerMarker(4242, None, None)
    (tmp_path / OWNER_MARKER_NAME).write_text("4242\n", encoding="utf-8")
    assert read_owner_marker(tmp_path) == OwnerMarker(4242, None, None)


def test_marker_ignores_lines_it_does_not_understand(tmp_path: Path) -> None:
    (tmp_path / OWNER_MARKER_NAME).write_text(
        "4242\nfuture=thing\nspace=\nnot a field\nstart=99\n", encoding="utf-8"
    )
    # An empty value counts as absent.
    assert read_owner_marker(tmp_path) == OwnerMarker(4242, None, "99")


@pytest.mark.parametrize("first_line", ["", "start=99", "0", "-7", "1e3", str(2**31)])
def test_a_marker_without_a_plausible_pid_first_reads_as_no_owner(
    tmp_path: Path, first_line: str
) -> None:
    (tmp_path / OWNER_MARKER_NAME).write_text(
        f"{first_line}\nspace=box\nstart=99\n", encoding="utf-8"
    )
    assert read_owner_marker(tmp_path) is None
    assert read_owner_pid(tmp_path) is None


@pytest.mark.parametrize(
    "content", ["", "not a pid", "0", "-7", "12 34", "1e3", "99999999999999999999", str(2**31)]
)
def test_unusable_marker_reads_as_no_owner(tmp_path: Path, content: str) -> None:
    (tmp_path / OWNER_MARKER_NAME).write_text(content, encoding="utf-8")
    assert read_owner_pid(tmp_path) is None


def test_binary_marker_reads_as_no_owner(tmp_path: Path) -> None:
    (tmp_path / OWNER_MARKER_NAME).write_bytes(b"\xff\xfe\x00\x80")
    assert read_owner_pid(tmp_path) is None


def test_missing_marker_reads_as_no_owner(tmp_path: Path) -> None:
    assert read_owner_pid(tmp_path) is None


def test_marker_failure_is_logged_not_raised(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level("WARNING", logger="tensa.session_dirs")
    write_owner_marker(tmp_path / "no-such-dir", 1)  # parent missing -> OSError
    assert "could not write the owner marker" in caplog.text


# ---- process liveness -------------------------------------------------------


def test_this_process_is_alive() -> None:
    assert pid_is_alive(os.getpid())


def test_another_live_process_is_alive(live_pid: int) -> None:
    assert pid_is_alive(live_pid)


def test_a_reaped_process_is_dead(dead_pid: int) -> None:
    assert not pid_is_alive(dead_pid)


@pytest.mark.parametrize("pid", [0, -1])
def test_non_positive_pid_is_never_probed(pid: int, monkeypatch: pytest.MonkeyPatch) -> None:
    # os.kill(0, 0) would signal the whole process group.
    monkeypatch.setattr(os, "kill", lambda *a: pytest.fail("os.kill must not run"))
    assert not pid_is_alive(pid)


def test_a_pid_too_large_to_exist_is_dead() -> None:
    assert not pid_is_alive(10**30, platform="linux")


def test_a_pid_owned_by_another_user_counts_as_alive(monkeypatch: pytest.MonkeyPatch) -> None:
    def deny(pid: int, sig: int) -> None:
        raise PermissionError(errno.EPERM, "not permitted")

    monkeypatch.setattr(os, "kill", deny)
    assert pid_is_alive(4242, platform="linux")


class _FakeKernel32:
    """Just enough of ``kernel32`` for ``pid_is_alive``."""

    def __init__(
        self,
        *,
        open_ok: bool = True,
        exit_code: int | None = 259,
        last_error: int = 0,
    ) -> None:
        self.open_ok = open_ok
        self.exit_code = exit_code
        self.last_error = last_error
        self.opened: list[tuple[int, bool, int]] = []
        self.closed: list[int] = []

    def OpenProcess(self, access: int, inherit: bool, pid: int) -> int | None:
        self.opened.append((access, inherit, pid))
        return 0xBEEF if self.open_ok else None

    def GetExitCodeProcess(self, handle: int, out: Any) -> int:
        if self.exit_code is None:
            return 0
        out._obj.value = self.exit_code
        return 1

    def CloseHandle(self, handle: int) -> int:
        self.closed.append(handle)
        return 1

    def get_last_error(self) -> int:
        return self.last_error


def _windows_alive(fake: _FakeKernel32, monkeypatch: pytest.MonkeyPatch) -> bool:
    # os.kill terminates the target on Windows, so the branch must never reach it.
    monkeypatch.setattr(os, "kill", lambda *a: pytest.fail("os.kill must not run on Windows"))
    return pid_is_alive(
        4242, kernel32=fake, get_last_error=fake.get_last_error, platform="win32"
    )


def test_windows_running_process_is_alive(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeKernel32(exit_code=259)  # STILL_ACTIVE
    assert _windows_alive(fake, monkeypatch)
    assert fake.opened == [(0x1000, False, 4242)]  # PROCESS_QUERY_LIMITED_INFORMATION
    assert fake.closed == [0xBEEF]


def test_windows_exited_process_is_dead(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeKernel32(exit_code=0)
    assert not _windows_alive(fake, monkeypatch)
    assert fake.closed == [0xBEEF]


def test_windows_no_such_process_is_dead(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeKernel32(open_ok=False, last_error=87)  # ERROR_INVALID_PARAMETER
    assert not _windows_alive(fake, monkeypatch)
    assert fake.closed == []


def test_windows_access_denied_means_it_exists(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeKernel32(open_ok=False, last_error=5)  # ERROR_ACCESS_DENIED
    assert _windows_alive(fake, monkeypatch)


def test_windows_unreadable_exit_code_errs_towards_alive(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeKernel32(exit_code=None)
    assert _windows_alive(fake, monkeypatch)
    assert fake.closed == [0xBEEF]


def test_windows_probe_failure_errs_towards_alive(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(os, "kill", lambda *a: pytest.fail("os.kill must not run on Windows"))

    def boom() -> Any:
        raise OSError("no kernel32")

    monkeypatch.setattr(session_dirs, "_load_kernel32", boom)
    assert pid_is_alive(4242, platform="win32")


# ---- process identity -------------------------------------------------------

linux_only = pytest.mark.skipif(not sys.platform.startswith("linux"), reason="reads /proc")


@linux_only
def test_a_process_has_a_stable_start_time() -> None:
    first = process_start_time(os.getpid())
    assert first is not None and first.isdigit()
    assert process_start_time(os.getpid()) == first


@linux_only
def test_two_processes_have_different_start_times(live_pid: int) -> None:
    assert process_start_time(live_pid) != process_start_time(os.getpid())


@linux_only
def test_a_gone_process_has_no_start_time(dead_pid: int) -> None:
    assert process_start_time(dead_pid) is None


@pytest.mark.parametrize("pid", [0, -1])
def test_a_non_positive_pid_has_no_start_time(pid: int) -> None:
    assert process_start_time(pid) is None


def test_the_start_time_is_the_22nd_field_whatever_the_command_name(tmp_path: Path) -> None:
    """The name sits in parentheses and can hold both spaces and parentheses."""
    # Fields 3 to 24; the 20th of these (field 22) is the start time.
    tail = "S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 10 4096"
    for number, name in enumerate(["python", "my (odd) proc", "a) b ("]):
        proc = tmp_path / str(5000 + number)
        proc.mkdir()
        (proc / "stat").write_text(f"{5000 + number} ({name}) {tail}\n", encoding="utf-8")
        assert session_dirs._linux_process_start_time(5000 + number, str(tmp_path)) == "987654"


def test_a_stat_file_that_does_not_parse_gives_no_start_time(tmp_path: Path) -> None:
    bad = {
        1: "garbage",
        2: "2 (x) S 1 2",  # too few fields
        3: "3 (x) S " + "0 " * 18 + "soon",  # a start time that is not a number
    }
    for pid, text in bad.items():
        (tmp_path / str(pid)).mkdir()
        (tmp_path / str(pid) / "stat").write_text(text, encoding="utf-8")
        assert session_dirs._linux_process_start_time(pid, str(tmp_path)) is None
    assert session_dirs._linux_process_start_time(4, str(tmp_path)) is None  # no such process


def test_macos_has_no_start_time_to_read() -> None:
    assert process_start_time(os.getpid(), platform="darwin") is None


class _FakeTimesKernel32:
    """Just enough of ``kernel32`` for ``process_start_time``."""

    def __init__(self, *, open_ok: bool = True, times_ok: bool = True) -> None:
        self.open_ok = open_ok
        self.times_ok = times_ok
        self.opened: list[tuple[int, bool, int]] = []
        self.closed: list[int] = []

    def OpenProcess(self, access: int, inherit: bool, pid: int) -> int | None:
        self.opened.append((access, inherit, pid))
        return 0xBEEF if self.open_ok else None

    def GetProcessTimes(
        self, handle: int, created: Any, exited: Any, kernel: Any, user: Any
    ) -> int:
        if not self.times_ok:
            return 0
        created._obj.dwLowDateTime = 0x89ABCDEF
        created._obj.dwHighDateTime = 0x01234567
        return 1

    def CloseHandle(self, handle: int) -> int:
        self.closed.append(handle)
        return 1


def test_windows_start_time_is_the_creation_filetime() -> None:
    fake = _FakeTimesKernel32()
    assert process_start_time(4242, kernel32=fake, platform="win32") == str(0x0123456789ABCDEF)
    assert fake.opened == [(0x1000, False, 4242)]  # PROCESS_QUERY_LIMITED_INFORMATION
    assert fake.closed == [0xBEEF]


def test_windows_start_time_needs_a_process_it_can_open() -> None:
    fake = _FakeTimesKernel32(open_ok=False)
    assert process_start_time(4242, kernel32=fake, platform="win32") is None
    assert fake.closed == []


def test_windows_start_time_closes_the_handle_when_the_times_cannot_be_read() -> None:
    fake = _FakeTimesKernel32(times_ok=False)
    assert process_start_time(4242, kernel32=fake, platform="win32") is None
    assert fake.closed == [0xBEEF]


def test_windows_start_time_failure_is_no_start_time(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom() -> Any:
        raise OSError("no kernel32")

    monkeypatch.setattr(session_dirs, "_load_kernel32", boom)
    assert process_start_time(4242, platform="win32") is None


def test_the_pid_space_names_the_host(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(session_dirs.socket, "gethostname", lambda: "boxy")
    space = pid_space()
    assert space is not None and space.startswith("boxy")


@linux_only
def test_the_pid_space_includes_the_pid_namespace_on_linux() -> None:
    space = pid_space()
    assert space is not None
    assert os.readlink("/proc/self/ns/pid") in space


def test_the_pid_space_is_the_bare_host_without_proc(monkeypatch: pytest.MonkeyPatch) -> None:
    def no_proc(path: str) -> str:
        raise FileNotFoundError(errno.ENOENT, "no /proc", path)

    monkeypatch.setattr(session_dirs.socket, "gethostname", lambda: "boxy")
    monkeypatch.setattr(os, "readlink", no_proc)
    assert pid_space() == "boxy"


def test_the_pid_space_is_unknown_when_there_is_no_hostname(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def no_name() -> str:
        raise OSError("no hostname")

    monkeypatch.setattr(session_dirs.socket, "gethostname", no_name)
    assert pid_space() is None


# ---- read-only-aware removal ------------------------------------------------


def _windows_like_unlink(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Make ``os.unlink`` refuse read-only files, as Windows does.

    Returns the paths it refused.
    """
    real_unlink = os.unlink
    refused: list[str] = []

    def unlink(path: str, *, dir_fd: int | None = None) -> None:
        mode = os.stat(path, dir_fd=dir_fd, follow_symlinks=False).st_mode
        if not mode & stat.S_IWUSR:
            refused.append(str(path))
            raise PermissionError(errno.EACCES, "read-only file", str(path))
        real_unlink(path, dir_fd=dir_fd)

    monkeypatch.setattr(os, "unlink", unlink)
    return refused


def _tree_with_read_only_file(root: Path) -> Path:
    victim = root / "tree"
    (victim / "clone").mkdir(parents=True)
    locked = victim / "clone" / "locked.raw"
    locked.write_text("case\n", encoding="utf-8")
    locked.chmod(0o444)
    (victim / "plain.txt").write_text("x\n", encoding="utf-8")
    return victim


def test_remove_tree_deletes_a_read_only_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    refused = _windows_like_unlink(monkeypatch)
    victim = _tree_with_read_only_file(tmp_path)
    remove_tree(victim)
    assert not victim.exists()
    assert refused, "the read-only file was never refused, so the handler was not exercised"


def test_plain_rmtree_fails_on_the_same_tree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Control: the behaviour remove_tree exists to fix."""
    import shutil

    _windows_like_unlink(monkeypatch)
    victim = _tree_with_read_only_file(tmp_path)
    with pytest.raises(PermissionError):
        shutil.rmtree(victim)
    assert victim.exists()


def test_handler_clears_the_bit_then_retries(tmp_path: Path) -> None:
    target = tmp_path / "f"
    target.write_text("x", encoding="utf-8")
    target.chmod(0o444)
    seen: list[int] = []

    def retry(path: str) -> None:
        seen.append(os.stat(path).st_mode & stat.S_IWUSR)

    session_dirs._clear_readonly_and_retry(retry, str(target), PermissionError())
    assert seen == [stat.S_IWUSR]


def test_handler_re_raises_anything_but_a_permission_error(tmp_path: Path) -> None:
    def retry(path: str) -> None:
        pytest.fail("must not retry")

    boom = FileNotFoundError(errno.ENOENT, "gone")
    with pytest.raises(FileNotFoundError):
        session_dirs._clear_readonly_and_retry(retry, str(tmp_path / "x"), boom)


def test_handler_raises_the_original_error_when_chmod_fails(tmp_path: Path) -> None:
    original = PermissionError(errno.EACCES, "denied")

    def retry(path: str) -> None:
        pytest.fail("must not retry")

    with pytest.raises(PermissionError) as info:
        session_dirs._clear_readonly_and_retry(retry, str(tmp_path / "missing"), original)
    assert info.value is original


def test_handler_lets_a_failing_retry_propagate(tmp_path: Path) -> None:
    target = tmp_path / "f"
    target.write_text("x", encoding="utf-8")

    def retry(path: str) -> None:
        raise PermissionError(errno.EACCES, "still locked")

    with pytest.raises(PermissionError, match="still locked"):
        session_dirs._clear_readonly_and_retry(retry, str(target), PermissionError())


# ---- startup sweep ----------------------------------------------------------


def test_sweep_removes_a_dir_whose_owner_is_dead(tmp_path: Path, dead_pid: int) -> None:
    stale = _session_dir(tmp_path, owner=dead_pid)
    assert sweep_stale_session_dirs(tmp_path) == [stale.name]
    assert not stale.exists()


def test_sweep_keeps_a_dir_whose_owner_is_alive(tmp_path: Path, live_pid: int) -> None:
    """Another server sharing the workspace: even an old dir is its own."""
    theirs = _session_dir(tmp_path, owner=live_pid)
    _age(theirs, 10 * DAY)
    assert sweep_stale_session_dirs(tmp_path) == []
    assert (theirs / "clone" / "x.raw").exists()


def test_sweep_keeps_a_dir_owned_by_this_process(tmp_path: Path) -> None:
    mine = _session_dir(tmp_path, owner=os.getpid())
    assert sweep_stale_session_dirs(tmp_path) == []
    assert mine.exists()


def test_sweep_keeps_the_sessions_it_is_told_about(tmp_path: Path, dead_pid: int) -> None:
    kept = _session_dir(tmp_path, owner=dead_pid)
    gone = _session_dir(tmp_path, owner=dead_pid)
    assert sweep_stale_session_dirs(tmp_path, keep={kept.name}) == [gone.name]
    assert kept.exists()
    assert not gone.exists()


def test_sweep_keeps_a_recent_dir_with_no_marker(tmp_path: Path) -> None:
    fresh = _session_dir(tmp_path)
    _age(fresh, DAY / 2)
    assert sweep_stale_session_dirs(tmp_path) == []
    assert fresh.exists()


def test_sweep_removes_an_old_dir_with_no_marker(tmp_path: Path) -> None:
    old = _session_dir(tmp_path)
    _age(old, DAY + 60)
    assert sweep_stale_session_dirs(tmp_path) == [old.name]
    assert not old.exists()


def test_a_recently_touched_file_keeps_an_unmarked_dir(tmp_path: Path) -> None:
    """The dir's own mtime is old, but a file inside was written an hour ago."""
    busy = _session_dir(tmp_path)
    _age(busy, 5 * DAY)
    recent = time.time() - 3600
    os.utime(busy / "clone" / "x.raw", (recent, recent))
    assert sweep_stale_session_dirs(tmp_path) == []
    assert busy.exists()


def test_an_unusable_marker_falls_back_to_the_age_rule(tmp_path: Path) -> None:
    fresh = _session_dir(tmp_path, owner="garbage")
    old = _session_dir(tmp_path, owner="-3")
    _age(old, 2 * DAY)
    assert sweep_stale_session_dirs(tmp_path) == [old.name]
    assert fresh.exists()


def test_sweep_ignores_names_that_are_not_session_ids(tmp_path: Path, dead_pid: int) -> None:
    sessions = tmp_path / SESSIONS_DIRNAME
    notes = sessions / "my-notes"
    notes.mkdir(parents=True)
    (notes / OWNER_MARKER_NAME).write_text(f"{dead_pid}\n", encoding="utf-8")
    upper = sessions / uuid.uuid4().hex.upper()
    upper.mkdir()
    (sessions / "stray-file").write_text("x", encoding="utf-8")
    assert sweep_stale_session_dirs(tmp_path, now=time.time() + 30 * DAY) == []
    assert notes.exists()
    assert upper.exists()
    assert (sessions / "stray-file").exists()


@pytest.mark.skipif(sys.platform == "win32", reason="creating symlinks needs privileges there")
def test_sweep_never_follows_a_symlink(tmp_path: Path, dead_pid: int) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "precious.txt").write_text("keep", encoding="utf-8")
    (outside / OWNER_MARKER_NAME).write_text(f"{dead_pid}\n", encoding="utf-8")
    sessions = tmp_path / "ws" / SESSIONS_DIRNAME
    sessions.mkdir(parents=True)
    (sessions / uuid.uuid4().hex).symlink_to(outside, target_is_directory=True)
    assert sweep_stale_session_dirs(tmp_path / "ws") == []
    assert (outside / "precious.txt").exists()


@pytest.mark.skipif(sys.platform == "win32", reason="creating symlinks needs privileges there")
def test_sweep_skips_a_symlinked_sessions_root(tmp_path: Path, dead_pid: int) -> None:
    stale = _session_dir(tmp_path / "elsewhere", owner=dead_pid)  # elsewhere/.sessions/<id>
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / SESSIONS_DIRNAME).symlink_to(stale.parent, target_is_directory=True)
    assert sweep_stale_session_dirs(ws) == []
    assert stale.exists()


def test_sweep_without_a_sessions_dir_is_a_no_op(tmp_path: Path) -> None:
    assert sweep_stale_session_dirs(tmp_path) == []
    assert sweep_stale_session_dirs(tmp_path / "does-not-exist") == []


def test_sweep_survives_a_dir_it_cannot_remove(
    tmp_path: Path, dead_pid: int, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level("WARNING", logger="tensa.session_dirs")
    stuck = _session_dir(tmp_path, owner=dead_pid)
    fine = _session_dir(tmp_path, owner=dead_pid)
    real_remove = session_dirs.remove_tree

    def remove(path: Any) -> None:
        if Path(path) == stuck:
            raise PermissionError(errno.EACCES, "in use")
        real_remove(path)

    monkeypatch.setattr(session_dirs, "remove_tree", remove)
    assert sweep_stale_session_dirs(tmp_path) == [fine.name]
    assert stuck.exists()
    assert "could not remove stale session dir" in caplog.text


def test_sweep_survives_a_probe_that_raises(tmp_path: Path) -> None:
    broken = _session_dir(tmp_path, owner=111)
    fine = _session_dir(tmp_path, owner=222)

    def probe(pid: int) -> bool:
        if pid == 111:
            raise RuntimeError("probe failed")
        return False

    assert sweep_stale_session_dirs(tmp_path, pid_alive=probe) == [fine.name]
    assert broken.exists()


def test_sweep_uses_the_injected_liveness_probe(tmp_path: Path) -> None:
    dir_a = _session_dir(tmp_path, owner=111)
    dir_b = _session_dir(tmp_path, owner=222)
    removed = sweep_stale_session_dirs(tmp_path, pid_alive=lambda pid: pid == 111)
    assert removed == [dir_b.name]
    assert dir_a.exists()


# ---- startup sweep: whose pid is it? ---------------------------------------

HERE = "box pid:[4026531836]"


def _sweep(
    workspace: Path,
    *,
    alive: bool = True,
    here: str | None = HERE,
    now_start: str | None = "100",
) -> list[str]:
    """The sweep with the pid probe, this process's pid space and the owner's
    current start time all set by hand."""
    return sweep_stale_session_dirs(
        workspace,
        pid_alive=lambda pid: alive,
        local_space=lambda: here,
        start_time=lambda pid: now_start,
    )


def test_sweep_keeps_a_live_owner_that_started_when_the_marker_says(tmp_path: Path) -> None:
    theirs = _session_dir(tmp_path, owner=7, fields=(f"space={HERE}", "start=100"))
    assert _sweep(tmp_path) == []
    assert theirs.exists()


def test_sweep_removes_a_dir_whose_pid_now_belongs_to_another_process(tmp_path: Path) -> None:
    """A container restarted, or Windows handed the pid out again: something with
    that pid is alive, but it is not the server that made the dir."""
    reused = _session_dir(tmp_path, owner=1, fields=(f"space={HERE}", "start=100"))
    assert _sweep(tmp_path, now_start="250") == [reused.name]
    assert not reused.exists()


def test_sweep_keeps_a_dir_when_the_current_start_time_cannot_be_read(tmp_path: Path) -> None:
    theirs = _session_dir(tmp_path, owner=7, fields=(f"space={HERE}", "start=100"))
    assert _sweep(tmp_path, now_start=None) == []
    assert theirs.exists()


def test_sweep_keeps_a_live_owner_whose_marker_has_no_start_time(tmp_path: Path) -> None:
    theirs = _session_dir(tmp_path, owner=7, fields=(f"space={HERE}",))
    assert _sweep(tmp_path, now_start="250") == []
    assert theirs.exists()


def test_sweep_removes_a_dead_owner_in_the_same_pid_space(tmp_path: Path) -> None:
    gone = _session_dir(tmp_path, owner=7, fields=(f"space={HERE}", "start=100"))
    assert _sweep(tmp_path, alive=False) == [gone.name]


def test_sweep_does_not_probe_a_pid_from_another_host(tmp_path: Path) -> None:
    """The pid is meaningless here, so it is neither a reason to keep the dir (the
    probe may find some other process) nor to delete it (it may find nothing)."""
    theirs = _session_dir(tmp_path, owner=7, fields=("space=otherhost pid:[4026531836]", "start=1"))

    def probe(pid: int) -> bool:
        pytest.fail("a pid from another host must not be probed")

    removed = sweep_stale_session_dirs(
        tmp_path, pid_alive=probe, local_space=lambda: HERE, start_time=lambda pid: "250"
    )
    assert removed == []
    assert theirs.exists()


def test_sweep_does_not_probe_a_pid_from_another_pid_namespace(tmp_path: Path) -> None:
    """Two containers on a shared volume, both on the host's network and so both
    named after the host."""
    theirs = _session_dir(tmp_path, owner=1, fields=("space=box pid:[4026532999]",))
    assert _sweep(tmp_path, alive=False) == []
    assert theirs.exists()


def test_a_dir_from_another_host_falls_back_to_the_age_rule(tmp_path: Path) -> None:
    recent = _session_dir(tmp_path, owner=7, fields=("space=otherhost",))
    _age(recent, DAY / 2)
    old = _session_dir(tmp_path, owner=7, fields=("space=otherhost",))
    _age(old, 2 * DAY)
    assert _sweep(tmp_path, alive=False) == [old.name]
    assert recent.exists()


def test_a_recently_touched_file_keeps_a_dir_from_another_host(tmp_path: Path) -> None:
    busy = _session_dir(tmp_path, owner=7, fields=("space=otherhost",))
    _age(busy, 5 * DAY)
    recent = time.time() - 3600
    os.utime(busy / "clone" / "x.raw", (recent, recent))
    assert _sweep(tmp_path, alive=False) == []
    assert busy.exists()


def test_sweep_probes_the_pid_when_this_servers_own_space_is_unknown(tmp_path: Path) -> None:
    theirs = _session_dir(tmp_path, owner=7, fields=("space=otherhost",))
    assert _sweep(tmp_path, here=None) == []
    assert _sweep(tmp_path, here=None, alive=False) == [theirs.name]


def test_sweep_probes_a_pid_from_a_marker_that_names_no_space(tmp_path: Path) -> None:
    """A marker of the first format has only a pid."""
    old_format = _session_dir(tmp_path, owner=7)
    assert _sweep(tmp_path) == []
    assert _sweep(tmp_path, alive=False) == [old_format.name]


def test_a_server_marker_survives_the_real_sweep(tmp_path: Path, live_pid: int) -> None:
    """Marker written by ``write_owner_marker`` for a live process, judged with
    nothing injected: the pid, host and start time all read back as they were."""
    theirs = _session_dir(tmp_path)
    write_owner_marker(theirs, live_pid)
    assert sweep_stale_session_dirs(tmp_path) == []
    assert theirs.exists()


@linux_only
def test_a_reused_pid_is_caught_with_real_start_times(tmp_path: Path, live_pid: int) -> None:
    """The same marker, but the process now holding the pid started at another
    time than the one the marker names."""
    reused = _session_dir(tmp_path)
    write_owner_marker(reused, live_pid)
    text = (reused / OWNER_MARKER_NAME).read_text(encoding="utf-8")
    assert "start=" in text
    started = process_start_time(live_pid)
    assert started is not None
    (reused / OWNER_MARKER_NAME).write_text(
        text.replace(f"start={started}", f"start={int(started) + 500}"), encoding="utf-8"
    )
    assert sweep_stale_session_dirs(tmp_path) == [reused.name]


# ---- SessionManager wiring --------------------------------------------------


def test_manager_start_sweeps_abandoned_dirs(tmp_path: Path, dead_pid: int, live_pid: int) -> None:
    abandoned = _session_dir(tmp_path, owner=dead_pid)
    shared = _session_dir(tmp_path, owner=live_pid)

    async def run() -> None:
        mgr = SessionManager(workspace=str(tmp_path))
        await mgr.start()
        await mgr.shutdown()

    asyncio.run(run())
    assert not abandoned.exists()
    assert shared.exists()


def test_manager_start_sweeps_only_once(tmp_path: Path, dead_pid: int) -> None:
    async def run() -> None:
        mgr = SessionManager(workspace=str(tmp_path))
        await mgr.start()
        late = _session_dir(tmp_path, owner=dead_pid)
        await mgr.start()  # idempotent: must not sweep again
        assert late.exists()
        await mgr.shutdown()

    asyncio.run(run())


def test_manager_without_a_workspace_has_nothing_to_sweep() -> None:
    async def run() -> None:
        mgr = SessionManager()
        await mgr.start()
        await mgr.shutdown()

    asyncio.run(run())


def test_a_failing_sweep_does_not_stop_startup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    from tensa.core import session

    def boom(*args: Any, **kwargs: Any) -> list[str]:
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(session, "sweep_stale_session_dirs", boom)
    caplog.set_level("WARNING", logger="tensa.session")

    async def run() -> bool:
        mgr = SessionManager(workspace=str(tmp_path))
        await mgr.start()
        started = mgr._reaper_task is not None
        await mgr.shutdown()
        return started

    assert asyncio.run(run())
    assert "could not sweep stale session dirs" in caplog.text


def test_closing_a_session_removes_a_dir_with_read_only_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """On Windows the clone of a read-only case file blocked the cleanup, and the
    error was swallowed, so the dir leaked."""
    refused = _windows_like_unlink(monkeypatch)
    session_id = uuid.uuid4().hex
    root = tmp_path / SESSIONS_DIRNAME / session_id
    (root / "clone").mkdir(parents=True)
    locked = root / "clone" / "case.raw"
    locked.write_text("case\n", encoding="utf-8")
    locked.chmod(0o444)
    SessionManager(workspace=str(tmp_path))._cleanup_clone_dir(session_id)
    assert not root.exists()
    assert refused


class _FakeWrapper(SimpleNamespace):
    """The three things ``CloneManager`` reads from a ``Wrapper``."""

    reloads: int = 0

    def reload_case(self) -> None:
        self.reloads += 1


def _clone_manager(workspace: Path, session_id: str) -> tuple[CloneManager, _FakeWrapper]:
    """A ``CloneManager`` over a read-only case file. ``shutil.copy2`` carries the
    read-only bit into the clone, as it does on Windows."""
    case = workspace / "case.raw"
    if not case.exists():
        case.write_text("case\n", encoding="utf-8")
        case.chmod(0o444)
    wrapper = _FakeWrapper(_case_path=case, _addfiles=[])
    mgr = CloneManager(
        wrapper=wrapper,  # type: ignore[arg-type]
        workspace=workspace,
        session_id=session_id,
    )
    return mgr, wrapper


def test_init_clone_replaces_a_leftover_clone_of_a_read_only_case_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A fresh manager (the worker was respawned) finds the previous clone dir,
    whose copy of the case file is read-only, and has to remove it first."""
    refused = _windows_like_unlink(monkeypatch)
    session_id = uuid.uuid4().hex
    first, _ = _clone_manager(tmp_path, session_id)
    first.init_clone()
    assert first.clone_dir is not None
    (first.clone_dir / "leftover.txt").write_text("from the first clone\n", encoding="utf-8")

    second, _ = _clone_manager(tmp_path, session_id)
    result = second.init_clone()

    assert result.already_initialized is False
    assert refused, "the read-only file was never refused, so the handler was not exercised"
    assert second.clone_dir is not None
    assert sorted(p.name for p in second.clone_dir.iterdir()) == ["case.raw"]


def test_reset_clone_deletes_a_clone_of_a_read_only_case_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    refused = _windows_like_unlink(monkeypatch)
    mgr, wrapper = _clone_manager(tmp_path, uuid.uuid4().hex)
    mgr.init_clone()
    clone_dir = mgr.clone_dir
    assert clone_dir is not None and clone_dir.is_dir()

    mgr.reset_clone()

    assert not clone_dir.exists()
    assert refused, "the read-only file was never refused, so the handler was not exercised"
    assert mgr.clone_dir is None
    assert not mgr.is_initialized
    assert wrapper.reloads == 1
