"""Integration tests of the Sienna unit commitment with a real Julia.

Marked ``sienna`` and ``integration``: they start a worker with Julia and
drive ``POST /sessions/{id}/uc`` on the hand-worked case written to a
temporary workspace. The hand enumeration of the sixteen commitment patterns
is in ``runtests_ops.jl`` beside the Julia test; the optimum is generator A
on in hours 2 and 3 with one start-up, 5600 $.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from tensa.core.examples import _andes_cases_dir

pytestmark = [pytest.mark.sienna, pytest.mark.integration]

# The hand-worked case of runtests_ops.jl: generator A (bus 1), 10 $/MWh,
# PMIN 50 MW, PMAX 200 MW, start-up 500 $; generator B (bus 2), 30 $/MWh,
# PMIN 0, PMAX 200 MW, no start-up cost; a load of 100 MW at bus 3.
_UC_CASE = """function mpc = uc_case
mpc.version = '2';
mpc.baseMVA = 100.0;
mpc.bus = [
  1  3  0  0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;
  2  2  0  0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;
  3  1  100.0  30.0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;
];
mpc.gen = [
  1  0  0  9999  -9999  1.0  100.0  1  200.0  50.0  0  0  0  0  0  0  0  0  0  0  0;
  2  0  0  9999  -9999  1.0  100.0  1  200.0  0  0  0  0  0  0  0  0  0  0  0  0;
];
mpc.branch = [
  1  2  0.0  0.1  0.0  0  0  0  0  0  1  -360  360;
  1  3  0.0  0.1  0.0  0  0  0  0  0  1  -360  360;
  2  3  0.0  0.1  0.0  0  0  0  0  0  1  -360  360;
];
mpc.gencost = [
  2  500.0  0  3  0.0  10.0  0.0;
  2  0  0  3  0.0  30.0  0.0;
];
"""


@pytest.fixture(scope="module")
def client(tmp_path_factory: pytest.TempPathFactory) -> Iterator[tuple[Any, Path]]:
    """One app and one client on a workspace holding the uc case, shared by
    the tests (Julia starts once). The fixture is the one of
    ``test_sienna_dispatch.py``."""
    from fastapi.testclient import TestClient

    from tensa.api.app import make_app

    workspace = tmp_path_factory.mktemp("uc-ws")
    (workspace / "uc_case.m").write_text(_UC_CASE)
    cases = _andes_cases_dir()
    assert cases is not None
    (workspace / "kundur.raw").write_bytes((cases / "kundur" / "kundur.raw").read_bytes())
    app = make_app(workspace=workspace, bind_host="127.0.0.1", bind_port=8000)
    with TestClient(app, base_url="http://127.0.0.1:8000") as test_client:
        yield test_client, workspace


def _session(client: Any, case: str, engine: str = "sienna") -> str:
    created = client.post("/api/sessions", json={"engine": engine})
    if created.status_code == 409 and engine == "sienna":
        pytest.skip(f"Sienna is not available: {created.json()['detail']}")
    assert created.status_code == 201, created.text
    session = created.json()["session_id"]
    loaded = client.post(f"/api/sessions/{session}/case", json={"primary_path": case})
    assert loaded.status_code == 200, loaded.text
    return session


def _uc(client: Any, session: str, body: dict[str, Any]) -> Any:
    return client.post(f"/api/sessions/{session}/uc", json=body)


def _body() -> dict[str, Any]:
    return {
        "network_model": "copper_plate",
        "horizon_h": 4,
        "resolution_min": 60,
        "series": [0.4, 1.2, 1.5, 0.4],
    }


def test_uc_hand_optimum(client: tuple[Any, Path]) -> None:
    """The enumeration's optimum: A on in hours 2 and 3 (its 50 MW minimum
    cannot run in an hour of 40 MW), one start-up; A at 120 and 150 MW, B at
    40 MW in hours 1 and 4; energy 10*270 + 30*80 = 5100 $, start-up 500 $,
    fixed 0 $, total 5600 $, against 10500 $ for B alone."""
    test_client, _ = client
    session = _session(test_client, "uc_case.m")
    response = _uc(test_client, session, _body())
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "completed"
    assert body["generators"]["gen:1-1"]["on"] == [False, True, True, False]
    assert body["generators"]["gen:1-1"]["p_mw"] == pytest.approx(
        [0.0, 120.0, 150.0, 0.0], abs=1e-4
    )
    # B (no minimum, no start-up, no fixed cost) on at 0 MW costs nothing, so
    # its on/off pattern in hours 2 and 3 is not unique: only its MW is held.
    assert body["generators"]["gen:2-1"]["p_mw"] == pytest.approx(
        [40.0, 0.0, 0.0, 40.0], abs=1e-4
    )
    assert body["cost"]["energy"] == pytest.approx(5100.0, rel=1e-6)
    assert body["cost"]["startup"] == pytest.approx(500.0, rel=1e-6)
    assert body["cost"]["fixed"] == pytest.approx(0.0, abs=1e-6)
    assert body["cost"]["total"] == pytest.approx(5600.0, rel=1e-6)
    assert body["objective"] == pytest.approx(body["objective_check"], rel=1e-6)
    assert body["slacks"] == []
    assert len(body["periods"]) == 4
    assert body["total_load_mw"] == [40.0, 120.0, 150.0, 40.0]


def test_uc_overrides_through_the_route(client: tuple[Any, Path]) -> None:
    """With a minimum up time of 3 hours, A started in hour 2 would have to
    run hours 2 to 4, and in hour 4 its 50 MW minimum cannot serve 40 MW;
    started in hour 1 it cannot run either. So A stays off and B serves the
    whole 350 MWh at 30 $/MWh: 10500 $. An implementation that drops the
    override answers the 5600 $ optimum."""
    test_client, _ = client
    session = _session(test_client, "uc_case.m")
    response = _uc(
        test_client,
        session,
        {**_body(), "overrides": {"gen:1-1": {"min_up_h": 3.0}}},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["generators"]["gen:1-1"]["on"] == [False, False, False, False]
    assert body["generators"]["gen:2-1"]["p_mw"] == pytest.approx([40.0, 120.0, 150.0, 40.0], abs=1e-4)
    assert body["cost"]["total"] == pytest.approx(10500.0, rel=1e-6)


def test_uc_a_psse_case_is_422(client: tuple[Any, Path]) -> None:
    test_client, _ = client
    session = _session(test_client, "kundur.raw")
    response = _uc(test_client, session, _body())
    assert response.status_code == 422, response.text
    assert response.json()["detail"].startswith(
        "the case has no generator cost data; economic dispatch needs "
        "gencost records, which a PSS/E .raw case does not carry"
    )


def test_uc_bad_series_is_422(client: tuple[Any, Path]) -> None:
    test_client, _ = client
    session = _session(test_client, "uc_case.m")
    response = _uc(test_client, session, {**_body(), "series": [1.0]})
    assert response.status_code == 422, response.text
    assert "4 periods of 60 minutes over 4 hours" in response.json()["detail"]


def test_uc_session_system_unchanged(client: tuple[Any, Path]) -> None:
    test_client, _ = client
    session = _session(test_client, "uc_case.m")
    before = test_client.get(f"/api/sessions/{session}/topology").json()
    response = _uc(test_client, session, _body())
    assert response.status_code == 200, response.text
    after = test_client.get(f"/api/sessions/{session}/topology").json()
    assert after == before
    # A power flow still solves afterwards: the forecast went to the copy.
    pflow = test_client.post(f"/api/sessions/{session}/pflow", json={})
    assert pflow.status_code == 200, pflow.text
    assert pflow.json()["converged"] is True


def test_uc_andes_session_is_409(client: tuple[Any, Path]) -> None:
    test_client, _ = client
    session = _session(test_client, "uc_case.m", engine="andes")
    response = _uc(test_client, session, _body())
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert "'run_uc' is not available with the andes engine" in detail
    assert "sienna" in detail
