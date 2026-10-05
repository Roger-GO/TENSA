"""The TDS routes' part in a run's controllers, with the worker stood in for.

The route coroutines are driven directly with a real ``SessionManager`` whose
``invoke`` is replaced, so what is sent to the worker and what is made of its
answer are checked without ANDES. ``tests/integration/test_tds_controllers_api.py``
drives the same routes against real workers.

Run via ``asyncio.run`` so they need no pytest-asyncio.
"""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path
from typing import Any

import pytest

from tensa.api.app import make_app
from tensa.api.routes.tds import list_tds_controllers, run_tds
from tensa.api.schemas import TdsRunRequest
from tensa.core.session import SessionManager, _Session

pytestmark = pytest.mark.unit


class _FakeCtrl:
    def send(self, msg: dict[str, Any]) -> None:  # pragma: no cover - unused
        pass


class _FakeRequest:
    """Minimal stand-in exposing ``app.state.session_manager`` for the route."""

    def __init__(self, mgr: SessionManager) -> None:
        self.app = type("_App", (), {"state": type("_State", (), {"session_manager": mgr})()})()


def _manager(answer: dict[str, Any]) -> tuple[SessionManager, list[tuple[str, dict[str, Any]]]]:
    """A manager with one session whose worker answers every op with ``answer``,
    and the ``(op, args)`` it was sent."""
    mgr = SessionManager()
    mgr._sessions["s1"] = _Session(  # noqa: SLF001
        session_id="s1", process=None, ctrl=_FakeCtrl(), data=_FakeCtrl(), abort_event=None
    )
    sent: list[tuple[str, dict[str, Any]]] = []

    async def invoke(_session_id: str, op: str, args: dict[str, Any], **_kwargs: Any) -> Any:
        sent.append((op, args))
        return answer

    mgr.invoke = invoke  # type: ignore[method-assign]
    return mgr, sent


RUN = {"converged": True, "final_t": 2.0, "callpert_count": 61}
DID = {
    "type": "droop",
    "model": "ESD1",
    "idx": 1,
    "samples": 2,
    "first_action_t": 1.1,
    "released_t": None,
    "peak_command": 15.9,
    "final_command": 15.5,
    "trace": {
        "t": [1.0, 1.1],
        "frequency": [60.0, 59.9],
        "command": [0.0, 15.9],
        "output": [0.0, None],
        "soc": [0.5, 0.5],
        "truncated": False,
    },
}


def test_the_run_route_sends_the_controllers_with_their_defaults_filled_in() -> None:
    mgr, sent = _manager({**RUN, "controllers": [DID]})
    body = TdsRunRequest.model_validate(
        {
            "tf": 2.0,
            "controllers": [
                {"type": "droop", "model": "ESD1", "idx": 1, "gain": 100},
                {"type": "ffr", "model": "ESD1", "idx": "2", "power": 20, "trigger_rocof": 0.5},
            ],
        }
    )

    result = asyncio.run(run_tds("s1", body, _FakeRequest(mgr)))  # type: ignore[arg-type]

    ((op, args),) = sent
    assert op == "run_tds"
    assert args["controllers"] == [
        {
            "type": "droop", "model": "ESD1", "idx": 1, "frequency": "coi", "period": 0.1,
            "t_start": 0.0, "ramp": None, "gain": 100.0, "deadband": 0.0, "p_max": None,
        },
        {
            "type": "ffr", "model": "ESD1", "idx": "2", "frequency": "coi", "period": 0.1,
            "t_start": 0.0, "ramp": None, "power": 20.0, "trigger_deviation": None,
            "trigger_rocof": 0.5, "hold": 10.0,
        },
    ]
    # What the worker says each did comes back typed, samples included.
    assert result.controllers is not None
    (controller,) = result.controllers
    assert (controller.type, controller.idx, controller.first_action_t) == ("droop", 1, 1.1)
    assert controller.trace is not None
    assert controller.trace.output == [0.0, None]


@pytest.mark.parametrize("controllers", [None, []])
def test_a_run_without_controllers_sends_none_and_reports_none(controllers: Any) -> None:
    mgr, sent = _manager(RUN)
    body = TdsRunRequest(tf=2.0, controllers=controllers)

    result = asyncio.run(run_tds("s1", body, _FakeRequest(mgr)))  # type: ignore[arg-type]

    assert "controllers" not in sent[0][1]
    assert result.controllers is None


def test_the_catalogue_route_asks_the_worker_and_types_its_answer() -> None:
    catalogue = {
        "types": ["droop", "ffr"],
        "coi_available": True,
        "freq_hz": 60.0,
        "base_mva": 100.0,
        "targets": [
            {
                "model": "ESD1", "idx": "ESD1_1", "name": "ESD1_1", "bus": 4, "in_service": True,
                "p_limit": 40.0, "fn": 60.0,
                "variables": {
                    "command": "Pext ESD1 1", "frequency": "fHz ESD1 1",
                    "active_current": "Ipout_y ESD1 1", "soc": None,
                },
            }
        ],
    }
    mgr, sent = _manager(catalogue)

    result = asyncio.run(list_tds_controllers("s1", _FakeRequest(mgr)))  # type: ignore[arg-type]

    assert sent == [("list_tds_controllers", {})]
    assert result.model_dump() == catalogue


def test_the_request_schema_documents_both_kinds_and_every_field() -> None:
    """The OpenAPI text is what an agent reads to write a controller."""
    with tempfile.TemporaryDirectory() as root:
        workspace = Path(root) / "ws"
        workspace.mkdir(mode=0o700)
        schemas = make_app(
            workspace=workspace, bind_host="127.0.0.1", bind_port=8000
        ).openapi()["components"]["schemas"]

    items = schemas["TdsRunRequest"]["properties"]["controllers"]["anyOf"][0]["items"]
    assert items["discriminator"]["propertyName"] == "type"
    assert sorted(items["discriminator"]["mapping"]) == ["droop", "ffr"]
    for name in ("DroopController", "FfrController", "TdsControllerResult", "TdsControllerTarget"):
        for field, spec in schemas[name]["properties"].items():
            assert spec.get("description"), f"{name}.{field} has no description"
    # A controller is parameters: nothing in it is free text to evaluate.
    for name in ("DroopController", "FfrController"):
        assert schemas[name]["additionalProperties"] is False
        assert set(schemas[name]["properties"]) <= {
            "type", "model", "idx", "frequency", "period", "t_start", "ramp",
            "gain", "deadband", "p_max",
            "power", "trigger_deviation", "trigger_rocof", "hold",
        }
