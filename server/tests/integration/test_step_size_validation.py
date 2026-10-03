"""The TDS step size ``h`` is refused at every entry point when it is not a
finite number greater than zero.

ANDES takes any value without complaint: ``TDS._calc_h_first`` logs a warning
for ``tstep <= 0`` and flips ``config.fixt`` to variable-step on the live
System, and NaN or infinity reach the integrator unchecked. The REST bodies
and the WebSocket start frame must therefore stop a bad value before a worker
sees it. No ANDES run is needed: every rejected request fails before the
session's worker is called, and the one accepted request is cut short by a
stub manager.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from tensa.api.app import make_app
from tensa.core.session import SessionExpiredError, SessionManager, _Session

WS_CLOSE_INTERNAL_ERROR = 4500
WS_CLOSE_SESSION_NOT_FOUND = 4404


class _FakeProcess:
    def is_alive(self) -> bool:
        return True


def _make_client(tmp_path: Path) -> tuple[TestClient, SessionManager]:
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        extra_allowed_hosts=frozenset({"testserver"}),
        extra_allowed_origins=frozenset({"http://testserver", "http://localhost"}),
    )
    mgr = SessionManager(max_sessions=4, idle_timeout=180.0)
    mgr._sessions["s1"] = _Session(  # noqa: SLF001
        session_id="s1",
        process=_FakeProcess(),
        ctrl=None,
        data=None,
        abort_event=None,
    )
    return TestClient(app), mgr


# Raw JSON bodies: Python's ``json.loads`` accepts the non-standard
# ``Infinity`` / ``NaN`` tokens, so a client can send them.
_BAD_H_LITERALS = ["0", "-0.01", "Infinity", "-Infinity", "NaN"]


@pytest.mark.integration
@pytest.mark.parametrize("h", _BAD_H_LITERALS)
def test_rest_tds_rejects_a_bad_step_size(h: str, tmp_path: Path) -> None:
    client, mgr = _make_client(tmp_path)
    with client:
        client.app.state.session_manager = mgr
        resp = client.post(
            "/api/sessions/s1/tds",
            content=f'{{"tf": 1.0, "h": {h}}}',
            headers={"content-type": "application/json"},
        )
    assert resp.status_code == 422, resp.text
    assert "('body', 'h')" in resp.json()["detail"], resp.text


@pytest.mark.integration
@pytest.mark.parametrize("h", _BAD_H_LITERALS)
def test_rest_sweep_rejects_a_bad_step_size(h: str, tmp_path: Path) -> None:
    client, mgr = _make_client(tmp_path)
    body = (
        '{"parameter": {"kind": "disturbance.fault.tc", "target": 0,'
        ' "range": {"start": 1.05, "end": 1.15, "steps": 3}},'
        f' "sim": {{"tf": 0.2, "h": {h}}}, "snapshot_name": "base"}}'
    )
    with client:
        client.app.state.session_manager = mgr
        resp = client.post(
            "/api/sessions/s1/sweep",
            content=body,
            headers={"content-type": "application/json"},
        )
    assert resp.status_code == 422, resp.text
    assert "('body', 'sim', 'h')" in resp.json()["detail"], resp.text


def _record_start_streaming_run(mgr: SessionManager) -> list[dict[str, Any]]:
    """Replace ``start_streaming_run`` with a recorder that ends the run at once."""
    calls: list[dict[str, Any]] = []

    async def _stub(session_id: str, op: str, args: dict[str, Any]) -> str:
        calls.append({"session_id": session_id, "op": op, "args": args})
        raise SessionExpiredError(f"session {session_id!r} is gone")

    mgr.start_streaming_run = _stub  # type: ignore[method-assign]
    return calls


@pytest.mark.integration
@pytest.mark.parametrize("h", [0, -0.01, "abc", True, [0.01], {"v": 1}])
def test_ws_start_tds_rejects_a_bad_step_size(h: object, tmp_path: Path) -> None:
    client, mgr = _make_client(tmp_path)
    calls = _record_start_streaming_run(mgr)
    with client:
        client.app.state.session_manager = mgr
        with client.websocket_connect("/api/ws/s1") as ws:
            assert json.loads(ws.receive_text())["type"] == "ready"
            ws.send_text(json.dumps({"type": "start_tds", "tf": 1.0, "h": h}))
            frame = json.loads(ws.receive_text())
            assert frame["type"] == "error"
            assert frame["code"] == WS_CLOSE_INTERNAL_ERROR
            assert "step size 'h'" in frame["reason"]
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_text()
            assert closed.value.code == WS_CLOSE_INTERNAL_ERROR
    assert calls == [], "a rejected start frame must not reach the session"


@pytest.mark.integration
@pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity"])
def test_ws_start_tds_rejects_non_finite_step_size(literal: str, tmp_path: Path) -> None:
    client, mgr = _make_client(tmp_path)
    calls = _record_start_streaming_run(mgr)
    with client:
        client.app.state.session_manager = mgr
        with client.websocket_connect("/api/ws/s1") as ws:
            assert json.loads(ws.receive_text())["type"] == "ready"
            ws.send_text(f'{{"type": "start_tds", "tf": 1.0, "h": {literal}}}')
            frame = json.loads(ws.receive_text())
            assert frame["type"] == "error"
            assert "step size 'h'" in frame["reason"]
    assert calls == []


@pytest.mark.integration
def test_ws_start_tds_rejects_an_integer_too_large_for_a_float(tmp_path: Path) -> None:
    """A 400-digit integer literal is valid JSON, but ``float()`` overflows on
    it; that must come back as the same error frame, not escape the handler."""
    client, mgr = _make_client(tmp_path)
    calls = _record_start_streaming_run(mgr)
    with client:
        client.app.state.session_manager = mgr
        with client.websocket_connect("/api/ws/s1") as ws:
            assert json.loads(ws.receive_text())["type"] == "ready"
            ws.send_text(f'{{"type": "start_tds", "tf": 1.0, "h": 1{"0" * 400}}}')
            frame = json.loads(ws.receive_text())
            assert frame["type"] == "error"
            assert frame["code"] == WS_CLOSE_INTERNAL_ERROR
            assert "step size 'h'" in frame["reason"]
    assert calls == []


@pytest.mark.integration
@pytest.mark.parametrize(
    ("sent", "forwarded"),
    [(0.005, 0.005), (1, 1.0), ("0.02", 0.02), (None, None)],
)
def test_ws_start_tds_forwards_a_valid_step_size_as_a_float(
    sent: object, forwarded: float | None, tmp_path: Path
) -> None:
    client, mgr = _make_client(tmp_path)
    calls = _record_start_streaming_run(mgr)
    with client:
        client.app.state.session_manager = mgr
        with client.websocket_connect("/api/ws/s1") as ws:
            assert json.loads(ws.receive_text())["type"] == "ready"
            ws.send_text(json.dumps({"type": "start_tds", "tf": 1.0, "h": sent}))
            frame = json.loads(ws.receive_text())
            # The stub ends the run by expiring the session.
            assert frame["code"] == WS_CLOSE_SESSION_NOT_FOUND
    assert len(calls) == 1
    assert calls[0]["op"] == "run_tds"
    assert calls[0]["args"]["h"] == forwarded
    assert calls[0]["args"]["tf"] == 1.0
