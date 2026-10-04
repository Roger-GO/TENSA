"""Unit tests for ``StreamCollector``, the per-step value reader of a TDS stream.

These run against stand-ins for the parts of an ANDES System the collector
touches, so what is checked is the collector's own logic: where each value
lands in the row, how a degraded System reads, and that a row is the step's
values and not a view of ANDES's arrays. The numeric ground truth against a
real System (the wrapper's own line-flow and load formulae, ``SynGen.get``) is
in ``tests/integration/test_stream_collectors.py``.
"""

from __future__ import annotations

import logging
import math
import warnings
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

from tensa.core.stream import VAR_GROUPS, StreamCollector

pytestmark = pytest.mark.unit

MVA = 100.0


def _param(values: list[float] | list[int] | list[str]) -> SimpleNamespace:
    """An ANDES variable, parameter or service: an object with a ``.v`` array."""
    return SimpleNamespace(v=np.array(values))


def _line_params(n: int, rng: np.random.Generator) -> dict[str, SimpleNamespace]:
    """Plausible random values for the twelve arrays the line-flow group reads."""
    return {
        "v1": _param(list(rng.uniform(0.95, 1.05, n))),
        "v2": _param(list(rng.uniform(0.95, 1.05, n))),
        "a1": _param(list(rng.uniform(-0.3, 0.3, n))),
        "a2": _param(list(rng.uniform(-0.3, 0.3, n))),
        "phi": _param(list(rng.uniform(-0.05, 0.05, n))),
        "ue": _param([1.0] * n),
        "gh": _param(list(rng.uniform(0.0, 0.01, n))),
        "bh": _param(list(rng.uniform(0.0, 0.1, n))),
        "ghk": _param(list(rng.uniform(1.0, 5.0, n))),
        "bhk": _param(list(rng.uniform(-20.0, -5.0, n))),
        "itap": _param(list(rng.uniform(0.95, 1.05, n))),
        "itap2": _param(list(rng.uniform(0.9, 1.1, n))),
    }


def _scalar_line_flow(
    p: dict[str, SimpleNamespace], i: int
) -> tuple[float, float]:
    """One line's terminal-1 P and Q in MW / MVar, one scalar at a time: the
    formulae the collector used to evaluate in a Python loop, kept as the
    oracle for the array expressions."""
    v1, v2 = p["v1"].v[i], p["v2"].v[i]
    d = p["a1"].v[i] - p["a2"].v[i] - p["phi"].v[i]
    gh, bh, ghk, bhk = (p[k].v[i] for k in ("gh", "bh", "ghk", "bhk"))
    itap, itap2, ue = p["itap"].v[i], p["itap2"].v[i], p["ue"].v[i]
    p_pu = ue * (
        v1 * v1 * (gh + ghk) * itap2
        - v1 * v2 * (ghk * math.cos(d) + bhk * math.sin(d)) * itap
    )
    q_pu = ue * (
        -v1 * v1 * (bh + bhk) * itap2
        - v1 * v2 * (ghk * math.sin(d) - bhk * math.cos(d)) * itap
    )
    return float(p_pu * MVA), float(q_pu * MVA)


def _system(**models: Any) -> SimpleNamespace:
    """A System with a bus model, a configuration, and whatever else is given."""
    models.setdefault(
        "Bus",
        SimpleNamespace(
            idx=_param([1, 2, 3]),
            v=_param([1.0, 0.98, 1.02]),
            a=_param([0.0, -0.1, 0.05]),
        ),
    )
    return SimpleNamespace(config=SimpleNamespace(mva=MVA), **models)


def _syngen() -> SimpleNamespace:
    """Three generators of two models, listed so that the second model's
    member sits between the first model's: G1 and G3 are in model A, G2 in
    model B, and a uid inside a model is not the generator's position."""
    model_a = SimpleNamespace(
        uid={"G3": 0, "G1": 1},
        delta=_param([0.30, 0.10]),
        omega=_param([1.003, 1.001]),
        Pe=_param([0.7, 0.5]),
        Qe=_param([0.07, 0.05]),
    )
    model_b = SimpleNamespace(
        uid={"G2": 0},
        delta=_param([0.20]),
        omega=_param([1.002]),
        Pe=_param([0.6]),
        Qe=_param([0.06]),
    )
    for model in (model_a, model_b):
        model.idx2uid = model.uid.__getitem__  # type: ignore[attr-defined]
    owners = {"G1": model_a, "G2": model_b, "G3": model_a}
    return SimpleNamespace(
        get_all_idxes=lambda: ["G1", "G2", "G3"],
        idx2model=lambda idx: [owners[i] for i in idx],
    )


# ---- row layout ---------------------------------------------------------------


def test_bus_columns_interleave_voltage_and_angle() -> None:
    collector = StreamCollector(_system(), ["bus_v"])

    assert collector.n_columns == 6
    assert collector.collect().tolist() == [1.0, 0.0, 0.98, -0.1, 1.02, 0.05]


