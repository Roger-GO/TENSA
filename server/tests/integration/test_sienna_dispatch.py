"""Integration tests of the Sienna economic dispatch with a real Julia.

Marked ``sienna`` and ``integration``: they start a worker with Julia and
drive ``POST /sessions/{id}/dispatch`` on MATPOWER cases written to a
temporary workspace. The hand computations are beside each test; the cost
unit is the one a trial on the engine's environment settled (the curves are
labelled as natural units, so the objective is the true cost in $/h of power
in MW).
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from tensa.core.examples import _andes_cases_dir

pytestmark = [pytest.mark.sienna, pytest.mark.integration]

# The two-generator one-load MATPOWER case of runtests_ops.jl: bus 1 the
# reference with generator A, bus 2 with generator B, bus 3 with a load of
# 150 MW, three lines of x = 0.1 pu on a 100 MVA base.
_TWO_GEN = """function mpc = two_gen
mpc.version = '2';
mpc.baseMVA = 100.0;
mpc.bus = [
  1  3  0  0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;
  2  2  0  0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;
  3  1  150.0  30.0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;
];
mpc.gen = [
  1  0  0  9999  -9999  1.0  100.0  1  200.0  0  0  0  0  0  0  0  0  0  0  0  0;
  2  0  0  9999  -9999  1.0  {mbase_b}  1  200.0  0  0  0  0  0  0  0  0  0  0  0  0;
];
mpc.branch = [
  1  2  0.0  0.1  0.0  0  0  0  0  0  1  -360  360;
  1  3  0.0  0.1  0.0  0  0  0  0  0  1  -360  360;
  2  3  0.0  0.1  0.0  0  0  0  0  0  1  -360  360;
];
mpc.gencost = [
  2  0  0  3  {cost_a}  0.0;
  2  0  0  3  {cost_b}  0.0;
];
"""

_NO_COST = """function mpc = no_cost
mpc.version = '2';
mpc.baseMVA = 100.0;
mpc.bus = [
  1  3  0  0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;
  2  2  0  0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;
  3  1  150.0  30.0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;
];
mpc.gen = [
  1  0  0  9999  -9999  1.0  100.0  1  100.0  0  0  0  0  0  0  0  0  0  0  0  0;
  2  0  0  9999  -9999  1.0  100.0  1  100.0  0  0  0  0  0  0  0  0  0  0  0  0;
];
mpc.branch = [
  1  2  0.0  0.1  0.0  0  0  0  0  0  1  -360  360;
  1  3  0.0  0.1  0.0  0  0  0  0  0  1  -360  360;
  2  3  0.0  0.1  0.0  0  0  0  0  0  1  -360  360;
];
"""


# Generator A (bus 1, 10 $/MWh) and B (bus 2, 20 $/MWh), 100 MW each, meet
# 150 MW at bus 3 over a triangle of equal reactances whose line 1-3 is rated
# 80 MVA.
_LIMITED = """function mpc = limited
mpc.version = '2';
mpc.baseMVA = 100.0;
mpc.bus = [
  1  3  0  0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;
  2  2  0  0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;
  3  1  150.0  30.0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;
];
mpc.gen = [
  1  0  0  9999  -9999  1.0  100.0  1  100.0  0  0  0  0  0  0  0  0  0  0  0  0;
  2  0  0  9999  -9999  1.0  100.0  1  100.0  0  0  0  0  0  0  0  0  0  0  0  0;
];
mpc.branch = [
  1  2  0.0  0.1  0.0  0  0  0  0  0  1  -360  360;
  1  3  0.0  0.1  0.0  80.0  0  0  0  0  1  -360  360;
  2  3  0.0  0.1  0.0  0  0  0  0  0  1  -360  360;
];
mpc.gencost = [
  2  0  0  3  0.0  10.0  0.0;
  2  0  0  3  0.0  20.0  0.0;
];
"""


@pytest.fixture(scope="module")
def client(tmp_path_factory: pytest.TempPathFactory) -> Iterator[tuple[Any, Path]]:
    """One app and one client on a workspace holding the dispatch cases,
    shared by the tests (Julia starts once). The fixture is the one of
    ``test_sienna_network.py``: the client talks to the host the app was made
    for, which the Host check takes."""
    from fastapi.testclient import TestClient

    from tensa.api.app import make_app

    workspace = tmp_path_factory.mktemp("dispatch-ws")
    (workspace / "linear.m").write_text(
        _TWO_GEN.format(mbase_b="100.0", cost_a="0.0  10.0", cost_b="0.0  20.0")
    )
    (workspace / "quadratic.m").write_text(
        _TWO_GEN.format(mbase_b="100.0", cost_a="0.1  10.0", cost_b="0.1  20.0")
    )
    (workspace / "quadratic_200.m").write_text(
        _TWO_GEN.format(mbase_b="200.0", cost_a="0.1  10.0", cost_b="0.1  20.0")
    )
    (workspace / "no_cost.m").write_text(_NO_COST)
    (workspace / "limited.m").write_text(_LIMITED)
    cases = _andes_cases_dir()
    assert cases is not None
    (workspace / "kundur.raw").write_bytes((cases / "kundur" / "kundur.raw").read_bytes())
    app = make_app(workspace=workspace, bind_host="127.0.0.1", bind_port=8000)
    with TestClient(app, base_url="http://127.0.0.1:8000") as test_client:
        yield test_client, workspace


def _session(client: Any, case: str) -> str:
    created = client.post("/api/sessions", json={"engine": "sienna"})
    if created.status_code == 409:
        pytest.skip(f"Sienna is not available: {created.json()['detail']}")
    assert created.status_code == 201, created.text
    session = created.json()["session_id"]
    loaded = client.post(f"/api/sessions/{session}/case", json={"primary_path": case})
    assert loaded.status_code == 200, loaded.text
    return session


def _dispatch(client: Any, session: str, body: dict[str, Any]) -> Any:
    return client.post(f"/api/sessions/{session}/dispatch", json=body)


def test_linear_costs_copper_plate(client: tuple[Any, Path]) -> None:
    test_client, _ = client
    session = _session(test_client, "linear.m")
    response = _dispatch(test_client, session, {"network_model": "copper_plate"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "completed"
    # By hand: costs 10 and 20 $/MWh, load 150 MW; the cheaper generator A
    # takes all 150 MW, B takes 0, the cost is 150 * 10 = 1500 $/h.
    assert body["generators"]["gen:1-1"]["p_mw"] == pytest.approx(150.0, abs=1e-6)
    assert body["generators"]["gen:2-1"]["p_mw"] == pytest.approx(0.0, abs=1e-6)
    assert body["objective_per_h"] == pytest.approx(1500.0, rel=1e-6)
    assert body["objective_check_per_h"] == pytest.approx(1500.0, rel=1e-6)
    assert body["objective_per_h"] == pytest.approx(
        body["objective_check_per_h"], rel=1e-6
    )
    assert body["total_load_mw"] == 150.0
    assert body["total_dispatch_mw"] == pytest.approx(150.0, abs=1e-6)
    assert body["slacks"] == []


def test_quadratic_costs_equal_marginal_cost_split(client: tuple[Any, Path]) -> None:
    test_client, _ = client
    session = _session(test_client, "quadratic.m")
    response = _dispatch(test_client, session, {"network_model": "copper_plate"})
    assert response.status_code == 200, response.text
    body = response.json()
    # By hand: A 0.1 P^2 + 10 P, B 0.1 P^2 + 20 P, load 150 MW; equal
    # marginal cost 0.2 PA + 10 = 0.2 PB + 20 with PA + PB = 150 gives
    # PA = 100 MW and PB = 50 MW; cost 0.1*100^2 + 1000 + 0.1*50^2 + 1000
    # = 3250 $/h. A wrong cost unit gives a different split.
    assert body["generators"]["gen:1-1"]["p_mw"] == pytest.approx(100.0, abs=1e-4)
    assert body["generators"]["gen:2-1"]["p_mw"] == pytest.approx(50.0, abs=1e-4)
    assert body["objective_per_h"] == pytest.approx(3250.0, rel=1e-6)
    assert body["objective_check_per_h"] == pytest.approx(3250.0, rel=1e-6)


def test_quadratic_costs_with_a_device_base(client: tuple[Any, Path]) -> None:
    test_client, _ = client
    session = _session(test_client, "quadratic_200.m")
    response = _dispatch(test_client, session, {"network_model": "copper_plate"})
    assert response.status_code == 200, response.text
    body = response.json()
    # Generator B's Mbase is 200 MVA; the answer is the same 100/50 split.
    assert body["generators"]["gen:1-1"]["p_mw"] == pytest.approx(100.0, abs=1e-4)
    assert body["generators"]["gen:2-1"]["p_mw"] == pytest.approx(50.0, abs=1e-4)
    assert body["objective_per_h"] == pytest.approx(3250.0, rel=1e-6)


def test_dc_and_ptdf_complete(client: tuple[Any, Path]) -> None:
    test_client, _ = client
    session = _session(test_client, "linear.m")
    for model in ("dc", "ptdf"):
        response = _dispatch(test_client, session, {"network_model": model})
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "completed"


def test_dc_and_ptdf_hold_the_line_limit(client: tuple[Any, Path]) -> None:
    """By hand: the flow on line 1-3 is (2 PA + PB) / 3 = 50 + PA / 3, so its
    80 MW rating holds A to 90 MW and B takes 60 MW, at 2100 $/h. The copper
    plate has no lines: 100 and 50 MW, 2000 $/h."""
    test_client, _ = client
    session = _session(test_client, "limited.m")
    for model, (pa, pb, cost) in (
        ("dc", (90.0, 60.0, 2100.0)),
        ("ptdf", (90.0, 60.0, 2100.0)),
        ("copper_plate", (100.0, 50.0, 2000.0)),
    ):
        response = _dispatch(test_client, session, {"network_model": model})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["network_model"] == model
        assert body["generators"]["gen:1-1"]["p_mw"] == pytest.approx(pa, abs=1e-4), model
        assert body["generators"]["gen:2-1"]["p_mw"] == pytest.approx(pb, abs=1e-4), model
        assert body["objective_per_h"] == pytest.approx(cost, rel=1e-6), model


def test_a_psse_case_is_422(client: tuple[Any, Path]) -> None:
    """A .raw case has no cost data, and PowerSystems gives its generators a
    placeholder cost, so the dispatch is refused before it runs."""
    test_client, _ = client
    session = _session(test_client, "kundur.raw")
    response = _dispatch(test_client, session, {"network_model": "copper_plate"})
    assert response.status_code == 422, response.text
    assert response.json()["detail"].startswith(
        "the case has no generator cost data; economic dispatch needs gencost records, "
        "which a PSS/E .raw case does not carry"
    )


def test_no_cost_data_is_422(client: tuple[Any, Path]) -> None:
    test_client, _ = client
    session = _session(test_client, "no_cost.m")
    response = _dispatch(test_client, session, {"network_model": "copper_plate"})
    assert response.status_code == 422
    assert response.json()["detail"] == (
        "the case has no generator cost data; economic dispatch needs gencost records"
    )


def test_the_session_system_is_unchanged(client: tuple[Any, Path]) -> None:
    test_client, _ = client
    session = _session(test_client, "linear.m")
    before = test_client.get(f"/api/sessions/{session}/topology").json()
    response = _dispatch(test_client, session, {"network_model": "copper_plate"})
    assert response.status_code == 200, response.text
    after = test_client.get(f"/api/sessions/{session}/topology").json()
    assert after == before
    # A power flow still solves afterwards: the forecast went to the copy.
    pflow = test_client.post(f"/api/sessions/{session}/pflow", json={})
    assert pflow.status_code == 200, pflow.text
    assert pflow.json()["converged"] is True


def test_duals_opt_in(client: tuple[Any, Path]) -> None:
    test_client, _ = client
    session = _session(test_client, "linear.m")
    response = _dispatch(test_client, session, {"network_model": "dc", "duals": True})
    assert response.status_code == 200, response.text
    assert isinstance(response.json()["duals"], list)
