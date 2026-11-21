"""Integration tests for ``GET /api/sessions/{id}/ybus``.

Same fixtures and client as ``tests/integration/test_engines_api.py``: a real
FastAPI app over an ASGI transport, with real worker subprocesses, loading the
IEEE 14-bus case a fresh workspace seeds. The numbers are held to the power
flow: with the solved bus voltages ``V``, ``V * conj(Y V)`` is the power each
bus injects into the network, which is what its generators give less what its
loads draw (the shunts are inside ``Y``).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import numpy as np
import pytest

from tensa.api.app import make_app
from tensa.core.examples import seed_example_cases
from tensa.core.session import SessionManager


@pytest.fixture
async def client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    """Yield an httpx AsyncClient pointed at a fresh FastAPI app instance."""
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    seed_example_cases(workspace)
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,  # for Host check; the actual transport is in-process
        max_sessions=2,
        idle_timeout_seconds=180.0,
    )
    mgr = SessionManager(max_sessions=2, idle_timeout=180.0)
    await mgr.start()
    app.state.session_manager = mgr
    app.state.workspace = workspace

    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://127.0.0.1:8000",
            timeout=120.0,
        ) as ac:
            yield ac
    finally:
        await mgr.shutdown()


async def _session_with_ieee14(client: httpx.AsyncClient) -> str:
    created = await client.post("/api/sessions")
    assert created.status_code == 201, created.text
    sid = str(created.json()["session_id"])
    loaded = await client.post(
        f"/api/sessions/{sid}/case", json={"primary_path": "ieee14_full.xlsx"}
    )
    assert loaded.status_code == 200, loaded.text
    return sid


async def _ybus(client: httpx.AsyncClient, sid: str) -> dict[str, Any]:
    resp = await client.get(f"/api/sessions/{sid}/ybus")
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


def _dense(body: dict[str, Any]) -> np.ndarray:
    n = body["n_bus"]
    y = np.zeros((n, n), dtype=complex)
    for e in body["entries"]:
        assert y[e["row"], e["col"]] == 0, "an entry is sent once"
        y[e["row"], e["col"]] = complex(e["re"], e["im"])
    return y


def _branches(topology: dict[str, Any]) -> list[dict[str, Any]]:
    return list(topology["lines"]) + list(topology["transformers"])


@pytest.mark.integration
async def test_ybus_names_every_bus_and_needs_no_power_flow(
    client: httpx.AsyncClient,
) -> None:
    sid = await _session_with_ieee14(client)
    topology = (await client.get(f"/api/sessions/{sid}/topology")).json()
    assert topology["state"] == "pre-setup"

    body = await _ybus(client, sid)

    buses = topology["buses"]
    assert body["n_bus"] == len(buses)
    assert sorted(body["bus_idx"]) == sorted(str(b["idx"]) for b in buses)
    key_of = {str(b["idx"]): b["key"] for b in buses}
    assert body["bus_key"] == [key_of[idx] for idx in body["bus_idx"]]
    assert all(key is not None for key in body["bus_key"])
    assert body["base_mva"] == pytest.approx(topology["base_mva"])
    for e in body["entries"]:
        assert 0 <= e["row"] < body["n_bus"] and 0 <= e["col"] < body["n_bus"]
        assert (e["re"], e["im"]) != (0.0, 0.0)

    # The sparsity is the network: a diagonal for every bus with a branch or a
    # shunt, a pair of off-diagonals for every pair of buses a branch joins, and
    # nothing else.
    pos = {idx: i for i, idx in enumerate(body["bus_idx"])}
    pairs = {
        frozenset((pos[str(br["params"]["bus1"])], pos[str(br["params"]["bus2"])]))
        for br in _branches(topology)
    }
    off = {(e["row"], e["col"]) for e in body["entries"] if e["row"] != e["col"]}
    assert off == {(i, j) for pair in pairs for i in pair for j in pair if i != j}
    # A series admittance is g - jb with g, b > 0, so its off-diagonal is
    # negative in the real part and positive in the imaginary part.
    y = _dense(body)
    for i, j in off:
        assert y[i, j].real <= 0 and y[i, j].imag > 0

    # ANDES builds the matrix only on a System that is set up: the call set it up.
    after = (await client.get(f"/api/sessions/{sid}/topology")).json()
    assert after["state"] == "committed"


@pytest.mark.integration
async def test_ybus_times_the_solved_voltages_gives_the_bus_injections(
    client: httpx.AsyncClient,
) -> None:
    sid = await _session_with_ieee14(client)
    pflow = await client.post(f"/api/sessions/{sid}/pflow", json={})
    assert pflow.status_code == 200, pflow.text
    result = pflow.json()
    assert result["converged"] is True

    body = await _ybus(client, sid)
    y = _dense(body)
    v = np.array(
        [
            result["bus_voltages"][idx] * np.exp(1j * result["bus_angles"][idx])
            for idx in body["bus_idx"]
        ]
    )
    injected = v * np.conj(y @ v) * body["base_mva"]  # MW + j MVAr

    expected = dict.fromkeys(body["bus_idx"], 0j)
    for gen in result["generator_outputs"].values():
        expected[str(gen["bus"])] += complex(gen["p"], gen["q"])
    for load in result["load_consumption"].values():
        expected[str(load["bus"])] -= complex(load["p"], load["q"])
    want = np.array([expected[idx] for idx in body["bus_idx"]])

    # The power flow converges to 1e-6 pu of mismatch; 1e-3 MW is ten times that.
    assert np.max(np.abs(injected - want)) < 1e-3
    # Not a trivial match: the slack bus alone injects some 80 MVA.
    assert np.max(np.abs(want)) > 50


@pytest.mark.integration
async def test_ybus_is_symmetric_without_phase_shifters(
    client: httpx.AsyncClient,
) -> None:
    sid = await _session_with_ieee14(client)
    topology = (await client.get(f"/api/sessions/{sid}/topology")).json()
    assert all(float(br["params"].get("phi", 0.0)) == 0.0 for br in _branches(topology))
    y = _dense(await _ybus(client, sid))
    np.testing.assert_allclose(y, y.T, rtol=0, atol=1e-12)


@pytest.mark.integration
async def test_a_line_switched_off_before_the_call_is_absent(
    client: httpx.AsyncClient,
) -> None:
    sid = await _session_with_ieee14(client)
    topology = (await client.get(f"/api/sessions/{sid}/topology")).json()
    lines = topology["lines"]
    ends = [frozenset((str(ln["params"]["bus1"]), str(ln["params"]["bus2"]))) for ln in lines]
    line = next(ln for ln, pair in zip(lines, ends, strict=True) if ends.count(pair) == 1)
    bus1, bus2 = str(line["params"]["bus1"]), str(line["params"]["bus2"])

    edited = await client.put(
        f"/api/sessions/{sid}/elements/Line/{line['idx']}", json={"params": {"u": 0}}
    )
    assert edited.status_code == 200, edited.text

    body = await _ybus(client, sid)
    pos = {idx: i for i, idx in enumerate(body["bus_idx"])}
    i, j = pos[bus1], pos[bus2]
    at = {(e["row"], e["col"]) for e in body["entries"]}
    assert (i, j) not in at and (j, i) not in at
    assert (i, i) in at and (j, j) in at  # both buses keep their other branches


@pytest.mark.integration
async def test_ybus_reflects_a_trip_at_the_time_of_the_call(
    client: httpx.AsyncClient,
) -> None:
    sid = await _session_with_ieee14(client)
    topology = (await client.get(f"/api/sessions/{sid}/topology")).json()
    lines = topology["lines"]
    ends = [frozenset((str(ln["params"]["bus1"]), str(ln["params"]["bus2"]))) for ln in lines]
    line = next(ln for ln, pair in zip(lines, ends, strict=True) if ends.count(pair) == 1)

    added = await client.post(
        f"/api/sessions/{sid}/disturbances",
        json={
            "disturbances": [
                {"kind": "toggle", "model": "Line", "dev_idx": str(line["idx"]), "t": 0.1}
            ]
        },
    )
    assert added.status_code == 200, added.text
    before = await _ybus(client, sid)
    pos = {idx: i for i, idx in enumerate(before["bus_idx"])}
    pair = (pos[str(line["params"]["bus1"])], pos[str(line["params"]["bus2"])])
    assert pair in {(e["row"], e["col"]) for e in before["entries"]}

    run = await client.post(f"/api/sessions/{sid}/tds", json={"tf": 0.5})
    assert run.status_code == 200, run.text

    after = await _ybus(client, sid)
    assert pair not in {(e["row"], e["col"]) for e in after["entries"]}
    assert len(after["entries"]) == len(before["entries"]) - 2


@pytest.mark.integration
async def test_ybus_unknown_session_is_404(client: httpx.AsyncClient) -> None:
    resp = await client.get("/api/sessions/no-such-session/ybus")
    assert resp.status_code == 404, resp.text
    assert resp.json()["status"] == 404


@pytest.mark.integration
async def test_ybus_without_a_case_is_409_with_load_case(
    client: httpx.AsyncClient,
) -> None:
    created = await client.post("/api/sessions")
    sid = created.json()["session_id"]
    resp = await client.get(f"/api/sessions/{sid}/ybus")
    assert resp.status_code == 409, resp.text
    assert resp.json()["recovery"]["kind"] == "load-case"


@pytest.mark.integration
async def test_ybus_maps_a_worker_error_like_every_route(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A refusal from the worker reaches the client with the status and the
    problem details the shared mapping gives it, recovery included; the route
    asks the worker for the matrix with no arguments."""
    from tensa.core.session import WorkerError

    created = await client.post("/api/sessions")
    sid = str(created.json()["session_id"])
    mgr = client._transport.app.state.session_manager  # type: ignore[attr-defined]  # noqa: SLF001
    asked: list[tuple[str, str, object]] = []

    async def refuse(session_id: str, op: str, args: object = None) -> object:
        asked.append((session_id, op, args))
        raise WorkerError("SetupFailedError", "ANDES setup() failed")

    monkeypatch.setattr(mgr, "invoke", refuse)
    resp = await client.get(f"/api/sessions/{sid}/ybus")
    assert resp.status_code == 422, resp.text
    body = resp.json()
    assert body["detail"] == "ANDES setup() failed"
    assert body["recovery"]["kind"] == "reload-case"
    # The op takes no arguments and its handler ignores any it is sent, so an
    # argument here would be a mistake nothing else would catch.
    assert [(s, op, args or {}) for s, op, args in asked] == [
        (sid, "bus_admittance_matrix", {})
    ]


