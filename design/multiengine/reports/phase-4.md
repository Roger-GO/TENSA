# Phase 4 report: a Sienna session that loads a case and solves its power flow

A session can now be created with `{"engine": "sienna"}`, load a PSS/E `.raw` (with or without a `.dyr`) or a MATPOWER `.m` case, answer its topology and its keys, solve the power flow and reload, through the same routes an ANDES session uses. Everything else answers 409 and names the engines that have it. Dynamics are Phase 5.

## What exists now

| Piece | Where | What it does |
|---|---|---|
| Julia module | `server/src/tensa/engines/sienna/julia/TensaSienna.jl` | `load_case`, `report_json`, `topology_json`, `pflow_json`, `versions_json` over PowerSystems 5.12.5 and PowerFlows 0.16.4. It answers JSON strings, so nothing of Julia's type system crosses the bridge. Its own tests: `server/tests/julia/runtests.jl`, 1410 tests. |
| The Julia project | `server/src/tensa/engines/sienna/envs/dyn/` | `Project.toml` and the `Manifest.toml` resolved for Julia 1.13. Shipped in the wheel. |
| Case facts | `engines/case_facts.py` | What the file says where PowerSystems' reader departs from it, read in Python: generator voltage setpoints, transformer taps, the half line charging of a branch read as a transformer, circuit ids of parallel branches, branch ratings (decisions 26, 27, 30, 31). The Julia module puts each back. |
| Keys and conversion | `engines/sienna/keys.py`, `convert.py` | The same keys an ANDES session gives the same file (`bus:7`, `branch:7-8-1`, `gen:1-1`), and the neutral topology and power flow result from the module's JSON. |
| Bridge | `engines/sienna/bridge.py` | The embedded Julia of one worker (juliacall 0.9.37): one thread, no signal handlers, offline, Julia called from the worker's main thread only (decision 32). A Julia error becomes `SiennaError` (422) with the path scrubbed. |
| State and runtime | `engines/sienna/state.py`, `runtime.py` | One session's case and the handler table of the six ops (`load_case`, `reload_case`, `topology`, `operating_point`, `run_pflow`, `list_keys`). Every path is checked against the workspace in Python before Julia sees it, because Julia's file reads are invisible to the worker's audit hook. |
| Availability | `engines/sienna/environment.py` | Why Sienna cannot start here, in order: juliacall missing, Julia not found, the project not set up, set up by another TENSA (the stamp), the module missing. `GET /engines` reports the reason. |
| Setup | `engines/sienna/setup.py`, `tensa warm-cache --engine sienna` | Copies the shipped project, instantiates and precompiles it, checks that the module loads, writes the stamp. The `sienna` extra pins juliacall. |
| CI | `.github/workflows/sienna.yml` | Installs Julia 1.13.4, runs the setup command, the Julia tests and the Python tests marked `sienna`, and fails on any skipped test. A test holds the Julia version to the Manifest's. |
| Web | engine picker in the top bar, the confirm dialog, the engine kept across a page reload (decision 33) | A session of another engine is a new session; a case opened under one engine is never replayed into another. |
| Load option | `on_unsupported` on `POST /sessions/{id}/case` | A `.dyr` with records Sienna's parser does not take is refused, naming them, or loaded without them with `"drop"` and a warning for each. An ANDES session ignores it. |

## Evidence

**Agreement with ANDES** on the same files, through the real API (`tests/integration/test_sienna_engine.py`):

| Case | V (pu) | Angle (rad) | Branch P / Q (MW / MVAr) | Generator P / Q |
|---|---|---|---|---|
| kundur | 3.4e-7 | 1.1e-6 | 6.6e-4 / 8.2e-4 | 6.5e-4 / 8.2e-4 |
| ieee39 | 2.5e-7 | 1.7e-7 | 3.3e-4 / 4.1e-3 | 1.8e-4 / 3.9e-3 |
| case14.m | 6.0e-8 | 1.2e-7 | 6.3e-5 / 6.5e-5 | 7.9e-5 / 1.2e-4 |

The key sets of the two engines are equal for buses, lines, transformers, generators, loads and shunts on each, and so are `rate_a` and `loading_pct`. At the level of the Julia module the comparison also covers ieee14, wscc9, npcc and wecc: at most 3e-6 pu and 9e-6 rad.

