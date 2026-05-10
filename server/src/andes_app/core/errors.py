"""Domain exceptions for the ANDES wrapper.

These exceptions wrap underlying ANDES exceptions at the wrapper boundary so
they never leak raw to the API surface. The FastAPI layer maps each to a
specific HTTP status + rfc7807 ``ProblemDetails`` body in Unit 7.
"""

from __future__ import annotations

from typing import Any


class AndesAppError(Exception):
    """Base class for all wrapper-level exceptions."""


class NoCaseLoadedError(AndesAppError):
    """Raised when an operation requires a loaded case but none has been loaded."""


class CaseLoadError(AndesAppError):
    """Raised when ``andes.load`` fails (file not found, malformed, parse error).

    The original exception (if any) is chained via ``__cause__``.
    """

    def __init__(self, path: str, message: str) -> None:
        super().__init__(f"failed to load case {path!r}: {message}")
        self.path = path
        self.message = message


class DisturbanceCommitError(AndesAppError):
    """Raised when an ``add_disturbance`` / ``delete_disturbance`` call is made
    after ``ss.setup()`` has been committed.

    ANDES rejects all post-setup ``System.add(...)`` calls regardless of model
    type. The caller must invoke ``reload_case`` to return to pre-setup state.
    """

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

    def __init__(self, detail: str) -> None:
        super().__init__(f"ANDES setup() failed: {detail}; call reload_case() to recover")
        self.detail = detail


class DisturbanceValidationError(AndesAppError):
    """Raised when a disturbance specification fails validation against the
    ANDES model (e.g., bus idx not present in the loaded case)."""


class ElementValidationError(AndesAppError):
    """Raised when an add/edit-element request fails the wrapper-side
    whitelist check or ANDES rejects the underlying ``ss.add()`` /
    parameter-array assignment.

    Surfaced as HTTP 422 ProblemDetails. The wrapper sanitizes embedded
    filesystem paths from the message before re-raising so workspace and
    install-tree paths never leak to the client.
    """


class ElementNotFoundError(AndesAppError):
    """Raised when ``edit_element(model, idx, ...)`` references an idx that
    does not exist in the loaded System. Surfaced as HTTP 404."""


class SystemAlreadyLoadedError(AndesAppError):
    """Raised when ``create_blank()`` is called on a session that already has
    a loaded System. The caller must reload or open a fresh session."""


class EigPrerequisiteError(AndesAppError):
    """Raised when ``Wrapper.run_eig`` is invoked without a converged PFlow.

    ANDES's ``EIG._pre_check`` (``andes/routines/eig.py:768-788``) only logs
    a warning when ``system.PFlow.converged`` is False — it then falls
    through to ``TDS.init()`` and crashes with a non-actionable
    ``TypeError: object of type 'NoneType' has no len()`` (verified in
    Unit 1a spike). The substrate gates the call independently and
    raises this error so the routes layer can surface a clean 409.
    """


class EigComputationError(AndesAppError):
    """Raised when ``ss.EIG.run()`` itself raises (e.g., singular Jacobian
    after regularization, LinAlg failure, or any other ANDES-side
    exception inside the routine body)."""


class CpfPrerequisiteError(AndesAppError):
    """Raised when ``Wrapper.run_cpf`` / ``Wrapper.run_cpf_qv`` is invoked
    without a converged PFlow.

    ANDES's ``CPF.init`` (``andes/routines/cpf.py:191``) only logs a warning
    when ``system.PFlow.converged`` is False (verified in Unit 1a spike). The
    substrate gates the call independently for a clean 409 with an
    actionable "Run PFlow first" message. Mirrors the EIG gating pattern
    (see :class:`EigPrerequisiteError`).
    """


class CpfDivergedError(AndesAppError):
    """Raised when ``ss.CPF.run()`` / ``ss.CPF.run_qv()`` itself raises an
    exception (e.g., singular Jacobian, KLU segfault, internal LinAlg
    failure).

    A clean ``False`` return with a populated ``done_msg`` (e.g.,
    ``"Reached max steps"``) is *not* a divergence — that path returns a
    truncated :class:`CpfResult` rather than raising. This error covers
    only the "ANDES blew up mid-routine" case.
    """


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


class SeUnderDeterminedError(AndesAppError):
    """Raised when the measurement set has insufficient redundancy to
    observe the system state.

    Detected via the chi-squared ``dof = nm - 2*nb <= 0`` condition
    (``andes/routines/se.py:241``) OR via a singular gain matrix at
    iteration 0 (``andes/se/algorithms.py:71-78``). Both cases surface
    as 422 from the route layer with an actionable "add more
    measurements" message.
    """


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
