"""The neutral results document: models, builders and validation.

No Julia, no worker, no app. Every input is constructed here.
"""

from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from tensa.api.schemas.tds import TdsTraces, TdsTraceSeries
from tensa.core.eig_result import ComplexNumber, EigResult
from tensa.core.wrapper.results import (
    GeneratorOutput,
    LineFlow,
    LoadConsumption,
    PflowResult,
)
from tensa.engines.keys import KeyBook, KeyEntry
from tensa.engines.results_doc import (
    DAE_VARS_SKIPPED_REASON,
    EngineBlock,
    OptimizationRow,
    OptimizationSlackRow,
    OptimizationTable,
    OptimizationVariableTable,
    ResultsDocError,
    ResultsDocument,
    ResultsTables,
    Series,
    eig_document,
    pflow_document,
    tds_document,
    validate_results_document,
)

pytestmark = pytest.mark.unit

ENGINE = EngineBlock(name="andes", versions={"andes": "2.0.0"})


def _book(*entries: KeyEntry) -> KeyBook:
    book = KeyBook()
    for entry in entries:
        book.assign(entry)
    return book


def _pflow_result() -> PflowResult:
    return PflowResult(
        converged=True,
        iterations=4,
        mismatch=1e-8,
        bus_voltages={1: 1.03, 7: 0.99},
        bus_angles={1: 0.0, 7: -0.1},
        keys={"bus": {"1": "bus:1", "7": "bus:7"}},
    )


def test_pflow_document_happy_path() -> None:
    doc = pflow_document(_pflow_result(), engine=ENGINE, study={"routine": "pflow"})

    assert doc.tensa_results == 1
    assert doc.status == "completed"
    assert doc.study == {"routine": "pflow"}
    table = doc.tables.pflow
    assert table is not None
    assert table.converged is True
    assert len(table.buses) == 2
    assert table.buses[0].key == "bus:1"
    assert table.buses[0].v_pu == 1.03
    assert table.buses[0].angle_rad == 0.0
    assert table.buses[1].key == "bus:7"
    assert table.buses[1].angle_rad == -0.1


def test_pflow_document_not_converged_refused() -> None:
    result = _pflow_result()
    result.converged = False

    with pytest.raises(
        ResultsDocError,
        match="power flow did not converge; a non-converged run has no results document",
    ):
        pflow_document(result, engine=ENGINE, study=None)


def test_pflow_document_bus_without_key_left_out() -> None:
    result = PflowResult(
        converged=True,
        iterations=4,
        mismatch=1e-8,
        bus_voltages={1: 1.0, 99: 1.0},
        bus_angles={1: 0.0, 99: 0.0},
        keys={"bus": {"1": "bus:1"}},
    )

    doc = pflow_document(result, engine=ENGINE, study=None)

    table = doc.tables.pflow
    assert table is not None
    assert [row.key for row in table.buses] == ["bus:1"]


def test_pflow_document_voltage_without_angle_raises() -> None:
    result = _pflow_result()
    del result.bus_angles[7]

    with pytest.raises(ResultsDocError, match="bus 7 has a voltage and no angle"):
        pflow_document(result, engine=ENGINE, study=None)


def test_pflow_document_branch_generator_and_load_fields() -> None:
    result = PflowResult(
        converged=True,
        iterations=4,
        mismatch=1e-8,
        bus_voltages={},
        bus_angles={},
        line_flows={
            "7-8-1": LineFlow(
                p=100.0,
                q=10.0,
                from_idx=7,
                to_idx=8,
                p_to=-99.0,
                q_to=-8.0,
                loss=1.0,
                rate_a=200.0,
                loading_pct=50.5,
            )
        },
        generator_outputs={
            "1": GeneratorOutput(p=700.0, q=185.0, v=1.03, bus=1, q_min=-100.0, q_max=200.0)
        },
        load_consumption={"7": LoadConsumption(p=967.0, q=100.0, bus=7)},
        keys={
            "line": {"7-8-1": "branch:7-8-1"},
            "generator": {"1": "gen:1-1"},
            "load": {"7": "load:7-1"},
        },
    )

    doc = pflow_document(result, engine=ENGINE, study=None)

    table = doc.tables.pflow
    assert table is not None
    (branch,) = table.branches
    assert branch.key == "branch:7-8-1"
    assert branch.p_from_mw == 100.0
    assert branch.q_from_mvar == 10.0
    assert branch.p_to_mw == -99.0
    assert branch.q_to_mvar == -8.0
    # loss and loading_pct are not fields of the document's branch row.
    assert not hasattr(branch, "loss_mw")
    (gen,) = table.generators
    assert gen.key == "gen:1-1"
    assert gen.p_mw == 700.0
    assert gen.q_mvar == 185.0
    (load,) = table.loads
    assert load.key == "load:7-1"
    assert load.p_mw == 967.0
    assert load.q_mvar == 100.0


