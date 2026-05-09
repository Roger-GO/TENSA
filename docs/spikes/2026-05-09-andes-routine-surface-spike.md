---
date: 2026-05-09
topic: andes-routine-surface-spike
status: complete
---

# ANDES Routine API Surface Spike (v2.0 Unit 1a)

All citations refer to `/home/roger-gracia/andes-project/.venv/lib/python3.12/site-packages/andes/...`. Empirical
runs use the same venv. Where the file claim conflicts with the brainstorm or the v2.0 plan, the source wins.

## Summary

- **Confirmed:** `EIG.run()` triggers `TDS.init()` + `TDS.itm_step()` as a side effect via `_pre_check`
  (`routines/eig.py:780-782`). Empirically `dae.t` jumps from `-1.0` to `0.0` after `EIG.run()` on IEEE 14
  (substrate must treat post-EIG state as TDS-polluted).
- **Confirmed:** `EIG.run()` warns on non-converged PFlow but still calls `TDS.init()` and crashes with
  `TypeError: object of type 'NoneType' has no len()` (`routines/tds.py:223`). The substrate **must** gate on
  `ss.PFlow.converged` itself; relying on `_pre_check` is unsafe.
- **Confirmed:** `Measurements.generate_from_pflow(noise_func=None, seed=None)` is real
  (`se/measurement.py:167`). The brainstorm's name was correct.
- **Surprising:** `TimeSeries` is a real model (`models/timeseries.py:243`) but the brainstorm's field set
  (`device, idx, src, mode`) is wrong. Real fields: `mode, path, sheet, fields, tkey, model, dev, dests`.
- **Surprising:** `mode=2` (interpolated) raises `NotImplementedError` (`models/timeseries.py:230`). v2.0 must
  expose only `mode=1` (exact-time) and surface the limitation in UI copy.
- **Surprising:** `TimeSeries.list2array()` requires the xlsx/csv to exist on disk at `setup()` time
  (`models/timeseries.py:114-116`). The TODO comment at line 99-101 explicitly flags this as a known limitation.
- **Confirmed:** `callpert` is integrator-agnostic — invoked in `tds.run()` outer loop at `routines/tds.py:450-451`,
  before `self.itm_step()` dispatches to the configured method. QNDF (`routines/qndf.py:172`) does not touch it.
- **Plan-affecting:** brainstorm's claim that ANDES exposes a public TDS streaming hook is partially true — only
  via `pert.py` file loading (`routines/tds.py:968-989`); there is no in-process callable registration. v2.0 will
  need to write a temp `pert.py` to disk and call `TDS._load_pert()` (or set `system.files.pert` and re-init).

## EIG (`andes/routines/eig.py`)

- **Signature:** `EIG.run(**kwargs)` (line 790). Returns `bool`. Mutates `self.As, self.mu, self.N, self.W,
  self.pfactors` and stats.
- **Prerequisites:**
  - `system.PFlow.converged` must be True (line 776). On False the routine logs a warning **but still falls
    through** to `TDS.init()` at line 781, which crashes if PFlow has never been called.
  - Wrapper code (substrate) must enforce PF convergence before calling `EIG.run()`.
- **Side effects (the ADV-001 claim, confirmed):**
  - `_pre_check` (line 768) calls `system.TDS.init()` + `system.TDS.itm_step()` whenever
    `system.TDS.initialized is False` (lines 780-782). This advances `dae.t` from `-1.0` → `0.0`, populates
    `dae.f, dae.g`, sets `TDS.initialized=True`. Confirmed empirically on IEEE 14.
  - **Implication:** running EIG and then expecting a clean operating-point snapshot for a follow-up TDS run
    is fine in practice (TDS would have to init anyway), but if a substrate ran EIG mid-disturbance-editing
    session it would silently switch the system into "TDS-initialized" mode. v2.0 should treat any post-EIG
    session as committed to the TDS phase.
- **Output attribute shapes:** All `As, mu, N, W, pfactors` are sized by the *reduced* state count after
  `_fold_zstates` (line 150) and `_apply_state_constraints` (line 472) — *not* `dae.n`. Verified empirically:
  - `ieee14.raw` (no dyn models): `dae.n=0`, `EIG.As.size=(0,0)`, `EIG.mu` length 0.
  - `ieee14_full.xlsx`: `dae.n=66`, `EIG.mu` length 62 (4 states folded/eliminated).
  - `kundur_full.json`: `dae.n=52`, `EIG.As (52,52)`, `EIG.mu` length 52, `EIG.pfactors (52,52)`.
