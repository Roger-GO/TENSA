"""Integration tests for TDS streaming over WebSocket + Arrow IPC.

These tests spawn ``andes-app serve`` in a subprocess (the same pattern as
the Phase A acceptance walkthrough), connect a real WebSocket client via
the ``websockets`` library, and assert on the wire protocol end-to-end:
auth handshake, stream-start metadata, Arrow IPC binary frames, and the
final ``done`` text frame.
"""

from __future__ import annotations

import io
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
import pyarrow.ipc
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
async def live_server(tmp_path: Path) -> AsyncIterator[tuple[str, int, str]]:
    """Spawn ``andes-app serve`` in a subprocess; yield (token, port, base_url).

    Workspace is seeded with IEEE 14 .raw + .dyr fixtures so the integration
    test can drive a real PF + TDS run."""
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    raw, dyr = _ieee14_paths()
    shutil.copy2(raw, workspace / "ieee14.raw")
    shutil.copy2(dyr, workspace / "ieee14.dyr")
    token_file = tmp_path / "run.token"
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
            "--token-file",
            str(token_file),
        ],
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(tmp_path),
    )
    try:
        _wait_for_server(port)
        token = token_file.read_text().strip()
        yield token, port, f"http://127.0.0.1:{port}"
    finally:
        proc.terminate()
        try:
            proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


async def _create_session_and_load(
    token: str, base_url: str, primary: str = "ieee14.raw", addfile: str = "ieee14.dyr"
) -> str:
    """Helper: create a session over HTTP and load IEEE 14. Returns session_id."""
    async with httpx.AsyncClient(base_url=base_url) as client:
        resp = await client.post("/sessions", headers={"X-Andes-Token": token})
        sid = str(resp.json()["session_id"])
        await client.post(
            f"/sessions/{sid}/case",
            headers={"X-Andes-Token": token},
            json={"primary_path": primary, "addfiles": [addfile]},
        )
    return sid


@pytest.mark.acceptance
async def test_streaming_tds_end_to_end(live_server: tuple[str, int, str]) -> None:
    """Load case → open WS → auth → start_tds → receive ≥10 Arrow batches +
    final done message. Decode the first batch and assert the schema matches
    what the stream_start metadata declared."""
    token, port, base_url = live_server
    sid = await _create_session_and_load(token, base_url)

    ws_url = f"ws://127.0.0.1:{port}/ws/{sid}"
    async with websockets.connect(ws_url) as ws:
        # Auth
        await ws.send(json.dumps({"type": "auth", "token": token}))
        ready = json.loads(await ws.recv())
        assert ready["type"] == "ready"

        # Start TDS
        await ws.send(json.dumps({"type": "start_tds", "tf": 1.0, "h": 1 / 120}))

        # Receive stream_start metadata (text)
        first = await ws.recv()
        assert isinstance(first, str), f"expected text frame, got {type(first)}"
        metadata = json.loads(first)
        assert metadata["type"] == "stream_start"
        assert "var_columns" in metadata["metadata"]
        assert len(metadata["metadata"]["var_columns"]) == 14  # 14 buses

        # Receive binary frames until "done"
        binary_frames: list[bytes] = []
        done: dict[str, object] | None = None
        while True:
            msg = await ws.recv()
            if isinstance(msg, bytes):
                binary_frames.append(msg)
            elif isinstance(msg, str):
                parsed = json.loads(msg)
                if parsed.get("type") == "done":
                    done = parsed
                    break
                pytest.fail(f"unexpected text frame: {parsed}")
            else:
                pytest.fail(f"unexpected frame type: {type(msg)}")

        assert done is not None
        assert done["final_t"] >= 0.99, f"final_t = {done['final_t']}"
        assert len(binary_frames) >= 10, (
            f"expected ≥ 10 Arrow batches, got {len(binary_frames)}"
        )

    # Decode the first batch and assert schema
    reader = pyarrow.ipc.open_stream(io.BytesIO(binary_frames[0]))
    schema = reader.schema
    assert schema.field("t").type == pyarrow.float64()
    expected_columns = ["t"] + metadata["metadata"]["var_columns"]
    assert schema.names == expected_columns

    # Read the batch
    batch = reader.read_next_batch()
    assert batch.num_rows == 1
    # 14 buses + 1 t column = 15 columns
    assert batch.num_columns == 15


@pytest.mark.acceptance
async def test_streaming_tds_bad_token_closes_4401(
    live_server: tuple[str, int, str],
) -> None:
    """First message with the wrong token causes server to close with 4401."""
    _token, port, _base = live_server
    ws_url = f"ws://127.0.0.1:{port}/ws/some-session-id"
    async with websockets.connect(ws_url) as ws:
        await ws.send(json.dumps({"type": "auth", "token": "wrong"}))
        # Server should send an error text frame, then close with 4401
        try:
            text = await ws.recv()
            err = json.loads(text)
            assert err.get("type") == "error"
            assert err.get("code") == 4401
        except websockets.exceptions.ConnectionClosed as exc:
            assert exc.code == 4401, f"expected 4401, got {exc.code}"
            return
        # Followed by close
        try:
            await ws.recv()
            pytest.fail("expected close after error frame")
        except websockets.exceptions.ConnectionClosed as exc:
            assert exc.code == 4401


@pytest.mark.acceptance
async def test_streaming_tds_auth_timeout_closes_4401(
    live_server: tuple[str, int, str],
) -> None:
    """Open WS, never send auth — server closes with 4401 within ~2s."""
    _token, port, _base = live_server
    ws_url = f"ws://127.0.0.1:{port}/ws/some-session-id"
    start = time.monotonic()
    async with websockets.connect(ws_url) as ws:
        # Don't send anything; wait for the server to close
        try:
            while True:
                msg = await ws.recv()
                # The server may emit an error text frame before closing
                if isinstance(msg, str):
                    err = json.loads(msg)
                    assert err.get("code") == 4401
        except websockets.exceptions.ConnectionClosed as exc:
            elapsed = time.monotonic() - start
            assert exc.code == 4401, f"expected 4401, got {exc.code}"
            assert elapsed < 5.0, f"server took too long to close: {elapsed}s"


@pytest.mark.acceptance
async def test_streaming_tds_unknown_session_closes_4404(
    live_server: tuple[str, int, str],
) -> None:
    """After successful auth, an unknown session_id closes with 4404."""
    token, port, _base = live_server
    ws_url = f"ws://127.0.0.1:{port}/ws/no-such-session"
    async with websockets.connect(ws_url) as ws:
        await ws.send(json.dumps({"type": "auth", "token": token}))
        # Expect close 4404 (possibly preceded by an error text frame)
        try:
            while True:
                msg = await ws.recv()
                if isinstance(msg, str):
                    err = json.loads(msg)
                    assert err.get("code") == 4404
        except websockets.exceptions.ConnectionClosed as exc:
            assert exc.code == 4404, f"expected 4404, got {exc.code}"
