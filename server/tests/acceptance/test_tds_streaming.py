"""Integration tests for TDS streaming over WebSocket + Arrow IPC.

These tests spawn ``andes-app serve`` in a subprocess (the same pattern as
the Phase A acceptance walkthrough), connect a real WebSocket client via
the ``websockets`` library, and assert on the wire protocol end-to-end:
ready handshake, stream-start metadata, Arrow IPC binary frames, and the
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
async def live_server(tmp_path: Path) -> AsyncIterator[tuple[int, str]]:
    """Spawn ``andes-app serve`` in a subprocess; yield (port, base_url).

    Workspace is seeded with IEEE 14 .raw + .dyr fixtures so the integration
    test can drive a real PF + TDS run."""
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
        sid = str(resp.json()["session_id"])
        await client.post(
            f"/api/sessions/{sid}/case",
            json={"primary_path": primary, "addfiles": [addfile]},
        )
    return sid


@pytest.mark.acceptance
async def test_streaming_tds_end_to_end(live_server: tuple[int, str]) -> None:
    """Load case → open WS → ready → start_tds → receive ≥10 Arrow batches +
    final done message. Decode the first batch and assert the schema matches
    what the stream_start metadata declared."""
    port, base_url = live_server
    sid = await _create_session_and_load(base_url)

    ws_url = f"ws://127.0.0.1:{port}/api/ws/{sid}"
    async with websockets.connect(ws_url) as ws:
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
        # Default vars = bus_v + gen_state: 14 buses × (v, a) = 28 plus
        # 5 SynGen × (delta, omega) = 10 → 38 columns.
        assert len(metadata["metadata"]["var_columns"]) == 28 + 10

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
    # Default vars (bus_v + gen_state): 28 bus columns + 10 gen columns
    # + 1 t column = 39 columns.
    assert batch.num_columns == 28 + 10 + 1


@pytest.mark.acceptance
async def test_streaming_tds_unknown_session_closes_4404(
    live_server: tuple[int, str],
) -> None:
    """An unknown session_id closes with 4404."""
    port, _base = live_server
    ws_url = f"ws://127.0.0.1:{port}/api/ws/no-such-session"
    async with websockets.connect(ws_url) as ws:
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
    port: int,
    sid: str,
    *,
    tf: float = 1.0,
    h: float | None = 1 / 120,
    decimation: str | None = None,
    max_rate_hz: float | None = None,
    vars_: list[str] | None = None,
) -> tuple[dict[str, object], list[bytes], dict[str, object]]:
    """Helper: open WS, await ready, send start_tds with optional decimation params,
    return (stream_start_metadata, list_of_binary_frames, done_message)."""
    ws_url = f"ws://127.0.0.1:{port}/api/ws/{sid}"
    cfg: dict[str, object] = {"type": "start_tds", "tf": tf}
    if h is not None:
        cfg["h"] = h
    if decimation is not None:
        cfg["decimation"] = decimation
    if max_rate_hz is not None:
        cfg["max_rate_hz"] = max_rate_hz
    if vars_ is not None:
        cfg["vars"] = vars_

    async with websockets.connect(ws_url) as ws:
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
    live_server: tuple[int, str],
) -> None:
    """``decimation="mean"`` + ``max_rate_hz=10`` on a 1-second sim emits
    ~10 Arrow batches, each containing one row (the mean of that window's
    source samples). This is the anti-aliased-decimation contract."""
    port, base = live_server
    sid = await _create_session_and_load(base)

    metadata, binary_frames, done = await _drive_streaming_run(
        port, sid, tf=1.0, h=1 / 120, decimation="mean", max_rate_hz=10.0
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
    live_server: tuple[int, str],
) -> None:
    """``decimation="none"`` + ``max_rate_hz=10`` emits ~10 Arrow batches
    each containing multiple rows (the source steps that fell in that
    window). This is the N-rows-per-batch overhead optimization."""
    port, base = live_server
    sid = await _create_session_and_load(base)

    metadata, binary_frames, done = await _drive_streaming_run(
        port, sid, tf=1.0, h=1 / 120, decimation="none", max_rate_hz=10.0
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
    live_server: tuple[int, str],
) -> None:
    """``decimation="mean"`` without ``max_rate_hz`` is invalid; the WS
    layer rejects it before any TDS run starts."""
    port, base = live_server
    sid = await _create_session_and_load(base)
    ws_url = f"ws://127.0.0.1:{port}/api/ws/{sid}"

    async with websockets.connect(ws_url) as ws:
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
    live_server: tuple[int, str],
) -> None:
    """Omitting ``decimation`` and ``max_rate_hz`` matches the v0.1 baseline:
    every callpert step is its own one-row Arrow batch (no aggregation)."""
    port, base = live_server
    sid = await _create_session_and_load(base)

    metadata, binary_frames, _done = await _drive_streaming_run(
        port, sid, tf=1.0, h=1 / 120
    )
    decim = metadata["metadata"]["decimation"]
    assert decim["mode"] == "none"
    assert decim["output_rate_hz"] is None
    for frame in binary_frames:
        reader = pyarrow.ipc.open_stream(io.BytesIO(frame))
        batch = reader.read_next_batch()
        assert batch.num_rows == 1


# ---- resume / reconnect ----------------------------------------------------


@pytest.mark.acceptance
async def test_streaming_run_id_in_stream_start_metadata(
    live_server: tuple[int, str],
) -> None:
    """The ``stream_start`` text frame carries the server-generated
    ``run_id`` so the client can use it for a later ``resume`` request."""
    port, base = live_server
    sid = await _create_session_and_load(base)

    ws_url = f"ws://127.0.0.1:{port}/api/ws/{sid}"
    async with websockets.connect(ws_url) as ws:
        json.loads(await ws.recv())  # ready
        await ws.send(json.dumps({"type": "start_tds", "tf": 1.0, "h": 1 / 120}))

        first = json.loads(await ws.recv())
        assert first["type"] == "stream_start"
        assert isinstance(first.get("run_id"), str) and len(first["run_id"]) == 32

        # Drain remaining frames cleanly so the run completes.
        while True:
            msg = await ws.recv()
            if isinstance(msg, str):
                parsed = json.loads(msg)
                if parsed.get("type") == "done":
                    assert parsed.get("run_id") == first["run_id"]
                    break


@pytest.mark.acceptance
async def test_streaming_resume_after_disconnect(
    live_server: tuple[int, str],
) -> None:
    """The full resume contract: start a TDS, drop the WS mid-run, reconnect
    with ``{"type":"resume","run_id":...,"last_seq":N}``, receive remaining
    frames + the final ``done`` envelope. The run must continue running on
    the server while the client is disconnected."""
    port, base = live_server
    sid = await _create_session_and_load(base)

    ws_url = f"ws://127.0.0.1:{port}/api/ws/{sid}"

    # ---- Phase 1: start the run, capture some frames, drop the WS ----
    run_id: str | None = None
    last_captured_seq = 0
    captured_frames_count = 0
    target_capture = 5

    async with websockets.connect(ws_url) as ws:
        json.loads(await ws.recv())  # ready
        await ws.send(json.dumps({"type": "start_tds", "tf": 2.0, "h": 1 / 120}))

        meta = json.loads(await ws.recv())
        assert meta["type"] == "stream_start"
        run_id = meta["run_id"]

        # Receive a few binary frames, then bail out
        while captured_frames_count < target_capture:
            msg = await ws.recv()
            if isinstance(msg, bytes):
                captured_frames_count += 1
                # The frame's seq matches the server's monotonic counter; we
                # don't decode the binary payload here — we just count.
                last_captured_seq = captured_frames_count

    # The WS is now closed (context manager exited). The run continues in
    # the background buffer.

    # ---- Phase 2: reconnect, send resume, receive remaining + done ----
    async with websockets.connect(ws_url) as ws:
        json.loads(await ws.recv())  # ready
        await ws.send(
            json.dumps(
                {"type": "resume", "run_id": run_id, "last_seq": last_captured_seq}
            )
        )

        # Server replays metadata first (so client decoder can rebuild)
        meta2 = json.loads(await ws.recv())
        assert meta2["type"] == "stream_start"
        assert meta2["run_id"] == run_id

        # Then receive remaining frames + done. We don't know the exact frame
        # count but it should be > 0 and the final done message should arrive.
        post_resume_frames = 0
        done = None
        while True:
            msg = await ws.recv()
            if isinstance(msg, bytes):
                post_resume_frames += 1
            elif isinstance(msg, str):
                parsed = json.loads(msg)
                if parsed.get("type") == "done":
                    done = parsed
                    break

    assert done is not None
    assert done["run_id"] == run_id
    assert done["final_t"] >= 1.99
    assert post_resume_frames > 0, "resume should yield at least some new frames"


@pytest.mark.acceptance
async def test_streaming_resume_unknown_run_id_closes_4404(
    live_server: tuple[int, str],
) -> None:
    """``resume`` with a run_id the server doesn't know closes WS with 4404."""
    port, base = live_server
    sid = await _create_session_and_load(base)

    ws_url = f"ws://127.0.0.1:{port}/api/ws/{sid}"
    async with websockets.connect(ws_url) as ws:
        json.loads(await ws.recv())  # ready
        await ws.send(
            json.dumps({"type": "resume", "run_id": "deadbeef" * 4, "last_seq": 0})
        )
        try:
            while True:
                msg = await ws.recv()
                if isinstance(msg, str):
                    err = json.loads(msg)
                    assert err.get("code") == 4404
        except websockets.exceptions.ConnectionClosed as exc:
            assert exc.code == 4404, f"expected 4404, got {exc.code}"


