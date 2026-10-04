"""Unit tests for the two-ended line flows and the generator reactive limits.

``_extract_line_flows`` reports the power at both ends of a line, its loss and
its loading against ``rate_a``; ``_extract_generator_outputs`` reports each
generator's ``qmin`` / ``qmax`` in MVAr. These run against stand-ins for the
parts of an ANDES System they read, so what is checked is the arithmetic and
the edge cases (an unrated line, a switched-off generator, a missing
attribute). The numeric ground truth against a real System is in
``tests/integration/test_pflow_limits.py``.
"""

from __future__ import annotations

import math
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

from tensa.core.wrapper import (
    _extract_generator_outputs,
    _extract_line_flows,
    _extract_load_consumption,
)

pytestmark = pytest.mark.unit

MVA = 100.0


def _param(values: list[Any]) -> SimpleNamespace:
    """An ANDES variable, parameter or service: an object with a ``.v`` array."""
    return SimpleNamespace(v=np.array(values))


def _line_system(
    *,
    r: float = 0.01,
    x: float = 0.1,
    b: float = 0.0,
    v1: float = 1.02,
    v2: float = 0.99,
    a1: float = 0.05,
    a2: float = -0.02,
    ue: float = 1.0,
    rate_a: float | None = 0.0,
    mva: float = MVA,
) -> SimpleNamespace:
    """A one-line System: a plain line (no tap, no phase shift) of series
    impedance ``r + jx`` and total charging ``b``, split half to each end."""
    y = 1.0 / complex(r, x)
    line: dict[str, Any] = {
        "idx": _param(["L1"]),
        "bus1": _param([1]),
        "bus2": _param([2]),
        "v1": _param([v1]),
        "v2": _param([v2]),
        "a1": _param([a1]),
        "a2": _param([a2]),
        "phi": _param([0.0]),
        "ue": _param([ue]),
        "gh": _param([0.5 * 0.0]),
        "bh": _param([0.5 * b]),
        "ghk": _param([y.real]),
        "bhk": _param([y.imag]),
        "itap": _param([1.0]),
        "itap2": _param([1.0]),
    }
    if rate_a is not None:
        line["rate_a"] = _param([rate_a])
    return SimpleNamespace(Line=SimpleNamespace(**line), config=SimpleNamespace(mva=mva))


def _complex_flows(
    *, r: float, x: float, b: float, v1: float, v2: float, a1: float, a2: float
) -> tuple[complex, complex]:
    """Power injected into the line at each end, by complex circuit analysis:
    the independent oracle for the pi-equivalent formulae, in pu."""
    e1 = v1 * np.exp(1j * a1)
    e2 = v2 * np.exp(1j * a2)
    y = 1.0 / complex(r, x)
    ysh = 0.5j * b
    i1 = (e1 - e2) * y + e1 * ysh
    i2 = (e2 - e1) * y + e2 * ysh
    return complex(e1 * np.conj(i1)), complex(e2 * np.conj(i2))


@pytest.mark.parametrize("b", [0.0, 0.04])
def test_both_ends_match_a_circuit_analysis(b: float) -> None:
    params = {"r": 0.01, "x": 0.1, "b": b, "v1": 1.02, "v2": 0.99, "a1": 0.05, "a2": -0.02}
    flow = _extract_line_flows(_line_system(**params))["L1"]
    s1, s2 = _complex_flows(**params)

    assert flow.p == pytest.approx(s1.real * MVA)
    assert flow.q == pytest.approx(s1.imag * MVA)
    assert flow.p_to == pytest.approx(s2.real * MVA)
    assert flow.q_to == pytest.approx(s2.imag * MVA)


def test_loss_is_the_sum_of_the_two_terminal_injections() -> None:
    flow = _extract_line_flows(_line_system())["L1"]
    assert flow.loss == pytest.approx(flow.p + flow.p_to)
    # The flow runs from bus 1 to bus 2: it enters at one end and leaves at the other.
    assert flow.p > 0.0 > flow.p_to
    assert flow.loss > 0.0


