"""SessionManager: spawns one worker subprocess per session, marshals
request/response over Pipes, owns idle-timeout reaping and the shutdown
escalation.

The SessionManager runs in the FastAPI parent process. It is the only place
where worker subprocesses are spawned. The FastAPI routers call its async
methods; the SessionManager handles the synchronous Pipe IPC via a thread
pool.

Concurrency model:

- One ``multiprocessing.Process`` per session. A long sensitivity sweep also
  spawns short-lived sub-workers for its duration (``core/sweep_pool.py``).
- One ``Lock`` per session — only one in-flight ``invoke`` at a time per
  session (per-session run-cap is also enforced at the API layer).
- A background reaper task scans for idle sessions every ``IDLE_REAP_TICK``
  seconds and calls ``close()`` on any session whose ``last_active`` is
  older than ``idle_timeout``. Every request to the worker stamps
  ``last_active``, and so does ``touch``, which a client that has no request to
  make (an open browser tab with nothing going on) calls to say it is still
  there.

A running TDS (batch or streaming) is stopped cooperatively: ``signal_abort``
sets an event the worker checks on every ``callpert`` step. Closing a session
escalates: a ``shutdown`` request, then ``terminate()``, then ``kill()`` if the
worker is still alive.

Layout: ``SessionManager`` is put together here from one mixin per concern, each
in its own module of this package over the shared state in
``base.SessionManagerBase`` (a mixin that calls another's methods inherits from
it):

- ``jobs``: the job registries as the routes read them, the live feed of job
  transitions, cancelling a job, and the liveness sweeper.
- ``registry``: spawning, closing and reaping sessions, and the requests to a
  session's worker.
- ``runs``: streaming runs that outlive their client.
- ``sweeps``: sensitivity sweeps.

``errors`` holds what the manager raises, ``buffers`` what a run and a sweep keep
for a client that attaches late, and ``base`` also holds ``_Session``, the
bookkeeping of one live session. Every name the single-file module defined is
importable from here.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from tensa.core.errors import WorkerDiedError
from tensa.core.session.base import _Session
from tensa.core.session.buffers import (
    RUN_BUFFER_RETENTION_SECONDS,
    RUN_CONSUMER_QUEUE_SIZE,
    RunState,
    SweepState,
    _RunBuffer,
    _RunConsumer,
    _SweepBuffer,
)
from tensa.core.session.errors import (
    WORKER_DIED_CATEGORY,
    SessionExpiredError,
    SweepInProgressError,
    WorkerError,
)
from tensa.core.session.jobs import (
    JOB_LIVENESS_TICK,
    _job_event_envelope,
    _stream_error_problem,
    _worker_died_problem,
)
from tensa.core.session.registry import IDLE_REAP_TICK, _absorb_log, _current_inflight_job
from tensa.core.session.runs import RunsMixin, _streaming_request_summary
from tensa.core.session.sweeps import (
    SWEEP_WORKERS_LOST_CATEGORY,
    SweepsMixin,
    _sweep_request_summary,
)


class SessionManager(RunsMixin, SweepsMixin):
    """Owns the registry of live sessions and the reaper task.

    Public methods are async to integrate cleanly with FastAPI dependency
    injection. Synchronous IPC (Pipe send/recv) is offloaded to a default
    asyncio executor.
    """


# Type aliases that downstream modules can import without re-typing
SessionInvoke = Callable[..., Awaitable[Any]]

# Every name the single-file module defined, kept importable from here; the private
# ones are what the routes and the tests reach for.
__all__ = [
    "IDLE_REAP_TICK",
    "JOB_LIVENESS_TICK",
    "RUN_BUFFER_RETENTION_SECONDS",
    "RUN_CONSUMER_QUEUE_SIZE",
    "RunState",
    "SWEEP_WORKERS_LOST_CATEGORY",
    "SessionExpiredError",
    "SessionInvoke",
    "SessionManager",
    "SweepInProgressError",
    "SweepState",
    "WORKER_DIED_CATEGORY",
    "WorkerDiedError",
    "WorkerError",
    "_RunBuffer",
    "_RunConsumer",
    "_Session",
    "_SweepBuffer",
    "_absorb_log",
    "_current_inflight_job",
    "_job_event_envelope",
    "_stream_error_problem",
    "_streaming_request_summary",
    "_sweep_request_summary",
    "_worker_died_problem",
]
