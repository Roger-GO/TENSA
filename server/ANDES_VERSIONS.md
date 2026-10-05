# ANDES_VERSIONS.md

Phase A pins ANDES to `>=2.0,<3.0`. The substrate depends on **nine API contracts** that ANDES does not formally declare as public API — they are documented here so that an ANDES upgrade can be reviewed against this matrix before it lands.

## The nine API contracts

| # | Contract | Where the substrate uses it | Failure mode if it changes |
|---|---|---|---|
| 1 | `andes.System.models` introspection — enumeration of all model classes (Bus, Line, GENROU, etc.) with their `idx` lists | `core/wrapper.topology_snapshot()` to build the topology summary | Topology endpoint missing or duplicating elements |
| 2 | `Fault`, `Toggle`, `Alter` model param shapes — kwargs accepted by `ss.add('Fault', ...)`, `ss.add('Toggle', ...)`, `ss.add('Alter', ...)` | `core/disturbance.py` translates substrate `DisturbanceDef` payloads to these kwargs | `DisturbanceDef` schema breaks on disturbance creation |
| 3 | `TDS.callpert` per-step hook — assigning a callable runs it once per integration step | `core/wrapper.run_tds()` and `core/stream.py` for streaming + abort polling | TDS streaming silently degrades or hangs |
| 4 | `dae.ts` time-series structure — `dae.ts.x`, `dae.ts.y`, `dae.ts.t` arrays grow during TDS | `core/stream.py` reads from these for state-variable snapshots | Streaming returns wrong column shape or no data |
| 5 | `andes.load(path, addfile=..., setup=False)` semantics — load without committing setup so disturbances can be added | `core/wrapper.load_case()` and `reload_case()` | `add_disturbance` always raises post-setup; v0.1 disturbance flow broken |
| 6 | **`PFlow.run()` and `TDS.run()` require an explicit prior `ss.setup()` call.** Verified empirically against ANDES 2.0.0: `PFlow.run` on a non-setup System raises `IndexError` because `dae` has no allocated address space. ANDES does NOT auto-call setup from these routines. The wrapper calls `ss.setup()` first if `not ss.is_setup`. | `core/wrapper.run_pflow()`, `run_tds()` | If a future ANDES version starts auto-calling setup, the wrapper's explicit `ss.setup()` call becomes a no-op-with-warning and we must handle that case rather than treating "second setup returned False" as a failure. |
| 7 | `sys.audit("open", ...)` event coverage — Python-level open() calls from ANDES are visible to the audit hook | `core/wrapper` --strict-fs best-effort logging of secondary file reads | --strict-fs misses reads (caveat already documented in the trust model — C-extension reads are not caught even today) |
| 8 | **Power-flow settings live on the System, not in `config`, once it is built.** `PFlow.config.tol` and `max_iter` and `Bus.config.flat_start` are read while the solver runs. `PV.config.pv2pq` is not: the `PV` and `Slack` models copy it into their `qlim` `SortedLimiter` (`enable`) when they are constructed, so writing the config of a loaded System does nothing. The limiter's own `enable` is the live switch, and its flags (`zl`, `zu`, `zi`, `ql`, `qu`, `nql`, `nqu`) stay where a run leaves them, `check_var` returning early once it is off. Verified against ANDES 2.0.0. | `core/pflow_options.pflow_options_applied()`, used by `core/wrapper.run_pflow()` | A renamed or relocated limiter attribute makes `enforce_q_limits` silently do nothing (the integration tests in `tests/integration/test_pflow_options.py` fail), and a flag the limiter stops resetting would carry one run's generator limits into the next. |
| 9 | **ANDES names and places its time-domain variables itself, and drops some of them.** `dae.x_name` and `dae.y_name` hold `"<variable> <Model> <idx>"` (the model name is not repeated when a string idx already has it, and underscores in the idx become spaces) and are filled by `System.set_dae_names` only when `TDS.init()` runs; before that they are empty or hold the power-flow variables. A static device that an online dynamic model replaces (an `IdxParam` with `replaces=True`) loses its algebraic variables in `DAECompactor.compact_dae()` during `TDS.init()`; its `var.a` then points at other variables. Verified against ANDES 2.0.0. | `core/dae_vars.dae_variables()` lists the names from `System.find_models`, each model's `states`, `algebs`, `idx` and `idx_params[...].replaces`, with no setup; `core/stream._DaeReader` reads `dae.x` / `dae.y` at the position `dae.x_name` / `dae.y_name` give each name, which is the only address that is right after compaction | A changed name format or a changed rule for what is compacted makes a name the catalogue offers unreadable: its stream column is `nan` and the worker logs that it is not in `dae.x_name` or `dae.y_name`. `tests/integration/test_dae_vars.py` compares the catalogue with `dae.x_name` / `dae.y_name` of three bundled cases and one with a machine out of service, and every column with the model's own array at every step of a faulted run. |

## Verification matrix

| ANDES version | Verified? | Curl walkthrough green? | Notes |
|---|---|---|---|
| 2.0.0 | Source-grounded during planning | Pending Unit 8 | Used during plan deepening; `andes/system/facade.py:362-407` confirms `add()` rejects post-setup; `andes/routines/tds.py:446-456` confirms `callpert` per-step invocation |

Update this table as the CI matrix expands.

## Upgrade procedure

1. Bump the version range in `pyproject.toml` deliberately (never automatic).
2. Re-run the curl walkthrough (`pytest -m acceptance`) on a fresh venv with the new ANDES.
3. For each row in "The nine API contracts," verify the contract still holds. Add a row to the verification matrix.
4. If any contract changes, update the wrapper before bumping the production pin and add a regression test in `tests/integration/`.
