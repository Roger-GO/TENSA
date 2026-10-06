"""The layout of a case's diagram: what it holds, and how it goes where the case goes.

A layout is one JSON document per case, kept beside the case file as
``<case file>.layout.json``. It records where everything on the single-line
diagram was put, so a case that is saved, copied or sent to someone opens with
the same picture:

- ``coordinates`` and ``non_bus_coordinates``: the position of every bus and of
  every generator, load and shunt, each device with the bus it hangs off.
- ``controller_coordinates``: a controller that was placed on its own. One with
  no entry is drawn docked beside the device it acts on.
- ``units``: per generating unit (a generator with its machine and their
  controllers, drawn as one symbol), whether its control chain is drawn out, and
  the bus the unit was on when that was chosen.
- ``busbars``: the length and the orientation of a bus's bar. A bar with no
  length set is as long as what connects to it needs.
- ``branches``: how a line or a transformer is drawn (``routing``), the points it
  bends at, and the face of each bus it leaves from.
- ``label_offsets``: how far a label was moved from where it is drawn by default.
- ``connections``: the faces a device's connector leaves the device and reaches
  the bus on, where they were chosen and not worked out.
- ``figure``: the display settings of the diagram and of a figure made from
  it. ``connector_style`` is the one the diagram itself reads: ``straight``, or
  ``elbow`` for device connectors drawn with one right angle.

Version 1 of the schema held only the first two. :func:`upgrade_layout` brings a
version 1 document to the current one, and every read and write here goes through
it, so the server only ever hands out and stores the current version.

Entries are keyed by ANDES idx, and an idx does not always keep its meaning. A
PSS/E ``.raw`` file holds none, so a system saved as one comes back with its
devices and branches numbered afresh by the parser, and an element that is
deleted can give its idx to the next one added. A device's position, the state
of a generating unit and a branch's route therefore carry what they are anchored
to (``bus``, and ``bus1`` / ``bus2``): a reader uses an entry only for an element
on those buses, and can match a position or a route whose idx no longer fits to
the element that is there now.
:func:`for_renumbered_copy` is what a copy written in such a format keeps.

The web client is what places things; the server validates the document and
keeps it with the case. ``PUT /workspace/layout`` writes it, and the functions at
the end of this module are what the save paths call: a case saved under a new
name takes its layout along (:func:`carry_layout_sidecar`), and a snapshot and a
reproducibility bundle hold a copy that restoring or importing puts back
(:func:`read_layout_sidecar`, :func:`write_layout_sidecar`).

A layout has one size, the bytes it takes as the server stores it
(:func:`layout_json`), and one cap on it (``MAX_LAYOUT_BYTES``). Every way in
holds a layout to that cap (the ``PUT``, the ``layout`` of a snapshot or a
bundle export, a file or a bundle entry that is read), so whatever the server
has taken it can also write beside a case, keep in a snapshot, pack in a
bundle, and read back.

This module imports nothing heavy (no ANDES), so the routes, the worker and the
bundle and snapshot code can all use it.
"""

from __future__ import annotations

import contextlib
import logging
import math
import os
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from tensa.core.errors import AndesAppError
from tensa.security.paths import write_private_temp

log = logging.getLogger("tensa.layout")

# The schema version this server reads, writes and answers with.
LAYOUT_SCHEMA_VERSION = "2"

# What a layout's file name adds to its case's: ``ieee14.raw.layout.json``.
LAYOUT_SIDECAR_SUFFIX = ".layout.json"

# Cap on a layout, in bytes of the form the server stores it in
# (:func:`layout_json`: compact JSON with every field written out). It is
# measured on that one form wherever a layout comes in, so a layout the server
# takes fits in the file beside the case, in a snapshot and in a bundle, and is
# read back from each. A few thousand buses with their devices and the bend
# points of every branch come to about a megabyte; the cap only stops a runaway
# document.
MAX_LAYOUT_BYTES = 2 * 1024 * 1024

