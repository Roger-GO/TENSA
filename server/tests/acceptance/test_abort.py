"""Acceptance tests for ``POST /sessions/{id}/abort`` (Unit 1b of v0.2).

These tests spawn ``andes-app serve`` in a subprocess (mirroring the
existing TDS streaming acceptance suite), open a real WebSocket against
the substrate, fire a streaming TDS, and verify that an out-of-band
``POST /abort`` from a separate HTTP client cooperatively terminates the
run.

Wire contract (per the v0.2 plan, Unit 1b):

- ``POST /api/sessions/{id}/abort`` returns ``200 {"aborted": true}`` and
  sets the session's abort event. The worker's ``callpert`` hook checks
  the event each tick and sets ``ss.TDS.busted`` on detect.
- The streaming WS subsequently emits ``{"type": "done", final_t < tf}``
  once the integration loop exits. The ``done`` payload has NO
  ``aborted`` flag — the UI infers user-initiated abort from local state.
- Unknown session_id → 404. Closed session → 404. Pre-active-run abort
  → 200 no-op (event is set but never consumed).
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
import websockets


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _wait_for_server(port: int, timeout: float = 60.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.2)
    raise RuntimeError(f"server did not bind on port {port} within {timeout}s")


def _ieee14_paths() -> tuple[Path, Path]:
    pytest.importorskip("andes")
    import andes

    cases = Path(andes.__file__).parent / "cases" / "ieee14"
    return cases / "ieee14.raw", cases / "ieee14.dyr"


@pytest.fixture
async def live_server(tmp_path: Path) -> AsyncIterator[tuple[int, str]]:
    """Spawn ``andes-app serve``; yield (port, base_url) with IEEE 14
    seeded into the workspace so the tests can drive a real TDS run."""
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    raw, dyr = _ieee14_paths()
    shutil.copy2(raw, workspace / "ieee14.raw")
    shutil.copy2(dyr, workspace / "ieee14.dyr")
    port = _free_port()

    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "andes_app",
            "serve",
            "--bind",
            "127.0.0.1",
            "--port",
            str(port),
            "--workspace",
            str(workspace),
        ],
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(tmp_path),
    )
    try:
        _wait_for_server(port)
        yield port, f"http://127.0.0.1:{port}"
    finally:
        proc.terminate()
        try:
            proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


async def _create_session_and_load(
    base_url: str, primary: str = "ieee14.raw", addfile: str = "ieee14.dyr"
) -> str:
    """Helper: create a session over HTTP and load IEEE 14. Returns session_id."""
    async with httpx.AsyncClient(base_url=base_url) as client:
        resp = await client.post("/api/sessions")
        assert resp.status_code == 201, resp.text
        sid = str(resp.json()["session_id"])
        load_resp = await client.post(
            f"/api/sessions/{sid}/case",
            json={"primary_path": primary, "addfiles": [addfile]},
        )
        assert load_resp.status_code == 200, load_resp.text
    return sid


@pytest.mark.acceptance
async def test_abort_terminates_streaming_run(
    live_server: tuple[int, str],
) -> None:
    """Start a long-horizon streaming TDS over WS; from another HTTP client,
    POST /abort; the WS receives ``done`` with ``final_t < tf`` cleanly."""
    port, base = live_server
    sid = await _create_session_and_load(base)

    ws_url = f"ws://127.0.0.1:{port}/api/ws/{sid}"
    abort_url = f"{base}/api/sessions/{sid}/abort"

    async with websockets.connect(ws_url) as ws:
        ready = json.loads(await ws.recv())
        assert ready["type"] == "ready"

        # 60-second sim — plenty of room to interrupt.
        await ws.send(
            json.dumps(
                {
                    "type": "start_tds",
                    "tf": 60.0,
                    "h": 1 / 120,
                    "decimation": "mean",
                    "max_rate_hz": 30.0,
                }
            )
        )

        # Wait for stream_start so we know the run is in flight.
        first = await ws.recv()
        assert isinstance(first, str)
        meta = json.loads(first)
        assert meta["type"] == "stream_start"

        # Receive at least one binary frame so we know the integration loop
        # is actually running on the worker, then fire the abort.
        msg = await ws.recv()
        assert isinstance(msg, bytes), (
            f"expected first frame to be binary, got {type(msg)}"
        )

        # Fire abort from a separate HTTP client (mirrors the UI's pattern:
        # one tab streams via WS, the abort button POSTs from the same
        # browser session over HTTP).
        async with httpx.AsyncClient() as client:
            abort_start = time.monotonic()
            resp = await client.post(
                abort_url, timeout=5.0
            )
            abort_latency = time.monotonic() - abort_start
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"aborted": True}
        # The route returns immediately — the cooperative exit lands later
        # on the worker. ~100 ms is the budget for the HTTP round-trip.
        assert abort_latency < 1.0, (
            f"abort HTTP round-trip too slow: {abort_latency:.3f}s"
        )

        # Drain the WS until ``done`` arrives. The integration loop exits at
        # the next ``callpert`` tick (~8 ms at h=1/120 on IEEE 14 — well
        # under the 1-sim-second wall-clock budget the plan calls for).
        done: dict[str, object] | None = None
        deadline = time.monotonic() + 30.0
        while time.monotonic() < deadline:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=15.0)
            except TimeoutError:
                pytest.fail("WS hung after abort; expected ``done`` within 15 s")
            if isinstance(msg, str):
                parsed = json.loads(msg)
                if parsed.get("type") == "done":
                    done = parsed
                    break
        assert done is not None, "did not receive ``done`` after abort"
        # Must be substantially less than tf — abort fired well before t=60.
        final_t = float(done["final_t"])  # type: ignore[arg-type]
        assert final_t < 60.0, f"abort did not interrupt TDS, final_t={final_t}"
        assert final_t < 5.0, (
            f"abort latency too high: TDS reached final_t={final_t} (budget < 5 sim-s)"
        )


@pytest.mark.acceptance
async def test_abort_with_no_active_run_returns_200(
    live_server: tuple[int, str],
) -> None:
    """POST /abort while no TDS is running is a 200 no-op — the abort event
    is set but never consumed (the next run will see + clear it)."""
    port, base = live_server
    sid = await _create_session_and_load(base)

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{base}/api/sessions/{sid}/abort",
        )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"aborted": True}


@pytest.mark.acceptance
async def test_abort_unknown_session_returns_404(
    live_server: tuple[int, str],
) -> None:
    """POST /abort on a session id that was never created → 404."""
    _port, base = live_server
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{base}/api/sessions/no-such-session/abort",
        )
    assert resp.status_code == 404, resp.text


@pytest.mark.acceptance
async def test_abort_closed_session_returns_404(
    live_server: tuple[int, str],
) -> None:
    """POST /abort after explicitly closing the session → 404."""
    _port, base = live_server
    async with httpx.AsyncClient() as client:
        # Create then close
        create = await client.post(
            f"{base}/api/sessions"
        )
        sid = str(create.json()["session_id"])
        close = await client.delete(
            f"{base}/api/sessions/{sid}"
        )
        assert close.status_code in (200, 204), close.text

        resp = await client.post(
            f"{base}/api/sessions/{sid}/abort",
        )
    assert resp.status_code == 404, resp.text