- **Failure modes:**
  - Singular `gy` is handled by `_regularize_dead_columns` (line 414) — substituting 1.0 on dead-column
    diagonals. Singular `N` (right-eigvec matrix) emits a `LinAlgWarning` from `solve(N, Weye, ...)` at line
    283 but does not raise. Empirically observed on `kundur_full.json` (rcond ~ 1e-19).
  - `dae.n == 0` after fold/elimination: `_pre_check` only checks the raw `dae.n` *and only* in the `elif`
    branch (line 784), so it is skipped when TDS was already initialized. Substrate must check `mu.shape[0]`
    on the result.
- **Per-mode pfactor slicing:** Computed all-at-once in `calc_pfactor` (line 247) which takes a full
  `np.linalg.eig` + `solve` over the dense `As`. There is no lazy / per-mode slicing. KTD-7's "slice
  pfactors by mode_id on demand" must therefore be a *substrate-side* slice of an in-memory full matrix —
  not a back-call into ANDES. Plan text reads correctly already.

## CPF (`andes/routines/cpf.py`)

- **Signature:** `CPF.run(load_scale=None, p0_target=None, q0_target=None, pg_target=None, **kwargs)`
  (line 222). Returns `bool`.
- **Prerequisites:** `system.PFlow.converged` must be True, checked in `init()` (line 191) which `run` calls
  (line 248). Returns `False` cleanly on failure (no crash). No TDS pollution.
- **Output attributes:** `lam` (1-D length `nsteps`), `V` (`(nbus, nsteps)`), `theta` (`(nbus, nsteps)`),
  `steps`, `events`, `max_lam`, `done_msg`. Verified on IEEE 14 with `load_scale=2.0`: 18 steps, max
  lambda ≈ 3.258, `V.shape=(14,18)`.
- **`run_qv(bus_idx, q_range=5.0, **kwargs)`** (line 273): rejects `load_scale`/`p0_target`/`q0_target`/
  `pg_target` kwargs (line 312-317). Requires at least one PQ device at `bus_idx`. Populates `qv_q`, `qv_v`,
  `qv_bus`. The `stop_at` kwarg is honoured for this call only (line 337-345).
- **Side effects:** `_snapshot_base` (line 462) disables `PQ.vcmp` for the duration of the run; `_restore_base`
  (line 524) restores `dae.x, dae.y, p0, q0, pg, vcmp.enable`. The base case is fully restored on both
  success and failure (try/finally at line 255-259). Substrate can call CPF without worrying about state
  leakage.
- **Failure modes:** Returns `False` and sets `system.exit_code=1` on internal failure; `done_msg` field
  carries the reason for the UI.

## SE (`andes/routines/se.py`)

- **Signature:** `SE.run(measurements=None, algorithm=None, **kwargs)` (line 120). Returns `bool`.
- **Prerequisites:** `system.PFlow.converged` checked in `init()` (line 99). Returns `False` cleanly.
- **Measurements API:** `from andes.se import Measurements` — class lives at `andes/se/measurement.py:19`.
  Methods: `add(model, var, idx=None, sigma=0.01)` (line 86), `add_bus_voltage` (127), `add_bus_angle`
  (131), `add_bus_injection` (144), `add_line_flow` (152), `finalize` (160), and crucially
  **`generate_from_pflow(noise_func=None, seed=None)`** (line 167). The brainstorm's name was correct;
  the prior reviewer's flag was a false alarm.
- **Default measurement set:** When `measurements=None`, `_default_measurements` (line 272) creates `Bus
  voltage` + `Bus injection` measurements automatically and calls `generate_from_pflow()`.
- **`SE.report()`** (line 185): logs converged flag, iterations, objective `J`, max |dV|, max |da|. Pulls
  estimates via `v_est`/`a_est` properties (lines 254-266).
- **`chi_squared_test(confidence=0.95)`** (line 212) — only valid for WLS; LAV runs return
  `(False, J, inf, 0)` with a warning.
- **Failure modes:** Non-converged PF returns `False`; non-WLS chi-squared logs a warning; observability
  failure (dof ≤ 0) returns `(False, J, inf, dof)` with a warning (line 241-244).