**Every route of a session** is swept under Sienna (`test_every_session_route_works_or_is_refused`, 63 routes): 12 work, 49 answer 409 naming the engines that have the op, 2 are exempt (a job by id). The sweep found two defects that had nothing to do with Sienna and are fixed: the four snapshot routes answered 500 on an engine refusal, and `POST /sweep` answered 202 and failed in the background.

**Life of a session**: two sessions have two workers, each with its own Julia; closing one ends its worker and removes its scratch folder; a killed Sienna worker answers as a killed ANDES one does. Asking how long a request may run showed that the idle reaper could close a session while a request of it was still running; that is fixed for every engine (a session with a request in flight is never reaped).

**Failure paths**, each held by a test: a file kind the engine does not read, a path outside the workspace, a `.dyr` with a `.m`, a file that is not a case (Julia's message, no server path), the power flow options the engine does not have (422 naming the option), a power flow that does not converge (200, `converged` false), and a load after failed ones.

**Mutation checks**: 18 planted defects in the state and runtime and 2 at the level of the API, all caught after four tests were added or repaired; the bridge, keys, conversion, ratings and setup units each had their own rounds before. The audit-hook test had been passing for the wrong reason (hooks left installed by earlier tests) and now runs in a fresh interpreter.

**CI**: the first run of the `sienna` job on GitHub passed in 11.5 minutes on a cold depot (setup 5 minutes, Julia tests 2, Python tests 3).

## Timings (Windows laptop, Julia 1.13.4)

| Step | Time |
|---|---|
| Create a session to its first reply | 2 to 5 s |
| First case load, Julia's start included | 56 to 84 s |
| First power flow | 40 to 47 s |
| Later loads and power flows | under 1 s |

The first use of each Julia function compiles it. A system image would take most of the first two rows away; it is not built yet.

## What went wrong, and what changed because of it

- **The specifications were wrong in places that only running showed.** The bridge's specification assumed error text juliacall does not produce; the ratings specification said "file order" where the module has its own; the extra's range was wrong for the Julia in use. Each was caught by the reviewer running the real thing, and the unit's tests now hold the real behaviour.
- **MATPOWER row numbers.** PowerSystems names a MATPOWER branch by its row; the first candidate numbered rows lines first and transformers after, and its test compared the function with itself. The code now reads the file's row order and the test uses a file whose first row is a transformer.
- **Candidates that passed for the wrong reason**: tests skipped where Julia was missing (decision 29: a skipped test fails a unit's checks), a `pytest-timeout` option that exists only on the development machine, a pipe into `tee` that hides a failure under GitHub's default shell.
- **First-load budget of the web client.** The engine picker and the initialisation dialog took the first load over its 500 kB limit; both dialogs load on first open now, and `vite build` is among the checks before a push.

## Open points

- **Cold start.** A minute and a half before the first power flow of a session. A system image or a warmed worker pool is the next step; the warm-up that exists is skipped when the first request arrives at once.
- **juliacall declares Julia 1.10.3 to 1.11** and prints a warning under 1.13.4, which the Manifest was resolved for and CI runs. Either the Manifest moves to 1.11 or the warning is accepted.
- **Sienna's versions** are not in `GET /engines` yet (`versions_json` exists).
- **The 409 of an op the engine lacks** names the engines in its `detail` text; the specification wants them in a `recovery` field.
- **`flat_start: false` is refused** under Sienna, as every power flow option it does not have; the UI sends it only when the user sets it.
- **The worker-died message** still says "ANDES operation" for a Sienna worker.
- **A file PowerSystems cannot read** is reported as "could not read junk.raw: nothing"; the wording is Julia's and wants a better one.
- **`audit.yml`** does not audit the `sienna` extra, and the "Pinned versions" section of `AGENTS.md` does not name the juliacall pin.
- **The job runs on Linux only.** Windows is covered by the development machine, macOS by nothing.

## Findings in the Sienna packages that may be worth reporting upstream

Offered to the maintainers only if the project's owner wants to; none is filed.

- PowerSystems' PSS/E reader: circuit ids of parallel branches are lost unless a `branch_name_formatter` is given; generator voltage setpoints are taken from the bus voltage magnitude, not the regulated setpoint; transformer taps are snapped; a branch read as a transformer loses half its line charging; a branch with no rating is given one; `.dyr` records it does not know are dropped without a word.
- PowerNetworkMatrices: the admittance matrix is `ComplexF32`.