# The most the server reads of a file, or of a bundle entry, that should hold a
# layout. It is not a second cap on the layout: the same document takes two to
# four times the room once it is indented, which is how earlier versions wrote
# the file and how one edited by hand may come back, so a reader takes in this
# much and then holds what it read to ``MAX_LAYOUT_BYTES``.
MAX_LAYOUT_FILE_BYTES = 4 * MAX_LAYOUT_BYTES

# The most points one branch can bend at. A routed branch has a handful.
MAX_BEND_POINTS = 256

# The most display settings ``figure`` can hold, and the longest text one can be.
MAX_FIGURE_SETTINGS = 64
MAX_FIGURE_TEXT = 256

Side = Literal["north", "east", "south", "west"]


class LayoutError(AndesAppError):
    """A document that is not a layout: not JSON, or a shape the schema refuses."""


class LayoutTooLargeError(LayoutError):
    """A layout over :data:`MAX_LAYOUT_BYTES` in the form the server stores it in."""


class BusCoord(BaseModel):
    """One position on the diagram.

    Coordinates are in arbitrary canvas units; the UI rescales them at render
    time. Infinity / NaN are rejected at validation time.
    """

    model_config = ConfigDict(extra="forbid")

    x: float = Field(..., description="X coordinate, finite (no NaN/Inf).")
    y: float = Field(..., description="Y coordinate, finite (no NaN/Inf).")

    @field_validator("x", "y")
    @classmethod
    def _finite(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("coordinate must be finite (no NaN/Inf)")
        return value


class LayoutDeviceCoord(BusCoord):
    """Where a generator, load or shunt is drawn, and the bus it hangs off."""

    bus: str | None = Field(
        None,
        description=(
            "idx of the bus the device was connected to when it was placed. A "
            "reader uses the position only for a device on that bus, so an idx "
            "that has come to name another element (a ``.raw`` file numbers "
            "its devices afresh) does not put it somewhere it never was. "
            "``null``: not recorded (a version 1 document); the idx alone is "
            "trusted."
        ),
    )


class LayoutUnit(BaseModel):
    """How one generating unit is drawn."""

    model_config = ConfigDict(extra="forbid")

    expanded: bool = Field(
        False,
        description=(
            "``true`` when the unit's control chain (exciter, governor, "
            "stabiliser) is drawn out; ``false`` when the unit is collapsed "
            "to its machine symbol."
        ),
    )
    bus: str | None = Field(
        None,
        description=(
            "idx of the bus the unit was on when this was chosen. A reader "
            "uses the entry only for a unit on that bus, so an idx that has "
            "come to name another generator does not draw the chain of that "
            "one out. ``null``: not recorded; the idx alone is trusted."
        ),
    )


class LayoutBusbar(BaseModel):
    """The bar a bus is drawn as."""

    model_config = ConfigDict(extra="forbid")

    length: float | None = Field(
        None,
        description=(
            "Length of the bar in canvas units. ``null`` leaves it to the "
            "renderer, which sizes the bar to what connects to it. A bar "
            "with a length set is still drawn longer when its connections "
            "need more room than that."
        ),
        gt=0,
        allow_inf_nan=False,
    )
    orientation: Literal["horizontal", "vertical"] = Field(
        "horizontal",
        description="Whether the bar lies across the diagram or stands upright.",
    )


class LayoutBranchRoute(BaseModel):
    """How one line or transformer is drawn between its two buses."""

    model_config = ConfigDict(extra="forbid")

    routing: Literal["auto", "polyline"] = Field(
        "auto",
        description=(
            "``auto``: the branch is drawn from where its two buses are now, "
            "and ``bend_points`` is not used. ``polyline``: it is drawn "
            "through ``bend_points`` as they are stored."
        ),
    )
    bend_points: list[BusCoord] = Field(
        default_factory=list,
        description=(
            "The points of a ``polyline`` route in order: where it leaves the "
            "first bus, each bend, and where it reaches the second bus. A "
            "route is only drawn while both ends still sit on their buses, so "
            "moving a bus sends its branches back to ``auto``."
        ),
        max_length=MAX_BEND_POINTS,
    )
    bus1: str | None = Field(
        None,
        description=(
            "idx of the bus the route starts at, with ``bus2`` what the route "
            "is anchored to: a reader draws it only for a branch between those "
            "two buses. ``null``: not recorded."
        ),
    )
    bus2: str | None = Field(
        None,
        description="idx of the bus the route ends at. ``null``: not recorded.",
    )
    source_face: Side | None = Field(
        None,
        description=(
            "Face of the first bus (``bus1``) the branch leaves from, when it "
            "was chosen. ``null`` lets the renderer pick the face that points "
            "at the other bus."
        ),
    )
    target_face: Side | None = Field(
        None,
        description=(
            "Face of the second bus (``bus2``) the branch arrives on, when it "
            "was chosen. ``null`` lets the renderer pick."
        ),
    )


class LayoutLabelOffset(BaseModel):
    """How far a label sits from where the renderer would put it."""

    model_config = ConfigDict(extra="forbid")

    dx: float = Field(
        ..., description="Shift to the right, in canvas units.", allow_inf_nan=False
    )
    dy: float = Field(..., description="Shift downwards, in canvas units.", allow_inf_nan=False)


class LayoutConnection(BaseModel):
    """Where the connector between a device and its bus attaches."""

    model_config = ConfigDict(extra="forbid")

    device_face: Side | None = Field(
        None,
        description=(
            "Face of the device symbol the connector leaves from, when it was "
            "chosen. ``null`` lets the renderer use the face that points at the bus."
        ),
    )
    bus_face: Side | None = Field(
        None,
        description=(
            "Face of the bus the connector lands on, when it was chosen. "
            "``null`` lets the renderer pick."
        ),
    )


class SidecarLayout(BaseModel):
    """The layout of one case's diagram (one file per case).

    Stored on disk as ``<case_path>.layout.json`` adjacent to the case file.
    Every section but ``coordinates`` is optional and reads as empty when
    absent, which is how a version 1 document (bus and device positions only)
    is still accepted; the server stores and answers with version 2.
    """

    model_config = ConfigDict(extra="forbid")

    schema_version: str = Field(
        ...,
        description=(
            "Schema version of the document. The server writes and answers "
            f'with ``"{LAYOUT_SCHEMA_VERSION}"``; a version 1 document '
            '(``"1"``, ``"1.0"``) is accepted and upgraded.'
        ),
        min_length=1,
    )
    andes_version: str = Field(
        ...,
        description=(
            "ANDES version the layout was saved against (e.g., ``\"2.0.0\"``). "
            "Recorded for diagnosis; not validated on read."
        ),
        min_length=1,
    )
    coordinates: dict[str, BusCoord] = Field(
        ...,
        description=(
            "Per-bus coordinates, keyed by bus idx (stringified). Buses "
            "missing from this dict fall back to the renderer's auto-layout."
        ),
    )
    non_bus_coordinates: dict[str, dict[str, LayoutDeviceCoord]] = Field(
        default_factory=dict,
        description=(
            "Per-non-bus-element coordinates, two-level dict keyed by "
            "ANDES model class (e.g., ``PV``, ``GENROU``, ``PQ``, ``Shunt``) "
            "OR by UI category (``generator``, ``load``, ``shunt``), then by "
            "element idx (stringified). The writer emits BOTH the model-"
            "class-keyed entry and the UI-category-keyed entry for every "
            "non-bus element so kind-edits (e.g., ``PV`` → "
            "``GENROU``) survive: the model-class entry becomes orphaned "
            "but the UI-category entry still resolves on read. Optional + "
            "additive — old sidecars without this field read as ``{}`` and "
            "the renderer falls back to kind-default offsets."
        ),
    )
    controller_coordinates: dict[str, dict[str, BusCoord]] = Field(
        default_factory=dict,
        description=(
            "Positions of controllers that were placed on their own, keyed "
            "by ANDES model class (``EXST1``, ``TGOV1``), then by idx. A "
            "controller with no entry is drawn docked beside the device it "
            "acts on and moves with it."
        ),
    )
    units: dict[str, LayoutUnit] = Field(
        default_factory=dict,
        description=(
            "Per generating unit (a generator with its machine and their "
            "controllers), keyed by the idx of the unit's generator symbol, "
            "the same idx its position has under ``generator`` in "
            "``non_bus_coordinates``."
        ),
    )
    busbars: dict[str, LayoutBusbar] = Field(
        default_factory=dict,
        description=(
            "The bar of a bus where it differs from the default, keyed by bus idx."
        ),
    )
    branches: dict[str, dict[str, LayoutBranchRoute]] = Field(
        default_factory=dict,
        description=(
            "How branches are drawn, keyed by ``line`` or ``transformer``, "
            "then by idx. A branch with no entry is routed automatically."
        ),
    )
    label_offsets: dict[str, dict[str, LayoutLabelOffset]] = Field(
        default_factory=dict,
        description=(
            "Labels that were moved, keyed like ``non_bus_coordinates`` with "
            "``bus``, ``line`` and ``transformer`` as further outer keys, "
            "then by idx."
        ),
    )
    connections: dict[str, dict[str, LayoutConnection]] = Field(
        default_factory=dict,
        description=(
            "Where the connector of a generator, load or shunt attaches, "
            "keyed like ``non_bus_coordinates``. A device with no entry has "
            "both ends worked out from where it sits."
        ),
    )
    figure: dict[str, bool | int | float | str] = Field(
        default_factory=dict,
        description=(
            "Display settings of this diagram and of a figure made from it "
            "(for example a monochrome style, a line width, which labels are "
            "shown), by name. The diagram reads ``connector_style``: "
            "``straight`` (the default) draws the connector of a generator, "
            "load or shunt to its bus as one line, ``elbow`` with one right "
            "angle. Values are booleans, finite numbers or short text; at "
            f"most {MAX_FIGURE_SETTINGS} settings."
        ),
    )
    last_modified: str = Field(
        ...,
        description=(
            "ISO 8601 timestamp recorded by the client at save time. The "
            "server does NOT regenerate this on write; it stores the value "
            "the client sent so collaborative-edit conflict detection (a "
            "future feature) has a single source of truth."
        ),
        min_length=1,
    )

    @field_validator("figure")
    @classmethod
    def _bounded_settings(
        cls, value: dict[str, bool | int | float | str]
    ) -> dict[str, bool | int | float | str]:
        if len(value) > MAX_FIGURE_SETTINGS:
            raise ValueError(f"at most {MAX_FIGURE_SETTINGS} figure settings")
        for name, setting in value.items():
            if isinstance(setting, float) and not math.isfinite(setting):
                raise ValueError(f"figure setting {name!r} must be finite (no NaN/Inf)")
            if isinstance(setting, str) and len(setting) > MAX_FIGURE_TEXT:
                raise ValueError(
                    f"figure setting {name!r} is longer than {MAX_FIGURE_TEXT} characters"
                )
        return value


# ---- versions ---------------------------------------------------------------


def _major(version: str) -> int:
    """The leading number of a schema version; 1 for anything unreadable."""
    match = re.match(r"\s*(\d+)", version)
    return int(match.group(1)) if match else 1


def upgrade_layout(layout: SidecarLayout) -> SidecarLayout:
    """``layout`` in the current schema version (itself when it already is).

    From version 1: the sections version 2 added are already empty by default,
    so what is left is the version number and one repair. A version 1 client
    could save the position of a controller badge among the buses, under the
    badge's node id (``controller-<class>-<idx>``); no bus is named that, and
    the entry made the diagram report a topology change on every open, so it is
    dropped. A document of a newer version than this server writes is returned
    as it is.
    """
    if _major(layout.schema_version) >= int(LAYOUT_SCHEMA_VERSION):
        return layout
    coordinates = {
        key: coord
        for key, coord in layout.coordinates.items()
        if not key.startswith("controller-")
    }
    return layout.model_copy(
        update={"schema_version": LAYOUT_SCHEMA_VERSION, "coordinates": coordinates}
    )


def for_renumbered_copy(layout: SidecarLayout) -> SidecarLayout:
    """What of ``layout`` still means something once the idx values have changed.

    For the copy of a system written in a format that keeps no idx (PSS/E
    ``.raw``): reading it back numbers the devices and branches afresh. What is
    keyed by bus stays, since a bus keeps its number. A device position and a
    branch route stay when they say which buses they belong to, so a reader can
    find them again; one that does not is dropped, as it would land on whatever
    element now has its idx. The sections with nothing to be matched by go
    (placed controllers, unit state, connection faces, the label offsets of
    anything but a bus); a ``.raw`` file holds no dynamic models either.
    """
    devices = {
        outer: {idx: coord for idx, coord in inner.items() if coord.bus is not None}
        for outer, inner in layout.non_bus_coordinates.items()
    }
    branches = {
        bucket: {
            idx: route
            for idx, route in routes.items()
            if route.bus1 is not None and route.bus2 is not None
        }
        for bucket, routes in layout.branches.items()
    }
    bus_labels = layout.label_offsets.get("bus")
    return layout.model_copy(
        update={
            "non_bus_coordinates": {k: v for k, v in devices.items() if v},
            "controller_coordinates": {},
            "units": {},
            "branches": {k: v for k, v in branches.items() if v},
            "label_offsets": {"bus": bus_labels} if bus_labels else {},
            "connections": {},
        }
    )


def parse_layout(raw: str | bytes | Mapping[str, Any]) -> SidecarLayout:
    """Validate ``raw`` (JSON text, or the object it parses to) and upgrade it.

    Raises :class:`LayoutError` when it is not a layout; the message is the
    validator's list of what is wrong and where.
    """
    try:
        if isinstance(raw, (str, bytes)):
            layout = SidecarLayout.model_validate_json(raw)
        else:
            layout = SidecarLayout.model_validate(dict(raw))
    except ValidationError as exc:
        raise LayoutError(str(exc.errors())) from exc
    return upgrade_layout(layout)


# ---- size -------------------------------------------------------------------


def layout_json(layout: SidecarLayout) -> bytes:
    """``layout`` as the server stores it: compact JSON in the current schema version.

    The file beside a case and a bundle's ``layout.json`` are these bytes, and
    :data:`MAX_LAYOUT_BYTES` is measured on them. Raises
    :class:`LayoutTooLargeError` for a layout over the cap, so nothing is
    written that a later read would turn down.
    """
    data = upgrade_layout(layout).model_dump_json().encode("utf-8")
    if len(data) > MAX_LAYOUT_BYTES:
        raise LayoutTooLargeError(
            f"the layout takes {len(data)} bytes as it is stored; "
            f"the cap is {MAX_LAYOUT_BYTES}"
        )
    return data


def check_layout_size(layout: SidecarLayout) -> None:
    """Raise :class:`LayoutTooLargeError` when ``layout`` is over the cap.

    For a layout that was read or sent and is not being written here: however
    the bytes it came in were laid out, the size that counts is the one it
    takes once stored.
    """
    layout_json(layout)


# ---- the file beside a case -------------------------------------------------


def layout_sidecar_path(case_path: Path) -> Path:
    """Where the layout of the case at ``case_path`` is kept: beside it."""
    return case_path.with_name(case_path.name + LAYOUT_SIDECAR_SUFFIX)


def write_layout_file(sidecar: Path, layout: SidecarLayout) -> None:
    """Write ``layout`` as the file ``sidecar``, atomically and with mode 0600.

    The document goes to a temp file in the same directory first and is renamed
    over ``sidecar``, so a reader never sees half of one. It is written in the
    current schema version, as :func:`layout_json` gives it, and one over the
    cap is refused (:class:`LayoutTooLargeError`) before anything is written.
    The caller has checked where ``sidecar`` points.
    """
    data = layout_json(layout)
    tmp_path = write_private_temp(sidecar.parent, data, prefix=".layout.")
    try:
        os.replace(tmp_path, sidecar)
    except Exception:
        with contextlib.suppress(OSError):
            tmp_path.unlink()
        raise


def read_layout_sidecar(case_path: Path) -> SidecarLayout | None:
    """The layout saved beside ``case_path``, or ``None`` when there is none to use.

    A layout is never worth failing a save, an export or a restore for, so one
    that cannot be read, is too large or does not validate is logged and
    treated as absent. A symlink in its place is not followed. The cap is held
    on the layout that was read, not on the file: a file written with
    indentation is larger than the layout in it.
    """
    sidecar = layout_sidecar_path(case_path)
    try:
        if sidecar.is_symlink() or not sidecar.is_file():
            return None
        size = sidecar.stat().st_size
        if size > MAX_LAYOUT_FILE_BYTES:
            log.warning(
                "ignoring the layout beside %s: the file is %d bytes, too large to read",
                case_path.name,
                size,
            )
            return None
        layout = parse_layout(sidecar.read_bytes())
        check_layout_size(layout)
    except (OSError, LayoutError) as exc:
        log.warning("ignoring the layout beside %s: %s", case_path.name, exc)
        return None
    return layout


def write_layout_sidecar(case_path: Path, layout: SidecarLayout) -> Path:
    """Save ``layout`` beside ``case_path`` and return the file written.

    Refuses to write where a symlink sits (:class:`LayoutError`): the rename
    would replace the link and not follow it, but a link there was not put by
    this server. Refuses a layout over the cap (:class:`LayoutTooLargeError`).
    """
    sidecar = layout_sidecar_path(case_path)
    if sidecar.is_symlink():
        raise LayoutError(f"{sidecar.name} is a symlink; not replacing it")
    write_layout_file(sidecar, layout)
    return sidecar


def _same_file(a: Path, b: Path) -> bool:
    try:
        return os.path.samefile(a, b)
    except OSError:  # one of the two does not exist
        return False


def carry_layout_sidecar(
    source_case: Path | None, target_case: Path, *, renumbered: bool = False
) -> bool:
    """Give the case just written as ``target_case`` the layout of ``source_case``.

    Called after a save under a new name, so the copy opens with the diagram
    the original had. Returns whether a layout was written. ``renumbered``
    says the copy will come back with other idx values than the session has
    (a ``.raw`` file), and the layout is cut down to what survives that
    (:func:`for_renumbered_copy`).

    When the source has no layout (or there is no source: a system built from
    scratch), a layout already beside the target is removed. It described
    whatever file had that name before and would be applied to a system it was
    not made for. A save over the source itself changes nothing. Failures are
    logged and not raised: the case is on disk either way.
    """
    if source_case is not None and _same_file(source_case, target_case):
        return False
    layout = read_layout_sidecar(source_case) if source_case is not None else None
    try:
        if layout is None:
            stale = layout_sidecar_path(target_case)
            if stale.is_file() and not stale.is_symlink():
                stale.unlink()
            return False
        write_layout_sidecar(target_case, for_renumbered_copy(layout) if renumbered else layout)
    except (OSError, LayoutError) as exc:
        log.warning("could not carry the layout over to %s: %s", target_case.name, exc)
        return False
    return True


__all__ = [
    "LAYOUT_SCHEMA_VERSION",
    "LAYOUT_SIDECAR_SUFFIX",
    "MAX_BEND_POINTS",
    "MAX_FIGURE_SETTINGS",
    "MAX_FIGURE_TEXT",
    "MAX_LAYOUT_BYTES",
    "MAX_LAYOUT_FILE_BYTES",
    "BusCoord",
    "LayoutBranchRoute",
    "LayoutBusbar",
    "LayoutConnection",
    "LayoutDeviceCoord",
    "LayoutError",
    "LayoutLabelOffset",
    "LayoutTooLargeError",
    "LayoutUnit",
    "SidecarLayout",
    "Side",
    "carry_layout_sidecar",
    "check_layout_size",
    "for_renumbered_copy",
    "layout_json",
    "layout_sidecar_path",
    "parse_layout",
    "read_layout_sidecar",
    "upgrade_layout",
    "write_layout_file",
    "write_layout_sidecar",
]
