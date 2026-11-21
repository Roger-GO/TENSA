# ANDES 2.0.0 capabilities not yet in TENSA

Source: Kimi run 002 (130 workers, one ANDES source file each, against `llms.txt`), plus an exact model list (`.claude/kimi/andes_model_coverage.py`). Statuses marked "checked" were confirmed by me against TENSA's schemas; the rest are worker findings still to be confirmed when each item is taken up in Phase 7A.

## A. Routine and solver options

| Item | ANDES | TENSA today | Priority |
|---|---|---|---|
| Power flow method | `PFlow.config.method` = `NR`, `dishonest`, `NK`; `n_factorize`; `linesearch` | not settable (checked) | high |
| TDS integrators | `trap_adapt`, `backeuler` beside trapezoid and QNDF | only `trapezoidal`, `qndf` (checked) | high |
| TDS tuning | `tol`, `max_iter`, `linesearch`, step bounds, `criteria`, `ddelta_limit`, `store_z/f/h/i` | QNDF tolerances only | medium |
| TDS initialise only, with diagnostics | `TDS.init()`, `test_init` tables | not exposed | high |
| TDS fast reset | `TDS.reinit()` | reload only | medium |
| Stepped TDS with mid-run actions | `andes.rl` environment, `TDS.run` in increments | controllers only (`droop`, `ffr`) | medium |
| CPF | `parameterization` (natural, arclength, pseudo-arclength), numeric `stop_at`, corrector `tol` / `max_iter`, step bounds, angles per bus | partly: direction, steps, limits (checked: no `parameterization`) | medium |
| Eigenvalue sweep and root loci | `EIG.sweep()`, `plot_root_loci()` | not exposed (checked) | high |
| State estimation | LAV estimator, chi-squared bad-data test, custom measurement sets with `seed`, `tol` / `max_iter`, residuals and `J` | WLS with generated measurements | high |
| Generic config override | `-O SECTION.FIELD=value`, `System.set_config` | per-routine fields only (checked) | medium |
| Sparse solver choice | `sparselib`: `klu`, `umfpack`, `spsolve`, `cupy` | not settable (checked) | low |
| Random seed | `configure_numpy(seed=...)` | not settable | low |

## B. Formats, exports, interop

| Item | ANDES | TENSA today | Priority |
|---|---|---|---|
| MATPOWER export | `system2mpc` | save offers `xlsx`, `json`, `raw` (checked) | high (also feeds Sienna) |
| pandapower bridge | `to_pandapower`, OPF through it (`runopp_map`), `make_GSF` | not exposed (checked) | high: a third engine for comparison, and OPF |
| pypowsybl, GridCal bridges | `to_pypowsybl`, `to_gridcal` | not exposed | medium |
| Admittance matrix | `System.build_ybus()` | not exposed (checked) | medium |
| Link table | `make_link_table` | partly, through topology | low |
| CSV and npz of a run | `TDSData.export_csv`, npz/lst output | COMTRADE and Arrow only (checked: no CSV route) | medium |
| External result import | `andes.utils.tsat` (TSAT and PSS/E Excel exports to series) | not exposed | high: lets a user overlay a commercial tool's result in the comparison view |
| Perturbation files | `--pert` | not exposed | low: arbitrary code, conflicts with the security posture |
| Model documentation | `doc()`, `supported_models()` | not exposed | medium |
| Dependency versions | `versioninfo` | ANDES version only | low |

## C. Models (exact list)

ANDES has 100 models in 36 groups. 29 are named nowhere in TENSA's server or web source, so they have no form, no help text and no unit grouping (a case that contains them still loads, since ANDES reads it):

- Motors: `Motor3`, `Motor5`
- Converter and renewable: `REGCV1`, `REGCV2`, `REGF1`, `REGF2`, `REGF3` (grid-forming), `REECA1E`, `REECA1G`, `WTDS`
- AC/DC: `VSCShunt`; DC links `RCp`, `RCs`, `RLs`, `RLCs`, `RLCp`
- Machines and controls: `SHAFT5`, `ESAC5A`, `TGOV1NDB`, `HYGOV4`, `IEEEVC`
- Loads: `FLoad`
- Measurement and calculation: `FreqDiv`, `COI`, `ACE`, `ACEc`
- Other: `Jumper`, `Area`, `Fortescue`

Per-model reference sheets (group, PSS/E equivalent, references, states) were written by the workers for all 116 model files and are in `.claude/kimi/runs/002-andes-gaps/out/model-*.md`. They are the starting table for the neutral language's model vocabulary.

## D. Judged not worth exposing

- `import_pycode` from a user path, perturbation files: arbitrary code on the server.
- MATLAB/Octave bridge (`andes.interop.matpower`): needs a licensed runtime.
- DiME streaming: needs an external server; TENSA's WebSocket stream covers the use.
- Interactive prompts, deprecated aliases, profiling.
