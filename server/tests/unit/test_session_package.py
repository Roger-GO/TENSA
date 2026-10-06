"""``tensa.core.session`` keeps the import surface it had as one module.

The ``SessionManager`` is put together from one mixin per concern, in the modules
beside it, and the records and helpers those share live there too. Callers (the
routes, the worker's tests, scripts) still reach every name through
``tensa.core.session`` and every method through ``SessionManager``; these tests pin
that.
"""

from __future__ import annotations

import importlib
import subprocess
import sys

import pytest

import tensa.core.session as session_pkg
from tensa.core.errors import WorkerDiedError
from tensa.core.session import SessionManager

# Every name the single-file module defined (bar its logger), and the module of the
# package that defines it now. ``tensa.core.session`` must hand out that very object.
SURFACE: dict[str, str] = {
    "IDLE_REAP_TICK": "registry",
    "JOB_LIVENESS_TICK": "jobs",
    "RUN_BUFFER_RETENTION_SECONDS": "buffers",
    "RUN_CONSUMER_QUEUE_SIZE": "buffers",
    "RunState": "buffers",
    "SWEEP_WORKERS_LOST_CATEGORY": "sweeps",
    "SessionExpiredError": "errors",
    "SweepInProgressError": "errors",
    "SweepState": "buffers",
    "WORKER_DIED_CATEGORY": "errors",
    "WorkerError": "errors",
    "_RunBuffer": "buffers",
    "_RunConsumer": "buffers",
    "_Session": "base",
    "_SweepBuffer": "buffers",
    "_absorb_log": "registry",
    "_current_inflight_job": "registry",
    "_job_event_envelope": "jobs",
    "_stream_error_problem": "jobs",
    "_streaming_request_summary": "runs",
    "_sweep_request_summary": "sweeps",
    "_worker_died_problem": "jobs",
}

# The names the old module's ``__all__`` listed that it did not define itself, plus
# its type alias for the manager's ``invoke``.
ELSEWHERE = {"SessionManager", "SessionInvoke", "WorkerDiedError"}

# Every method of the one-file ``SessionManager``, and the module that defines it
# now. The private ones are what the routes and the tests reach for.
METHODS: dict[str, str] = {
    "__init__": "base",
    "_session_expired_error": "base",
    "_require_session": "base",
    "session_job_registry": "jobs",
    "global_job_registry": "jobs",
    "list_session_jobs": "jobs",
    "get_session_job": "jobs",
    "cancel_session_job": "jobs",
    "subscribe_job_events": "jobs",
    "broadcast_job_event": "jobs",
    "_liveness_loop": "jobs",
    "sweep_dead_worker_jobs": "jobs",
    "start": "registry",
    "_sweep_stale_scratch_dirs": "registry",
    "shutdown": "registry",
    "create_session": "registry",
    "close_session": "registry",
    "_close_session": "registry",
    "_cleanup_clone_dir": "registry",
    "_raise_worker_died": "registry",
    "invoke": "registry",
    "invoke_streaming": "registry",
    "signal_abort": "registry",
    "session_messages": "registry",
    "list_sessions": "registry",
    "is_alive": "registry",
    "touch": "registry",
    "_reap_loop": "registry",
    "start_streaming_run": "runs",
    "_drive_streaming_run": "runs",
    "_finish_run_buffer": "runs",
    "attach_to_run": "runs",
    "register_streaming_job": "runs",
    "_mark_streaming_job_running": "runs",
    "_finish_streaming_job": "runs",
    "start_sweep": "sweeps",
    "_drive_sweep": "sweeps",
    "_run_sweep_on_session_worker": "sweeps",
    "_plan_parallel_sweep": "sweeps",
    "_run_sweep_in_parallel": "sweeps",
    "_finish_sweep": "sweeps",
    "attach_to_sweep": "sweeps",
    "get_sweep_buffer": "sweeps",
    "register_sweep_job": "sweeps",
    "_finish_sweep_job": "sweeps",
}


def _definers(name: str) -> list[type]:
    return [klass for klass in SessionManager.__mro__[:-1] if name in vars(klass)]


@pytest.mark.unit
@pytest.mark.parametrize(("name", "module"), sorted(SURFACE.items()))
def test_a_name_the_module_defined_is_the_object_its_new_module_defines(
    name: str, module: str
) -> None:
    home = importlib.import_module(f"tensa.core.session.{module}")
    assert hasattr(session_pkg, name)
    assert getattr(session_pkg, name) is getattr(home, name)


@pytest.mark.unit
def test_the_package_exports_the_names_the_module_defined() -> None:
    assert set(session_pkg.__all__) == {*SURFACE, *ELSEWHERE}
    assert session_pkg.WorkerDiedError is WorkerDiedError


@pytest.mark.unit
def test_the_manager_is_still_defined_at_the_old_module_path() -> None:
    assert SessionManager.__module__ == "tensa.core.session"
    assert session_pkg.SessionManager is SessionManager


@pytest.mark.unit
@pytest.mark.parametrize(("method", "module"), sorted(METHODS.items()))
def test_a_method_of_the_manager_is_defined_by_exactly_one_mixin(
    method: str, module: str
) -> None:
    # A name defined twice would be settled by the order the mixins are listed in,
    # which a later edit of that list could change without anyone noticing.
    definers = _definers(method)
    assert [klass.__module__ for klass in definers] == [f"tensa.core.session.{module}"]


@pytest.mark.unit
def test_the_manager_has_no_method_the_single_file_did_not() -> None:
    defined = {
        name
        for klass in SessionManager.__mro__[:-1]
        for name in vars(klass)
        if not (name.startswith("__") and name.endswith("__") and name != "__init__")
    }
    assert defined == set(METHODS)


@pytest.mark.unit
def test_the_parts_are_put_together_in_one_order() -> None:
    # Runs and sweeps build on the registry, which builds on the jobs surface, which
    # builds on the shared state: the order the classes are listed in follows that.
    assert [klass.__module__.rsplit(".", 1)[-1] for klass in SessionManager.__mro__[:-1]] == [
        "session",
        "runs",
        "sweeps",
        "registry",
        "jobs",
        "base",
    ]


@pytest.mark.unit
def test_the_manager_keeps_its_constructor_arguments() -> None:
    manager = SessionManager(
        max_sessions=2, idle_timeout=5.0, spawn_method="spawn", workspace=None, sweep_workers=1
    )
    assert manager.list_sessions() == []


@pytest.mark.unit
def test_the_manager_logs_under_its_old_logger_name() -> None:
    # Tests and anyone filtering the server's log select it by this name.
    for module in ("jobs", "registry", "runs", "sweeps"):
        source = importlib.import_module(f"tensa.core.session.{module}")
        assert source.log.name == "tensa.session"


@pytest.mark.integration
def test_the_package_imports_without_the_api_or_andes() -> None:
    # The manager runs in the server process, which loads no case: ANDES belongs to
    # the workers, and ``core/`` never imports from ``api/`` (see core/errors.py).
    done = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys, tensa.core.session; "
            "bad = [m for m in sys.modules if m == 'andes' or m.startswith('tensa.api')]; "
            "sys.exit(1 if bad else 0)",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert done.returncode == 0, done.stderr
