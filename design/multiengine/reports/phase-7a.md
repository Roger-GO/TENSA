# Phase 7A report: ANDES capabilities TENSA did not expose

Date: 2026-11-21. Scope: the gaps listed in `andes-gaps.md`. Each is additive: a request that names none of the new options behaves as before, and a field added to an existing response is optional. One gap is deferred (the pandapower bridge, at the end).

## What exists now

| Capability | Route or option | What ANDES 2.0.0 actually does, found by running it |
|---|---|---|
| Bus admittance matrix | `GET /sessions/{id}/ybus` | `build_ybus()` on a System that is not set up returns an empty matrix without an error, so the route sets the case up, as `GET /connectivity` does. A device switched off leaves explicit zeros, which are left out. |
| MATPOWER as a save format | `POST /sessions/{id}/save` with `format: "m"` | ANDES's writer fails on a System before setup (values are lists on the device base) and changes the System it is given. The writer hands it a read-only view on the system base. ANDES keeps only the last load or shunt of a bus; they are added up. |
| Power flow method | `method`, `n_factorize`, `linesearch` on `POST /sessions/{id}/pflow` | The three are read at run time. Under `NK` ANDES hands the solve to SciPy: it reads none of `tol`, `max_iter` and `linesearch`, reports no iterations, prints to standard output, and a run that fails raises (`IndexError`, or SciPy's `NoConvergence`) instead of reporting failure. All handled; contract 8. |
| Continuation power flow options | `parameterization`, `tol`, `corrector_max_iter`, `step_min`, `step_max`, a number as `stop_at` on `POST /sessions/{id}/cpf`; bus angles in the result | Natural parameterisation with the full curve fails at the nose; a corrector limit of 1 gives a false nose at 0.014 on IEEE 14; a tolerance above 1e-4 moves the nose and the reactive limit switches. Each is refused. A target past the nose makes ANDES run down the lower branch to a negative load level and fail; the run is ended at the nose. Contract 11. |
| Eigenvalue sweep | `POST /sessions/{id}/eig/sweep` | ANDES's own `EIG.sweep`, and any loop over the live System, keep the first value: `TDS.init()` returns at once when it has already run. Each point is therefore a System built and set up afresh with the value, solved with the settings of the session's last power flow. The session's System is not touched. |
| Integrators | `integrator: "backeuler" \| "trap_adapt"` beside `trapezoidal` and `qndf`; `min_step` | ANDES reads its method only when the time-domain routine initialises, so a run on a System that has stepped swaps the integrator object. The adaptive trapezoidal method takes steps far below a nanosecond when it struggles, which the recorder used to take for retries (283 rows recorded of 381 stored); fixed. Contract 13. |
| Initialise without running | `POST /sessions/{id}/tds/init` | A run that starts from an initialisation whose test failed reported that it converged; an eigenvalue analysis after an unchecked initialisation read Jacobians that were never evaluated (eigenvalues off by up to 49.5). Both fixed. `exist.tds` holds the static models too, so a case without dynamics is told by its models. Contract 13. |
| State estimation options | `algorithm: "wls" \| "lav"`, `tol`, `max_iter`, `noise_seed` on `POST /sessions/{id}/se`; the chi-squared test in the result | LAV is iteratively reweighted least squares in NumPy (no LP solver). With one measurement 20 sigma off and no noise it stays within 7e-4 rad of the truth where WLS is pulled by up to 0.10. With noise as well it often needs more than its 100 iterations and is not always the more accurate; the descriptions say so. |
| Model documentation | `GET /sessions/{id}/models`, `GET /sessions/{id}/models/{model}/doc` | `System.supported_models()` returns a printed table, and `System.groups` holds a deprecated alias that lists `Bus` twice; the list is built from the groups with the alias left out. The routes need a session because the server process does not import ANDES, and a test holds that it still does not. |
| External results | `POST /external-results?source=tsat\|psse` | ANDES's readers consume a header row and then drop 6 (TSAT) or 1 (PSS/E) rows; the route reads the same rows, held value for value against ANDES's own functions. The workbook is parsed in the server process, so it is capped before it is read, before it is unpacked and by its real extent. |

## Evidence

| Check | Result |
|---|---|
| Server unit suite on this PC | 4322 passed, 89 skipped (3819 at the end of Phase 3) |
| New and existing integration tests of the routes above | 321 passed over two runs, 2 skipped (signals Windows cannot deliver) |
| Acceptance tests that run on Windows, and the smoke test | 31 passed; passed |
| `ruff`, `mypy --strict` | pass (the two Windows-only type errors of the baseline remain) |
| GitHub CI, Linux, macOS, Windows, with acceptance and web end-to-end | green on `1d2bdd0a` (ten units); the run on `1fe78bbf` (the last three) is recorded in the next report |
| Each unit's own mutation check by its reviewer (4 to 21 deliberate breaks each) | every break made a test fail |
| A second, independent mutation check of the first five units (about 255 breaks proposed by worker models) | 222 failed a test; the 33 that did not are with a reviewer |

## How the units were made, and what that showed

Worker models wrote three candidates of each unit from a specification that other worker calls had drafted from ANDES's source. An Opus reviewer then took the closest candidate, ran ANDES to settle every claim, fixed it, and broke the code on purpose to see that the tests noticed.

- Of the ten units landed, none was right as a worker wrote it. Five had no candidate that passed its own checks; in two of those the worker API timed out on every candidate (the runner now asks for a stream after a timeout), and the reviewer wrote the unit.
- Every specification was wrong about ANDES somewhere, each time on something only a run shows: an option that is accepted and does nothing, a method that raises where it should report, a loop that recomputes nothing. Decision 26 (agreement between candidates is evidence, not proof) was extended by practice: a claim about an engine is checked by running the engine.
- One candidate passed every check with all its integration tests skipped, and its code raised on any real case. A unit's checks now fail when its own tests are skipped (decision 29).
- The reviews and the workflow tests also found defects outside the units they were about, in code that had passed its own review, and fixed them: a transformer record's length read from the wrong line in the identity reader; two elements handed one key (a fixed and a switched shunt on a bus; an element added during a session); a key problem noted again on every read; the default engine constant with no reader; a run that starts from a failed initialisation, reached through an eigenvalue analysis, reported as converged.

## Open points

- The eigenvalue sweep rebuilds the System for every point (about a second each on IEEE 14) and takes up to 200 points, with no cancel short of the job machinery. A lower cap or a progress stream may be wanted before it gets a UI.
- A continuation run to a target past the nose ends through refused steps, so ANDES logs "CPF failed" into the message log while the result says it ended at the nose.
- After `tds/init`, a power flow is refused with a message that names the eigenvalue analysis.
- `pandas` is imported by the server process on the first external-results request and is a dependency only through ANDES. Declaring it directly is a packaging decision for Phase 8.
- The worker ignores arguments of an op it does not know; whether to refuse them is open.
- None of the new routes has a web surface yet except the save format; the web units for the power flow method, the integrators, the CPF options and the state estimation options are in progress, and the routes without one are listed as deferred in `docs/gui-parity-ledger.md` with the reason.

## Deferred: the pandapower bridge

ANDES can convert a System to a pandapower network (`andes.interop.pandapower`). pandapower is not a TENSA dependency and `AGENTS.md` says it must not become one; it is not installed here, so no candidate could be run. If it is wanted, it would be an optional extra with a route that answers 409 when the package is missing, tested in a CI job that installs it.

## Findings in ANDES 2.0.0 that may be worth reporting upstream

Not filed; listed for the project owner to decide.

1. `EIG.sweep` does not recompute after the first value (`TDS.init()` returns early once initialised).
2. A failed `NK` power flow raises `IndexError` from `mis[-2]`, and SciPy's `NoConvergence` is not caught; `newton_krylov` is called with `verbose=True` whatever the log level.
3. `system2mpc` keeps only the last PQ or Shunt of a bus, ignores `u`, and fails on text bus idx and on a System before setup.
4. `CPF` with a numeric `stop_at` past the nose continues down the lower branch to negative load levels.
5. A PSS/E two-winding transformer's ratio is read as `WINDV1` alone; `WINDV2` is ignored unless `CW` is 2 (decision 27).
