"""The four integrators through ``POST /sessions/{id}/tds`` and the WebSocket's
``start_tds`` frame.

Both are driven for real (route, session manager, worker, ANDES) on the bundled
IEEE 14 case with a fault on bus 4 from 0.5 s to 0.6 s. What each integrator
does to a trajectory is in ``test_tds_integrators.py``; these tests hold the two
ways in to one behaviour: the same values are taken and refused, the same run
comes out, and the result says which integrator ran.

Markers: ``integration``.
"""

from __future__ import annotations

import json
import shutil
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from tensa.api.app import make_app
from tensa.core.stream import decode_batch
from tests._ws import websocket_session

pytestmark = pytest.mark.integration

WS_CLOSE_WORKER_ERROR = 4500
TF = 1.5
OMEGA = "omega GENROU 1"
AUTO = {"rtol": 1e-3, "atol": 1e-6, "max_step": 0.05}


def _ieee14_dir() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases" / "ieee14"


@pytest.fixture(scope="module")
def client(tmp_path_factory: pytest.TempPathFactory) -> Iterator[TestClient]:
    workspace = tmp_path_factory.mktemp("integrators") / "ws"
    workspace.mkdir(mode=0o700)
    for name in ("ieee14.raw", "ieee14.dyr"):
        shutil.copy2(_ieee14_dir() / name, workspace / name)
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=2,
        idle_timeout_seconds=180.0,
        extra_allowed_hosts=frozenset({"testserver"}),
        extra_allowed_origins=frozenset({"http://testserver", "http://localhost"}),
    )
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def sid(client: TestClient) -> Iterator[str]:
    """A session with IEEE 14 and the fault, closed after the test."""
    created = client.post("/api/sessions")
    assert created.status_code == 201, created.text
    session = str(created.json()["session_id"])
    try:
        loaded = client.post(
            f"/api/sessions/{session}/case",
            json={"primary_path": "ieee14.raw", "addfiles": ["ieee14.dyr"]},
        )
        assert loaded.status_code in (200, 201), loaded.text
        added = client.post(
            f"/api/sessions/{session}/disturbances",
            json={"disturbances": [{"kind": "fault", "bus_idx": 4, "tf": 0.5, "tc": 0.6}]},
        )
        assert added.status_code == 200, added.text
        yield session
    finally:
        client.delete(f"/api/sessions/{session}")


def _batch(client: TestClient, sid: str, **body: Any) -> dict[str, Any]:
    resp = client.post(
        f"/api/sessions/{sid}/tds", json={"tf": TF, "dae_vars": [OMEGA], **body}
    )
    assert resp.status_code == 200, resp.text
    result: dict[str, Any] = resp.json()
    return result


def _streamed(client: TestClient, sid: str, **start: Any) -> tuple[dict[str, Any], dict[str, Any], np.ndarray, np.ndarray]:
    """Run ``start_tds`` and return its ``stream_start`` metadata, its ``done``
    frame, and the streamed times and speeds."""
    metadata: dict[str, Any] = {}
    times, values = [], []
    with websocket_session(client, f"/api/ws/{sid}") as ws:
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_text(
            json.dumps({"type": "start_tds", "tf": TF, "vars": [], "dae_vars": [OMEGA], **start})
        )
        while True:
            message = ws.receive()
            if message.get("bytes") is not None:
                t, v = decode_batch(message["bytes"])
                times.append(t)
                values.append(v)
                continue
            frame: dict[str, Any] = json.loads(message["text"])
            if frame["type"] == "stream_start":
                metadata = frame["metadata"]
            elif frame["type"] in ("done", "error"):
                break
    assert frame["type"] == "done", frame
    speed = np.concatenate(values)[:, list(metadata["var_columns"]).index(OMEGA)]
    return metadata, frame, np.concatenate(times), speed


def _refused_ws(client: TestClient, sid: str, **start: Any) -> dict[str, Any]:
    with websocket_session(client, f"/api/ws/{sid}") as ws:
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_text(json.dumps({"type": "start_tds", "tf": TF, **start}))
        frame: dict[str, Any] = json.loads(ws.receive_text())
        assert frame["type"] == "error", frame
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_text()
        assert closed.value.code == WS_CLOSE_WORKER_ERROR
    return frame


# ---- the batch route ------------------------------------------------------------------


def test_a_request_that_names_no_integrator_reports_the_trapezoidal_method(
    client: TestClient, sid: str
) -> None:
    result = _batch(client, sid, h=0.01)
    assert result["integrator"] == "trapezoidal"
    assert result["converged"] is True
    steps = np.diff(result["traces"]["t"])
    assert steps.max() <= 0.01 + 1e-12


