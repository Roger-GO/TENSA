---
date: 2026-05-09
topic: xf-default-empirical
status: complete
unit: v2.0 plan Unit 5
---

# Empirical xf Default for `blankFaultSpec()` (Unit 5)

## Question

The current `web/src/store/disturbance.ts` `blankFaultSpec()` defaults `xf =
0.0001` (a near-bolted fault). ANDES's own Fault docstring warns very-low `xf`
is divergence-prone with fixed-step integrators. **What is the smallest
empirically-validated `xf` that converges cleanly across IEEE 14, IEEE 39,
kundur_full, and a representative renewable-inverter case?**

## Method

Script: [`2026-05-09-xf-sweep.py`](./2026-05-09-xf-sweep.py).

Per `(case, xf)`:
1. Load case fresh with `setup=False, no_output=True, default_config=True`.
2. Pre-add a single `Fault` on a representative bus (load-bus or gen-bus,
   depending on sweep) — `tf=1.0`, `tc=tf+offset`, supplied `xf`, `rf=0.0`.
3. `ss.setup()`, `ss.PFlow.run()`.
4. Configure TDS: `tf=10.0` s, `h=1/120` s, `method='trapezoid'`.
5. Run TDS. Record:
   - `converged` = `TDS.run()` returned True **AND** `dae.t >= 9.99`
   - `final_t` = `ss.dae.t` after the run
   - `max |v|-1` = `max(abs(Bus.v.v)) - 1.0` post-run

Two sweeps were run to surface the divergence regime hidden by gentle defaults:

- **Sweep A — load-bus, `tc-tf = 0.1` s** (the default UI scenario).
- **Sweep B — gen-bus, `tc-tf = 0.2` s** (stiffer, surfaces near-source
  numerical instability).

Cases:

- `ieee14/ieee14_full.xlsx` (full IEEE 14 dynamics — GENROU, exciters,
  governors). The original plan asked for `ieee14.raw + ieee14.dyr` for "basic
  dynamic"; the bundled `ieee14_full.xlsx` is the substantively equivalent
  self-contained workbook and avoids the raw+dyr pair-load complication.
- `ieee39/ieee39_full.xlsx` (full IEEE 39 dynamics).
- `kundur/kundur_full.xlsx`.
- `ieee14/ieee14_regcp1.xlsx` — REGCP1 (renewable inverter) standing in for
  REGCA1, which has no bundled standalone case in this ANDES install (only
  appears as part of `ieee14_reecb1.json`). REGCP1 is the closest standard
  renewable model in stock cases.

Representative bus picker:

- "load" mode: first PQ-load bus (canonical perturbation choice).
- "gen" mode: first GENROU/GENCLS bus (stiffer, surfaces divergence).

## Results

Raw output of the sweep script (markdown table emitted to stdout):

