"""Unit tests for the engine seam (unit P3-A): the ops table, the registry, the
capabilities, the two new error classes and the session request schema.

No subprocess is spawned here; the integration coverage of the routes lives in
``tests/integration/test_engines_api.py``.
"""

from __future__ import annotations

import typing
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from tensa.api.app import make_app
from tensa.api.error_mapping import WORKER_ERROR_HTTP_MAP
from tensa.api.schemas import CreateSessionRequest, SaveCaseRequest
from tensa.core.errors import EngineUnavailableError, EngineUnsupportedError
from tensa.core.example_catalog import SUPPORTED_CASE_EXTENSIONS
from tensa.core.worker import HANDLERS
from tensa.engines import (
    ENGINE_NAMES,
    ENGINE_OPS,
    engine_capabilities,
    engine_unavailable_reason,
    engines_with_op,
    is_engine,
    load_runtime,
)


def test_andes_ops_match_the_handler_table() -> None:
    """The literal set cannot drift from the worker's table and special cases."""
    assert ENGINE_OPS["andes"] == frozenset(
        set(HANDLERS) | {"run_tds", "run_sweep", "run_sweep_iteration"}
    )


def test_sienna_ops_match_the_handler_table() -> None:
    """The Sienna runtime's table cannot drift from the ops table. ``run_tds``
    is dispatched directly (it needs the abort event), not through the table."""
    from tensa.engines.sienna.runtime import _HANDLERS

    assert ENGINE_OPS["sienna"] == frozenset(_HANDLERS) | {"run_tds"}


def test_engines_with_op() -> None:
    assert engines_with_op("run_pflow") == ["andes", "sienna"]
    assert engines_with_op("network_matrix") == ["sienna"]
    assert engines_with_op("run_eig") == ["andes", "sienna"]
    assert engines_with_op("eig_participation") == ["andes", "sienna"]
    assert engines_with_op("run_eig_sweep") == ["andes"]
    assert engines_with_op("eig_state_matrix") == ["andes"]
    assert engines_with_op("run_tds") == ["andes", "sienna"]
    assert engines_with_op("init_tds") == ["andes", "sienna"]
    assert engines_with_op("add_disturbance") == ["andes", "sienna"]
    assert engines_with_op("replay_disturbances") == ["andes"]
    assert engines_with_op("no-such-op") == []
    # ENGINE_NAMES order, in case a later engine shares an op.
    assert list(ENGINE_NAMES) == ["andes", "sienna"]


def test_sienna_ops_are_the_literal_fifteen() -> None:
    """The Sienna set is held to the literal ops the engine has."""
    assert ENGINE_OPS["sienna"] == frozenset(
        {
            "load_case",
            "reload_case",
            "topology",
            "operating_point",
            "run_pflow",
            "list_keys",
            "network_matrix",
            "run_eig",
            "eig_participation",
            "add_disturbance",
            "list_disturbances",
            "clear_disturbances",
            "init_tds",
            "case_document",
            "run_tds",
        }
    )


def test_case_document_is_an_op_of_both_engines() -> None:
    assert "case_document" in ENGINE_OPS["andes"]
    assert "case_document" in ENGINE_OPS["sienna"]
    assert engines_with_op("case_document") == ["andes", "sienna"]


def test_engines_with_op_lists_engines_in_engine_names_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When two engines share an op, the list follows ``ENGINE_NAMES``: the error
    that names the engines with an op reads the same every time."""
    monkeypatch.setitem(ENGINE_OPS, "sienna", frozenset({"run_pflow"}))
    assert engines_with_op("run_pflow") == ["andes", "sienna"]


def test_every_engine_name_has_an_ops_entry() -> None:
    """The two tables name the same engines, so asking either is one question."""
    assert set(ENGINE_OPS) == set(ENGINE_NAMES)
    assert len(ENGINE_NAMES) == len(set(ENGINE_NAMES))


def test_is_engine() -> None:
    assert is_engine("andes")
    assert is_engine("sienna")
    assert not is_engine("nope")


def test_engine_unavailable_reason() -> None:
    assert engine_unavailable_reason("andes") is None
    # Sienna's reason comes from the environment check: None when Julia and
    # the project are set up, the reason otherwise.
    from tensa.engines.sienna.environment import sienna_unavailable_reason

    assert engine_unavailable_reason("sienna") == sienna_unavailable_reason()
    with pytest.raises(ValueError, match="unknown engine"):
        engine_unavailable_reason("nope")


def test_load_runtime_andes() -> None:
    runtime = load_runtime("andes")
    assert runtime.name == "andes"


def test_load_runtime_sienna_is_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the environment says Sienna cannot start, ``load_runtime`` raises
    with the environment's reason."""
    from tensa.engines.sienna import environment

    monkeypatch.setattr(
        environment, "sienna_unavailable_reason", lambda: "no Julia here"
    )
    with pytest.raises(EngineUnavailableError) as excinfo:
        load_runtime("sienna")
    assert excinfo.value.engine == "sienna"
    # The error says why, in the words GET /engines gives for it.
    assert excinfo.value.reason == engine_unavailable_reason("sienna")


