"""Unit tests of the op block and series block models and validation."""

from __future__ import annotations

import pytest

from tensa.engines.case_doc import (
    BusRecord,
    CaseDocument,
    CaseDocumentError,
    CaseSeries,
    CostCurveRecord,
    GeneratorOp,
    GeneratorRecord,
    LoadRecord,
    SeriesProfile,
    validate_case_document,
)


def test_op_block_round_trip() -> None:
    op = GeneratorOp(
        p_min_mw=10.0,
        p_max_mw=200.0,
        ramp_up_mw_per_min=2.5,
        cost=CostCurveRecord(
            kind="polynomial",
            coefficients=[0.1, 10.0, 0.0],
            startup_usd=0.0,
            shutdown_usd=0.0,
        ),
        initial_p_mw=0.0,
        initial_status="on",
    )
    gen = GeneratorRecord(key="gen:1-1", bus=1, id="1", op=op)
    dumped = gen.model_dump()
    assert dumped["op"]["p_min_mw"] == 10.0
    assert dumped["op"]["p_max_mw"] == 200.0
    assert dumped["op"]["ramp_up_mw_per_min"] == 2.5
    assert dumped["op"]["cost"]["kind"] == "polynomial"
    assert dumped["op"]["cost"]["coefficients"] == [0.1, 10.0, 0.0]
    again = GeneratorRecord.model_validate(dumped)
    assert again == gen


def test_op_block_absent_by_default() -> None:
    gen = GeneratorRecord(key="gen:1-1", bus=1, id="1")
    assert gen.op is None
    dumped = gen.model_dump()
    assert dumped["op"] is None


def test_min_above_max_refused() -> None:
    doc = CaseDocument(
        name="test",
        buses=[BusRecord(key="bus:1", number=1, type="ref")],
        generators=[
            GeneratorRecord(
                key="gen:1-1",
                bus=1,
                id="1",
                op=GeneratorOp(p_min_mw=250.0, p_max_mw=200.0),
            )
        ],
    )
    with pytest.raises(
        CaseDocumentError,
        match="generator 'gen:1-1' has p_min_mw 250.0 above p_max_mw 200.0",
    ):
        validate_case_document(doc.model_dump())


def test_polynomial_cost_without_coefficients_refused() -> None:
    doc = CaseDocument(
        name="test",
        buses=[BusRecord(key="bus:1", number=1, type="ref")],
        generators=[
            GeneratorRecord(
                key="gen:1-1",
                bus=1,
                id="1",
                op=GeneratorOp(cost=CostCurveRecord(kind="polynomial", coefficients=None)),
            )
        ],
    )
    with pytest.raises(CaseDocumentError, match="has a polynomial cost without coefficients"):
        validate_case_document(doc.model_dump())


def test_piecewise_cost_points_checked() -> None:
    # Not increasing in MW
    doc = CaseDocument(
        name="test",
        buses=[BusRecord(key="bus:1", number=1, type="ref")],
        generators=[
            GeneratorRecord(
                key="gen:1-1",
                bus=1,
                id="1",
                op=GeneratorOp(
                    cost=CostCurveRecord(
                        kind="piecewise",
                        points=[[100.0, 1500.0], [50.0, 600.0]],
                    )
                ),
            )
        ],
    )
    with pytest.raises(CaseDocumentError, match="malformed points"):
        validate_case_document(doc.model_dump())

    # Only one point
    doc2 = CaseDocument(
        name="test",
        buses=[BusRecord(key="bus:1", number=1, type="ref")],
        generators=[
            GeneratorRecord(
                key="gen:1-1",
                bus=1,
                id="1",
                op=GeneratorOp(
                    cost=CostCurveRecord(kind="piecewise", points=[[100.0, 1500.0]])
                ),
            )
        ],
    )
    with pytest.raises(CaseDocumentError, match="malformed points"):
        validate_case_document(doc2.model_dump())


def test_series_star_and_per_key() -> None:
    doc = CaseDocument(
        name="test",
        buses=[BusRecord(key="bus:3", number=3, type="pq"), BusRecord(key="bus:4", number=4, type="pq")],
        loads=[
            LoadRecord(key="load:3-1", bus=3, id="1"),
            LoadRecord(key="load:4-1", bus=4, id="1"),
        ],
        series=CaseSeries(
            load=[
                SeriesProfile(applies_to="*", resolution_s=3600.0, factors=[1.0, 1.1]),
                SeriesProfile(applies_to="load:3-1", resolution_s=3600.0, factors=[0.9, 1.0, 1.2]),
            ]
        ),
    )
    validated = validate_case_document(doc.model_dump())
    assert validated.series is not None


def test_series_unknown_load_refused() -> None:
    doc = CaseDocument(
        name="test",
        buses=[BusRecord(key="bus:3", number=3, type="pq")],
        loads=[LoadRecord(key="load:3-1", bus=3, id="1")],
        series=CaseSeries(
            load=[SeriesProfile(applies_to="load:9-9", resolution_s=3600.0, factors=[1.0])]
        ),
    )
    with pytest.raises(
        CaseDocumentError,
        match="series profile references 'load:9-9', which no load of the document has",
    ):
        validate_case_document(doc.model_dump())


def test_series_two_stars_refused() -> None:
    doc = CaseDocument(
        name="test",
        buses=[BusRecord(key="bus:3", number=3, type="pq")],
        loads=[LoadRecord(key="load:3-1", bus=3, id="1")],
        series=CaseSeries(
            load=[
                SeriesProfile(applies_to="*", resolution_s=3600.0, factors=[1.0]),
                SeriesProfile(applies_to="*", resolution_s=3600.0, factors=[1.1]),
            ]
        ),
    )
    with pytest.raises(CaseDocumentError, match='series has more than one load profile for "\\*"'):
        validate_case_document(doc.model_dump())


def test_series_negative_factor_refused() -> None:
    doc = CaseDocument(
        name="test",
        buses=[BusRecord(key="bus:3", number=3, type="pq")],
        loads=[LoadRecord(key="load:3-1", bus=3, id="1")],
        series=CaseSeries(
            load=[SeriesProfile(applies_to="load:3-1", resolution_s=3600.0, factors=[1.0, -0.5])]
        ),
    )
    with pytest.raises(CaseDocumentError, match="has a negative factor"):
        validate_case_document(doc.model_dump())


def test_series_duplicate_load_refused() -> None:
    doc = CaseDocument(
        name="test",
        buses=[BusRecord(key="bus:3", number=3, type="pq")],
        loads=[LoadRecord(key="load:3-1", bus=3, id="1")],
        series=CaseSeries(
            load=[
                SeriesProfile(applies_to="load:3-1", resolution_s=3600.0, factors=[1.0]),
                SeriesProfile(applies_to="load:3-1", resolution_s=3600.0, factors=[1.1]),
            ]
        ),
    )
    with pytest.raises(CaseDocumentError, match="two load profiles for 'load:3-1'"):
        validate_case_document(doc.model_dump())


def test_extra_field_forbidden() -> None:
    with pytest.raises(ValueError, match="Extra inputs are not permitted"):
        GeneratorOp.model_validate({"p_min_mw": 10.0, "reserve_mw": 5.0})
