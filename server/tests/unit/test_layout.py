"""The diagram layout's schema, its versions, and the file kept beside a case.

``tensa.core.layout`` has no ANDES in it, so these run without a worker: what a
version 2 document may hold, what a version 1 document becomes, and how the
sidecar is read, written and carried to a case saved under a new name.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path
from typing import Any

import pytest

from tensa.core.layout import (
    LAYOUT_SCHEMA_VERSION,
    MAX_BEND_POINTS,
    MAX_FIGURE_SETTINGS,
    MAX_FIGURE_TEXT,
    MAX_LAYOUT_BYTES,
    MAX_LAYOUT_FILE_BYTES,
    LayoutError,
    LayoutTooLargeError,
    SidecarLayout,
    carry_layout_sidecar,
    check_layout_size,
    for_renumbered_copy,
    layout_json,
    layout_sidecar_path,
    parse_layout,
    read_layout_sidecar,
    upgrade_layout,
    write_layout_sidecar,
)

pytestmark = pytest.mark.unit


def _v1(**extra: Any) -> dict[str, Any]:
    """A version 1 document: bus positions, and device positions when given."""
    return {
        "schema_version": "1",
        "andes_version": "2.0.0",
        "coordinates": {"1": {"x": 0.0, "y": 0.0}, "2": {"x": 120.0, "y": 40.0}},
        "last_modified": "2026-05-07T12:00:00+00:00",
        **extra,
    }


def _v2() -> dict[str, Any]:
    """A version 2 document with something in every section."""
    return {
        "schema_version": "2",
        "andes_version": "2.0.0",
        "coordinates": {"1": {"x": 0.0, "y": 0.0}, "2": {"x": 120.0, "y": 40.0}},
        "non_bus_coordinates": {
            "GENROU": {"1": {"x": 0.0, "y": -70.0, "bus": "1"}},
            "generator": {"1": {"x": 0.0, "y": -70.0, "bus": "1"}},
        },
        "controller_coordinates": {"EXST1": {"1": {"x": 64.0, "y": -88.0}}},
        "units": {"1": {"expanded": True, "bus": "1"}},
        "busbars": {"2": {"length": 180.0, "orientation": "vertical"}},
        "branches": {
            "line": {
                "Line_1": {
                    "routing": "polyline",
                    "bend_points": [
                        {"x": 30.0, "y": 6.0},
                        {"x": 30.0, "y": 40.0},
                        {"x": 150.0, "y": 40.0},
                    ],
                    "bus1": "1",
                    "bus2": "2",
                    "source_face": "south",
                    "target_face": "north",
                }
            }
        },
        "label_offsets": {"bus": {"1": {"dx": 4.0, "dy": -12.0}}},
        "connections": {
            "generator": {
                "1": {
                    "device_face": "south",
                    "bus_face": "north",
                    "bend_points": [
                        {"x": 25.0, "y": -24.0},
                        {"x": 25.0, "y": -12.0},
                        {"x": 40.0, "y": -12.0},
                        {"x": 40.0, "y": 3.0},
                    ],
                    "bus": "1",
                }
            }
        },
        "figure": {"monochrome": True, "line_width": 1.5, "font": "serif", "dpi": 300},
        "last_modified": "2026-10-06T08:00:00+00:00",
    }


# ---- what a document may hold -----------------------------------------------


def test_a_version_2_document_validates_and_dumps_back_to_itself() -> None:
    layout = parse_layout(_v2())
    assert layout.schema_version == LAYOUT_SCHEMA_VERSION
    assert layout.model_dump() == _v2()
    # And the same through JSON text, which is how a file and a request arrive.
    assert parse_layout(json.dumps(_v2())).model_dump() == _v2()
    assert parse_layout(json.dumps(_v2()).encode("utf-8")).model_dump() == _v2()


def test_every_section_but_the_bus_coordinates_is_optional() -> None:
    layout = parse_layout({**_v1(), "schema_version": "2"})
    assert layout.non_bus_coordinates == {}
    assert layout.controller_coordinates == {}
    assert layout.units == {}
    assert layout.busbars == {}
    assert layout.branches == {}
    assert layout.label_offsets == {}
    assert layout.connections == {}
    assert layout.figure == {}


def test_a_record_reads_with_its_defaults() -> None:
    doc = _v2()
    doc["units"] = {"1": {}}
    doc["busbars"] = {"2": {}}
    doc["branches"] = {"line": {"Line_1": {}}}
    doc["connections"] = {"load": {"PQ_1": {}}}
    layout = parse_layout(doc)
    assert layout.units["1"].expanded is False
    # The state of a unit written without its bus is trusted on its idx.
    assert layout.units["1"].bus is None
    assert layout.busbars["2"].length is None
    assert layout.busbars["2"].orientation == "horizontal"
    route = layout.branches["line"]["Line_1"]
    assert (route.routing, route.bend_points, route.source_face) == ("auto", [], None)
    assert (route.bus1, route.bus2) == (None, None)
    assert layout.connections["load"]["PQ_1"].bus_face is None
    # A connector with no points is worked out from where the device and the bus stand.
    assert layout.connections["load"]["PQ_1"].bend_points == []
    assert layout.connections["load"]["PQ_1"].bus is None
    # A device position written without its bus (version 1 had none) reads as unanchored.
    doc["non_bus_coordinates"] = {"load": {"PQ_1": {"x": 1.0, "y": 2.0}}}
    assert parse_layout(doc).non_bus_coordinates["load"]["PQ_1"].bus is None


@pytest.mark.parametrize(
    ("section", "value"),
    [
        ("coordinates", {"1": {"x": float("nan"), "y": 0.0}}),
        ("controller_coordinates", {"EXST1": {"1": {"x": 0.0, "y": float("inf")}}}),
        ("controller_coordinates", {"EXST1": {"1": {"x": 0.0}}}),
        # A bus has no bus of its own, and a placed controller is anchored by its device.
        ("coordinates", {"1": {"x": 0.0, "y": 0.0, "bus": "2"}}),
        ("controller_coordinates", {"EXST1": {"1": {"x": 0.0, "y": 0.0, "bus": "2"}}}),
        ("non_bus_coordinates", {"load": {"PQ_1": {"x": 0.0, "y": 0.0, "bus": 7}}}),
        ("branches", {"line": {"1": {"bus1": 1, "bus2": 2}}}),
        ("units", {"1": {"expanded": "sometimes"}}),
        ("units", {"1": {"expanded": True, "bus": 1}}),
        ("units", {"1": {"expanded": True, "colour": "red"}}),
        ("busbars", {"1": {"length": 0.0}}),
        ("busbars", {"1": {"length": -10.0}}),
        ("busbars", {"1": {"length": float("inf")}}),
        ("busbars", {"1": {"orientation": "diagonal"}}),
        ("branches", {"line": {"1": {"routing": "wavy"}}}),
        ("branches", {"line": {"1": {"bend_points": [{"x": 1.0, "y": float("nan")}]}}}),
        ("branches", {"line": {"1": {"source_face": "up"}}}),
        ("label_offsets", {"bus": {"1": {"dx": 1.0}}}),
        ("label_offsets", {"bus": {"1": {"dx": float("nan"), "dy": 0.0}}}),
        ("connections", {"load": {"1": {"bus_face": "inside"}}}),
        ("connections", {"load": {"1": {"bend_points": [{"x": float("inf"), "y": 0.0}]}}}),
        ("connections", {"load": {"1": {"bus": 7}}}),
        ("figure", {"line_width": float("nan")}),
        ("figure", {"font": "x" * (MAX_FIGURE_TEXT + 1)}),
        ("figure", {"palette": ["black", "white"]}),
        ("figure", {f"setting_{i}": True for i in range(MAX_FIGURE_SETTINGS + 1)}),
    ],
)
def test_a_value_the_schema_has_no_use_for_is_refused(section: str, value: object) -> None:
    doc = _v2()
    doc[section] = value
    with pytest.raises(LayoutError):
        parse_layout(doc)


def test_a_branch_cannot_bend_at_more_points_than_the_cap() -> None:
    doc = _v2()
    points = [{"x": float(i), "y": 0.0} for i in range(MAX_BEND_POINTS + 1)]
    doc["branches"] = {"line": {"1": {"routing": "polyline", "bend_points": points}}}
    with pytest.raises(LayoutError):
        parse_layout(doc)
    doc["branches"]["line"]["1"]["bend_points"] = points[:-1]
    assert len(parse_layout(doc).branches["line"]["1"].bend_points) == MAX_BEND_POINTS


def test_a_connector_cannot_bend_at_more_points_than_the_cap() -> None:
    doc = _v2()
    points = [{"x": float(i), "y": 0.0} for i in range(MAX_BEND_POINTS + 1)]
    doc["connections"] = {"load": {"1": {"bend_points": points, "bus": "2"}}}
    with pytest.raises(LayoutError):
        parse_layout(doc)
    doc["connections"]["load"]["1"]["bend_points"] = points[:-1]
    assert len(parse_layout(doc).connections["load"]["1"].bend_points) == MAX_BEND_POINTS


def test_a_route_drawn_by_hand_says_so_and_keeps_its_points() -> None:
    """``manual`` is what tells a route the user drew from one the diagram made:
    a tidy leaves the first alone and makes the second afresh."""
    doc = _v2()
    doc["branches"]["line"]["Line_1"]["routing"] = "manual"
    route = parse_layout(doc).branches["line"]["Line_1"]
    assert route.routing == "manual"
    assert [(p.x, p.y) for p in route.bend_points] == [(30.0, 6.0), (30.0, 40.0), (150.0, 40.0)]
    assert parse_layout(doc).model_dump() == doc


def test_an_unknown_section_is_refused() -> None:
    with pytest.raises(LayoutError):
        parse_layout({**_v2(), "viewport": {"zoom": 2}})


@pytest.mark.parametrize(
    "raw",
    ["{not json", b"\xff\xfe", "[]", "null", "3"],
    ids=["not-json", "not-utf8", "array", "null", "number"],
)
def test_text_that_is_not_a_layout_is_refused(raw: str | bytes) -> None:
    with pytest.raises(LayoutError):
        parse_layout(raw)


# ---- versions ---------------------------------------------------------------


@pytest.mark.parametrize("version", ["1", "1.0", "0.9", "one"])
def test_a_version_1_document_is_upgraded(version: str) -> None:
    doc = _v1(
        schema_version=version,
        non_bus_coordinates={"PQ": {"PQ_1": {"x": 5.0, "y": 70.0}}},
    )
    layout = parse_layout(doc)
    assert layout.schema_version == LAYOUT_SCHEMA_VERSION
    # What version 1 held is kept as it was.
    assert layout.model_dump()["coordinates"] == doc["coordinates"]
    assert layout.model_dump()["non_bus_coordinates"] == {
        "PQ": {"PQ_1": {"x": 5.0, "y": 70.0, "bus": None}}
    }
    assert layout.andes_version == "2.0.0"
    assert layout.last_modified == doc["last_modified"]
    assert layout.branches == {}


def test_the_upgrade_drops_controller_badges_saved_among_the_buses() -> None:
    doc = _v1()
    doc["coordinates"]["controller-EXST1-1"] = {"x": 136.0, "y": 12.0}
    doc["coordinates"]["controller-TGOV1-GOV_1"] = {"x": 136.0, "y": 34.0}
    assert sorted(parse_layout(doc).coordinates) == ["1", "2"]


def test_a_current_document_is_not_touched_by_the_upgrade() -> None:
    layout = SidecarLayout.model_validate(_v2())
    assert upgrade_layout(layout) is layout
    # Version 2 never wrote a badge among the buses, so a bus named like one stays.
    doc = _v2()
    doc["coordinates"]["controller-room"] = {"x": 1.0, "y": 2.0}
    assert "controller-room" in parse_layout(doc).coordinates


def test_a_document_of_a_newer_version_keeps_its_version() -> None:
    assert parse_layout({**_v2(), "schema_version": "3"}).schema_version == "3"


# ---- a copy whose idx values will change ------------------------------------


def _renumbering_source() -> dict[str, Any]:
    """A layout with, in each idx-keyed section, an entry that says what it is
    anchored to and one that does not."""
    doc = _v2()
    doc["non_bus_coordinates"] = {
        "PQ": {
            "PQ_0": {"x": 10.0, "y": 70.0, "bus": "7"},
            "PQ_9": {"x": 99.0, "y": 99.0},
        },
        "load": {
            "PQ_0": {"x": 10.0, "y": 70.0, "bus": "7"},
            "PQ_9": {"x": 99.0, "y": 99.0},
        },
        "shunt": {"Shunt_1": {"x": 1.0, "y": 1.0}},
    }
    route = doc["branches"]["line"]["Line_1"]
    doc["branches"] = {
        "line": {"Line_1": route, "Line_2": {**route, "bus1": None, "bus2": None}},
        "transformer": {"T1": {**route, "bus2": None}},
    }
    doc["label_offsets"] = {
        "bus": {"1": {"dx": 4.0, "dy": -12.0}},
        "load": {"PQ_0": {"dx": 1.0, "dy": 1.0}},
    }
    drawn = [{"x": 30.0, "y": 70.0}, {"x": 30.0, "y": 43.0}]
    doc["connections"] = {
        "generator": {"1": {"device_face": "south", "bus_face": "north"}},
        "load": {
            "PQ_0": {"bend_points": drawn, "bus": "7"},
            "PQ_9": {"bend_points": drawn},
        },
    }
    return doc


def test_a_renumbered_copy_keeps_what_is_keyed_by_bus_or_says_its_buses() -> None:
    kept = for_renumbered_copy(parse_layout(_renumbering_source())).model_dump()
    assert kept["coordinates"] == _v2()["coordinates"]
    assert kept["busbars"] == _v2()["busbars"]
    assert kept["figure"] == _v2()["figure"]
    assert kept["label_offsets"] == {"bus": {"1": {"dx": 4.0, "dy": -12.0}}}
    # The load that names its bus can be found again whatever it is called then.
    anchored = {"x": 10.0, "y": 70.0, "bus": "7"}
    assert kept["non_bus_coordinates"] == {"PQ": {"PQ_0": anchored}, "load": {"PQ_0": anchored}}
    assert list(kept["branches"]) == ["line"]
    assert list(kept["branches"]["line"]) == ["Line_1"]
    # So can the connector that was drawn by hand for it, which names the same bus.
    assert kept["connections"] == {
        "load": {
            "PQ_0": {
                "device_face": None,
                "bus_face": None,
                "bend_points": [{"x": 30.0, "y": 70.0}, {"x": 30.0, "y": 43.0}],
                "bus": "7",
            }
        }
    }
    # Nothing ties these to an element once the idx values have moved on.
    assert kept["controller_coordinates"] == {}
    assert kept["units"] == {}


def test_a_renumbered_copy_of_a_layout_with_nothing_to_drop_is_that_layout() -> None:
    doc = _v1(schema_version="2")
    layout = parse_layout(doc)
    assert for_renumbered_copy(layout).model_dump() == layout.model_dump()


# ---- the file beside a case -------------------------------------------------


def test_the_sidecar_sits_beside_the_case_under_its_whole_name(tmp_path: Path) -> None:
    assert layout_sidecar_path(tmp_path / "ieee14.raw") == tmp_path / "ieee14.raw.layout.json"
    assert layout_sidecar_path(tmp_path / "my.case.xlsx").name == "my.case.xlsx.layout.json"


def test_write_then_read_gives_the_layout_back(tmp_path: Path) -> None:
    case = tmp_path / "ieee14.raw"
    written = write_layout_sidecar(case, parse_layout(_v2()))
    assert written == tmp_path / "ieee14.raw.layout.json"
    assert [p.name for p in tmp_path.iterdir()] == ["ieee14.raw.layout.json"]  # no temp file
    if sys.platform != "win32":
        assert written.stat().st_mode & 0o777 == 0o600
    stored = read_layout_sidecar(case)
    assert stored is not None
    assert stored.model_dump() == _v2()


def test_a_version_1_layout_is_written_as_the_current_version(tmp_path: Path) -> None:
    case = tmp_path / "ieee14.raw"
    write_layout_sidecar(case, SidecarLayout.model_validate(_v1()))
    on_disk = json.loads((tmp_path / "ieee14.raw.layout.json").read_text(encoding="utf-8"))
    assert on_disk["schema_version"] == LAYOUT_SCHEMA_VERSION


def test_a_version_1_file_reads_as_the_current_version(tmp_path: Path) -> None:
    case = tmp_path / "ieee14.raw"
    layout_sidecar_path(case).write_text(json.dumps(_v1()), encoding="utf-8")
    stored = read_layout_sidecar(case)
    assert stored is not None
    assert stored.schema_version == LAYOUT_SCHEMA_VERSION
    assert sorted(stored.coordinates) == ["1", "2"]


def test_no_file_reads_as_no_layout(tmp_path: Path) -> None:
    assert read_layout_sidecar(tmp_path / "ieee14.raw") is None


@pytest.mark.parametrize(
    "content",
    ["{not json", json.dumps({"schema_version": "2"}), " " * (MAX_LAYOUT_FILE_BYTES + 1)],
    ids=["not-json", "not-a-layout", "too-large-to-read"],
)
def test_a_file_that_cannot_be_used_reads_as_no_layout_and_is_logged(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, content: str
) -> None:
    case = tmp_path / "ieee14.raw"
    layout_sidecar_path(case).write_text(content, encoding="utf-8")
    with caplog.at_level(logging.WARNING, logger="tensa.layout"):
        assert read_layout_sidecar(case) is None
    assert "ignoring the layout beside ieee14.raw" in caplog.text


# ---- the cap ----------------------------------------------------------------


def _with_routes(count: int) -> dict[str, Any]:
    """``_v2()`` with ``count`` more routed lines, each a couple of hundred bytes."""
    doc = _v2()
    route = doc["branches"]["line"]["Line_1"]
    doc["branches"]["line"].update({f"L{i:04d}": route for i in range(count)})
    return doc


def test_the_file_holds_the_layout_as_compact_json(tmp_path: Path) -> None:
    """One stored form: it is what the cap is measured on, so it is also what
    is written."""
    layout = parse_layout(_v2())
    written = write_layout_sidecar(tmp_path / "ieee14.raw", layout)
    data = written.read_bytes()
    assert data == layout_json(layout)
    assert json.loads(data) == _v2()
    assert b"\n" not in data and b": " not in data and b", " not in data


def test_the_cap_is_on_the_layout_as_it_is_stored(monkeypatch: pytest.MonkeyPatch) -> None:
    layout = parse_layout(_with_routes(20))
    size = len(layout_json(layout))
    monkeypatch.setattr("tensa.core.layout.MAX_LAYOUT_BYTES", size)
    check_layout_size(layout)  # at the cap: taken
    monkeypatch.setattr("tensa.core.layout.MAX_LAYOUT_BYTES", size - 1)
    with pytest.raises(LayoutTooLargeError) as raised:
        check_layout_size(layout)
    assert f"{size} bytes" in str(raised.value)
    assert str(size - 1) in str(raised.value)
    with pytest.raises(LayoutTooLargeError):
        layout_json(layout)


def test_a_field_left_to_its_default_counts_as_it_is_written_out(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A document can be shorter than the layout it holds: the server writes
    every field, and ``{}`` for a branch becomes its six fields."""
    doc = {**_v2(), "branches": {"line": {f"L{i:04d}": {} for i in range(100)}}}
    sent = len(json.dumps(doc, separators=(",", ":")))
    stored = len(layout_json(parse_layout(doc)))
    assert stored > 2 * sent
    monkeypatch.setattr("tensa.core.layout.MAX_LAYOUT_BYTES", sent)
    with pytest.raises(LayoutTooLargeError):
        check_layout_size(parse_layout(doc))


