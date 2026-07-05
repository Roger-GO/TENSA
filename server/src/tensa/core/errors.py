"""Domain exceptions for the ANDES wrapper.

These exceptions wrap underlying ANDES exceptions at the wrapper boundary so
they never leak raw to the API surface. The FastAPI layer maps each to a
specific HTTP status + rfc7807 ``ProblemDetails`` body in Unit 7.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from tensa.core.jobs import JobRecord


class AndesAppError(Exception):
    """Base class for all wrapper-level exceptions.

    ``recovery_kind`` is the single source of truth the shared error mapper
    (Unit 4a) consults to attach a ``RecoveryDescriptor`` to the response. It
    is a plain ``str`` here (NOT the ``RecoveryKind`` Literal in
    ``api/schemas.py`` — importing that into ``core/`` would create a
    core->api import cycle); the string values must match that Literal, and a
    reflection test cross-checks for drift. The base default ``None`` means
    'unclassified / no CTA'; the string ``'none'`` means 'considered, no
    canonical recovery' — both render without a CTA in the UI.
    """

    recovery_kind: str | None = None


class NoCaseLoadedError(AndesAppError):
    """Raised when an operation requires a loaded case but none has been loaded."""

    recovery_kind: str | None = "load-case"


class CaseLoadError(AndesAppError):
    """Raised when ``andes.load`` fails (file not found, malformed, parse error).

    The original exception (if any) is chained via ``__cause__``.
    """

    recovery_kind: str | None = "load-case"

    def __init__(self, path: str, message: str) -> None:
        super().__init__(f"failed to load case {path!r}: {message}")
        self.path = path
        self.message = message


class CaseSaveError(AndesAppError):
    """Raised when saving the current System to a workspace file fails or
    would produce a corrupt artifact.

    The xlsx/json writers are not atomic — ``andes.io.xlsx.write`` opens the
    file (0 bytes) and only flushes the zip content at ``close()``, so any
    failure between open and close (or a worker kill) leaves a 0-byte file that
    then masquerades as a real case and fails to load with "File is not a zip
    file". ``save_case`` now writes to a temp file, validates it is non-empty
    and a valid container, and atomically renames it onto the target; on any
    failure it raises this error and leaves no partial file behind.

    Surfaced as HTTP 422 ``ProblemDetails``.
    """

    recovery_kind: str | None = "retry"

    def __init__(self, detail: str) -> None:
        super().__init__(f"failed to save case: {detail}")
        self.detail = detail


class DisturbanceCommitError(AndesAppError):
    """Raised when an ``add_disturbance`` / ``delete_disturbance`` call is made
    after ``ss.setup()`` has been committed.

    ANDES rejects all post-setup ``System.add(...)`` calls regardless of model
    type. The caller must invoke ``reload_case`` to return to pre-setup state.
    """

    recovery_kind: str | None = "reload-case"

    def __init__(self) -> None:
        super().__init__(
            "cannot modify disturbances after setup() has been committed; "
            "call reload_case() to return to a pre-setup state"
        )


class SetupFailedError(AndesAppError):
    """Raised when ``ss.setup()`` returns False or raises mid-way.

    PFlow.run and TDS.run cannot proceed without a successful setup. The
    session is marked as 'requires reload' and the caller is directed to
    invoke ``reload_case``.
    """

    recovery_kind: str | None = "reload-case"

    def __init__(self, detail: str) -> None:
        super().__init__(f"ANDES setup() failed: {detail}; call reload_case() to recover")
        self.detail = detail


class DisturbanceValidationError(AndesAppError):
    """Raised when a disturbance specification fails validation against the
    ANDES model (e.g., bus idx not present in the loaded case)."""

    recovery_kind: str | None = "none"


class ElementValidationError(AndesAppError):
    """Raised when an add/edit-element request fails the wrapper-side
    whitelist check or ANDES rejects the underlying ``ss.add()`` /
    parameter-array assignment.

    Surfaced as HTTP 422 ProblemDetails. The wrapper sanitizes embedded
    filesystem paths from the message before re-raising so workspace and
    install-tree paths never leak to the client.
    """

    recovery_kind: str | None = "none"


class ElementNotFoundError(AndesAppError):
    """Raised when ``edit_element(model, idx, ...)`` references an idx that
    does not exist in the loaded System. Surfaced as HTTP 404."""

    recovery_kind: str | None = "none"


class SystemAlreadyLoadedError(AndesAppError):
    """Raised when ``create_blank()`` is called on a session that already has
    a loaded System. The caller must reload or open a fresh session."""

    recovery_kind: str | None = "reload-case"


class EigPrerequisiteError(AndesAppError):
    """Raised when ``Wrapper.run_eig`` is invoked without a converged PFlow.

    ANDES's ``EIG._pre_check`` (``andes/routines/eig.py:768-788``) only logs
    a warning when ``system.PFlow.converged`` is False — it then falls
    through to ``TDS.init()`` and crashes with a non-actionable
    ``TypeError: object of type 'NoneType' has no len()`` (verified in
    Unit 1a spike). The substrate gates the call independently and
    raises this error so the routes layer can surface a clean 409.
    """

    recovery_kind: str | None = "run-pflow"


class EigComputationError(AndesAppError):
    """Raised when ``ss.EIG.run()`` itself raises (e.g., singular Jacobian
    after regularization, LinAlg failure, or any other ANDES-side
    exception inside the routine body)."""

    recovery_kind: str | None = "retry"


class CpfPrerequisiteError(AndesAppError):
    """Raised when ``Wrapper.run_cpf`` / ``Wrapper.run_cpf_qv`` is invoked
    without a converged PFlow.

    ANDES's ``CPF.init`` (``andes/routines/cpf.py:191``) only logs a warning
    when ``system.PFlow.converged`` is False (verified in Unit 1a spike). The
    substrate gates the call independently for a clean 409 with an
    actionable "Run PFlow first" message. Mirrors the EIG gating pattern
    (see :class:`EigPrerequisiteError`).
    """

    recovery_kind: str | None = "run-pflow"


class CpfDivergedError(AndesAppError):
    """Raised when ``ss.CPF.run()`` / ``ss.CPF.run_qv()`` itself raises an
    exception (e.g., singular Jacobian, KLU segfault, internal LinAlg
    failure).

    A clean ``False`` return with a populated ``done_msg`` (e.g.,
    ``"Reached max steps"``) is *not* a divergence — that path returns a
    truncated :class:`CpfResult` rather than raising. This error covers
    only the "ANDES blew up mid-routine" case.
    """

    recovery_kind: str | None = "retry"


class SePrerequisiteError(AndesAppError):
    """Raised when ``Wrapper.run_se`` / ``Wrapper.generate_measurements_from_pflow``
    is invoked without a converged PFlow.

    ANDES's ``SE.init`` (``andes/routines/se.py:99``) only logs an error
    when ``system.PFlow.converged`` is False before returning False
    (verified in Unit 1a spike). The substrate gates the call
    independently for a clean 409 with an actionable "Run PFlow first"
    message. Mirrors the EIG / CPF gating pattern.

    Also raised when ``Wrapper.run_se`` is invoked before
    ``generate_measurements_from_pflow`` has populated the substrate's
    in-memory ``Measurements`` object — the route layer maps to 409 with
    "Generate measurements first".
    """

    recovery_kind: str | None = "run-pflow"


class SeNonConvergentError(AndesAppError):
    """Raised when ``ss.SE.run()`` returned False after running to
    completion (max_iter reached without satisfying ``config.tol``).

    A clean ``False`` return with a populated ``result['n_iter']`` is
    the WLS Gauss-Newton failing to converge — distinct from the
    under-determined / singular gain matrix case (which is mapped to
    :class:`SeUnderDeterminedError`).

    Also raised when ``ss.SE.run()`` itself raises an exception (e.g.,
    LinAlg failure outside the singular-gain path).
    """

    recovery_kind: str | None = "retry"


class SeUnderDeterminedError(AndesAppError):
    """Raised when the measurement set has insufficient redundancy to
    observe the system state.

    Detected via the chi-squared ``dof = nm - 2*nb <= 0`` condition
    (``andes/routines/se.py:241``) OR via a singular gain matrix at
    iteration 0 (``andes/se/algorithms.py:71-78``). Both cases surface
    as 422 from the route layer with an actionable "add more
    measurements" message.
    """

    recovery_kind: str | None = "add-measurements"


class EigDirtyDaeError(AndesAppError):
    """Raised when ``Wrapper.run_pflow`` is invoked while
    ``ss.TDS.initialized is True`` — the documented EIG side-effect
    (``EIG._pre_check`` calls ``TDS.init()`` + ``TDS.itm_step()``;
    see Unit 1a spike). Re-running PF over the TDS-extended dae has
    been observed to populate ``Bus.v.v`` with NaN values on
    ``kundur_full``, which then either crashes the extraction
    helpers or surfaces as a JSON-encoder failure (5xx).

    The wrapper rejects with this typed error instead so the routes
    layer can return an actionable 422. Recovery: call
    ``POST /api/sessions/{id}/reload`` to return to a fresh pre-setup
    state (full re-parse — this is the only clean escape per Unit 1a;
    ``System.reset(force=True)`` raises ``NotImplementedError: Does
    not know how to shrink arrays`` after EIG-induced TDS init).
    """

    recovery_kind: str | None = "reload-case"


class ElementHasDependentsError(AndesAppError):
    """Raised when ``delete_element(model, idx)`` would orphan references on
    other devices (e.g., deleting a Bus that has a Line attached).

    Surfaced as HTTP 422 ``DeleteBlockedResponse``. Carries the list of
    dependent topology entries (capped at 25 by the wrapper at construction
    time) plus the full count so the UI can render a "Showing N of M"
    truncation footer.

    The ``dependents`` list is a list of plain dicts (already serialized
    from ``TopologyEntry`` dataclasses) so the value can cross the worker
    Pipe without re-importing the wrapper module on the parent side.
    """

    recovery_kind: str | None = "none"

    def __init__(
        self,
        model: str,
        idx: int | str,
        dependents: list[dict[str, Any]],
        total: int,
    ) -> None:
        super().__init__(
            f"cannot delete {model} idx={idx!r}: {total} dependent "
            f"element(s) reference it. Delete those first."
        )
        self.model = model
        self.idx = idx
        # Dependents capped at 25; ``total`` is the full count.
        self.dependents = dependents
        self.total = total


class CloneEditError(AndesAppError):
    """Raised when a clone-on-write file edit fails (Unit 21 / KTD-9).

    Covers the format-writer failure modes the clone substrate surfaces to
    the UI:

    - A ``.dyr`` / ``.raw`` file whose target record does not match the
      expected ``(BUS, MODEL, ID)`` pattern, or whose target field cannot be
      located at the spike-index position (malformed / hand-edited file).
    - An ``.xlsx`` clone whose sheet / idx-row / param-column is absent.
    - A controller-param edit routed to the ``.raw`` writer — controllers
      never live in ``.raw`` (they live in the paired ``.dyr``). The
      recovery hint directs the user to the existing edit-element route for
      static-topology edits.

    Surfaced as HTTP 422 ``ProblemDetails``. The wrapper sanitizes embedded
    filesystem paths from the message before re-raising so workspace and
    install-tree paths never leak to the client.

    ``recovery_kind`` is ``"none"`` — there is no single canonical CTA for a
    malformed clone file; the detail string carries the actionable guidance
    (and, for the ``.raw`` controller case, the "use edit-element" hint).
    The orthogonal ``ui_hint``/``conflict`` recovery axes described in KTD-3
    are not yet modelled on :class:`RecoveryDescriptor` (it carries only
    ``kind`` + ``label``); the ``use-edit-element`` hint therefore rides in
    the detail string rather than a structured field.
    """

    recovery_kind: str | None = "none"


class WorkerDiedError(AndesAppError):
    """Raised when a session's worker subprocess dies mid-RPC — the parent
    detects this as a torn IPC pipe (``EOFError`` / ``BrokenPipeError`` /
    ``ConnectionResetError`` / ``OSError`` while sending the request or
    receiving the response).

    Distinct from :class:`~tensa.core.session.WorkerError` (the worker is
    alive and returned a structured error) and
    :class:`~tensa.core.session.SessionExpiredError` (the session was reaped
    or never existed): here the worker crashed — e.g. it ran out of memory or
    hit an unsupported ANDES operation (an observed trigger is the snapshot
    dill-restore corrupting the worker's multiprocessing pipe fd). The session
    is marked dead and removed from the registry so every subsequent call to it
    fast-fails as :class:`~tensa.core.session.SessionExpiredError` instead of
    repeatedly bubbling a raw 500.

    Surfaced as HTTP 503 (Service Unavailable — the worker is gone, not a client
    conflict; the condition is transient and recoverable by reloading the case)
    with a ``reload-case`` recovery CTA. The ``recovery_kind`` / ``http_status``
    class attributes are the single source of truth the app-level exception
    handler (mirroring ``SessionBusyError`` / ``SweepInProgressError``) consults.

    The case is safe on disk, so the actionable recovery is to reload it (or
    start a new session); the default message below says exactly that.
    """

    recovery_kind: str | None = "reload-case"
    http_status: int = 503

    _DEFAULT_DETAIL = (
        "The simulation worker stopped unexpectedly (it may have run out of "
        "memory or hit an unsupported ANDES operation). Your case is safe on "
        "disk — reload it to continue, or start a new session."
    )

    def __init__(self, detail: str | None = None) -> None:
        super().__init__(detail if detail is not None else self._DEFAULT_DETAIL)
        self.detail = detail if detail is not None else self._DEFAULT_DETAIL


class SessionBusyError(AndesAppError):
    """Raised by ``SessionManager.invoke`` when the per-session lock is
    already held by an in-flight operation (the non-blocking try-acquire
    failed) — KTD-2a/2b of the v3.1 UX overhaul.

    Unlike :class:`~tensa.core.session.SweepInProgressError` (a
    long-running sweep deliberately holds the session for many iterations),
    this is the general single-operation contention guard: one routine is
    already running on this session and a second request would otherwise
    block the event loop. Surfacing it lets the routes layer return a clean
    ``409 Conflict`` with a ``wait-for-job`` recovery descriptor so the UI
    can show the in-flight job and offer wait/cancel instead of freezing.

    ``current_job`` carries the in-flight :class:`~tensa.core.jobs.JobRecord`
    when the registry knows about it; it is ``None`` during the race window
    where the lock is held but the job row has not yet been inserted, and —
    until Unit 5 wires per-route registry population — in the common case.

    The ``recovery_kind`` / ``http_status`` class attributes are the single
    source of truth the shared error mapper (Unit 4a) consults.
    """

    recovery_kind: str | None = "wait-for-job"
    http_status: int = 409

    def __init__(self, current_job: JobRecord | None = None) -> None:
        if current_job is not None:
            detail = (
                f"session is busy with an in-flight {current_job.kind} "
                f"operation (job {current_job.id})"
            )
        else:
            detail = "session is busy with an in-flight operation"
        super().__init__(detail)
        self.current_job = current_job
