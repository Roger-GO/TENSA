"""The two engines agree on a time-domain run of the same case, through the API.

Kundur with its machines alone (the GENROU records of ``kundur_full.dyr``;
the exciters, governors and the case's own line trip are left out), the same
bus fault in both engines, constant-impedance loads in both: ANDES streams the
run over the WebSocket, Sienna runs it in batch, each result goes through
``POST /results/convert`` into a results document, and ``POST /compare`` holds
the two documents to each other. This is the like-for-like check of the Phase 1
spike (``design/multiengine/reports/phase-1-spike.md``, section 1), which found
the machine and network models the same in both engines to solver accuracy;
the bounds below say how close, and why.

Markers: ``sienna`` and ``integration``; skipped where the Sienna engine is
not available.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from tensa.api.app import make_app
from tensa.core.examples import _andes_cases_dir
from tensa.core.stream import decode_batch
from tensa.engines.sienna.environment import sienna_unavailable_reason
from tests._ws import websocket_session

_REASON = sienna_unavailable_reason()

pytestmark = [
    pytest.mark.integration,
    pytest.mark.sienna,
    pytest.mark.skipif(_REASON is not None, reason=f"the Sienna engine is not available: {_REASON}"),
]

_TF = 5.0
# A three-phase fault on bus 8, the midpoint of the tie, from 1.0 s to 1.1 s.
_FAULT = {"kind": "fault", "bus_idx": 8, "tf": 1.0, "tc": 1.1, "xf": 0.0001, "rf": 0.0}


def _genrou_only(text: str) -> str:
    """The GENROU records of a PSS/E .dyr, each ended by its ``/``."""
    records = [r.strip() for r in text.split("/") if r.strip()]
    kept = [r for r in records if re.split(r"[\s,]+", r)[1].strip("'") == "GENROU"]
    return "".join(f"{r} /\n" for r in kept)


def _ok(response: Any) -> Any:
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture(scope="module")
def results(tmp_path_factory: pytest.TempPathFactory) -> Iterator[dict[str, Any]]:
    """Both engines' results documents of the run, and their comparison."""
    cases = _andes_cases_dir()
    assert cases is not None
    workspace = tmp_path_factory.mktemp("agree") / "ws"
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
    case = {"primary_path": "kundur.raw", "addfiles": ["kundur_genrou.dyr"]}
    with TestClient(app) as client:
        sessions: dict[str, str] = {}
        for engine in ("andes", "sienna"):
            created = client.post("/api/sessions", json={"engine": engine})
            assert created.status_code == 201, created.text
            sid = str(created.json()["session_id"])
            _ok(client.post(f"/api/sessions/{sid}/case", json=case))
            # Before the power flow: an ANDES System takes a disturbance only
            # before setup, which the power flow commits.
            _ok(client.post(f"/api/sessions/{sid}/disturbances", json={"disturbances": [_FAULT]}))
            assert _ok(client.post(f"/api/sessions/{sid}/pflow", json={}))["converged"] is True
            sessions[engine] = sid

        # ANDES streams its columns (Bus_<n>_v, Gen_<n>_omega, ...) at a step of
        # 1/120 s, which keeps its trapezoidal integration error below the
        # differences held below.
        with websocket_session(client, f"/api/ws/{sessions['andes']}") as ws:
            assert json.loads(ws.receive_text())["type"] == "ready"
            ws.send_text(json.dumps({"type": "start_tds", "tf": _TF, "h": 1 / 120}))
            start = json.loads(ws.receive_text())
            assert start["type"] == "stream_start", start
            names = start["metadata"]["var_columns"]
            times: list[float] = []
            rows: list[list[float]] = []
            while True:
                message = ws.receive()
                if message.get("text") is not None:
                    done = json.loads(message["text"])
                    assert done["type"] == "done" and done["converged"] is True, done
                    break
                t, values = decode_batch(message["bytes"])
                times.extend(float(v) for v in t)
                rows.extend(values.tolist())
        andes_traces = {
            "t": times,
            "variables": [
                {"name": name, "values": [row[i] for row in rows]} for i, name in enumerate(names)
            ],
            "truncated": False,
        }
        sienna_run = _ok(
            client.post(
                f"/api/sessions/{sessions['sienna']}/tds",
                json={"tf": _TF, "load_model": "impedance"},
            )
        )
        assert sienna_run["converged"] is True

        documents: dict[str, Any] = {}
        for engine, traces in (("andes", andes_traces), ("sienna", sienna_run["traces"])):
            keys = _ok(client.get(f"/api/sessions/{sessions[engine]}/keys"))["keys"]
            converted = _ok(
                client.post(
                    "/api/results/convert",
                    json={"kind": "tds", "engine": engine, "result": traces, "keys": keys},
                )
            )
            documents[engine] = converted["document"]
        compared = _ok(
            client.post(
                "/api/compare",
                json={"reference": documents["andes"], "comparison": documents["sienna"]},
            )
        )
        yield {"documents": documents, "compare": compared, "client": client}


@pytest.fixture(scope="module")
def client(results: dict[str, Any]) -> TestClient:
    """The client of the module's app, still open while the tests run."""
    c: TestClient = results["client"]
    return c


