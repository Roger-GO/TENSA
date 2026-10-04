"""Unit tests for the columns a streaming run lists.

Mirrors ``test_stream_aggregator.py``'s structure: each test is a
self-contained, andes-free check on ``var_column_names``, which turns the
``vars``-selected groups into the ordered column names a run sends in
``stream_start.metadata.var_columns``. ANDES-driven collection
(``StreamCollector``) is exercised against ANDES by
``server/tests/integration/test_stream_collectors.py`` and end-to-end by
``server/tests/acceptance/test_tds_streaming.py``.

The streaming-variable contract each group contributes (per idx):

- ``bus_v``     → ``Bus_<idx>_v`` (pu) + ``Bus_<idx>_a`` (rad)
- ``gen_state`` → ``Gen_<idx>_delta`` (rad) + ``Gen_<idx>_omega`` (pu)
- ``gen_power`` → ``Gen_<idx>_Pe`` (MW) + ``Gen_<idx>_Qe`` (MVar)
- ``line_flow`` → ``Line_<idx>_p`` (MW) + ``Line_<idx>_q`` (MVar)
- ``load_pq``   → ``Load_<idx>_p`` (MW) + ``Load_<idx>_q`` (MVar)
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from tensa.core.stream import (
    DEFAULT_VARS,
    VAR_GROUPS,
    decode_batch,
    encode_batch,
    var_column_names,
)


def _fake_system(
    bus_idxes: list[int | str] | None = None,
    syngen_idxes: list[int | str] | None = None,
    line_idxes: list[int | str] | None = None,
    pq_idxes: list[int | str] | None = None,
) -> object:
    """Build a stand-in object that quacks like ``andes.system.System``
    enough for ``var_column_names``'s introspection.

    It reaches through ``Bus.idx.v``, ``SynGen.get_all_idxes``,
    ``Line.idx.v``, and ``PQ.idx.v`` — nothing else — so a SimpleNamespace
    tree is sufficient. This keeps the unit tests andes-import-free and
    fast."""
    bus_idxes = bus_idxes if bus_idxes is not None else []
    syngen_idxes = syngen_idxes if syngen_idxes is not None else []
    line_idxes = line_idxes if line_idxes is not None else []
    pq_idxes = pq_idxes if pq_idxes is not None else []
    return SimpleNamespace(
        Bus=SimpleNamespace(idx=SimpleNamespace(v=list(bus_idxes))),
        SynGen=SimpleNamespace(get_all_idxes=lambda: list(syngen_idxes)),
        Line=SimpleNamespace(idx=SimpleNamespace(v=list(line_idxes))),
        PQ=SimpleNamespace(idx=SimpleNamespace(v=list(pq_idxes))),
    )


# ---- one group at a time ----------------------------------------------------


@pytest.mark.unit
def test_bus_v_emits_v_then_a_per_bus() -> None:
    """The bus_v group emits ``Bus_<idx>_v`` (magnitude) then
    ``Bus_<idx>_a`` (angle, rad) per bus, in idx order — the same order
    ``StreamCollector`` reads them."""
    system = _fake_system(bus_idxes=[1, 2, 3])
    assert var_column_names(["bus_v"], system) == [
        "Bus_1_v", "Bus_1_a",
        "Bus_2_v", "Bus_2_a",
        "Bus_3_v", "Bus_3_a",
    ]


@pytest.mark.unit
def test_bus_v_with_no_buses_has_no_columns() -> None:
    assert var_column_names(["bus_v"], _fake_system(bus_idxes=[])) == []


@pytest.mark.unit
def test_gen_state_emits_delta_then_omega_per_idx() -> None:
    """For each SynGen idx the group lays out ``delta`` then ``omega``
    in idx order — the same order ``StreamCollector`` reads."""
    system = _fake_system(syngen_idxes=["GENROU_1", "GENROU_2"])
    assert var_column_names(["gen_state"], system) == [
        "Gen_GENROU_1_delta", "Gen_GENROU_1_omega",
        "Gen_GENROU_2_delta", "Gen_GENROU_2_omega",
    ]


@pytest.mark.unit
def test_gen_state_with_no_syngens_has_no_columns() -> None:
    """A case loaded without a .dyr addfile has zero SynGen members, so the
    group contributes nothing (and never crashes)."""
    assert var_column_names(["gen_state"], _fake_system(syngen_idxes=[])) == []


@pytest.mark.unit
def test_gen_power_emits_Pe_then_Qe_per_idx() -> None:
    """``vars=["gen_power"]`` selects just the electrical-power columns, ``Pe``
    then ``Qe`` per SynGen idx — the order ``StreamCollector`` reads."""
    system = _fake_system(syngen_idxes=["GENROU_1", "GENROU_2"])
    assert var_column_names(["gen_power"], system) == [
        "Gen_GENROU_1_Pe", "Gen_GENROU_1_Qe",
        "Gen_GENROU_2_Pe", "Gen_GENROU_2_Qe",
    ]


@pytest.mark.unit
def test_gen_power_with_no_syngens_has_no_columns() -> None:
    """A pure power-flow case (no .dyr) has zero SynGen members → the
    gen_power group has no columns, never crashes."""
    assert var_column_names(["gen_power"], _fake_system(syngen_idxes=[])) == []


@pytest.mark.unit
def test_line_flow_emits_p_then_q_column_per_line() -> None:
    system = _fake_system(line_idxes=["Line_1", "Line_2"])
    assert var_column_names(["line_flow"], system) == [
        "Line_Line_1_p", "Line_Line_1_q",
        "Line_Line_2_p", "Line_Line_2_q",
    ]


@pytest.mark.unit
def test_line_flow_on_a_zero_line_case_has_no_columns() -> None:
    """Edge case: ``vars=["line_flow"]`` on a case with zero lines has no
    columns of that prefix and does not crash."""
    assert var_column_names(["line_flow"], _fake_system(line_idxes=[])) == []


@pytest.mark.unit
def test_load_pq_emits_p_then_q_column_per_load() -> None:
    """``vars=["load_pq"]`` selects just the PQ-load consumption columns."""
    system = _fake_system(pq_idxes=["PQ_1", "PQ_2"])
    assert var_column_names(["load_pq"], system) == [
        "Load_PQ_1_p", "Load_PQ_1_q",
        "Load_PQ_2_p", "Load_PQ_2_q",
    ]


@pytest.mark.unit
def test_load_pq_on_a_zero_load_case_has_no_columns() -> None:
    """``vars=["load_pq"]`` on a case with zero PQ loads has no columns.
    Doesn't crash."""
    assert var_column_names(["load_pq"], _fake_system(pq_idxes=[])) == []