## Snapshot (`andes/utils/snapshot.py`)

- **API:** `save_ss(path, system)` (line 39) and `load_ss(path)` (line 64). Both accept str path or
  file-like objects.
- **Implementation:** dill-based (`import dill` at line 34). Confirmed.
- **Pre-/post-setup behaviour:** No explicit guard. Save calls `system.remove_pycapsule()` at line 53 (which
  exists post-`prepare()`). Empirically: `save_ss` works *only* post-setup and post-PF (the pickled object
  carries `is_setup=True, PFlow.converged=True`). Pre-setup save would emit a partial system with no DAE
  addresses set; round-trip is undefined territory and not exercised in stock tests.
- **Round-trip:** Confirmed empirically — `save_ss` + `load_ss` of IEEE 14 produces a 2.2 MB pickle that
  round-trips to a system with `PFlow.converged=True, is_setup=True`.
- **Version locking:** Hard-coded warning in the docstring at line 49-51: *"The snapshots only work with the
  specific ANDES version that created it."* No runtime version-check is enforced. Substrate must record the
  ANDES version in the snapshot bundle metadata and refuse to load on mismatch (KTD-4 implication).

## PMU (`andes/models/measurement/pmu.py`)

- **Required params:** `bus` (mandatory, `IdxParam` to `ACNode`, line 15). `Ta` and `Tv` default to `0.1`
  (lines 18-19) — *not* mandatory.
- **Pre-setup add:** Confirmed empirically — `ss.add('PMU', dict(bus=1, Ta=0.05, Tv=0.05))` returns
  `'PMU_1'` on a `setup=False` system; `ss.PMU.n` becomes 1; `ss.setup()` succeeds; post-TDS `PMU.am.v`
  and `PMU.vm.v` carry tracked phasor measurements.
- **`flags.tds=True`:** Line 34 — confirmed; not a power-flow model. PMUs need a TDS run to populate
  measurements; calling `ss.PFlow.run()` alone leaves `am`/`vm` at their `v_str` initial values (`a` / `v`).
- **Group:** `'PhasorMeasurement'` (line 35) — useful for `system.find_models('PhasorMeasurement')`.

## TimeSeries (`andes/models/timeseries.py`)

**This one was the most-mis-stated in the brainstorm.**

- **Real fields (TimeSeriesData, lines 38-71):**
  - `mode` (NumParam, default 1, vrange (1,2); 1=exact, 2=interpolated)
  - `path` (DataParam, **mandatory**, line 53) — path to xlsx file
  - `sheet` (DataParam, mandatory, line 54)
  - `fields` (NumParam, mandatory, comma-separated column names; uses `iconvert=str_list_iconv`)
  - `tkey` (DataParam, default `'t'`)
  - `model` (DataParam, mandatory)
  - `dev` (IdxParam, mandatory) — idx of device to drive
  - `dests` (NumParam, mandatory, comma-separated destination param names)
- **Brainstorm's `device, idx, src, mode`** is wrong. Correct mapping: `device→model`, `idx→dev`,
  `src→fields+dests` (no single `src` field).
- **File-on-disk requirement:** `list2array()` (line 92-131) opens and reads the file during `setup()`. If
  the file is missing it raises `FileNotFoundError` (line 114-116). Confirmed empirically:
  `ss.add('TimeSeries', {...path='nonexistent.xlsx'...})` succeeds, then `ss.setup()` raises
  `FileNotFoundError`. v2.0 substrate must materialise any user-uploaded xlsx onto the case directory
  *before* the next `setup()` call.
- **`mode=2` interpolated:** Raises `NotImplementedError` in `apply_interpolate` (line 230). The class
  docstring explicitly warns this at line 265. **v2.0 UI must hide or disable mode=2** until upstream lands
  it.
- **Other constraints:** "TimeSeries will not be applied power flow" (docstring line 264) — TS only takes
  effect within TDS. `flags.tds=True` (line 85). The xlsx is assumed to live in `system.files.case_path`
  (line 111-112) unless the path is absolute.

## TDS callpert hook + QNDF integrator

- **Public hook:** The intended extension point is `system.files.pert` (a path on disk) loaded via
  `_load_pert` (`routines/tds.py:968-990`), which `importlib`-imports the module and assigns
  `self.callpert = getattr(module, 'pert')` (line 988). The pert function signature is `pert(t, system)`,
  invoked at `routines/tds.py:450-451` once per outer-loop step.