def test_the_adaptive_method_runs_with_its_tolerances_and_bound(
    client: TestClient, sid: str
) -> None:
    result = _batch(client, sid, integrator="trap_adapt", tds_config_overrides=AUTO)
    assert result["converged"] is True
    assert result["final_t"] == TF
    assert result["integrator"] == "trap_adapt"
    steps = np.diff(result["traces"]["t"])
    assert steps.max() <= AUTO["max_step"] + 1e-12
    assert steps.max() > 0.02  # longer than any fixed step a run here takes


def test_backward_euler_runs_at_h_and_is_another_method(client: TestClient, sid: str) -> None:
    euler = _batch(client, sid, integrator="backeuler", h=0.01)
    assert euler["integrator"] == "backeuler"
    assert euler["converged"] is True
    assert np.diff(euler["traces"]["t"]).max() <= 0.01 + 1e-12

    # The same request with the trapezoidal method, on the same case from zero.
    assert client.post(f"/api/sessions/{sid}/reload").status_code == 200
    added = client.post(
        f"/api/sessions/{sid}/disturbances",
        json={"disturbances": [{"kind": "fault", "bus_idx": 4, "tf": 0.5, "tc": 0.6}]},
    )
    assert added.status_code == 200, added.text
    trap = _batch(client, sid, h=0.01)
    a = np.array(euler["traces"]["variables"][0]["values"])
    b = np.interp(euler["traces"]["t"], trap["traces"]["t"], trap["traces"]["variables"][0]["values"])
    assert np.max(np.abs(a - b)) > 1e-5


def test_qndf_after_an_adaptive_trapezoidal_run_asks_for_a_reload(
    client: TestClient, sid: str
) -> None:
    first = client.post(
        f"/api/sessions/{sid}/tds", json={"tf": 0.3, "integrator": "trap_adapt"}
    )
    assert first.status_code == 200, first.text
    refused = client.post(f"/api/sessions/{sid}/tds", json={"tf": 0.6, "integrator": "qndf"})
    assert refused.status_code == 422, refused.text
    detail = refused.json()["detail"]
    assert "QNDF cannot replace the trap_adapt integrator" in detail
    assert detail.lower().count("reload") == 1
    # The other two carry on from there.
    for integrator in ("backeuler", "trapezoidal"):
        carried = client.post(
            f"/api/sessions/{sid}/tds", json={"tf": 0.6, "h": 0.01, "integrator": integrator}
        )
        assert carried.status_code == 200, carried.text
        assert carried.json()["integrator"] == integrator


@pytest.mark.parametrize("bad", ["rk4", "trapezoid", "TRAP_ADAPT", None])
def test_an_unknown_integrator_is_refused_by_both_ways_in(
    client: TestClient, sid: str, bad: object
) -> None:
    rest = client.post(f"/api/sessions/{sid}/tds", json={"tf": TF, "integrator": bad})
    assert rest.status_code == 422, rest.text
    frame = _refused_ws(client, sid, integrator=bad)
    # The route refuses it before the worker is asked, as it does a bad ``h``.
    assert frame["reason"].startswith("unknown integrator")
    for name in ("trapezoidal", "trap_adapt", "backeuler", "qndf"):
        assert name in frame["reason"]


@pytest.mark.parametrize("key", ["min_step", "dtmin_adapt"])
def test_a_negative_step_floor_is_refused_by_both_ways_in(
    client: TestClient, sid: str, key: str
) -> None:
    body = {"integrator": "trap_adapt", "tds_config_overrides": {key: -0.001}}
    rest = client.post(f"/api/sessions/{sid}/tds", json={"tf": TF, **body})
    assert rest.status_code == 422, rest.text
    assert f"'{key}' must be 0" in rest.json()["detail"]
    frame = _refused_ws(client, sid, **body)
    assert f"'{key}' must be 0" in frame["reason"]


# ---- the stream ---------------------------------------------------------------------


@pytest.mark.parametrize(
    ("start", "fixed_step"),
    [
        ({"integrator": "trap_adapt", "tds_config_overrides": AUTO}, False),
        ({"integrator": "backeuler", "h": 0.01}, True),
    ],
)
def test_a_stream_runs_the_integrator_a_batch_run_does(
    client: TestClient, sid: str, start: dict[str, Any], fixed_step: bool
) -> None:
    """The stream says whether the run steps at a fixed size, and its rows are
    the rows of the same request made as a batch run."""
    metadata, done, t, speed = _streamed(client, sid, **start)
    assert done["converged"] is True
    assert done["final_t"] == TF
    assert metadata["decimation"]["fixed_step"] is fixed_step

    assert client.post(f"/api/sessions/{sid}/reload").status_code == 200
    added = client.post(
        f"/api/sessions/{sid}/disturbances",
        json={"disturbances": [{"kind": "fault", "bus_idx": 4, "tf": 0.5, "tc": 0.6}]},
    )
    assert added.status_code == 200, added.text
    batch = _batch(client, sid, **start)
    assert t.tolist() == batch["traces"]["t"]
    assert speed.tolist() == pytest.approx(batch["traces"]["variables"][0]["values"], abs=1e-12)
