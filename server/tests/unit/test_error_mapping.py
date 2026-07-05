"""Unit 4a — shared error-mapping module + recovery plumbing.

Pure-unit coverage of ``tensa.api.error_mapping`` and the new
``app.py`` exception handlers. This env has NO ``httpx`` / NO ``andes``
(PEP-668 blocks installs), so ``TestClient`` / ``httpx`` integration tests
cannot run here. Instead we:

- call ``map_worker_error`` / ``recovery_for`` directly (they are pure);
- invoke the ``app.py`` handler functions directly against a hand-built
  ``starlette.requests.Request`` and parse the ``JSONResponse`` body.

The full HTTP round-trip (TestClient) is deferred to a later env / Phase 7.
"""

from __future__ import annotations

import json
import logging
import sys
import types

import pytest
from fastapi import HTTPException
from starlette.requests import Request

# --- multipart shim (lean-env only) -----------------------------------------
#
# Importing ``tensa.api.app`` eagerly imports every router, and the bundle
# router declares ``UploadFile`` / ``Form`` params that make FastAPI call
# ``ensure_multipart_is_installed()`` at decoration time. ``python_multipart``
# is genuinely absent in this lean PYTHONPATH=src env (PEP-668 blocks installs;
# no httpx / no andes either — see module docstring). Install a minimal shim
# exposing only the ``__version__`` attribute FastAPI probes so the handler
# functions under test (which do NOT touch multipart) can be imported. A real
# env with python_multipart installed skips this branch.
if "python_multipart" not in sys.modules:
    try:  # pragma: no cover - env-dependent
        import python_multipart  # noqa: F401
    except ModuleNotFoundError:  # pragma: no cover - lean env path
        _mp = types.ModuleType("python_multipart")
        _mp.__version__ = "0.0.20"  # type: ignore[attr-defined]
        sys.modules["python_multipart"] = _mp
        _legacy = types.ModuleType("multipart")
        _legacy.__version__ = "0.0.20"  # type: ignore[attr-defined]
        _legacy_inner = types.ModuleType("multipart.multipart")
        _legacy_inner.parse_options_header = lambda *a, **k: (b"", {})  # type: ignore[attr-defined]
        _legacy.multipart = _legacy_inner  # type: ignore[attr-defined]
        sys.modules["multipart"] = _legacy
        sys.modules["multipart.multipart"] = _legacy_inner

from tensa.api.error_mapping import (
    WORKER_ERROR_HTTP_MAP,
    map_worker_error,
    recovery_for,
)
from tensa.api.schemas import RECOVERY_DEFAULT_LABELS, RecoveryDescriptor
from tensa.core.errors import (
    EigPrerequisiteError,
    SessionBusyError,
)
from tensa.core.jobs import _JobRegistry
from tensa.core.session import SweepInProgressError, WorkerError

# --- recovery_for (pure helper) ---------------------------------------------


def test_recovery_for_representative_kind_returns_descriptor() -> None:
    desc = recovery_for(EigPrerequisiteError("run pflow first"))
    assert isinstance(desc, RecoveryDescriptor)
    assert desc.kind == "run-pflow"
    assert desc.label == RECOVERY_DEFAULT_LABELS["run-pflow"]


def test_recovery_for_none_string_kind_returns_none() -> None:
    """An error whose ``recovery_kind == 'none'`` carries no CTA."""

    class _NoneKind(Exception):
        recovery_kind = "none"

    assert recovery_for(_NoneKind()) is None


def test_recovery_for_none_attr_returns_none() -> None:
    """An error whose ``recovery_kind is None`` carries no CTA."""

    class _NullKind(Exception):
        recovery_kind = None

    assert recovery_for(_NullKind()) is None


def test_recovery_for_missing_attr_returns_none() -> None:
    """An exception with no ``recovery_kind`` attribute at all -> None."""
    assert recovery_for(ValueError("boom")) is None


def test_recovery_for_unknown_kind_returns_none() -> None:
    """A recovery_kind not present in the labels registry -> None (no CTA)."""

    class _BogusKind(Exception):
        recovery_kind = "teleport"

    assert recovery_for(_BogusKind()) is None


# --- map_worker_error: status + recovery ------------------------------------


