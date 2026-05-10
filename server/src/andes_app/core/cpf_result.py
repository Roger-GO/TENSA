"""CPF (continuation power flow) result dataclasses for Unit 12 of the v2.0 plan.

Wraps :meth:`andes.routines.cpf.CPF.run` and :meth:`andes.routines.cpf.CPF.run_qv`
outputs. Returned by :meth:`andes_app.core.wrapper.Wrapper.run_cpf` and
:meth:`andes_app.core.wrapper.Wrapper.run_cpf_qv` and serialized over the
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
      reaching the nose (no NOSE event in ``CPF.events``).
    - ``max_lam``: peak lambda value reached. Echo of ``CPF.max_lam``
      (always populated, even on truncation).
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
    """

    lambdas: list[float]
    voltages_per_bus: dict[str, list[float]]
    bus_idxes: list[str]
    nose_idx: int
    max_lam: float
    truncated: bool
    done_msg: str
    mode: str  # "pv" or "qv"


__all__ = ["CpfResult"]