def test_pflow_document_extra_key_kinds_ignored() -> None:
    result = _pflow_result()
    result.keys["shunt"] = {"7": "shunt:7-1"}

    doc = pflow_document(result, engine=ENGINE, study=None)

    assert doc.tables.pflow is not None
    assert len(doc.tables.pflow.buses) == 2


def test_tds_document_andes_columns_mapped() -> None:
    traces = TdsTraces(
        t=[0.0, 0.1],
        variables=[
            TdsTraceSeries(name="Bus_7_v", values=[1.0, 0.9]),
            TdsTraceSeries(name="Gen_1_omega", values=[1.0, 1.001]),
        ],
        truncated=False,
    )
    book = _book(
        KeyEntry(key="bus:7", bucket="bus", model="Bus", idx="7", source="file"),
        KeyEntry(key="gen:1-1/machine", bucket="dynamic", model="GENROU", idx="1", source="file"),
    )

    doc, skipped, notes = tds_document(traces, engine=ENGINE, study=None, key_book=book)

    assert skipped == []
    assert notes == []
    assert len(doc.series) == 2
    first = doc.series[0]
    assert first.quantity == "voltage"
    assert first.of == "bus:7"
    assert first.unit == "pu"
    assert first.t == [0.0, 0.1]
    assert first.y == [1.0, 0.9]
    second = doc.series[1]
    assert second.quantity == "rotor_speed"
    assert second.of == "gen:1-1"
    assert second.unit == "pu"


def test_tds_document_sienna_names_split() -> None:
    traces = TdsTraces(
        t=[0.0],
        variables=[TdsTraceSeries(name="rotor_speed|gen:1-1", values=[1.0])],
        truncated=False,
    )
    engine = EngineBlock(name="sienna", versions={"PowerSystems": "5.12.5"})

    doc, skipped, _notes = tds_document(traces, engine=engine, study=None)

    assert skipped == []
    (series,) = doc.series
    assert series.quantity == "rotor_speed"
    assert series.of == "gen:1-1"
    assert series.unit == "pu"


def test_tds_document_sienna_unknown_quantity_is_skipped_not_kept() -> None:
    traces = TdsTraces(
        t=[0.0],
        variables=[
            TdsTraceSeries(name="slip|gen:1-1", values=[0.01]),
            TdsTraceSeries(name="voltage|bus:7", values=[1.0]),
        ],
        truncated=False,
    )

    doc, skipped, _notes = tds_document(traces, engine=EngineBlock(name="sienna"), study=None)

    assert [(s.quantity, s.of) for s in doc.series] == [("voltage", "bus:7")]
    assert [(s.name, s.reason) for s in skipped] == [
        ("slip|gen:1-1", "no neutral mapping for the name")
    ]


def test_tds_document_carries_the_status_it_is_given() -> None:
    traces = TdsTraces(
        t=[0.0], variables=[TdsTraceSeries(name="voltage|bus:7", values=[1.0])], truncated=False
    )

    for status in ("completed", "aborted", "failed"):
        doc, _skipped, _notes = tds_document(
            traces, engine=EngineBlock(name="sienna"), study=None, status=status
        )
        assert doc.status == status


def test_tds_document_sienna_name_without_pipe_raises() -> None:
    traces = TdsTraces(
        t=[0.0],
        variables=[TdsTraceSeries(name="rotor_speed", values=[1.0])],
        truncated=False,
    )

    with pytest.raises(
        ResultsDocError, match=r"series name 'rotor_speed' is not neutral \(<quantity>\|<key>\)"
    ):
        tds_document(traces, engine=EngineBlock(name="sienna"), study=None)


