"""Power flow: the request, and the result with the flows, outputs and loads it reads."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from tensa.core.pflow_options import (
    MAX_ITERATIONS_MAX,
    MAX_ITERATIONS_MIN,
    TOLERANCE_MAX,
    TOLERANCE_MIN,
)


class LineFlow(BaseModel):
    """Per-line active and reactive power flow at both terminals: ``p`` / ``q``
    at terminal 1 (``bus1``) and ``p_to`` / ``q_to`` at terminal 2 (``bus2``),
    each flowing from the bus INTO the line, plus the line's loss and its
    loading against its rating.

    Sign convention: positive ``p`` means real power flowing FROM ``bus1``
    INTO the line; positive ``q`` means reactive power flowing FROM ``bus1``
    INTO the line, and the same at terminal 2 for ``p_to`` / ``q_to``. On a
    line that carries power from ``bus1`` to ``bus2``, ``p`` is positive and
    ``p_to`` negative, and the two sum to the loss. The SLD overlay uses the
    sign of ``p`` to render directional arrows along each branch.
    """

    p: float = Field(
        ...,
        description=(
            "Active power leaving ``bus1`` into the line, in MW (i.e., "
            "computed in pu and multiplied by the system base MVA)."
        ),
    )
    q: float = Field(
        ...,
        description=(
            "Reactive power leaving ``bus1`` into the line, in MVAr."
        ),
    )
    from_idx: int | str = Field(
        ...,
        description="ANDES idx of the ``bus1`` terminal (the from-side bus).",
    )
    to_idx: int | str = Field(
        ...,
        description="ANDES idx of the ``bus2`` terminal (the to-side bus).",
    )
    p_to: float = Field(
        ...,
        description=(
            "Active power leaving ``bus2`` into the line, in MW. Negative "
            "when the line delivers power to ``bus2``."
        ),
    )
    q_to: float = Field(
        ...,
        description="Reactive power leaving ``bus2`` into the line, in MVAr.",
    )
    loss: float = Field(
        ...,
        description=(
            "Active power the line dissipates, in MW: ``p + p_to``."
        ),
    )
    rate_a: float | None = Field(
        default=None,
        description=(
            "The line's long-term rating (the case's ``rate_a``), in MVA. "
            "``null`` when the case gives none (a ``rate_a`` of zero), in "
            "which case the line has no loading either."
        ),
    )
    loading_pct: float | None = Field(
        default=None,
        description=(
            "The larger of the apparent powers at the two terminals, "
            "``sqrt(p^2 + q^2)`` and ``sqrt(p_to^2 + q_to^2)``, as a "
            "percentage of ``rate_a``. Above 100 is an overload. ``null`` "
            "when the line has no rating."
        ),
    )


class GeneratorOutput(BaseModel):
    """Per-generator PF output. Active + reactive injection at the
    generator's terminal bus, plus the terminal voltage (pu). A generator that
    is switched off injects nothing: ``p`` and ``q`` are 0.
    """

    p: float = Field(
        ..., description="Active power generated at the terminal bus, in MW."
    )
    q: float = Field(
        ..., description="Reactive power generated at the terminal bus, in MVAr."
    )
    v: float = Field(
        ..., description="Terminal bus voltage magnitude (pu)."
    )
    bus: int | str = Field(..., description="Terminal bus idx.")
    q_min: float | None = Field(
        default=None,
        description=(
            "Lower reactive power limit the case sets (``qmin``), in MVAr. "
            "Power flow does not enforce it unless the run asked for "
            "``enforce_q_limits``, so ``q`` can lie below it. ``null`` for a "
            "generator that is switched off."
        ),
    )
    q_max: float | None = Field(
        default=None,
        description=(
            "Upper reactive power limit the case sets (``qmax``), in MVAr. "
            "Power flow does not enforce it unless the run asked for "
            "``enforce_q_limits``, so ``q`` can lie above it. ``null`` for a "
            "generator that is switched off."
        ),
    )


class LoadConsumption(BaseModel):
    """Per-load PF consumption at the converged voltage. A load that is
    switched off draws nothing: ``p`` and ``q`` are 0."""

    p: float = Field(..., description="Active power drawn, in MW.")
    q: float = Field(..., description="Reactive power drawn, in MVAr.")
    bus: int | str = Field(..., description="Terminal bus idx.")


class PflowSettings(BaseModel):
    """The settings a power-flow run used: the request's where it gave one, the
    case's own (ANDES's default unless the case file sets one) where it did not."""

    tolerance: float = Field(
        ...,
        description="Mismatch (max residual, in pu) below which the solver stopped.",
    )
    max_iterations: int = Field(
        ...,
        description=(
            "The iteration limit. ANDES stops once the count passes it, so a run "
            "that does not converge reports ``iterations`` one above this."
        ),
    )
    flat_start: bool = Field(
        ...,
        description=(
            "``true`` if the solver started from 1 pu at angle 0 on every bus "
            "that has no generator holding its voltage, ``false`` if it started "
            "from the voltages and angles in the case."
        ),
    )
    enforce_q_limits: bool = Field(
        ...,
        description=(
            "``true`` if a PV or slack generator whose reactive power went past "
            "``qmin`` or ``qmax`` was held at that limit (PV to PQ switching)."
        ),
    )


class PflowSummary(BaseModel):
    """System totals of a converged power flow, in MW and MVAr.

    Generation, load, bus shunts and lines balance: ``generation = load +
    shunt + loss``, in P and in Q, to the solver's tolerance. Devices that are
    switched off count for nothing.
    """

    generation_p: float = Field(
        ..., description="Active power the in-service generators produce, in MW."
    )
    generation_q: float = Field(
        ..., description="Reactive power the in-service generators produce, in MVAr."
    )
    load_p: float = Field(..., description="Active power the loads draw, in MW.")
    load_q: float = Field(..., description="Reactive power the loads draw, in MVAr.")
    shunt_p: float = Field(
        ..., description="Active power the bus shunts absorb, in MW (0 for a pure susceptance)."
    )
    shunt_q: float = Field(
        ...,
        description=(
            "Reactive power the bus shunts absorb, in MVAr: negative for a capacitor, "
            "which supplies it."
        ),
    )
    loss_p: float = Field(
        ..., description="Active power the lines and transformers dissipate, in MW."
    )
    loss_q: float = Field(
        ...,
        description=(
            "Reactive power the lines and transformers absorb, in MVAr: their series "
            "losses less their charging, so negative when charging dominates."
        ),
    )
    slack_p: float | None = Field(
        default=None,
        description=(
            "Active power the in-service slack generators produce, in MW: what the "
            "case's schedules leave for the slack to make up. ``null`` when there is none."
        ),
    )
    slack_q: float | None = Field(
        default=None,
        description=(
            "Reactive power the in-service slack generators produce, in MVAr. "
            "``null`` when there is none."
        ),
    )


class PflowResult(BaseModel):
    """Power-flow run result. Bus voltages and angles are keyed by ANDES idx."""

    run_id: str = Field(
        ...,
        description=(
            "Server-generated identifier for this PF run. Results are not "
            "stored under it: read the solved state again with "
            "GET /sessions/{id}/operating-point."
        ),
    )
    converged: bool = Field(
        ...,
        description=(
            "``true`` if PF converged within the iteration limit. Non-"
            "convergence is NOT a server error; it is a valid power-system "
            "outcome the caller must handle."
        ),
    )
    iterations: int = Field(
        ..., description="Number of Newton-Raphson iterations executed."
    )
    mismatch: float = Field(
        ...,
        description=(
            "Final mismatch (max element of the residual vector) at the "
            "converged solution. For non-converged runs this is the last "
            "iteration's mismatch."
        ),
    )
    bus_voltages: dict[str, float] = Field(
        ...,
        description=(
            "Bus voltage magnitudes (pu) keyed by ANDES idx (stringified). "
            "JSON object keys must be strings; the ANDES idx is "
            "converted at the boundary."
        ),
    )
    bus_angles: dict[str, float] = Field(
        ...,
        description="Bus voltage angles (radians) keyed by ANDES idx (stringified).",
    )
    line_flows: dict[str, LineFlow] = Field(
        default_factory=dict,
        description=(
            "Per-line P/Q flow at both terminals, with the line's loss and "
            "its loading against ``rate_a``, keyed by line idx (stringified). "
            "Empty if the wrapper could not extract line flows from the post-"
            "PF System (e.g., on an unexpected ANDES API change). "
            "Populated by computing the standard pi-equivalent line "
            "injection at each end from the converged ``v1``/``a1``/``v2``/"
            "``a2`` algebraic variables and the line's series + shunt "
            "admittances."
        ),
    )
    generator_outputs: dict[str, GeneratorOutput] = Field(
        default_factory=dict,
        description=(
            "Per-generator P / Q output, terminal voltage and reactive "
            "limits, keyed by generator idx (stringified). Covers the "
            "static generators (PV and Slack). A dynamic machine (GENROU, "
            "GENCLS) has no entry of its own: read the entry of the static "
            "generator named by its ``gen`` parameter. Empty when PF did "
            "not converge."
        ),
    )
    load_consumption: dict[str, LoadConsumption] = Field(
        default_factory=dict,
        description=(
            "Per-load P / Q consumption at the converged voltage, keyed "
            "by load idx (stringified). Covers PQ and ZIP. Empty when PF "
            "did not converge."
        ),
    )
    settings: PflowSettings | None = Field(
        default=None,
        description=(
            "The settings this run used, whether or not it converged. ``null`` "
            "on ``GET /sessions/{id}/operating-point``, which runs nothing."
        ),
    )
    summary: PflowSummary | None = Field(
        default=None,
        description=(
            "System totals: generation, load, bus shunts, line losses and the "
            "slack output. ``null`` when the run did not converge, and on "
            "``GET /sessions/{id}/operating-point``."
        ),
    )
    job_id: str | None = Field(
        default=None,
        description=(
            "Job-registry id mirroring this routine invocation. "
            "Additive: ``GET /sessions/{id}/jobs/{job_id}`` returns the "
            "matching ``JobRecord`` (kind ``pflow``). ``null`` only on legacy "
            "responses synthesised outside the job lifecycle."
        ),
    )


class PflowRunRequest(BaseModel):
    """Request body for ``POST /sessions/{id}/pflow``. Every field is optional:
    one that is left out keeps the case's own setting (ANDES's default unless
    the case file's ``_config`` section says otherwise). The settings apply to
    this run only; the next request starts from the case's settings again."""

    model_config = ConfigDict(extra="forbid")

    tolerance: float | None = Field(
        default=None,
        ge=TOLERANCE_MIN,
        le=TOLERANCE_MAX,
        allow_inf_nan=False,
        description=(
            "Convergence tolerance: the solver stops once the largest residual "
            f"(mismatch), in pu, is below it. From {TOLERANCE_MIN:g} to "
            f"{TOLERANCE_MAX:g}. ANDES's default is 1e-6."
        ),
    )
    max_iterations: int | None = Field(
        default=None,
        ge=MAX_ITERATIONS_MIN,
        le=MAX_ITERATIONS_MAX,
        description=(
            "Iteration limit. ANDES gives up once the count passes it. From "
            f"{MAX_ITERATIONS_MIN} to {MAX_ITERATIONS_MAX}. ANDES's default is 25."
        ),
    )
    flat_start: bool | None = Field(
        default=None,
        description=(
            "Start from 1 pu at angle 0 on every bus instead of the voltages and "
            "angles in the case. A bus with a generator holding its voltage still "
            "starts at that setpoint. Helps when the case's own starting point "
            "is far from the solution. Left out, the case's own setting stands; "
            "``false`` turns off a flat start the case file asks for."
        ),
    )
    enforce_q_limits: bool | None = Field(
        default=None,
        description=(
            "Hold a PV or slack generator at ``qmin`` or ``qmax`` when its "
            "reactive power goes past one (PV to PQ switching). Without it the "
            "limits are reported and not enforced. Left out, the case's own "
            "setting stands; ``false`` turns off enforcement the case file asks for."
        ),
    )