@pytest.mark.acceptance
async def test_streaming_resume_after_run_completed_replays_full_run(
    live_server: tuple[int, str],
) -> None:
    """If the run completed while the client was disconnected, a resume with
    ``last_seq=0`` replays the full set of buffered frames + the done event.

    Buffer retention is 30 seconds, so a fresh resume right after completion
    sees the whole run."""
    port, base = live_server
    sid = await _create_session_and_load(base)

    ws_url = f"ws://127.0.0.1:{port}/api/ws/{sid}"

    # ---- Phase 1: complete a short run, capturing run_id but not frames ----
    run_id: str | None = None
    async with websockets.connect(ws_url) as ws:
        json.loads(await ws.recv())
        await ws.send(json.dumps({"type": "start_tds", "tf": 1.0, "h": 1 / 120}))
        meta = json.loads(await ws.recv())
        run_id = meta["run_id"]
        # Drain to completion
        while True:
            msg = await ws.recv()
            if isinstance(msg, str):
                parsed = json.loads(msg)
                if parsed.get("type") == "done":
                    break

    # ---- Phase 2: reconnect post-completion, resume from seq 0 ----
    async with websockets.connect(ws_url) as ws:
        json.loads(await ws.recv())
        await ws.send(
            json.dumps({"type": "resume", "run_id": run_id, "last_seq": 0})
        )
        meta2 = json.loads(await ws.recv())
        assert meta2["type"] == "stream_start"
        assert meta2["run_id"] == run_id

        # Should receive buffered frames + done immediately (all from buffer).
        frames_replayed = 0
        done = None
        while True:
            msg = await ws.recv()
            if isinstance(msg, bytes):
                frames_replayed += 1
            elif isinstance(msg, str):
                parsed = json.loads(msg)
                if parsed.get("type") == "done":
                    done = parsed
                    break

    assert done is not None
    assert done["final_t"] >= 0.99
    assert frames_replayed > 0, "completed-run replay yielded no frames"


