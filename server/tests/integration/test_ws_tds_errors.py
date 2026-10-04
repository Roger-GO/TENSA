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
    with client.websocket_connect(f"/api/ws/{sid}") as ws:
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
    assert message in frame["reason"]

    # The refusal wrote nothing to the System: the same client can still run.
    ok = client.post(f"/api/sessions/{sid}/tds", json={"tf": 0.3, "h": 0.01})
    assert ok.status_code == 200, ok.text
