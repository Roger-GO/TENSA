"""Unit tests for the multi-group Arrow schemas.

Mirrors ``test_stream_aggregator.py``'s structure: each test is a
self-contained, andes-free check on the schema-builder helpers and their
composition into the ``vars``-selected unified schema. ANDES-driven
collection (i.e., ``collect_combined_values``) is exercised end-to-end by
``server/tests/acceptance/test_tds_streaming.py``.

The streaming-variable contract each group contributes (per idx):

- ``bus_v``     → ``Bus_<idx>_v`` (pu) + ``Bus_<idx>_a`` (rad)
- ``gen_state`` → ``Gen_<idx>_delta`` (rad) + ``Gen_<idx>_omega`` (pu)
- ``gen_power`` → ``Gen_<idx>_Pe`` (MW) + ``Gen_<idx>_Qe`` (MVar)
- ``line_flow`` → ``Line_<idx>_p`` (MW) + ``Line_<idx>_q`` (MVar)
- ``load_pq``   → ``Load_<idx>_p`` (MW) + ``Load_<idx>_q`` (MVar)
"""

from __future__ import annotations

import io
from types import SimpleNamespace

import pyarrow as pa
import pyarrow.ipc
import pytest

from andes_app.core.stream import (
    DEFAULT_VARS,
    VAR_GROUPS,
    encode_batch,
    make_bus_voltage_schema,
    make_combined_schema,
    make_generator_power_schema,
    make_generator_state_schema,
    make_line_flow_schema,
    make_load_pq_schema,
)

# ---- per-group schemas ------------------------------------------------------


@pytest.mark.unit
def test_make_bus_voltage_schema_emits_v_then_a_per_bus() -> None:
    """The bus_v group emits ``Bus_<idx>_v`` (magnitude) then
    ``Bus_<idx>_a`` (angle, rad) per bus, in idx order — the same order
    ``collect_bus_voltages`` reads them."""
    schema = make_bus_voltage_schema([1, 2, 3])
    assert schema.names == [
        "t",
        "Bus_1_v", "Bus_1_a",
        "Bus_2_v", "Bus_2_a",
        "Bus_3_v", "Bus_3_a",
    ]
    for name in schema.names:
        assert schema.field(name).type == pa.float64()


@pytest.mark.unit
def test_make_bus_voltage_schema_with_no_buses_is_well_formed() -> None:
    schema = make_bus_voltage_schema([])
    assert schema.names == ["t"]


@pytest.mark.unit
def test_make_generator_state_schema_emits_delta_then_omega_per_idx() -> None:
    """For each SynGen idx the schema lays out ``delta`` then ``omega``
    in idx order — the same order ``collect_generator_state`` reads."""
    schema = make_generator_state_schema(["GENROU_1", "GENROU_2"])
    assert schema.names == [
        "t",
        "Gen_GENROU_1_delta",
        "Gen_GENROU_1_omega",
        "Gen_GENROU_2_delta",
        "Gen_GENROU_2_omega",
    ]
    for name in schema.names:
        assert schema.field(name).type == pa.float64()


@pytest.mark.unit
def test_make_generator_state_schema_with_no_syngens_is_well_formed() -> None:
    """A case loaded without a .dyr addfile has zero SynGen members.
    The schema is still well-formed: just the ``t`` column."""
    schema = make_generator_state_schema([])
    assert schema.names == ["t"]


@pytest.mark.unit
def test_make_generator_power_schema_emits_Pe_then_Qe_per_idx() -> None:
    """For each SynGen idx the gen_power schema lays out ``Pe`` then
    ``Qe`` in idx order — the order ``collect_generator_power`` reads."""
    schema = make_generator_power_schema(["GENROU_1", "GENROU_2"])
    assert schema.names == [
        "t",
        "Gen_GENROU_1_Pe",
        "Gen_GENROU_1_Qe",
        "Gen_GENROU_2_Pe",
        "Gen_GENROU_2_Qe",
    ]
    for name in schema.names:
        assert schema.field(name).type == pa.float64()