def test_tds_document_andes_unknown_column_is_skipped() -> None:
    traces = TdsTraces(
        t=[0.0],
        variables=[TdsTraceSeries(name="Line_5_P", values=[1.0])],
        truncated=False,
    )

    doc, skipped, _notes = tds_document(traces, engine=ENGINE, study=None, key_book=KeyBook())

    assert doc.series == []
    assert len(skipped) == 1
    assert skipped[0].name == "Line_5_P"
    assert "no neutral mapping" in skipped[0].reason


def test_tds_document_andes_neutral_names_taken_as_they_are() -> None:
    # A column that is already a neutral name (it parses with parse_name) is
    # taken as it is for an ANDES result too: a run made with names "neutral"
    # converts to the same document as an engine-named one.
    traces = TdsTraces(
        t=[0.0, 0.1],
        variables=[
            TdsTraceSeries(name="voltage|bus:7", values=[1.0, 0.9]),
            TdsTraceSeries(name="rotor_speed|gen:1-1", values=[1.0, 1.001]),
            TdsTraceSeries(name="state|gen:1-1/machine#omega", values=[1.0, 1.002]),
        ],
        truncated=False,
    )

    doc, skipped, notes = tds_document(traces, engine=ENGINE, study=None, key_book=KeyBook())

    assert skipped == []
    assert notes == []
    assert [(s.quantity, s.of, s.unit) for s in doc.series] == [
        ("voltage", "bus:7", "pu"),
        ("rotor_speed", "gen:1-1", "pu"),
        ("state", "gen:1-1/machine#omega", "engine's own"),
    ]
    assert doc.series[2].y == [1.0, 1.002]


def test_tds_document_andes_neutral_name_unknown_quantity_is_skipped() -> None:
    traces = TdsTraces(
        t=[0.0],
        variables=[TdsTraceSeries(name="slip|gen:1-1", values=[0.01])],
        truncated=False,
    )

    doc, skipped, _notes = tds_document(traces, engine=ENGINE, study=None, key_book=KeyBook())

    assert doc.series == []
    assert [(s.name, s.reason) for s in skipped] == [
        ("slip|gen:1-1", "no neutral mapping for the ANDES column")
    ]


def test_tds_document_dae_vars_are_skipped_with_the_reason() -> None:
    traces = TdsTraces(
        t=[0.0, 0.1],
        variables=[TdsTraceSeries(name="omega GENROU 1", values=[1.0, 1.001])],
        truncated=False,
    )
    book = _book(
        KeyEntry(key="gen:1-1/machine", bucket="dynamic", model="GENROU", idx="1", source="file")
    )

    doc, skipped, _notes = tds_document(traces, engine=ENGINE, study=None, key_book=book)

    assert doc.series == []
    assert len(skipped) == 1
    assert skipped[0].name == "omega GENROU 1"
    assert skipped[0].reason == DAE_VARS_SKIPPED_REASON
    assert skipped[0].reason == "raw engine state; not part of the neutral document yet"


def test_tds_document_andes_requires_key_book() -> None:
    traces = TdsTraces(
        t=[0.0],
        variables=[TdsTraceSeries(name="Bus_7_v", values=[1.0])],
        truncated=False,
    )

    with pytest.raises(ResultsDocError, match="a key book is required to map ANDES column names"):
        tds_document(traces, engine=ENGINE, study=None, key_book=None)


def test_tds_document_idx_without_key_left_out() -> None:
    traces = TdsTraces(
        t=[0.0],
        variables=[TdsTraceSeries(name="Bus_99_v", values=[1.0])],
        truncated=False,
    )

    doc, skipped, _notes = tds_document(traces, engine=ENGINE, study=None, key_book=KeyBook())

    assert doc.series == []
    assert len(skipped) == 1
    assert skipped[0].name == "Bus_99_v"


def test_tds_document_null_values_kept() -> None:
    traces = TdsTraces(
        t=[0.0, 0.1],
        variables=[TdsTraceSeries(name="Bus_7_v", values=[1.0, None])],
        truncated=False,
    )
    book = _book(KeyEntry(key="bus:7", bucket="bus", model="Bus", idx="7", source="file"))

    doc, _skipped, _notes = tds_document(traces, engine=ENGINE, study=None, key_book=book)

    assert doc.series[0].y == [1.0, None]


