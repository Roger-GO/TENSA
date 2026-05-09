"""Empirical xf sweep for Unit 5 of v2.0 plan.

Purpose
-------
Find the smallest ``xf`` (fault reactance) value at which a Fault disturbance
applied to a representative bus converges cleanly under fixed-step Trapezoidal
integration across a battery of ANDES test cases — including a renewable
inverter case.

The current `blankFaultSpec()` default in the web client is `xf=0.0001`, which
ANDES's own docstring warns is essentially a bolted fault and prone to numerical
instability with fixed-step integrators. This script empirically nails down the
smallest convergent value so the UI default does not foot-gun new users.

Method
------
For each (case, xf) pair:
  1. Load the case fresh (no_output=True so we don't pollute disk)
  2. ``setup()`` and run PFlow
  3. Pre-add a single Fault on a representative bus with the candidate ``xf``
     (Fault model has fields: ``bus, tf, tc, xf, rf``)
  4. Run TDS at default ``tf=10`` s, ``h=1/120`` s, Trapezoidal
  5. Record: ``converged`` (TDS.converged or run() return), ``final_t``
     (``ss.dae.t``), and a max bus-voltage overshoot signal (max |v| - 1 across
     all buses across the run, taken from the BusFreq / Bus model snapshot
     post-run).

ANDES quirk handled: ``ss.add()`` is rejected after ``setup()``. We therefore
load with ``setup=False``, add the Fault, and then call ``setup()``.

Run
---
    /home/roger-gracia/andes-project/.venv/bin/python \
        /data/projects/ANDES_App/docs/spikes/2026-05-09-xf-sweep.py
"""

from __future__ import annotations

import contextlib
import io
import logging
import sys
import traceback
from dataclasses import dataclass
from pathlib import Path

ANDES_CASES = Path(
    "/home/roger-gracia/andes-project/.venv/lib/python3.12/site-packages/andes/cases"
)


@dataclass
class SweepResult:
    case: str
    bus: int | str
    xf: float
    converged: bool
    final_t: float
    max_v_overshoot: float | None
    note: str = ""


def _silence_andes() -> None:
    """ANDES is loud. Mute logger + stdout for the per-run noise."""
    for name in ("andes", "andes.system", "andes.routines"):
        logging.getLogger(name).setLevel(logging.ERROR)


def _load_case(path: Path) -> object:
    """Load a case with ``setup=False``. Caller is responsible for setup()."""
    import andes  # imported inside function to keep top-level import light

    return andes.load(
        str(path),
        setup=False,
        no_output=True,
        default_config=True,
    )


def _representative_bus(ss: object, prefer: str = "load") -> int | str:
    """Pick a bus with at least one PQ load attached if ``prefer='load'``,
    otherwise pick a bus with a synchronous machine attached (stiffer fault).

    Default picks a load bus (canonical perturbation). The "gen" mode is used
    by the second sweep to surface near-source numerical instability that load-
    bus faults often hide.
    """
    bus_ids = list(ss.Bus.idx.v)  # type: ignore[attr-defined]
    if prefer == "gen":
        # Try GENROU then GENCLS — large-machine bus
        for model_name in ("GENROU", "GENCLS"):
            mdl = getattr(ss, model_name, None)
            if mdl is not None and getattr(mdl, "n", 0) > 0:
                gen_buses = list(mdl.bus.v)
                for b in gen_buses:
                    if b in bus_ids:
                        return b
        # Fall through if no machines at all
    pq_buses = list(ss.PQ.bus.v)  # type: ignore[attr-defined]
    for b in pq_buses:
        if b in bus_ids:
            return b
    if 5 in bus_ids:
        return 5
    return bus_ids[0]


def _max_overshoot(ss: object) -> float | None:
    """Return max(|v| - 1) across all buses post-run. None if Bus.v unavailable."""
    try:
        v = ss.Bus.v.v  # type: ignore[attr-defined]
        return float(max(abs(vi) for vi in v) - 1.0)
    except Exception:  # pragma: no cover - defensive
        return None