# ---- several groups ---------------------------------------------------------


@pytest.mark.unit
def test_default_is_bus_v_and_gen_state() -> None:
    """The default ``vars`` (``DEFAULT_VARS``) carries bus voltage +
    angle AND generator delta/omega so frequency is always plottable
    without re-running."""
    assert tuple(DEFAULT_VARS) == ("bus_v", "gen_state")
    system = _fake_system(bus_idxes=[1, 2], syngen_idxes=["GENROU_1"])
    assert var_column_names(list(DEFAULT_VARS), system) == [
        "Bus_1_v", "Bus_1_a",
        "Bus_2_v", "Bus_2_a",
        "Gen_GENROU_1_delta",
        "Gen_GENROU_1_omega",
    ]


@pytest.mark.unit
def test_columns_follow_the_canonical_group_order_not_the_request_order() -> None:
    """Even if the client lists the groups in a different order, the
    columns are laid out in canonical ``VAR_GROUPS`` order (bus_v,
    gen_state, gen_power, line_flow, load_pq). This makes the wire format
    predictable."""
    system = _fake_system(
        bus_idxes=[1],
        syngen_idxes=["GENROU_1"],
        line_idxes=["Line_1"],
    )
    assert var_column_names(["line_flow", "gen_state", "bus_v"], system) == [
        "Bus_1_v", "Bus_1_a",
        "Gen_GENROU_1_delta",
        "Gen_GENROU_1_omega",
        "Line_Line_1_p",
        "Line_Line_1_q",
    ]


