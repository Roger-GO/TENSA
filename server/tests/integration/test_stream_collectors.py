"""Integration tests for the ANDES-driven streaming collectors.

These exercise ``andes_app.core.stream``'s per-tick value collectors against
ANDES's bundled IEEE 14 case (with the .dyr addfile so SynGen members exist).
They are the numeric ground-truth checks the unit schema tests can't make:
that the streamed line P/Q match ``wrapper._extract_line_flows``, the load
P/Q match ``wrapper._extract_load_consumption``, and the generator electrical
power matches a direct ``SynGen.get('Pe'/'Qe') * mva`` read.

Markers: ``integration`` — imports ANDES and runs a real PF + TDS init, so
these take ~1-3 s each.
"""

from __future__ import annotations

import math
from pathlib import Path

import pytest

from andes_app.core import stream as S
from andes_app.core.wrapper import _extract_line_flows, _extract_load_consumption


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
def test_combined_collector_column_count_matches_schema_for_all_groups() -> None:
    """``collect_combined_values`` returns exactly one float per schema
    column (excluding ``t``) for every group selected. IEEE 14 + dyr:
    14 buses, 5 SynGen, 20 lines, 11 PQ loads → 2 columns each."""
    ss = _load_ieee14_post_pf_tds_init()
    groups = list(S.VAR_GROUPS)

    _schema, var_columns = S.make_combined_schema(groups, ss)
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

    values = S.collect_combined_values(
        ss,
        groups,
        syngen_idx_values=sg_idx,
        line_idx_values=line_idx,
        pq_idx_values=pq_idx,
    )
    assert len(values) == len(var_columns)
    assert all(isinstance(v, float) for v in values)


@pytest.mark.integration
def test_streamed_line_pq_matches_wrapper_extract_line_flows() -> None:
    """The line collector's P and Q must match
    ``wrapper._extract_line_flows`` exactly on the converged state — the
    Q1 pi-equivalent formula is replicated, not approximated."""
    ss = _load_ieee14_post_pf_tds_init()
    line_idx = S.line_idx_values_from_system(ss)
    _schema, var_columns = S.make_combined_schema(["line_flow"], ss)
    values = S.collect_combined_values(
        ss,
        ["line_flow"],
        syngen_idx_values=[],
        line_idx_values=line_idx,
        pq_idx_values=[],
    )
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
    _schema, var_columns = S.make_combined_schema(["load_pq"], ss)
    values = S.collect_combined_values(
        ss,
        ["load_pq"],
        syngen_idx_values=[],
        line_idx_values=[],
        pq_idx_values=pq_idx,
    )
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
    _schema, var_columns = S.make_combined_schema(["gen_power"], ss)
    values = S.collect_combined_values(
        ss,
        ["gen_power"],
        syngen_idx_values=sg_idx,
        line_idx_values=[],
        pq_idx_values=[],
    )
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
    _schema, var_columns = S.make_combined_schema(["bus_v"], ss)
    values = S.collect_combined_values(
        ss,
        ["bus_v"],
        syngen_idx_values=[],
        line_idx_values=[],
        pq_idx_values=[],
    )
    name_to_value = dict(zip(var_columns, values, strict=True))

    v_ref = [float(v) for v in ss.Bus.v.v]
    a_ref = [float(a) for a in ss.Bus.a.v]
    for i, idx in enumerate(bus_idx):
        assert name_to_value[f"Bus_{idx}_v"] == pytest.approx(v_ref[i], abs=1e-9)
        assert name_to_value[f"Bus_{idx}_a"] == pytest.approx(a_ref[i], abs=1e-9)
    # Slack bus angle is the reference (~0 rad).
    assert abs(name_to_value[f"Bus_{bus_idx[0]}_a"]) < 1e-6


@pytest.mark.integration
def test_no_syngen_case_yields_zero_gen_columns_but_well_formed_schema() -> None:
    """A case loaded without a .dyr addfile has zero SynGen members. The
    gen_state + gen_power groups contribute zero columns, but the schema
    and collected values stay well-formed (bus + line + load only)."""
    import andes

    raw, _dyr = _ieee14_paths()
    ss = andes.load(str(raw), setup=True, no_output=True)
    ss.PFlow.run()

    groups = list(S.VAR_GROUPS)
    sg_idx = S.syngen_idx_values_from_system(ss)
    assert sg_idx == []

    _schema, var_columns = S.make_combined_schema(groups, ss)
    assert not any(c.startswith("Gen_") for c in var_columns)

    values = S.collect_combined_values(
        ss,
        groups,
        syngen_idx_values=sg_idx,
        line_idx_values=S.line_idx_values_from_system(ss),
        pq_idx_values=S.pq_idx_values_from_system(ss),
    )
    assert len(values) == len(var_columns)
    assert all(math.isfinite(v) for v in values)
