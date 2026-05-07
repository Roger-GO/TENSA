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


# ---- decimation modes -------------------------------------------------------


async def _drive_streaming_run(
    token: str,
    port: int,
    sid: str,
    *,
    tf: float = 1.0,
    h: float | None = 1 / 120,
    decimation: str | None = None,
    max_rate_hz: float | None = None,
) -> tuple[dict[str, object], list[bytes], dict[str, object]]:
    """Helper: open WS, auth, send start_tds with optional decimation params,
    return (stream_start_metadata, list_of_binary_frames, done_message)."""
    ws_url = f"ws://127.0.0.1:{port}/ws/{sid}"
    cfg: dict[str, object] = {"type": "start_tds", "tf": tf}
    if h is not None:
        cfg["h"] = h
    if decimation is not None:
        cfg["decimation"] = decimation
    if max_rate_hz is not None:
        cfg["max_rate_hz"] = max_rate_hz

    async with websockets.connect(ws_url) as ws:
        await ws.send(json.dumps({"type": "auth", "token": token}))
        ready = json.loads(await ws.recv())
        assert ready["type"] == "ready"
        await ws.send(json.dumps(cfg))

        first = await ws.recv()
        assert isinstance(first, str)
        metadata = json.loads(first)
        assert metadata["type"] == "stream_start"

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
        assert done is not None
        return metadata, binary_frames, done


@pytest.mark.acceptance
async def test_streaming_decimation_mean_emits_one_row_per_window(
    live_server: tuple[str, int, str],
) -> None:
    """``decimation="mean"`` + ``max_rate_hz=10`` on a 1-second sim emits
    ~10 Arrow batches, each containing one row (the mean of that window's
    source samples). This is the anti-aliased-decimation contract."""
    token, port, base = live_server
    sid = await _create_session_and_load(token, base)

    metadata, binary_frames, done = await _drive_streaming_run(
        token, port, sid, tf=1.0, h=1 / 120, decimation="mean", max_rate_hz=10.0
    )

    decim = metadata["metadata"]["decimation"]
    assert decim["mode"] == "mean"
    assert decim["output_rate_hz"] == 10.0
    # ANDES TDS is adaptive-step by default; the algorithm label is best-effort.
    assert decim["algorithm"] in {"boxcar-mean", "boxcar-mean-best-effort"}

    # Roughly 10 frames over 1 simulated second, with slack for tail flush.
    assert 5 <= len(binary_frames) <= 15, (
        f"expected ~10 batches at 10 Hz output, got {len(binary_frames)}"
    )

    # Each batch contains exactly one row (the mean over that window).
    for frame in binary_frames:
        reader = pyarrow.ipc.open_stream(io.BytesIO(frame))
        batch = reader.read_next_batch()
        assert batch.num_rows == 1, (
            f"mean mode emits 1 row per batch; got {batch.num_rows}"
        )

    assert done["final_t"] >= 0.99


@pytest.mark.acceptance
async def test_streaming_decimation_none_with_max_rate_batches_rows(
    live_server: tuple[str, int, str],
) -> None:
    """``decimation="none"`` + ``max_rate_hz=10`` emits ~10 Arrow batches
    each containing multiple rows (the source steps that fell in that
    window). This is the N-rows-per-batch overhead optimization."""
    token, port, base = live_server
    sid = await _create_session_and_load(token, base)

    metadata, binary_frames, done = await _drive_streaming_run(
        token, port, sid, tf=1.0, h=1 / 120, decimation="none", max_rate_hz=10.0
    )

    decim = metadata["metadata"]["decimation"]
    assert decim["mode"] == "none"
    assert decim["algorithm"] == "none"
    assert decim["output_rate_hz"] == 10.0
    assert 5 <= len(binary_frames) <= 15

    # Most batches should contain MORE than one row. Allow up to 2 single-row
    # outliers (the tail flush, or windows with very few source samples).
    multi_row = sum(
        1
        for frame in binary_frames
        if pyarrow.ipc.open_stream(io.BytesIO(frame)).read_next_batch().num_rows > 1
    )
    assert multi_row >= len(binary_frames) - 2, (
        "most batches should contain multiple rows under N-rows-per-batch; "
        f"got {multi_row}/{len(binary_frames)} multi-row batches"
    )

    assert done["final_t"] >= 0.99


@pytest.mark.acceptance
async def test_streaming_decimation_mean_without_rate_closes_with_error(
    live_server: tuple[str, int, str],
) -> None:
    """``decimation="mean"`` without ``max_rate_hz`` is invalid; the WS
    layer rejects it before any TDS run starts."""
    token, port, base = live_server
    sid = await _create_session_and_load(token, base)
    ws_url = f"ws://127.0.0.1:{port}/ws/{sid}"

    async with websockets.connect(ws_url) as ws:
        await ws.send(json.dumps({"type": "auth", "token": token}))
        ready = json.loads(await ws.recv())
        assert ready["type"] == "ready"
        await ws.send(
            json.dumps(
                {"type": "start_tds", "tf": 1.0, "h": 1 / 120, "decimation": "mean"}
            )
        )
        try:
            while True:
                msg = await ws.recv()
                if isinstance(msg, str):
                    err = json.loads(msg)
                    if err.get("type") == "error":
                        assert "max_rate_hz" in err.get("reason", "")
        except websockets.exceptions.ConnectionClosed as exc:
            assert exc.code == 4500, f"expected 4500, got {exc.code}"


@pytest.mark.acceptance
async def test_streaming_decimation_default_matches_legacy_behavior(
    live_server: tuple[str, int, str],
) -> None:
    """Omitting ``decimation`` and ``max_rate_hz`` matches the v0.1 baseline:
    every callpert step is its own one-row Arrow batch (no aggregation)."""
    token, port, base = live_server
    sid = await _create_session_and_load(token, base)

    metadata, binary_frames, _done = await _drive_streaming_run(
        token, port, sid, tf=1.0, h=1 / 120
    )
    decim = metadata["metadata"]["decimation"]
    assert decim["mode"] == "none"
    assert decim["output_rate_hz"] is None
    for frame in binary_frames:
        reader = pyarrow.ipc.open_stream(io.BytesIO(frame))
        batch = reader.read_next_batch()
        assert batch.num_rows == 1
