"""A tds study's results document carries the run's own status (unit f2).

``POST /studies`` used to build every time-domain document with the default
``status="completed"``, so a run that failed or was stopped read as completed.
These tests pin the mapping from a run's payload to the document's status, and
that ``_run_study`` passes it for both engines (the streamed ANDES path and
the Sienna path).
"""

from __future__ import annotations

import asyncio
from typing import Any

from tensa.api.routes.studies import _run_status, _run_study
from tensa.engines.study_doc import StudyDocument


def test_run_status_reads_the_payload() -> None:
    assert _run_status({"status": "failed"}) == "failed"
    assert _run_status({"status": "aborted"}) == "aborted"
    assert _run_status({"status": "completed"}) == "completed"
    # A run that ended without completing and was not aborted failed.
    assert _run_status({"completed": False}) == "failed"
    assert _run_status({"aborted": True, "completed": False}) == "aborted"
    assert _run_status({"completed": True}) == "completed"
    # A payload that says nothing is a completed run, as before.
    assert _run_status({}) == "completed"


class _FakeManager:
    """The ops a tds study calls, answered from a table of payloads."""

    def __init__(self, payloads: dict[str, Any]) -> None:
        self._payloads = payloads

    async def invoke(
        self, sid: str, op: str, args: dict[str, Any], timeout: float
    ) -> Any:
        return self._payloads[op]

    async def invoke_streaming(
        self,
        sid: str,
        op: str,
        args: dict[str, Any],
        on_metadata: Any,
        on_frame: Any,
        timeout: float,
    ) -> Any:
        await on_metadata({"var_columns": []})
        return self._payloads[op]


def _study() -> StudyDocument:
    return StudyDocument.model_validate(
        {"tensa_study": 1, "routine": "tds", "options": {"t_end": 1.0}}
    )


def test_failed_run_marks_the_document_failed_sienna() -> None:
    payloads = {
        "list_keys": {"keys": []},
        "run_pflow": {"versions": {}},
        "run_tds": {
            "versions": {},
            "status": "failed",
            "traces": {"t": [], "variables": [], "truncated": False},
        },
    }
    document, _raw = asyncio.run(
        _run_study(_FakeManager(payloads), "sid", "sienna", _study())
    )
    assert document.status == "failed"


def test_failed_run_marks_the_document_failed_andes() -> None:
    payloads = {
        "list_keys": {"keys": []},
        "run_pflow": {"versions": {}},
        "run_tds": {"versions": {}, "completed": False},
    }
    document, _raw = asyncio.run(
        _run_study(_FakeManager(payloads), "sid", "andes", _study())
    )
    assert document.status == "failed"


def test_aborted_run_marks_the_document_aborted_andes() -> None:
    payloads = {
        "list_keys": {"keys": []},
        "run_pflow": {"versions": {}},
        "run_tds": {"versions": {}, "aborted": True, "completed": False},
    }
    document, _raw = asyncio.run(
        _run_study(_FakeManager(payloads), "sid", "andes", _study())
    )
    assert document.status == "aborted"


def test_completed_run_marks_the_document_completed_andes() -> None:
    payloads = {
        "list_keys": {"keys": []},
        "run_pflow": {"versions": {}},
        "run_tds": {"versions": {}, "completed": True},
    }
    document, _raw = asyncio.run(
        _run_study(_FakeManager(payloads), "sid", "andes", _study())
    )
    assert document.status == "completed"
