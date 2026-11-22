"""Integration tests of the Sienna network matrices with a real Julia.

Marked ``sienna`` and ``integration``: they start a worker with Julia and load
the three-bus triangle built in code in ``runtests_net.jl``'s Python twin, a
PSS/E case written to a temporary workspace. The PTDF and LODF values are the
hand computation of the unit, read against the orientation the answer's axes
report.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

pytestmark = [pytest.mark.sienna, pytest.mark.integration]

# The three-bus triangle as a PSS/E RAW case: buses 1 (reference), 2 and 3,
# lines 1-2, 1-3 and 2-3, each r = 0 and x = 0.1 pu on a 100 MVA base.
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


@pytest.fixture(scope="module")
def triangle(tmp_path_factory: pytest.TempPathFactory) -> Iterator[tuple[Any, str]]:
    """One app, one client and one Sienna session with the triangle loaded,
    through a real worker, shared by the matrix tests (Julia starts once). The
    client talks to the host the app was made for, which the Host check takes."""
    from fastapi.testclient import TestClient

    from tensa.api.app import make_app

    workspace = tmp_path_factory.mktemp("network-ws")
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

def _matrix(client: Any, session_id: Any, kind: str) -> dict[str, Any]:
    response = client.get(f"/api/sessions/{session_id}/network-matrix?kind={kind}")
    assert response.status_code == 200, response.text
    return response.json()


def _sign(arc: dict[str, Any], from_bus: int, to_bus: int) -> float:
    """+1 when the arc runs ``from_bus`` to ``to_bus``, -1 the other way."""
    if arc["from"] == from_bus and arc["to"] == to_bus:
        return 1.0
    assert arc["from"] == to_bus and arc["to"] == from_bus
    return -1.0


def test_ptdf_matches_hand_computation(triangle: tuple[Any, str]) -> None:
    client, session_id = triangle
    body = _matrix(client, session_id, "ptdf")
    # Hand computation (the comment of the unit): with the injection withdrawn
    # at the reference bus 1, the reduced susceptance matrix over buses 2 and 3
    # is [[20, -10], [-10, 20]], its inverse [[1/15, 1/30], [1/30, 1/15]], and
    # the flow on line i-j is (theta_i - theta_j) / x. For an injection at
    # bus 2: line 1-2 carries -2/3, line 1-3 -1/3, line 2-3 +1/3. For bus 3:
    # line 1-2 carries -1/3, line 1-3 -2/3, line 2-3 -1/3. The reference
    # bus's column is zero. The signs are for flow from the line's first bus
    # to its second; the orientation is read from the axes, not assumed.
    bus_col = {entry["bus"]: i for i, entry in enumerate(body["cols"])}
    assert set(bus_col) == {1, 2, 3}
    want = {
        (1, 2): {2: -2.0 / 3.0, 3: -1.0 / 3.0},
        (1, 3): {2: -1.0 / 3.0, 3: -2.0 / 3.0},
        (2, 3): {2: 1.0 / 3.0, 3: -1.0 / 3.0},
    }
    seen: set[tuple[int, int]] = set()
    for row, arc in zip(body["values"], body["rows"], strict=True):
        pair = (min(arc["from"], arc["to"]), max(arc["from"], arc["to"]))
        seen.add(pair)
        sign = _sign(arc, *pair)
        for bus in (1, 2, 3):
            expected = sign * want[pair].get(bus, 0.0) if bus != 1 else 0.0
            assert row[bus_col[bus]] == pytest.approx(expected, abs=1e-9)
    assert seen == {(1, 2), (1, 3), (2, 3)}
    assert body["ref_buses"] == ["bus:1"]
    assert body["distributed_slack"] is False


def test_lodf_of_the_triangle(triangle: tuple[Any, str]) -> None:
    client, session_id = triangle
    body = _matrix(client, session_id, "lodf")
    # The outage of line 1-2 moves its whole pre-outage flow onto the path
    # 1-3-2: LODF(1-3, out 1-2) = 1 and LODF(2-3, out 1-2) = -1 in the
    # 1-to-3 and 2-to-3 orientations. Every diagonal entry is -1 by
    # PowerNetworkMatrices' convention (lodf_calculations.jl: "Diagonal
    # Elements: Always -1 (100% flow reduction on the outaged line itself)").
    rows = body["rows"]
    cols = body["cols"]
    values = body["values"]
    for i, arc in enumerate(rows):
        assert values[i][i] == pytest.approx(-1.0, abs=1e-9)
        for j, outage in enumerate(cols):
            if i == j:
                continue
            pair = (min(arc["from"], arc["to"]), max(arc["from"], arc["to"]))
            out_pair = (min(outage["from"], outage["to"]), max(outage["from"], outage["to"]))
            if out_pair != (1, 2):
                continue
            sign = _sign(arc, *pair)
            expected = sign * (1.0 if pair == (1, 3) else -1.0)
            assert values[i][j] == pytest.approx(expected, abs=1e-9)


def test_ybus_symmetric(triangle: tuple[Any, str]) -> None:
    client, session_id = triangle
    body = _matrix(client, session_id, "ybus")
    entries = {(e["row"], e["col"]): e for e in body["entries"]}
    for (row, col), entry in entries.items():
        twin = entries[(col, row)]
        assert entry["re"] == pytest.approx(twin["re"], abs=1e-9)
        assert entry["im"] == pytest.approx(twin["im"], abs=1e-9)
    # Admittance conservation: each diagonal is the negative sum of the
    # off-diagonal entries of its row (no shunts in this case).
    for bus in range(3):
        off = sum(
            entry["im"] for (row, col), entry in entries.items() if row == bus and col != bus
        )
        assert entries[(bus, bus)]["im"] == pytest.approx(-off, abs=1e-9)


def test_incidence_rows(triangle: tuple[Any, str]) -> None:
    client, session_id = triangle
    body = _matrix(client, session_id, "incidence")
    for row, arc in zip(body["values"], body["rows"], strict=True):
        assert sum(row) == pytest.approx(0.0, abs=1e-12)
        assert sorted(row) == [-1.0, 0.0, 1.0]
        bus_col = {entry["bus"]: i for i, entry in enumerate(body["cols"])}
        assert row[bus_col[arc["from"]]] == 1.0
        assert row[bus_col[arc["to"]]] == -1.0


def test_andes_session_refused(tmp_path: Path) -> None:
    from fastapi.testclient import TestClient

    from tensa.api.app import make_app

    app = make_app(workspace=tmp_path, bind_host="127.0.0.1", bind_port=8000)
    with TestClient(app, base_url="http://127.0.0.1:8000") as client:
        created = client.post("/api/sessions", json={"engine": "andes"})
        assert created.status_code == 201, created.text
        session = created.json()["session_id"]
        response = client.get(f"/api/sessions/{session}/network-matrix?kind=ptdf")
        assert response.status_code == 409
        assert "sienna" in response.json()["detail"]
