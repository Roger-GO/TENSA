"""Integration tests of the Sienna DC power flow with a real Julia.

Marked ``sienna`` and ``integration``: they start a worker with Julia and load
the three-bus triangle of the unit (a load of 150 MW at bus 3, generation of
100 MW at bus 1 and 50 MW at bus 2) and ANDES's kundur.raw, through a real
worker. The triangle's DC flows are the hand computation of the unit;
kundur's DC active flows are held to its AC ones within the AC losses, its
reference generator to the lossless balance and the others to their
schedules.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

pytestmark = [pytest.mark.sienna, pytest.mark.integration]

# The three-bus triangle as a PSS/E RAW case: buses 1 (reference), 2 and 3,
# lines 1-2, 1-3 and 2-3, each r = 0 and x = 0.1 pu on a 100 MVA base, a load
# of 150 MW at bus 3 and generation of 100 MW at bus 1 and 50 MW at bus 2.
_THREE_BUS_RAW = """0,   100.00, 33, 0, 0, 60.00     / PSS(R)E-33 RAW
TENSA three-bus triangle
lines of x = 0.1 pu, bus 1 the reference
1,'BUS1        ', 230.0000,3,   1,   1,   1,1.00000,   0.0000,1.10000,0.90000,1.10000,0.90000
2,'BUS2        ', 230.0000,2,   1,   1,   1,1.00000,   0.0000,1.10000,0.90000,1.10000,0.90000
3,'BUS3        ', 230.0000,1,   1,   1,   1,1.00000,   0.0000,1.10000,0.90000,1.10000,0.90000
0 / END OF BUS DATA, BEGIN LOAD DATA
3,'1 ',1,   1,   1,   150.000,    30.000,     0.000,     0.000,     0.000,     0.000,   1,1,0
0 / END OF LOAD DATA, BEGIN FIXED SHUNT DATA
0 / END OF FIXED SHUNT DATA, BEGIN GENERATOR DATA
1,'1 ',   100.000,     0.000,  9999.000, -9999.000,1.00000,     0,   100.000, 0.00000E+0, 1.00000E+0, 0.00000E+0, 0.00000E+0,1.00000,1,  100.0,  9999.000, -9999.000,   1,1.0000
2,'1 ',    50.000,     0.000,  9999.000, -9999.000,1.00000,     0,   100.000, 0.00000E+0, 1.00000E+0, 0.00000E+0, 0.00000E+0,1.00000,1,  100.0,  9999.000, -9999.000,   1,1.0000
0 / END OF GENERATOR DATA, BEGIN BRANCH DATA
1,2,'1 ', 0.00000E+0, 1.00000E-1, 0.00000,   0.00,   0.00,   0.00, 0.00000, 0.00000, 0.00000, 0.00000,1,1,   0.00,   1,1.0000
1,3,'1 ', 0.00000E+0, 1.00000E-1, 0.00000,   0.00,   0.00,   0.00, 0.00000, 0.00000, 0.00000, 0.00000,1,1,   0.00,   1,1.0000
2,3,'1 ', 0.00000E+0, 1.00000E-1, 0.00000,   0.00,   0.00,   0.00, 0.00000, 0.00000, 0.00000, 0.00000,1,1,   0.00,   1,1.0000
0 / END OF BRANCH DATA, BEGIN TRANSFORMER DATA
0 / END OF TRANSFORMER DATA, BEGIN AREA DATA
0 / END OF AREA DATA, BEGIN TWO-TERMINAL DC DATA
0 / END OF TWO-TERMINAL DC DATA, BEGIN VSC DC LINE DATA
0 / END OF VSC DC LINE DATA, BEGIN IMPEDANCE CORRECTION DATA
0 / END OF IMPEDANCE CORRECTION DATA, BEGIN MULTI-TERMINAL DC DATA
0 / END OF MULTI-TERMINAL DC DATA, BEGIN MULTI-SECTION LINE DATA
0 / END OF MULTI-SECTION LINE DATA, BEGIN ZONE DATA
0 / END OF ZONE DATA, BEGIN INTER-AREA TRANSFER DATA
0 / END OF INTER-AREA TRANSFER DATA, BEGIN OWNER DATA
0 / END OF OWNER DATA, BEGIN FACTS DEVICE DATA
0 / END OF FACTS DEVICE DATA, BEGIN SWITCHED SHUNT DATA
0 / END OF SWITCHED SHUNT DATA, BEGIN GNE DATA
0 / END OF GNE DATA, BEGIN INDUCTION MACHINE DATA
0 / END OF INDUCTION MACHINE DATA
Q
"""


def _kundur_raw() -> Path:
    """ANDES's kundur.raw, which every Sienna test reads its cases from."""
    from tensa.core.examples import _andes_cases_dir

    cases = _andes_cases_dir()
    assert cases is not None
    return cases / "kundur" / "kundur.raw"


