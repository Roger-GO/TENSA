"""A real worker on Kundur, asked for neutral series names (unit p6-f).

With ``names: "neutral"`` the ``stream_start`` metadata's ``var_columns`` are
all neutral names and the relative quantities ride along; with no ``names``
the metadata is what it was and holds ``"names": "engine"``. A batch run with
``dae_vars`` and ``names: "neutral"`` answers a trace named
``state|<key>#omega`` with the same values as the run without it. The fixtures
copy the neighbouring integration tests (``test_ws_tds_errors.py``).
"""

from __future__ import annotations

import json
import shutil
from collections.abc import Iterator
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from tensa.api.app import make_app
from tensa.core.examples import _andes_cases_dir
from tensa.core.stream import decode_batch
from tensa.engines.series_names import parse_name
from tests._ws import websocket_session


def _kundur() -> Path:
    pytest.importorskip("andes")
    cases = _andes_cases_dir() / "kundur"
    case = cases / "kundur_full.xlsx"
    if not case.exists():  # pragma: no cover
        pytest.skip(f"Kundur fixture not bundled with this ANDES install: {cases}")
    return case


@pytest.fixture
def live(tmp_path: Path) -> Iterator[tuple[TestClient, str]]:
    """A client on a running app, and the id of a session with Kundur loaded."""
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    shutil.copy2(_kundur(), workspace / "kundur_full.xlsx")
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=2,
        idle_timeout_seconds=180.0,
        extra_allowed_hosts=frozenset({"testserver"}),
        extra_allowed_origins=frozenset({"http://testserver", "http://localhost"}),
    )
    with TestClient(app) as client:
        created = client.post("/api/sessions")
        assert created.status_code == 201, created.text
        sid = str(created.json()["session_id"])
        loaded = client.post(
            f"/api/sessions/{sid}/case",
            json={"primary_path": "kundur_full.xlsx"},
        )
        assert loaded.status_code in (200, 201), loaded.text
        yield client, sid


def _stream(client: TestClient, sid: str, start: dict[str, object]) -> tuple[dict[str, object], list[tuple[object, object]]]:
    """Run a short stream and return its metadata and decoded rows."""
    metadata: dict[str, object] | None = None
    rows: list[tuple[object, object]] = []
    with websocket_session(client, f"/api/ws/{sid}") as ws:
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_text(json.dumps({"type": "start_tds", **start}))
        while True:
            message = ws.receive()
            if "text" in message:
                frame = json.loads(message["text"])
                if frame["type"] == "stream_start":
                    metadata = frame["metadata"]
                elif frame["type"] == "done":
                    break
                else:  # pragma: no cover - an error frame fails the test
                    pytest.fail(f"unexpected frame: {frame}")
            else:
                t, values = decode_batch(message["bytes"])
                rows.extend(zip(t, values, strict=True))
    assert metadata is not None
    return metadata, rows


@pytest.mark.integration
def test_neutral_stream_columns_and_relative_quantities(live: tuple[TestClient, str]) -> None:
    client, sid = live
    metadata, rows = _stream(client, sid, {"tf": 0.1, "names": "neutral"})

    columns = metadata["var_columns"]
    assert isinstance(columns, list)
    assert metadata["names"] == "neutral"
    # Every column is a neutral name: each parses.
    parsed = [parse_name(str(column)) for column in columns]
    quantities = [quantity for quantity, _of in parsed]
    assert "voltage|bus:1" in columns
    # The rotor speed of every machine of the case (Kundur has four).
    assert quantities.count("rotor_speed") == 4
    assert all(of.startswith("gen:") for q, of in parsed if q == "rotor_speed")

    # angle_rel of every bus, against the reference bus: the slack's own
    # column is exactly 0.0 at every row.
    angle_rel_columns = [of for q, of in parsed if q == "angle_rel"]
    assert len(angle_rel_columns) == quantities.count("voltage")
    slack_column = columns.index("angle_rel|bus:1")
    assert rows, "the run streamed no rows"
    for _t, values in rows:
        assert values[slack_column] == 0.0

    # rotor_angle_rel of every machine: the H*Sn-weighted sum of each row is 0.
    rotor_columns = [i for i, q in enumerate(quantities) if q == "rotor_angle_rel"]
    assert len(rotor_columns) == 4
    # Kundur's four GENROU machines: H 6.5, 6.5, 6.175, 6.175 on Sn 900, 900,
    # 900, 900 MVA, so the weights H*Sn are 5850, 5850, 5557.5, 5557.5.
    weights = [6.5 * 900.0, 6.5 * 900.0, 6.175 * 900.0, 6.175 * 900.0]
    for _t, values in rows:
        weighted = sum(weights[k] * values[i] for k, i in enumerate(rotor_columns))
        assert abs(weighted) <= 1e-9


@pytest.mark.integration
def test_no_names_is_the_stream_as_it_was(live: tuple[TestClient, str]) -> None:
    client, sid = live
    metadata, rows = _stream(client, sid, {"tf": 0.1})
    columns = metadata["var_columns"]
    assert "Bus_1_v" in columns
    # A request without "names" keeps the metadata as it was: no "names" key.
    assert "names" not in metadata
    assert not any(str(column).startswith("angle_rel|") for column in columns)
    assert rows, "the run streamed no rows"


@pytest.mark.integration
def test_names_engine_is_reported_and_names_nothing(live: tuple[TestClient, str]) -> None:
    client, sid = live
    metadata, rows = _stream(client, sid, {"tf": 0.1, "names": "engine"})
    columns = metadata["var_columns"]
    assert "Bus_1_v" in columns
    assert metadata["names"] == "engine"
    assert not any(str(column).startswith("angle_rel|") for column in columns)
    assert rows, "the run streamed no rows"


@pytest.mark.integration
def test_batch_traces_renamed_with_the_same_values(live: tuple[TestClient, str]) -> None:
    client, sid = live
    engine_run = client.post(
        f"/api/sessions/{sid}/tds",
        json={"tf": 0.1, "dae_vars": ["omega GENROU 1"]},
    )
    assert engine_run.status_code == 200, engine_run.text
    engine_traces = engine_run.json()["traces"]
    assert engine_traces["variables"][0]["name"] == "omega GENROU 1"

    reloaded = client.post(f"/api/sessions/{sid}/reload")
    assert reloaded.status_code == 200, reloaded.text
    neutral_run = client.post(
        f"/api/sessions/{sid}/tds",
        json={"tf": 0.1, "dae_vars": ["omega GENROU 1"], "names": "neutral"},
    )
    assert neutral_run.status_code == 200, neutral_run.text
    neutral_traces = neutral_run.json()["traces"]

    keys = client.get(f"/api/sessions/{sid}/keys")
    assert keys.status_code == 200, keys.text
    machine = next(
        entry
        for entry in keys.json()["keys"]
        if entry["model"] == "GENROU" and str(entry["idx"]) == "1"
    )
    assert neutral_traces["variables"][0]["name"] == f"state|{machine['key']}#omega"
    assert neutral_traces["t"] == engine_traces["t"]
    assert neutral_traces["variables"][0]["values"] == engine_traces["variables"][0]["values"]