# ---- v0.2 vars selector ----------------------------------------------------


@pytest.mark.acceptance
async def test_streaming_vars_default_omitted_is_bus_v_and_gen_state(
    live_server: tuple[int, str],
) -> None:
    """Omitting ``vars`` defaults to ``bus_v`` + ``gen_state`` so voltage,
    angle, and the omega frequency proxy are always plottable without
    re-running. Bus_v contributes ``Bus_<idx>_v`` + ``Bus_<idx>_a`` per
    bus; gen_state contributes ``Gen_<idx>_delta`` + ``Gen_<idx>_omega``
    per SynGen."""
    port, base = live_server
    sid = await _create_session_and_load(base)

    metadata, binary_frames, _done = await _drive_streaming_run(
        port, sid, tf=0.5, h=1 / 120
    )
    meta = metadata["metadata"]
    assert meta.get("vars") == ["bus_v", "gen_state"]
    var_cols = list(meta["var_columns"])
    v_cols = [c for c in var_cols if c.startswith("Bus_") and c.endswith("_v")]
    a_cols = [c for c in var_cols if c.startswith("Bus_") and c.endswith("_a")]
    delta_cols = [c for c in var_cols if c.startswith("Gen_") and c.endswith("_delta")]
    omega_cols = [c for c in var_cols if c.startswith("Gen_") and c.endswith("_omega")]
    assert len(v_cols) == 14
    assert len(a_cols) == 14
    assert len(delta_cols) == 5
    assert len(omega_cols) == 5
    assert len(var_cols) == 28 + 10

    reader = pyarrow.ipc.open_stream(io.BytesIO(binary_frames[0]))
    schema = reader.schema
    assert schema.names == ["t"] + var_cols