@pytest.mark.unit
def test_make_generator_power_schema_with_no_syngens_is_well_formed() -> None:
    """A pure power-flow case (no .dyr) has zero SynGen members → the
    gen_power schema is just the ``t`` column, never crashes."""
    schema = make_generator_power_schema([])
    assert schema.names == ["t"]


@pytest.mark.unit
def test_make_line_flow_schema_emits_p_then_q_column_per_line() -> None:
    schema = make_line_flow_schema(["Line_1", "Line_2"])
    assert schema.names == [
        "t",
        "Line_Line_1_p", "Line_Line_1_q",
        "Line_Line_2_p", "Line_Line_2_q",
    ]
    for name in schema.names:
        assert schema.field(name).type == pa.float64()


@pytest.mark.unit
def test_make_line_flow_schema_with_zero_lines_is_well_formed() -> None:
    """Edge case: ``vars=["line_flow"]`` on a case with zero lines must
    produce a well-formed schema (zero columns of that prefix), not
    crash."""
    schema = make_line_flow_schema([])
    assert schema.names == ["t"]


@pytest.mark.unit
def test_make_load_pq_schema_emits_p_then_q_column_per_load() -> None:
    schema = make_load_pq_schema(["PQ_1", "PQ_2"])
    assert schema.names == [
        "t",
        "Load_PQ_1_p", "Load_PQ_1_q",
        "Load_PQ_2_p", "Load_PQ_2_q",
    ]
    for name in schema.names:
        assert schema.field(name).type == pa.float64()


@pytest.mark.unit
def test_make_load_pq_schema_with_zero_loads_is_well_formed() -> None:
    schema = make_load_pq_schema([])
    assert schema.names == ["t"]


# ---- combined schema --------------------------------------------------------


