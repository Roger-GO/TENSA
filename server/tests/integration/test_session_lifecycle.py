"""Integration tests for SessionManager + worker subprocess.

These tests spawn real worker subprocesses (one per test, isolated by
session_id) and exercise the full RPC lifecycle: spawn, load_case, run_pflow,
abort during run_tds, idle-timeout reap, max-sessions cap, and clean shutdown.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path

import pytest

from andes_app.core.session import (
    SessionExpiredError,
    SessionManager,
    WorkerError,
)


def _ieee14_paths() -> tuple[Path, Path]:
    pytest.importorskip("andes")
    import andes

    cases = Path(andes.__file__).parent / "cases" / "ieee14"
    raw = cases / "ieee14.raw"
    dyr = cases / "ieee14.dyr"
    if not raw.exists() or not dyr.exists():  # pragma: no cover
        pytest.skip(f"IEEE 14 fixtures not bundled: {cases}")
    return raw, dyr


@pytest.fixture
async def manager() -> SessionManager:
    """Yield a started SessionManager and shut it down at teardown."""
    mgr = SessionManager(max_sessions=4, idle_timeout=180.0)
    await mgr.start()
    try:
        yield mgr
    finally:
        await mgr.shutdown()


@pytest.mark.integration
async def test_create_session_and_load_case(manager: SessionManager) -> None:
    """Happy path: spawn a worker subprocess, send load_case over the control
    Pipe, receive a topology result on the data Pipe."""
    raw, _ = _ieee14_paths()
    session_id = await manager.create_session()
    assert manager.is_alive(session_id)

    payload = await manager.invoke(
        session_id, "load_case", {"path": str(raw), "addfiles": None}
    )
    assert payload["state"] == "pre-setup"
    assert len(payload["buses"]) == 14


@pytest.mark.integration
async def test_load_then_run_pflow(manager: SessionManager) -> None:
    """End-to-end RPC: load → run PF; verify converged."""
    raw, _ = _ieee14_paths()
    session_id = await manager.create_session()
    await manager.invoke(session_id, "load_case", {"path": str(raw)})
    pf = await manager.invoke(session_id, "run_pflow", {})
    assert pf["converged"] is True
    assert pf["iterations"] <= 10


@pytest.mark.integration
async def test_post_setup_add_disturbance_returns_structured_error(
    manager: SessionManager,
) -> None:
    """Edge case: post-setup add_disturbance surfaces as a WorkerError with
    category ``disturbance-commit`` (the API layer maps this to HTTP 409)."""
    raw, _ = _ieee14_paths()
    session_id = await manager.create_session()
    await manager.invoke(session_id, "load_case", {"path": str(raw)})
    await manager.invoke(session_id, "run_pflow", {})  # commits setup

    with pytest.raises(WorkerError) as exc_info:
        await manager.invoke(
            session_id,
            "add_disturbance",
            {"spec": {"kind": "fault", "bus_idx": 4, "tf": 1.0, "tc": 1.1}},
        )
    assert exc_info.value.category == "disturbance-commit"


@pytest.mark.integration
async def test_max_sessions_cap_returns_error(manager: SessionManager) -> None:
    """At the max-sessions cap, ``create_session`` raises ``RuntimeError``
    (the API layer translates this to HTTP 429)."""
    sess_ids = []
    for _ in range(4):
        sess_ids.append(await manager.create_session())

    with pytest.raises(RuntimeError, match="max_sessions"):
        await manager.create_session()

    # Closing one frees a slot
    await manager.close_session(sess_ids[0])
    new_id = await manager.create_session()
    assert manager.is_alive(new_id)


@pytest.mark.integration
async def test_close_session_invalidates_invoke(manager: SessionManager) -> None:
    """After close_session, invoke raises SessionExpiredError."""
    session_id = await manager.create_session()
    await manager.close_session(session_id)
    with pytest.raises(SessionExpiredError):
        await manager.invoke(session_id, "topology", {})


@pytest.mark.integration
async def test_unknown_session_id_raises_expired(manager: SessionManager) -> None:
    """invoke against an unknown session_id raises SessionExpiredError."""
    with pytest.raises(SessionExpiredError):
        await manager.invoke("does-not-exist", "topology", {})


@pytest.mark.integration
async def test_abort_terminates_run_tds(manager: SessionManager) -> None:
    """Set the abort event mid-TDS run; the worker terminates the integration
    loop within ~2 steps. The TdsBatchResult.final_t must be < tf."""
    raw, dyr = _ieee14_paths()
    session_id = await manager.create_session()
    await manager.invoke(
        session_id, "load_case", {"path": str(raw), "addfiles": [str(dyr)]}
    )

    # Schedule abort to fire after ~250 ms (well into the TDS run)
    async def _delayed_abort() -> None:
        await asyncio.sleep(0.25)
        await manager.signal_abort(session_id)

    abort_task = asyncio.create_task(_delayed_abort())
    payload = await manager.invoke(
        session_id, "run_tds", {"tf": 5.0, "h": 1 / 120}, timeout=15.0
    )
    await abort_task

    assert payload["final_t"] < 5.0, (
        f"abort did not terminate TDS, final_t = {payload['final_t']}"
    )


@pytest.mark.integration
async def test_idle_timeout_reaps_session() -> None:
    """A session with no activity beyond ``idle_timeout`` is reaped by the
    background task."""
    mgr = SessionManager(max_sessions=2, idle_timeout=1.0)  # 1-second idle window
    await mgr.start()
    try:
        session_id = await mgr.create_session()
        assert mgr.is_alive(session_id)

        # Wait long enough for one reaper tick after the timeout. The reaper
        # ticks every IDLE_REAP_TICK (5 s) — bypass that by setting a tiny
        # timeout and waiting up to 8 s for the reap to land.
        deadline = time.monotonic() + 8.0
        while time.monotonic() < deadline:
            if not mgr.is_alive(session_id):
                break
            await asyncio.sleep(0.5)

        assert not mgr.is_alive(session_id), "session was not reaped after idle timeout"
    finally:
        await mgr.shutdown()


@pytest.mark.integration
async def test_concurrent_sessions_are_independent(manager: SessionManager) -> None:
    """Two sessions can each load a case and run PF concurrently without
    interfering with each other."""
    raw, _ = _ieee14_paths()
    s1 = await manager.create_session()
    s2 = await manager.create_session()

    # Load on both
    await asyncio.gather(
        manager.invoke(s1, "load_case", {"path": str(raw)}),
        manager.invoke(s2, "load_case", {"path": str(raw)}),
    )
    # Run PF on both concurrently
    pf1, pf2 = await asyncio.gather(
        manager.invoke(s1, "run_pflow", {}),
        manager.invoke(s2, "run_pflow", {}),
    )
    assert pf1["converged"] and pf2["converged"]