@pytest.mark.acceptance
async def test_streaming_vars_bus_v_and_gen_state_includes_both_groups(
    live_server: tuple[int, str],
) -> None:
    """``vars: ["bus_v","gen_state"]`` produces frames whose Arrow schema
    has both bus voltage/angle + generator delta/omega columns. IEEE 14 +
    the .dyr addfile gives 14 buses × (v, a) = 28 plus 5 GENROU SynGen ×
    (delta, omega) = 10 → 38 state columns plus ``t``."""
    port, base = live_server
    sid = await _create_session_and_load(base)

    metadata, binary_frames, _done = await _drive_streaming_run(
        port, sid, tf=0.5, h=1 / 120, vars_=["bus_v", "gen_state"]
    )
    meta = metadata["metadata"]
    assert meta["vars"] == ["bus_v", "gen_state"]

    var_cols = list(meta["var_columns"])
    bus_cols = [c for c in var_cols if c.startswith("Bus_")]
    v_cols = [c for c in bus_cols if c.endswith("_v")]
    a_cols = [c for c in bus_cols if c.endswith("_a")]
    delta_cols = [c for c in var_cols if c.startswith("Gen_") and c.endswith("_delta")]
    omega_cols = [c for c in var_cols if c.startswith("Gen_") and c.endswith("_omega")]
    assert len(v_cols) == 14
    assert len(a_cols) == 14
    assert len(delta_cols) == 5
    assert len(omega_cols) == 5
    # Layout is canonical: bus_v block then gen_state block.
    bus_end = var_cols.index(bus_cols[-1])
    gen_start = var_cols.index(delta_cols[0])
    assert gen_start == bus_end + 1

    reader = pyarrow.ipc.open_stream(io.BytesIO(binary_frames[0]))
    schema = reader.schema
    assert schema.names == ["t"] + var_cols
    batch = reader.read_next_batch()
    assert batch.num_columns == 1 + 28 + 10
    # All omega values at t=0 are 1.0 pu (synchronous reference); spot-check.
    for col in omega_cols:
        values = batch.column(col).to_pylist()
        for v in values:
            assert 0.5 < v < 1.5, f"omega {col}={v} out of physical range"


@pytest.mark.acceptance
async def test_streaming_vars_metadata_enumerates_all_columns(
    live_server: tuple[int, str],
) -> None:
    """The stream-start metadata enumerates every column for the chosen
    ``vars`` set — bus + gen + line — so the client picker tree can be
    populated without re-introspecting the topology."""
    port, base = live_server
    sid = await _create_session_and_load(base)

    metadata, _frames, _done = await _drive_streaming_run(
        port,
        sid,
        tf=0.5,
        h=1 / 120,
        vars_=["bus_v", "gen_state", "line_flow"],
    )
    meta = metadata["metadata"]
    assert meta["vars"] == ["bus_v", "gen_state", "line_flow"]
    var_cols = list(meta["var_columns"])
    n_buses = len(meta["bus_idx_values"])
    n_gens = len(meta["syngen_idx_values"])
    n_lines = len(meta["line_idx_values"])
    # IEEE 14 + dyr: 14 buses, 5 GENROU, 20 lines.
    assert n_buses == 14
    assert n_gens == 5
    assert n_lines == 20
    # bus_v contributes two columns per bus (v + a); gen_state two per gen
    # (delta + omega); line_flow two per line (P + Q).
    assert len(var_cols) == 2 * n_buses + 2 * n_gens + 2 * n_lines


@pytest.mark.acceptance
async def test_streaming_vars_empty_list_closes_with_error(
    live_server: tuple[int, str],
) -> None:
    """``vars=[]`` is rejected with a structured WS error (close 4500 +
    ``{type: "error", code, reason}`` text frame). The server never
    starts the run."""
    port, base = live_server
    sid = await _create_session_and_load(base)
    ws_url = f"ws://127.0.0.1:{port}/api/ws/{sid}"

    async with websockets.connect(ws_url) as ws:
        ready = json.loads(await ws.recv())
        assert ready["type"] == "ready"
        await ws.send(
            json.dumps(
                {"type": "start_tds", "tf": 1.0, "h": 1 / 120, "vars": []}
            )
        )
        try:
            while True:
                msg = await ws.recv()
                if isinstance(msg, str):
                    err = json.loads(msg)
                    if err.get("type") == "error":
                        assert err.get("code") == 4500
                        assert "vars" in err.get("reason", "").lower()
        except websockets.exceptions.ConnectionClosed as exc:
            assert exc.code == 4500, f"expected 4500, got {exc.code}"


