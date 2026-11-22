"""``POST /sessions/{id}/pflow`` against a real server, worker and ANDES case.

Covers the solver settings a request can name for one run: ``method`` (``NR``,
``dishonest``, ``NK``), ``n_factorize`` and ``linesearch``, beside the tolerance,
iteration limit and flags the route already took. Each is for the one run: the
request after reports the case's own setting again.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient

from tensa.api.app import make_app
from tensa.core.examples import seed_example_cases
from tensa.core.session import SessionManager

CASE = "ieee14_full.xlsx"


@pytest.fixture()
def client(tmp_path: Path) -> Iterator[TestClient]:
    """A TestClient over a real app with a real SessionManager and a seeded workspace."""
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    seed_example_cases(workspace)
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=2,
        idle_timeout_seconds=180.0,
    )
    mgr = SessionManager(max_sessions=2, idle_timeout=180.0)
    app.state.session_manager = mgr
    app.state.workspace = workspace
    # The Host/Origin middleware trusts loopback hosts only; TestClient's default
    # "testserver" host is refused with a 400.
    with TestClient(app, base_url="http://127.0.0.1:8000") as test_client:
        yield test_client


@pytest.fixture()
def session_id(client: TestClient) -> str:
    """A session with the IEEE 14-bus case loaded."""
    created = client.post("/api/sessions")
    assert created.status_code == 201, created.text
    sid = created.json()["session_id"]
    loaded = client.post(f"/api/sessions/{sid}/case", json={"primary_path": CASE})
    assert loaded.status_code == 200, loaded.text
    return str(sid)


def _run_pflow(
    client: TestClient, session_id: str, body: dict[str, Any] | None = None
) -> dict[str, Any]:
    response = client.post(f"/api/sessions/{session_id}/pflow", json=body or {})
    assert response.status_code == 200, response.text
    result: dict[str, Any] = response.json()
    return result


@pytest.mark.integration
def test_dishonest_method_applies_to_one_run_only(
    client: TestClient, session_id: str
) -> None:
    result = _run_pflow(client, session_id, {"method": "dishonest", "n_factorize": 2})
    assert result["converged"] is True
    settings = result["settings"]
    assert settings["method"] == "dishonest"
    assert settings["n_factorize"] == 2
    # The request left linesearch out: the case's own (ANDES's default) stands.
    assert settings["linesearch"] is True

    # The setting was for the one run: a plain request reports NR again.
    plain = _run_pflow(client, session_id)
    assert plain["converged"] is True
    assert plain["settings"]["method"] == "NR"


@pytest.mark.integration
def test_dishonest_reuses_the_jacobian_to_the_same_solution(client: TestClient) -> None:
    created = client.post("/api/sessions")
    assert created.status_code == 201, created.text
    kundur = str(created.json()["session_id"])
    loaded = client.post(f"/api/sessions/{kundur}/case", json={"primary_path": "kundur_full.xlsx"})
    assert loaded.status_code == 200, loaded.text

    nr = _run_pflow(client, kundur, {"method": "NR"})
    dishonest = _run_pflow(client, kundur, {"method": "dishonest", "n_factorize": 1})
    every_time = _run_pflow(client, kundur, {"method": "dishonest", "n_factorize": 100})
    assert nr["converged"] is True
    assert dishonest["converged"] is True
    assert every_time["converged"] is True
    # Reusing the Jacobian cannot beat rebuilding it on a case that converges
    # cleanly. On Kundur's system NR takes 4 iterations and the dishonest method
    # that factorises only on the first 22, a margin no other LAPACK moves it
    # across. Factorising on the first 100 is NR's own computation, iteration
    # for iteration, so that one is exact.
    assert dishonest["iterations"] > 2 * nr["iterations"]
    assert every_time["iterations"] == nr["iterations"]
    # Both land on the same solution.
    assert dishonest["bus_voltages"].keys() == nr["bus_voltages"].keys()
    for bus, voltage in nr["bus_voltages"].items():
        assert dishonest["bus_voltages"][bus] == pytest.approx(voltage, abs=1e-6)
        assert dishonest["bus_angles"][bus] == pytest.approx(nr["bus_angles"][bus], abs=1e-6)


@pytest.mark.integration
def test_newton_krylov_converges(client: TestClient, session_id: str) -> None:
    nr = _run_pflow(client, session_id)
    result = _run_pflow(client, session_id, {"method": "NK"})
    assert result["converged"] is True
    assert result["settings"]["method"] == "NK"
    # No iteration count: newton_krylov does not keep niter the way nr_solve
    # does. The mismatch is the residual it left, under SciPy's own tolerance
    # (about 6e-6 pu), which is also why the voltages are held to a margin over it.
    assert result["iterations"] == 0
    assert 0.0 <= result["mismatch"] < 1e-5
    for bus, voltage in nr["bus_voltages"].items():
        assert result["bus_voltages"][bus] == pytest.approx(voltage, abs=1e-4)

    plain = _run_pflow(client, session_id)
    assert plain["settings"]["method"] == "NR"
    assert plain["iterations"] == nr["iterations"]


@pytest.mark.integration
def test_linesearch_off_applies_to_one_run_only(
    client: TestClient, session_id: str
) -> None:
    result = _run_pflow(client, session_id, {"linesearch": False})
    assert result["converged"] is True
    assert result["settings"]["linesearch"] is False

    plain = _run_pflow(client, session_id)
    assert plain["converged"] is True
    assert plain["settings"]["linesearch"] is True


@pytest.mark.integration
def test_an_unknown_method_is_refused_and_writes_nothing(
    client: TestClient, session_id: str
) -> None:
    for method in ("foo", "nr"):
        refused = client.post(f"/api/sessions/{session_id}/pflow", json={"method": method})
        assert refused.status_code == 422, refused.text
        assert "method must be one of" in refused.text
        assert method in refused.text
    for body in ({"n_factorize": 0}, {"n_factorize": 101}):
        refused = client.post(f"/api/sessions/{session_id}/pflow", json=body)
        assert refused.status_code == 422, refused.text

    # Nothing was written: the session still runs a plain power flow.
    plain = _run_pflow(client, session_id)
    assert plain["converged"] is True
    assert plain["settings"]["method"] == "NR"


@pytest.mark.integration
def test_a_run_with_no_body_reports_the_andes_defaults(
    client: TestClient, session_id: str
) -> None:
    result = _run_pflow(client, session_id)
    assert result["converged"] is True
    settings = result["settings"]
    assert settings["method"] == "NR"
    assert settings["n_factorize"] == 4
    assert settings["linesearch"] is True
