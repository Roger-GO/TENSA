"""Route tests of ``POST /studies`` with a stubbed session manager; no Julia."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from tensa.api.app import make_app
from tensa.core.session import WorkerError


class _StubManager:
    """A stand-in ``SessionManager`` that records its calls and answers from a
    script: ``answers[op]`` is the payload every invoke of that op returns, or
    the exception it raises."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.answers: dict[str, Any] = {}
        self._next = 0

    async def create_session(self, engine: str = "andes") -> str:
        self._next += 1
        sid = f"stub-{engine}-{self._next}"
        self.calls.append(("create_session", engine))
        return sid

    async def invoke(
        self, session_id: str, op: str, args: dict[str, Any] | None = None, **kw: Any
    ) -> Any:
        self.calls.append(("invoke", session_id, op, args))
        answer = self.answers.get(op, {})
        if isinstance(answer, BaseException):
            raise answer
        return answer

    async def invoke_streaming(
        self,
        session_id: str,
        op: str,
        args: dict[str, Any] | None = None,
        *,
        on_metadata: Any = None,
        on_frame: Any = None,
        **kw: Any,
    ) -> Any:
        """A streamed run: the answer's traces go out as a stream_start with
        their names and one frame of their rows, as the worker sends them, and
        the final payload carries no traces."""
        from tensa.core.stream import encode_batch

        self.calls.append(("invoke", session_id, op, args))
        answer = self.answers.get(op, {})
        if isinstance(answer, BaseException):
            raise answer
        traces = answer.get("traces") or {"t": [], "variables": []}
        names = [v["name"] for v in traces["variables"]]
        if on_metadata is not None:
            await on_metadata({"var_columns": names})
        rows = [
            (t, [v["values"][i] for v in traces["variables"]]) for i, t in enumerate(traces["t"])
        ]
        if on_frame is not None and rows:
            await on_frame(encode_batch(len(names), rows))
        return {key: value for key, value in answer.items() if key != "traces"}

    async def close_session(self, session_id: str) -> None:
        self.calls.append(("close_session", session_id))

    def invoked(self, op: str) -> list[tuple[str, Any]]:
        return [
            (str(call[1]), call[3])
            for call in self.calls
            if call[0] == "invoke" and call[2] == op
        ]

    def closed(self, sid: str) -> bool:
        return ("close_session", sid) in self.calls


def _pflow_payload() -> dict[str, Any]:
    """A minimal converged run_pflow payload: two buses, one branch, one
    generator, one load, with the keys lookup the builder reads."""
    return {
        "converged": True,
        "iterations": 3,
        "mismatch": 1e-9,
        "bus_voltages": {"1": 1.03, "2": 1.01},
        "bus_angles": {"1": 0.0, "2": -0.05},
        "line_flows": {
            "Line_1": {
                "p": 50.0,
                "q": 10.0,
                "from_idx": "1",
                "to_idx": "2",
                "p_to": -49.5,
                "q_to": -9.0,
                "loss": 0.5,
                "rate_a": 0.0,
                "loading_pct": None,
            }
        },
        "generator_outputs": {
            "1": {"p": 50.0, "q": 10.0, "v": 1.03, "bus": "1", "q_min": -100.0, "q_max": 100.0}
        },
        "load_consumption": {"PQ_1": {"p": 49.5, "q": 9.0, "bus": "2"}},
        "keys": {
            "bus": {"1": "bus:1", "2": "bus:2"},
            "line": {"Line_1": "branch:1-2-1"},
            "generator": {"1": "gen:1-1"},
            "load": {"PQ_1": "load:2-1"},
        },
    }


def _keys_payload() -> dict[str, Any]:
    return {
        "keys": [
            {"key": "bus:1", "bucket": "bus", "model": "Bus", "idx": 1, "source": "case"},
            {"key": "bus:8", "bucket": "bus", "model": "Bus", "idx": 8, "source": "case"},
            {
                "key": "branch:7-8-1",
                "bucket": "line",
                "model": "Line",
                "idx": "Line_1",
                "source": "case",
            },
        ],
        "problems": [],
    }


def _tds_payload(engine: str) -> dict[str, Any]:
    """A minimal run_tds payload: one voltage column per bus, named as the
    engine names it."""
    names = ["voltage|bus:1", "voltage|bus:8"] if engine == "sienna" else ["Bus_1_v", "Bus_8_v"]
    return {
        "converged": True,
        "final_t": 2.0,
        "callpert_count": 3,
        "traces": {
            "t": [0.0, 1.0, 2.0],
            "variables": [
                {"name": names[0], "values": [1.0, 0.9, 1.0]},
                {"name": names[1], "values": [1.01, 0.4, 1.01]},
            ],
            "truncated": False,
        },
    }


@pytest.fixture()
def stub() -> _StubManager:
    return _StubManager()