def _rows(compared: dict[str, Any], quantity: str) -> list[dict[str, Any]]:
    rows = [row for row in compared["series"] if row["quantity"] == quantity]
    for row in rows:
        print(
            f"{quantity:12} {row['key']:10} max {row['max_diff']:.3e} at {row['max_diff_t']:.3f} s,"
            f" rms {row['rms_diff']:.3e}, swing {row['swing_ref']:.3e}"
        )
    return rows


def _document_of(document: dict[str, Any], series: list[dict[str, Any]]) -> dict[str, Any]:
    """``document`` with its series replaced, its tables left out."""
    return {**document, "series": series, "tables": {}}


def _after(document: dict[str, Any], quantity: str, t0: float) -> dict[str, Any]:
    """The document's series of one quantity, from ``t0`` on."""
    series = []
    for s in document["series"]:
        if s["quantity"] != quantity:
            continue
        kept = [(t, y) for t, y in zip(s["t"], s["y"], strict=True) if t >= t0]
        series.append({**s, "t": [t for t, _ in kept], "y": [y for _, y in kept]})
    return _document_of(document, series)


def _relative_angles(document: dict[str, Any], reference: str) -> dict[str, Any]:
    """Each bus's angle less the reference bus's, as ``angle`` series (the
    times of one document are the same for all its series)."""
    angles = {s["of"]: s for s in document["series"] if s["quantity"] == "angle"}
    ref = angles[reference]["y"]
    series = [
        {**s, "y": [None if a is None or r is None else a - r for a, r in zip(s["y"], ref, strict=True)]}
        for key, s in angles.items()
        if key != reference
    ]
    return _document_of(document, series)


def _compare(client: TestClient, reference: dict[str, Any], comparison: dict[str, Any]) -> Any:
    return _ok(client.post("/api/compare", json={"reference": reference, "comparison": comparison}))


def test_every_machine_and_bus_is_compared(results: dict[str, Any]) -> None:
    compared = results["compare"]
    assert len(_rows(compared, "rotor_speed")) == 4
    assert len(_rows(compared, "voltage")) == 10
    assert len(_rows(compared, "angle")) == 10


def test_rotor_speeds_agree_to_solver_accuracy(results: dict[str, Any]) -> None:
    """The spike found 1.0e-5 pu on a swing of 1.0e-2 with these models; this
    run gives 5.0e-6 pu on a swing of 9.2e-3. Held at 2e-5 pu and a quarter of
    a percent of the swing, so a change of either engine's machine or network
    model, which moves them by far more, fails here."""
    for row in _rows(results["compare"], "rotor_speed"):
        assert row["swing_ref"] > 5e-3, row
        assert row["max_diff"] <= 2e-5, row
        assert row["max_diff"] <= 2.5e-3 * row["swing_ref"], row


def test_bus_voltages_agree_once_the_fault_is_cleared(results: dict[str, Any], client: TestClient) -> None:
    """At the instant the fault is applied the engines record the value on
    either side of the step (the whole run's largest difference, at
    t = 1.000 s, is the depth of the fault), so the voltages are held from
    1.2 s on, after it is cleared at 1.1 s."""
    for row in _rows(results["compare"], "voltage"):
        assert row["max_diff_t"] == pytest.approx(_FAULT["tf"], abs=1e-6), row
    docs = results["documents"]
    after = _compare(client, _after(docs["andes"], "voltage", 1.2), _after(docs["sienna"], "voltage", 1.2))
    # This run: at most 2.3e-4 pu, RMS below 3e-5 pu (the spike: RMS 5e-5 to
    # 9e-5 pu). Held at about three times that.
    for row in _rows(after, "voltage"):
        assert row["max_diff"] <= 7e-4, row
        assert row["rms_diff"] <= 1e-4, row


def test_relative_bus_angles_agree(results: dict[str, Any], client: TestClient) -> None:
    """Absolute bus angles drift with the system's frequency in a frame each
    engine chooses (they differ by up to pi here), so they are compared against
    the reference bus, bus 1: what the network carries. Over the whole run the
    largest differences are at the fault's two steps (1.0 s and 1.1 s), where
    the engines record either side of a step, so the angles are held from
    1.2 s on."""
    docs = results["documents"]
    whole = _compare(
        client, _relative_angles(docs["andes"], "bus:1"), _relative_angles(docs["sienna"], "bus:1")
    )
    for row in _rows(whole, "angle"):
        assert min(abs(row["max_diff_t"] - 1.0), abs(row["max_diff_t"] - 1.1)) <= 1e-6, row
    relative = _compare(
        client,
        _relative_angles(_after(docs["andes"], "angle", 1.2), "bus:1"),
        _relative_angles(_after(docs["sienna"], "angle", 1.2), "bus:1"),
    )
    rows = _rows(relative, "angle")
    assert len(rows) == 9
    # This run: at most 4.5e-4 rad on swings of up to 0.4 rad (0.13 percent);
    # the spike: 1.3e-3 rad for relative rotor angles. Held at 1.5e-3 rad and
    # half a percent of the swing.
    for row in rows:
        assert row["max_diff"] <= 1.5e-3, row
        assert row["max_diff"] <= 5e-3 * row["swing_ref"], row
