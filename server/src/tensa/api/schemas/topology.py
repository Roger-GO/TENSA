"""The topology of the loaded case: its elements, the events its file defines and the
edits made to it."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from tensa.core.wrapper import ParamValue


class TopologyEntry(BaseModel):
    """One element in a topology summary."""

    idx: int | str = Field(
        ...,
        description=(
            "ANDES idx of the element (its public identifier in ANDES). "
            "Used as the stable handle in subsequent operations (e.g., "
            "Fault.bus references this idx)."
        ),
    )
    name: str = Field(..., description="Human-readable name of the element.")
    kind: str = Field(
        ...,
        description=(
            "ANDES model class name (e.g., ``Bus``, ``Line``, ``GENROU``, "
            "``PV``, ``Slack``, ``PQ``)."
        ),
    )
    params: dict[str, ParamValue] = Field(
        default_factory=dict,
        description=(
            "Flat dict of model-input parameters for this element (e.g., for "
            "a Bus: ``Vn`` rated voltage in kV, ``vmax``/``vmin`` voltage "
            "limits, ``area``, ``zone``; for a Line: ``r``, ``x``, ``b``, "
            "``g``, ``tap``, ``phi``; for a generator: ``Sn`` rated MVA, "
            "``Vn``, ``bus``, plus model-specific params). The Inspector "
            "Properties tab in the v0.1 UI consumes this dict; absent params "
            "(None or unavailable on a given model) are omitted."
        ),
    )
    job_id: str | None = Field(
        default=None,
        description=(
            "Job-registry id mirroring the mutation that produced this entry. "
            "Populated only when this ``TopologyEntry`` is the "
            "top-level response of an edit / PMU-add / profile-add routine; "
            "``null`` for nested entries inside a ``TopologySummary``."
        ),
    )


class CaseEvent(BaseModel):
    """A timed event the next time-domain run applies that the client did not
    schedule: one the case's files define, or one a bundle import or a snapshot
    restore replayed."""

    source: Literal["case", "restored"] = Field(
        ...,
        description=(
            "``case``: a ``Fault``, ``Toggle`` or ``Alter`` device the case "
            "file or one of its add-on files defines. ``restored``: a disturbance a bundle import or a "
            "snapshot restore replayed onto the system."
        ),
    )
    kind: Literal["fault", "toggle", "alter"] = Field(
        ..., description="Which ANDES event model it is."
    )
    t: float = Field(
        ...,
        description=(
            "Time the event starts, in seconds: a fault's ``tf``, otherwise "
            "the time the toggle or alteration fires."
        ),
    )
    name: str | None = Field(
        default=None,
        description=(
            "The device's name in the case file. ``null`` for a restored "
            "disturbance, which has none."
        ),
    )
    tc: float | None = Field(
        default=None,
        description=(
            "Fault only: time the fault is cleared, in seconds. ``null`` when "
            "the case gives none, which leaves the fault on."
        ),
    )
    model: str | None = Field(
        default=None,
        description=(
            "ANDES model of the device the event acts on: ``Bus`` for a fault, "
            "the toggled or altered model otherwise (a group name is possible "
            "in a case file)."
        ),
    )
    dev_idx: int | str | None = Field(
        default=None,
        description="ANDES idx of the device within ``model`` (the bus, for a fault).",
    )
    src: str | None = Field(
        default=None, description="Alter only: the parameter the event changes."
    )
    method: str | None = Field(
        default=None,
        description=(
            "Alter only: how ``amount`` is combined with the parameter's "
            "current value (``=``, ``+``, ``-``, ``*`` or ``/``)."
        ),
    )
    amount: float | None = Field(
        default=None, description="Alter only: the operand applied via ``method``."
    )


class EditStep(BaseModel):
    """One edit to the system made before a run: an element added, changed or
    deleted. What ``undo`` and ``redo`` of a topology summary name."""

    op: Literal["add", "edit", "delete"] = Field(
        ..., description="What the edit did to the element."
    )
    model: str = Field(..., description="ANDES model of the element.")
    idx: int | str | None = Field(
        default=None, description="The element's idx."
    )
    params: list[str] = Field(
        default_factory=list,
        description="``edit`` only: the params whose values it changed.",
    )
    also: int = Field(
        default=0,
        ge=0,
        description=(
            "``delete`` only: how many more devices went with the element "
            "because they depended on it."
        ),
    )


class TopologySummary(BaseModel):
    """Substrate's structural view of the loaded case.

    ``state`` reflects whether ``ss.setup()`` has been committed. Some
    fields on individual elements are only populated after setup.
    """

    state: Literal["pre-setup", "committed"] = Field(
        ...,
        description=(
            "``pre-setup`` if disturbances can still be added; ``committed`` "
            "after PF or TDS has triggered ``ss.setup()``. Once committed, "
            "callers must POST /sessions/{id}/reload to add more disturbances."
        ),
    )
    buses: list[TopologyEntry] = Field(..., description="Bus elements.")
    lines: list[TopologyEntry] = Field(..., description="Line elements.")
    transformers: list[TopologyEntry] = Field(
        ...,
        description=(
            "Transformer elements split out from the ANDES ``Line`` bucket "
            "via the ``tap != 1.0 OR phi != 0.0`` heuristic. Pure "
            "transmission lines remain in ``lines``; off-nominal-tap and "
            "phase-shifting branches move here."
        ),
    )
    generators: list[TopologyEntry] = Field(
        ...,
        description="Generator elements (PV, Slack, GENROU, GENCLS, etc.).",
    )
    loads: list[TopologyEntry] = Field(
        ...,
        description="Load elements — both static (PQ) and dynamic (ZIP).",
    )
    shunts: list[TopologyEntry] = Field(
        default_factory=list,
        description=(
            "Shunt elements (capacitors and reactors). Modeled as ANDES "
            "``Shunt`` devices; rendered with the IEC 60617 shunt-cap or "
            "shunt-reactor icon depending on the sign of ``b``."
        ),
    )
    controllers: list[TopologyEntry] = Field(
        default_factory=list,
        description=(
            "Dynamic controller devices: exciters (``IEEEX1``, ``ESDC2A``, "
            "``SEXS``), governors (``IEEEG1``, ``TGOV1``), the ``IEEEST`` "
            "PSS, and the ``REGCA1`` renewable-converter model. Surfaces "
            "the seven Unit-8 whitelist additions so the disturbance editor "
            "can populate device pickers when the case includes them. An "
            "``ESD1`` battery is listed here as well: like ``REGCA1`` it takes "
            "over a static generator (its ``gen``) in a time-domain run. Empty "
            "for cases that carry no dynamics addfile (stock IEEE 14 .raw "
            "alone)."
        ),
    )
    freq_hz: float | None = Field(
        default=None,
        description=(
            "System nominal frequency in Hz, as the case sets it: the header "
            "of a PSS/E RAW file, or the ``_config`` section of an xlsx or "
            "json file. A MATPOWER file, and any other case that sets none, "
            "keeps ANDES's default of 60. A per-unit rotor speed ``omega`` "
            "times this is the speed in Hz. ``null`` when the configuration "
            "has no usable value."
        ),
    )
    base_mva: float | None = Field(
        default=None,
        description=(
            "System MVA base, as the case sets it: the header of a PSS/E RAW "
            "file, ``baseMVA`` of a MATPOWER file, or the ``_config`` section "
            "of an xlsx or json file. Any other case, and a blank system, "
            "keeps ANDES's default of 100. A power in per unit on the system "
            "base times this is the power in MW or MVAr. A device with its own "
            "rating ``Sn`` gives some values per unit of that instead; an "
            "``ESD1`` battery reads alike on both only when its ``Sn`` equals "
            "this. ``null`` when the configuration has no usable value."
        ),
    )
    buses_without_vn: list[int | str] = Field(
        default_factory=list,
        description=(
            "Idx of the buses whose rated voltage (``Vn`` in the bus's "
            "params) the case file does not give: it is absent, blank or "
            "zero there, and ANDES fills in 110 kV. That 110 is not the "
            "bus's voltage base, so a client must not use it to turn a "
            "per-unit voltage into kV. Empty when every bus has a rated "
            "voltage. A bus whose ``Vn`` has been edited since the case was "
            "loaded is no longer listed."
        ),
    )
    events: list[CaseEvent] = Field(
        default_factory=list,
        description=(
            "Timed events the next time-domain run applies besides the "
            "disturbances a client commits through "
            "``POST /sessions/{id}/disturbances``: the ``Fault``, ``Toggle`` "
            "and ``Alter`` devices the case's files define (the bundled "
            "``kundur_full.xlsx`` trips ``Line_8`` at 2 s), and the "
            "disturbances a bundle import or snapshot restore replayed. A "
            "client that says what a run will do must count these. A device "
            "that cannot act (switched off with ``u = 0``, or a time below "
            "zero) is not listed. Empty when there are none."
        ),
    )
    undo: EditStep | None = Field(
        default=None,
        description=(
            "The edit ``POST /sessions/{id}/undo-last-edit`` would take back: "
            "the last element added, changed or deleted since the case was "
            "loaded. ``null`` when there is none. Edits are taken back while "
            "``state`` is ``pre-setup``."
        ),
    )
    redo: EditStep | None = Field(
        default=None,
        description=(
            "The edit ``POST /sessions/{id}/redo-edit`` would put back: the "
            "one taken back last. ``null`` when there is none, which is the "
            "case after any new edit."
        ),
    )
    job_id: str | None = Field(
        default=None,
        description=(
            "Job-registry id mirroring the routine that produced this topology "
            "snapshot: case load / reload, element delete / "
            "undo / redo, or blank-system create. ``null`` when the summary is "
            "a plain read (``GET /topology``)."
        ),
    )
