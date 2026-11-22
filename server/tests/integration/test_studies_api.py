"""``POST /studies`` disturbance mappings on kundur_full, ANDES only (unit f2).

A ``gen_trip`` must toggle the unit's machine (a Toggle on the static
generator leaves every rotor speed at 1.0). A ``load_step`` and a ``setpoint``
are refused for the ANDES engine with the reason: its time-domain run holds
loads as constant impedance from the start, and no ANDES parameter takes a
set-point in MW that has been checked. No Julia needed.

Marker: ``integration``.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from tensa.api.app import make_app
from tensa.core.examples import _andes_cases_dir

pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def client(tmp_path_factory: pytest.TempPathFactory) -> Iterator[TestClient]:
    cases = _andes_cases_dir()
    assert cases is not None
    workspace = tmp_path_factory.mktemp("studies-api") / "ws"
    workspace.mkdir(mode=0o700)
    (workspace / "kundur.raw").write_bytes((cases / "kundur" / "kundur.raw").read_bytes())
    (workspace / "kundur_full.dyr").write_bytes(
        (cases / "kundur" / "kundur_full.dyr").read_bytes()
    )
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        extra_allowed_hosts=frozenset({"testserver"}),
        extra_allowed_origins=frozenset({"http://testserver", "http://localhost"}),
    )
    with TestClient(app) as c:
        yield c


def _study(study: dict[str, Any]) -> dict[str, Any]:
    return {
        "case": {"primary_path": "kundur.raw", "addfiles": ["kundur_full.dyr"]},
        "engines": ["andes"],
        "study": study,
    }


def _tds_study(disturbance: dict[str, Any]) -> dict[str, Any]:
    return {
        "tensa_study": 1,
        "routine": "tds",
        "options": {"t_end": 2.0, "step": 1 / 120},
        "load_model": "impedance",
        "disturbances": [disturbance],
        "record": [{"quantity": "rotor_speed", "of": "gen:1-1"}],
    }


def test_gen_trip_toggles_the_machine(client: TestClient) -> None:
    """A trip of unit 2 swings unit 1. Measured against ANDES on kundur_full
    with the file's own event off: a Toggle on GENROU 2 at 1 s moves the other
    three machines' speeds by 9e-3 to 1.1e-2 pu within 2 s, and a Toggle on the
    static generator PV 2 (the old mapping) moves nothing. (The tripped
    machine's own states freeze in ANDES, so its speed is not what to watch.)"""
    study = _tds_study({"kind": "gen_trip", "target": "gen:2-1", "t": 1.0})
    response = client.post("/api/studies", json=_study(study))
    assert response.status_code == 200, response.text
    outcome = response.json()["outcomes"][0]
    assert outcome["ran"] is True, outcome
    document = outcome["document"]
    assert document["status"] == "completed"
    (series,) = [
        s for s in document["series"] if s["quantity"] == "rotor_speed" and s["of"] == "gen:1-1"
    ]
    before = [y for t, y in zip(series["t"], series["y"], strict=True) if t < 1.0]
    after = [y for t, y in zip(series["t"], series["y"], strict=True) if t >= 1.0]
    assert before and after
    assert max(abs(y - 1.0) for y in before) < 1e-4
    assert max(abs(y - 1.0) for y in after) > 1e-3


def test_load_step_is_refused_for_andes(client: TestClient) -> None:
    pflow = client.post("/api/studies", json=_study({"tensa_study": 1, "routine": "pflow"}))
    assert pflow.status_code == 200, pflow.text
    loads = pflow.json()["outcomes"][0]["document"]["tables"]["pflow"]["loads"]
    load_key = loads[0]["key"]
    study = _tds_study({"kind": "load_step", "target": load_key, "t": 1.0, "p_mw": 1017.0, "q_mvar": 100.0})
    response = client.post("/api/studies", json=_study(study))
    assert response.status_code == 422, response.text
    assert "constant impedance" in response.text


def test_setpoint_is_refused_for_andes(client: TestClient) -> None:
    study = _tds_study(
        {"kind": "setpoint", "target": "gen:2-1", "signal": "p_ref", "value": 0.7, "t": 1.0}
    )
    response = client.post("/api/studies", json=_study(study))
    assert response.status_code == 422, response.text
    assert "p_ref" in response.text
