"""Unit tests for ``Wrapper.run_eig_sweep``: its checks and what it does with
the Systems it builds.

The session's System and the Systems the sweep builds are stand-ins: the sweep
reads the session's ``models`` (real ANDES ``NumParam`` and ``ExtParam``
objects, since those are what it tells apart), its ``PFlow`` and ``TDS``, and
builds each point's System through ``_build_system``, which a test replaces.
That each point equals an analysis of a System read with the value, on a real
case, is ``tests/integration/test_eig_sweep_api.py``.
"""

from __future__ import annotations

import math
import weakref
from types import SimpleNamespace
from typing import Any

import pytest
from andes.core.param import ExtParam, NumParam

from tensa.core.edit_log import EditOp
from tensa.core.errors import (
    EigComputationError,
    EigPrerequisiteError,
    ElementNotFoundError,
)
from tensa.core.pflow_options import PflowSettings
from tensa.core.wrapper import Wrapper
from tensa.core.wrapper.eig import _SWEEP_MAX_POINTS


class _Model:
    """A model with two devices, ``1`` and ``2``: a ``NumParam`` ``M``, an
    ``ExtParam`` ``Sn`` and a service ``Mt`` that is not among its params."""

    def __init__(self, m: list[float]) -> None:
        self.idx = SimpleNamespace(v=["1", "2"])
        self.M = NumParam(name="M")
        self.M.v = list(m)
        self.Sn = ExtParam(model="StaticGen", src="Sn", indexer=None, name="Sn")
        self.Mt = SimpleNamespace(v=[0.0, 0.0])
        self.params = {"idx": self.idx, "M": self.M, "Sn": self.Sn}


class _Session:
    """The session's System: set up, its power flow solved."""

    def __init__(self, *, setup: bool = True, converged: bool = True) -> None:
        self.GENROU = _Model([10.0, 12.0])
        self.models = {"GENROU": self.GENROU}
        self.is_setup = setup
        self.PFlow = SimpleNamespace(converged=converged)
        self.TDS = SimpleNamespace(initialized=False)
        self.EIG = SimpleNamespace(config=SimpleNamespace(tol=1e-6), mu=None, As=None)


class _Built:
    """A System the sweep builds: it records what was written before setup and
    the power-flow settings it was solved with, and its eigenvalues follow the
    ``M`` of device ``2`` as it stood when it was set up."""

    def __init__(self, log: list[_Built], *, mu: Any = None, converge: bool = True) -> None:
        self.GENROU = _Model([10.0, 12.0])
        self.models = {"GENROU": self.GENROU}
        self.Bus = SimpleNamespace(config=SimpleNamespace(flat_start=0))
        self.PFlow = SimpleNamespace(
            config=SimpleNamespace(
                tol=1e-6, max_iter=25, method="NR", n_factorize=4, linesearch=1
            ),
            converged=False,
            run=self._pflow,
        )
        self.EIG = SimpleNamespace(run=self._eig, mu=None)
        self.mu = mu
        self.converge = converge
        self.m_at_setup: float | None = None
        self.pflow_with: tuple[float, int, int] | None = None
        self.solver_with: tuple[str, int, int] | None = None
        log.append(self)

    def setup(self) -> bool:
        self.m_at_setup = float(self.GENROU.M.v[1])
        return True

    def _pflow(self) -> None:
        self.pflow_with = (
            float(self.PFlow.config.tol),
            int(self.PFlow.config.max_iter),
            int(self.Bus.config.flat_start),
        )
        self.solver_with = (
            str(self.PFlow.config.method),
            int(self.PFlow.config.n_factorize),
            int(self.PFlow.config.linesearch),
        )
        self.PFlow.converged = self.converge

    def _eig(self) -> bool:
        m = self.m_at_setup or 0.0
        self.EIG.mu = (
            self.mu if self.mu is not None else [complex(-1.0, m), complex(-1.0, -m), -m]
        )
        return True