# The extension of the files each read format of the capabilities stands for.
_EXTENSION_OF_FORMAT = {
    "xlsx": ".xlsx",
    "json": ".json",
    "psse-raw": ".raw",
    "psse-dyr": ".dyr",
    "matpower": ".m",
}
# The capability name of each ``format`` a save request takes.
_FORMAT_OF_SAVE = {"xlsx": "xlsx", "json": "json", "raw": "psse-raw", "m": "matpower"}


def test_andes_reads_every_kind_of_case_file_the_workspace_takes() -> None:
    read = engine_capabilities("andes")["formats"]["read"]
    assert len(read) == len(set(read))
    assert {_EXTENSION_OF_FORMAT[name] for name in read} == SUPPORTED_CASE_EXTENSIONS


def test_andes_writes_the_formats_a_save_takes() -> None:
    write = engine_capabilities("andes")["formats"]["write"]
    save_formats = typing.get_args(SaveCaseRequest.model_fields["format"].annotation)
    assert len(write) == len(set(write))
    assert set(write) == {_FORMAT_OF_SAVE[name] for name in save_formats}


def test_andes_routines_are_the_runs_it_has_a_route_for(tmp_path: Path) -> None:
    """A routine is listed when the API has ``POST /sessions/{id}/<routine>`` and the
    worker answers ``run_<routine>``. A sensitivity sweep repeats those routines and
    is not one of them."""
    paths = make_app(workspace=tmp_path, static_override=tmp_path).openapi()["paths"]
    prefix = "/api/sessions/{session_id}/"
    routed = {
        path[len(prefix):]
        for path, methods in paths.items()
        if path.startswith(prefix) and "/" not in path[len(prefix):] and "post" in methods
    }
    runs = {name for name in routed if f"run_{name}" in ENGINE_OPS["andes"]} - {"sweep"}
    routines = engine_capabilities("andes")["routines"]
    assert len(routines) == len(set(routines))
    assert set(routines) == runs


def test_engine_capabilities_andes() -> None:
    caps = engine_capabilities("andes")
    assert set(caps) == {
        "name",
        "available",
        "unavailable_reason",
        "versions",
        "formats",
        "routines",
        "routine_options",
        "ops",
        "editing",
    }
    # The power flow methods of core/pflow_options.py, by name.
    assert caps["routine_options"] == {"pflow": {"methods": ["NR", "dishonest", "NK"]}}
    assert caps["available"] is True
    assert caps["unavailable_reason"] is None
    assert isinstance(caps["versions"]["andes"], str)
    assert caps["versions"]["andes"]
    assert caps["ops"] == sorted(ENGINE_OPS["andes"])
    assert caps["editing"] is True


def test_engine_capabilities_sienna_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from tensa.engines.sienna import environment

    monkeypatch.setattr(
        environment, "sienna_unavailable_reason", lambda: "no Julia here"
    )
    caps = engine_capabilities("sienna")
    assert set(caps) == {
        "name",
        "available",
        "unavailable_reason",
        "versions",
        "formats",
        "routines",
        "ops",
        "editing",
    }
    assert caps["available"] is False
    assert caps["unavailable_reason"] == engine_unavailable_reason("sienna")
    assert caps["versions"] == {}
    assert caps["formats"] == {"read": [], "write": []}
    assert caps["routines"] == []
    assert caps["ops"] == []
    assert caps["editing"] is False