def _fake_system(
    bus_idxes: list[int | str] | None = None,
    syngen_idxes: list[int | str] | None = None,
    line_idxes: list[int | str] | None = None,
    pq_idxes: list[int | str] | None = None,
) -> object:
    """Build a stand-in object that quacks like ``andes.system.System``
    enough for the combined-schema composer's introspection.

    The composer reaches through ``Bus.idx.v``, ``SynGen.get_all_idxes``,
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


@pytest.mark.unit
def test_combined_schema_bus_v_only_matches_bus_voltage_schema() -> None:
    """``vars=["bus_v"]`` produces an Arrow schema byte-equivalent to
    ``make_bus_voltage_schema`` (v + a per bus)."""
    system = _fake_system(bus_idxes=[1, 2, 3])
    schema, var_columns = make_combined_schema(["bus_v"], system)
    expected = make_bus_voltage_schema([1, 2, 3])
    assert schema.names == expected.names
    assert var_columns == [
        "Bus_1_v", "Bus_1_a",
        "Bus_2_v", "Bus_2_a",
        "Bus_3_v", "Bus_3_a",
    ]


@pytest.mark.unit
def test_combined_schema_default_is_bus_v_and_gen_state() -> None:
    """The default ``vars`` (``DEFAULT_VARS``) carries bus voltage +
    angle AND generator delta/omega so frequency is always plottable
    without re-running."""
    assert tuple(DEFAULT_VARS) == ("bus_v", "gen_state")
    system = _fake_system(bus_idxes=[1, 2], syngen_idxes=["GENROU_1"])
    schema, var_columns = make_combined_schema(list(DEFAULT_VARS), system)
    assert schema.names == [
        "t",
        "Bus_1_v", "Bus_1_a",
        "Bus_2_v", "Bus_2_a",
        "Gen_GENROU_1_delta",
        "Gen_GENROU_1_omega",
    ]
    assert var_columns == [
        "Bus_1_v", "Bus_1_a",
        "Bus_2_v", "Bus_2_a",
        "Gen_GENROU_1_delta",
        "Gen_GENROU_1_omega",
    ]


@pytest.mark.unit
def test_combined_schema_orders_by_canonical_groups_not_request_order() -> None:
    """Even if the client lists the groups in a different order, the
    schema is laid out in canonical ``VAR_GROUPS`` order (bus_v,
    gen_state, gen_power, line_flow, load_pq). This makes the wire format
    predictable."""
    system = _fake_system(
        bus_idxes=[1],
        syngen_idxes=["GENROU_1"],
        line_idxes=["Line_1"],
    )
    schema, var_columns = make_combined_schema(
        ["line_flow", "gen_state", "bus_v"], system
    )
    assert schema.names == [
        "t",
        "Bus_1_v", "Bus_1_a",
        "Gen_GENROU_1_delta",
        "Gen_GENROU_1_omega",
        "Line_Line_1_p",
        "Line_Line_1_q",
    ]
    assert var_columns == [
        "Bus_1_v", "Bus_1_a",
        "Gen_GENROU_1_delta",
        "Gen_GENROU_1_omega",
        "Line_Line_1_p",
        "Line_Line_1_q",
    ]


@pytest.mark.unit
def test_combined_schema_all_five_groups() -> None:
    """All five groups in canonical order, each contributing two columns
    per element. Verifies the new gen_power + load_pq groups slot in
    between gen_state and line_flow / after line_flow respectively."""
    system = _fake_system(
        bus_idxes=[1, 2],
        syngen_idxes=["GENROU_1"],
        line_idxes=["Line_1", "Line_2"],
        pq_idxes=["PQ_1"],
    )
    schema, var_columns = make_combined_schema(
        list(VAR_GROUPS), system
    )
    expected_cols = [
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
    assert schema.names == ["t", *expected_cols]
    assert var_columns == expected_cols


@pytest.mark.unit
def test_combined_schema_gen_power_only() -> None:
    """``vars=["gen_power"]`` selects just the electrical-power columns."""
    system = _fake_system(syngen_idxes=["GENROU_1", "GENROU_2"])
    schema, var_columns = make_combined_schema(["gen_power"], system)
    assert schema.names == [
        "t",
        "Gen_GENROU_1_Pe", "Gen_GENROU_1_Qe",
        "Gen_GENROU_2_Pe", "Gen_GENROU_2_Qe",
    ]
    assert var_columns == [
        "Gen_GENROU_1_Pe", "Gen_GENROU_1_Qe",
        "Gen_GENROU_2_Pe", "Gen_GENROU_2_Qe",
    ]


@pytest.mark.unit
def test_combined_schema_load_pq_only() -> None:
    """``vars=["load_pq"]`` selects just the PQ-load consumption columns."""
    system = _fake_system(pq_idxes=["PQ_1", "PQ_2"])
    schema, var_columns = make_combined_schema(["load_pq"], system)
    assert schema.names == [
        "t",
        "Load_PQ_1_p", "Load_PQ_1_q",
        "Load_PQ_2_p", "Load_PQ_2_q",
    ]
    assert var_columns == [
        "Load_PQ_1_p", "Load_PQ_1_q",
        "Load_PQ_2_p", "Load_PQ_2_q",
    ]


@pytest.mark.unit
def test_combined_schema_load_pq_only_on_zero_load_case() -> None:
    """``vars=["load_pq"]`` on a case with zero PQ loads yields a schema
    with just ``t``. Doesn't crash."""
    system = _fake_system(pq_idxes=[])
    schema, var_columns = make_combined_schema(["load_pq"], system)
    assert schema.names == ["t"]
    assert var_columns == []


@pytest.mark.unit
def test_combined_schema_line_flow_only_on_zero_line_case() -> None:
    """v0.2 plan edge case: ``vars=["line_flow"]`` on a case with zero
    lines yields a schema with just ``t``. Doesn't crash."""
    system = _fake_system(line_idxes=[])
    schema, var_columns = make_combined_schema(["line_flow"], system)
    assert schema.names == ["t"]
    assert var_columns == []


