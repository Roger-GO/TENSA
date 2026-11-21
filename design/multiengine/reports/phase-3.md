# Phase 3 report: the engine seam

Date: 2026-11-20. Scope: `spec.md` sections 4, 7 and 9, for ANDES only. No behaviour of an ANDES session changes; every addition is a new field, route or module.

## What exists now

| Piece | Where | What it does |
|---|---|---|
| Engines | `server/src/tensa/engines/` | `ops.py`: which worker ops each engine answers, as data. `base.py`: `EngineRuntime`, the handler table a worker loads by name. `registry.py`: name to runtime, and why an engine is not available. `capabilities.py`: what `GET /engines` reports. |
| Worker | `server/src/tensa/core/worker.py` | Takes the engine name at spawn, loads its runtime, warms up only it. The existing handlers are the ANDES runtime as they stood. An op another engine has is refused with `EngineUnsupportedError`; an op no engine has is still "unknown op". |
| Sessions | `core/session/`, `api/routes/sessions.py` | `POST /sessions` takes an optional `engine` (default `andes`); a session keeps it and reports it. An engine this build cannot start answers 409 before anything is spawned. |
| `GET /engines` | `api/routes/engines.py` | `andes` available with its version, formats, routines and ops; `sienna` declared and not available, with the reason. |
| Identity reader | `engines/identity.py` | Reads bus numbers, branch ends and circuits, device buses and ids, area slack buses and block counts from a PSS/E RAW (revisions 32 to 34) or MATPOWER file, without an engine. |
| Keys | `engines/keys.py`, `engines/andes/keys.py` | The key vocabulary and the key book; assignment for a loaded ANDES System, with ids from the file's identity where ANDES dropped them, and dynamic models named by generating unit and role. |
| Keys in the API | wrapper, `api/routes/keys.py` | `key` on every topology entry, a `keys` lookup on power flow results, `GET /sessions/{id}/keys`, `has_dynamics` on the topology. Keys survive reload, undo, redo and delete; a file changed on disk is keyed afresh. |
| Web client | `web/src/` | The session store holds the engine and asks for it again on recovery; `useEngines`; the engines list mirrored into the store; `useRunReadiness` refuses a routine the engine lacks, with the reason. |

## Evidence

| Check | Result |
|---|---|
| Server unit suite on this PC | 3819 passed, 89 skipped (3759 at baseline; 60 new tests) |
| Acceptance tests that run on Windows (OpenAPI descriptions, alterable params, abort, TDS streaming) | 31 passed |
| Smoke test (real server, worker, power flow, time-domain run) | passed |
| Keys, cases, power flow, topology and session-replay API tests | 187 passed |
| `ruff`, `mypy --strict` | pass (the two Windows-only type errors of the baseline remain) |
| GitHub CI, Linux, macOS, Windows, with acceptance and web end-to-end | green on `2e81c78d` (seam, identity), `1901e79e` (keys), `3261bbcc` (keys in the API) |
| Identity reader: four independent implementations on 22 case files, up to 2224 buses | identical on every field (one differed on one field against the spec and was not taken) |
| Key assignment: four independent implementations on 20 cases, up to 6561 elements | identical key for every element |
| Key assignment on PSS/E cases | every line, transformer and load keyed from the file; no problem notes |

## What went wrong, and what changed because of it

1. **CI failed once.** The Linux acceptance job requires every route to document a 4xx or be on a list of input-free routes; `GET /engines` was on neither. The acceptance tests that run on Windows are now part of the local gate before any API push (decision 18).
2. **A literal default broke the web types.** `has_dynamics: bool = False` made the generated TypeScript field required and broke 106 typed fixtures. Caught locally, before any push that included it. Added response fields now use a null default or a default factory, and the web types are regenerated and type-checked with every schema change (decision 20).
3. **The first run of the web unit gave the workers no real feedback.** The check commands went through `pnpm exec`, which tried to reinstall dependencies in the isolated copies and failed. The checks now call the tools' launchers directly.
4. **Pinned-shape tests stop unattended workers.** Tests that pin the worker's argument list, the session descriptor, and the method lists of the session manager and the wrapper each stopped a candidate that was otherwise right. Workers are not allowed to edit tests they were not given, and they did not. The architect made those four one-line updates (decision 17).
5. **Worker candidates that passed their checks and were still wrong.** One plumbing candidate rewrote `wrapper/__init__.py`, removing 178 lines it had no reason to touch. One web candidate created a second query client beside the app's, so its gate could never have fired from the command menus. Both were found by reading the diff, not by a failing check, and were discarded.
6. **Spec gaps found by running on real cases.** Position-based matching of lines failed for MATPOWER files; three-winding transformers and several devices of one model on a unit needed rules. All three are fixed (decision 19).

## Left open

- The kind in a branch key depends on where it was decided (decision 22).
- `key` is filled on the topology and on power flow results. Entries returned by add, edit and delete, and the other results that hold an idx (line flow ends, controller results, case events, edit steps), get their lookup when Phase 5 and 6 need them.
- Loading a case into an existing session while keeping the session's engine through a crash is covered by the store; the recovery path with a non-default engine is first exercised when Sienna exists (Phase 4).
- The worker module still imports ANDES-linked modules at import time, so a Sienna worker will load ANDES too (accepted in the specification).
