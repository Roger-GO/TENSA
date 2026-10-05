"""CPF (continuation power flow) result dataclasses for Unit 12 of the v2.0 plan.

Wraps :meth:`andes.routines.cpf.CPF.run` and :meth:`andes.routines.cpf.CPF.run_qv`
outputs. Returned by :meth:`tensa.core.wrapper.Wrapper.run_cpf` and
:meth:`tensa.core.wrapper.Wrapper.run_cpf_qv` and serialized over the
worker Pipe before crossing the FastAPI boundary.

ANDES exposes the continuation trajectory as two arrays on the ``CPF`` object:

- ``CPF.lam`` (1-D, length ``nsteps``): values of the continuation parameter
  lambda at each successful step (0 = base case, increasing as the load /
  generation is scaled up).
- ``CPF.V``   (2-D, shape ``[nbus, nsteps]``): per-bus voltage magnitudes at
  each lambda step.

Per Unit 1a spike (``docs/spikes/2026-05-09-andes-routine-surface-spike.md``):

- ``CPF.run(load_scale=2.0)`` on IEEE 14 returns ``True``, populates 18
  lambda steps, ``max_lam ≈ 3.258``, ``V.shape=(14, 18)``.
- The base case is restored on both success and failure (try / finally at
  ``cpf.py:255-259``); no state leakage.
- ``CPF.run_qv(bus_idx, q_range=5.0)`` writes ``qv_q``, ``qv_v``, ``qv_bus``
  attributes — single-bus QV-curve trace.
- ``done_msg`` carries a UI-friendly explanation (e.g. ``"Nose point at
  lambda=3.258046"``, ``"Reached max steps (5)"``).
"""

from __future__ import annotations

import dataclasses


@dataclasses.dataclass(frozen=True)
class CpfGeneratorTrace:
    """One static generator (PV or Slack) along a continuation path.

    - ``idx`` / ``bus``: the generator's ANDES idx and the bus it sits on, as
      text.
    - ``model``: ``"PV"`` or ``"Slack"``.
    - ``q``: its reactive output in MVAr at every step, index-aligned with
      :attr:`CpfResult.lambdas`.
    - ``q_min`` / ``q_max``: the reactive limits the case sets, in MVAr;
      ``None`` for one that is not finite.

    A generator that is out of service has no entry.
    """

    idx: str
    model: str
    bus: str
    q: list[float]
    q_min: float | None
    q_max: float | None


@dataclasses.dataclass(frozen=True)
class CpfLimitEvent:
    """The first step at which a generator is held at a reactive limit.

    - ``step``: index into :attr:`CpfResult.lambdas`. ``0`` means the power
      flow the continuation started from already held the generator there.
    - ``lam``: the value of ``lambdas`` at that step.
    - ``idx`` / ``model`` / ``bus``: the generator, as in
      :class:`CpfGeneratorTrace`.
    - ``limit``: ``"qmax"`` or ``"qmin"``.
    - ``at_nose``: ``True`` when the nose is where this generator switched.
      The path then has no way on with the generator either holding its
      voltage (it would be past the limit) or held at the limit (its voltage
      would be on the wrong side of the set-point), so the loadability ends
      at the switch and not at a smooth fold.
    - ``would_release_step``: the first step, from ``step`` on, at which the
      generator's terminal voltage is back across its set-point (above it
      for one held at ``qmax``, below for ``qmin``), where a real exciter
      would take the voltage up again and leave the limit. ANDES keeps the
      generator at the limit all the same, so from that step the curve is
      the one for a generator pinned there. ``None`` when it does not happen.

    A generator has at most one event: ANDES's limiter does not let go of a
    generator it holds.
    """

    step: int
    lam: float
    idx: str
    model: str
    bus: str
    limit: str  # "qmax" or "qmin"
    at_nose: bool = False
    would_release_step: int | None = None