def test_tds_document_truncated_is_a_note_and_completed() -> None:
    traces = TdsTraces(
        t=[0.0],
        variables=[TdsTraceSeries(name="Bus_7_v", values=[1.0])],
        truncated=True,
    )
    book = _book(KeyEntry(key="bus:7", bucket="bus", model="Bus", idx="7", source="file"))

    doc, _skipped, notes = tds_document(traces, engine=ENGINE, study=None, key_book=book)

    assert doc.status == "completed"
    assert len(doc.series) == 1
    assert len(notes) == 1
    assert "truncated" in notes[0]


def test_eig_document_happy_path() -> None:
    result = EigResult(
        eigenvalues=[ComplexNumber(-0.5, 6.0), ComplexNumber(0.0, 0.0)],
        damping_ratios=[0.083, 1.0],
        frequencies_hz=[0.955, 0.0],
        mode_count=2,
        state_count=2,
        state_names=["omega GENROU 1", "delta GENROU 1"],
        tds_initialized=True,
    )

    doc = eig_document(result, engine=ENGINE, study=None)

    table = doc.tables.eig
    assert table is not None
    assert len(table.eigenvalues) == 2
    first = table.eigenvalues[0]
    assert first.re == -0.5
    assert first.im == 6.0
    assert first.frequency_hz == 0.955
    assert first.damping_ratio == 0.083
    second = table.eigenvalues[1]
    assert second.re == 0.0
    assert second.im == 0.0
    assert second.damping_ratio == 1.0


def test_eig_document_length_mismatch_raises() -> None:
    result = EigResult(
        eigenvalues=[ComplexNumber(-0.5, 6.0), ComplexNumber(0.0, 0.0)],
        damping_ratios=[0.083, 1.0],
        frequencies_hz=[0.955, 0.0],
        mode_count=3,
        state_count=3,
        state_names=[],
        tds_initialized=True,
    )

    with pytest.raises(ResultsDocError, match="eig result lengths disagree"):
        eig_document(result, engine=ENGINE, study=None)


def test_validate_document_ok() -> None:
    doc = pflow_document(_pflow_result(), engine=ENGINE, study=None)

    assert validate_results_document(doc) == []


def _doc_with_series(series: Series) -> ResultsDocument:
    return ResultsDocument(
        tensa_results=1,
        engine=ENGINE,
        study=None,
        status="completed",
        series=[series],
    )


def test_validate_unknown_quantity() -> None:
    doc = _doc_with_series(Series(quantity="slipt", of="bus:1", unit="pu", t=[0.0], y=[1.0]))

    assert validate_results_document(doc) == ["series 0: unknown quantity 'slipt'"]


def test_validate_not_a_key() -> None:
    doc = _doc_with_series(Series(quantity="voltage", of="Bus 7", unit="pu", t=[0.0], y=[1.0]))

    assert validate_results_document(doc) == ["series 0: 'Bus 7' is not a key"]


def test_validate_length_mismatch() -> None:
    doc = _doc_with_series(
        Series(quantity="voltage", of="bus:1", unit="pu", t=[0.0, 0.1], y=[1.0])
    )

    assert validate_results_document(doc) == ["series 0: t has 2 values, y has 1"]


def test_validate_non_monotonic_t() -> None:
    doc = _doc_with_series(
        Series(quantity="voltage", of="bus:1", unit="pu", t=[0.0, 0.2, 0.1], y=[1.0, 1.0, 1.0])
    )

    assert validate_results_document(doc) == ["series 0: t is not non-decreasing at index 2"]


def test_validate_repeated_time_is_no_problem() -> None:
    doc = _doc_with_series(
        Series(quantity="voltage", of="bus:1", unit="pu", t=[0.0, 0.0], y=[1.0, 1.0])
    )

    assert validate_results_document(doc) == []


def test_validate_wrong_prefix() -> None:
    doc = _doc_with_series(
        Series(quantity="voltage", of="gen:1-1", unit="pu", t=[0.0], y=[1.0])
    )

    assert validate_results_document(doc) == ["series 0: quantity 'voltage' is not of 'gen'"]


