"""Controllers on a TDS run over HTTP and the WebSocket, on real ANDES.

Drives the app with a real ``SessionManager`` and worker subprocesses: what the
catalogue lists, what a batch run returns and says in the session's messages,
what a streamed run's ``done`` frame carries, and that a run whose controllers
cannot be used is refused before anything is set up. The control laws and their
timing are checked against ANDES's own arrays in ``test_tds_controllers.py``.

Markers: ``integration``.
"""

from __future__ import annotations

import json
import shutil
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from tensa.api.app import make_app
from tensa.core.session import SessionManager

pytestmark = pytest.mark.integration

ESD1_CASE = "ieee14_esd1.xlsx"  # IEEE 14 with ten 1 MVA batteries on bus 4
WS_CLOSE_WORKER_ERROR = 4500

DROOP = {"type": "droop", "model": "ESD1", "idx": 1, "gain": 2.0, "deadband": 0.02}
TRIP = {"kind": "toggle", "model": "GENROU", "dev_idx": "GENROU_2", "t": 0.5}


def _cases() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases"


def _workspace(tmp_path: Path) -> Path:
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    for case in ("ieee14/ieee14_esd1.xlsx", "ieee14/ieee14.raw", "kundur/kundur_full.xlsx"):
        shutil.copy2(_cases() / case, workspace / Path(case).name)
    return workspace


@pytest.fixture
async def client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    workspace = _workspace(tmp_path)
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=3,
        idle_timeout_seconds=180.0,
    )
    mgr = SessionManager(max_sessions=3, idle_timeout=180.0, workspace=str(workspace))
    await mgr.start()
    app.state.session_manager = mgr
    app.state.workspace = workspace
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8000"
        ) as ac:
            yield ac
    finally:
        await mgr.shutdown()


async def _session(ac: httpx.AsyncClient, case: str | None = ESD1_CASE) -> str:
    created = await ac.post("/api/sessions")
    assert created.status_code == 201, created.text
    sid = str(created.json()["session_id"])
    if case is not None:
        loaded = await ac.post(f"/api/sessions/{sid}/case", json={"primary_path": case})
        assert loaded.status_code == 200, loaded.text
    return sid


async def _trip(ac: httpx.AsyncClient, sid: str) -> None:
    added = await ac.post(f"/api/sessions/{sid}/disturbances", json={"disturbances": [TRIP]})
    assert added.status_code == 200, added.text


async def _state(ac: httpx.AsyncClient, sid: str) -> str:
    topology = await ac.get(f"/api/sessions/{sid}/topology")
    assert topology.status_code == 200, topology.text
    return str(topology.json()["state"])


# ---- the catalogue -------------------------------------------------------------


async def test_the_catalogue_lists_the_batteries_and_variables_a_run_can_record(
    client: httpx.AsyncClient,
) -> None:
    sid = await _session(client)
    listed = await client.get(f"/api/sessions/{sid}/tds/controllers")
    assert listed.status_code == 200, listed.text
    catalogue = listed.json()
    assert catalogue["types"] == ["droop", "ffr"]
    assert (catalogue["coi_available"], catalogue["freq_hz"], catalogue["base_mva"]) == (
        True, 60.0, 100.0,
    )
    targets = catalogue["targets"]
    assert [(t["model"], t["idx"]) for t in targets] == [("ESD1", i) for i in range(1, 11)]
    first = targets[0]
    assert (first["name"], first["bus"], first["in_service"], first["fn"]) == (
        "ESD1_1", 4, True, 60.0,
    )
    assert first["variables"] == {
        "command": "Pext ESD1 1",
        "frequency": "fHz ESD1 1",
        "active_current": "Ipout_y ESD1 1",
        "soc": "pIG_y ESD1 1",
    }
    # Asking did not set the case up.
    assert await _state(client, sid) == "pre-setup"

    # The names are ones a run records.
    names = list(first["variables"].values())
    run = await client.post(f"/api/sessions/{sid}/tds", json={"tf": 0.2, "dae_vars": names})
    assert run.status_code == 200, run.text
    assert [v["name"] for v in run.json()["traces"]["variables"]] == names

    # A 1 MVA battery whose power limit the case leaves at ANDES's 9999: what it
    # can deliver is its current limit, 1.1 pu of its rating. It reads the same
    # megawatts once setup() has moved the limits to the system base.
    assert first["p_limit"] == pytest.approx(1.1)
    again = await client.get(f"/api/sessions/{sid}/tds/controllers")
    assert again.json()["targets"][0]["p_limit"] == pytest.approx(1.1)