@pytest.fixture()
def client(stub: _StubManager, tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setattr(
        "tensa.api.routes.studies.SessionManager", _StubManager
    )
    app = make_app(
        workspace=tmp_path,
        static_override=None,
        extra_allowed_hosts=frozenset({"testserver"}),
        extra_allowed_origins=frozenset({"http://testserver", "http://localhost"}),
    )
    app.state.session_manager = stub
    # The lifespan that sets the workspace does not run for a client used
    # outside a with block; the route validates the case's files under it.
    app.state.workspace = tmp_path
    (tmp_path / "kundur.raw").write_text("0, 100.0")
    (tmp_path / "kundur.dyr").write_text("1 'GENCLS' 1 6.0 0.0 /")
    return TestClient(app)


def _body(study: dict[str, Any], engines: list[str] | None = None) -> dict[str, Any]:
    return {
        "case": {"primary_path": "kundur.raw", "addfiles": ["kundur.dyr"]},
        "engines": engines or ["andes", "sienna"],
        "study": study,
    }


def test_a_case_outside_the_workspace_is_400_and_makes_no_session(
    client: TestClient, stub: _StubManager
) -> None:
    body = _body({"tensa_study": 1, "routine": "pflow"})
    body["case"] = {"primary_path": "../outside.raw", "addfiles": []}
    response = client.post("/api/studies", json=body)
    assert response.status_code == 400, response.text
    assert not any(call[0] == "create_session" for call in stub.calls)


def test_pflow_on_both_engines(client: TestClient, stub: _StubManager) -> None:
    stub.answers["run_pflow"] = _pflow_payload()
    response = client.post("/api/studies", json=_body({"tensa_study": 1, "routine": "pflow"}))
    assert response.status_code == 200, response.text
    data = response.json()
    assert len(data["outcomes"]) == 2
    for outcome, engine in zip(data["outcomes"], ("andes", "sienna"), strict=True):
        assert outcome["ran"] is True
        assert outcome["problem"] is None
        assert outcome["document"]["engine"]["name"] == engine
        assert outcome["document"]["study"]["routine"] == "pflow"
        assert outcome["document"]["tables"]["pflow"]["converged"] is True
    assert len(data["comparisons"]) == 1
    comparison = data["comparisons"][0]
    assert comparison["engine"] == "sienna"
    keys = {row["key"] for row in comparison["power_flow"]["rows"]}
    assert "bus:1" in keys and "bus:2" in keys
    assert ("create_session", "andes") in stub.calls
    assert ("create_session", "sienna") in stub.calls
    load_cases = stub.invoked("load_case")
    assert len(load_cases) == 2
    for _sid, args in load_cases:
        # The worker is given the canonical paths, as POST /sessions/{id}/case
        # gives them.
        assert Path(args["path"]).name == "kundur.raw"
        assert [Path(a).name for a in args["addfiles"]] == ["kundur.dyr"]
        assert Path(args["path"]).is_absolute()
    assert len(stub.invoked("run_pflow")) == 2
    # create_session records the engine, so find the sids in order of creation.
    created = [f"stub-{engine}-{i + 1}" for i, engine in enumerate(("andes", "sienna"))]
    for sid in created:
        assert stub.closed(sid)


def test_refusal_beside_result(client: TestClient, stub: _StubManager) -> None:
    stub.answers["network_matrix"] = {"kind": "ptdf", "values": []}
    response = client.post(
        "/api/studies", json=_body({"tensa_study": 1, "routine": "matrices"})
    )
    assert response.status_code == 200, response.text
    data = response.json()
    andes, sienna = data["outcomes"]
    assert andes["ran"] is False
    assert andes["document"] is None
    assert andes["problem"]["status"] == 409
    assert andes["problem"]["category"] == "engine_unsupported"
    assert "sienna" in andes["problem"]["recovery"]["engines"]
    assert sienna["ran"] is True
    assert sienna["raw"] == {"kind": "ptdf", "values": []}
    assert ("create_session", "andes") not in stub.calls
    assert data["comparisons"] == []


def test_dispatch_refused_by_andes(client: TestClient, stub: _StubManager) -> None:
    stub.answers["run_dispatch"] = {"objective_per_h": 1.0}
    response = client.post(
        "/api/studies",
        json=_body(
            {
                "tensa_study": 1,
                "routine": "dispatch",
                "options": {"network_model": "copper_plate"},
            }
        ),
    )
    assert response.status_code == 200, response.text
    data = response.json()
    andes, sienna = data["outcomes"]
    assert andes["ran"] is False
    assert andes["problem"]["category"] == "engine_unsupported"
    assert sienna["ran"] is True
    assert sienna["raw"] == {"objective_per_h": 1.0}
    assert ("create_session", "andes") not in stub.calls


def test_sessions_closed_on_failure(client: TestClient, stub: _StubManager) -> None:
    stub.answers["run_pflow"] = WorkerError(
        category="no-case-loaded", detail="no case has been loaded into this session"
    )
    response = client.post("/api/studies", json=_body({"tensa_study": 1, "routine": "pflow"}))
    assert response.status_code == 409, response.text
    # The run_pflow of the first engine fails, so no second session is made;
    # every session that was made is closed, whatever happened.
    created = [call[1] for call in stub.calls if call[0] == "create_session"]
    assert created == ["andes"]
    assert stub.closed("stub-andes-1")


def test_unknown_engine_422(client: TestClient) -> None:
    response = client.post(
        "/api/studies",
        json=_body({"tensa_study": 1, "routine": "pflow"}, engines=["andes", "pandapower"]),
    )
    assert response.status_code == 422
    assert "unknown engine" in response.text


def test_duplicate_engine_422(client: TestClient) -> None:
    response = client.post(
        "/api/studies",
        json=_body({"tensa_study": 1, "routine": "pflow"}, engines=["andes", "andes"]),
    )
    assert response.status_code == 422
    assert "an engine is named twice" in response.text


def test_bad_study_422(client: TestClient) -> None:
    response = client.post(
        "/api/studies", json=_body({"tensa_study": 2, "routine": "pflow"})
    )
    assert response.status_code == 422
    assert "newer than this server reads" in response.text


def test_tds_disturbance_mapping(client: TestClient, stub: _StubManager) -> None:
    stub.answers["list_keys"] = _keys_payload()
    stub.answers["run_tds"] = _tds_payload("andes")
    study = {
        "tensa_study": 1,
        "routine": "tds",
        "options": {"t_end": 2.0},
        "load_model": "impedance",
        "disturbances": [
            {
                "kind": "bus_fault",
                "bus": "bus:8",
                "t_on": 1.0,
                "t_clear": 1.1,
                "r_pu": 0.0,
                "x_pu": 0.0001,
            }
        ],
    }
    response = client.post("/api/studies", json=_body(study, engines=["andes"]))
    assert response.status_code == 200, response.text
    disturbances = stub.invoked("add_disturbance")
    assert len(disturbances) == 1
    _sid, args = disturbances[0]
    # What POST /sessions/{id}/disturbances sends the worker: the spec under
    # "spec", with the bus's idx from the session's keys.
    assert args["spec"] == {
        "kind": "fault",
        "bus_idx": 8,
        "tf": 1.0,
        "tc": 1.1,
        "xf": 0.0001,
        "rf": 0.0,
    }
    runs = stub.invoked("run_tds")
    assert len(runs) == 1
    _sid, run_args = runs[0]
    assert run_args["load_model"] == "impedance"
    assert run_args["tf"] == 2.0
    # ANDES runs as a stream: its batch run records only named variables.
    assert run_args["stream"] is True
    # The disturbance before the power flow (ANDES takes it only before setup),
    # the power flow before the run (a Sienna session refuses a run without one).
    ops = [call[2] for call in stub.calls if call[0] == "invoke"]
    assert ops.index("add_disturbance") < ops.index("run_pflow") < ops.index("run_tds")


def test_unknown_disturbance_target_422(client: TestClient, stub: _StubManager) -> None:
    stub.answers["list_keys"] = _keys_payload()
    stub.answers["run_tds"] = _tds_payload("andes")
    study = {
        "tensa_study": 1,
        "routine": "tds",
        "options": {"t_end": 2.0},
        "disturbances": [{"kind": "branch_trip", "target": "branch:1-2-9", "t": 1.0}],
    }
    response = client.post("/api/studies", json=_body(study, engines=["andes"]))
    assert response.status_code == 422
    assert "is not an element of the case" in response.text


def test_unknown_pflow_option_422(client: TestClient, stub: _StubManager) -> None:
    stub.answers["run_pflow"] = _pflow_payload()
    response = client.post(
        "/api/studies",
        json=_body(
            {"tensa_study": 1, "routine": "pflow", "options": {"toleranc": 1e-6}},
            engines=["andes"],
        ),
    )
    assert response.status_code == 422
    assert "unknown pflow option 'toleranc'" in response.text


def test_comparison_skipped_without_two_documents(
    client: TestClient, stub: _StubManager
) -> None:
    stub.answers["run_pflow"] = _pflow_payload()
    response = client.post(
        "/api/studies",
        json=_body({"tensa_study": 1, "routine": "pflow"}, engines=["andes"]),
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert len(data["outcomes"]) == 1
    assert data["comparisons"] == []


def test_nonconverged_pflow_422(client: TestClient, stub: _StubManager) -> None:
    payload = _pflow_payload()
    payload["converged"] = False
    stub.answers["run_pflow"] = payload
    response = client.post(
        "/api/studies",
        json=_body({"tensa_study": 1, "routine": "pflow"}, engines=["andes"]),
    )
    assert response.status_code == 422
    assert "did not converge" in response.text
    assert stub.closed("stub-andes-1")