@pytest.mark.acceptance
async def test_streaming_vars_unknown_group_closes_with_error(
    live_server: tuple[int, str],
) -> None:
    """An unknown variable-group name closes the WS with 4500 before any
    run starts."""
    port, base = live_server
    sid = await _create_session_and_load(base)
    ws_url = f"ws://127.0.0.1:{port}/api/ws/{sid}"

    async with websockets.connect(ws_url) as ws:
        json.loads(await ws.recv())
        await ws.send(
            json.dumps(
                {
                    "type": "start_tds",
                    "tf": 1.0,
                    "h": 1 / 120,
                    "vars": ["bus_v", "no_such_group"],
                }
            )
        )
        try:
            while True:
                msg = await ws.recv()
                if isinstance(msg, str):
                    err = json.loads(msg)
                    if err.get("type") == "error":
                        assert err.get("code") == 4500
                        assert "no_such_group" in err.get("reason", "")
        except websockets.exceptions.ConnectionClosed as exc:
            assert exc.code == 4500


@pytest.mark.acceptance
async def test_streaming_vars_works_with_decimation_mean(
    live_server: tuple[int, str],
) -> None:
    """Aggregation modes (``decimation="mean"``) work with the extended
    schema — the mean is computed across every column in the multi-
    column rows. Each frame contains exactly one row whose values are
    the per-column window mean."""
    port, base = live_server
    sid = await _create_session_and_load(base)

    metadata, binary_frames, done = await _drive_streaming_run(
        port,
        sid,
        tf=0.5,
        h=1 / 120,
        decimation="mean",
        max_rate_hz=10.0,
        vars_=["bus_v", "gen_state"],
    )
    meta = metadata["metadata"]
    assert meta["decimation"]["mode"] == "mean"
    assert meta["vars"] == ["bus_v", "gen_state"]

    # Every batch is one row × (1 t + 28 bus + 10 gen) columns.
    expected_cols = 1 + 2 * 14 + 2 * 5
    for frame in binary_frames:
        reader = pyarrow.ipc.open_stream(io.BytesIO(frame))
        batch = reader.read_next_batch()
        assert batch.num_rows == 1
        assert batch.num_columns == expected_cols

    assert done["final_t"] >= 0.49


@pytest.mark.acceptance
async def test_streaming_vars_gen_power_and_load_pq_groups(
    live_server: tuple[int, str],
) -> None:
    """The new ``gen_power`` + ``load_pq`` groups stream end-to-end. IEEE 14
    + dyr has 5 SynGen → 10 Gen power columns (Pe + Qe) and 11 PQ loads →
    22 Load columns (p + q). The metadata enumerates them in canonical
    order and the Arrow frames carry physically plausible MW / MVar
    values (electrical power is not all-zero on a loaded grid)."""
    port, base = live_server
    sid = await _create_session_and_load(base)

    metadata, binary_frames, done = await _drive_streaming_run(
        port, sid, tf=0.5, h=1 / 120, vars_=["gen_power", "load_pq"]
    )
    meta = metadata["metadata"]
    assert meta["vars"] == ["gen_power", "load_pq"]

    var_cols = list(meta["var_columns"])
    pe_cols = [c for c in var_cols if c.startswith("Gen_") and c.endswith("_Pe")]
    qe_cols = [c for c in var_cols if c.startswith("Gen_") and c.endswith("_Qe")]
    load_p_cols = [c for c in var_cols if c.startswith("Load_") and c.endswith("_p")]
    load_q_cols = [c for c in var_cols if c.startswith("Load_") and c.endswith("_q")]
    assert len(pe_cols) == 5
    assert len(qe_cols) == 5
    assert len(meta["pq_idx_values"]) == 11
    assert len(load_p_cols) == 11
    assert len(load_q_cols) == 11
    # Canonical order: gen_power block precedes load_pq block.
    assert var_cols.index(pe_cols[-1]) < var_cols.index(load_p_cols[0])

    reader = pyarrow.ipc.open_stream(io.BytesIO(binary_frames[0]))
    schema = reader.schema
    assert schema.names == ["t"] + var_cols
    batch = reader.read_next_batch()
    assert batch.num_columns == 1 + 10 + 22

    # Electrical power on a loaded grid is nonzero — at least one generator
    # carries > 1 MW of active power.
    pe_total = sum(abs(batch.column(c).to_pylist()[0]) for c in pe_cols)
    assert pe_total > 1.0, f"all Gen Pe ~0 MW; suspicious ({pe_total})"
    # PQ load consumption is nonzero too.
    load_total = sum(abs(batch.column(c).to_pylist()[0]) for c in load_p_cols)
    assert load_total > 1.0, f"all Load p ~0 MW; suspicious ({load_total})"

    assert done["final_t"] >= 0.49
