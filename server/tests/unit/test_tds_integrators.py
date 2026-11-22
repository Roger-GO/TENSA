"""The four integrators a time-domain run can ask for, as the wrapper hands them
to ANDES.

``ss.TDS.run`` is stubbed, as in ``test_wrapper_run_tds_integrator.py``: these
tests hold what the wrapper writes to ``ss.TDS.config`` and which integrator
object it leaves ANDES to step with. The runs themselves, their trajectories and
their recorded times are in ``tests/integration/test_tds_integrators.py``.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import numpy as np
import pytest
from pydantic import ValidationError

pytest.importorskip("andes")

from tensa.api.schemas import TdsBatchResult, TdsRunRequest
from tensa.core import worker
from tensa.core.errors import SetupFailedError, TdsRequestError
from tensa.core.wrapper import Wrapper, tds_fixed_step, validate_tds_overrides
from tensa.core.wrapper.tds import TDS_INTEGRATORS, validate_integrator

pytestmark = pytest.mark.unit

# The ANDES ``config.method``, the ``fixt`` and the class of the integrator
# object that each integrator of the API stands for.
ANDES = {
    "trapezoidal": ("trapezoid", 1, "Trapezoid"),
    "backeuler": ("backeuler", 1, "BackEuler"),
    "trap_adapt": ("trap_adapt", 0, "TrapezoidAdaptive"),
    "qndf": ("qndf", 0, "QNDF"),
}


def _ieee14_raw() -> Path:
    import andes

    return Path(andes.__file__).parent / "cases" / "ieee14" / "ieee14.raw"


@pytest.fixture
def loaded_wrapper() -> Wrapper:
    """IEEE 14, set up and solved, with ``TDS.run`` a no-op."""
    w = Wrapper()
    w.load_case(_ieee14_raw())
    w._ensure_setup()  # noqa: SLF001
    ss = w._require_loaded()  # noqa: SLF001
    ss.PFlow.run()
    ss.TDS.run = MagicMock(return_value=None)
    return w


def _ss(w: Wrapper) -> Any:
    return w._require_loaded()  # noqa: SLF001


def _live(w: Wrapper) -> str:
    return type(_ss(w).TDS.method).__name__


def _as_initialised_with(w: Wrapper, andes_method: str, *, stepped: bool) -> None:
    """What ``TDS.init()`` leaves, with ``andes_method`` the object it built, and
    what a run leaves when ``stepped``."""
    ss = _ss(w)
    ss.TDS.set_method(andes_method)
    ss.TDS.initialized = True
    ss.dae.t = np.array(0.4 if stepped else 0.0)
    ss.dae.kcount = 12 if stepped else 0
    ss.dae.n = max(int(ss.dae.n), 3)


def _config(w: Wrapper) -> tuple[object, ...]:
    cfg = _ss(w).TDS.config
    return (cfg.method, int(cfg.fixt), float(cfg.tstep), float(cfg.tf), float(cfg.dtmin_adapt))


# ---- what a request writes ----------------------------------------------------------


def test_the_api_names_four_integrators() -> None:
    assert TDS_INTEGRATORS == ("trapezoidal", "trap_adapt", "backeuler", "qndf")


@pytest.mark.parametrize("integrator", list(ANDES))
def test_each_integrator_reaches_andes_as_its_method_and_step_mode(
    loaded_wrapper: Wrapper, integrator: Any
) -> None:
    method, fixt, _ = ANDES[integrator]
    result = loaded_wrapper.run_tds(tf=0.1, h=0.01, integrator=integrator)
    cfg = _ss(loaded_wrapper).TDS.config
    assert cfg.method == method
    assert int(cfg.fixt) == fixt
    assert result.integrator == integrator


def test_the_default_is_the_trapezoidal_method_and_is_reported(loaded_wrapper: Wrapper) -> None:
    result = loaded_wrapper.run_tds(tf=0.1, h=0.01)
    assert result.integrator == "trapezoidal"
    assert _ss(loaded_wrapper).TDS.config.method == "trapezoid"


@pytest.mark.parametrize("earlier", ["trap_adapt", "backeuler", "qndf"])
def test_a_run_that_names_no_integrator_inherits_none_of_an_earlier_runs(
    loaded_wrapper: Wrapper, earlier: Any
) -> None:
    """``method`` and ``fixt`` are written by every run, so a run that names
    nothing is the trapezoidal method at ``h``, whatever ran before."""
    loaded_wrapper.run_tds(tf=0.1, integrator=earlier)
    _ss(loaded_wrapper).TDS.initialized = True  # as after the run
    loaded_wrapper.run_tds(tf=0.2, h=0.005)
    cfg = _ss(loaded_wrapper).TDS.config
    assert (cfg.method, int(cfg.fixt), float(cfg.tstep)) == ("trapezoid", 1, 0.005)
    assert _live(loaded_wrapper) == "Trapezoid"


# ---- which object ANDES steps with ------------------------------------------------------


@pytest.mark.parametrize("requested", ["trapezoidal", "backeuler", "trap_adapt"])
@pytest.mark.parametrize("earlier", ["trapezoid", "backeuler", "trap_adapt", "qndf"])
def test_any_integrator_but_qndf_replaces_any_other_on_a_system_that_has_stepped(
    loaded_wrapper: Wrapper, earlier: str, requested: Any
) -> None:
    """ANDES reads ``config.method`` only in ``TDS.init()``; on a System that
    already ran the wrapper swaps the object, or the run would step with the
    earlier one under the new name."""
    _as_initialised_with(loaded_wrapper, earlier, stepped=True)
    loaded_wrapper.run_tds(tf=1.0, h=0.01, integrator=requested)
    method, fixt, cls = ANDES[requested]
    assert _live(loaded_wrapper) == cls
    assert (_ss(loaded_wrapper).TDS.config.method, int(_ss(loaded_wrapper).TDS.config.fixt)) == (
        method,
        fixt,
    )
    _ss(loaded_wrapper).TDS.run.assert_called_once()


@pytest.mark.parametrize("requested", ["backeuler", "trap_adapt"])
def test_before_init_the_object_is_left_to_andes(
    loaded_wrapper: Wrapper, requested: Any
) -> None:
    """``TDS.init()`` builds the object from ``config.method`` on the first run."""
    assert not bool(_ss(loaded_wrapper).TDS.initialized)
    loaded_wrapper.run_tds(tf=0.1, integrator=requested)
    assert _live(loaded_wrapper) == "Trapezoid"
    assert _ss(loaded_wrapper).TDS.config.method == ANDES[requested][0]


@pytest.mark.parametrize("earlier", ["trap_adapt", "backeuler"])
def test_qndf_is_refused_on_a_system_another_integrator_has_stepped(
    loaded_wrapper: Wrapper, earlier: str
) -> None:
    """QNDF's history is built in ``TDS.init()``. Before this unit only the
    trapezoidal object could be live without it; a System stepped with the
    adaptive trapezoidal method, which is also variable-step, must be refused
    too, not run with that object under a QNDF request."""
    _as_initialised_with(loaded_wrapper, earlier, stepped=True)
    before = _config(loaded_wrapper)
    with pytest.raises(SetupFailedError, match=f"cannot replace the {earlier} integrator"):
        loaded_wrapper.check_tds_request("qndf")
    with pytest.raises(SetupFailedError, match=f"cannot replace the {earlier} integrator"):
        loaded_wrapper.run_tds(tf=1.0, integrator="qndf")
    assert _config(loaded_wrapper) == before
    assert _live(loaded_wrapper) == ANDES[earlier][2]
    _ss(loaded_wrapper).TDS.run.assert_not_called()


@pytest.mark.parametrize("earlier", ["backeuler", "trap_adapt"])
def test_qndf_builds_its_history_on_a_system_initialised_with_another_and_not_stepped(
    loaded_wrapper: Wrapper, earlier: str
) -> None:
    _as_initialised_with(loaded_wrapper, earlier, stepped=False)
    loaded_wrapper.run_tds(tf=1.0, integrator="qndf", tds_config_overrides={"rtol": 1e-4})
    ss = _ss(loaded_wrapper)
    assert _live(loaded_wrapper) == "QNDF"
    assert ss.TDS.qndf_cache is not None
    assert ss.TDS.qndf_cache.reltol == pytest.approx(1e-4)


def test_check_tds_request_accepts_the_new_integrators_on_a_fresh_case(
    loaded_wrapper: Wrapper,
) -> None:
    for integrator in ("trap_adapt", "backeuler"):
        loaded_wrapper.check_tds_request(integrator)


@pytest.mark.parametrize("requested", ["backeuler", "trap_adapt"])
def test_check_tds_request_accepts_the_new_integrators_after_steps(
    loaded_wrapper: Wrapper, requested: Any
) -> None:
    _as_initialised_with(loaded_wrapper, "qndf", stepped=True)
    loaded_wrapper.check_tds_request(requested)


# ---- refusals of the value itself ------------------------------------------------------


@pytest.mark.parametrize("bad", ["rk4", "Trapezoidal", "trapezoid", "", None, 1, ["qndf"]])
def test_an_unknown_integrator_is_a_bad_request(bad: object) -> None:
    with pytest.raises(TdsRequestError, match="unknown integrator"):
        validate_integrator(bad)


def test_run_tds_refuses_an_unknown_integrator_before_setup() -> None:
    """A direct caller of the wrapper has no request model in front of it."""
    w = Wrapper()
    w.load_case(_ieee14_raw())
    with pytest.raises(TdsRequestError, match="unknown integrator 'rk4'"):
        w.run_tds(tf=0.1, integrator="rk4")  # type: ignore[arg-type]
    assert not bool(_ss(w).is_setup)


def test_check_tds_request_refuses_an_unknown_integrator(loaded_wrapper: Wrapper) -> None:
    before = _config(loaded_wrapper)
    with pytest.raises(TdsRequestError, match="unknown integrator"):
        loaded_wrapper.check_tds_request("rk4")  # type: ignore[arg-type]
    assert _config(loaded_wrapper) == before


def test_the_worker_refuses_an_unknown_integrator_as_a_bad_request(
    loaded_wrapper: Wrapper,
) -> None:
    with pytest.raises(TdsRequestError, match="unknown integrator 'rk4'"):
        worker._handle_run_tds(  # noqa: SLF001
            loaded_wrapper, {"tf": 0.1, "integrator": "rk4"}, threading.Event()
        )
    _ss(loaded_wrapper).TDS.run.assert_not_called()


@pytest.mark.parametrize("integrator", ["trap_adapt", "backeuler"])
def test_the_worker_passes_the_new_integrators_on_and_reports_them(
    loaded_wrapper: Wrapper, integrator: str
) -> None:
    result = worker._handle_run_tds(  # noqa: SLF001
        loaded_wrapper, {"tf": 0.1, "h": 0.01, "integrator": integrator}, threading.Event()
    )
    assert result["integrator"] == integrator
    assert _ss(loaded_wrapper).TDS.config.method == ANDES[integrator][0]


# ---- fixed or variable step ------------------------------------------------------------


@pytest.mark.parametrize(
    ("integrator", "overrides", "fixed"),
    [
        ("trapezoidal", None, True),
        ("backeuler", None, True),
        ("backeuler", {"fixt": 0}, False),
        ("trap_adapt", None, False),
        ("trap_adapt", {"fixt": 1}, False),
        ("qndf", None, False),
    ],
)
def test_tds_fixed_step_follows_the_integrator(
    integrator: Any, overrides: dict[str, float] | None, fixed: bool
) -> None:
    assert tds_fixed_step(integrator, overrides) is fixed


# ---- the step floor --------------------------------------------------------------------


@pytest.mark.parametrize("key", ["min_step", "dtmin_adapt"])
@pytest.mark.parametrize("bad", [-1.0, -1e-9, float("inf"), float("nan")])
def test_a_step_floor_that_is_negative_or_not_finite_is_refused(key: str, bad: float) -> None:
    with pytest.raises(TdsRequestError, match=f"'{key}' must be"):
        validate_tds_overrides({key: bad})


@pytest.mark.parametrize("good", [0, 0.0, 1e-4])
def test_a_step_floor_of_zero_or_more_is_accepted(good: float) -> None:
    validate_tds_overrides({"min_step": good})
    validate_tds_overrides({"dtmin_adapt": good})


def test_min_step_lands_on_dtmin_adapt(loaded_wrapper: Wrapper) -> None:
    loaded_wrapper.check_tds_request("trap_adapt", {"dtmin_adapt": 1e-5})
    loaded_wrapper.run_tds(
        tf=0.1, integrator="trap_adapt", tds_config_overrides={"min_step": 2e-4, "max_step": 0.02}
    )
    cfg = _ss(loaded_wrapper).TDS.config
    assert float(cfg.dtmin_adapt) == pytest.approx(2e-4)
    assert float(cfg.dtmax) == pytest.approx(0.02)


def test_a_bad_step_floor_writes_nothing(loaded_wrapper: Wrapper) -> None:
    before = _config(loaded_wrapper)
    with pytest.raises(TdsRequestError):
        loaded_wrapper.run_tds(
            tf=0.3, integrator="trap_adapt", tds_config_overrides={"min_step": -0.1}
        )
    assert _config(loaded_wrapper) == before
    _ss(loaded_wrapper).TDS.run.assert_not_called()


# ---- the request and the result as the API has them ----------------------------------------


@pytest.mark.parametrize("integrator", list(ANDES))
def test_the_request_takes_the_four_integrators(integrator: str) -> None:
    assert TdsRunRequest(tf=1.0, integrator=integrator).integrator == integrator  # type: ignore[arg-type]


def test_the_request_refuses_any_other_integrator() -> None:
    with pytest.raises(ValidationError):
        TdsRunRequest(tf=1.0, integrator="rk4")  # type: ignore[arg-type]


def test_the_result_s_integrator_is_optional_and_null_by_default() -> None:
    """Additive: a literal default would make it a required field of the
    generated web types."""
    schema = TdsBatchResult.model_json_schema()
    assert "integrator" not in schema.get("required", [])
    assert schema["properties"]["integrator"]["default"] is None
    result = TdsBatchResult(run_id="r", converged=True, final_t=1.0, callpert_count=3)
    assert result.integrator is None
