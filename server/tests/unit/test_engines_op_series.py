"""Unit tests of the series block models and validation."""

from __future__ import annotations

import pytest

from tensa.engines.case_doc import CaseSeries, SeriesProfile


def test_series_profile_round_trip() -> None:
    profile = SeriesProfile(
        applies_to="load:3-1",
        resolution_s=3600.0,
        factors=[1.0, 1.1, 0.9],
    )
    dumped = profile.model_dump()
    assert dumped["applies_to"] == "load:3-1"
    assert dumped["resolution_s"] == 3600.0
    assert dumped["factors"] == [1.0, 1.1, 0.9]
    again = SeriesProfile.model_validate(dumped)
    assert again == profile


def test_case_series_round_trip() -> None:
    series = CaseSeries(
        start="2026-01-01T00:00:00",
        load=[
            SeriesProfile(applies_to="*", resolution_s=3600.0, factors=[1.0, 1.1]),
            SeriesProfile(applies_to="load:3-1", resolution_s=3600.0, factors=[0.9, 1.0, 1.2]),
        ],
    )
    dumped = series.model_dump()
    assert dumped["start"] == "2026-01-01T00:00:00"
    assert len(dumped["load"]) == 2
    again = CaseSeries.model_validate(dumped)
    assert again == series


def test_case_series_null_start() -> None:
    series = CaseSeries(load=[SeriesProfile(applies_to="*", resolution_s=3600.0, factors=[1.0])])
    assert series.start is None
    dumped = series.model_dump()
    assert dumped["start"] is None


def test_series_profile_extra_field_forbidden() -> None:
    with pytest.raises(ValueError, match="Extra inputs are not permitted"):
        SeriesProfile.model_validate({
            "applies_to": "load:3-1",
            "resolution_s": 3600.0,
            "factors": [1.0],
            "extra": "not allowed",
        })


def test_case_series_extra_field_forbidden() -> None:
    with pytest.raises(ValueError, match="Extra inputs are not permitted"):
        CaseSeries.model_validate({
            "load": [],
            "extra": "not allowed",
        })


def test_series_profile_resolution_must_be_positive() -> None:
    with pytest.raises(ValueError, match="greater than 0"):
        SeriesProfile(applies_to="*", resolution_s=0.0, factors=[1.0])
    with pytest.raises(ValueError, match="greater than 0"):
        SeriesProfile(applies_to="*", resolution_s=-1.0, factors=[1.0])


def test_series_profile_factors_must_not_be_empty() -> None:
    with pytest.raises(ValueError, match="at least 1"):
        SeriesProfile(applies_to="*", resolution_s=3600.0, factors=[])