async def test_the_catalogue_of_a_case_without_such_devices_is_empty(
    client: httpx.AsyncClient,
) -> None:
    sid = await _session(client, "kundur_full.xlsx")
    catalogue = (await client.get(f"/api/sessions/{sid}/tds/controllers")).json()
    assert catalogue["targets"] == []
    assert catalogue["coi_available"] is True

    empty = await _session(client, None)
    listed = await client.get(f"/api/sessions/{empty}/tds/controllers")
    assert listed.status_code == 200, listed.text
    assert listed.json() == {
        "types": ["droop", "ffr"],
        "coi_available": False,
        "freq_hz": None,
        "base_mva": None,
        "targets": [],
    }

    missing = await client.get("/api/sessions/nope/tds/controllers")
    assert missing.status_code == 404


# ---- a batch run ---------------------------------------------------------------


async def test_a_batch_run_returns_what_each_controller_did(client: httpx.AsyncClient) -> None:
    sid = await _session(client)
    await _trip(client, sid)
    ffr = {
        "type": "ffr", "model": "ESD1", "idx": "2",
        "power": 0.5, "trigger_deviation": 0.05, "hold": 0.5, "frequency": "bus",
    }
    run = await client.post(
        f"/api/sessions/{sid}/tds",
        json={
            # Short of a multiple of the sample period, so the count of samples
            # does not hang on whether the last step lands a rounding error early.
            "tf": 2.95,
            "dae_vars": ["Pext ESD1 1", "Pext ESD1 2"],
            "controllers": [DROOP, ffr],
            "tds_config_overrides": {"criteria": 0},
        },
    )
    assert run.status_code == 200, run.text
    body = run.json()
    assert body["converged"] is True
    droop, fast = body["controllers"]

    assert (droop["type"], droop["model"], droop["idx"]) == ("droop", "ESD1", 1)
    assert droop["samples"] == 30
    assert droop["first_action_t"] > 0.5
    assert droop["released_t"] is None
    trace = droop["trace"]
    assert {len(trace[k]) for k in ("t", "frequency", "command", "output", "soc")} == {30}
    assert trace["truncated"] is False
    assert trace["frequency"][0] == pytest.approx(60.0)
    assert min(trace["frequency"]) < 59.9
    assert droop["peak_command"] == pytest.approx(max(trace["command"]))
    assert droop["final_command"] == pytest.approx(trace["command"][-1])

    # Named as text, reported as the case holds it.
    assert (fast["type"], fast["idx"]) == ("ffr", 2)
    # Held for five sample periods (the case's own events move the solved
    # instants a step off the multiples of the period, hence the tolerance).
    assert fast["trace"]["command"].count(0.5) == 5
    assert fast["released_t"] - fast["first_action_t"] == pytest.approx(0.5, abs=0.034)
    assert (fast["peak_command"], fast["final_command"]) == (0.5, 0.0)

    # The batteries' own variable shows the commands they were given, per unit.
    recorded = {v["name"]: v["values"] for v in body["traces"]["variables"]}
    assert max(recorded["Pext ESD1 1"]) * 100.0 == pytest.approx(droop["peak_command"])
    assert max(recorded["Pext ESD1 2"]) * 100.0 == pytest.approx(0.5)
    assert recorded["Pext ESD1 2"][-1] == 0.0

    # And the session's messages say it in words.
    messages = (await client.get(f"/api/sessions/{sid}/messages?level=info")).json()["messages"]
    said = [m["text"] for m in messages if m["source"] == "run_tds"]
    assert any(text.startswith("Droop on ESD1 1 acted from t = ") for text in said), said
    assert any(
        text.startswith("Fast frequency response on ESD1 2 triggered at t = ") for text in said
    ), said


async def test_a_run_without_controllers_reports_none(client: httpx.AsyncClient) -> None:
    sid = await _session(client)
    run = await client.post(f"/api/sessions/{sid}/tds", json={"tf": 0.2})
    assert run.status_code == 200, run.text
    assert run.json()["controllers"] is None
    empty = await client.post(f"/api/sessions/{sid}/reload")
    assert empty.status_code == 200, empty.text
    run = await client.post(f"/api/sessions/{sid}/tds", json={"tf": 0.2, "controllers": []})
    assert run.status_code == 200, run.text
    assert run.json()["controllers"] is None


# ---- refusals ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("controller", "message"),
    [
        ({**DROOP, "gain": 0}, "gain"),
        ({**DROOP, "script": "print(1)"}, "script"),
        ({"type": "pid", "model": "ESD1", "idx": 1}, "pid"),
        (
            {"type": "ffr", "model": "ESD1", "idx": 1, "power": 1.0},
            "give trigger_deviation, trigger_rocof or both",
        ),
    ],
)
async def test_a_body_that_breaks_a_rule_is_a_422(
    client: httpx.AsyncClient, controller: dict[str, Any], message: str
) -> None:
    sid = await _session(client)
    run = await client.post(
        f"/api/sessions/{sid}/tds", json={"tf": 0.2, "controllers": [controller]}
    )
    assert run.status_code == 422, run.text
    assert message in run.text


