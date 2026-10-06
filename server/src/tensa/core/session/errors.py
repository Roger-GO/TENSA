"""What the session manager raises, and the category a dead worker is reported under."""

from __future__ import annotations

from typing import Any

from tensa.core.errors import AndesAppError

# Category string the liveness sweeper stamps onto the synthesized
# ``ProblemDetails`` of a job orphaned by a dead worker.
WORKER_DIED_CATEGORY = "WorkerDied"


class SessionExpiredError(AndesAppError):
    """Raised when a caller references a session that has been reaped or
    never existed."""


class SweepInProgressError(AndesAppError):
    """Raised by ``SessionManager.invoke`` when a sweep holds the session
    lock — Unit 18.

    Carries the sweep_id + iteration progress so the routes layer can
    build a ``503 Service Unavailable`` response with a ``Retry-After``
    header and a useful detail string (``"Sweep <id> in progress;
    <N>/<total> iterations complete"``).

    ``recovery_kind`` is a plain ``str`` (matching the ``RecoveryKind``
    Literal in ``api/schemas/errors.py`` without importing it — see
    :class:`~tensa.core.errors.AndesAppError`) so the shared error mapper
    (Unit 4a) can attach a ``wait-for-sweep`` recovery descriptor.
    """

    recovery_kind: str | None = "wait-for-sweep"

    def __init__(
        self, sweep_id: str, *, iter_done: int, iter_total: int
    ) -> None:
        super().__init__(
            f"Sweep {sweep_id} in progress; {iter_done}/{iter_total} "
            "iterations complete"
        )
        self.sweep_id = sweep_id
        self.iter_done = iter_done
        self.iter_total = iter_total


class WorkerError(AndesAppError):
    """Raised when the worker reports a structured error response. The
    ``category`` field maps onto specific HTTP status codes at the API layer
    (Unit 4 / Unit 5).

    ``extra`` carries an optional structured payload (e.g., the dependents
    list for ``ElementHasDependentsError``). Routes that need the extra
    fields (currently only the DELETE elements endpoint) read them off
    this attribute; everyone else can ignore it.
    """

    def __init__(
        self,
        category: str,
        detail: str,
        *,
        extra: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(f"{category}: {detail}")
        self.category = category
        self.detail = detail
        self.extra = extra or {}
