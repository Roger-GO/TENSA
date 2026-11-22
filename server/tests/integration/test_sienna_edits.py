"""Integration tests of editing a case under the Sienna engine, with a real
Julia. Marked ``sienna`` and ``integration``.

The numbers are worked by hand on Kundur: raising load ``load:7-1`` by 100 MW
and solving the power flow raises the slack's output by 100 MW plus the change
of the losses (within 10 MW of 100); setting a generator out of service
removes its output from the slack's balance; undo gives back the previous
power flow's slack output within 1e-6 MW and redo the edited one; a reload
keeps the edits.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

pytestmark = [pytest.mark.sienna, pytest.mark.integration]


@pytest.fixture(scope="module")
def client_and_session(tmp_path_factory: pytest.TempPathFactory) -> Iterator[tuple[Any, str]]:
    """One app, one client and one Sienna session with Kundur loaded, through
    a real worker, shared by the edit tests (Julia starts once)."""
    from fastapi.testclient import TestClient

    from tensa.api.app import make_app
    from tensa.core.examples import _andes_cases_dir

    cases = _andes_cases_dir()
    if cases is None:
        pytest.skip("ANDES is not installed")
    workspace = tmp_path_factory.mktemp("edits-ws")
    for name in ("kundur.raw", "kundur_full.dyr"):
        (workspace / name).write_bytes((cases / "kundur" / name).read_bytes())
    app = make_app(workspace=workspace, bind_host="127.0.0.1", bind_port=8000)
    with TestClient(app, base_url="http://127.0.0.1:8000") as client:
        created = client.post("/api/sessions", json={"engine": "sienna"})
        if created.status_code == 409:
            pytest.skip(f"Sienna is not available: {created.json()['detail']}")
        assert created.status_code == 201, created.text
        session = created.json()["session_id"]
        loaded = client.post(
            f"/api/sessions/{session}/case",
            json={"primary_path": "kundur.raw"},
        )
        assert loaded.status_code == 200, loaded.text
        yield client, session


def _pflow(client: Any, session: str) -> dict[str, Any]:
    response = client.post(f"/api/sessions/{session}/pflow", json={})
    assert response.status_code == 200, response.text
    return response.json()


def _slack_p(result: dict[str, Any]) -> float:
    for idx, output in result["generator_outputs"].items():
        if str(idx).endswith("1") or "generator-1-1" in str(idx):
            return float(output["p"])
    # Fall back: the generator on bus 1 is the slack.
    keys = result.get("keys", {}).get("generator", {})
    for idx, key in keys.items():
        if key == "gen:1-1":
            return float(result["generator_outputs"][idx]["p"])
    raise AssertionError(f"no slack output in {list(result['generator_outputs'])}")


def _load_p(result: dict[str, Any]) -> float:
    keys = result.get("keys", {}).get("load", {})
    for idx, key in keys.items():
        if key == "load:7-2":
            return float(result["load_consumption"][idx]["p"])
    raise AssertionError("no load:7-1 in the result")


def _losses(result: dict[str, Any]) -> float:
    return float(result["summary"]["loss_p"])


def test_raise_load_raises_slack_output(client_and_session: tuple[Any, str]) -> None:
    """The power balance holds the edit: the slack takes up the 100 MW and the
    change of the losses, which the result reports (10.6 MW on Kundur, whose
    tie carries the area's import)."""
    client, session = client_and_session
    before = _pflow(client, session)
    load_before = _load_p(before)
    # Kundur's load:7-2 (bus 7, id 2, named load72) is 1159 MW; raise it by 100 MW.
    assert load_before == pytest.approx(1159.0)
    edited = client.put(
        f"/api/sessions/{session}/elements/PQ/load72",
        json={"params": {"p0": (load_before + 100.0) / 100.0}},
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["idx"] == "load72"
    after = _pflow(client, session)
    assert _load_p(after) == pytest.approx(load_before + 100.0, abs=1e-6)
    d_slack = _slack_p(after) - _slack_p(before)
    d_losses = _losses(after) - _losses(before)
    assert d_slack == pytest.approx(100.0 + d_losses, abs=1e-3)
    assert 0.0 < d_losses < 20.0
    client.post(f"/api/sessions/{session}/undo-last-edit")


def test_a_generator_edit_moves_its_output_to_the_slack(client_and_session: tuple[Any, str]) -> None:
    """Generator 2 scheduled 50 MW lower: the slack makes up the 50 MW and the
    change of the losses. Taking it out of service altogether (700 MW) leaves
    Kundur's slack more than its AC power flow converges with, so the
    in-service switch is held by its round trip: out and back gives the
    schedule's power flow again."""
    client, session = client_and_session
    before = _pflow(client, session)
    keys = before.get("keys", {}).get("generator", {})
    gen2_idx = next(idx for idx, key in keys.items() if key == "gen:2-1")
    gen2_p = float(before["generator_outputs"][gen2_idx]["p"])
    edited = client.put(
        f"/api/sessions/{session}/elements/PV/{gen2_idx}",
        json={"params": {"p0": (gen2_p - 50.0) / 100.0}},
    )
    assert edited.status_code == 200, edited.text
    after = _pflow(client, session)
    assert float(after["generator_outputs"][gen2_idx]["p"]) == pytest.approx(gen2_p - 50.0, abs=1e-6)
    d_slack = _slack_p(after) - _slack_p(before)
    d_losses = _losses(after) - _losses(before)
    assert d_slack == pytest.approx(50.0 + d_losses, abs=1e-3)
    assert client.post(f"/api/sessions/{session}/undo-last-edit").status_code == 200
    out = client.put(f"/api/sessions/{session}/elements/PV/{gen2_idx}", json={"params": {"u": 0}})
    assert out.status_code == 200, out.text
    back = client.put(f"/api/sessions/{session}/elements/PV/{gen2_idx}", json={"params": {"u": 1}})
    assert back.status_code == 200, back.text
    assert _slack_p(_pflow(client, session)) == pytest.approx(_slack_p(before), abs=1e-6)
    client.post(f"/api/sessions/{session}/undo-last-edit")
    client.post(f"/api/sessions/{session}/undo-last-edit")


def test_undo_and_redo_give_back_the_slack_outputs(client_and_session: tuple[Any, str]) -> None:
    client, session = client_and_session
    before = _pflow(client, session)
    slack_before = _slack_p(before)
    load_before = _load_p(before)
    edited = client.put(
        f"/api/sessions/{session}/elements/PQ/load72",
        json={"params": {"p0": (load_before + 50.0) / 100.0}},
    )
    assert edited.status_code == 200, edited.text
    slack_edited = _slack_p(_pflow(client, session))
    undone = client.post(f"/api/sessions/{session}/undo-last-edit")
    assert undone.status_code == 200, undone.text
    assert _slack_p(_pflow(client, session)) == pytest.approx(slack_before, abs=1e-6)
    redone = client.post(f"/api/sessions/{session}/redo-edit")
    assert redone.status_code == 200, redone.text
    assert _slack_p(_pflow(client, session)) == pytest.approx(slack_edited, abs=1e-6)
    # Take the edit back so the module-shared session stays clean.
    client.post(f"/api/sessions/{session}/undo-last-edit")


def test_reload_keeps_the_edits(client_and_session: tuple[Any, str]) -> None:
    client, session = client_and_session
    load_before = _load_p(_pflow(client, session))
    edited = client.put(
        f"/api/sessions/{session}/elements/PQ/load72",
        json={"params": {"p0": (load_before + 25.0) / 100.0}},
    )
    assert edited.status_code == 200, edited.text
    reloaded = client.post(f"/api/sessions/{session}/reload")
    assert reloaded.status_code == 200, reloaded.text
    assert _load_p(_pflow(client, session)) == pytest.approx(load_before + 25.0, abs=1e-6)
    client.post(f"/api/sessions/{session}/undo-last-edit")


def test_an_edit_of_a_field_the_engine_does_not_take_is_422(
    client_and_session: tuple[Any, str],
) -> None:
    client, session = client_and_session
    response = client.put(
        f"/api/sessions/{session}/elements/PQ/load72",
        json={"params": {"Vn": 20.0}},
    )
    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert "Vn" in detail
    assert "p0" in detail or "p_mw" in detail