def test_a_layout_over_the_cap_is_not_written(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    case = tmp_path / "ieee14.raw"
    layout = parse_layout(_with_routes(20))
    monkeypatch.setattr("tensa.core.layout.MAX_LAYOUT_BYTES", len(layout_json(layout)) - 1)
    with pytest.raises(LayoutTooLargeError):
        write_layout_sidecar(case, layout)
    assert list(tmp_path.iterdir()) == []  # no file, and no temp file either


def test_a_file_written_with_indentation_reads_when_the_layout_in_it_fits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The file is larger than the cap and the layout in it is not: earlier
    versions wrote the file indented, and one edited by hand may be."""
    case = tmp_path / "ieee14.raw"
    doc = _with_routes(20)
    indented = json.dumps(doc, indent=2)
    stored = len(layout_json(parse_layout(doc)))
    assert len(indented) > 2 * stored
    monkeypatch.setattr("tensa.core.layout.MAX_LAYOUT_BYTES", stored)
    monkeypatch.setattr("tensa.core.layout.MAX_LAYOUT_FILE_BYTES", 4 * stored)
    layout_sidecar_path(case).write_text(indented, encoding="utf-8")
    read = read_layout_sidecar(case)
    assert read is not None
    assert read.model_dump() == doc
    # And it is carried to a new name, where it is written the compact way.
    target = tmp_path / "mine.xlsx"
    assert carry_layout_sidecar(case, target) is True
    assert layout_sidecar_path(target).stat().st_size == stored


def test_a_file_whose_layout_is_over_the_cap_reads_as_no_layout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Whatever the size of the file: this one is shorter than the cap, and
    the layout it holds would not fit in the file the server writes."""
    case = tmp_path / "ieee14.raw"
    doc = {**_v2(), "branches": {"line": {f"L{i:04d}": {} for i in range(100)}}}
    text = json.dumps(doc, separators=(",", ":"))
    monkeypatch.setattr("tensa.core.layout.MAX_LAYOUT_BYTES", len(text))
    layout_sidecar_path(case).write_text(text, encoding="utf-8")
    with caplog.at_level(logging.WARNING, logger="tensa.layout"):
        assert read_layout_sidecar(case) is None
    assert "ignoring the layout beside ieee14.raw" in caplog.text
    assert "as it is stored" in caplog.text


def test_the_real_cap_takes_a_few_thousand_buses_with_every_branch_routed() -> None:
    """What the cap is sized for, with room to spare, and the file guard above it."""
    doc = _v2()
    doc["coordinates"] = {str(i): {"x": 100.5 * i, "y": 40.25 * i} for i in range(3000)}
    route = doc["branches"]["line"]["Line_1"]
    doc["branches"]["line"] = {f"Line_{i}": route for i in range(4500)}
    assert len(layout_json(parse_layout(doc))) < MAX_LAYOUT_BYTES // 2
    assert len(json.dumps(doc, indent=2)) < MAX_LAYOUT_FILE_BYTES


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX symlinks")
def test_a_symlink_where_the_sidecar_goes_is_neither_read_nor_replaced(tmp_path: Path) -> None:
    elsewhere = tmp_path / "elsewhere.json"
    elsewhere.write_text(json.dumps(_v2()), encoding="utf-8")
    case = tmp_path / "ieee14.raw"
    os.symlink(elsewhere, layout_sidecar_path(case))
    assert read_layout_sidecar(case) is None
    with pytest.raises(LayoutError, match="symlink"):
        write_layout_sidecar(case, parse_layout(_v1()))
    assert json.loads(elsewhere.read_text(encoding="utf-8")) == _v2()


# ---- a case saved under a new name ------------------------------------------


def _case(tmp_path: Path, name: str, layout: dict[str, Any] | None = None) -> Path:
    case = tmp_path / name
    case.write_text("case", encoding="utf-8")
    if layout is not None:
        layout_sidecar_path(case).write_text(json.dumps(layout), encoding="utf-8")
    return case


def test_a_new_name_takes_the_layout_along(tmp_path: Path) -> None:
    source = _case(tmp_path, "ieee14.raw", _v2())
    target = _case(tmp_path, "mine.xlsx")
    assert carry_layout_sidecar(source, target) is True
    carried = read_layout_sidecar(target)
    assert carried is not None
    assert carried.model_dump() == _v2()
    # The original keeps its own.
    assert read_layout_sidecar(source) is not None


def test_a_carried_version_1_layout_arrives_upgraded(tmp_path: Path) -> None:
    source = _case(tmp_path, "ieee14.raw", _v1())
    target = _case(tmp_path, "mine.xlsx")
    assert carry_layout_sidecar(source, target) is True
    on_disk = json.loads(layout_sidecar_path(target).read_text(encoding="utf-8"))
    assert on_disk["schema_version"] == LAYOUT_SCHEMA_VERSION


def test_a_carried_layout_replaces_the_one_the_old_file_of_that_name_had(tmp_path: Path) -> None:
    source = _case(tmp_path, "ieee14.raw", _v2())
    stale = {**_v1(), "coordinates": {"99": {"x": 9.0, "y": 9.0}}}
    target = _case(tmp_path, "mine.xlsx", stale)
    assert carry_layout_sidecar(source, target) is True
    carried = read_layout_sidecar(target)
    assert carried is not None
    assert sorted(carried.coordinates) == ["1", "2"]


def test_with_no_layout_to_carry_a_stale_one_beside_the_target_goes(tmp_path: Path) -> None:
    source = _case(tmp_path, "ieee14.raw")
    target = _case(tmp_path, "mine.xlsx", _v2())
    assert carry_layout_sidecar(source, target) is False
    assert not layout_sidecar_path(target).exists()
    # Likewise for a system built from scratch, which has no file to carry from.
    again = _case(tmp_path, "again.xlsx", _v2())
    assert carry_layout_sidecar(None, again) is False
    assert not layout_sidecar_path(again).exists()


def test_a_copy_that_will_be_renumbered_gets_the_layout_cut_down_to_what_survives(
    tmp_path: Path,
) -> None:
    source = _case(tmp_path, "ieee14.xlsx", _renumbering_source())
    target = _case(tmp_path, "ieee14.raw")
    assert carry_layout_sidecar(source, target, renumbered=True) is True
    carried = read_layout_sidecar(target)
    assert carried is not None
    expected = for_renumbered_copy(parse_layout(_renumbering_source()))
    assert carried.model_dump() == expected.model_dump()
    assert "PQ_9" not in carried.non_bus_coordinates["load"]
    # The original is not touched.
    kept = read_layout_sidecar(source)
    assert kept is not None
    assert "PQ_9" in kept.non_bus_coordinates["load"]


def test_a_save_over_the_open_file_leaves_its_layout_alone(tmp_path: Path) -> None:
    case = _case(tmp_path, "ieee14.raw", _v2())
    before = layout_sidecar_path(case).read_bytes()
    assert carry_layout_sidecar(case, case) is False
    assert carry_layout_sidecar(case, tmp_path / "." / "ieee14.raw") is False
    assert layout_sidecar_path(case).read_bytes() == before


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX symlinks")
def test_a_layout_that_cannot_be_carried_is_logged_not_raised(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    source = _case(tmp_path, "ieee14.raw", _v2())
    target = _case(tmp_path, "mine.xlsx")
    os.symlink(tmp_path / "planted.json", layout_sidecar_path(target))  # dangling
    with caplog.at_level(logging.WARNING, logger="tensa.layout"):
        assert carry_layout_sidecar(source, target) is False
    assert "could not carry the layout over to mine.xlsx" in caplog.text
    assert not (tmp_path / "planted.json").exists()