def test_a_lossless_line_has_no_loss() -> None:
    flow = _extract_line_flows(_line_system(r=0.0))["L1"]
    assert flow.loss == pytest.approx(0.0, abs=1e-9)
    assert flow.p_to == pytest.approx(-flow.p)


def test_powers_follow_the_system_base() -> None:
    at_100 = _extract_line_flows(_line_system(mva=100.0))["L1"]
    at_1000 = _extract_line_flows(_line_system(mva=1000.0))["L1"]
    assert at_1000.p == pytest.approx(10.0 * at_100.p)
    assert at_1000.p_to == pytest.approx(10.0 * at_100.p_to)
    assert at_1000.loss == pytest.approx(10.0 * at_100.loss)


def test_loading_is_the_larger_terminal_apparent_power_over_the_rating() -> None:
    flow = _extract_line_flows(_line_system(b=0.04, rate_a=50.0))["L1"]
    s_from = math.hypot(flow.p, flow.q)
    s_to = math.hypot(flow.p_to, flow.q_to)
    assert s_from != pytest.approx(s_to)  # the two ends differ, so the choice matters
    assert flow.rate_a == 50.0
    assert flow.loading_pct == pytest.approx(max(s_from, s_to) / 50.0 * 100.0)


def test_a_line_over_its_rating_loads_past_100() -> None:
    flow = _extract_line_flows(_line_system(rate_a=10.0))["L1"]
    assert flow.loading_pct is not None
    assert flow.loading_pct > 100.0


@pytest.mark.parametrize("rate_a", [0.0, -5.0, float("nan"), None])
def test_a_line_without_a_usable_rating_has_no_loading(rate_a: float | None) -> None:
    flow = _extract_line_flows(_line_system(rate_a=rate_a))["L1"]
    assert flow.rate_a is None
    assert flow.loading_pct is None
    # Everything that does not depend on the rating is still reported.
    assert flow.p_to < 0.0
    assert flow.loss > 0.0


def test_a_line_out_of_service_carries_nothing() -> None:
    flow = _extract_line_flows(_line_system(ue=0.0, rate_a=50.0))["L1"]
    assert (flow.p, flow.q, flow.p_to, flow.q_to, flow.loss) == (0.0, 0.0, 0.0, 0.0, 0.0)
    assert flow.loading_pct == 0.0


def test_a_rating_array_of_the_wrong_length_leaves_every_line_unrated() -> None:
    system = _line_system(rate_a=50.0)
    system.Line.rate_a = _param([50.0, 50.0])
    flow = _extract_line_flows(system)["L1"]
    assert flow.rate_a is None
    assert flow.loading_pct is None


# ---- generator reactive limits ---------------------------------------------


def _gen_system(
    *,
    q: float = 0.3,
    qmin: float | None = -0.1,
    qmax: float | None = 0.2,
    u: float | None = 1.0,
    ue: float | None = None,
    mva: float = MVA,
) -> SimpleNamespace:
    pv: dict[str, Any] = {
        "idx": _param([2]),
        "bus": _param([2]),
        "p": _param([0.4]),
        "q": _param([q]),
        "v": _param([1.045]),
    }
    if qmin is not None:
        pv["qmin"] = _param([qmin])
    if qmax is not None:
        pv["qmax"] = _param([qmax])
    if u is not None:
        pv["u"] = _param([u])
    if ue is not None:
        pv["ue"] = _param([ue])
    return SimpleNamespace(PV=SimpleNamespace(**pv), config=SimpleNamespace(mva=mva))


def test_generator_limits_are_in_mvar_like_its_output() -> None:
    out = _extract_generator_outputs(_gen_system(q=0.3, qmin=-0.1, qmax=0.2))["2"]
    assert out.q == pytest.approx(30.0)
    assert out.q_min == pytest.approx(-10.0)
    assert out.q_max == pytest.approx(20.0)


def test_generator_limits_follow_the_system_base() -> None:
    out = _extract_generator_outputs(_gen_system(qmin=-0.1, qmax=0.2, mva=1000.0))["2"]
    assert out.q_min == pytest.approx(-100.0)
    assert out.q_max == pytest.approx(200.0)


