"""Integration tests for the ANDES-driven streaming collector.

These exercise ``tensa.core.stream.StreamCollector`` against ANDES's bundled
IEEE 14 case (with the .dyr addfile so SynGen members exist). They are the
numeric ground-truth checks the unit tests, which run on stand-ins, can't
make: that the streamed line P/Q match ``wrapper._extract_line_flows``, the
load P/Q match ``wrapper._extract_load_consumption``, the generator state and
electrical power match direct ``SynGen.get`` reads, and that all of it still
holds at every step of a run with a fault, when the values are moving.

Markers: ``integration`` — imports ANDES and runs a real PF + TDS init, so
these take ~1-3 s each.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pytest

from tensa.core import stream as S
from tensa.core.wrapper import _extract_line_flows, _extract_load_consumption


def _ieee14_paths() -> tuple[Path, Path]:
    pytest.importorskip("andes")
    import andes

    cases = Path(andes.__file__).parent / "cases" / "ieee14"
    raw = cases / "ieee14.raw"
    dyr = cases / "ieee14.dyr"
    if not raw.exists() or not dyr.exists():  # pragma: no cover
        pytest.skip(f"IEEE 14 fixtures not bundled: {cases}")
    return raw, dyr


def _load_ieee14_post_pf_tds_init():  # type: ignore[no-untyped-def]
    """Load IEEE 14 + dynamics, run PF, init TDS so ``Pe``/``Qe`` populate.

    The streaming collectors read live values from ``callpert`` ticks, which
    fire *after* ``TDS.init``. Replicating ``TDS.init`` here mirrors the
    mid-run state without driving the whole integration loop.
    """
    import andes

    raw, dyr = _ieee14_paths()
    ss = andes.load(str(raw), addfile=str(dyr), setup=True, no_output=True)
    ss.PFlow.run()
    ss.TDS.init()
    return ss


@pytest.mark.integration
def test_combined_collector_column_count_matches_the_column_names_for_all_groups() -> None:
    """``StreamCollector`` returns exactly one float per column name
    (``t`` excluded) for every group selected. IEEE 14 + dyr:
    14 buses, 5 SynGen, 20 lines, 11 PQ loads → 2 columns each."""
    ss = _load_ieee14_post_pf_tds_init()
    groups = list(S.VAR_GROUPS)

    var_columns = S.var_column_names(groups, ss)
    bus_idx = S.bus_idx_values_from_system(ss)
    sg_idx = S.syngen_idx_values_from_system(ss)
    line_idx = S.line_idx_values_from_system(ss)
    pq_idx = S.pq_idx_values_from_system(ss)

    assert len(bus_idx) == 14
    assert len(sg_idx) == 5
    assert len(line_idx) == 20
    assert len(pq_idx) == 11

    expected = 2 * 14 + 2 * 5 + 2 * 5 + 2 * 20 + 2 * 11
    assert len(var_columns) == expected

    values = S.StreamCollector(ss, groups).collect()
    assert values.shape == (len(var_columns),)
    assert values.dtype == np.float64


@pytest.mark.integration
def test_streamed_line_pq_matches_wrapper_extract_line_flows() -> None:
    """The line collector's P and Q must match
    ``wrapper._extract_line_flows`` exactly on the converged state — the
    Q1 pi-equivalent formula is replicated, not approximated."""
    ss = _load_ieee14_post_pf_tds_init()
    line_idx = S.line_idx_values_from_system(ss)
    var_columns = S.var_column_names(["line_flow"], ss)
    values = S.StreamCollector(ss, ["line_flow"]).collect()
    name_to_value = dict(zip(var_columns, values, strict=True))

    flows = _extract_line_flows(ss)
    assert flows, "wrapper produced no line flows; fixture/PF broken"
    for idx in line_idx:
        ref = flows[str(idx)]
        got_p = name_to_value[f"Line_{idx}_p"]
        got_q = name_to_value[f"Line_{idx}_q"]
        assert got_p == pytest.approx(ref.p, abs=1e-9), f"P mismatch on {idx}"
        assert got_q == pytest.approx(ref.q, abs=1e-9), f"Q mismatch on {idx}"


@pytest.mark.integration
def test_streamed_load_pq_matches_wrapper_extract_load_consumption() -> None:
    """The load collector's P and Q must match
    ``wrapper._extract_load_consumption`` for the PQ model (Ppf/Qpf * mva)."""
    ss = _load_ieee14_post_pf_tds_init()
    pq_idx = S.pq_idx_values_from_system(ss)
    var_columns = S.var_column_names(["load_pq"], ss)
    values = S.StreamCollector(ss, ["load_pq"]).collect()
    name_to_value = dict(zip(var_columns, values, strict=True))

    loads = _extract_load_consumption(ss)
    assert loads, "wrapper produced no load consumption; fixture/PF broken"
    for idx in pq_idx:
        ref = loads[str(idx)]
        got_p = name_to_value[f"Load_{idx}_p"]
        got_q = name_to_value[f"Load_{idx}_q"]
        assert got_p == pytest.approx(ref.p, abs=1e-9), f"P mismatch on {idx}"
        assert got_q == pytest.approx(ref.q, abs=1e-9), f"Q mismatch on {idx}"


@pytest.mark.integration
def test_streamed_gen_power_matches_direct_syngen_get_times_mva() -> None:
    """``gen_power`` columns must equal ``SynGen.get('Pe'/'Qe') * mva``.
    Pe/Qe are system-base pu, so the MW/MVar conversion is a single mva
    multiply."""
    ss = _load_ieee14_post_pf_tds_init()
    sg_idx = S.syngen_idx_values_from_system(ss)
    var_columns = S.var_column_names(["gen_power"], ss)
    values = S.StreamCollector(ss, ["gen_power"]).collect()
    name_to_value = dict(zip(var_columns, values, strict=True))

    mva = float(ss.config.mva)
    pe_ref = [float(p) * mva for p in ss.SynGen.get("Pe", sg_idx, "v")]
    qe_ref = [float(q) * mva for q in ss.SynGen.get("Qe", sg_idx, "v")]
    for i, idx in enumerate(sg_idx):
        assert name_to_value[f"Gen_{idx}_Pe"] == pytest.approx(pe_ref[i], abs=1e-9)
        assert name_to_value[f"Gen_{idx}_Qe"] == pytest.approx(qe_ref[i], abs=1e-9)
        # Sanity: at least the slack/PV gens carry nonzero electrical power.
    assert any(abs(name_to_value[f"Gen_{idx}_Pe"]) > 1.0 for idx in sg_idx)


@pytest.mark.integration
def test_streamed_bus_angle_matches_bus_a_v() -> None:
    """The bus_v group now interleaves ``Bus_<idx>_v`` then
    ``Bus_<idx>_a``; the angle column must equal ``Bus.a.v`` (rad)."""
    ss = _load_ieee14_post_pf_tds_init()
    bus_idx = S.bus_idx_values_from_system(ss)
    var_columns = S.var_column_names(["bus_v"], ss)
    values = S.StreamCollector(ss, ["bus_v"]).collect()
    name_to_value = dict(zip(var_columns, values, strict=True))

    v_ref = [float(v) for v in ss.Bus.v.v]
    a_ref = [float(a) for a in ss.Bus.a.v]
    for i, idx in enumerate(bus_idx):
        assert name_to_value[f"Bus_{idx}_v"] == pytest.approx(v_ref[i], abs=1e-9)
        assert name_to_value[f"Bus_{idx}_a"] == pytest.approx(a_ref[i], abs=1e-9)
    # Slack bus angle is the reference (~0 rad).
    assert abs(name_to_value[f"Bus_{bus_idx[0]}_a"]) < 1e-6


@pytest.mark.integration
def test_no_syngen_case_yields_zero_gen_columns_but_well_formed_columns() -> None:
    """A case loaded without a .dyr addfile has zero SynGen members. The
    gen_state + gen_power groups contribute zero columns, but the column
    names and collected values stay well-formed (bus + line + load only)."""
    import andes

    raw, _dyr = _ieee14_paths()
    ss = andes.load(str(raw), setup=True, no_output=True)
    ss.PFlow.run()

    groups = list(S.VAR_GROUPS)
    sg_idx = S.syngen_idx_values_from_system(ss)
    assert sg_idx == []

    var_columns = S.var_column_names(groups, ss)
    assert not any(c.startswith("Gen_") for c in var_columns)

    values = S.StreamCollector(ss, groups).collect()
    assert len(values) == len(var_columns)
    assert all(math.isfinite(v) for v in values)


@pytest.mark.integration
def test_streamed_gen_state_matches_direct_syngen_get() -> None:
    """``gen_state`` columns must equal ``SynGen.get('delta'/'omega')``, in idx
    order, interleaved delta then omega."""
    ss = _load_ieee14_post_pf_tds_init()
    sg_idx = S.syngen_idx_values_from_system(ss)
    values = S.StreamCollector(ss, ["gen_state"]).collect()

    delta = np.asarray(ss.SynGen.get("delta", sg_idx, "v"), dtype=float)
    omega = np.asarray(ss.SynGen.get("omega", sg_idx, "v"), dtype=float)
    assert values[0::2].tolist() == delta.tolist()
    assert values[1::2].tolist() == omega.tolist()


@pytest.mark.integration
def test_generators_of_several_models_are_read_from_the_right_model() -> None:
    """NPCC has 21 GENCLS and 27 GENROU machines, so the SynGen members span two
    models whose uids restart at 0. Every column must be the member's own value,
    which a read by position within the wrong model would not give."""
    import andes

    cases = Path(andes.__file__).parent / "cases" / "npcc"
    raw, dyr = cases / "npcc.raw", cases / "npcc_full.dyr"
    if not raw.exists() or not dyr.exists():  # pragma: no cover
        pytest.skip(f"NPCC fixtures not bundled: {cases}")
    ss = andes.load(str(raw), addfile=str(dyr), setup=True, no_output=True)
    ss.PFlow.run()
    ss.TDS.init()

    sg_idx = S.syngen_idx_values_from_system(ss)
    models = {type(m).__name__ for m in ss.SynGen.idx2model(sg_idx)}
    assert models == {"GENCLS", "GENROU"}

    values = S.StreamCollector(ss, ["gen_state", "gen_power"]).collect()
    n = len(sg_idx)
    mva = float(ss.config.mva)
    expected = {
        "delta": np.asarray(ss.SynGen.get("delta", sg_idx, "v"), dtype=float),
        "omega": np.asarray(ss.SynGen.get("omega", sg_idx, "v"), dtype=float),
        "Pe": np.asarray(ss.SynGen.get("Pe", sg_idx, "v"), dtype=float) * mva,
        "Qe": np.asarray(ss.SynGen.get("Qe", sg_idx, "v"), dtype=float) * mva,
    }
    assert values[0 : 2 * n : 2].tolist() == expected["delta"].tolist()
    assert values[1 : 2 * n : 2].tolist() == expected["omega"].tolist()
    assert values[2 * n :: 2].tolist() == pytest.approx(expected["Pe"].tolist())
    assert values[2 * n + 1 :: 2].tolist() == pytest.approx(expected["Qe"].tolist())
    # Distinct machines, not one value repeated.
    assert len(set(values[0 : 2 * n : 2].tolist())) > n // 2


@pytest.mark.integration
def test_every_step_of_a_run_with_a_fault_matches_the_direct_reads() -> None:
    """The collector is built before the run starts, while the state is still
    the power-flow solution, and then reads every step of a run that includes a
    fault and its clearing. Each step's row must equal what the same groups read
    directly off the System at that step (``Bus.v.v`` and ``Bus.a.v``,
    ``SynGen.get``, and the wrapper's own line-flow and load formulae). A
    collector that kept the values of the step it was built at would stay put."""
    import andes

    raw, dyr = _ieee14_paths()
    ss = andes.load(str(raw), addfile=str(dyr), setup=False, no_output=True)
    ss.add("Fault", {"bus": 9, "tf": 0.1, "tc": 0.2, "xf": 0.01, "rf": 0.0})
    ss.setup()
    ss.PFlow.run()

    groups = list(S.VAR_GROUPS)
    collector = S.StreamCollector(ss, groups)
    line_idx = S.line_idx_values_from_system(ss)
    sg_idx = S.syngen_idx_values_from_system(ss)
    pq_idx = S.pq_idx_values_from_system(ss)
    mva = float(ss.config.mva)

    rows: list[np.ndarray] = []

    def on_step(_t: float, system: object) -> None:
        row = collector.collect()
        rows.append(row)
        flows = _extract_line_flows(ss)
        loads = _extract_load_consumption(ss)
        expected: list[float] = []
        for v, a in zip(ss.Bus.v.v, ss.Bus.a.v, strict=True):
            expected += [float(v), float(a)]
        for d, w in zip(
            ss.SynGen.get("delta", sg_idx, "v"), ss.SynGen.get("omega", sg_idx, "v"), strict=True
        ):
            expected += [float(d), float(w)]
        for p, q in zip(
            ss.SynGen.get("Pe", sg_idx, "v"), ss.SynGen.get("Qe", sg_idx, "v"), strict=True
        ):
            expected += [float(p) * mva, float(q) * mva]
        for idx in line_idx:
            expected += [flows[str(idx)].p, flows[str(idx)].q]
        for idx in pq_idx:
            expected += [loads[str(idx)].p, loads[str(idx)].q]
        assert row.tolist() == pytest.approx(expected, abs=1e-9)

    ss.TDS.config.tf = 0.4
    ss.TDS.config.tstep = 1 / 60
    ss.TDS.config.fixt = 1
    ss.TDS.callpert = on_step
    ss.TDS.run()

    assert len(rows) > 15
    # The fault moves things: the rows are not the initial one repeated.
    delta_first, delta_last = rows[0][28 + 0], rows[-1][28 + 0]
    assert abs(delta_last - delta_first) > 1e-3
    assert not np.allclose(rows[0], rows[-1])