@dataclasses.dataclass(frozen=True)
class CpfResult:
    """Continuation power flow result returned by ``Wrapper.run_cpf``.

    Field semantics:

    - ``lambdas``: per-step values of the continuation parameter
      (``CPF.lam`` coerced to a Python list of floats). Length = number
      of successful continuation steps. The first entry is the base
      case (lambda = 0); subsequent entries trace the curve up to (and
      slightly past) the nose point when ``stop_at='NOSE'``.
    - ``voltages_per_bus``: mapping ``bus_idx -> [V0, V1, ...]`` where
      each list is index-aligned with ``lambdas``. Bus indices are
      stringified (ANDES carries them as int or str depending on case
      file format; the wire payload normalises to str for stable
      JSON-key semantics).
    - ``bus_idxes``: ordered list of bus idxes (stringified) matching
      the row order of ``CPF.V``. Surfaced separately so the UI knows
      the canonical render order without dict-key iteration ambiguity.
    - ``nose_idx``: index into ``lambdas`` where lambda is maximised
      (the nose point). ``-1`` when the run was truncated before
      reaching the nose (no NOSE event in ``CPF.events``). On a full
      curve the steps after it are the lower branch.
    - ``max_lam``: lambda at the nose, and the largest value reached when
      there is no nose (always populated, even on truncation). For a QV
      curve it is on the axis ``lambdas`` is on: the largest reactive
      power at the bus.
    - ``truncated``: ``True`` when the run terminated without finding a
      nose point (e.g. hit ``max_steps`` or diverged). When ``True``,
      ``nose_idx == -1``.
    - ``done_msg``: ANDES's terminal status string. UI surfaces this in
      the truncation note (e.g. ``"Reached max steps (5)"``,
      ``"Nose point at lambda=3.258046"``).
    - ``mode``: discriminator — ``"pv"`` for the full PV-curve sweep
      (``CPF.run``) and ``"qv"`` for a single-bus QV-curve
      (``CPF.run_qv``). The wire shape is the same; the UI uses ``mode``
      to label axes ("Voltage vs lambda" vs "Voltage vs Q").
    - ``generators``: every in-service PV and Slack generator's reactive
      output along the path (:class:`CpfGeneratorTrace`). Empty when the
      readings could not be matched to the steps.
    - ``limit_events``: the generators held at a reactive limit, each with
      the first step at which it is (:class:`CpfLimitEvent`), in step
      order. An event marked ``at_nose`` means the nose is where that
      generator ran out of reactive power, not a smooth fold.
    - ``q_limits_enforced``: whether generators were switched from PV to PQ
      at their limits along the path. When ``False`` only the generators
      the base power flow already held are held (the events at step 0).
    - ``stop_at``: ``"nose"`` for a run that stops at the nose, ``"full"``
      for one that goes on along the lower branch back to ``lambda = 0``.
    - ``complete``: whether the run ended the way ``stop_at`` asked. A full
      curve whose lower branch broke off has a nose (``truncated`` is
      ``False``) and is not complete; ``done_msg`` says where it stopped.
    - ``direction``: the direction of the increase a PV run was asked for
      (``"load"``, ``"load-only"``, ``"gen"`` or ``"custom"``); ``None`` for
      a QV curve, which moves the reactive load of one bus.
    """

    lambdas: list[float]
    voltages_per_bus: dict[str, list[float]]
    bus_idxes: list[str]
    nose_idx: int
    max_lam: float
    truncated: bool
    done_msg: str
    mode: str  # "pv" or "qv"
    generators: list[CpfGeneratorTrace] = dataclasses.field(default_factory=list)
    limit_events: list[CpfLimitEvent] = dataclasses.field(default_factory=list)
    q_limits_enforced: bool = False
    stop_at: str = "nose"  # "nose" or "full"
    complete: bool = True
    direction: str | None = None


__all__ = ["CpfGeneratorTrace", "CpfLimitEvent", "CpfResult"]
