"""Unit tests for ``Wrapper.init_tds``: the setting applied for one call and put
back, the refusals, and the mapping of the diagnostics ANDES leaves behind.

A stub System stands in for ANDES where the test is about the wrapper's own
logic; one test uses a real loaded case for the passing path, in the style of
the other wrapper unit tests.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from tensa.core.errors import NoCaseLoadedError, SetupFailedError, TdsRequestError
from tensa.core.wrapper import Wrapper
from tensa.core.wrapper.tds import _init_diagnostics


class _Config:
    def __init__(self, test_init: int = 1, tol: float = 1e-4) -> None:
        self.test_init = test_init
        self.tol = tol


class _TDS:
    def __init__(self) -> None:
        self.initialized = False
        self.test_ok: bool | None = None
        self.config = _Config()
        self.calls = 0

    def init(self) -> None:
        self.calls += 1
        self.initialized = True
        if self.config.test_init:
            self.test_ok = True


class _PFlow:
    converged = True

    def run(self) -> None:
        pass


class _Discrete:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows

    def get_limit_report(self) -> list[dict[str, Any]]:
        return list(self._rows)


class _Model:
    def __init__(self, discrete: dict[str, Any]) -> None:
        self.discrete = discrete


class _Exist:
    def __init__(self, tds: dict[str, Any], pflow_tds: dict[str, Any]) -> None:
        self.tds = tds
        self.pflow_tds = pflow_tds


class _Dae:
    def __init__(self, fg: list[float], xy_name: list[str], n: int) -> None:
        self.fg = np.array(fg)
        self.xy_name = xy_name
        self.n = n
        self.m = len(xy_name) - n
        self.x_map: dict[int, Any] = {}
        self.y_map: dict[int, Any] = {}


class _System:
    def __init__(self, dae: _Dae, exist: _Exist) -> None:
        self.dae = dae
        self.exist = exist
        self.TDS = _TDS()
        self.PFlow = _PFlow()
        self.exit_code = 0
        self.is_setup = True
        self.no_check_init: list[int] = []
        self.j_updates = 0

    def j_update(self, models: Any = None) -> None:
        self.j_updates += 1


def _wrapper_with(ss: Any) -> Wrapper:
    wrapper = Wrapper(workspace=None, session_id="s", owner_pid=None)
    wrapper._ss = ss  # noqa: SLF001
    wrapper._is_setup = True  # noqa: SLF001
    return wrapper


@pytest.mark.unit
def test_test_init_true_maps_to_config_and_is_put_back() -> None:
    ss = _System(_Dae([0.0], ["v Bus 1"], 0), _Exist({"GENROU": object()}, {}))
    ss.TDS.config.test_init = 0
    wrapper = _wrapper_with(ss)
    seen: list[int] = []
    original = ss.TDS.init

    def _init() -> None:
        seen.append(ss.TDS.config.test_init)
        original()

    ss.TDS.init = _init  # type: ignore[method-assign]
    result = wrapper.init_tds(test_init=True)
    assert seen == [1]
    assert ss.TDS.config.test_init == 0
    assert result.test_init is True
    assert result.test_ok is True


@pytest.mark.unit
def test_test_init_false_maps_to_config_and_test_ok_is_none() -> None:
    ss = _System(_Dae([0.0], ["v Bus 1"], 0), _Exist({"GENROU": object()}, {}))
    wrapper = _wrapper_with(ss)
    result = wrapper.init_tds(test_init=False)
    assert result.test_init is False
    assert result.test_ok is None
    assert result.clamped == []
    assert result.residuals == []
    assert ss.TDS.config.test_init == 1


@pytest.mark.unit
def test_config_is_put_back_even_when_init_raises() -> None:
    ss = _System(_Dae([0.0], ["v Bus 1"], 0), _Exist({"GENROU": object()}, {}))
    ss.TDS.config.test_init = 0

    def _boom() -> None:
        raise RuntimeError("boom")

    ss.TDS.init = _boom  # type: ignore[method-assign]
    wrapper = _wrapper_with(ss)
    with pytest.raises(SetupFailedError, match="TDS.init raised: boom"):
        wrapper.init_tds(test_init=True)
    assert ss.TDS.config.test_init == 0


@pytest.mark.unit
def test_already_initialised_is_refused_and_init_not_called_again() -> None:
    ss = _System(_Dae([0.0], ["v Bus 1"], 0), _Exist({"GENROU": object()}, {}))
    ss.TDS.initialized = True
    wrapper = _wrapper_with(ss)
    with pytest.raises(SetupFailedError, match="already initialised"):
        wrapper.init_tds()
    assert ss.TDS.calls == 0


@pytest.mark.unit
def test_a_case_without_dynamic_models_is_refused() -> None:
    ss = _System(_Dae([0.0], ["v Bus 1"], 0), _Exist({}, {}))
    wrapper = _wrapper_with(ss)
    with pytest.raises(SetupFailedError, match="no dynamic models"):
        wrapper.init_tds()


@pytest.mark.unit
def test_no_case_loaded_raises_the_no_case_error() -> None:
    wrapper = Wrapper(workspace=None, session_id="s", owner_pid=None)
    with pytest.raises(NoCaseLoadedError):
        wrapper.init_tds()


def _diagnostics_system() -> _System:
    dae = _Dae(
        [0.0, 0.5, float("nan"), 1e-9],
        ["omega GENROU 1", "delta GENROU 1", "v Bus 1", "a Bus 1"],
        2,
    )
    entry_x = (None, type("V", (), {"e_str": "d(omega) = (Pm - Pe) / M"})())
    entry_y = (None, type("V", (), {"e_str": ""})())
    dae.x_map[1] = entry_x
    dae.y_map[0] = entry_y
    rows = [
        {
            "model": "GENROU",
            "idx": 1,
            "var": "omega",
            "limit_name": "wmax",
            "limit_val": 1.05,
            "unconstr": 1.2,
        }
    ]
    exist = _Exist(
        {"GENROU": object()},
        {"GENROU": _Model({"wl": _Discrete(rows)})},
    )
    return _System(dae, exist)


@pytest.mark.unit
def test_diagnostics_map_residuals_and_clamps() -> None:
    ss = _diagnostics_system()
    clamped, residuals, truncated = _init_diagnostics(ss)
    assert not truncated
    assert clamped == [
        # model, idx stringified, var, limit name, limit value, unconstrained value
        type(clamped[0])(
            model="GENROU", idx="1", var="omega",
            limit_name="wmax", limit_val=1.05, unconstr=1.2,
        )
    ]
    assert [r.name for r in residuals] == ["delta GENROU 1", "v Bus 1"]
    assert residuals[0].mismatch == 0.5
    assert residuals[0].equation == "d(omega) = (Pm - Pe) / M"
    assert residuals[1].mismatch is None  # NaN does not survive JSON
    assert residuals[1].equation == ""


@pytest.mark.unit
def test_the_500_row_cap_sets_diagnostics_truncated() -> None:
    n = 600
    dae = _Dae([1.0] * n, [f"v Bus {i}" for i in range(n)], 0)
    ss = _System(dae, _Exist({"GENROU": object()}, {}))
    clamped, residuals, truncated = _init_diagnostics(ss)
    assert truncated
    assert len(residuals) == 500
    assert clamped == []


class _Flags:
    def __init__(self, pflow: bool) -> None:
        self.pflow = pflow


class _Kind:
    def __init__(self, group: str, pflow: bool) -> None:
        self.group = group
        self.flags = _Flags(pflow)


@pytest.mark.unit
def test_static_models_and_timed_events_are_no_dynamic_models() -> None:
    """``exist.tds`` lists the network and the static devices on a case with no
    dynamic data too; a toggle alone is no dynamic model either."""
    tds = {
        "PQ": _Kind("StaticLoad", True),
        "Line": _Kind("ACLine", True),
        "Toggle": _Kind("TimedEvent", False),
    }
    ss = _System(_Dae([0.0], ["v Bus 1"], 0), _Exist(tds, {}))
    with pytest.raises(SetupFailedError, match="no dynamic models"):
        _wrapper_with(ss).init_tds()
    assert ss.TDS.calls == 0

    tds["GENROU"] = _Kind("SynGen", False)
    assert _wrapper_with(ss).init_tds().initialized is True


@pytest.mark.unit
@pytest.mark.parametrize("value", [1, 0, "false", None])
def test_a_test_init_that_is_not_a_bool_is_refused_before_anything_is_touched(
    value: Any,
) -> None:
    ss = _System(_Dae([0.0], ["v Bus 1"], 0), _Exist({"GENROU": object()}, {}))
    with pytest.raises(TdsRequestError, match="test_init"):
        _wrapper_with(ss).init_tds(test_init=value)
    assert ss.TDS.calls == 0
    assert ss.TDS.config.test_init == 1


@pytest.mark.unit
def test_the_power_flow_runs_first_and_one_that_fails_stops_the_call() -> None:
    ss = _System(_Dae([0.0], ["v Bus 1"], 0), _Exist({"GENROU": object()}, {}))
    runs: list[int] = []

    class _Unsolved:
        converged = False

        def run(self) -> None:
            runs.append(1)

    ss.PFlow = _Unsolved()  # type: ignore[assignment]
    with pytest.raises(SetupFailedError, match="power flow did not converge"):
        _wrapper_with(ss).init_tds()
    assert runs == [1]
    assert ss.TDS.calls == 0

    class _Solves:
        converged = False

        def run(self) -> None:
            self.converged = True

    ss.PFlow = _Solves()  # type: ignore[assignment]
    assert _wrapper_with(ss).init_tds().initialized is True
    assert ss.TDS.calls == 1


@pytest.mark.unit
def test_the_jacobians_are_evaluated_when_the_test_does_not_do_it() -> None:
    for test_init, expected in ((True, 0), (False, 1)):
        ss = _System(_Dae([0.0], ["v Bus 1"], 0), _Exist({"GENROU": object()}, {}))
        _wrapper_with(ss).init_tds(test_init=test_init)
        assert ss.j_updates == expected


@pytest.mark.unit
def test_a_nan_residual_is_counted_and_kept_out_of_the_largest() -> None:
    ss = _System(
        _Dae([0.25, float("nan")], ["omega GENROU 1", "v Bus 1"], 1),
        _Exist({"GENROU": object()}, {}),
    )
    result = _wrapper_with(ss).init_tds()
    assert result.nan_residuals == 1
    assert result.max_residual == 0.25
    assert [r.mismatch for r in result.residuals] == [0.25, None]


@pytest.mark.unit
def test_equations_andes_does_not_check_are_left_out() -> None:
    """ANDES's test zeroes the differential equations of ``no_check_init``
    before it judges; with the test off they still hold what ``init()`` left."""
    ss = _System(
        _Dae([5.0, 0.0, 0.5], ["x GENROU 1", "y GENROU 1", "v Bus 1"], 2),
        _Exist({"GENROU": object()}, {}),
    )
    ss.no_check_init = [0]
    result = _wrapper_with(ss).init_tds(test_init=False)
    assert [r.name for r in result.residuals] == ["v Bus 1"]
    assert result.max_residual == 0.5
    # Read, not written: the System's own residuals are as ``init()`` left them.
    assert ss.dae.fg[0] == 5.0


@pytest.mark.unit
def test_a_passing_case_reports_empty_lists_and_test_ok_true() -> None:
    pytest.importorskip("andes")
    import andes

    ss = andes.load(
        andes.get_case("kundur/kundur_full.xlsx"),
        setup=False,
        no_output=True,
    )
    wrapper = Wrapper(workspace=None, session_id="s", owner_pid=None)
    wrapper._ss = ss  # noqa: SLF001
    result = wrapper.init_tds()
    assert result.initialized is True
    assert result.test_ok is True
    assert result.test_init is True
    assert result.n_states > 0
    assert result.clamped == []
    assert result.residuals == []
    assert result.diagnostics_truncated is False
    # No step was taken.
    assert float(ss.dae.t) == 0.0
    assert int(ss.dae.kcount) == 0
