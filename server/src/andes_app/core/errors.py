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