def test_map_worker_error_prerequisite_is_409_with_run_pflow_recovery() -> None:
    exc = WorkerError("EigPrerequisiteError", "run pflow first")
    http = map_worker_error(exc)
    assert isinstance(http, HTTPException)
    assert http.status_code == 409
    detail = http.detail
    assert isinstance(detail, dict)
    assert detail["detail"] == "run pflow first"
    recovery = detail["recovery"]
    assert recovery is not None
    assert recovery["kind"] == "run-pflow"
    assert recovery["label"] == RECOVERY_DEFAULT_LABELS["run-pflow"]


def test_map_worker_error_dependents_is_422_with_extras_and_no_recovery() -> None:
    exc = WorkerError(
        "ElementHasDependentsError",
        "cannot delete bus 1: 7 dependents reference it",
    )
    dependents = [{"idx": "2", "name": "L1", "kind": "Line", "params": {}}]
    http = map_worker_error(exc, extras={"dependents": dependents, "total": 7})
    assert http.status_code == 422
    detail = http.detail
    assert isinstance(detail, dict)
    assert detail["dependents"] == dependents
    assert detail["total"] == 7
    # ElementHasDependentsError.recovery_kind == "none" -> no CTA.
    assert detail["recovery"] is None


def test_map_worker_error_no_case_loaded_wire_category_is_409() -> None:
    """The worker ships ``NoCaseLoadedError`` as the hyphenated wire string
    ``no-case-loaded``; the mapper must resolve it (not fall through to 500)."""
    exc = WorkerError("no-case-loaded", "no case loaded")
    http = map_worker_error(exc)
    assert http.status_code == 409
    detail = http.detail
    assert isinstance(detail, dict)
    assert detail["recovery"]["kind"] == "load-case"


def test_map_worker_error_disturbance_commit_wire_category_is_409() -> None:
    exc = WorkerError("disturbance-commit", "cannot modify after setup")
    http = map_worker_error(exc)
    assert http.status_code == 409
    detail = http.detail
    assert isinstance(detail, dict)
    assert detail["recovery"]["kind"] == "reload-case"


def test_map_worker_error_unknown_category_is_500_no_recovery(
    caplog: pytest.LogCaptureFixture,
) -> None:
    exc = WorkerError("TotallyMadeUpError", "kaboom")
    with caplog.at_level(logging.ERROR):
        http = map_worker_error(exc)
    assert http.status_code == 500
    detail = http.detail
    assert isinstance(detail, dict)
    # No silent recovery on an unmapped category.
    assert detail["recovery"] is None
    # A clear log line names the unmapped category.
    assert any("TotallyMadeUpError" in rec.getMessage() for rec in caplog.records)


def test_map_worker_error_internal_error_category_is_500() -> None:
    exc = WorkerError("internal-error", "ValueError: nope")
    http = map_worker_error(exc)
    assert http.status_code == 500
    detail = http.detail
    assert isinstance(detail, dict)
    assert detail["recovery"] is None


def test_worker_error_http_map_covers_documented_categories() -> None:
    # Sanity: the canonical class-name keys resolve through the map.
    for key in ("EigPrerequisiteError", "ElementHasDependentsError"):
        assert key in WORKER_ERROR_HTTP_MAP


def test_map_worker_error_bundle_validation_subcategory_is_422_no_recovery() -> None:
    """The composite ``BundleValidationError:<sub>`` wire category is NOT a key
    in the table; the special-case branch strips the ``:<sub>`` suffix, resolves
    the ``BundleValidationError`` class (recovery_kind is the inherited ``None``)
    and falls back to 422 instead of the 500 default. This is the most divergent
    shape Unit 4b migrates against (the bundle route keeps its own per-sub-category
    400/413/422 table at the call site)."""
    exc = WorkerError("BundleValidationError:manifest-missing", "no manifest.json")
    http = map_worker_error(exc)
    assert http.status_code == 422
    detail = http.detail
    assert isinstance(detail, dict)
    assert detail["detail"] == "no manifest.json"
    # BundleValidationError inherits the base ``recovery_kind = None`` -> no CTA.
    assert detail["recovery"] is None


def test_map_worker_error_setup_failed_canonical_status_is_422() -> None:
    """``SetupFailedError`` canonical status is 422 (the baseline Unit 4b
    overrides per-route: 409 in elements/pmu, 500 in profiles). Pinning the
    canonical value here guards against a drift that "fixes" it to match one of
    the per-route overrides — which would silently pass CI otherwise."""
    http = map_worker_error(WorkerError("SetupFailedError", "ANDES setup failed"))
    assert http.status_code == 422
    assert WORKER_ERROR_HTTP_MAP["SetupFailedError"] == 422


