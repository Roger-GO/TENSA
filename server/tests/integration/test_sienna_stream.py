"""A Sienna streamed run over the WebSocket, against the real Julia runtime.

A 2 s Kundur run through ``start_tds`` on a Sienna session: the stream's
columns are the neutral names, its rows are the batch run's (the same times
and the same values), and an abort part way ends the stream with
``converged`` false and is spent by that run.

Markers: ``sienna`` and ``integration``; skipped where the Sienna engine is
not available.
"""

from __future__ import annotations

import json
import shutil
from collections.abc import Iterator
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient

from tensa.api.app import make_app
from tensa.core.examples import _andes_cases_dir
from tensa.core.stream import decode_batch
from tensa.engines.sienna.environment import sienna_unavailable_reason
from tests._ws import websocket_session

_REASON = sienna_unavailable_reason()

pytestmark = [
    pytest.mark.integration,
    pytest.mark.sienna,
    pytest.mark.skipif(_REASON is not None, reason=f"the Sienna engine is not available: {_REASON}"),
]


@pytest.fixture(scope="module")
def live(tmp_path_factory: pytest.TempPathFactory) -> Iterator[tuple[TestClient, str]]:
    """One app and one Sienna session with Kundur and its .dyr loaded and the
    power flow solved, shared by the tests (Julia starts once). The test
    client opens a WebSocket on ``testserver`` whatever its base URL, so that
    host and its origin are let in, as the other WebSocket tests do."""
    cases = _andes_cases_dir()
    assert cases is not None
    workspace = tmp_path_factory.mktemp("sienna-stream") / "ws"
    workspace.mkdir(mode=0o700)
    shutil.copy2(cases / "kundur" / "kundur.raw", workspace / "kundur.raw")
    shutil.copy2(cases / "kundur" / "kundur_full.dyr", workspace / "kundur_full.dyr")
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        extra_allowed_hosts=frozenset({"testserver"}),
        extra_allowed_origins=frozenset({"http://testserver", "http://localhost"}),
    )
    with TestClient(app) as client:
        created = client.post("/api/sessions", json={"engine": "sienna"})
        assert created.status_code == 201, created.text
        sid = str(created.json()["session_id"])
        loaded = client.post(
            f"/api/sessions/{sid}/case",
            json={
                "primary_path": "kundur.raw",
                "addfiles": ["kundur_full.dyr"],
                "on_unsupported": "drop",
            },
        )
        assert loaded.status_code == 200, loaded.text
        solved = client.post(f"/api/sessions/{sid}/pflow", json={})
        assert solved.status_code == 200 and solved.json()["converged"] is True, solved.text
        yield client, sid


def _stream(ws: Any) -> tuple[dict[str, Any], list[float], list[list[float]], dict[str, Any]]:
    """Read one run off the socket: its stream_start, its rows and its done."""
    start = json.loads(ws.receive_text())
    assert start["type"] == "stream_start", start
    times: list[float] = []
    rows: list[list[float]] = []
    while True:
        message = ws.receive()
        if message.get("text") is not None:
            done = json.loads(message["text"])
            assert done["type"] == "done", done
            return start, times, rows, done
        t, values = decode_batch(message["bytes"])
        times.extend(float(v) for v in t)
        rows.extend(values.tolist())


def test_kundur_streams_the_batch_runs_rows_under_neutral_names(
    live: tuple[TestClient, str],
) -> None:
    client, sid = live
    batch = client.post(f"/api/sessions/{sid}/tds", json={"tf": 2.0})
    assert batch.status_code == 200, batch.text
    traces = batch.json()["traces"]

    with websocket_session(client, f"/api/ws/{sid}") as ws:
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_text(json.dumps({"type": "start_tds", "tf": 2.0}))
        start, times, rows, done = _stream(ws)

    metadata = start["metadata"]
    names = metadata["var_columns"]
    assert names
    for name in names:
        quantity, separator, key = name.partition("|")
        assert separator and quantity and key.split(":")[0] in ("bus", "gen"), name
    assert metadata["vars"] == []
    assert metadata["dae_vars"] == []
    assert metadata["load_model"] == "impedance"
    assert done["converged"] is True
    assert done["final_t"] == pytest.approx(2.0)

    # The same run as the batch one: the same times, and each streamed column
    # the batch series of that name.
    assert times[0] == 0.0
    assert times == pytest.approx(traces["t"], abs=1e-12)
    by_name = {v["name"]: v["values"] for v in traces["variables"]}
    streamed = np.asarray(rows, dtype=float)
    for index, name in enumerate(names):
        assert name in by_name, name
        expected = np.asarray([np.nan if v is None else v for v in by_name[name]], dtype=float)
        np.testing.assert_allclose(streamed[:, index], expected, rtol=0, atol=1e-9)

    # Undisturbed, the machines stay at synchronous speed.
    speeds = [i for i, n in enumerate(names) if n.startswith("rotor_speed|")]
    assert speeds
    assert np.max(np.abs(streamed[:, speeds] - 1.0)) <= 1e-6


def test_kundur_stream_abort_part_way(live: tuple[TestClient, str]) -> None:
    client, sid = live
    with websocket_session(client, f"/api/ws/{sid}") as ws:
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_text(json.dumps({"type": "start_tds", "tf": 3600.0}))
        start = json.loads(ws.receive_text())
        assert start["type"] == "stream_start"
        for _ in range(3):
            ws.receive_bytes()
        assert client.post(f"/api/sessions/{sid}/abort").status_code == 200
        while True:
            message = ws.receive()
            if message.get("text") is not None:
                done = json.loads(message["text"])
                break
    assert done["type"] == "done", done
    assert done["converged"] is False
    assert 0.0 < done["final_t"] < 3600.0

    # The abort was spent by the run it stopped: the next one completes.
    after = client.post(f"/api/sessions/{sid}/tds", json={"tf": 0.1})
    assert after.status_code == 200, after.text
    assert after.json()["converged"] is True
