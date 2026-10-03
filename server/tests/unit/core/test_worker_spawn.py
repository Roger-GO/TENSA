"""Unit tests for ``tensa.core.worker_spawn`` (worker hygiene).

Thread caps for the worker's BLAS, and the Windows Job Object that ties a worker's
life to the server's. The Job Object calls cannot run on this OS, so the call
sequence is driven through a fake ``kernel32`` and the platform guard is tested
directly.
"""

from __future__ import annotations

import asyncio
import ctypes
import multiprocessing as mp
import os
from types import SimpleNamespace
from typing import Any

import pytest

from tensa.core import session, worker_spawn
from tensa.core.session import SessionManager
from tensa.core.worker_spawn import (
    DEFAULT_WORKER_THREADS,
    THREAD_ENV_VARS,
    WORKER_THREADS_ENV,
    KillOnCloseJob,
    attach_kill_on_close_job,
    worker_spawn_env,
    worker_thread_env,
)

ALL_VARS = (*THREAD_ENV_VARS, WORKER_THREADS_ENV)


@pytest.fixture(autouse=True)
def clean_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """None of the thread variables set, whatever the developer's shell has."""
    for name in ALL_VARS:
        monkeypatch.delenv(name, raising=False)


def _caps(value: int | str) -> dict[str, str]:
    return dict.fromkeys(THREAD_ENV_VARS, str(value))


# ---- worker_thread_env ------------------------------------------------------


def test_the_default_is_four_threads_for_every_library() -> None:
    assert DEFAULT_WORKER_THREADS == 4
    assert set(THREAD_ENV_VARS) == {
        "OMP_NUM_THREADS",
        "OPENBLAS_NUM_THREADS",
        "MKL_NUM_THREADS",
        "VECLIB_MAXIMUM_THREADS",
        "NUMEXPR_NUM_THREADS",
    }
    assert worker_thread_env({}) == _caps(4)


def test_a_value_the_user_already_set_is_left_alone() -> None:
    env = {"OPENBLAS_NUM_THREADS": "2", "MKL_NUM_THREADS": "1"}
    assert worker_thread_env(env) == {
        name: "4" for name in THREAD_ENV_VARS if name not in env
    }


@pytest.mark.parametrize("omp", ["1", "2", "8", "16"])
def test_the_libraries_follow_the_openmp_count_the_user_set(omp: str) -> None:
    """OpenBLAS, MKL and numexpr fall back to ``OMP_NUM_THREADS`` only while their
    own variable is unset, so filling them with 4 would override a user who set
    just ``OMP_NUM_THREADS``, a higher count included."""
    assert worker_thread_env({"OMP_NUM_THREADS": omp}) == {
        name: omp for name in THREAD_ENV_VARS if name != "OMP_NUM_THREADS"
    }


def test_a_variable_set_beside_omp_keeps_its_own_value() -> None:
    env = {"OMP_NUM_THREADS": "2", "MKL_NUM_THREADS": "6"}
    added = worker_thread_env(env)
    assert "MKL_NUM_THREADS" not in added
    assert added["OPENBLAS_NUM_THREADS"] == "2"


@pytest.mark.parametrize(
    ("omp", "expected"),
    [("2,1", "2"), (" 3", "3"), ("", "4"), ("auto", "4"), ("0", "4"), ("-2", "4")],
)
def test_an_openmp_value_that_is_not_a_count_falls_back_to_the_default(
    omp: str, expected: str
) -> None:
    added = worker_thread_env({"OMP_NUM_THREADS": omp})
    assert added["OPENBLAS_NUM_THREADS"] == expected


def test_a_legacy_goto_count_is_left_for_openblas_to_resolve() -> None:
    """OpenBLAS reads GOTO_NUM_THREADS ahead of OMP_NUM_THREADS, so an
    OPENBLAS_NUM_THREADS of ours would override it."""
    added = worker_thread_env({"GOTO_NUM_THREADS": "1"})
    assert "OPENBLAS_NUM_THREADS" not in added
    assert added["OMP_NUM_THREADS"] == "4"
    assert added["MKL_NUM_THREADS"] == "4"


def test_every_variable_set_means_nothing_to_add() -> None:
    assert worker_thread_env(_caps(8)) == {}


