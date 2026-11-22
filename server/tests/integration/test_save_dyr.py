"""Saving a case as ``raw`` writes its ``.dyr`` beside it, and the pair loads
as the case that was saved."""

from __future__ import annotations

import math
from pathlib import Path

import pytest
from starlette.testclient import TestClient

pytestmark = pytest.mark.integration


def _kundur(workspace: Path) -> None:
    from tensa.core.examples import _andes_cases_dir

    cases = _andes_cases_dir()
    assert cases is not None
    import shutil

    shutil.copyfile(cases / "kundur" / "kundur_full.xlsx", workspace / "kundur_full.xlsx")


def _create_session(client: TestClient) -> str:
    response = client.post("/api/sessions", json={})
    assert response.status_code == 201, response.text
    return response.json()["session_id"]


def _load(client: TestClient, session_id: str, path: str, addfiles: list[str] | None = None) -> None:
    body: dict[str, object] = {"primary_path": path}
    if addfiles:
        body["addfiles"] = addfiles
    response = client.post(f"/api/sessions/{session_id}/case", json=body)
    assert response.status_code in (200, 201), response.text


def _pflow(client: TestClient, session_id: str) -> dict[str, float]:
    response = client.post(f"/api/sessions/{session_id}/pflow", json={})
    assert response.status_code == 200, response.text
    return response.json()["bus_voltages"]


def _controllers(client: TestClient, session_id: str) -> list[str]:
    response = client.get(f"/api/sessions/{session_id}/topology")
    assert response.status_code == 200, response.text
    topology = response.json()
    return sorted(
        str(entry['kind']) for entry in topology.get("controllers", [])
    )


def test_save_raw_writes_the_dyr_beside_it(tmp_path: Path) -> None:
    from tensa.api.app import make_app

    _kundur(tmp_path)
    app = make_app(workspace=tmp_path, bind_host="127.0.0.1", bind_port=8000)
    with TestClient(app, base_url="http://127.0.0.1:8000") as client:
        saved_session = _create_session(client)
        _load(client, saved_session, "kundur_full.xlsx")
        before_pf = _pflow(client, saved_session)
        before_controllers = _controllers(client, saved_session)

        response = client.post(
            f"/api/sessions/{saved_session}/save",
            json={"filename": "kundur_saved.raw", "format": "raw"},
        )
        assert response.status_code == 201, response.text
        answer = response.json()
        assert answer["dyr_filename"] == "kundur_saved.dyr"
        assert (tmp_path / "kundur_saved.raw").is_file()
        assert (tmp_path / "kundur_saved.dyr").is_file()
        assert (tmp_path / "kundur_saved.dyr").stat().st_size > 0

        loaded_session = _create_session(client)
        _load(
            client,
            loaded_session,
            "kundur_saved.raw",
            addfiles=["kundur_saved.dyr"],
        )
        after_pf = _pflow(client, loaded_session)
        assert after_pf.keys() == before_pf.keys()
        for bus, voltage in before_pf.items():
            assert math.isclose(after_pf[bus], voltage, abs_tol=1e-6), bus
        assert _controllers(client, loaded_session) == before_controllers