def test_validate_a_unit_quantity_of_a_load_is_refused() -> None:
    doc = _doc_with_series(
        Series(quantity="rotor_speed", of="load:7-1", unit="pu", t=[0.0], y=[1.0])
    )

    assert validate_results_document(doc) == [
        "series 0: quantity 'rotor_speed' is not of 'load'"
    ]


def test_validate_p_of_a_load_key_is_accepted() -> None:
    doc = _doc_with_series(Series(quantity="p", of="load:7-1", unit="MW", t=[0.0], y=[1.0]))

    assert validate_results_document(doc) == []


def test_validate_wrong_unit() -> None:
    doc = _doc_with_series(Series(quantity="voltage", of="bus:1", unit="kV", t=[0.0], y=[1.0]))

    assert validate_results_document(doc) == [
        "series 0: quantity 'voltage' is in 'pu', not 'kV'"
    ]


def test_validate_eigenvalue_as_series() -> None:
    doc = _doc_with_series(
        Series(quantity="eigenvalue", of="case:1", unit="1/s", t=[0.0], y=[1.0])
    )

    assert validate_results_document(doc) == [
        "series 0: eigenvalue is a table quantity, not a series"
    ]


def test_validate_state_series_of_shape() -> None:
    good = _doc_with_series(
        Series(quantity="state", of="gen:1-1/machine#omega", unit="pu", t=[0.0], y=[1.0])
    )
    bad = _doc_with_series(Series(quantity="state", of="gen:1-1", unit="pu", t=[0.0], y=[1.0]))

    assert validate_results_document(good) == []
    assert validate_results_document(bad) == ["series 0: 'gen:1-1' is not <key>#<state name>"]


def test_an_unknown_table_is_refused_by_the_model() -> None:
    data = json.loads(pflow_document(_pflow_result(), engine=ENGINE, study=None).model_dump_json())
    data["tables"]["cpf"] = data["tables"]["pflow"]

    with pytest.raises(ValidationError):
        ResultsDocument.model_validate(data)


def test_an_eigenvalue_table_under_pflow_is_refused_by_the_model() -> None:
    data = json.loads(pflow_document(_pflow_result(), engine=ENGINE, study=None).model_dump_json())
    data["tables"]["pflow"] = {"eigenvalues": []}

    with pytest.raises(ValidationError):
        ResultsDocument.model_validate(data)


def test_validate_pflow_row_key_that_is_not_a_key() -> None:
    doc = pflow_document(_pflow_result(), engine=ENGINE, study=None)
    assert doc.tables.pflow is not None
    doc.tables.pflow.buses[0].key = "Bus 7"

    assert validate_results_document(doc) == ["tables.pflow: 'Bus 7' is not a key"]


def test_validate_a_row_keyed_as_another_kind() -> None:
    doc = pflow_document(_pflow_result(), engine=ENGINE, study=None)
    assert doc.tables.pflow is not None
    doc.tables.pflow.buses[0].key = "load:7-1"

    assert validate_results_document(doc) == ["tables.pflow: 'load:7-1' is not a bus key"]


# Optimization table tests


def test_optimization_table_round_trip() -> None:
    opt = OptimizationTable(
        routine="dispatch",
        template={"name": "economic_dispatch", "network_model": "copper_plate", "horizon_h": 1, "resolution_h": 1},
        status="OPTIMAL",
        objective_usd=1500.0,
        variables=[
            OptimizationVariableTable(
                name="ActivePowerVariable__ThermalStandard",
                unit="MW",
                rows=[OptimizationRow(element="gen:1-1", t=[0.0], y=[150.0])],
            )
        ],
        slacks=[],
    )
    tables = ResultsTables(optimization=opt)
    doc = ResultsDocument(
        tensa_results=1,
        engine=ENGINE,
        study=None,
        status="completed",
        series=[],
        tables=tables,
    )
    dumped = doc.model_dump()
    assert dumped["tables"]["optimization"]["routine"] == "dispatch"
    assert dumped["tables"]["optimization"]["status"] == "OPTIMAL"
    assert dumped["tables"]["optimization"]["objective_usd"] == 1500.0
    again = ResultsDocument.model_validate(dumped)
    assert again == doc