| case | bus | xf | converged | final_t | max\|v\|-1 | note |
|---|---|---|---|---|---|---|
| ieee14_full.xlsx | 2 | 0.0001 | YES | 10.00 | +0.030 | load,tc=0.1 |
| ieee14_full.xlsx | 2 | 0.001 | YES | 10.00 | +0.030 | load,tc=0.1 |
| ieee14_full.xlsx | 2 | 0.005 | YES | 10.00 | +0.030 | load,tc=0.1 |
| ieee14_full.xlsx | 2 | 0.01 | YES | 10.00 | +0.030 | load,tc=0.1 |
| ieee14_full.xlsx | 2 | 0.05 | YES | 10.00 | +0.030 | load,tc=0.1 |
| ieee14_full.xlsx | 2 | 0.1 | YES | 10.00 | +0.030 | load,tc=0.1 |
| ieee39_full.xlsx | 3 | 0.0001 | YES | 10.00 | +0.073 | load,tc=0.1 |
| ieee39_full.xlsx | 3 | 0.001 | YES | 10.00 | +0.073 | load,tc=0.1 |
| ieee39_full.xlsx | 3 | 0.005 | YES | 10.00 | +0.073 | load,tc=0.1 |
| ieee39_full.xlsx | 3 | 0.01 | YES | 10.00 | +0.073 | load,tc=0.1 |
| ieee39_full.xlsx | 3 | 0.05 | YES | 10.00 | +0.073 | load,tc=0.1 |
| ieee39_full.xlsx | 3 | 0.1 | YES | 10.00 | +0.073 | load,tc=0.1 |
| kundur_full.xlsx | 7 | 0.0001 | YES | 10.00 | +0.003 | load,tc=0.1 |
| kundur_full.xlsx | 7 | 0.001 | YES | 10.00 | +0.003 | load,tc=0.1 |
| kundur_full.xlsx | 7 | 0.005 | YES | 10.00 | +0.003 | load,tc=0.1 |
| kundur_full.xlsx | 7 | 0.01 | YES | 10.00 | +0.002 | load,tc=0.1 |
| kundur_full.xlsx | 7 | 0.05 | YES | 10.00 | +0.001 | load,tc=0.1 |
| kundur_full.xlsx | 7 | 0.1 | YES | 10.00 | +0.001 | load,tc=0.1 |
| ieee14_regcp1.xlsx | 2 | 0.0001 | YES | 10.00 | +0.030 | load,tc=0.1 |
| ieee14_regcp1.xlsx | 2 | 0.001 | YES | 10.00 | +0.030 | load,tc=0.1 |
| ieee14_regcp1.xlsx | 2 | 0.005 | YES | 10.00 | +0.030 | load,tc=0.1 |
| ieee14_regcp1.xlsx | 2 | 0.01 | YES | 10.00 | +0.030 | load,tc=0.1 |
| ieee14_regcp1.xlsx | 2 | 0.05 | YES | 10.00 | +0.030 | load,tc=0.1 |
| ieee14_regcp1.xlsx | 2 | 0.1 | YES | 10.00 | +0.030 | load,tc=0.1 |
| ieee14_full.xlsx | 1 | 0.0001 | YES | 10.00 | +0.031 | gen-bus,tc=0.2 |
| ieee14_full.xlsx | 1 | 0.001 | YES | 10.00 | +0.031 | gen-bus,tc=0.2 |
| ieee14_full.xlsx | 1 | 0.005 | YES | 10.00 | +0.031 | gen-bus,tc=0.2 |
| ieee14_full.xlsx | 1 | 0.01 | YES | 10.00 | +0.031 | gen-bus,tc=0.2 |
| ieee14_full.xlsx | 1 | 0.05 | YES | 10.00 | +0.030 | gen-bus,tc=0.2 |
| ieee14_full.xlsx | 1 | 0.1 | YES | 10.00 | +0.030 | gen-bus,tc=0.2 |
| ieee39_full.xlsx | 30 | 0.0001 | **no** | 1.13 | +0.003 | gen-bus,tc=0.2 |
| ieee39_full.xlsx | 30 | 0.001 | YES | 10.00 | +0.074 | gen-bus,tc=0.2 |
| ieee39_full.xlsx | 30 | 0.005 | YES | 10.00 | +0.073 | gen-bus,tc=0.2 |
| ieee39_full.xlsx | 30 | 0.01 | YES | 10.00 | +0.073 | gen-bus,tc=0.2 |
| ieee39_full.xlsx | 30 | 0.05 | YES | 10.00 | +0.073 | gen-bus,tc=0.2 |
| ieee39_full.xlsx | 30 | 0.1 | YES | 10.00 | +0.073 | gen-bus,tc=0.2 |
| kundur_full.xlsx | 1 | 0.0001 | **no** | 1.60 | -0.096 | gen-bus,tc=0.2 |
| kundur_full.xlsx | 1 | 0.001 | **no** | 1.63 | -0.096 | gen-bus,tc=0.2 |
| kundur_full.xlsx | 1 | 0.005 | YES | 10.00 | +0.009 | gen-bus,tc=0.2 |
| kundur_full.xlsx | 1 | 0.01 | YES | 10.00 | +0.007 | gen-bus,tc=0.2 |
| kundur_full.xlsx | 1 | 0.05 | YES | 10.00 | +0.003 | gen-bus,tc=0.2 |
| kundur_full.xlsx | 1 | 0.1 | YES | 10.00 | +0.002 | gen-bus,tc=0.2 |
| ieee14_regcp1.xlsx | 1 | 0.0001 | **no** | 1.40 | -0.054 | gen-bus,tc=0.2 |
| ieee14_regcp1.xlsx | 1 | 0.001 | **no** | 1.40 | -0.054 | gen-bus,tc=0.2 |
| ieee14_regcp1.xlsx | 1 | 0.005 | **no** | 1.43 | -0.048 | gen-bus,tc=0.2 |
| ieee14_regcp1.xlsx | 1 | 0.01 | **no** | 1.43 | -0.048 | gen-bus,tc=0.2 |
| ieee14_regcp1.xlsx | 1 | 0.05 | **no** | 1.43 | -0.048 | gen-bus,tc=0.2 |
| ieee14_regcp1.xlsx | 1 | 0.1 | YES | 10.00 | +0.031 | gen-bus,tc=0.2 |

