"""Any ANDES variable can be recorded: the catalogue, the stream and the batch run.

Checked against ANDES's bundled cases, because what matters is that the
catalogue's names are the ones ANDES writes into ``dae.x_name`` /
``dae.y_name`` and that each name's column holds that variable's value at every
step, with a fault in the run so the values move.

Markers: ``integration``.
"""

from __future__ import annotations

import json
import shutil
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from tensa.api.app import make_app
from tensa.core import worker
from tensa.core.dae_vars import dae_variables
from tensa.core.stream import StreamCollector, decode_batch
from tensa.core.wrapper import Wrapper
from tests._ws import websocket_session

pytestmark = pytest.mark.integration


def _cases() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases"


def _load(case: str, *, fault_bus: int | None = None, setup: bool = True) -> Any:
    import andes

    ss = andes.load(str(_cases() / case), setup=False, no_output=True)
    if fault_bus is not None:
        ss.add("Fault", {"bus": fault_bus, "tf": 0.3, "tc": 0.4, "xf": 1e-4, "rf": 0})
    if setup:
        ss.setup()
    return ss


# ---- the catalogue is ANDES's own list ---------------------------------------------


def _names_after_init(ss: Any) -> tuple[set[str], set[str]]:
    ss.PFlow.run()
    ss.TDS.config.tf = 0.1
    ss.TDS.init()
    # A partly replaced case leaves one unnamed slot in dae.y for the devices
    # that kept an equation; it is not a variable.
    return set(ss.dae.x_name) - {""}, set(ss.dae.y_name) - {""}


@pytest.mark.parametrize(
    "case",
    ["ieee14/ieee14_full.xlsx", "kundur/kundur_full.xlsx", "wscc9/wscc9.xlsx"],
)
def test_the_catalogue_is_what_andes_names_after_the_run_is_set_up(case: str) -> None:
    ss = _load(case)
    catalogue = dae_variables(ss)

    x_names, y_names = _names_after_init(ss)

    assert {v.name for v in catalogue if v.kind == "x"} == x_names
    assert {v.name for v in catalogue if v.kind == "y"} == y_names
    assert len({v.name for v in catalogue}) == len(catalogue)


def test_a_static_generator_without_a_dynamic_replacement_keeps_its_variables() -> None:
    """Only a device an online dynamic one replaces loses its algebraic
    variables: take one machine out of service and its PV keeps ``q``."""
    import andes

    cases = _cases() / "ieee14"
    ss = andes.load(
        str(cases / "ieee14.raw"), addfile=str(cases / "ieee14.dyr"), setup=False, no_output=True
    )
    ss.GENROU.u.v[2] = 0
    ss.setup()
    catalogue = dae_variables(ss)
    assert "q PV 3" in {v.name for v in catalogue}
    assert "q PV 2" not in {v.name for v in catalogue}

    x_names, y_names = _names_after_init(ss)

    assert {v.name for v in catalogue if v.kind == "y"} == y_names
    assert {v.name for v in catalogue if v.kind == "x"} == x_names


def test_the_catalogue_needs_no_setup_and_does_not_commit_one() -> None:
    ss = _load("ieee14/ieee14_full.xlsx", setup=False)

    catalogue = dae_variables(ss)

    assert not ss.is_setup
    assert "omega GENROU 1" in {v.name for v in catalogue}


# ---- each column holds its variable's value ----------------------------------------


@pytest.mark.parametrize("case", ["ieee14/ieee14_full.xlsx", "kundur/kundur_full.xlsx"])
def test_every_variable_reads_what_the_model_holds_at_every_step(case: str) -> None:
    ss = _load(case, fault_bus=ss_bus(case))
    catalogue = dae_variables(ss)
    collector = StreamCollector(ss, [], [v.name for v in catalogue])
    ss.PFlow.run()
    ss.TDS.config.tf = 0.6
    ss.TDS.config.tstep = 0.02
    steps = 0
    worst = 0.0

    def check(t: float, system: Any) -> None:
        nonlocal steps, worst
        row = collector.collect()
        assert not np.isnan(row).any(), [v.name for v, x in zip(catalogue, row, strict=True) if np.isnan(x)]
        for value, variable in zip(row, catalogue, strict=True):
            model = getattr(system, variable.model)
            holder = model.states if variable.kind == "x" else model.algebs
            held = float(np.asarray(holder[variable.var].v)[model.idx2uid(variable.idx)])
            worst = max(worst, abs(value - held))
        steps += 1

    ss.TDS.callpert = check
    ss.TDS.run()

    assert steps > 20
    assert worst == 0.0