def test_engine_capabilities_sienna_available(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from tensa.engines.sienna import environment

    monkeypatch.setattr(environment, "sienna_unavailable_reason", lambda: None)
    # A project folder with no Manifest: the versions are what it holds, none.
    monkeypatch.setattr(environment, "sienna_project", lambda: tmp_path)
    caps = engine_capabilities("sienna")
    assert caps["available"] is True
    assert caps["unavailable_reason"] is None
    assert caps["versions"] == {}
    assert caps["formats"] == {
        "read": ["psse-raw", "psse-dyr", "matpower"],
        "write": [],
    }
    assert caps["routines"] == ["matrices", "pflow", "eig", "tds"]
    assert caps["routine_options"] == {
        "pflow": {"methods": ["ac", "dc", "ptdf-dc"]},
        "tds": {
            "streaming": True,
            "abort": True,
            "disturbances": ["branch_trip", "bus_fault", "gen_trip"],
            "options": {"load_model": ["impedance", "power", "as-case"]},
        }
    }
    assert "run_eig" in caps["ops"]
    assert "run_tds" in caps["ops"]
    assert caps["ops"] == sorted(ENGINE_OPS["sienna"])
    assert caps["editing"] is False


def test_every_sienna_op_has_a_dispatch_path() -> None:
    """Each op of the Sienna set reaches a handler; an op outside it is a
    KeyError, which the worker's dispatch refuses before the engine sees it."""
    from tensa.engines.sienna.runtime import sienna_runtime

    runtime = sienna_runtime()

    class _NullPipe:
        def send(self, message: Any) -> None:
            pass

    class _StubBridge:
        def dyn_plan(self, session: Any, load_model: str = "impedance") -> dict[str, Any]:
            return {"ok": True, "ready": True, "columns": []}

    class _Stub:
        def __init__(self) -> None:
            self._session = object()
            self._bridge = _StubBridge()

        def keys(self) -> Any:
            from tensa.engines.keys import KeyBook

            return KeyBook()

        def list_disturbances(self) -> list[Any]:
            return []

        def case_document_parts(self) -> tuple[Any, ...]:
            from tensa.engines.keys import KeyBook

            return ({}, None, None, None, KeyBook(), None, None)

        def _require_session(self) -> Any:
            return self._session

        def _require_bridge(self) -> Any:
            return self._bridge

        def run_tds(self, **kwargs: Any) -> Any:
            return {"converged": True, "final_t": 1.0, "callpert_count": 1}

        def __getattr__(self, name: str) -> Any:
            if name.startswith("__"):
                raise AttributeError(name)

            def _answer(*args: Any, **kwargs: Any) -> Any:
                return {}

            return _answer

    # The smallest args each op's handler reads before it reaches the state.
    # ``run_tds`` is streaming-only, so its args are a ``start_tds`` frame's.
    args_by_op: dict[str, dict[str, Any]] = {
        "load_case": {"path": "case.raw"},
        "run_tds": {"tf": 1.0, "stream": True},
        "eig_participation": {"mode_idx": "0"},
        "network_matrix": {"kind": "ptdf"},
        "add_disturbance": {
            "spec": {
                "kind": "fault",
                "bus_idx": 7,
                "tf": 1.0,
                "tc": 1.1,
                "xf": 0.05,
                "rf": 0.0,
            }
        },
    }
    import threading

    for op in ENGINE_OPS["sienna"]:
        runtime.dispatch(
            _Stub(), op, args_by_op.get(op, {}), threading.Event(), _NullPipe(), 1
        )
    with pytest.raises(KeyError):
        runtime.dispatch(_Stub(), "run_cpf", {}, None, None, None)


def test_engine_unsupported_error_message_and_attributes() -> None:
    exc = EngineUnsupportedError("run_cpf", "sienna", ["andes"])
    assert str(exc) == (
        "'run_cpf' is not available with the sienna engine; "
        "engines that have it: andes"
    )
    assert exc.op == "run_cpf"
    assert exc.engine == "sienna"
    assert exc.engines_with_op == ["andes"]
    assert exc.recovery_kind == "none"


def test_engine_unavailable_error_message_and_attributes() -> None:
    exc = EngineUnavailableError("sienna", "the Sienna engine is not part of this build yet")
    assert str(exc) == (
        "the sienna engine is not available: "
        "the Sienna engine is not part of this build yet"
    )
    assert exc.engine == "sienna"
    assert exc.reason == "the Sienna engine is not part of this build yet"
    assert exc.recovery_kind == "none"


def test_engine_errors_map_to_409() -> None:
    assert WORKER_ERROR_HTTP_MAP["EngineUnsupportedError"] == 409
    assert WORKER_ERROR_HTTP_MAP["EngineUnavailableError"] == 409


def test_create_session_request_body_shapes() -> None:
    assert CreateSessionRequest.model_validate({}).engine == "andes"
    assert CreateSessionRequest.model_validate({"engine": "andes"}).engine == "andes"
    assert CreateSessionRequest.model_validate({"engine": "sienna"}).engine == "sienna"
    with pytest.raises(ValidationError):
        CreateSessionRequest.model_validate({"engine": "x"})
    with pytest.raises(ValidationError):
        CreateSessionRequest.model_validate({"session_id": "x"})
