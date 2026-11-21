"""The ``method``, ``n_factorize`` and ``linesearch`` power-flow settings.

Validation in :func:`validate_pflow_options`, the request body, and the
write-and-restore of :func:`pflow_options_applied` on a real loaded System. That
the settings change what the solver does is in
``tests/integration/test_pflow_options.py`` (the wrapper) and
``tests/integration/test_pflow_api.py`` (the route).
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from tensa.api.schemas import PflowRunRequest
from tensa.api.schemas import PflowSettings as PflowSettingsModel
from tensa.core import worker
from tensa.core.errors import PflowRequestError
from tensa.core.pflow_options import (
    METHODS,
    N_FACTORIZE_MAX,
    N_FACTORIZE_MIN,
    PflowSettings,
    pflow_options_applied,
    validate_pflow_options,
)
from tensa.core.wrapper import Wrapper

pytestmark = pytest.mark.unit


# ---- validation ------------------------------------------------------------


@pytest.mark.parametrize("method", ["NR", "dishonest", "NK", None])
def test_method_accepts_the_three_solvers(method: str | None) -> None:
    validate_pflow_options(method=method)


@pytest.mark.parametrize("method", ["nr", "Dishonest", "NK ", "foo", "", 1, True])
def test_method_refuses_anything_else(method: object) -> None:
    with pytest.raises(PflowRequestError, match="method must be one of"):
        validate_pflow_options(method=method)


def test_the_method_message_names_the_choices_and_the_value() -> None:
    with pytest.raises(PflowRequestError) as raised:
        validate_pflow_options(method="newton")
    message = str(raised.value)
    assert "'NR', 'dishonest', 'NK'" in message
    assert "newton" in message


@pytest.mark.parametrize("n_factorize", [1, 4, 100, None])
def test_n_factorize_accepts_a_whole_number_in_range(n_factorize: int | None) -> None:
    validate_pflow_options(n_factorize=n_factorize)


@pytest.mark.parametrize("n_factorize", [0, -1, 101, 2.5, 4.0, "4", True])
def test_n_factorize_refuses_anything_else(n_factorize: object) -> None:
    with pytest.raises(PflowRequestError, match="n_factorize must be a whole number from 1 to 100"):
        validate_pflow_options(n_factorize=n_factorize)


@pytest.mark.parametrize("linesearch", [True, False, None])
def test_linesearch_accepts_a_bool(linesearch: bool | None) -> None:
    validate_pflow_options(linesearch=linesearch)


@pytest.mark.parametrize("linesearch", [1, 0, "true", 1.0])
def test_linesearch_refuses_anything_else(linesearch: object) -> None:
    with pytest.raises(PflowRequestError, match="linesearch must be true or false"):
        validate_pflow_options(linesearch=linesearch)


def test_the_constants_are_andes_choices_in_its_order(loaded_wrapper: Wrapper) -> None:
    config = loaded_wrapper._require_loaded().PFlow.config  # noqa: SLF001
    assert METHODS == ("NR", "dishonest", "NK")
    assert config._alt["method"] == METHODS  # noqa: SLF001
    assert (N_FACTORIZE_MIN, N_FACTORIZE_MAX) == (1, 100)


# ---- the request body and the worker ---------------------------------------


def test_the_request_body_carries_the_solver_settings() -> None:
    body = PflowRunRequest(method="dishonest", n_factorize=2, linesearch=False)
    assert body.model_dump(exclude_none=True) == {
        "method": "dishonest",
        "n_factorize": 2,
        "linesearch": False,
    }


@pytest.mark.parametrize("payload", [{"n_factorize": 0}, {"n_factorize": 101}, {"linesearch": "maybe"}])
def test_the_request_body_refuses_what_it_can_express(payload: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        PflowRunRequest(**payload)


def test_the_response_settings_read_an_older_payload() -> None:
    """A field added to a response defaults to null: the four older settings
    alone still make a valid object."""
    older = {"tolerance": 1e-6, "max_iterations": 25, "flat_start": False, "enforce_q_limits": False}
    settings = PflowSettingsModel(**older)
    assert (settings.method, settings.n_factorize, settings.linesearch) == (None, None, None)


def test_the_worker_forwards_the_solver_settings() -> None:
    calls: list[dict[str, Any]] = []

    class _Wrapper:
        def run_pflow(self, **options: Any) -> Any:
            calls.append(options)
            return type("Result", (), {"converged": False})()

    worker._handle_run_pflow(  # type: ignore[arg-type]
        _Wrapper(), {"method": "NK", "n_factorize": 3, "linesearch": False, "tolerance": None}
    )
    assert calls == [{"method": "NK", "n_factorize": 3, "linesearch": False}]


# ---- applying and restoring on a real System ------------------------------


@pytest.fixture()
def loaded_wrapper(tmp_path: Path) -> Iterator[Wrapper]:
    """A Wrapper with a real case loaded and set up."""
    andes = pytest.importorskip("andes")
    wrapper = Wrapper(workspace=tmp_path, session_id="test", owner_pid=None)
    wrapper.load_case(Path(andes.get_case("ieee14/ieee14_full.xlsx")))
    wrapper._ensure_setup()  # noqa: SLF001
    yield wrapper


def _solver_config(wrapper: Wrapper) -> tuple[Any, Any, Any]:
    config = wrapper._require_loaded().PFlow.config  # noqa: SLF001
    return (config.method, config.n_factorize, config.linesearch)


def test_applied_writes_reports_and_restores(loaded_wrapper: Wrapper) -> None:
    ss = loaded_wrapper._require_loaded()  # noqa: SLF001
    assert _solver_config(loaded_wrapper) == ("NR", 4, 1)  # ANDES's defaults
    with pflow_options_applied(ss, method="dishonest", n_factorize=2, linesearch=False) as settings:
        assert _solver_config(loaded_wrapper) == ("dishonest", 2, 0)
        assert settings == PflowSettings(1e-6, 25, False, False, "dishonest", 2, False)
    assert _solver_config(loaded_wrapper) == ("NR", 4, 1)


def test_applied_restores_when_the_body_raises(loaded_wrapper: Wrapper) -> None:
    ss = loaded_wrapper._require_loaded()  # noqa: SLF001
    with (
        pytest.raises(RuntimeError),
        pflow_options_applied(ss, method="NK", n_factorize=7, linesearch=False),
    ):
        assert _solver_config(loaded_wrapper) == ("NK", 7, 0)
        raise RuntimeError("body failed")
    assert _solver_config(loaded_wrapper) == ("NR", 4, 1)


def test_applied_left_out_keeps_the_systems_own(loaded_wrapper: Wrapper) -> None:
    """A case file's ``_config`` can set any of them; a request that says nothing
    runs with that, reports it, and leaves it."""
    ss = loaded_wrapper._require_loaded()  # noqa: SLF001
    ss.PFlow.config.method = "dishonest"
    ss.PFlow.config.n_factorize = 3
    ss.PFlow.config.linesearch = 0
    with pflow_options_applied(ss) as settings:
        assert _solver_config(loaded_wrapper) == ("dishonest", 3, 0)
        assert (settings.method, settings.n_factorize, settings.linesearch) == ("dishonest", 3, False)
    assert _solver_config(loaded_wrapper) == ("dishonest", 3, 0)

    # ...and a request can override the case's own for one run.
    with pflow_options_applied(ss, method="NR", linesearch=True) as settings:
        assert (settings.method, settings.n_factorize, settings.linesearch) == ("NR", 3, True)
    assert _solver_config(loaded_wrapper) == ("dishonest", 3, 0)