def ss_bus(case: str) -> int:
    """A bus to put the fault on: not the first, so a generator feels it."""
    return 4 if "ieee14" in case else 6


# ---- the streaming handler ---------------------------------------------------------


class _RecordingPipe:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    def send(self, message: dict[str, Any]) -> None:
        self.sent.append(message)

    def metadata(self) -> dict[str, Any]:
        (start,) = (m for m in self.sent if m["type"] == "stream_start")
        metadata: dict[str, Any] = start["metadata"]
        return metadata

    def rows(self) -> tuple[np.ndarray, np.ndarray]:
        decoded = [decode_batch(m["payload"]) for m in self.sent if m["type"] == "stream_frame"]
        return (
            np.concatenate([t for t, _ in decoded]),
            np.concatenate([values for _, values in decoded]),
        )


@pytest.fixture
def wrapper() -> Wrapper:
    cases = _cases() / "ieee14"
    w = Wrapper()
    w.load_case(cases / "ieee14.raw", addfiles=[cases / "ieee14.dyr"])
    return w


def _run(w: Wrapper, **args: Any) -> tuple[Any, _RecordingPipe]:
    pipe = _RecordingPipe()
    request: dict[str, Any] = {"tf": 0.5, "h": 1 / 60, **args}
    result = worker._handle_run_tds(w, request, threading.Event(), pipe, seq=1)  # type: ignore[arg-type]
    return result, pipe


def test_the_stream_names_the_variables_and_matches_the_groups_it_overlaps(
    wrapper: Wrapper,
) -> None:
    wanted = ["omega GENROU 1", "v Bus 3", "vf GENROU 2"]
    _, pipe = _run(
        wrapper,
        stream=True,
        vars=["bus_v", "gen_state"],
        dae_vars=wanted,
        decimation="none",
    )
    metadata = pipe.metadata()
    columns = metadata["var_columns"]
    _, values = pipe.rows()

    # The groups first, then the named variables, each named as asked.
    assert columns[-3:] == wanted
    assert metadata["dae_vars"] == wanted
    assert values.shape[1] == len(columns)
    # Two of them are also in a group: the same numbers under two names.
    assert np.array_equal(values[:, columns.index("omega GENROU 1")],
                          values[:, columns.index("Gen_GENROU_1_omega")])
    assert np.array_equal(values[:, columns.index("v Bus 3")],
                          values[:, columns.index("Bus_3_v")])
    # One is in no group, and it is a real signal: the exciter field voltage moves.
    vf = values[:, columns.index("vf GENROU 2")]
    assert np.isfinite(vf).all()
    assert np.ptp(vf) > 0 or abs(vf[0]) > 0


def test_andes_variables_alone_can_be_the_whole_selection(wrapper: Wrapper) -> None:
    _, pipe = _run(wrapper, stream=True, vars=[], dae_vars=["omega GENROU 1"], decimation="none")

    assert pipe.metadata()["var_columns"] == ["omega GENROU 1"]
    assert pipe.metadata()["vars"] == []
    _, values = pipe.rows()
    assert values.shape[1] == 1


def test_a_name_that_is_not_a_variable_is_refused_before_the_stream_opens(
    wrapper: Wrapper,
) -> None:
    pipe = _RecordingPipe()

    with pytest.raises(Exception, match="omega GENROU 99") as refused:
        worker._handle_run_tds(
            wrapper,
            {"tf": 0.5, "stream": True, "dae_vars": ["omega GENROU 99"]},
            threading.Event(),
            pipe,  # type: ignore[arg-type]
            seq=1,
        )

    assert type(refused.value).__name__ == "TdsRequestError"
    assert pipe.sent == []


def test_a_refused_request_leaves_the_case_open_to_disturbances(wrapper: Wrapper) -> None:
    with pytest.raises(Exception, match="not ANDES variable"):
        _run(wrapper, dae_vars=["nope"])

    # Nothing set the System up, so a disturbance can still be added.
    assert not wrapper._require_loaded().is_setup  # noqa: SLF001