def _sweeping(
    session: _Session, *, built: list[_Built] | None = None, **kwargs: Any
) -> tuple[Wrapper, list[_Built], list[Any]]:
    """A wrapper on ``session`` whose ``_build_system`` hands out ``_Built``
    Systems, recording each and the edit log it was asked for."""
    wrapper = Wrapper(workspace=None, session_id="eig-sweep", owner_pid=0)
    wrapper._ss = session  # type: ignore[assignment]  # noqa: SLF001
    made: list[_Built] = [] if built is None else built
    asked: list[Any] = []

    def build(ops: Any) -> _Built:
        asked.append(list(ops))
        return _Built(made, **kwargs)

    wrapper._build_system = build  # type: ignore[method-assign,assignment]  # noqa: SLF001
    return wrapper, made, asked


# ---- the target --------------------------------------------------------------


@pytest.mark.unit
def test_an_unknown_model_is_not_found() -> None:
    wrapper, made, _ = _sweeping(_Session())
    with pytest.raises(ElementNotFoundError, match="model 'NOPE' does not exist"):
        wrapper.run_eig_sweep("NOPE", "1", "M", [1.0])
    assert made == []


@pytest.mark.unit
def test_an_unknown_device_is_not_found() -> None:
    wrapper, made, _ = _sweeping(_Session())
    with pytest.raises(ElementNotFoundError, match="GENROU '9' does not exist"):
        wrapper.run_eig_sweep("GENROU", "9", "M", [1.0])
    assert made == []


@pytest.mark.unit
@pytest.mark.parametrize(
    "param",
    [
        "NOPE",  # not there at all
        "Sn",  # copied from another model at setup
        "Mt",  # a service: worked out again at setup
        "idx",  # not a number
    ],
)
def test_a_name_that_is_not_a_parameter_an_edit_can_write_is_not_found(param: str) -> None:
    wrapper, made, _ = _sweeping(_Session())
    with pytest.raises(ElementNotFoundError, match=f"GENROU has no parameter '{param}'"):
        wrapper.run_eig_sweep("GENROU", "1", param, [1.0])
    assert made == []


# ---- the values --------------------------------------------------------------


@pytest.mark.unit
@pytest.mark.parametrize(
    ("values", "match"),
    [
        ([], "must not be empty"),
        ([1.0] * (_SWEEP_MAX_POINTS + 1), f"at most {_SWEEP_MAX_POINTS} values"),
        ([1.0, math.nan], "position 1 is not a finite number"),
        ([1.0, math.inf], "position 1 is not a finite number"),
        ([-math.inf], "position 0 is not a finite number"),
        ([1.0, 2.0, True], "position 2 is not a finite number"),
        ([1.0, "2"], "position 1 is not a finite number"),
        ([10**400], "position 0 is not a finite number"),
        (None, "must be a list of numbers"),
        (3.0, "must be a list of numbers"),
    ],
)
def test_values_that_are_not_1_to_200_finite_numbers_are_refused(
    values: Any, match: str
) -> None:
    wrapper, made, _ = _sweeping(_Session())
    with pytest.raises(EigComputationError, match=match):
        wrapper.run_eig_sweep("GENROU", "1", "M", values)
    assert made == []


@pytest.mark.unit
def test_the_bound_is_200_values_and_200_are_taken() -> None:
    assert _SWEEP_MAX_POINTS == 200
    wrapper, made, _ = _sweeping(_Session())
    result = wrapper.run_eig_sweep("GENROU", "2", "M", [float(v) for v in range(1, 201)])
    assert len(result.points) == 200
    assert len(made) == 200


@pytest.mark.unit
def test_integers_are_taken_as_numbers() -> None:
    wrapper, _, _ = _sweeping(_Session())
    result = wrapper.run_eig_sweep("GENROU", "2", "M", [3, 4])
    assert [p.value for p in result.points] == [3.0, 4.0]


# ---- the gate ----------------------------------------------------------------


