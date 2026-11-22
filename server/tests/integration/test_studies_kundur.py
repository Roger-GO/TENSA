"""``POST /studies`` on the Kundur case, both engines, through the real workers.

The same GENROU-only case and bus-8 fault as ``test_engines_agree.py``, run as
one study on both engines; the comparison the route answers is held to the
bounds that test holds, because the route runs the same ops on the same case
with the same load model.

Markers: ``sienna`` and ``integration``; skipped where the Sienna engine is
not available.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from tensa.api.app import make_app
from tensa.core.examples import _andes_cases_dir
from tensa.engines.sienna.environment import sienna_unavailable_reason

_REASON = sienna_unavailable_reason()

pytestmark = [
    pytest.mark.integration,
    pytest.mark.sienna,
    pytest.mark.skipif(_REASON is not None, reason=f"the Sienna engine is not available: {_REASON}"),
]


def _genrou_only(text: str) -> str:
    """The GENROU records of a PSS/E .dyr, each ended by its ``/``."""
    records = [r.strip() for r in text.split("/") if r.strip()]
    kept = [r for r in records if re.split(r"[\s,]+", r)[1].strip("'") == "GENROU"]
    return "".join(f"{r} /\n" for r in kept)


@pytest.fixture(scope="module")
def client(tmp_path_factory: pytest.TempPathFactory) -> Iterator[TestClient]:
    cases = _andes_cases_dir()
    assert cases is not None
    workspace = tmp_path_factory.mktemp("studies") / "ws"
    workspace.mkdir(mode=0o700)
    (workspace / "kundur.raw").write_bytes((cases / "kundur" / "kundur.raw").read_bytes())
    dyr = _genrou_only((cases / "kundur" / "kundur_full.dyr").read_text())
    assert dyr.count("'GENROU'") == 4
    (workspace / "kundur_genrou.dyr").write_text(dyr)
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
        "case": {"primary_path": "kundur.raw", "addfiles": ["kundur_genrou.dyr"]},
        "engines": ["andes", "sienna"],
        "study": study,
    }


def test_kundur_tds_study_on_both_engines(client: TestClient) -> None:
    study = {
        "tensa_study": 1,
        "routine": "tds",
        "options": {"t_end": 5.0, "step": 1 / 120},
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
        "record": [
            {"quantity": "rotor_speed", "of": "gen:*"},
            {"quantity": "voltage", "of": "bus:*"},
        ],
    }
    response = client.post("/api/studies", json=_study(study))
    assert response.status_code == 200, response.text
    data = response.json()
    assert len(data["outcomes"]) == 2
    for outcome in data["outcomes"]:
        assert outcome["ran"] is True, outcome
        assert outcome["document"]["status"] == "completed"
    andes = data["outcomes"][0]["document"]
    speeds = [s for s in andes["series"] if s["quantity"] == "rotor_speed"]
    voltages = [s for s in andes["series"] if s["quantity"] == "voltage"]
    assert len(speeds) == 4
    assert len(voltages) == 10
    assert len(data["comparisons"]) == 1
    comparison = data["comparisons"][0]
    assert comparison["engine"] == "sienna"
    for row in comparison["series"]:
        if row["quantity"] == "rotor_speed":
            assert row["swing_ref"] > 5e-3, row
            assert row["max_diff"] <= 2e-5, row
        if row["quantity"] == "voltage":
            assert row["max_diff_t"] == pytest.approx(1.0, abs=1e-6), row


def test_kundur_pflow_study(client: TestClient) -> None:
    response = client.post(
        "/api/studies", json=_study({"tensa_study": 1, "routine": "pflow"})
    )
    assert response.status_code == 200, response.text
    data = response.json()
    for outcome in data["outcomes"]:
        assert outcome["ran"] is True, outcome
        assert outcome["document"]["tables"]["pflow"]["converged"] is True
    assert len(data["comparisons"]) == 1
    comparison = data["comparisons"][0]
    assert comparison["operating_point_differs"] is False
    for row in comparison["power_flow"]["rows"]:
        assert row["within_tolerance"] is not False, row


def test_matrices_study_refusal_beside_result(client: TestClient) -> None:
    response = client.post(
        "/api/studies", json=_study({"tensa_study": 1, "routine": "matrices"})
    )
    assert response.status_code == 200, response.text
    data = response.json()
    andes, sienna = data["outcomes"]
    assert andes["ran"] is False
    assert andes["problem"]["status"] == 409
    assert andes["problem"]["category"] == "engine_unsupported"
    assert "sienna" in andes["problem"]["recovery"]["engines"]
    assert sienna["ran"] is True
    assert data["comparisons"] == []