# ---- the batch run -------------------------------------------------------------------


def test_a_batch_run_returns_the_values_it_was_asked_to_record(wrapper: Wrapper) -> None:
    result, _ = _run(wrapper, dae_vars=["omega GENROU 1", "v Bus 3"], h=0.02)

    traces = result["traces"]
    t = np.array(traces["t"])
    assert t[0] == 0.0
    assert np.all(np.diff(t) > 0)
    assert t[-1] == pytest.approx(result["final_t"])
    assert [v["name"] for v in traces["variables"]] == ["omega GENROU 1", "v Bus 3"]
    for series in traces["variables"]:
        assert len(series["values"]) == len(t)
    # The power flow's operating point: every machine at synchronous speed.
    assert traces["variables"][0]["values"][0] == pytest.approx(1.0)
    assert traces["truncated"] is False


def test_a_batch_run_that_names_nothing_returns_no_traces(wrapper: Wrapper) -> None:
    result, _ = _run(wrapper)

    assert "traces" not in result


# ---- over HTTP and the WebSocket --------------------------------------------------------


@pytest.fixture
def live(tmp_path: Path) -> Iterator[tuple[TestClient, str]]:
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    for name in ("ieee14.raw", "ieee14.dyr"):
        shutil.copy2(_cases() / "ieee14" / name, workspace / name)
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=2,
        idle_timeout_seconds=180.0,
        extra_allowed_hosts=frozenset({"testserver"}),
        extra_allowed_origins=frozenset({"http://testserver", "http://localhost"}),
    )
    with TestClient(app) as client:
        created = client.post("/api/sessions")
        assert created.status_code == 201, created.text
        sid = str(created.json()["session_id"])
        loaded = client.post(
            f"/api/sessions/{sid}/case",
            json={"primary_path": "ieee14.raw", "addfiles": ["ieee14.dyr"]},
        )
        assert loaded.status_code in (200, 201), loaded.text
        yield client, sid


def test_the_listing_pages_and_filters_the_catalogue(live: tuple[TestClient, str]) -> None:
    client, sid = live

    everything = client.get(f"/api/sessions/{sid}/dae-variables", params={"limit": 1000})
    assert everything.status_code == 200, everything.text
    body = everything.json()
    assert body["total"] == len(body["items"]) > 300

    omega = client.get(
        f"/api/sessions/{sid}/dae-variables", params={"q": "omega genrou", "kind": "x"}
    ).json()
    assert [item["name"] for item in omega["items"]] == [f"omega GENROU {i}" for i in range(1, 6)]
    first = omega["items"][0]
    assert (first["kind"], first["model"], first["var"], first["idx"]) == (
        "x",
        "GENROU",
        "omega",
        "GENROU_1",
    )

    page = client.get(
        f"/api/sessions/{sid}/dae-variables", params={"model": "GENROU", "limit": 4, "offset": 2}
    ).json()
    assert len(page["items"]) == 4
    assert page["total"] > 4


def test_listing_the_catalogue_does_not_close_the_case_to_disturbances(
    live: tuple[TestClient, str],
) -> None:
    client, sid = live
    assert client.get(f"/api/sessions/{sid}/dae-variables").status_code == 200

    fault = client.post(
        f"/api/sessions/{sid}/disturbances",
        json={
            "disturbances": [
                {"kind": "fault", "bus_idx": 4, "tf": 0.3, "tc": 0.4, "xf": 1e-4, "rf": 0}
            ]
        },
    )

    assert fault.status_code in (200, 201), fault.text


def test_listing_without_a_case_is_an_empty_list(live: tuple[TestClient, str]) -> None:
    client, _ = live
    empty = str(client.post("/api/sessions").json()["session_id"])

    answer = client.get(f"/api/sessions/{empty}/dae-variables")

    assert answer.status_code == 200
    assert answer.json() == {"total": 0, "items": []}


def test_listing_for_a_session_that_is_not_there_is_a_404(live: tuple[TestClient, str]) -> None:
    client, _ = live

    assert client.get("/api/sessions/nope/dae-variables").status_code == 404