@pytest.fixture(scope="module")
def triangle(tmp_path_factory: pytest.TempPathFactory) -> Iterator[tuple[Any, str]]:
    """One app, one client and one Sienna session with the triangle loaded,
    through a real worker, shared by the DC tests (Julia starts once). The
    plumbing is the one of test_sienna_network.py."""
    from fastapi.testclient import TestClient

    from tensa.api.app import make_app

    workspace = tmp_path_factory.mktemp("dcpf-ws")
    (workspace / "triangle.raw").write_text(_THREE_BUS_RAW)
    app = make_app(workspace=workspace, bind_host="127.0.0.1", bind_port=8000)
    with TestClient(app, base_url="http://127.0.0.1:8000") as client:
        created = client.post("/api/sessions", json={"engine": "sienna"})
        if created.status_code == 409:
            pytest.skip(f"Sienna is not available: {created.json()['detail']}")
        assert created.status_code == 201, created.text
        session = created.json()["session_id"]
        loaded = client.post(
            f"/api/sessions/{session}/case", json={"primary_path": "triangle.raw"}
        )
        assert loaded.status_code == 200, loaded.text
        yield client, session


def _pflow(client: Any, session_id: str, body: dict[str, Any]) -> Any:
    return client.post(f"/api/sessions/{session_id}/pflow", json=body)


def _by_buses(line_flows: dict[str, Any]) -> dict[tuple[int, int], Any]:
    """The line flows by their two buses: PowerSystems names a branch read
    from a RAW file after its buses' names, which the test does not rely on."""
    return {(int(f["from_idx"]), int(f["to_idx"])): f for f in line_flows.values()}