def test_generators_of_different_models_land_in_idx_order() -> None:
    """The members are read model by model but must come out in idx order:
    delta then omega per generator, whichever model holds it."""
    collector = StreamCollector(_system(SynGen=_syngen()), ["gen_state"])

    assert collector.collect().tolist() == [
        0.10, 1.001,  # G1: model A, uid 1
        0.20, 1.002,  # G2: model B, uid 0
        0.30, 1.003,  # G3: model A, uid 0
    ]  # fmt: skip


def test_generator_power_is_scaled_to_mw_and_mvar() -> None:
    collector = StreamCollector(_system(SynGen=_syngen()), ["gen_power"])

    assert collector.collect().tolist() == pytest.approx(
        [50.0, 5.0, 60.0, 6.0, 70.0, 7.0]
    )


def test_groups_come_out_in_canonical_order_whatever_the_request_order() -> None:
    system = _system(
        SynGen=_syngen(),
        PQ=SimpleNamespace(idx=_param(["L1"]), Ppf=_param([0.5]), Qpf=_param([0.1])),
    )
    ordered = StreamCollector(system, ["bus_v", "gen_state", "load_pq"]).collect()
    shuffled = StreamCollector(system, ["load_pq", "gen_state", "bus_v"]).collect()

    assert ordered.shape == (6 + 6 + 2,)
    assert shuffled.tolist() == ordered.tolist()
    assert ordered[-2:].tolist() == pytest.approx([50.0, 10.0])


def test_a_group_with_no_devices_has_no_columns() -> None:
    """A case without dynamic generators has no SynGen members, and no load or
    line either here: those groups are zero columns wide, and a run that
    selects only them streams ``t`` alone."""
    system = _system(SynGen=SimpleNamespace(get_all_idxes=lambda: []))
    system.Line = SimpleNamespace(idx=_param([]))
    system.PQ = SimpleNamespace(idx=_param([]))

    collector = StreamCollector(system, list(VAR_GROUPS)[1:])

    assert collector.n_columns == 0
    assert collector.collect().shape == (0,)


def test_a_system_without_the_models_of_a_group_has_no_columns_for_it() -> None:
    collector = StreamCollector(_system(), ["gen_state", "gen_power", "line_flow", "load_pq"])

    assert collector.n_columns == 0


def test_an_unknown_group_is_refused() -> None:
    with pytest.raises(ValueError, match="unknown var groups"):
        StreamCollector(_system(), ["bus_v", "gen_speed"])  # type: ignore[list-item]


# ---- the values are the step's ------------------------------------------------


def test_each_step_reads_what_andes_holds_now() -> None:
    """Addresses are resolved once, values are not: ANDES changes its arrays in
    place as the run goes, and the next row must show it."""
    system = _system()
    collector = StreamCollector(system, ["bus_v"])
    before = collector.collect()

    system.Bus.v.v[1] = 0.5  # in place, as ANDES does at every step
    after = collector.collect()

    assert before[2] == 0.98
    assert after[2] == 0.5


def _recording(log: list[str], name: str, fn: Any) -> Any:
    """``fn`` that notes each call to it in ``log``."""

    def call(*args: Any) -> Any:
        log.append(name)
        return fn(*args)

    return call


def test_generators_are_looked_up_when_the_run_starts_and_not_at_every_step() -> None:
    """ANDES's ``SynGen.get`` looks every idx up again on each call, which for
    two variables is a few hundred dictionary lookups a step on a large case.
    The collector asks the group where each generator lives once."""
    syngen = _syngen()
    lookups: list[str] = []
    members = syngen.idx2model(["G1", "G2", "G3"])
    syngen.idx2model = _recording(lookups, "idx2model", syngen.idx2model)
    for model in {id(m): m for m in members}.values():
        model.idx2uid = _recording(lookups, "idx2uid", model.idx2uid)

    collector = StreamCollector(_system(SynGen=syngen), ["gen_state", "gen_power"])
    at_start = list(lookups)
    for _ in range(10):
        collector.collect()

    assert at_start.count("idx2model") == 2  # once for each group read
    assert lookups == at_start


def test_a_row_is_a_copy_of_the_values_and_not_a_view_of_andes_arrays() -> None:
    """The aggregator keeps rows until their window closes; a row that still
    pointed into ANDES's arrays would read as the newest step's values."""
    system = _system(SynGen=_syngen())
    collector = StreamCollector(system, ["bus_v", "gen_state"])
    row = collector.collect()
    snapshot = row.tolist()

    system.Bus.v.v[:] = 0.0
    system.Bus.a.v[:] = 0.0
    for model in {id(m): m for m in system.SynGen.idx2model(["G1", "G2"])}.values():
        model.delta.v[:] = 9.0
        model.omega.v[:] = 9.0

    assert row.tolist() == snapshot
    assert collector.collect() is not row


# ---- line flow and load -------------------------------------------------------