def test_a_batch_request_returns_traces_and_a_bad_name_is_a_422(
    live: tuple[TestClient, str],
) -> None:
    client, sid = live

    bad = client.post(
        f"/api/sessions/{sid}/tds", json={"tf": 0.3, "dae_vars": ["omega GENROU 99"]}
    )
    assert bad.status_code == 422
    assert "omega GENROU 99" in bad.text

    ok = client.post(
        f"/api/sessions/{sid}/tds",
        json={"tf": 0.3, "h": 0.02, "dae_vars": ["omega GENROU 1", "omega GENROU 2"]},
    )
    assert ok.status_code == 200, ok.text
    traces = ok.json()["traces"]
    assert [v["name"] for v in traces["variables"]] == ["omega GENROU 1", "omega GENROU 2"]
    assert len(traces["t"]) == len(traces["variables"][0]["values"]) >= 15
    assert traces["truncated"] is False

    plain = client.post(f"/api/sessions/{sid}/reload")
    assert plain.status_code == 200
    summary = client.post(f"/api/sessions/{sid}/tds", json={"tf": 0.2, "h": 0.02}).json()
    assert summary["traces"] is None


def test_a_faulted_batch_runs_traces_go_straight_into_the_metrics_route(
    live: tuple[TestClient, str],
) -> None:
    client, sid = live
    client.post(
        f"/api/sessions/{sid}/disturbances",
        json={
            "disturbances": [
                {"kind": "fault", "bus_idx": 4, "tf": 0.5, "tc": 0.6, "xf": 1e-3, "rf": 0}
            ]
        },
    ).raise_for_status()
    run = client.post(
        f"/api/sessions/{sid}/tds",
        json={"tf": 4.0, "h": 0.02, "dae_vars": ["omega GENROU 1", "omega GENROU 5"]},
    )
    assert run.status_code == 200, run.text
    traces = run.json()["traces"]

    answer = client.post(
        "/api/response-metrics",
        json={
            "series": [
                {"name": v["name"], "t": traces["t"], "y": v["values"]}
                for v in traces["variables"]
            ],
            "t_start": 0.5,
        },
    )

    assert answer.status_code == 200, answer.text
    results = answer.json()["results"]
    assert [r["name"] for r in results] == ["omega GENROU 1", "omega GENROU 5"]
    for result in results:
        assert result["error"] is None
        assert result["t_start"] == 0.5
        # The machines are at synchronous speed until the fault and swing after it.
        assert result["initial"] == pytest.approx(1.0, abs=1e-3)
        assert abs(result["max_deviation"]["value"]) > 1e-4
        assert result["peak"]["value"] > result["nadir"]["value"]
        assert result["rocof"]["value"] != 0


def test_a_websocket_run_streams_the_named_variables(live: tuple[TestClient, str]) -> None:
    client, sid = live
    with websocket_session(client, f"/api/ws/{sid}") as ws:
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_text(
            json.dumps(
                {
                    "type": "start_tds",
                    "tf": 0.3,
                    "h": 0.02,
                    "vars": ["bus_v"],
                    "dae_vars": ["omega GENROU 1"],
                }
            )
        )
        start = json.loads(ws.receive_text())
        assert start["type"] == "stream_start"
        columns = start["metadata"]["var_columns"]
        assert columns[-1] == "omega GENROU 1"
        frame = ws.receive_bytes()
        _, values = decode_batch(frame)
        assert values.shape[1] == len(columns)
        assert values[0, -1] == pytest.approx(1.0)


def test_a_websocket_run_with_a_bad_name_is_refused_with_the_reason(
    live: tuple[TestClient, str],
) -> None:
    client, sid = live
    with websocket_session(client, f"/api/ws/{sid}") as ws:
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_text(
            json.dumps({"type": "start_tds", "tf": 0.3, "dae_vars": ["omega GENROU 99"]})
        )
        frame = json.loads(ws.receive_text())
        assert frame["type"] == "error"
        assert "omega GENROU 99" in frame["reason"]
        with pytest.raises(WebSocketDisconnect):
            ws.receive_text()


def test_a_websocket_dae_vars_that_is_not_a_list_of_names_is_refused(
    live: tuple[TestClient, str],
) -> None:
    client, sid = live
    with websocket_session(client, f"/api/ws/{sid}") as ws:
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_text(json.dumps({"type": "start_tds", "tf": 0.3, "dae_vars": "omega"}))
        frame = json.loads(ws.receive_text())
        assert frame["type"] == "error"
        assert "dae_vars" in frame["reason"]