def test_a_generator_switched_off_has_no_limits() -> None:
    out = _extract_generator_outputs(_gen_system(u=0.0))["2"]
    assert out.q_min is None
    assert out.q_max is None


def test_a_generator_switched_off_injects_nothing() -> None:
    # A PV generator's ``p`` is a copy of ``p0`` whatever ``u`` says (0.4 pu here).
    out = _extract_generator_outputs(_gen_system(q=0.3, u=0.0))["2"]
    assert out.p == 0.0
    assert out.q == 0.0
    in_service = _extract_generator_outputs(_gen_system(q=0.3, u=1.0))["2"]
    assert in_service.p == pytest.approx(40.0)
    assert in_service.q == pytest.approx(30.0)


def test_a_generator_on_a_bus_that_is_out_of_service_injects_nothing_and_has_no_limits() -> None:
    # Its own ``u`` is 1; the bus it hangs on is out, which ANDES carries in ``ue``.
    out = _extract_generator_outputs(_gen_system(q=0.3, u=1.0, ue=0.0))["2"]
    assert (out.p, out.q) == (0.0, 0.0)
    assert (out.q_min, out.q_max) == (None, None)


def test_a_generator_is_judged_by_ue_when_the_model_has_it() -> None:
    # ``ue`` is ``u`` less what a status parent takes out, so a ``ue`` of 1 is in service.
    out = _extract_generator_outputs(_gen_system(q=0.3, u=1.0, ue=1.0))["2"]
    assert out.p == pytest.approx(40.0)
    assert out.q_max == pytest.approx(20.0)


def _load_system(*, u: float | None, ue: float | None = None, mva: float = MVA) -> SimpleNamespace:
    pq: dict[str, Any] = {
        "idx": _param(["PQ_1"]),
        "bus": _param([4]),
        "Ppf": _param([0.5]),
        "Qpf": _param([0.2]),
    }
    if u is not None:
        pq["u"] = _param([u])
    if ue is not None:
        pq["ue"] = _param([ue])
    return SimpleNamespace(PQ=SimpleNamespace(**pq), config=SimpleNamespace(mva=mva))


def test_a_load_switched_off_draws_nothing() -> None:
    # ``Ppf`` / ``Qpf`` keep the set-point whatever ``u`` says.
    out = _extract_load_consumption(_load_system(u=0.0))["PQ_1"]
    assert out.p == 0.0
    assert out.q == 0.0


def test_a_load_on_a_bus_that_is_out_of_service_draws_nothing() -> None:
    out = _extract_load_consumption(_load_system(u=1.0, ue=0.0))["PQ_1"]
    assert (out.p, out.q) == (0.0, 0.0)


@pytest.mark.parametrize("u", [1.0, None])
def test_a_load_in_service_draws_its_power(u: float | None) -> None:
    out = _extract_load_consumption(_load_system(u=u))["PQ_1"]
    assert out.p == pytest.approx(50.0)
    assert out.q == pytest.approx(20.0)
    assert out.bus == 4


def test_a_generator_in_service_keeps_its_limits_when_u_is_missing() -> None:
    out = _extract_generator_outputs(_gen_system(u=None))["2"]
    assert out.q_min == pytest.approx(-10.0)
    assert out.q_max == pytest.approx(20.0)


@pytest.mark.parametrize("missing", ["qmin", "qmax"])
def test_a_missing_limit_is_none_and_the_other_survives(missing: str) -> None:
    kwargs: dict[str, Any] = {missing: None}
    out = _extract_generator_outputs(_gen_system(**kwargs))["2"]
    assert getattr(out, "q_" + missing[1:]) is None
    other = "q_max" if missing == "qmin" else "q_min"
    assert getattr(out, other) is not None


def test_a_non_finite_limit_is_none() -> None:
    out = _extract_generator_outputs(_gen_system(qmin=float("-inf"), qmax=float("nan")))["2"]
    assert out.q_min is None
    assert out.q_max is None
