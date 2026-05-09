"""Unit tests for the v0.2 multi-group Arrow schemas.

Mirrors ``test_stream_aggregator.py``'s structure: each test is a
self-contained, andes-free check on the schema-builder helpers and their
composition into the ``vars``-selected unified schema. ANDES-driven
collection (i.e., ``collect_combined_values``) is exercised end-to-end by
``server/tests/acceptance/test_tds_streaming.py``."""

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
    make_generator_state_schema,
    make_line_flow_schema,
)

# ---- per-group schemas ------------------------------------------------------


@pytest.mark.unit
def test_make_bus_voltage_schema_unchanged_from_v01() -> None:
    """v0.1 wire format: ``t`` then ``Bus_<idx>_v`` columns. v0.2 must
    not alter the bus_v column-name or dtype contract — backward compat
    is the hinge of the whole streaming protocol."""
    schema = make_bus_voltage_schema([1, 2, 3])
    assert schema.names == ["t", "Bus_1_v", "Bus_2_v", "Bus_3_v"]
    for name in schema.names:
        assert schema.field(name).type == pa.float64()


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
def test_make_line_flow_schema_emits_one_p_column_per_line() -> None:
    schema = make_line_flow_schema(["Line_1", "Line_2"])
    assert schema.names == ["t", "Line_Line_1_p", "Line_Line_2_p"]
    for name in schema.names:
        assert schema.field(name).type == pa.float64()


@pytest.mark.unit
def test_make_line_flow_schema_with_zero_lines_is_well_formed() -> None:
    """Edge case from the v0.2 plan: ``vars=["line_flow"]`` on a case
    with zero lines must produce a well-formed schema (zero columns of
    that prefix), not crash."""
    schema = make_line_flow_schema([])
    assert schema.names == ["t"]


# ---- combined schema --------------------------------------------------------


def _fake_system(
    bus_idxes: list[int | str] | None = None,
    syngen_idxes: list[int | str] | None = None,
    line_idxes: list[int | str] | None = None,
) -> object:
    """Build a stand-in object that quacks like ``andes.system.System``
    enough for the combined-schema composer's introspection.

    The composer reaches through ``Bus.idx.v``, ``SynGen.get_all_idxes``,
    and ``Line.idx.v`` — nothing else — so a SimpleNamespace tree is
    sufficient. This keeps the unit tests andes-import-free and fast."""
    bus_idxes = bus_idxes if bus_idxes is not None else []
    syngen_idxes = syngen_idxes if syngen_idxes is not None else []
    line_idxes = line_idxes if line_idxes is not None else []
    return SimpleNamespace(
        Bus=SimpleNamespace(idx=SimpleNamespace(v=list(bus_idxes))),
        SynGen=SimpleNamespace(get_all_idxes=lambda: list(syngen_idxes)),
        Line=SimpleNamespace(idx=SimpleNamespace(v=list(line_idxes))),
    )


@pytest.mark.unit
def test_combined_schema_default_matches_v01_bus_voltage_layout() -> None:
    """``vars=["bus_v"]`` (the default) produces an Arrow schema
    byte-equivalent to ``make_bus_voltage_schema``. This is the
    backward-compat anchor: clients that omit ``vars`` see the v0.1
    wire format unchanged."""
    system = _fake_system(bus_idxes=[1, 2, 3])
    schema, var_columns = make_combined_schema(list(DEFAULT_VARS), system)
    expected = make_bus_voltage_schema([1, 2, 3])
    assert schema.names == expected.names
    assert var_columns == ["Bus_1_v", "Bus_2_v", "Bus_3_v"]


@pytest.mark.unit
def test_combined_schema_bus_v_then_gen_state_orders_by_canonical_groups() -> None:
    """Even if the client lists the groups in a different order, the
    schema is laid out in canonical ``VAR_GROUPS`` order: bus_v,
    gen_state, line_flow. This makes the wire format predictable."""
    system = _fake_system(
        bus_idxes=[1, 2],
        syngen_idxes=["GENROU_1"],
        line_idxes=["Line_1"],
    )
    schema, var_columns = make_combined_schema(
        ["gen_state", "bus_v"], system
    )
    assert schema.names == [
        "t",
        "Bus_1_v",
        "Bus_2_v",
        "Gen_GENROU_1_delta",
        "Gen_GENROU_1_omega",
    ]
    assert var_columns == [
        "Bus_1_v",
        "Bus_2_v",
        "Gen_GENROU_1_delta",
        "Gen_GENROU_1_omega",
    ]


@pytest.mark.unit
def test_combined_schema_all_three_groups() -> None:
    system = _fake_system(
        bus_idxes=[1, 2],
        syngen_idxes=["GENROU_1"],
        line_idxes=["Line_1", "Line_2"],
    )
    schema, var_columns = make_combined_schema(
        list(VAR_GROUPS), system
    )
    assert schema.names == [
        "t",
        "Bus_1_v",
        "Bus_2_v",
        "Gen_GENROU_1_delta",
        "Gen_GENROU_1_omega",
        "Line_Line_1_p",
        "Line_Line_2_p",
    ]
    assert var_columns == [
        "Bus_1_v",
        "Bus_2_v",
        "Gen_GENROU_1_delta",
        "Gen_GENROU_1_omega",
        "Line_Line_1_p",
        "Line_Line_2_p",
    ]


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
    assert schema.names == ["t", "Bus_1_v", "Bus_2_v"]
    assert var_columns == ["Bus_1_v", "Bus_2_v"]


# ---- round-trip a multi-group batch -----------------------------------------


@pytest.mark.unit
def test_combined_schema_round_trips_through_arrow_ipc() -> None:
    """A combined-schema batch encodes + decodes through pyarrow's
    standard IPC stream reader without losing column names or values.
    The row layout follows ``collect_combined_values`` ordering: bus
    voltages, then [delta, omega] per gen, then line P."""
    system = _fake_system(
        bus_idxes=[1, 2],
        syngen_idxes=["GENROU_1"],
        line_idxes=["Line_1"],
    )
    schema, var_columns = make_combined_schema(
        list(VAR_GROUPS), system
    )
    # values: Bus_1_v, Bus_2_v, Gen_GENROU_1_delta, Gen_GENROU_1_omega, Line_Line_1_p
    rows = [
        (0.0, [1.04, 1.03, 0.5, 1.0, 12.5]),
        (0.01, [1.041, 1.029, 0.501, 1.0001, 12.6]),
    ]
    payload = encode_batch(schema, rows)

    reader = pyarrow.ipc.open_stream(io.BytesIO(payload))
    decoded = reader.schema
    assert decoded.names == [
        "t",
        "Bus_1_v",
        "Bus_2_v",
        "Gen_GENROU_1_delta",
        "Gen_GENROU_1_omega",
        "Line_Line_1_p",
    ]
    batch = reader.read_next_batch()
    assert batch.num_rows == 2
    assert batch.column("Bus_1_v").to_pylist() == [1.04, 1.041]
    assert batch.column("Gen_GENROU_1_omega").to_pylist() == [1.0, 1.0001]
    assert batch.column("Line_Line_1_p").to_pylist() == [12.5, 12.6]
    # var_columns matches the metadata advertised to the client (no t).
    assert var_columns == [
        "Bus_1_v",
        "Bus_2_v",
        "Gen_GENROU_1_delta",
        "Gen_GENROU_1_omega",
        "Line_Line_1_p",
    ]
