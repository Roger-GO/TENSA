"""Time-domain simulation: the request, the traces and the controllers of a run, the
variables a run can record, and the abort."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from tensa.core.dae_vars import MAX_DAE_VARS
from tensa.core.stream import MAX_TRACE_VALUES
from tensa.core.tds_controllers import (
    MAX_CONTROLLERS,
    MAX_SAMPLE_VALUES,
    ControllerSpec,
)


class TdsRunRequest(BaseModel):
    """Request body for ``POST /sessions/{id}/tds`` (batch mode).

    Streaming runs use the WebSocket at ``/ws/{session_id}`` and are started
    by its ``start_tds`` frame; this schema is the batch-only surface.
    """

    model_config = ConfigDict(extra="forbid")

    tf: float = Field(
        ...,
        description="Final simulation time, in seconds. Must be > 0.",
        gt=0.0,
    )
    h: float | None = Field(
        None,
        description=(
            "Integration step size, in seconds, applied as ANDES "
            "``TDS.config.tstep``. With the default ``trapezoidal`` "
            "integrator this is the fixed step; ``None`` keeps the ANDES "
            "default (1/30 s). The ``qndf`` integrator picks its own step "
            "and ignores it; bound its step with "
            "``tds_config_overrides.max_step`` instead."
        ),
        gt=0.0,
        allow_inf_nan=False,
    )
    vars: list[Literal["bus_v", "gen_state", "gen_power", "line_flow", "load_pq"]] | None = Field(
        None,
        description=(
            "Optional selector for which variable groups appear as columns "
            "in each per-step Arrow record batch on the streaming path. "
            "``bus_v`` covers bus voltage magnitudes and angles; "
            "``gen_state`` adds generator rotor angle ``delta`` and per-"
            "unit speed ``omega`` for every member of the ANDES ``SynGen`` "
            "group (GENROU / GENCLS / PLBVFU1); ``gen_power`` adds their "
            "electrical ``Pe`` / ``Qe``; ``line_flow`` adds active and "
            "reactive power at each line's bus1 terminal; ``load_pq`` adds "
            "each PQ load's consumption. "
            "Unknown values are rejected with 422; an empty list is "
            "rejected with 422. The batch path (``POST /tds``) ignores "
            "this field at runtime: it returns the values of ``dae_vars`` "
            "instead, and accepts this field for symmetry with the WebSocket "
            "``start_tds`` config so generated clients can share one "
            "request shape. Defaults to ``[\"bus_v\", \"gen_state\"]`` when "
            "omitted on the streaming path."
        ),
        min_length=1,
    )
    dae_vars: list[str] | None = Field(
        None,
        max_length=MAX_DAE_VARS,
        description=(
            "ANDES variables to record, by the names ``dae.x_name`` and "
            "``dae.y_name`` give them (``omega GENROU 1``, ``vf GENROU 2``); "
            "``GET /sessions/{id}/dae-variables`` lists them. A batch run returns "
            "their values in ``traces``, at every step ANDES takes, with no "
            "scaling. A name that is not a variable of the loaded case is "
            "refused with 422 before anything runs. The streaming ``start_tds`` "
            "frame takes the same field and adds one column per name, named "
            "exactly so."
        ),
    )
    integrator: Literal["trapezoidal", "qndf"] = Field(
        "trapezoidal",
        description=(
            "DAE integrator. ``\"trapezoidal\"`` (default) maps "
            "to ANDES's fixed-step Implicit Trapezoidal Method "
            "(``ss.TDS.config.method = \"trapezoid\"``). ``\"qndf\"`` "
            "selects the variable-order, variable-step QNDF (NDF) method "
            "and forces ``fixt = 0`` so ANDES enables LTE-driven step "
            "control. Combine ``integrator=\"qndf\"`` with the Auto "
            "preset (``rtol=1e-3, atol=1e-6, max_step=0.05``) by passing "
            "the values via ``tds_config_overrides``."
        ),
    )
    controllers: list[ControllerSpec] | None = Field(
        None,
        max_length=MAX_CONTROLLERS,
        description=(
            "Controllers that act while the run goes: each reads the frequency "
            "once a sample ``period`` and sets the power of a battery or another "
            "distributed generation device, on top of the device's own "
            "set-point. Two kinds, picked by ``type``: ``droop`` (power in "
            "proportion to the frequency deviation beyond a dead band) and "
            "``ffr`` (a fixed power, once, for a set time when the frequency "
            "leaves a threshold or moves too fast). Powers are in MW, positive "
            "discharging, and frequencies in Hz. "
            "``GET /sessions/{id}/tds/controllers`` lists the devices that can be "
            "named. A controller that names a device the case does not have is "
            "refused with 422 before anything runs. What each did comes back in "
            "the result's ``controllers``; when the run ends the devices' inputs "
            "are as they were. A later run that names the same controllers and "
            "goes on from where this one stopped (a larger ``tf``) keeps their "
            "state, so an ``ffr`` that has fired does not fire again. After a "
            "reload or a restored snapshot they start afresh, and it can. The "
            "streaming ``start_tds`` frame takes the same field. Sweeps do not "
            "take controllers."
        ),
    )
    tds_config_overrides: dict[str, float] | None = Field(
        None,
        description=(
            "Optional adaptive-integrator tolerance overrides. "
            "Supported keys are ``rtol`` (→ ``ss.TDS.config.reltol``), "
            "``atol`` (→ ``ss.TDS.config.abstol``) and ``max_step`` (→ "
            "``ss.TDS.config.dtmax``), or the name of any ``ss.TDS.config`` "
            "field. An unknown key is refused with 422. So is a value that "
            "ANDES would take and then misbehave on: ``tstep`` must be "
            "finite and greater than 0, ``max_step`` (``dtmax``) finite "
            "and not negative (0 lets ANDES choose), ``fixt`` 0 or 1, and "
            "every other value a finite number. The tolerances have no "
            "effect when ``integrator=\"trapezoidal\"`` (the fixed-step "
            "path ignores ``reltol/abstol`` and uses ``h`` for stepping)."
        ),
    )


class TdsTraceSeries(BaseModel):
    """One recorded ANDES variable of a batch run."""

    name: str = Field(..., description="The variable, named as in ``dae_vars``.")
    values: list[float | None] = Field(
        ...,
        description=(
            "Its value at each time in ``traces.t``, as ANDES stores it. ``null`` "
            "for a value that is not a number (a diverged step)."
        ),
    )


class TdsTraces(BaseModel):
    """The ANDES variables a batch run was asked to record (``dae_vars``)."""

    t: list[float] = Field(
        ..., description="Simulation time of each recorded step, in seconds."
    )
    variables: list[TdsTraceSeries] = Field(
        ..., description="One series per requested variable, in the order asked."
    )
    truncated: bool = Field(
        ...,
        description=(
            "``true`` when the run took more steps than a response holds "
            f"({MAX_TRACE_VALUES} values in all) and the later steps were left "
            "out. Raise ``h`` or ask for fewer variables."
        ),
    )


class TdsControllerTrace(BaseModel):
    """What one controller read and commanded at each of its samples."""

    t: list[float] = Field(
        ...,
        description=(
            "Simulation time of each sample, in seconds: the solved instant the "
            "controller read, from which its command applies."
        ),
    )
    frequency: list[float] = Field(
        ..., description="The frequency the controller read at each sample, in Hz."
    )
    command: list[float] = Field(
        ...,
        description=(
            "The power the controller commanded from each sample on, in MW, "
            "positive discharging: what it adds to the device's own set-point."
        ),
    )
    output: list[float | None] = Field(
        ...,
        description=(
            "The active power the device was delivering at each sample, in MW, "
            "its own set-point included. Where it stays below what the command "
            "asks for, the device is at one of its limits. ``null`` where the "
            "device has no such reading."
        ),
    )
    soc: list[float | None] = Field(
        ...,
        description=(
            "The device's state of charge at each sample, 0 to 1. ``null`` for a "
            "device without one (a ``PVD1``)."
        ),
    )
    truncated: bool = Field(
        ...,
        description=(
            "``true`` when the run took more samples than a response holds "
            f"({MAX_SAMPLE_VALUES} values over all controllers) and the later "
            "ones were left out. Raise ``period``."
        ),
    )


class TdsControllerResult(BaseModel):
    """What one controller of a TDS run did."""

    type: Literal["droop", "ffr"] = Field(..., description="The kind of controller.")
    model: str = Field(..., description="ANDES model of the device it commanded.")
    idx: int | str = Field(..., description="The device's idx, as the case holds it.")
    samples: int = Field(
        ..., ge=0, description="How many times it read the frequency in this run."
    )
    first_action_t: float | None = Field(
        default=None,
        description=(
            "Simulation time, in seconds, of the first sample at which it commanded "
            "a power: for an ``ffr``, when it triggered. ``null`` if it never did."
        ),
    )
    released_t: float | None = Field(
        default=None,
        description=(
            "Simulation time, in seconds, at which an ``ffr`` let go after its "
            "hold. ``null`` for a ``droop``, and for an ``ffr`` that did not "
            "trigger or was still holding when the run ended."
        ),
    )
    peak_command: float = Field(
        ..., description="Its command of the largest magnitude, in MW, with its sign."
    )
    final_command: float = Field(
        ..., description="Its command when the run ended, in MW."
    )
    trace: TdsControllerTrace | None = Field(
        default=None,
        description=(
            "Its samples. Returned by a batch run; ``null`` in a stream's ``done`` "
            "frame, where the device's variables are streamed instead."
        ),
    )


class TdsBatchResult(BaseModel):
    """Result of a batch TDS run (post-completion delivery).

    Streaming TDS uses a different code path (the WebSocket at
    ``/ws/{session_id}``) that emits Arrow IPC frames per integration step.
    Batch mode blocks until completion and returns a summary; the per-step
    state values are NOT returned in batch mode unless the request names
    ``dae_vars``, whose values come back in ``traces`` (use streaming mode for
    the five variable groups).
    """

    run_id: str = Field(
        ..., description="Server-generated identifier for this TDS run."
    )
    converged: bool = Field(
        ...,
        description=(
            "``true`` if TDS completed without becoming ``busted``. "
            "Numerical instability (e.g., a fault that doesn't clear) "
            "surfaces as ``converged: false`` with ``final_t`` < ``tf``."
        ),
    )
    final_t: float = Field(
        ..., description="Last simulation time reached, in seconds."
    )
    callpert_count: int = Field(
        ...,
        description=(
            "Number of times the per-step ``TDS.callpert`` hook fired during "
            "the run. Useful as a sanity check that streaming is wired."
        ),
    )
    job_id: str | None = Field(
        default=None,
        description=(
            "Job-registry id mirroring this TDS run. Additive "
            "and IDENTICAL to ``run_id`` — the two fields alias the same value, "
            "with ``run_id`` preserved for backward compatibility. "
            "``GET /sessions/{id}/jobs/{job_id}`` returns the matching "
            "``JobRecord`` (kind ``tds-batch``). ``null`` only on legacy "
            "responses synthesised outside the job lifecycle."
        ),
    )
    traces: TdsTraces | None = Field(
        default=None,
        description=(
            "The values of the request's ``dae_vars``, every step of the run. "
            "``null`` when the request named none."
        ),
    )
    controllers: list[TdsControllerResult] | None = Field(
        default=None,
        description=(
            "What each of the request's ``controllers`` did, in the order asked, "
            "with its samples. ``null`` when the request named none."
        ),
    )


class TdsControllerVariables(BaseModel):
    """The ANDES variables that show a controller at work on one device: names
    to put in a run's ``dae_vars``."""

    command: str = Field(
        ...,
        description=(
            "The external power signal as the device receives it (``Pext``), per "
            "unit of the system base: what the controllers on it command."
        ),
    )
    frequency: str = Field(
        ..., description="The frequency the device measures at its bus (``fHz``), in Hz."
    )
    active_current: str = Field(
        ...,
        description=(
            "The device's active current (``Ipout_y``), per unit of the system "
            "base; times the bus voltage it is the active power delivered."
        ),
    )
    soc: str | None = Field(
        default=None,
        description="The device's state of charge (``pIG_y``); ``null`` for a model without one.",
    )