def test_tables_extra_name_forbidden() -> None:
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        ResultsTables.model_validate({"pflow": None, "unknown_table": {}})


def test_validate_row_length_mismatch() -> None:
    opt = OptimizationTable(
        routine="dispatch",
        template={},
        status="OPTIMAL",
        variables=[
            OptimizationVariableTable(
                name="ActivePowerVariable__ThermalStandard",
                unit="MW",
                rows=[OptimizationRow(element="gen:1-1", t=[0.0, 1.0], y=[150.0])],
            )
        ],
    )
    doc = ResultsDocument(
        tensa_results=1,
        engine=ENGINE,
        study=None,
        status="completed",
        series=[],
        tables=ResultsTables(optimization=opt),
    )
    problems = validate_results_document(doc)
    assert len(problems) == 1
    assert "tables.optimization.variables 'gen:1-1': t has 2 values, y has 1" in problems[0]


def test_validate_time_backwards() -> None:
    opt = OptimizationTable(
        routine="dispatch",
        template={},
        status="OPTIMAL",
        variables=[
            OptimizationVariableTable(
                name="ActivePowerVariable__ThermalStandard",
                unit="MW",
                rows=[OptimizationRow(element="gen:1-1", t=[1.0, 0.0], y=[150.0, 160.0])],
            )
        ],
    )
    doc = ResultsDocument(
        tensa_results=1,
        engine=ENGINE,
        study=None,
        status="completed",
        series=[],
        tables=ResultsTables(optimization=opt),
    )
    problems = validate_results_document(doc)
    assert len(problems) == 1
    assert "t is not non-decreasing" in problems[0]


def test_validate_key_kind() -> None:
    opt = OptimizationTable(
        routine="dispatch",
        template={},
        status="OPTIMAL",
        variables=[
            OptimizationVariableTable(
                name="ActivePowerVariable__ThermalStandard",
                unit="MW",
                rows=[OptimizationRow(element="load:3-1", t=[0.0], y=[150.0])],
            )
        ],
    )
    doc = ResultsDocument(
        tensa_results=1,
        engine=ENGINE,
        study=None,
        status="completed",
        series=[],
        tables=ResultsTables(optimization=opt),
    )
    problems = validate_results_document(doc)
    assert len(problems) == 1
    assert "is not a gen key" in problems[0]


def test_validate_slack_threshold() -> None:
    opt = OptimizationTable(
        routine="dispatch",
        template={},
        status="OPTIMAL",
        slacks=[
            OptimizationSlackRow(
                variable="SystemBalanceSlackUp",
                element="system",
                t=[0.0],
                y=[1e-7],
            )
        ],
    )
    doc = ResultsDocument(
        tensa_results=1,
        engine=ENGINE,
        study=None,
        status="completed",
        series=[],
        tables=ResultsTables(optimization=opt),
    )
    problems = validate_results_document(doc)
    assert len(problems) == 1
    assert "a listed slack value is not past 1e-6" in problems[0]


def test_validate_non_key_elements_pass() -> None:
    opt = OptimizationTable(
        routine="dispatch",
        template={},
        status="OPTIMAL",
        variables=[
            OptimizationVariableTable(
                name="SystemBalance",
                unit="MW",
                rows=[OptimizationRow(element="system-balance", t=[0.0], y=[150.0])],
            )
        ],
    )
    doc = ResultsDocument(
        tensa_results=1,
        engine=ENGINE,
        study=None,
        status="completed",
        series=[],
        tables=ResultsTables(optimization=opt),
    )
    problems = validate_results_document(doc)
    assert problems == []


def test_existing_documents_unchanged() -> None:
    # pflow_document and eig_document still produce tables.optimization is None
    pflow_doc = pflow_document(_pflow_result(), engine=ENGINE, study=None)
    assert pflow_doc.tables.optimization is None

    eig_result = EigResult(
        eigenvalues=[ComplexNumber(-0.5, 6.0)],
        damping_ratios=[0.083],
        frequencies_hz=[0.955],
        mode_count=1,
        state_count=1,
        state_names=["omega GENROU 1"],
        tds_initialized=True,
    )
    eig_doc = eig_document(eig_result, engine=ENGINE, study=None)
    assert eig_doc.tables.optimization is None