@pytest.mark.parametrize(
    ("controller", "detail"),
    [
        ({**DROOP, "idx": 99}, "controllers[0]: the loaded case has no ESD1 with idx 99"),
        (
            {**DROOP, "model": "GENROU", "idx": "GENROU_1"},
            "controllers[0]: 'GENROU' is not a model a controller can command",
        ),
    ],
)
async def test_a_controller_the_case_cannot_bind_is_refused_before_setup(
    client: httpx.AsyncClient, controller: dict[str, Any], detail: str
) -> None:
    sid = await _session(client)
    run = await client.post(
        f"/api/sessions/{sid}/tds", json={"tf": 0.2, "controllers": [controller]}
    )
    assert run.status_code == 422, run.text
    problem = run.json()
    assert problem["detail"].startswith(detail)
    # Nothing was written, so there is nothing to reload.
    assert "reload" not in problem["detail"].lower()
    assert problem["recovery"] is None
    # The case is still open: a disturbance can be added and the run then goes.
    assert await _state(client, sid) == "pre-setup"
    await _trip(client, sid)
    run = await client.post(f"/api/sessions/{sid}/tds", json={"tf": 0.2, "controllers": [DROOP]})
    assert run.status_code == 200, run.text


async def test_an_alter_on_the_same_input_is_refused(client: httpx.AsyncClient) -> None:
    sid = await _session(client)
    alter = {
        "kind": "alter", "model": "ESD1", "dev_idx": 1,
        "src": "Pext0", "t": 0.1, "method": "+", "amount": 0.001,
    }
    added = await client.post(f"/api/sessions/{sid}/disturbances", json={"disturbances": [alter]})
    assert added.status_code == 200, added.text
    run = await client.post(f"/api/sessions/{sid}/tds", json={"tf": 0.2, "controllers": [DROOP]})
    assert run.status_code == 422, run.text
    assert "an Alter event of the case writes Pext0 of ESD1 1" in run.json()["detail"]
    # Another battery is free.
    run = await client.post(
        f"/api/sessions/{sid}/tds", json={"tf": 0.2, "controllers": [{**DROOP, "idx": 2}]}
    )
    assert run.status_code == 200, run.text


async def test_a_case_without_machines_has_only_the_bus_frequency(
    client: httpx.AsyncClient,
) -> None:
    """IEEE 14 as a power-flow case, with a battery and no synchronous machine."""
    sid = await _session(client, "ieee14.raw")
    pf_sid = await _session(client, "ieee14.raw")
    pf = await client.post(f"/api/sessions/{pf_sid}/pflow", json={})
    v0 = float(pf.json()["bus_voltages"]["4"])
    await client.delete(f"/api/sessions/{pf_sid}")
    for model, params in (
        ("PV", {"idx": "PV_B", "name": "PV_B", "bus": 4, "Sn": 100, "Vn": 138, "p0": 0.0, "v0": v0}),
        (
            "ESD1",
            {"idx": "ESD1_1", "name": "ESD1_1", "bus": 4, "gen": "PV_B", "pqflag": 1, "pmx": 0.2,
             "En": 10.0},
        ),
    ):
        added = await client.post(
            f"/api/sessions/{sid}/elements", json={"model": model, "params": params}
        )
        assert added.status_code == 201, added.text

    catalogue = (await client.get(f"/api/sessions/{sid}/tds/controllers")).json()
    assert catalogue["coi_available"] is False
    assert [t["idx"] for t in catalogue["targets"]] == ["ESD1_1"]
    assert catalogue["targets"][0]["p_limit"] == pytest.approx(20.0)

    droop = {"type": "droop", "model": "ESD1", "idx": "ESD1_1", "gain": 10.0}
    refused = await client.post(
        f"/api/sessions/{sid}/tds", json={"tf": 0.45, "controllers": [droop]}
    )
    assert refused.status_code == 422, refused.text
    assert 'use frequency "bus"' in refused.json()["detail"]

    run = await client.post(
        f"/api/sessions/{sid}/tds",
        json={"tf": 0.45, "controllers": [{**droop, "frequency": "bus"}]},
    )
    assert run.status_code == 200, run.text
    (controller,) = run.json()["controllers"]
    assert controller["samples"] == 5
    assert controller["trace"]["frequency"] == pytest.approx([60.0] * 5, abs=1e-6)


# ---- the WebSocket -------------------------------------------------------------