def test_tensa_worker_threads_overrides_the_default_and_the_users_values() -> None:
    env = {WORKER_THREADS_ENV: "2", "OMP_NUM_THREADS": "16"}
    assert worker_thread_env(env) == _caps(2)


@pytest.mark.parametrize("bad", ["", "abc", "0", "-3", "2.5", " "])
def test_a_bad_override_is_logged_and_the_default_applies(
    bad: str, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level("WARNING", logger="tensa.worker_spawn")
    assert worker_thread_env({WORKER_THREADS_ENV: bad}) == _caps(4)
    assert WORKER_THREADS_ENV in caplog.text


def test_a_bad_override_still_respects_what_the_user_set() -> None:
    env = {WORKER_THREADS_ENV: "zero", "OPENBLAS_NUM_THREADS": "3"}
    added = worker_thread_env(env)
    assert "OPENBLAS_NUM_THREADS" not in added
    assert added["OMP_NUM_THREADS"] == "4"


def test_an_openmp_style_list_is_not_a_valid_override() -> None:
    assert worker_thread_env({WORKER_THREADS_ENV: "2,1"}) == _caps(4)


# ---- worker_spawn_env -------------------------------------------------------


def test_the_caps_are_set_inside_the_block_and_gone_after() -> None:
    with worker_spawn_env():
        assert {name: os.environ[name] for name in THREAD_ENV_VARS} == _caps(4)
    assert not any(name in os.environ for name in THREAD_ENV_VARS)


def test_the_environment_is_restored_when_the_block_raises() -> None:
    with pytest.raises(RuntimeError), worker_spawn_env():
        raise RuntimeError("start() failed")
    assert not any(name in os.environ for name in THREAD_ENV_VARS)


def test_an_override_is_undone_to_the_users_own_values(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OMP_NUM_THREADS", "16")
    monkeypatch.setenv(WORKER_THREADS_ENV, "2")
    with worker_spawn_env():
        assert os.environ["OMP_NUM_THREADS"] == "2"
        assert os.environ["MKL_NUM_THREADS"] == "2"
    assert os.environ["OMP_NUM_THREADS"] == "16"
    assert "MKL_NUM_THREADS" not in os.environ
    assert os.environ[WORKER_THREADS_ENV] == "2"


def _report_thread_env(conn: Any) -> None:
    """Runs in the spawned child: send back the variables it was started with."""
    conn.send({name: os.environ.get(name) for name in THREAD_ENV_VARS})


@pytest.mark.parametrize(
    ("parent_env", "expected"),
    [
        ({}, _caps(4)),
        ({"OMP_NUM_THREADS": "1"}, _caps(1)),
        ({"OMP_NUM_THREADS": "8"}, _caps(8)),
        ({"OMP_NUM_THREADS": "2", "MKL_NUM_THREADS": "6"}, {**_caps(2), "MKL_NUM_THREADS": "6"}),
        ({"GOTO_NUM_THREADS": "1"}, {**_caps(4), "OPENBLAS_NUM_THREADS": None}),
        ({WORKER_THREADS_ENV: "2", "MKL_NUM_THREADS": "8"}, _caps(2)),
    ],
)
def test_a_spawned_child_starts_with_the_caps(
    monkeypatch: pytest.MonkeyPatch,
    parent_env: dict[str, str],
    expected: dict[str, str | None],
) -> None:
    """The real mechanism: ``spawn`` copies ``os.environ`` at ``start()``, which is
    before the child can import numpy."""
    for name, value in parent_env.items():
        monkeypatch.setenv(name, value)
    ctx = mp.get_context("spawn")
    parent, child = ctx.Pipe()
    proc = ctx.Process(target=_report_thread_env, args=(child,))
    with worker_spawn_env():
        proc.start()
    child.close()
    try:
        assert parent.poll(60), "the child never reported"
        assert parent.recv() == expected
    finally:
        proc.join(30)
        parent.close()
    assert proc.exitcode == 0


# ---- SessionManager.create_session ------------------------------------------


class _RecordingProcess:
    """Stands in for ``mp.Process``: records what the manager hands it and the
    environment at the moment of ``start()``."""

    pid: int | None = 31337

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.env_at_start: dict[str, str] | None = None

    def start(self) -> None:
        self.env_at_start = dict(os.environ)


def _manager_with_recording_ctx(pid: int | None = 31337) -> SessionManager:
    mgr = SessionManager(workspace="/ws")
    real = mgr._spawn_ctx
    process_cls = type("Proc", (_RecordingProcess,), {"pid": pid})
    mgr._spawn_ctx = SimpleNamespace(Pipe=real.Pipe, Event=real.Event, Process=process_cls)
    return mgr


def _close_pipes(mgr: SessionManager) -> None:
    for sess in mgr._sessions.values():
        sess.ctrl.close()
        sess.data.close()


def test_a_new_worker_is_started_with_the_caps_and_the_server_pid(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attached: list[int] = []
    monkeypatch.setattr(session, "attach_kill_on_close_job", attached.append)
    mgr = _manager_with_recording_ctx()
    sid = asyncio.run(mgr.create_session())
    try:
        proc = mgr._sessions[sid].process
        assert proc.env_at_start is not None
        assert {name: proc.env_at_start[name] for name in THREAD_ENV_VARS} == _caps(4)
        # args: (ctrl, data, abort_event, workspace, session_id, owner_pid). The
        # last is the SERVER's pid, which the worker records as its dirs' owner.
        assert proc.kwargs["args"][3:] == ("/ws", sid, os.getpid())
        assert attached == [31337]
        # ... and the server's own environment was not left capped.
        assert not any(name in os.environ for name in THREAD_ENV_VARS)
    finally:
        _close_pipes(mgr)


def test_a_worker_without_a_pid_is_not_attached_to_a_job(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attached: list[int] = []
    monkeypatch.setattr(session, "attach_kill_on_close_job", attached.append)
    mgr = _manager_with_recording_ctx(pid=None)
    asyncio.run(mgr.create_session())
    try:
        assert attached == []
    finally:
        _close_pipes(mgr)


# ---- Windows Job Object -----------------------------------------------------


class _FakeJobKernel32:
    """Records the Job Object calls; each result is configurable."""

    def __init__(
        self,
        *,
        job: int | None = 0xA0,
        set_info: int = 1,
        process: int | None = 0xB0,
        assign: int = 1,
    ) -> None:
        self._job = job
        self._set_info = set_info
        self._process = process
        self._assign = assign
        self.calls: list[tuple[Any, ...]] = []
        self.limit_flags: int | None = None

    def CreateJobObjectW(self, attributes: Any, name: Any) -> int | None:
        self.calls.append(("CreateJobObjectW", attributes, name))
        return self._job

    def SetInformationJobObject(self, job: int, info_class: int, info: Any, size: int) -> int:
        self.limit_flags = info._obj.BasicLimitInformation.LimitFlags
        self.calls.append(("SetInformationJobObject", job, info_class, size))
        return self._set_info

    def OpenProcess(self, access: int, inherit: bool, pid: int) -> int | None:
        self.calls.append(("OpenProcess", access, inherit, pid))
        return self._process

    def AssignProcessToJobObject(self, job: int, process: int) -> int:
        self.calls.append(("AssignProcessToJobObject", job, process))
        return self._assign

    def CloseHandle(self, handle: int) -> int:
        self.calls.append(("CloseHandle", handle))
        return 1


def test_the_job_is_created_with_kill_on_close_and_the_worker_assigned() -> None:
    fake = _FakeJobKernel32()
    KillOnCloseJob(fake, lambda: 0).assign(4242)
    assert fake.calls == [
        ("CreateJobObjectW", None, None),
        (
            "SetInformationJobObject",
            0xA0,
            9,  # JobObjectExtendedLimitInformation
            ctypes.sizeof(worker_spawn._JobObjectExtendedLimitInformation),
        ),
        ("OpenProcess", 0x0101, False, 4242),  # PROCESS_SET_QUOTA | PROCESS_TERMINATE
        ("AssignProcessToJobObject", 0xA0, 0xB0),
        ("CloseHandle", 0xB0),  # the process handle; the job handle stays open
    ]
    assert fake.limit_flags == 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE


def test_creating_the_job_can_fail() -> None:
    with pytest.raises(OSError, match=r"CreateJobObjectW failed \(Windows error 5\)"):
        KillOnCloseJob(_FakeJobKernel32(job=None), lambda: 5)


def test_a_job_that_cannot_be_configured_is_closed_again() -> None:
    fake = _FakeJobKernel32(set_info=0)
    with pytest.raises(OSError, match="SetInformationJobObject failed"):
        KillOnCloseJob(fake, lambda: 6)
    assert fake.calls[-1] == ("CloseHandle", 0xA0)


def test_a_worker_that_cannot_be_opened_is_reported() -> None:
    job = KillOnCloseJob(_FakeJobKernel32(process=None), lambda: 87)
    with pytest.raises(OSError, match=r"OpenProcess\(4242\) failed"):
        job.assign(4242)


def test_the_process_handle_is_closed_even_when_the_assignment_fails() -> None:
    fake = _FakeJobKernel32(assign=0)
    job = KillOnCloseJob(fake, lambda: 5)
    with pytest.raises(OSError, match=r"AssignProcessToJobObject\(4242\) failed"):
        job.assign(4242)
    assert fake.calls[-1] == ("CloseHandle", 0xB0)


def test_the_ctypes_structs_match_the_64_bit_windows_layout() -> None:
    if ctypes.sizeof(ctypes.c_void_p) != 8:
        pytest.skip("the expected offsets are the 64-bit ones")
    basic = worker_spawn._JobObjectBasicLimitInformation
    extended = worker_spawn._JobObjectExtendedLimitInformation
    assert ctypes.sizeof(basic) == 64
    assert basic.LimitFlags.offset == 16
    assert extended.IoInfo.offset == 64
    assert extended.ProcessMemoryLimit.offset == 112
    assert ctypes.sizeof(extended) == 144


@pytest.fixture
def fresh_job_state(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(worker_spawn, "_shared_job", None)


def _pretend_windows(monkeypatch: pytest.MonkeyPatch, kernel32: Any) -> None:
    monkeypatch.setattr(worker_spawn, "sys", SimpleNamespace(platform="win32"))
    monkeypatch.setattr(worker_spawn, "_load_kernel32", lambda: kernel32)
    monkeypatch.setattr(worker_spawn, "_last_error", lambda: 0)


def test_attaching_does_nothing_off_windows(
    monkeypatch: pytest.MonkeyPatch, fresh_job_state: None
) -> None:
    def must_not_load() -> Any:
        pytest.fail("kernel32 must not be touched off Windows")

    monkeypatch.setattr(worker_spawn, "_load_kernel32", must_not_load)
    monkeypatch.setattr(worker_spawn, "sys", SimpleNamespace(platform="linux"))
    assert attach_kill_on_close_job(4242) is False
    assert worker_spawn._shared_job is None


def test_every_worker_joins_the_same_job(
    monkeypatch: pytest.MonkeyPatch, fresh_job_state: None
) -> None:
    fake = _FakeJobKernel32()
    _pretend_windows(monkeypatch, fake)
    assert attach_kill_on_close_job(1001) is True
    assert attach_kill_on_close_job(1002) is True
    names = [call[0] for call in fake.calls]
    assert names.count("CreateJobObjectW") == 1
    assert names.count("AssignProcessToJobObject") == 2
    assert [call[3] for call in fake.calls if call[0] == "OpenProcess"] == [1001, 1002]


def test_a_failure_is_logged_and_never_raised(
    monkeypatch: pytest.MonkeyPatch, fresh_job_state: None, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level("WARNING", logger="tensa.worker_spawn")
    _pretend_windows(monkeypatch, _FakeJobKernel32(assign=0))
    assert attach_kill_on_close_job(4242) is False
    assert "could not put worker 4242 in a Job Object" in caplog.text


def test_a_job_that_cannot_be_created_is_retried_for_the_next_worker(
    monkeypatch: pytest.MonkeyPatch, fresh_job_state: None
) -> None:
    _pretend_windows(monkeypatch, _FakeJobKernel32(job=None))
    assert attach_kill_on_close_job(1) is False
    assert worker_spawn._shared_job is None
    _pretend_windows(monkeypatch, _FakeJobKernel32())
    assert attach_kill_on_close_job(2) is True


def test_an_unexpected_exception_is_swallowed_too(
    monkeypatch: pytest.MonkeyPatch, fresh_job_state: None
) -> None:
    def explode() -> Any:
        raise AttributeError("kernel32 has no CreateJobObjectW")

    _pretend_windows(monkeypatch, None)
    monkeypatch.setattr(worker_spawn, "_load_kernel32", explode)
    assert attach_kill_on_close_job(4242) is False