@pytest.mark.unit
@pytest.mark.parametrize(("setup", "converged"), [(True, False), (False, False), (False, True)])
def test_without_a_converged_power_flow_the_sweep_is_refused(
    setup: bool, converged: bool
) -> None:
    session = _Session(setup=setup, converged=converged)
    wrapper, made, _ = _sweeping(session)
    with pytest.raises(EigPrerequisiteError, match="Run PFlow first"):
        wrapper.run_eig_sweep("GENROU", "1", "M", [1.0, 2.0])
    assert made == []
    assert session.is_setup is setup  # the gate sets nothing up


# ---- the points --------------------------------------------------------------


@pytest.mark.unit
def test_each_value_is_written_before_setup_on_a_system_of_its_own() -> None:
    session = _Session()
    wrapper, made, asked = _sweeping(session)
    edit = EditOp(model="GENROU", idx="1", params={"M": 11.0})
    wrapper._edit_log = [edit]  # noqa: SLF001

    result = wrapper.run_eig_sweep("GENROU", "2", "M", [4.0, 6.0])

    # One System per value, each built from the session's edits.
    assert len(made) == 2
    assert asked == [[edit], [edit]]
    # The value was in place at setup, on the device named and on no other.
    assert [b.m_at_setup for b in made] == [4.0, 6.0]
    assert [b.GENROU.M.v[0] for b in made] == [10.0, 10.0]
    # The eigenvalues are those of the System with that value.
    assert [p.value for p in result.points] == [4.0, 6.0]
    assert [p.eigenvalues[0].imag for p in result.points] == [4.0, 6.0]
    assert result.model == "GENROU"
    assert result.idx == "2"
    assert result.param == "M"
    assert result.mode_count == 3
    for point in result.points:
        assert len(point.damping_ratios) == len(point.eigenvalues) == 3
        assert len(point.frequencies_hz) == 3
        assert point.frequencies_hz[0] == pytest.approx(point.value / (2 * math.pi))


@pytest.mark.unit
def test_the_sessions_system_is_left_as_it_was() -> None:
    session = _Session()
    session.EIG.mu = ["before"]
    wrapper, _, _ = _sweeping(session)

    result = wrapper.run_eig_sweep("GENROU", "2", "M", [4.0, 6.0])

    assert session.GENROU.M.v == [10.0, 12.0]
    assert session.TDS.initialized is False
    assert session.EIG.mu == ["before"]
    assert result.tds_initialized is False


@pytest.mark.unit
def test_a_point_that_fails_names_its_value_and_leaves_the_session_as_it_was() -> None:
    session = _Session()
    wrapper, made, _ = _sweeping(session)
    calls = {"n": 0}
    real_build = wrapper._build_system  # noqa: SLF001

    def build(ops: Any) -> Any:
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("singular Jacobian at /home/someone/case.raw")
        return real_build(ops)

    wrapper._build_system = build  # type: ignore[method-assign]  # noqa: SLF001
    with pytest.raises(EigComputationError) as caught:
        wrapper.run_eig_sweep("GENROU", "2", "M", [4.0, 6.0, 8.0])
    message = str(caught.value)
    assert "value 6.0 (point 1)" in message
    assert "/home/someone" not in message
    assert len(made) == 1  # the sweep stopped at the failure
    assert session.GENROU.M.v == [10.0, 12.0]
    assert session.TDS.initialized is False


@pytest.mark.unit
def test_a_point_whose_power_flow_does_not_converge_is_refused() -> None:
    wrapper, _, _ = _sweeping(_Session(), converge=False)
    with pytest.raises(EigComputationError, match=r"value 4\.0 \(point 0\).*did not converge"):
        wrapper.run_eig_sweep("GENROU", "2", "M", [4.0])