def run_one(case_path: Path, xf: float, *, prefer_bus: str = "load",
            tc_offset: float = 0.1) -> SweepResult:
    """Load + setup + Fault-on-bus + TDS. Returns a SweepResult.

    Catches everything; failures get ``converged=False`` with the exception text
    in ``note``.
    """
    case_label = case_path.name
    sink = io.StringIO()
    with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        try:
            ss = _load_case(case_path)
            bus = _representative_bus(ss, prefer=prefer_bus)
            ss.add(  # type: ignore[attr-defined]
                "Fault",
                dict(bus=bus, tf=1.0, tc=1.0 + tc_offset, xf=xf, rf=0.0),
            )
            ss.setup()  # type: ignore[attr-defined]
            ok_pf = ss.PFlow.run()  # type: ignore[attr-defined]
            if not ok_pf:
                return SweepResult(
                    case=case_label,
                    bus=bus,
                    xf=xf,
                    converged=False,
                    final_t=-1.0,
                    max_v_overshoot=None,
                    note="PFlow did not converge",
                )
            ss.TDS.config.tf = 10.0  # type: ignore[attr-defined]
            ss.TDS.config.h = 1.0 / 120.0  # type: ignore[attr-defined]
            ss.TDS.config.method = "trapezoid"  # type: ignore[attr-defined]
            ok_tds = ss.TDS.run()  # type: ignore[attr-defined]
            final_t = float(ss.dae.t)  # type: ignore[attr-defined]
            converged = bool(ok_tds) and final_t >= 9.99
            return SweepResult(
                case=case_label,
                bus=bus,
                xf=xf,
                converged=converged,
                final_t=final_t,
                max_v_overshoot=_max_overshoot(ss),
            )
        except Exception as exc:  # noqa: BLE001 - we want every failure shape
            return SweepResult(
                case=case_path.name,
                bus="?",
                xf=xf,
                converged=False,
                final_t=-1.0,
                max_v_overshoot=None,
                note=f"{type(exc).__name__}: {exc}".replace("\n", " ")[:160],
            )


def main() -> int:
    _silence_andes()

    cases = [
        # IEEE 14 with dynamic models — the dyn_only xlsx is self-contained
        # and avoids the .raw + .dyr pair-load complication.
        ANDES_CASES / "ieee14" / "ieee14_full.xlsx",
        ANDES_CASES / "ieee39" / "ieee39_full.xlsx",
        ANDES_CASES / "kundur" / "kundur_full.xlsx",
        # Renewable inverter case — REGCP1 is the closest standard to REGCA1
        # in the bundled cases (ieee14_regcp1.xlsx).
        ANDES_CASES / "ieee14" / "ieee14_regcp1.xlsx",
    ]
    xf_values = [0.0001, 0.001, 0.005, 0.01, 0.05, 0.1]

    results: list[SweepResult] = []
    # Sweep 1 — load-bus fault, tc-tf=0.1s (gentle, default UI scenario)
    for case in cases:
        if not case.exists():
            print(f"SKIP missing: {case}", file=sys.stderr)
            continue
        for xf in xf_values:
            print(f"[load 0.1s] {case.name:<28s} xf={xf}", file=sys.stderr)
            results.append(run_one(case, xf, prefer_bus="load", tc_offset=0.1))

    # Sweep 2 — generator-bus fault, longer tc-tf=0.2s (stiffer, surfaces
    # numerical instability at very-low xf that load-bus faults hide)
    for case in cases:
        if not case.exists():
            continue
        for xf in xf_values:
            print(f"[gen 0.2s] {case.name:<28s} xf={xf}", file=sys.stderr)
            r = run_one(case, xf, prefer_bus="gen", tc_offset=0.2)
            r.note = (r.note + " [gen-bus,tc=0.2]").strip()
            results.append(r)

    # Print as a markdown table so the spike md can copy-paste
    print()
    print("| case | bus | xf | converged | final_t | max |v|-1 | note |")
    print("|---|---|---|---|---|---|---|")
    for r in results:
        ov = "n/a" if r.max_v_overshoot is None else f"{r.max_v_overshoot:+.3f}"
        ft = f"{r.final_t:.2f}" if r.final_t >= 0 else "—"
        ok = "YES" if r.converged else "no"
        print(
            f"| {r.case} | {r.bus} | {r.xf} | {ok} | {ft} | {ov} | {r.note} |"
        )

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # pragma: no cover
        traceback.print_exc()
        sys.exit(1)