- **Direct in-process registration:** Not officially documented but trivially possible — the substrate can
  set `ss.TDS.callpert = some_callable` between `init()` and `run()`. This avoids the temp-file dance.
  However nothing in ANDES advertises this; it should be treated as a private extension and tested per
  ANDES release.
- **Integrator-agnostic:** `callpert` is invoked in `tds.run()`'s outer loop *before* `self.itm_step()`
  (line 456) which itself delegates to `self.method.step(self)` (line 601). The QNDF method
  (`routines/qndf.py:172`) does not call `callpert`. So the hook fires identically for `trapezoid`,
  `backeuler`, `trap_adapt`, and `qndf`. The reviewer concern that callpert was Trapezoidal-only is
  **unfounded** based on source.
- **Limitation:** `callpert` is per-outer-step, not per-Newton-iter, and not per-microstep inside the
  integrator. For sub-cycle disturbance injection (PMU-rate, ≤4 ms) the substrate cannot rely on `callpert`
  — `tds.h` is the granularity ceiling. v2.0 plan KTD already defers sub-cycle streaming to v2.5 (consistent
  with this finding).

## Plan-affecting findings

The plan at `docs/plans/2026-05-09-001-feat-v2-full-andes-coverage-plan.md` needs the following revisions:

1. **TimeSeries field schema (Unit 15):** the brainstormed `{device, idx, src, mode}` is fictional. Use the
   real schema `{mode, path, sheet, fields, tkey, model, dev, dests}`. UI form must collect xlsx upload +
   sheet name + comma-separated `fields`/`dests`. Strongly affects Unit 15's React form design.
2. **TimeSeries `mode=2`:** disable in UI; it raises `NotImplementedError`. Surface a tooltip linking to
   ANDES upstream tracker.
3. **TimeSeries upload pipeline:** add a substrate step that writes the user-uploaded xlsx to
   `system.files.case_path` *before* the `setup()` call. Otherwise `setup()` will raise. Pre-setup add of
   the TimeSeries metadata is fine; the file resolution happens at `list2array` (called from `setup`).
4. **EIG side-effect on TDS state (Unit 6):** confirm in the substrate's EIG endpoint contract that running
   EIG mutates `dae.t` and `TDS.initialized`. Either (a) document it as a known transition into TDS-mode,
   or (b) snapshot+restore around the EIG call. Recommend (a) since EIG-then-TDS is a common workflow.
5. **EIG without converged PF (Unit 6):** `EIG._pre_check` does not actually short-circuit — it falls
   through to `TDS.init()` and crashes. Substrate **must** check `ss.PFlow.converged` before calling
   `ss.EIG.run()` and 4xx the request otherwise.
6. **EIG mode count (KTD-7):** the eigenvalue count is the *reduced* state count, not `dae.n`. UI's "N
   eigenvalues" header must read from `len(EIG.mu)`, not `dae.n`. Stock IEEE 14 (no dyn models) gives 0
   eigenvalues; full IEEE 14 gives 62; kundur_full gives 52.
7. **EIG pfactors slicing (KTD-7):** confirmed all-at-once compute. The "slice on demand" endpoint is
   substrate-side over an in-memory matrix; this matches the plan, just confirming.
8. **Snapshot version-locking (KTD-4):** ANDES does not check version on load. The plan's KTD-4 must add a
   substrate-side version-stamp + refusal-to-load on minor-version mismatch. Otherwise users will get silent
   pickle deserialization failures on ANDES upgrades.
9. **`Measurements.generate_from_pflow` (Unit 13):** the brainstorm name was correct. No revision needed,
   but the spike confirms the API exists at `se/measurement.py:167` with signature
   `(noise_func=None, seed=None)`.
10. **callpert and QNDF (Unit 6/8):** the hook is integrator-agnostic. Substrate's disturbance-injection
    layer can use either the `pert.py` file path or the in-process `ss.TDS.callpert = fn` assignment, and
    both will fire under any integrator. No need to restrict to Trapezoidal in the plan's TDS section.

No fabricated `reset_to_pre_setup()` or analogous claim was found in the source — confirming the
`feedback_deepening_needs_source_grounding.md` warning that such an API does not exist. The substrate's
existing `reload_case()` pattern remains the only path back to a pre-setup state.
