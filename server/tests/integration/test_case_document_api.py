"""Route tests of ``GET /sessions/{id}/case/neutral`` through a real worker."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient

from tensa.api.app import make_app
from tensa.engines.case_doc import CaseDocument


def _kundur() -> Path:
    import andes

    return Path(andes.__file__).parent / "cases" / "kundur" / "kundur.raw"


pytestmark = pytest.mark.integration


@pytest.fixture()
def client(tmp_path: Path) -> Iterator[TestClient]:
    """An app over a workspace holding kundur.raw, and a client that talks to
    the host the app was made for, which the Host check takes."""
    case = tmp_path / "kundur.raw"
    case.write_bytes(_kundur().read_bytes())
    app = make_app(workspace=tmp_path, bind_host="127.0.0.1", bind_port=8000)
    with TestClient(app, base_url="http://127.0.0.1:8000") as test_client:
        yield test_client


def _session(client: TestClient, engine: str = "andes") -> str:
    response = client.post("/api/sessions", json={"engine": engine})
    if engine != "andes" and response.status_code == 409:
        pytest.skip(str(response.json()["detail"]))
    assert response.status_code == 201, response.text
    return str(response.json()["session_id"])


def test_case_document_of_an_andes_session(client: TestClient) -> None:
    session_id = _session(client)
    response = client.post(
        f"/api/sessions/{session_id}/case", json={"primary_path": "kundur.raw"}
    )
    assert response.status_code == 200
    response = client.get(f"/api/sessions/{session_id}/case/neutral")
    assert response.status_code == 200
    document = CaseDocument.model_validate(response.json())
    assert document.tensa_case == 1
    assert document.name == "kundur"
    assert document.base_mva == 100.0
    assert document.freq_hz == 60.0
    assert len(document.buses) == 10
    assert len(document.lines) == 11
    assert len(document.transformers) == 4
    assert len(document.generators) == 4
    assert len(document.loads) == 2
    body = response.json()
    for field in (
        "buses",
        "lines",
        "transformers",
        "generators",
        "loads",
        "shunts",
        "dynamics",
        "events",
        "notes",
        "ext",
    ):
        assert field in body
    # The JSON names are the spec's: from, to, zip.
    assert "from" in body["lines"][0]
    assert "to" in body["lines"][0]


def test_case_document_keys_equal_the_keys_listing(client: TestClient) -> None:
    session_id = _session(client)
    client.post(f"/api/sessions/{session_id}/case", json={"primary_path": "kundur.raw"})
    document = client.get(f"/api/sessions/{session_id}/case/neutral").json()
    listing = client.get(f"/api/sessions/{session_id}/keys").json()
    served = {
        entry["key"]
        for entry in listing["keys"]
        if entry["bucket"] in ("bus", "line", "transformer", "generator", "load", "shunt")
    }
    in_document = {
        record["key"]
        for name in ("buses", "lines", "transformers", "generators", "loads", "shunts")
        for record in document[name]
    }
    assert in_document == served


def test_unknown_session_is_404(client: TestClient) -> None:
    response = client.get("/api/sessions/nope/case/neutral")
    assert response.status_code == 404


def test_no_case_loaded_is_409(client: TestClient) -> None:
    session_id = _session(client)
    response = client.get(f"/api/sessions/{session_id}/case/neutral")
    assert response.status_code == 409
    assert "no case has been loaded" in response.json()["detail"]


@pytest.mark.sienna()
def test_case_document_of_a_sienna_session(client: TestClient) -> None:
    session_id = _session(client, engine="sienna")
    response = client.post(
        f"/api/sessions/{session_id}/case", json={"primary_path": "kundur.raw"}
    )
    assert response.status_code == 200
    response = client.get(f"/api/sessions/{session_id}/case/neutral")
    assert response.status_code == 200
    document = CaseDocument.model_validate(response.json())
    assert document.tensa_case == 1
    assert len(document.buses) == 10
    listing = client.get(f"/api/sessions/{session_id}/keys").json()
    served = {
        entry["key"]
        for entry in listing["keys"]
        if entry["bucket"] in ("bus", "line", "transformer", "generator", "load", "shunt")
    }
    in_document = {
        record.key
        for name in ("buses", "lines", "transformers", "generators", "loads", "shunts")
        for record in getattr(document, name)
    }
    assert in_document == served

    # The two engines' documents of the same file, from real sessions, agree
    # record by record where both engines hold the value; each transformer's
    # impedance on the system base, from the bases its record states.
    andes_id = _session(client)
    loaded = client.post(f"/api/sessions/{andes_id}/case", json={"primary_path": "kundur.raw"})
    assert loaded.status_code == 200, loaded.text
    andes = CaseDocument.model_validate(
        client.get(f"/api/sessions/{andes_id}/case/neutral").json()
    )
    for name in ("buses", "lines", "transformers", "generators", "loads", "shunts"):
        assert [r.key for r in getattr(andes, name)] == [r.key for r in getattr(document, name)]
    for a, s in zip(andes.buses, document.buses, strict=True):
        assert (a.type, a.vn_kv, a.area_slack) == (s.type, s.vn_kv, s.area_slack)
        assert a.v_pu == pytest.approx(s.v_pu, abs=1e-9)
        assert a.angle_deg == pytest.approx(s.angle_deg, abs=1e-6)
    for a, s in zip(andes.lines, document.lines, strict=True):
        assert (a.r_pu, a.x_pu, a.b_pu) == pytest.approx((s.r_pu, s.x_pu, s.b_pu), rel=1e-9)
        # The file's rating (none: 0.0), not one PowerSystems makes up.
        assert a.rate_a_mva == s.rate_a_mva == 0.0

    def on_system_base(doc: CaseDocument, record: Any) -> tuple[float, float]:
        bus_vn = {bus.number: bus.vn_kv for bus in doc.buses}
        ratio = (record.vn_from_kv**2 / record.rate_mva) / (
            bus_vn[record.from_bus] ** 2 / doc.base_mva
        )
        return record.r_pu * ratio, record.x_pu * ratio

    for a, s in zip(andes.transformers, document.transformers, strict=True):
        assert on_system_base(andes, a) == pytest.approx(on_system_base(document, s), rel=1e-9)
        assert on_system_base(document, s) == pytest.approx((0.001, 0.012))
        assert a.rate_a_mva == s.rate_a_mva == 0.0
    for a, s in zip(andes.generators, document.generators, strict=True):
        assert (a.p_mw, a.q_mvar, a.v_set_pu, a.mbase_mva) == pytest.approx(
            (s.p_mw, s.q_mvar, s.v_set_pu, s.mbase_mva), rel=1e-9
        )
        assert (a.q_min_mvar, a.q_max_mvar) == pytest.approx((s.q_min_mvar, s.q_max_mvar))
    for a, s in zip(andes.loads, document.loads, strict=True):
        assert (a.p_mw, a.q_mvar) == pytest.approx((s.p_mw, s.q_mvar), rel=1e-9)