def test_line_flow_matches_the_scalar_formula() -> None:
    rng = np.random.default_rng(7)
    params = _line_params(40, rng)
    system = _system(Line=SimpleNamespace(idx=_param(list(range(40))), **params))

    row = StreamCollector(system, ["line_flow"]).collect()

    assert row.shape == (80,)
    expected = [x for i in range(40) for x in _scalar_line_flow(params, i)]
    assert row.tolist() == pytest.approx(expected, rel=1e-12, abs=1e-12)


def test_a_line_that_is_out_of_service_carries_no_flow() -> None:
    """``Line.ue`` is the line's status as ANDES updates it when a breaker
    toggles, so a tripped line reads zero from the next step on."""
    params = _line_params(3, np.random.default_rng(1))
    system = _system(Line=SimpleNamespace(idx=_param([1, 2, 3]), **params))
    collector = StreamCollector(system, ["line_flow"])
    assert abs(collector.collect()[2]) > 0

    system.Line.ue.v[1] = 0.0

    assert collector.collect()[2:4].tolist() == [0.0, 0.0]


def test_non_finite_line_values_emit_nan_without_raising_or_warning() -> None:
    """A divergent step leaves infinities in the algebraic variables. The
    columns of that line read ``nan``, the others are untouched, and numpy's
    floating-point warnings stay out of the run's log."""
    params = _line_params(3, np.random.default_rng(2))
    params["a1"].v[1] = np.inf
    params["v2"].v[2] = np.nan
    system = _system(Line=SimpleNamespace(idx=_param([1, 2, 3]), **params))

    with warnings.catch_warnings():
        warnings.simplefilter("error")
        row = StreamCollector(system, ["line_flow"]).collect()

    assert np.isnan(row[2:6]).all()
    assert row[0:2].tolist() == pytest.approx(list(_scalar_line_flow(params, 0)))


def test_load_reads_post_flow_power_in_mw_and_mvar() -> None:
    pq = SimpleNamespace(
        idx=_param(["L1", "L2"]),
        Ppf=_param([0.5, 0.25]),
        Qpf=_param([0.1, 0.05]),
        p0=_param([9.0, 9.0]),
        q0=_param([9.0, 9.0]),
    )
    row = StreamCollector(_system(PQ=pq), ["load_pq"]).collect()

    assert row.tolist() == pytest.approx([50.0, 10.0, 25.0, 5.0])


def test_load_falls_back_to_its_setpoints_without_post_flow_power() -> None:
    pq = SimpleNamespace(idx=_param(["L1"]), p0=_param([0.4]), q0=_param([0.08]))

    row = StreamCollector(_system(PQ=pq), ["load_pq"]).collect()

    assert row.tolist() == pytest.approx([40.0, 8.0])


def test_a_non_finite_load_reads_nan() -> None:
    pq = SimpleNamespace(
        idx=_param(["L1", "L2"]), Ppf=_param([np.inf, 0.25]), Qpf=_param([0.1, np.nan])
    )

    row = StreamCollector(_system(PQ=pq), ["load_pq"]).collect()

    assert np.isnan(row[0]) and np.isnan(row[3])
    assert row[1:3].tolist() == pytest.approx([10.0, 25.0])


# ---- a System that does not look as expected ----------------------------------


def test_a_missing_angle_array_emits_nan_angles_and_says_so_once(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The warning used to be logged at every step of the run."""
    system = _system(
        Bus=SimpleNamespace(idx=_param([1, 2]), v=_param([1.0, 0.9]))
    )
    collector = StreamCollector(system, ["bus_v"])

    with caplog.at_level(logging.WARNING, logger="tensa.stream"):
        rows = [collector.collect() for _ in range(5)]

    for row in rows:
        assert row[0::2].tolist() == [1.0, 0.9]
        assert np.isnan(row[1::2]).all()
    assert [r.getMessage() for r in caplog.records].count(
        "Bus.a.v is missing or not 2 values long; emitting NaN columns"
    ) == 1


def test_a_missing_line_array_emits_nan_for_every_line_column(
    caplog: pytest.LogCaptureFixture,
) -> None:
    params = _line_params(2, np.random.default_rng(3))
    del params["itap"]
    system = _system(Line=SimpleNamespace(idx=_param([1, 2]), **params))
    collector = StreamCollector(system, ["bus_v", "line_flow"])

    with caplog.at_level(logging.WARNING, logger="tensa.stream"):
        rows = [collector.collect() for _ in range(3)]

    for row in rows:
        assert row[:6].tolist() == [1.0, 0.0, 0.98, -0.1, 1.02, 0.05]
        assert np.isnan(row[6:]).all()
    assert len([r for r in caplog.records if "Line.itap.v" in r.getMessage()]) == 1


def test_an_array_of_the_wrong_length_reads_as_nan() -> None:
    pq = SimpleNamespace(
        idx=_param(["L1", "L2"]), Ppf=_param([0.5]), Qpf=_param([0.1, 0.05])
    )

    row = StreamCollector(_system(PQ=pq), ["load_pq"]).collect()

    assert np.isnan(row[0::2]).all()
    assert row[1::2].tolist() == pytest.approx([10.0, 5.0])