@pytest.mark.unit
def test_combined_schema_rejects_empty_vars() -> None:
    system = _fake_system(bus_idxes=[1])
    with pytest.raises(ValueError, match="non-empty"):
        make_combined_schema([], system)


@pytest.mark.unit
def test_combined_schema_rejects_unknown_group() -> None:
    system = _fake_system(bus_idxes=[1])
    with pytest.raises(ValueError, match="unknown var groups"):
        make_combined_schema(["bus_v", "no_such_group"], system)  # type: ignore[list-item]


@pytest.mark.unit
def test_combined_schema_dedupe_collapses_repeats() -> None:
    """A client that accidentally lists ``bus_v`` twice gets one
    contiguous run of bus columns, not two."""
    system = _fake_system(bus_idxes=[1, 2])
    schema, var_columns = make_combined_schema(
        ["bus_v", "bus_v"], system
    )
    assert schema.names == ["t", "Bus_1_v", "Bus_1_a", "Bus_2_v", "Bus_2_a"]
    assert var_columns == ["Bus_1_v", "Bus_1_a", "Bus_2_v", "Bus_2_a"]


# ---- round-trip a multi-group batch -----------------------------------------


@pytest.mark.unit
def test_combined_schema_round_trips_through_arrow_ipc() -> None:
    """A combined-schema batch encodes + decodes through pyarrow's
    standard IPC stream reader without losing column names or values.
    The row layout follows ``collect_combined_values`` ordering: [v, a]
    per bus, then [delta, omega] per gen, then [Pe, Qe] per gen, then
    [p, q] per line, then [p, q] per load."""
    system = _fake_system(
        bus_idxes=[1, 2],
        syngen_idxes=["GENROU_1"],
        line_idxes=["Line_1"],
        pq_idxes=["PQ_1"],
    )
    schema, var_columns = make_combined_schema(
        list(VAR_GROUPS), system
    )
    expected_cols = [
        "Bus_1_v", "Bus_1_a",
        "Bus_2_v", "Bus_2_a",
        "Gen_GENROU_1_delta", "Gen_GENROU_1_omega",
        "Gen_GENROU_1_Pe", "Gen_GENROU_1_Qe",
        "Line_Line_1_p", "Line_Line_1_q",
        "Load_PQ_1_p", "Load_PQ_1_q",
    ]
    # values match expected_cols order, one row per timestep.
    rows = [
        (0.0, [1.04, -0.01, 1.03, -0.05, 0.5, 1.0, 81.4, -21.6, 12.5, 3.1, 21.7, 12.7]),
        (0.01, [1.041, -0.011, 1.029, -0.051, 0.501, 1.0001, 81.5, -21.5, 12.6, 3.2, 21.7, 12.7]),
    ]
    payload = encode_batch(schema, rows)

    reader = pyarrow.ipc.open_stream(io.BytesIO(payload))
    decoded = reader.schema
    assert decoded.names == ["t", *expected_cols]
    batch = reader.read_next_batch()
    assert batch.num_rows == 2
    assert batch.column("Bus_1_v").to_pylist() == [1.04, 1.041]
    assert batch.column("Bus_1_a").to_pylist() == [-0.01, -0.011]
    assert batch.column("Gen_GENROU_1_omega").to_pylist() == [1.0, 1.0001]
    assert batch.column("Gen_GENROU_1_Pe").to_pylist() == [81.4, 81.5]
    assert batch.column("Line_Line_1_p").to_pylist() == [12.5, 12.6]
    assert batch.column("Line_Line_1_q").to_pylist() == [3.1, 3.2]
    assert batch.column("Load_PQ_1_p").to_pylist() == [21.7, 21.7]
    # var_columns matches the metadata advertised to the client (no t).
    assert var_columns == expected_cols
