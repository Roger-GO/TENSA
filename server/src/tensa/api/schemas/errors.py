"""The error envelope: what every 4xx and 5xx response is shaped as, and the recovery
it can offer."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

# Canonical recovery-action discriminator. Each ``AndesAppError`` subclass
# declares a matching plain-``str`` ``recovery_kind`` attribute in
# ``core/errors.py`` / ``core/session.py`` (a plain ``str`` there, NOT this
# Literal — importing it into ``core/`` would create a core->api import
# cycle). A reflection test cross-checks the two for drift. The shared error
# mapper (Unit 4a) translates an error's ``recovery_kind`` into a
# ``RecoveryDescriptor`` on the wire.
RecoveryKind = Literal[
    "load-case",
    "reload-case",
    "run-pflow",
    "retry",
    "add-measurements",
    "none",
    "wait-for-job",
    "wait-for-sweep",
]


# Default user-facing copy for each recovery kind. The mapper falls back to
# these when an error does not carry a bespoke label.
RECOVERY_DEFAULT_LABELS: dict[RecoveryKind, str] = {
    "load-case": "Load a case",
    "reload-case": "Reload the case",
    "run-pflow": "Run power flow first",
    "retry": "Try again",
    "add-measurements": "Add more measurements",
    "none": "No recovery action",
    "wait-for-job": "Wait for the running operation",
    "wait-for-sweep": "Wait for the sweep to finish",
}


class RecoveryDescriptor(BaseModel):
    """Recovery call-to-action attached to an error response.

    The ``kind`` is the stable, machine-readable discriminator the UI keys
    off to render the right action (e.g., a "Run power flow" button); the
    ``label`` is the human-facing copy. ``kind == "none"`` means the error was
    considered but has no canonical recovery action — the UI renders it
    without a CTA, same as an absent ``recovery``.
    """

    model_config = ConfigDict(extra="forbid")

    kind: RecoveryKind = Field(
        ...,
        description=(
            "Stable, machine-readable discriminator for the recovery action "
            "the client should offer (e.g., ``run-pflow``, ``load-case``, "
            "``retry``). ``none`` means no canonical recovery action applies."
        ),
    )
    label: str = Field(
        ...,
        description=(
            "Human-readable copy describing the recovery action, suitable for "
            "rendering on a call-to-action button or hint."
        ),
    )


class ProblemDetails(BaseModel):
    """RFC 7807 problem-details object. Used for all 4xx and 5xx responses."""

    model_config = ConfigDict(extra="allow")

    type: str = Field(
        "about:blank",
        description=(
            "URI reference identifying the problem type. ``about:blank`` "
            "means the title is the canonical reason for the status code."
        ),
    )
    title: str = Field(..., description="Short, human-readable summary of the problem.")
    status: int = Field(..., description="HTTP status code for this response.")
    detail: str | None = Field(
        None,
        description=(
            "Human-readable explanation specific to this occurrence of the "
            "problem (e.g., 'session id is required to be server-generated; "
            "remove the session_id field from your request body')."
        ),
    )
    instance: str | None = Field(
        None,
        description="URI reference that identifies the specific occurrence of the problem.",
    )
    # ``default=`` (keyword), NOT positional ``None``: under mypy's
    # dataclass_transform handling of pydantic ``BaseModel`` (no pydantic mypy
    # plugin is enabled here), a model-typed optional declared with positional
    # ``Field(None, ...)`` is NOT recognized as having a default, so mypy
    # ``--strict`` flags ``recovery`` as a required ctor arg at every
    # ``ProblemDetails(...)`` site that omits it (verified: the positional form
    # raises ``Missing named argument "recovery"`` in api/app.py). The keyword
    # ``default=None`` form is recognized and keeps the field optional.
    recovery: RecoveryDescriptor | None = Field(
        default=None,
        description=(
            "Optional recovery call-to-action describing how the client can "
            "resolve the problem (e.g., load a case, run power flow, retry). "
            "``None`` means no recovery action is offered. Populated by the "
            "shared error mapper from the error's recovery kind."
        ),
    )
