# ANDES_VERSIONS.md

Phase A pins ANDES to `>=2.0,<3.0`. The substrate depends on **seven API contracts** that ANDES does not formally declare as public API — they are documented here so that an ANDES upgrade can be reviewed against this matrix before it lands.

## The seven API contracts

| # | Contract | Where the substrate uses it | Failure mode if it changes |
|---|---|---|---|
| 1 | `andes.System.models` introspection — enumeration of all model classes (Bus, Line, GENROU, etc.) with their `idx` lists | `core/wrapper.topology_snapshot()` to build the topology summary | Topology endpoint missing or duplicating elements |
| 2 | `Fault`, `Toggle`, `Alter` model param shapes — kwargs accepted by `ss.add('Fault', ...)`, `ss.add('Toggle', ...)`, `ss.add('Alter', ...)` | `core/disturbance.py` translates substrate `DisturbanceDef` payloads to these kwargs | `DisturbanceDef` schema breaks on disturbance creation |
| 3 | `TDS.callpert` per-step hook — assigning a callable runs it once per integration step | `core/wrapper.run_tds()` and `core/stream.py` for streaming + abort polling | TDS streaming silently degrades or hangs |
| 4 | `dae.ts` time-series structure — `dae.ts.x`, `dae.ts.y`, `dae.ts.t` arrays grow during TDS | `core/stream.py` reads from these for state-variable snapshots | Streaming returns wrong column shape or no data |
| 5 | `andes.load(path, addfile=..., setup=False)` semantics — load without committing setup so disturbances can be added | `core/wrapper.load_case()` and `reload_case()` | `add_disturbance` always raises post-setup; v0.1 disturbance flow broken |
| 6 | **`PFlow.run()` and `TDS.run()` require an explicit prior `ss.setup()` call.** Verified empirically against ANDES 2.0.0: `PFlow.run` on a non-setup System raises `IndexError` because `dae` has no allocated address space. ANDES does NOT auto-call setup from these routines. The wrapper calls `ss.setup()` first if `not ss.is_setup`. | `core/wrapper.run_pflow()`, `run_tds()` | If a future ANDES version starts auto-calling setup, the wrapper's explicit `ss.setup()` call becomes a no-op-with-warning and we must handle that case rather than treating "second setup returned False" as a failure. |
| 7 | `sys.audit("open", ...)` event coverage — Python-level open() calls from ANDES are visible to the audit hook | `core/wrapper` --strict-fs best-effort logging of secondary file reads | --strict-fs misses reads (caveat already documented in the trust model — C-extension reads are not caught even today) |

## Verification matrix

| ANDES version | Verified? | Curl walkthrough green? | Notes |
|---|---|---|---|
| 2.0.0 | Source-grounded during planning | Pending Unit 8 | Used during plan deepening; `andes/system/facade.py:362-407` confirms `add()` rejects post-setup; `andes/routines/tds.py:446-456` confirms `callpert` per-step invocation |

Update this table as the CI matrix expands.

## Upgrade procedure

1. Bump the version range in `pyproject.toml` deliberately (never automatic).
2. Re-run the curl walkthrough (`pytest -m acceptance`) on a fresh venv with the new ANDES.
3. For each row in "The seven API contracts," verify the contract still holds. Add a row to the verification matrix.
4. If any contract changes, update the wrapper before bumping the production pin and add a regression test in `tests/integration/`.