def test_dc_three_bus_hand_calculation(triangle: tuple[Any, str]) -> None:
    client, session_id = triangle
    response = _pflow(client, session_id, {"method": "dc"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["converged"] is True
    assert body["settings"]["method"] == "dc"
    # Hand computation from the PTDF of the matrices unit. The injections are
    # +0.5 pu at bus 2 and -1.5 pu at bus 3 (the reference bus 1 balances).
    # With the PTDF columns of the matrices unit's test (line 1-2: bus 2
    # -2/3, bus 3 -1/3; line 1-3: bus 2 -1/3, bus 3 -2/3; line 2-3: bus 2
    # +1/3, bus 3 -1/3), the flows in per unit are:
    #   line 1-2: (-2/3)(0.5) + (-1/3)(-1.5) = 1/6   -> 16.6667 MW
    #   line 1-3: (-1/3)(0.5) + (-2/3)(-1.5) = 5/6   -> 83.3333 MW
    #   line 2-3: (+1/3)(0.5) + (-1/3)(-1.5) = 2/3   -> 66.6667 MW
    flows = _by_buses(body["line_flows"])
    assert flows[(1, 2)]["p"] == pytest.approx(100.0 / 6.0, abs=1e-9)
    assert flows[(1, 3)]["p"] == pytest.approx(500.0 / 6.0, abs=1e-9)
    assert flows[(2, 3)]["p"] == pytest.approx(400.0 / 6.0, abs=1e-9)
    for flow in flows.values():
        assert flow["p_to"] == pytest.approx(-flow["p"], abs=1e-9)
        assert flow["q"] is None
        assert flow["q_to"] is None
    # The slack picks up the balance: 150 - 50 = 100 MW at bus 1.
    gens = {int(g["bus"]): g for g in body["generator_outputs"].values()}
    assert gens[1]["p"] == pytest.approx(100.0, abs=1e-9)
    assert gens[2]["p"] == pytest.approx(50.0, abs=1e-9)
    for output in gens.values():
        assert output["q"] is None
    for load in body["load_consumption"].values():
        assert load["q"] is None
    assert body["summary"]["generation_q"] is None
    assert body["summary"]["load_q"] is None
    assert body["summary"]["loss_q"] is None
    assert body["summary"]["slack_q"] is None


def test_ptdf_dc_agrees_with_dc(triangle: tuple[Any, str]) -> None:
    client, session_id = triangle
    dc = _pflow(client, session_id, {"method": "dc"}).json()
    ptdf = _pflow(client, session_id, {"method": "ptdf-dc"}).json()
    assert ptdf["settings"]["method"] == "ptdf-dc"
    for name, flow in ptdf["line_flows"].items():
        assert flow["p"] == pytest.approx(dc["line_flows"][name]["p"], abs=1e-9)


def test_unknown_method_refused(triangle: tuple[Any, str]) -> None:
    client, session_id = triangle
    response = _pflow(client, session_id, {"method": "qndf"})
    assert response.status_code == 422
    assert "qndf" in response.json()["detail"]


def test_kundur_dc_vs_ac_active_flows(tmp_path: Path) -> None:
    import shutil

    from fastapi.testclient import TestClient

    from tensa.api.app import make_app

    shutil.copy(_kundur_raw(), tmp_path / "kundur.raw")
    app = make_app(workspace=tmp_path, bind_host="127.0.0.1", bind_port=8000)
    with TestClient(app, base_url="http://127.0.0.1:8000") as client:
        created = client.post("/api/sessions", json={"engine": "sienna"})
        if created.status_code == 409:
            pytest.skip(f"Sienna is not available: {created.json()['detail']}")
        assert created.status_code == 201, created.text
        session = created.json()["session_id"]
        loaded = client.post(
            f"/api/sessions/{session}/case", json={"primary_path": "kundur.raw"}
        )
        assert loaded.status_code == 200, loaded.text
        ac_response = _pflow(client, session, {})
        assert ac_response.status_code == 200, ac_response.text
        ac = ac_response.json()
        assert ac["converged"] is True
        dc_response = _pflow(client, session, {"method": "dc"})
        assert dc_response.status_code == 200, dc_response.text
        dc = dc_response.json()
        assert dc["converged"] is True
        ac_flows = {name: flow["p"] for name, flow in ac["line_flows"].items()}
        assert set(dc["line_flows"]) == set(ac_flows)
        # A DC power flow is lossless, so its flows differ from the AC ones by
        # where the losses go. The AC losses are the slack's output less the
        # loads' balance: 2734 MW of load less 2100 MW from the other three
        # machines leaves 634 MW, and the AC slack makes about 727 MW, so they
        # are about 93 MW. The slack's step-up transformer carries nearly all
        # of that difference back; no branch differs by more (5 percent kept
        # for the transformer's own loss).
        ac_losses = ac["summary"]["loss_p"]
        ac_slack = next(g["p"] for g in ac["generator_outputs"].values() if g["bus"] == 1)
        # Equal to the AC solve's tolerance.
        assert ac_losses == pytest.approx(ac_slack - 634.0, abs=1e-3)
        assert 80.0 < ac_losses < 110.0
        for name, flow in dc["line_flows"].items():
            assert abs(flow["p"] - ac_flows[name]) <= 1.05 * ac_losses, name
            assert flow["q"] is None
            assert flow["q_to"] is None
        # Generators other than the reference's keep their scheduled output in
        # both, which is 700 MW each in kundur.raw; their machines are rated
        # 900 MVA, so a value read off the device base would be 700/9.
        ref_bus = 1
        # A DC power flow is lossless: the reference generator makes up the
        # loads less the other three, 1159 + 1575 - 3 * 700 = 634 MW (by hand),
        # not its scheduled 745.861 MW.
        (slack,) = [g for g in dc["generator_outputs"].values() if g["bus"] == ref_bus]
        assert slack["p"] == pytest.approx(634.0, abs=1e-6)
        for name, output in dc["generator_outputs"].items():
            if output["bus"] == ref_bus:
                continue
            assert output["p"] == pytest.approx(700.0, abs=1e-6), name
            assert output["p"] == pytest.approx(ac["generator_outputs"][name]["p"], abs=1e-6)