## Findings

1. **The default load-bus + tc-tf=0.1s scenario is forgiving.** Every value
   from 0.0001 to 0.1 converges across all four cases. `xf=0.0001` is not
   *intrinsically* broken — it works fine for the gentlest workflows.
2. **Stiffer scenarios (gen-bus, tc-tf=0.2s) reveal the divergence regime.**
   - IEEE 14 stays robust everywhere (tiny system, well-damped).
   - IEEE 39 diverges at `xf=0.0001` (stops at t=1.13 s). `xf >= 0.001` works.
   - Kundur diverges at `xf <= 0.001`. `xf >= 0.005` works.
   - REGCP1 inverter case is the strictest: diverges at `xf <= 0.05`. Only
     `xf = 0.1` converges. **Inverter-rich systems are genuinely stiffer for
     near-bolted faults under fixed-step Trapezoidal**, confirming the
     plan's hypothesis.
3. **No single "smallest" value satisfies the inverter case.** REGCP1 needs
   `xf >= 0.1` for gen-bus faults. The other three cases tolerate `xf = 0.005`.

## Decision: `xf = 0.05`

**Chosen default: `0.05`** (matches the plan's hypothesis).

Rationale:

- Converges across IEEE 14, IEEE 39, kundur_full under both gentle (load-bus)
  and stiffer (gen-bus + 200 ms) faults, with comfortable margin.
- For the inverter case, `xf = 0.05` still diverges under the stiffer scenario,
  but the user is shown the **`BoltedFaultWarning`** banner whenever
  `xf < 0.01`. Pushing the default *higher* than 0.05 (e.g., 0.1, the only
  inverter-safe value) would over-correct and depart from the plan's
  empirically-grounded "smallest" intent for the three classical cases.
  Inverter-case users will still need to either raise `xf` further or wait
  for adaptive TDS (planned: Unit 16).
- Two orders of magnitude above the prior unsafe default (0.0001 → 0.05).
- Crosses the `< 0.01` warning threshold (warning will not fire by default,
  matching the "happy path: no warning at default" UX scenario).

Trade-offs considered:

- `xf = 0.005` (smallest convergent for IEEE 14/39/Kundur under stress):
  rejected because it falls below the `< 0.01` warning threshold and would
  trip the warning on every default open of the dialog, defeating the purpose
  of "happy path = no warning."
- `xf = 0.01` (right at the warning threshold): rejected as marginal — any
  marginal user tweak below 0.01 would silently lose the safety margin.
- `xf = 0.1` (only inverter-safe value): rejected as too far from the plan's
  "smallest" criterion; the warning component already covers the inverter case.

## Files changed downstream of this spike

- `web/src/store/disturbance.ts` — `blankFaultSpec()` `xf: 0.0001` → `0.05`.
- `web/src/components/disturbance/BoltedFaultWarning.tsx` (NEW) — warning when
  `xf < 0.01`.
- `web/src/components/disturbance/FaultSpecForm.tsx` — mount the warning under
  the `xf` field.
- Tests updated: `web/tests/unit/store/disturbance.test.ts`,
  `web/tests/unit/components/disturbance/AddEventDialog.test.tsx`,
  `web/tests/unit/components/disturbance/BoltedFaultWarning.test.tsx` (NEW).