@pytest.fixture
def live(tmp_path: Path) -> Iterator[tuple[TestClient, str]]:
    """A client on a running app, and a session with the battery case loaded
    and a generator set to trip."""
    app = make_app(
        workspace=_workspace(tmp_path),
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=2,
        idle_timeout_seconds=180.0,
        extra_allowed_hosts=frozenset({"testserver"}),
        extra_allowed_origins=frozenset({"http://testserver", "http://localhost"}),
    )
    with TestClient(app) as test_client:
        created = test_client.post("/api/sessions")
        assert created.status_code == 201, created.text
        sid = str(created.json()["session_id"])
        loaded = test_client.post(f"/api/sessions/{sid}/case", json={"primary_path": ESD1_CASE})
        assert loaded.status_code == 200, loaded.text
        added = test_client.post(
            f"/api/sessions/{sid}/disturbances", json={"disturbances": [TRIP]}
        )
        assert added.status_code == 200, added.text
        yield test_client, sid


def test_a_streamed_run_says_what_its_controllers_did_in_the_done_frame(
    live: tuple[TestClient, str],
) -> None:
    test_client, sid = live
    start = {
        "type": "start_tds",
        "tf": 1.95,
        "vars": ["gen_state"],
        "dae_vars": ["Pext ESD1 1"],
        "controllers": [DROOP],
        "tds_config_overrides": {"criteria": 0},
    }
    frames = 0
    with test_client.websocket_connect(f"/api/ws/{sid}") as ws:
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_text(json.dumps(start))
        started = json.loads(ws.receive_text())
        assert started["type"] == "stream_start", started
        assert started["metadata"]["var_columns"][-1] == "Pext ESD1 1"
        while True:
            message = ws.receive()
            if message.get("bytes") is not None:
                frames += 1
                continue
            done = json.loads(message["text"])
            break
    assert frames > 0
    assert done["type"] == "done", done
    assert done["converged"] is True
    (controller,) = done["controllers"]
    assert (controller["type"], controller["model"], controller["idx"]) == ("droop", "ESD1", 1)
    assert controller["samples"] == 20
    assert controller["first_action_t"] > 0.5
    assert controller["peak_command"] > 0.1
    # The samples are not in the frame: the stream carries the battery's variables.
    assert "trace" not in controller


def test_a_streamed_run_without_controllers_has_no_such_key(live: tuple[TestClient, str]) -> None:
    test_client, sid = live
    with test_client.websocket_connect(f"/api/ws/{sid}") as ws:
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_text(json.dumps({"type": "start_tds", "tf": 0.2}))
        while True:
            message = ws.receive()
            if message.get("text") is not None:
                frame = json.loads(message["text"])
                if frame["type"] == "done":
                    break
    assert "controllers" not in frame


def _refused(test_client: TestClient, sid: str, controllers: Any) -> dict[str, Any]:
    """Send ``start_tds`` with ``controllers`` and return the error frame, which
    is the first thing sent: a refused run starts no stream."""
    with test_client.websocket_connect(f"/api/ws/{sid}") as ws:
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_text(json.dumps({"type": "start_tds", "tf": 0.3, "controllers": controllers}))
        frame: dict[str, Any] = json.loads(ws.receive_text())
        assert frame["type"] == "error", frame
        assert frame["code"] == WS_CLOSE_WORKER_ERROR
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_text()
        assert closed.value.code == WS_CLOSE_WORKER_ERROR
    return frame


@pytest.mark.parametrize(
    ("controllers", "reason"),
    [
        ({"type": "droop"}, "'controllers' must be a list of controller objects"),
        ([{**DROOP, "gain": -1}], "controllers[0].gain: Input should be greater than 0"),
        ([{**DROOP, "eval": "x"}], "controllers[0].eval: Extra inputs are not permitted"),
        ([DROOP, {**DROOP, "idx": 99}], "controllers[1]: the loaded case has no ESD1 with idx 99"),
        # A kind the server does not have, of any length: named by its place, not repeated.
        ([{**DROOP, "type": "pid" * 400}], "controllers[0].type: must be 'droop' or 'ffr'"),
    ],
)
def test_a_streamed_run_with_controllers_that_cannot_be_used_starts_no_stream(
    live: tuple[TestClient, str], controllers: Any, reason: str
) -> None:
    test_client, sid = live
    frame = _refused(test_client, sid, controllers)
    assert reason in frame["reason"]
    assert len(frame["reason"]) < 200
    assert "reload" not in frame["reason"].lower()
    # Nothing was set up or written: the same session still runs.
    ok = test_client.post(f"/api/sessions/{sid}/tds", json={"tf": 0.2, "controllers": [DROOP]})
    assert ok.status_code == 200, ok.text