class TdsControllerTarget(BaseModel):
    """One device of the loaded case a controller can command."""

    model: str = Field(..., description="The device's ANDES model.")
    idx: int | str = Field(..., description="The device's idx.")
    name: str = Field(..., description="The device's name in the case.")
    bus: int | str | None = Field(default=None, description="Idx of the bus it is on.")
    in_service: bool = Field(
        ..., description="``false`` for a device that is switched off: commands do nothing to it."
    )
    p_limit: float | None = Field(
        default=None,
        description=(
            "The most active power the device delivers, in MW: the smaller of "
            "its power limit ``pmx`` and its current limit ``ialim`` (the power "
            "that current carries at rated voltage). A command beyond it is not "
            "delivered, and a ``droop`` that names no ``p_max`` is limited to "
            "it. ``null`` where the model has neither."
        ),
    )
    fn: float | None = Field(
        default=None,
        description="The device's nominal frequency, in Hz: what a ``bus`` reading deviates from.",
    )
    variables: TdsControllerVariables = Field(
        ..., description="ANDES variables to record to see the controller at work."
    )


class TdsControllerCatalogue(BaseModel):
    """The controllers a TDS run takes, for the loaded case."""

    types: list[Literal["droop", "ffr"]] = Field(
        ..., description="The kinds of controller: the values ``type`` takes."
    )
    coi_available: bool = Field(
        ...,
        description=(
            "``true`` when the case has a synchronous machine, which the "
            "centre-of-inertia frequency (``frequency: \"coi\"``) is read from. "
            "Without one a controller has to read its own ``bus``."
        ),
    )
    freq_hz: float | None = Field(
        default=None,
        description=(
            "The system's nominal frequency, in Hz: what a ``coi`` reading "
            "deviates from. ``null`` with no case loaded."
        ),
    )
    base_mva: float | None = Field(
        default=None,
        description="The system MVA base. ``null`` with no case loaded.",
    )
    targets: list[TdsControllerTarget] = Field(
        ...,
        description=(
            "The devices a controller can command: those of ANDES's distributed "
            "generation models (``ESD1``, ``PVD1``, ``EV1``, ``EV2``). Empty when "
            "the case has none, and with no case loaded."
        ),
    )