def test_map_worker_error_bare_tensa_error_category_falls_to_500() -> None:
    """The bare ``AndesAppError`` category (snapshot-export 422 override is
    route-local, NOT in the shared map) must fall through to the 500 default —
    documenting that the snapshot override lives at the call site, not here."""
    assert "AndesAppError" not in WORKER_ERROR_HTTP_MAP
    http = map_worker_error(WorkerError("AndesAppError", "generic substrate failure"))
    assert http.status_code == 500
    detail = http.detail
    assert isinstance(detail, dict)
    assert detail["recovery"] is None


# --- SessionBusyError handler (app.py) --------------------------------------


def _make_request() -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/",
            "headers": [],
        }
    )


def _handle_busy(exc: SessionBusyError) -> tuple[int, dict[str, object]]:
    from tensa.api.app import _session_busy_to_problem_details

    response = _session_busy_to_problem_details(_make_request(), exc)
    body = json.loads(response.body)
    return response.status_code, body


def test_session_busy_handler_409_with_recovery_and_null_current_job() -> None:
    status_code, body = _handle_busy(SessionBusyError())
    assert status_code == 409
    assert body["status"] == 409
    assert body["recovery"]["kind"] == "wait-for-job"
    assert body["recovery"]["label"] == RECOVERY_DEFAULT_LABELS["wait-for-job"]
    # current_job rides along as an extra field (extra="allow"); None stays null.
    assert "current_job" in body
    assert body["current_job"] is None


def test_session_busy_handler_409_with_populated_current_job() -> None:
    reg = _JobRegistry()
    job_id = reg.register_job(kind="eig", can_cancel=False)
    reg.mark_running(job_id)
    job = reg.get_job(job_id)
    assert job is not None

    status_code, body = _handle_busy(SessionBusyError(current_job=job))
    assert status_code == 409
    assert body["recovery"]["kind"] == "wait-for-job"
    current_job = body["current_job"]
    assert current_job is not None
    assert current_job["id"] == job_id
    assert current_job["kind"] == "eig"
    assert current_job["status"] == "running"
    assert current_job["can_cancel"] is False


# --- HTTPException -> ProblemDetails handler now plumbs recovery -------------


def test_problem_details_handler_plumbs_recovery_from_dict_detail() -> None:
    """When a route raises ``HTTPException(detail={...})`` carrying a
    ``recovery`` field (the shape ``map_worker_error`` produces), the
    ProblemDetails handler surfaces it on the envelope."""
    from tensa.api.app import _problem_details_handler

    http = map_worker_error(WorkerError("EigPrerequisiteError", "run pflow first"))
    response = _problem_details_handler(_make_request(), http)
    body = json.loads(response.body)
    assert response.status_code == 409
    assert body["recovery"]["kind"] == "run-pflow"


def test_problem_details_handler_string_detail_emits_null_recovery() -> None:
    """A plain string-detail ``HTTPException`` (the ``elif`` branch the Unit 4a
    edit also covers) must emit ``recovery: null`` — the recovery lift only fires
    on the dict-detail branch, and the string path must not raise."""
    from tensa.api.app import _problem_details_handler

    response = _problem_details_handler(
        _make_request(), HTTPException(status_code=409, detail="plain string")
    )
    body = json.loads(response.body)
    assert response.status_code == 409
    assert body["detail"] == "plain string"
    assert body["recovery"] is None


def test_problem_details_handler_dict_without_recovery_spreads_extras() -> None:
    """A dict-detail lacking a ``recovery`` key still spreads its other fields as
    extras while emitting ``recovery: null`` — and ``recovery`` must NOT leak into
    the spread extras (it is in the excluded-key set)."""
    from tensa.api.app import _problem_details_handler

    http = HTTPException(
        status_code=422,
        detail={"detail": "bad input", "field": "bus_idx"},
    )
    response = _problem_details_handler(_make_request(), http)
    body = json.loads(response.body)
    assert response.status_code == 422
    assert body["detail"] == "bad input"
    assert body["field"] == "bus_idx"
    assert body["recovery"] is None


def test_sweep_in_progress_handler_plumbs_wait_for_sweep_recovery() -> None:
    from tensa.api.app import _sweep_in_progress_to_problem_details

    exc = SweepInProgressError("sw-1", iter_done=2, iter_total=10)
    response = _sweep_in_progress_to_problem_details(_make_request(), exc)
    body = json.loads(response.body)
    assert response.status_code == 503
    assert body["recovery"]["kind"] == "wait-for-sweep"
    assert body["sweep_id"] == "sw-1"
