"""Integration tests of the Sienna multi-stage simulation with a real Julia.

Marked ``sienna`` and ``integration``: they start a worker with Julia and
drive ``POST /sessions/{id}/sim`` on the hand-worked case written to a
temporary workspace. The hand enumeration of the commitment patterns is in
``runtests_ops.jl`` beside the Julia test: generator A on in hours 2 and 3
with one start-up, B serving the rest.
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
    """One app and one client on a workspace holding the sim case, shared by
    the tests (Julia starts once). The fixture is the one of
    ``test_sienna_dispatch.py``."""
    from fastapi.testclient import TestClient

    from tensa.api.app import make_app

    workspace = tmp_path_factory.mktemp("sim-ws")
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


def _profile() -> list[float]:
    # 40, 120, 150, 40 MW over the first four hours (factors 0.4, 1.2, 1.5,
    # 0.4 of the 100 MW load, each held for its four quarter-hours), then
    # 40 MW for the rest of the day.
    return [0.4] * 4 + [1.2] * 4 + [1.5] * 4 + [0.4] * 84


def test_sim_end_to_end_commitment_kept(client: tuple[Any, Path]) -> None:
    """The enumeration's optimum: A on in hours 2 and 3 (its 50 MW minimum
    cannot run in an hour of 40 MW), one start-up; A at 120 and 150 MW, B at
    40 MW in hours 1 and 4 and for the rest of the day. The real-time stage,
    held to that commitment, dispatches each 15-minute period of an hour at
    that hour's day-ahead MW; without the feed-forward it would be free to
    run A whenever A is locally cheaper. DA cost: energy
    10 * 270 + 30 * 40 * 22 = 29100 $ plus one start-up of 500 $, 29600 $;
    RT the energy alone, 29100 $."""
    test_client, _ = client
    session = _session(test_client, "uc_case.m")
    response = test_client.post(
        f"/api/sessions/{session}/sim",
        json={"load_profile": _profile(), "network_model": "copper_plate"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "completed"
    assert body["engine"] == "sienna"
    assert body["interval_minutes"] == 60
    da, rt = body["stages"]
    assert (da["kind"], da["resolution_minutes"], da["steps"]) == ("uc", 60, 24)
    assert (rt["kind"], rt["resolution_minutes"], rt["steps"]) == ("dispatch", 15, 96)
    assert da["commitment"]["gen:1-1"]["values"] == pytest.approx(
        [0.0, 1.0, 1.0] + [0.0] * 21, abs=1e-6
    )
    assert da["dispatch"]["gen:1-1"]["values"] == pytest.approx(
        [0.0, 120.0, 150.0] + [0.0] * 21, abs=1e-4
    )
    assert da["dispatch"]["gen:2-1"]["values"] == pytest.approx(
        [40.0, 0.0, 0.0] + [40.0] * 21, abs=1e-4
    )
    # The feed-forward: every real-time period of hours 1 and 4 to 24 has A
    # at 0 MW, and each period of hours 2 and 3 is at the hour's MW.
    rt_a = rt["dispatch"]["gen:1-1"]["values"]
    rt_b = rt["dispatch"]["gen:2-1"]["values"]
    for t in list(range(0, 4)) + list(range(12, 96)):
        assert rt_a[t] == pytest.approx(0.0, abs=1e-6)
    assert rt_a[4:8] == pytest.approx([120.0] * 4, abs=1e-4)
    assert rt_a[8:12] == pytest.approx([150.0] * 4, abs=1e-4)
    assert rt_b[0:4] == pytest.approx([40.0] * 4, abs=1e-4)
    assert rt_b[12:96] == pytest.approx([40.0] * 84, abs=1e-4)
    assert da["objective"] == pytest.approx(29600.0, rel=1e-6)
    assert rt["objective"] == pytest.approx(29100.0, rel=1e-6)
    assert body["slacks"] == []


def test_sim_a_psse_case_is_422(client: tuple[Any, Path]) -> None:
    test_client, _ = client
    session = _session(test_client, "kundur.raw")
    response = test_client.post(
        f"/api/sessions/{session}/sim", json={"load_profile": _profile()}
    )
    assert response.status_code == 422, response.text
    assert response.json()["detail"].startswith(
        "the case has no generator cost data; economic dispatch needs "
        "gencost records, which a PSS/E .raw case does not carry"
    )


def test_sim_andes_session_is_409(client: tuple[Any, Path]) -> None:
    test_client, _ = client
    session = _session(test_client, "uc_case.m", engine="andes")
    response = test_client.post(
        f"/api/sessions/{session}/sim", json={"load_profile": _profile()}
    )
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert "'run_sim' is not available with the andes engine" in detail
    assert "sienna" in detail


def test_sim_session_system_unchanged(client: tuple[Any, Path]) -> None:
    test_client, _ = client
    session = _session(test_client, "uc_case.m")
    before = test_client.get(f"/api/sessions/{session}/topology").json()
    response = test_client.post(
        f"/api/sessions/{session}/sim", json={"load_profile": _profile()}
    )
    assert response.status_code == 200, response.text
    after = test_client.get(f"/api/sessions/{session}/topology").json()
    assert after == before
    # A power flow still solves afterwards: the time series went to the copy.
    pflow = test_client.post(f"/api/sessions/{session}/pflow", json={})
    assert pflow.status_code == 200, pflow.text
    assert pflow.json()["converged"] is True
