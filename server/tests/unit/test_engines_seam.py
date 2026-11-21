"""Unit tests for the engine seam (unit P3-A): the ops table, the registry, the
capabilities, the two new error classes and the session request schema.

No subprocess is spawned here; the integration coverage of the routes lives in
``tests/integration/test_engines_api.py``.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from tensa.api.error_mapping import WORKER_ERROR_HTTP_MAP
from tensa.api.schemas import CreateSessionRequest
from tensa.core.errors import EngineUnavailableError, EngineUnsupportedError
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


def test_sienna_has_no_ops() -> None:
    assert ENGINE_OPS["sienna"] == frozenset()


def test_engines_with_op() -> None:
    assert engines_with_op("run_pflow") == ["andes"]
    assert engines_with_op("no-such-op") == []
    # ENGINE_NAMES order, in case a later engine shares an op.
    assert list(ENGINE_NAMES) == ["andes", "sienna"]


def test_is_engine() -> None:
    assert is_engine("andes")
    assert is_engine("sienna")
    assert not is_engine("nope")


def test_engine_unavailable_reason() -> None:
    assert engine_unavailable_reason("andes") is None
    assert engine_unavailable_reason("sienna") == (
        "the Sienna engine is not part of this build yet"
    )
    with pytest.raises(ValueError, match="unknown engine"):
        engine_unavailable_reason("nope")


def test_load_runtime_andes() -> None:
    runtime = load_runtime("andes")
    assert runtime.name == "andes"


def test_load_runtime_sienna_is_unavailable() -> None:
    with pytest.raises(EngineUnavailableError) as excinfo:
        load_runtime("sienna")
    assert excinfo.value.engine == "sienna"


def test_engine_capabilities_andes() -> None:
    caps = engine_capabilities("andes")
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
    assert caps["available"] is True
    assert caps["unavailable_reason"] is None
    assert isinstance(caps["versions"]["andes"], str)
    assert caps["versions"]["andes"]
    assert caps["ops"] == sorted(ENGINE_OPS["andes"])
    assert caps["editing"] is True


def test_engine_capabilities_sienna() -> None:
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
