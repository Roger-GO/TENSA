"""What a WebSocket client is told when a ``start_tds`` run is refused.

These tests drive the real route, session manager, and worker over Starlette's
``TestClient``, against ANDES's bundled IEEE 14 case. A refused run answers with
one ``error`` text frame and a 4500 close, and never sends ``stream_start``.
"""

from __future__ import annotations

import json
import shutil
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from tensa.api.app import make_app
from tests._ws import websocket_session

WS_CLOSE_WORKER_ERROR = 4500


def _ieee14_dir() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases" / "ieee14"


@pytest.fixture
def live(tmp_path: Path) -> Iterator[tuple[TestClient, str]]:
    """A client on a running app, and the id of a session with IEEE 14 loaded."""
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    for name in ("ieee14.raw", "ieee14.dyr"):
        shutil.copy2(_ieee14_dir() / name, workspace / name)
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
            json={"primary_path": "ieee14.raw", "addfiles": ["ieee14.dyr"]},
        )
        assert loaded.status_code in (200, 201), loaded.text
        yield client, sid


def _refused(client: TestClient, sid: str, start: dict[str, Any]) -> dict[str, Any]:
    """Send ``start_tds`` and return the error frame; the close follows it."""
    with websocket_session(client, f"/api/ws/{sid}") as ws:
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_text(json.dumps({"type": "start_tds", **start}))
        frame: dict[str, Any] = json.loads(ws.receive_text())
        assert frame["type"] == "error", frame
        assert frame["code"] == WS_CLOSE_WORKER_ERROR
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_text()
        assert closed.value.code == WS_CLOSE_WORKER_ERROR
    return frame


@pytest.mark.integration
@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"tstep": 0}, "step size 'tstep'"),
        ({"tstep": -0.01}, "step size 'tstep'"),
        ({"max_step": -0.05}, "'max_step' must be 0"),
        ({"fixt": 2}, "'fixt' must be 0"),
    ],
)
def test_ws_start_tds_refuses_a_bad_step_override(
    live: tuple[TestClient, str], overrides: dict[str, float], message: str
) -> None:
    client, sid = live
    frame = _refused(
        client, sid, {"tf": 0.3, "h": 0.01, "tds_config_overrides": overrides}
    )
    assert frame["reason"].startswith("TdsRequestError: ")
    assert message in frame["reason"]
    # Nothing was written, so there is no reload to suggest.
    assert "reload" not in frame["reason"].lower()

    # The refusal wrote nothing to the System: the same client can still run.
    ok = client.post(f"/api/sessions/{sid}/tds", json={"tf": 0.3, "h": 0.01})
    assert ok.status_code == 200, ok.text


@pytest.mark.integration
def test_ws_start_tds_refuses_an_unknown_override_key_without_a_reload_hint(
    live: tuple[TestClient, str],
) -> None:
    client, sid = live
    frame = _refused(client, sid, {"tf": 0.3, "tds_config_overrides": {"bogus": 1.0}})
    assert "unknown TDS override key 'bogus'" in frame["reason"]
    assert "reload" not in frame["reason"].lower()


@pytest.mark.integration
def test_ws_setup_failure_names_the_endpoint_not_the_python_api(
    live: tuple[TestClient, str],
) -> None:
    """``SetupFailedError`` ends with the Python API's hint (``call reload_case()
    to recover``). A WebSocket client, and the web UI that shows this reason in
    a toast, gets what it can do instead, as ``POST /tds`` does for REST."""
    client, sid = live
    first = client.post(f"/api/sessions/{sid}/tds", json={"tf": 0.3, "h": 0.01})
    assert first.status_code == 200, first.text

    # The System has stepped, so QNDF cannot take over from the trapezoidal run.
    frame = _refused(client, sid, {"tf": 0.6, "integrator": "qndf"})
    reason = frame["reason"]
    assert reason.startswith("SetupFailedError: ANDES setup() failed: QNDF cannot replace")
    assert "reload_case()" not in reason
    assert f"POST /api/sessions/{sid}/reload" in reason
    assert "Reload from file" in reason
    assert reason.count("reload the case to recover") == 1


@pytest.mark.integration
def test_ws_close_frame_stays_within_its_byte_limit(live: tuple[TestClient, str]) -> None:
    """A close reason is at most 123 bytes. It was cut to 120 characters, which
    is more than 123 bytes once the client's own text is not ASCII, and the
    close that failed for it was swallowed: the client never got the code."""
    client, sid = live
    with websocket_session(client, f"/api/ws/{sid}") as ws:
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_text(
            json.dumps({"type": "start_tds", "tf": 0.3, "decimation": "é" * 100})
        )
        frame = json.loads(ws.receive_text())
        assert frame["type"] == "error"
        assert "unknown decimation mode" in frame["reason"]
        # The client's text is quoted back in short, whatever its length.
        assert len(frame["reason"]) < 120
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_text()
    assert closed.value.code == WS_CLOSE_WORKER_ERROR
    assert 0 < len(closed.value.reason.encode("utf-8")) <= 123
