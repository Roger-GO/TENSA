"""Shared worker-error → HTTP mapping + recovery-descriptor plumbing.

Unit 4a of the v3.1 UX overhaul. This module is the single place the API
layer translates a substrate :class:`~andes_app.core.session.WorkerError`
(which crosses the worker Pipe carrying only a *category string*, not the
live exception type) into an :class:`fastapi.HTTPException`, and attaches the
typed :class:`~andes_app.api.schemas.RecoveryDescriptor` call-to-action the UI
keys off.

Two public entry points:

- :func:`recovery_for` — pure helper. Reads ``getattr(exc, "recovery_kind")``
  and returns a ``RecoveryDescriptor`` iff the kind is a known, non-``"none"``
  ``RecoveryKind``; otherwise ``None`` (so both ``recovery_kind="none"`` and a
  missing/``None`` attr render without a CTA).
- :func:`map_worker_error` — consolidates the 13 per-route ``_map_worker_error``
  helpers (audited in ``_error_audit.md``) into one mapping, preserving each
  documented status + extras shape and attaching ``recovery``.

Design (documented in ``_error_audit.md``): the worker's wire ``category`` is
almost always the ``AndesAppError`` subclass ``__name__`` (e.g.
``"EigPrerequisiteError"``), but two categories are bespoke hyphenated strings
(``"no-case-loaded"`` for :class:`NoCaseLoadedError`, ``"disturbance-commit"``
for :class:`DisturbanceCommitError`) and a third is the
``"BundleValidationError:<sub>"`` composite. We resolve ``category`` →
``AndesAppError`` subclass via a registry built over the FULL subclass
hierarchy (the same module set the Unit 3 reflection test imports), then read
``recovery_kind`` off the class — the class attribute is the single source of
truth. Status comes from an explicit ``category -> status`` table; the class
attribute drives recovery so the two never drift.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import HTTPException, status

from andes_app.api.schemas import RECOVERY_DEFAULT_LABELS, RecoveryDescriptor

# Import EVERY module that defines an ``AndesAppError`` subclass so the whole
# hierarchy is registered before we walk ``__subclasses__()`` to build the
# class-name registry below. ``__subclasses__()`` only sees classes whose
# defining module has already been imported, so this import set is
# load-bearing (same set as the Unit 3 reflection test). Drop a module and the
# registry silently stops covering its errors.
from andes_app.core import (  # noqa: F401  (imported for subclass registration)
    bundle,
    errors,
    report,
    session,
    snapshot,
    sweep,
)
from andes_app.core.errors import AndesAppError
from andes_app.core.session import WorkerError
from andes_app.security import paths  # noqa: F401  (subclass registration)

log = logging.getLogger(__name__)


def _walk_subclasses(cls: type[AndesAppError]) -> set[type[AndesAppError]]:
    """Recursively collect every subclass of ``cls``."""
    found: set[type[AndesAppError]] = set()
    for sub in cls.__subclasses__():
        found.add(sub)
        found |= _walk_subclasses(sub)
    return found


# Registry: ``AndesAppError`` subclass ``__name__`` -> the class. Built once at
# import time over the full hierarchy. Used to resolve a wire ``category``
# (which is the class ``__name__`` for most errors) back to the class so we can
# read its authoritative ``recovery_kind``.
_ERROR_CLASS_BY_NAME: dict[str, type[AndesAppError]] = {
    sub.__name__: sub for sub in _walk_subclasses(AndesAppError)
}
_ERROR_CLASS_BY_NAME[AndesAppError.__name__] = AndesAppError


# Bespoke wire categories the worker emits that are NOT class ``__name__``
# (see ``core/worker.py``): the two hyphenated strings map onto their classes
# so ``recovery_for`` can read the right ``recovery_kind``.
_WIRE_CATEGORY_ALIASES: dict[str, str] = {
    "no-case-loaded": "NoCaseLoadedError",
    "disturbance-commit": "DisturbanceCommitError",
}


# Canonical ``category -> HTTP status``. This is the CONTRACT distilled from
# the 13 per-route audits (``_error_audit.md``); it captures the *dominant*
# status for each category. Where a single route overrides the canonical
# status (pmu ``SetupFailedError`` -> 409, profiles ``SetupFailedError`` ->
# 500, snapshot ``SetupFailedError`` -> 422, bundle-export wide 422 bucket),
# Unit 4b reconciles those at the call site (e.g. via per-route ``status``
# overrides on the migrated mapper). Keys are wire categories (class ``__name__``
# or the hyphenated aliases above).
WORKER_ERROR_HTTP_MAP: dict[str, int] = {
    # --- 409 Conflict (pre-condition / lifecycle) ---
    "no-case-loaded": status.HTTP_409_CONFLICT,
    "disturbance-commit": status.HTTP_409_CONFLICT,
    "SystemAlreadyLoadedError": status.HTTP_409_CONFLICT,
    "EigPrerequisiteError": status.HTTP_409_CONFLICT,
    "CpfPrerequisiteError": status.HTTP_409_CONFLICT,
    "SePrerequisiteError": status.HTTP_409_CONFLICT,
    "PflowNotConvergedError": status.HTTP_409_CONFLICT,
    "TdsNotRunError": status.HTTP_409_CONFLICT,
    "EigReportPrerequisiteError": status.HTTP_409_CONFLICT,
    "SnapshotCollisionError": status.HTTP_409_CONFLICT,
    # --- 404 Not Found ---
    "ElementNotFoundError": status.HTTP_404_NOT_FOUND,
    "SnapshotNotFoundError": status.HTTP_404_NOT_FOUND,
    # --- 422 Unprocessable Content (validation / dirty-state) ---
    "SetupFailedError": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "EigDirtyDaeError": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "EigComputationError": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "CpfDivergedError": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "SeNonConvergentError": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "SeUnderDeterminedError": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "ElementValidationError": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "ElementHasDependentsError": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "DisturbanceValidationError": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "CaseLoadError": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "SnapshotMetadataError": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "SnapshotVersionMismatchError": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "SweepValidationError": status.HTTP_422_UNPROCESSABLE_ENTITY,
    # --- 500 Internal Server Error ---
    "ReportGenerationError": status.HTTP_500_INTERNAL_SERVER_ERROR,
}


def _descriptor_for_kind(kind: object) -> RecoveryDescriptor | None:
    """Build a ``RecoveryDescriptor`` from a raw ``recovery_kind`` value.

    Returns a descriptor iff ``kind`` is a non-``None`` value that is also
    ``!= "none"`` and present in :data:`RECOVERY_DEFAULT_LABELS`; otherwise
    ``None`` (so both ``"none"`` and a missing / ``None`` kind render without a
    CTA). Shared by :func:`recovery_for` (reads off a live exception) and the
    category resolver (reads off the resolved error *class*).
    """
    if not isinstance(kind, str) or kind == "none":
        return None
    label = RECOVERY_DEFAULT_LABELS.get(kind)  # type: ignore[call-overload]
    if label is None:
        return None
    return RecoveryDescriptor(kind=kind, label=label)  # type: ignore[arg-type]


def recovery_for(exc: Exception) -> RecoveryDescriptor | None:
    """Return the typed recovery CTA for ``exc``, or ``None``.

    Reads ``getattr(exc, "recovery_kind", None)``. Returns a
    ``RecoveryDescriptor`` iff the kind is a non-``None`` value that is also
    ``!= "none"`` and present in :data:`RECOVERY_DEFAULT_LABELS`; otherwise
    ``None``. So both ``recovery_kind="none"`` and a missing / ``None`` attr
    render without a CTA.
    """
    return _descriptor_for_kind(getattr(exc, "recovery_kind", None))


def _recovery_for_category(category: str) -> RecoveryDescriptor | None:
    """Resolve a wire ``category`` to its error class and read ``recovery_kind``.

    Handles the hyphenated wire aliases and the
    ``"BundleValidationError:<sub>"`` composite. Returns ``None`` when the
    category does not resolve to a known class (so an unknown category carries
    no silent recovery). The class attribute is the single source of truth.
    """
    class_name = _WIRE_CATEGORY_ALIASES.get(category, category)
    if class_name.startswith("BundleValidationError:"):
        class_name = "BundleValidationError"
    error_cls = _ERROR_CLASS_BY_NAME.get(class_name)
    if error_cls is None:
        return None
    return _descriptor_for_kind(error_cls.recovery_kind)


def map_worker_error(
    exc: WorkerError, *, extras: dict[str, Any] | None = None
) -> HTTPException:
    """Map a :class:`WorkerError` to an :class:`HTTPException`.

    Consolidates the per-route ``_map_worker_error`` helpers (see
    ``_error_audit.md``): looks up the canonical HTTP status for the wire
    ``category``, attaches the recovery descriptor read off the resolved error
    class, and spreads any ``extras`` (e.g. the DELETE-elements
    ``dependents`` / ``total``) into the detail dict so they ride along the
    ``ProblemDetails`` envelope (which is ``extra="allow"``).

    The ``detail`` is always a dict of the RFC-7807-extension shape the
    ``ProblemDetails`` handler in ``app.py`` knows how to spread:
    ``{"detail": <str>, "recovery": <descriptor|None>, **extras}``.

    An unknown / unmapped category falls back to HTTP 500 with a clear log
    line and NO recovery (no silent CTA).
    """
    category = exc.category or ""
    recovery = _recovery_for_category(category)

    http_status = WORKER_ERROR_HTTP_MAP.get(category)
    if http_status is None:
        # ``BundleValidationError:<sub>`` is route-specific (its sub-category
        # decides the status); the shared default treats the composite as a
        # validation failure (422) — Unit 4b's bundle route keeps its own
        # sub-category table. Everything else unknown -> 500 + log.
        if category.startswith("BundleValidationError:"):
            http_status = status.HTTP_422_UNPROCESSABLE_ENTITY
        else:
            log.error(
                "map_worker_error: unmapped worker error category %r "
                "(detail=%r) — defaulting to HTTP 500 with no recovery CTA",
                category,
                exc.detail,
            )
            http_status = status.HTTP_500_INTERNAL_SERVER_ERROR

    detail: dict[str, Any] = {
        "detail": exc.detail,
        "recovery": recovery.model_dump(mode="json") if recovery is not None else None,
    }
    if extras:
        for key, value in extras.items():
            detail[key] = value
    return HTTPException(status_code=http_status, detail=detail)