@pytest.mark.integration
async def test_ybus_without_a_session_manager_is_500(tmp_path: Path) -> None:
    """An app whose lifespan has not run holds no session manager: the route says
    so with a 500, not a 404 that would read as a session that is gone."""
    app = make_app(workspace=tmp_path, bind_host="127.0.0.1", bind_port=8000)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as ac:
        resp = await ac.get("/api/sessions/nope/ybus")
    assert resp.status_code == 500, resp.text
    assert resp.json()["detail"] == "session manager is not configured"


@pytest.mark.integration
async def test_ybus_is_described_under_its_operation_id(client: httpx.AsyncClient) -> None:
    """The web client's generated types and an agent's tools name the route by its
    operation id, and its refusals are problem details."""
    spec: dict[str, Any] = (await client.get("/openapi.json")).json()
    operation = spec["paths"]["/api/sessions/{session_id}/ybus"]["get"]
    assert operation["operationId"] == "getBusAdmittanceMatrix"
    ok = operation["responses"]["200"]["content"]["application/json"]["schema"]["$ref"]
    assert ok.endswith("/YbusResponse")
    for code in ("404", "409", "422"):
        schema = operation["responses"][code]["content"]["application/json"]["schema"]
        assert schema["$ref"].endswith("/ProblemDetails"), code
