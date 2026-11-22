"""Integration tests of the Sienna islanding refusal with a real Julia.

Marked ``sienna`` and ``integration``: they start a worker with Julia and load
Kundur (``kundur/kundur.raw`` of the ANDES examples, copied into the
workspace). A branch trip that would island the network is refused with 422
when it is posted, before any run; the branch keys and the areas cut off are
read against the recorded sample topology
(``server/tests/unit/sienna_samples/kundur.topology.json``).
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

pytestmark = [pytest.mark.sienna, pytest.mark.integration]

_SAMPLES = Path(__file__).parent.parent / "unit" / "sienna_samples"


def _andes_cases_dir() -> Path:
    andes = pytest.importorskip("andes")
    return Path(andes.__file__).parent / "cases"


@pytest.fixture(scope="module")
def kundur(tmp_path_factory: pytest.TempPathFactory) -> Iterator[tuple[Any, str]]:
    """One app, one client and one Sienna session with Kundur loaded, through
    a real worker, shared by the islanding tests (Julia starts once). The
    client talks to the host the app was made for, which the Host check
    takes."""
    from fastapi.testclient import TestClient

    from tensa.api.app import make_app

    workspace = tmp_path_factory.mktemp("islanding-ws")
    source = _andes_cases_dir() / "kundur" / "kundur.raw"
    (workspace / "kundur.raw").write_bytes(source.read_bytes())
    app = make_app(workspace=workspace, bind_host="127.0.0.1", bind_port=8000)
    with TestClient(app, base_url="http://127.0.0.1:8000") as client:
        created = client.post("/api/sessions", json={"engine": "sienna"})
        if created.status_code == 409:
            pytest.skip(f"Sienna is not available: {created.json()['detail']}")
        assert created.status_code == 201, created.text
        session = created.json()["session_id"]
        loaded = client.post(
            f"/api/sessions/{session}/case", json={"primary_path": "kundur.raw"}
        )
        assert loaded.status_code == 200, loaded.text
        yield client, session


def _branch_names() -> dict[tuple[int, int, str], str]:
    """The ``(from, to, ckt)`` to ``name`` map of the recorded topology, which
    is what the key book's Line idx are. The keys the tests use are asserted
    to exist, so a topology that changes fails here and not in Julia."""
    topology = json.loads((_SAMPLES / "kundur.topology.json").read_text("utf-8"))
    return {
        (int(row["from"]), int(row["to"]), str(row["ckt"])): str(row["name"])
        for row in topology["branches"]
    }


def _toggle(names: dict[tuple[int, int, str], str], ends: tuple[int, int, str]) -> dict[str, Any]:
    return {"kind": "toggle", "model": "Line", "dev_idx": names[ends], "t": 1.0}


def test_the_branch_keys_used_exist() -> None:
    names = _branch_names()
    # The generator step-up transformer of bus 1 and the three 7-8 circuits.
    assert (1, 5, "1") in names
    assert (7, 8, "1") in names
    assert (7, 8, "2") in names
    assert (7, 8, "3") in names


def test_tripping_the_step_up_transformer_of_bus_1_is_refused(
    kundur: tuple[Any, str],
) -> None:
    client, session_id = kundur
    names = _branch_names()
    response = client.post(
        f"/api/sessions/{session_id}/disturbances",
        json={"disturbances": [_toggle(names, (1, 5, "1"))]},
    )
    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert "branch:1-5-1" in detail
    # Bus 1 hangs off the network by that transformer alone (the recorded
    # topology has no other branch on bus 1), so it is the bus cut off.
    assert "buses 1 lose their connection" in detail
    assert "before the run" in detail


def test_the_three_circuits_of_7_8(kundur: tuple[Any, str]) -> None:
    client, session_id = kundur
    names = _branch_names()
    # The first two trips leave one circuit: accepted.
    for ends in ((7, 8, "1"), (7, 8, "2")):
        response = client.post(
            f"/api/sessions/{session_id}/disturbances",
            json={"disturbances": [_toggle(names, ends)]},
        )
        assert response.status_code == 200, response.text
    # The third opens the only way to the far side. By hand from the recorded
    # topology: with 7-8 open, buses 8, 9, 10, 3 and 4 reach the rest only
    # through bus 7 (8-9, 9-10, 9-3, 10-4), so the smallest new component is
    # [3, 4, 8, 9, 10], sorted.
    response = client.post(
        f"/api/sessions/{session_id}/disturbances",
        json={"disturbances": [_toggle(names, (7, 8, "3"))]},
    )
    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert "branch:7-8-3" in detail
    assert "buses 3, 4, 8, 9, 10 lose their connection" in detail
    # The refused trip was not added: the pending list holds the first two.
    listed = client.get(f"/api/sessions/{session_id}/disturbances")
    assert listed.status_code == 200, listed.text
    held = listed.json()["disturbances"]
    assert [row["dev_idx"] for row in held] == [names[(7, 8, "1")], names[(7, 8, "2")]]