class DaeVariableInfo(BaseModel):
    """One ANDES variable of one device of the loaded case."""

    name: str = Field(
        ...,
        description=(
            "``<variable> <Model> <idx>`` as ANDES spells it in ``dae.x_name`` / "
            "``dae.y_name`` (``omega GENROU 1``): what ``dae_vars`` asks for it by, "
            "and the name of its column in a stream."
        ),
    )
    kind: Literal["x", "y"] = Field(
        ...,
        description="``x`` for a state variable, ``y`` for an algebraic one.",
    )
    model: str = Field(..., description="ANDES model the device belongs to.")
    var: str = Field(..., description="The variable's name within the model.")
    idx: int | str = Field(..., description="The device's idx.")
    unit: str | None = Field(
        default=None, description="ANDES's unit for the variable; ``null`` where it gives none."
    )
    info: str | None = Field(
        default=None,
        description="ANDES's description of the variable; ``null`` where it gives none.",
    )


class DaeVariableList(BaseModel):
    """A page of the ANDES variables of the loaded case."""

    total: int = Field(
        ..., ge=0, description="How many variables match the filters, across all pages."
    )
    items: list[DaeVariableInfo] = Field(
        ..., description="The requested page, in the models' own order."
    )


class AbortResponse(BaseModel):
    """Response body for ``POST /sessions/{id}/abort``.

    The endpoint is fire-and-forget at the wire level — it sets the session's
    abort event and returns immediately. The actual TDS exit happens
    cooperatively at the next ``callpert`` tick on the worker (typically
    within a few milliseconds for IEEE 14, longer for larger cases). The
    streaming WebSocket emits the terminal ``done`` message with
    ``final_t < tf`` once the integration loop exits.

    There is no ``aborted`` flag on the WS ``done`` payload — the UI infers
    user-initiated abort from local state (it set the abort itself) vs.
    numerical instability (a ``done`` with ``final_t < tf`` arrived without
    a local abort).
    """

    model_config = ConfigDict(extra="forbid")

    aborted: Literal[True] = Field(
        True,
        description=(
            "Always ``true`` on a successful response. The signal has been "
            "delivered to the worker; the actual TDS exit is cooperative "
            "and lands on the next per-step ``callpert`` tick. No-op when "
            "no TDS is currently running on the session (the abort event "
            "is set but never consumed)."
        ),
    )
