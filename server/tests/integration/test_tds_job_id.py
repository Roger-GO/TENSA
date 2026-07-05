"""Integration tests for v3.1 Unit 5c — TDS ``job_id`` reconciliation.

The wire shape GAINS a ``job_id`` field; the legacy ``run_id`` is preserved
and the two are IDENTICAL (additive aliasing, nothing removed):

  (a) batch ``POST /sessions/{id}/tds`` returns BOTH ``run_id`` and ``job_id``,
      identical, and ``GET /sessions/{id}/jobs/{job_id}`` resolves a record
      (kind ``tds-batch``);
  (b) the streaming-start path (``SessionManager.start_streaming_run``, exercised
      in-process — it does NOT require the WS to actually stream) registers a
      ``tds-stream`` record whose registry ``job_id`` EQUALS the ``run_id``.

These stand up the real FastAPI app over a workspace seeded with the IEEE 14
fixtures, driving everything end-to-end through a worker subprocess.
"""

from __future__ import annotations

import shutil
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from tensa.api.app import make_app
from tensa.core.session import SessionManager


def _bundled_ieee14_dir() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases" / "ieee14"


@pytest.fixture
async def client(
    tmp_path: Path,
) -> AsyncIterator[tuple[httpx.AsyncClient, SessionManager]]:
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    src = _bundled_ieee14_dir()
    for name in ["ieee14.raw", "ieee14.dyr"]:
        shutil.copy2(src / name, workspace / name)

    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=2,
        idle_timeout_seconds=180.0,
    )
    mgr = SessionManager(
        max_sessions=2, idle_timeout=180.0, workspace=str(workspace)
    )
    await mgr.start()
    app.state.session_manager = mgr
    app.state.workspace = workspace
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(
            transport=transport, base_url="http://127.0.0.1:8000"
        ) as ac:
            yield ac, mgr
    finally:
        await mgr.shutdown()


async def _new_session(ac: httpx.AsyncClient) -> str:
    resp = await ac.post("/api/sessions")
    assert resp.status_code == 201, resp.text
    return str(resp.json()["session_id"])


async def _load_case(ac: httpx.AsyncClient, sid: str) -> None:
    resp = await ac.post(
        f"/api/sessions/{sid}/case",
        json={"primary_path": "ieee14.raw", "addfiles": ["ieee14.dyr"]},
    )
    assert resp.status_code in (200, 201), resp.text


@pytest.mark.integration
async def test_batch_tds_returns_run_id_and_identical_job_id(
    client: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    """POST /tds returns BOTH run_id and job_id; they are identical, and
    GET /jobs/{job_id} resolves a ``tds-batch`` record marked ``done``."""
    ac, _mgr = client
    sid = await _new_session(ac)
    await _load_case(ac, sid)

    resp = await ac.post(
        f"/api/sessions/{sid}/tds",
        json={"tf": 0.1, "h": None},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    run_id = body["run_id"]
    job_id = body["job_id"]
    assert isinstance(run_id, str) and run_id
    assert isinstance(job_id, str) and job_id
    # The HARD invariant: job_id is the SAME value as run_id (additive alias).
    assert job_id == run_id

    # The registry record resolves and reflects the completed batch run.
    rec = await ac.get(f"/api/sessions/{sid}/jobs/{job_id}")
    assert rec.status_code == 200, rec.text
    record = rec.json()
    assert record["id"] == job_id
    assert record["kind"] == "tds-batch"
    assert record["status"] == "done"
    # Streaming/sweep/batch-TDS jobs expose a cooperative-abort affordance.
    assert record["can_cancel"] is True


@pytest.mark.integration
async def test_streaming_start_registers_tds_stream_job_with_aliased_id(
    client: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    """``start_streaming_run`` registers a ``tds-stream`` record whose
    registry ``job_id`` EQUALS the ``run_id`` — exercised in-process; it does
    NOT require the WS to actually stream.

    The run is aborted immediately so the background task drains without a long
    simulation; we assert the record exists and aliases the run_id BEFORE
    (or regardless of) terminal reconciliation.
    """
    ac, mgr = client
    sid = await _new_session(ac)
    await _load_case(ac, sid)

    run_args: dict[str, object] = {
        "tf": 0.1,
        "h": None,
        "stream": True,
        "decimation": "none",
        "max_rate_hz": None,
        "vars": ["bus_v"],
        "integrator": "trapezoidal",
    }
    run_id = await mgr.start_streaming_run(sid, "run_tds", run_args)
    assert isinstance(run_id, str) and run_id

    # The job is registered synchronously the instant the run starts; its
    # registry id IS the run_id (aliased, same value).
    rec = await ac.get(f"/api/sessions/{sid}/jobs/{run_id}")
    assert rec.status_code == 200, rec.text
    record = rec.json()
    assert record["id"] == run_id
    assert record["kind"] == "tds-stream"
    # Immediately post-start the run is still in-flight: the record is
    # registered synchronously ``pending`` and the driver may have flipped it
    # ``running`` once the worker began emitting frames. It has NOT had time to
    # reach a terminal state, so a tight in-flight assertion is load-bearing
    # (the prior "every status except cancelled" set validated nothing).
    assert record["status"] in ("pending", "running")
    assert record["can_cancel"] is True

    # Cooperatively abort so the background driver tears down promptly and the
    # fixture's ``mgr.shutdown`` (which cancels run tasks) is fast.
    await mgr.signal_abort(sid)


@pytest.mark.integration
async def test_delete_cancel_of_live_stream_fires_real_abort(
    client: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    """DELETE /jobs/{id} for a LIVE streaming run must actually abort the work,
    not just flip the record to ``cancelled``: the session abort event must be
    set (the cooperative-abort path ``run_tds`` checks each ``callpert`` tick).

    Regression for the Phase-2 finding that ``cancel_session_job`` only called
    ``mark_cancelled`` and never wired ``signal_abort`` / task cancellation, so
    the worker ran to completion while the record falsely read ``cancelled``.
    """
    ac, mgr = client
    sid = await _new_session(ac)
    await _load_case(ac, sid)

    run_args: dict[str, object] = {
        "tf": 5.0,
        "h": None,
        "stream": True,
        "decimation": "none",
        "max_rate_hz": None,
        "vars": ["bus_v"],
        "integrator": "trapezoidal",
    }
    run_id = await mgr.start_streaming_run(sid, "run_tds", run_args)

    sess = mgr._sessions[sid]
    assert not sess.abort_event.is_set()

    resp = await ac.delete(f"/api/sessions/{sid}/jobs/{run_id}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "cancelled"

    # The REAL abort fired — not just the record flip.
    assert sess.abort_event.is_set()
