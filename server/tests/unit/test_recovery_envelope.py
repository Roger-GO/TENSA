"""Unit 3 — recovery-descriptor substrate/schema layer.

Substrate-level coverage of the v3.1 UX-overhaul Unit 3 contract:

- Every ``AndesAppError`` subclass carries the EXACT ``recovery_kind`` class
  attribute the shared error mapper (Unit 4a) will consult.
- The base ``AndesAppError.recovery_kind`` defaults to ``None``
  (unclassified / no CTA).
- A reflection sweep over ``AndesAppError.__subclasses__()`` (across every
  module that defines a subclass — errors, session, bundle, report, snapshot,
  sweep, security/paths) catches any concrete subclass added later without a
  classification, and any drift between the plain-``str`` attrs in ``core/``
  and the ``RecoveryKind`` Literal in ``api/schemas.py``.
- ``RECOVERY_DEFAULT_LABELS`` has a label for every ``RecoveryKind`` value.
- ``RecoveryDescriptor`` validates a good payload, rejects an unknown kind,
  and rejects extra fields (``extra='forbid'``).

The HTTP wiring that actually emits ``recovery`` in responses lands in
Unit 4a; this module proves only the class attrs + schema types.
"""

from __future__ import annotations

import typing

import pytest
from pydantic import ValidationError

# Import EVERY module that defines an ``AndesAppError`` subclass so the whole
# hierarchy is registered before we walk ``__subclasses__()`` in the
# completeness test below. ``__subclasses__()`` only sees classes whose
# defining module has already been imported, so this import set is
# load-bearing: drop a module and the sweep silently stops guarding it.
from tensa.api.schemas import (
    RECOVERY_DEFAULT_LABELS,
    ProblemDetails,
    RecoveryDescriptor,
    RecoveryKind,
)
from tensa.core import bundle, errors, report, session, snapshot, sweep
from tensa.core.errors import (
    AndesAppError,
    CaseLoadError,
    CpfDivergedError,
    CpfPrerequisiteError,
    DisturbanceCommitError,
    DisturbanceValidationError,
    EigComputationError,
    EigDirtyDaeError,
    EigPrerequisiteError,
    ElementHasDependentsError,
    ElementNotFoundError,
    ElementValidationError,
    NoCaseLoadedError,
    SeNonConvergentError,
    SePrerequisiteError,
    SessionBusyError,
    SetupFailedError,
    SeUnderDeterminedError,
    SystemAlreadyLoadedError,
)
from tensa.core.session import SweepInProgressError
from tensa.security import paths

# Keep the module imports referenced so linters don't strip them — they are
# load-bearing for the reflection sweep below: each one registers the
# ``AndesAppError`` subclasses it defines into ``__subclasses__()``.
_REGISTERED_MODULES = (errors, session, bundle, report, snapshot, sweep, paths)


# ---- exact mapping ----------------------------------------------------------

_EXPECTED_MAPPING: list[tuple[type[AndesAppError], str]] = [
    (NoCaseLoadedError, "load-case"),
    (CaseLoadError, "load-case"),
    (SetupFailedError, "reload-case"),
    (DisturbanceCommitError, "reload-case"),
    (EigPrerequisiteError, "run-pflow"),
    (CpfPrerequisiteError, "run-pflow"),
    (SePrerequisiteError, "run-pflow"),
    (EigDirtyDaeError, "reload-case"),
    (EigComputationError, "retry"),
    (CpfDivergedError, "retry"),
    (SeNonConvergentError, "retry"),
    (SeUnderDeterminedError, "add-measurements"),
    (ElementValidationError, "none"),
    (ElementNotFoundError, "none"),
    (ElementHasDependentsError, "none"),
    (SystemAlreadyLoadedError, "reload-case"),
    (SessionBusyError, "wait-for-job"),
    (SweepInProgressError, "wait-for-sweep"),
    (DisturbanceValidationError, "none"),
]


@pytest.mark.parametrize(
    ("error_cls", "expected_kind"),
    _EXPECTED_MAPPING,
    ids=[cls.__name__ for cls, _ in _EXPECTED_MAPPING],
)
def test_recovery_kind_matches_mapping(
    error_cls: type[AndesAppError], expected_kind: str
) -> None:
    assert error_cls.recovery_kind == expected_kind


def test_base_recovery_kind_is_none() -> None:
    assert AndesAppError.recovery_kind is None


# ---- completeness / reflection ----------------------------------------------


def _walk_subclasses(cls: type[AndesAppError]) -> set[type[AndesAppError]]:
    """Recursively collect every subclass of ``cls``."""
    found: set[type[AndesAppError]] = set()
    for sub in cls.__subclasses__():
        found.add(sub)
        found |= _walk_subclasses(sub)
    return found


def test_every_subclass_recovery_kind_is_classified_or_none() -> None:
    """Every concrete AndesAppError subclass must declare a ``recovery_kind``
    that is either ``None`` (base default / unclassified) or a key in
    ``RECOVERY_DEFAULT_LABELS`` (i.e., a valid ``RecoveryKind``). With every
    subclass-defining module imported above, this catches a future class
    added anywhere without classification and any drift between the str attrs
    (core) and the RecoveryKind Literal (schemas)."""
    for sub in _walk_subclasses(AndesAppError):
        kind = sub.recovery_kind
        assert kind is None or kind in RECOVERY_DEFAULT_LABELS, (
            f"{sub.__name__}.recovery_kind={kind!r} is neither None nor a "
            f"known RecoveryKind"
        )


# ---- labels registry --------------------------------------------------------


def test_default_labels_cover_every_recovery_kind() -> None:
    literal_values = set(typing.get_args(RecoveryKind))
    assert literal_values, "RecoveryKind must enumerate at least one value"
    assert set(RECOVERY_DEFAULT_LABELS) == literal_values
    for kind, label in RECOVERY_DEFAULT_LABELS.items():
        assert isinstance(label, str) and label.strip(), (
            f"label for {kind!r} must be a non-empty string"
        )


# ---- RecoveryDescriptor schema ----------------------------------------------


def test_recovery_descriptor_accepts_good_payload() -> None:
    desc = RecoveryDescriptor(kind="run-pflow", label="Run power flow first")
    assert desc.kind == "run-pflow"
    assert desc.label == "Run power flow first"


def test_recovery_descriptor_rejects_unknown_kind() -> None:
    with pytest.raises(ValidationError):
        RecoveryDescriptor(kind="teleport", label="Teleport away")  # type: ignore[arg-type]


def test_recovery_descriptor_rejects_extra_fields() -> None:
    with pytest.raises(ValidationError):
        RecoveryDescriptor(
            kind="retry",
            label="Try again",
            extra_field="nope",  # type: ignore[call-arg]
        )


# ---- ProblemDetails.recovery field ------------------------------------------


def test_problem_details_recovery_defaults_to_none() -> None:
    pd = ProblemDetails(title="conflict", status=409)
    assert pd.recovery is None


def test_problem_details_accepts_recovery_descriptor() -> None:
    pd = ProblemDetails(
        title="run pflow first",
        status=409,
        recovery=RecoveryDescriptor(kind="run-pflow", label="Run power flow first"),
    )
    assert pd.recovery is not None
    assert pd.recovery.kind == "run-pflow"
    assert pd.recovery.label == "Run power flow first"


def test_problem_details_coerces_recovery_dict() -> None:
    pd = ProblemDetails(
        title="retry",
        status=500,
        recovery={"kind": "retry", "label": "Try again"},  # type: ignore[arg-type]
    )
    assert isinstance(pd.recovery, RecoveryDescriptor)
    assert pd.recovery.kind == "retry"
