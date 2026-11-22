"""The seam the ``ext.sienna`` block crosses: route, runtime and schema.

No Julia. The batch route refuses ``ext_sienna`` for an ANDES session with a
422 that names the field before anything reaches a worker, and the Sienna
runtime's streaming arm refuses it with the named error. The schema half of
the seam (the request model takes the block and forbids a bogus one) is held
by ``test_engines_sienna_ext.py`` beside the other ext tests.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import tensa.api.routes.tds as tds_module
from tensa.api.routes.tds import router as tds_router
from tensa.core.errors import AndesAppError
from tensa.engines.sienna.runtime import _handle_run_tds


class _Session:
    def __init__(self, engine: str) -> None:
        self.engine = engine


class _Manager:
    """The one lookup the route makes on the session manager before it invokes."""

    def __init__(self, engine: str) -> None:
        self._sessions = {"abc": _Session(engine)}


def test_route_refuses_ext_sienna_for_an_andes_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The route's own check, before any worker call: a 422 naming the field.
    # ``_manager`` asserts isinstance SessionManager, so the stub is handed
    # in through the helper itself.
    monkeypatch.setattr(
        tds_module, "_manager", lambda request: _Manager("andes")
    )
    app = FastAPI()
    app.include_router(tds_router, prefix="/api")
    client = TestClient(app, raise_server_exceptions=False)
    response = client.post(
        "/api/sessions/abc/tds",
        json={
            "tf": 1.0,
            "ext_sienna": {
                "dynamic_branches": [{"target": "branch:7-8-1"}],
                "inverters": [],
            },
        },
    )
    assert response.status_code == 422
    assert response.json()["detail"] == (
        "ext_sienna is a Sienna option; an ANDES session does not take it"
    )


def test_streamed_run_refuses_ext_sienna() -> None:
    # The streaming arm of the Sienna runtime refuses the block by name,
    # before a plan is built (which would need a bridge).
    with pytest.raises(AndesAppError) as excinfo:
        _handle_run_tds(
            state=None,  # type: ignore[arg-type]  # never reached: the refusal precedes any state use
            args={
                "stream": True,
                "tf": 1.0,
                "ext_sienna": {"dynamic_branches": [], "inverters": []},
            },
            abort_event=None,
            data=object(),
            seq=object(),
        )
    assert str(excinfo.value) == "ext.sienna is not taken on a streamed run yet; run it batch"