@pytest.mark.unit
def test_points_with_different_numbers_of_eigenvalues_are_refused() -> None:
    wrapper, _, _ = _sweeping(_Session())
    sizes = iter([[-1.0, -2.0], [-1.0]])

    real_build = wrapper._build_system  # noqa: SLF001

    def build(ops: Any) -> Any:
        system = real_build(ops)
        system.mu = next(sizes)
        return system

    wrapper._build_system = build  # type: ignore[method-assign]  # noqa: SLF001
    with pytest.raises(EigComputationError, match="count changed at point 1"):
        wrapper.run_eig_sweep("GENROU", "2", "M", [4.0, 6.0])


@pytest.mark.unit
def test_a_zero_eigenvalue_is_exactly_zero_with_a_damping_ratio_of_one() -> None:
    """The rule of ``run_eig`` (``_settle_zero``): what ANDES counts as zero is
    rounding noise whose sign differs between machines."""
    noise = [complex(3e-14, 0.0), complex(-2e-9, 1e-9), complex(1e-16, 5.0), complex(-0.5, 0.0)]
    wrapper, _, _ = _sweeping(_Session(), mu=noise)

    point = wrapper.run_eig_sweep("GENROU", "2", "M", [4.0]).points[0]

    assert (point.eigenvalues[0].real, point.eigenvalues[0].imag) == (0.0, 0.0)
    assert (point.eigenvalues[1].real, point.eigenvalues[1].imag) == (0.0, 0.0)
    assert point.damping_ratios[0] == 1.0
    assert point.damping_ratios[1] == 1.0
    # On the axis: an undamped mode, not a growing one.
    assert point.eigenvalues[2].real == 0.0
    assert point.damping_ratios[2] == 0.0
    assert point.damping_ratios[3] == 1.0


# ---- the power flow of each point --------------------------------------------


@pytest.mark.unit
def test_each_point_is_solved_with_the_settings_of_the_sessions_last_power_flow() -> None:
    session = _Session()
    wrapper, made, _ = _sweeping(session)
    settings = PflowSettings(
        tolerance=1e-9,
        max_iterations=40,
        flat_start=True,
        enforce_q_limits=False,
        method="NR",
        n_factorize=4,
        linesearch=True,
    )
    wrapper._pflow_settings = (weakref.ref(session), settings)  # type: ignore[arg-type]  # noqa: SLF001

    wrapper.run_eig_sweep("GENROU", "2", "M", [4.0, 6.0])

    assert [b.pflow_with for b in made] == [(1e-9, 40, 1), (1e-9, 40, 1)]
    # Each System's own settings are put back after its run.
    assert made[0].PFlow.config.tol == 1e-6


@pytest.mark.unit
def test_each_point_is_solved_with_the_method_of_the_sessions_last_power_flow() -> None:
    session = _Session()
    wrapper, made, _ = _sweeping(session)
    settings = PflowSettings(
        tolerance=1e-9,
        max_iterations=40,
        flat_start=True,
        enforce_q_limits=False,
        method="dishonest",
        n_factorize=7,
        linesearch=False,
    )
    wrapper._pflow_settings = (weakref.ref(session), settings)  # type: ignore[arg-type]  # noqa: SLF001

    wrapper.run_eig_sweep("GENROU", "2", "M", [4.0, 6.0])

    assert [b.solver_with for b in made] == [("dishonest", 7, 0), ("dishonest", 7, 0)]
    # Each System's own solver settings are put back after its run.
    config = made[0].PFlow.config
    assert (config.method, config.n_factorize, config.linesearch) == ("NR", 4, 1)


@pytest.mark.unit
def test_settings_of_a_power_flow_on_another_system_are_not_used() -> None:
    session = _Session()
    other = _Session()
    wrapper, made, _ = _sweeping(session)
    settings = PflowSettings(
        tolerance=1e-9,
        max_iterations=40,
        flat_start=True,
        enforce_q_limits=False,
        method="NR",
        n_factorize=4,
        linesearch=True,
    )
    wrapper._pflow_settings = (weakref.ref(other), settings)  # type: ignore[arg-type]  # noqa: SLF001

    wrapper.run_eig_sweep("GENROU", "2", "M", [4.0])

    assert made[0].pflow_with == (1e-6, 25, 0)