@pytest.mark.unit
def test_all_five_groups() -> None:
    """All five groups in canonical order, each contributing two columns
    per element: gen_power slots in between gen_state and line_flow, and
    load_pq comes after line_flow."""
    system = _fake_system(
        bus_idxes=[1, 2],
        syngen_idxes=["GENROU_1"],
        line_idxes=["Line_1", "Line_2"],
        pq_idxes=["PQ_1"],
    )
    assert var_column_names(list(VAR_GROUPS), system) == [
        "Bus_1_v", "Bus_1_a",
        "Bus_2_v", "Bus_2_a",
        "Gen_GENROU_1_delta",
        "Gen_GENROU_1_omega",
        "Gen_GENROU_1_Pe",
        "Gen_GENROU_1_Qe",
        "Line_Line_1_p", "Line_Line_1_q",
        "Line_Line_2_p", "Line_Line_2_q",
        "Load_PQ_1_p", "Load_PQ_1_q",
    ]


@pytest.mark.unit
def test_a_repeated_group_gives_one_run_of_columns() -> None:
    """A client that accidentally lists ``bus_v`` twice gets one
    contiguous run of bus columns, not two."""
    system = _fake_system(bus_idxes=[1, 2])
    assert var_column_names(["bus_v", "bus_v"], system) == [
        "Bus_1_v", "Bus_1_a", "Bus_2_v", "Bus_2_a"
    ]


@pytest.mark.unit
def test_rejects_empty_vars() -> None:
    system = _fake_system(bus_idxes=[1])
    with pytest.raises(ValueError, match="non-empty"):
        var_column_names([], system)


@pytest.mark.unit
def test_rejects_unknown_group() -> None:
    system = _fake_system(bus_idxes=[1])
    with pytest.raises(ValueError, match="unknown var groups"):
        var_column_names(["bus_v", "no_such_group"], system)  # type: ignore[list-item]


# ---- round-trip a multi-group batch -----------------------------------------


@pytest.mark.unit
def test_a_runs_rows_round_trip_through_encode_and_decode() -> None:
    """A multi-group batch encodes and decodes without losing a value or
    moving it to another column. The row layout follows
    ``StreamCollector``'s ordering: [v, a] per bus, then [delta, omega]
    per gen, then [Pe, Qe] per gen, then [p, q] per line, then [p, q] per
    load; ``var_column_names`` names those positions."""
    system = _fake_system(
        bus_idxes=[1, 2],
        syngen_idxes=["GENROU_1"],
        line_idxes=["Line_1"],
        pq_idxes=["PQ_1"],
    )
    var_columns = var_column_names(list(VAR_GROUPS), system)
    expected_cols = [
        "Bus_1_v", "Bus_1_a",
        "Bus_2_v", "Bus_2_a",
        "Gen_GENROU_1_delta", "Gen_GENROU_1_omega",
        "Gen_GENROU_1_Pe", "Gen_GENROU_1_Qe",
        "Line_Line_1_p", "Line_Line_1_q",
        "Load_PQ_1_p", "Load_PQ_1_q",
    ]
    # var_columns matches the metadata advertised to the client (no t).
    assert var_columns == expected_cols
    # values match expected_cols order, one row per timestep.
    rows = [
        (0.0, [1.04, -0.01, 1.03, -0.05, 0.5, 1.0, 81.4, -21.6, 12.5, 3.1, 21.7, 12.7]),
        (0.01, [1.041, -0.011, 1.029, -0.051, 0.501, 1.0001, 81.5, -21.5, 12.6, 3.2, 21.7, 12.7]),
    ]
    t, values = decode_batch(encode_batch(len(var_columns), rows))

    assert t.tolist() == [0.0, 0.01]
    assert values.shape == (2, len(expected_cols))

    def column(name: str) -> list[float]:
        return values[:, var_columns.index(name)].tolist()

    assert column("Bus_1_v") == [1.04, 1.041]
    assert column("Bus_1_a") == [-0.01, -0.011]
    assert column("Gen_GENROU_1_omega") == [1.0, 1.0001]
    assert column("Gen_GENROU_1_Pe") == [81.4, 81.5]
    assert column("Line_Line_1_p") == [12.5, 12.6]
    assert column("Line_Line_1_q") == [3.1, 3.2]
    assert column("Load_PQ_1_p") == [21.7, 21.7]
