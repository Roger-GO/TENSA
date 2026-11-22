# Phase 8 report: release

A Sienna session can now be edited through the same element routes an ANDES session uses, snapshots and bundles record the engine that wrote them and are refused by another, both engines answer the case document of spec section 5, the MCP tools take an engine and gain the comparison and editing tools, the `sienna` extra and `tensa warm-cache --engine sienna` install the Julia environment, CI runs the Sienna tests on Linux with Julia 1.13.4 and no skip allowed, and the documentation describes the two engines.

## What exists now

| Piece | Where | What it does |
|---|---|---|
| Editing under Sienna | `engines/sienna/edit_log.py`, `apply_edits_json` in the Julia module | Loads (PQ: `p0`, `q0`, `u`), generators (PV or Slack: `p0`, `v0`, `u`), lines and transformers (Line: `u`), shunts (Shunt: `g`, `b`, `u`), one param per edit; a PQ or a Shunt can be added on a bus and a load or a shunt deleted, with undo and redo. The System is always the case file with the whole neutral log applied in Julia; an edit the System refuses is a 422 that leaves the log as it was. A case load starts a new log; a reload keeps it. A PV bus whose generators are all out of service becomes PQ. `GET /engines` says `editing` is true for Sienna, with the fields and kinds in `routine_options.edit`. |
| Engine in snapshots and bundles | commit 14569d74 | Snapshots and bundles record the engine that wrote them; another engine's session refuses to restore or import one with a 409 (a bundle's problem carries the code `engine-mismatch`; the Sienna engine has no snapshot or bundle op, so the refusal is met by an ANDES session given a file another engine wrote). |
| Case document route | `GET /sessions/{id}/case/neutral`, `engines/case_doc.py` | The loaded case as the engine-neutral document of spec section 5 from either engine: buses, lines, transformers, generators, loads, shunts, the dynamic models of each unit (their parameter values are a later unit, and the document's notes say so) and the case's own events, under the session's keys. Bases are stated, never implied: the ANDES builder reads what the case gave (`vin`), not what `setup()` converted, so a transformer keeps its own rating (`rate_mva` = its Sn) and rated voltages; the Sienna builder holds transformer impedances on the system base and says so. |
| MCP tools | commit 55e56942, `docs/agents.md` | `create_session` takes an engine (no body when none is given, so the call is unchanged for ANDES); new tools `list_engines`, `get_keys`, `network_matrix`, `run_dispatch`, `convert_result`, `compare_results`, and the element editing tools (`add_element`, `edit_element` with the params the route takes, `delete_element`, `undo_last_edit`, `redo_edit`). `load_case` gains `on_unsupported`, `run_pflow` `method` and `run_tds` `load_model`, each sent only when given. Every tool's description says which engines have it; a tool the session's engine lacks comes back with the API's 409, whose message names the engines that have it. |
| The `sienna` extra and warm-cache | commit 14c1cf41 | `tensa warm-cache --engine sienna` copies the Manifest the engine was verified with into the project folder, has Julia install and precompile it (the first time this fetches the packages of the Manifest), checks that the engine's Julia module loads there, and writes a stamp of the Manifest. `GET /engines` reports Sienna as not available, with what to run, until a setup made by this version's Manifest has finished; a failed or half-done setup leaves no stamp. `tensa serve` never starts a setup on its own. The Julia must be the minor version the Manifest was resolved for (1.13), unless `--allow-julia-mismatch`. The `sienna` extra pins juliacall to the release whose PythonCall the Manifest holds, and a test keeps the two together. The built sdist and wheel are checked for the Manifest, the Project file and the Julia module. |
| CI with Julia | commit 846742dc | A job that installs Julia 1.13.4, sets up the environment with `tensa warm-cache --engine sienna`, and runs the Julia suites and the Python tests marked `sienna` with no skip allowed. |
| Failed tests as annotations | commits efb35ce5, fc6476da, `scripts/junit_annotations.py` | A job's log cannot be read without signing in, but its annotations can. The server test steps write JUnit reports, and after a failure each failed test is written as an error annotation with its assertion and the end of its traceback (the first ten, and the names of the rest). `runtests_dyn.jl` checks that a hook written in Python stops a run, which needs PythonCall to load; the step hands `JULIA_PYTHONCALL_EXE` the job's Python, with no conda environment of its own. The acceptance job writes its failed tests as annotations too. |
| Docs and AGENTS.md | commits 9318197e (docs) and cf6f8b0e (AGENTS.md, contract 15), `docs/engines.md`, `docs/install.md`, `docs/troubleshooting.md`, `docs/agents.md` | `docs/engines.md` is the page a user reads to use the two engines: naming an engine, what each reads and runs (the Sienna-only routes included), the refusal of an op an engine lacks, keys, comparing the engines through `/results/convert`, `/compare` and `/studies`, fidelity and the known-difference register, the measured agreement with the case each number belongs to, and the limits a user meets. `install.md` says what the Sienna environment holds and the first-use delay; `troubleshooting.md` gains the Sienna section: each reason `GET /engines` gives for the engine being unavailable, a failed warm-cache, the first-request delay, and dispatch on a PSS/E case. AGENTS.md is rewritten for two engines, with ANDES contract 15. |
| Case document field docs | commit 48325d7a | Every field of the case document described, as the OpenAPI check of the acceptance suite asks. |
| First-load budget | commit cd2841b3 | The first load stood at 499.6 kB of its 500 kB limit; it is 479.3 kB now. The App root's frame-overlay hook moves to `sld/frameOverlay.ts`, the Components palette is fetched the first time its tab is shown, and Save parameter edits as case is fetched on its first open. `codeSplitting.test.ts` holds the three modules out of the entry chunk. |

## Evidence

- The case document: tests hold each engine's document to kundur.raw's own numbers and the two engines' documents to each other, from real sessions (commit 97f5246e).
- Editing under Sienna: a refused edit is a 422 naming the System's reasons.
- Snapshots and bundles: another engine's session refuses them with a 409 (code `engine-mismatch` on a bundle).
- CI: server CI on 9318197e failed on one renamed Starlette status constant from the ext.sienna commit (72d2b585), fixed in 85376209.
- First load of the web client: 499.6 kB of the 500 kB limit before, 479.3 kB after (commit cd2841b3).
- The warm-cache install: about 0.8 GB of unpacked sources and binaries and 1.1 GB on disk, measured before PowerSimulations, HiGHS and Ipopt joined the environment (34 more packages; the Manifest holds 253).

## What went wrong, and what changed because of it

- **Worker candidates of the MCP tools invented request shapes and a recovery field the API does not have.** The landed tools take the engine as the routes do: `create_session(engine)`, `load_case(on_unsupported)`, `run_pflow(method)`, `run_tds(load_model)`, `edit_element(params)`.
- **The engine stamp loosened snapshot names it did not need to.** 14569d74 made the listing, restore and delete of a snapshot named like a Windows device (`aux`, `con.v2`, `snap.`) accept it on every platform. On Windows such a file is not listed again, because restore and delete refuse it, which `tests/unit/test_snapshot.py` holds on Linux and macOS; the one integration test that holds the exemption where it is on is skipped on Windows (commit 22b3955a).
- **Server CI failed on a renamed Starlette status constant** from the ext.sienna commit (72d2b585), found on 9318197e and fixed in 85376209.
- **The first load of the web client stood at 499.6 kB of its 500 kB limit.** The frame-overlay hook, the Components palette and the save-as dialog now load late, and `codeSplitting.test.ts` holds the three modules out of the entry chunk; the first load is 479.3 kB (commit cd2841b3).
- **A job's log cannot be read without signing in.** The server and acceptance test steps now write JUnit reports and each failed test becomes an error annotation; the Sienna Julia tests get the job's Python for their hook check so the no-skip rule holds (commits efb35ce5, fc6476da).

## Review

A review of the phase by a second model (Fable), read-only on 58c2260f, ran the phase's unit tests (186) and read the rest. What it found, and what was done:

| Finding | Disposition |
|---|---|
| A file element of a MATPOWER case could take another key after an add, a delete and an undo on its bus (`load:7-1` came back as `load:7-3`), against spec section 13 | Fixed in 8d010081: elements the session added stay out of the matching with the file's ids |
| A Sienna topology never named what undo or redo would act on (`undo` and `redo` were always null) | Fixed in bc25afa8, in the ANDES engine's `EditStep` shape |
| The Sienna CI job's path filters missed files that hold tests marked `sienna` and every change to the API or the session manager, so such a change ran only the server workflow, where every Sienna test skips | Fixed in bc25afa8 (the job runs on any change under `server/src` or the integration tests), with a test that holds every such file under a filter |
| The setup check loaded `TensaSienna.jl` only, so a stamp could be written where the dynamics or operations modules fail to load | Fixed in bc25afa8 (all four modules) |
| `POST /reload` keeps a Sienna session's edits and drops an ANDES session's | Recorded as decision 40; the MCP tool says so |
| MCP docstrings: `add_element` said it answers the topology, `run_dispatch` omitted `ac` | Fixed in bc25afa8 |
| Comments promised a `/case-document` route that landed as `/case/neutral` and cannot open a case | Fixed in bc25afa8; decision 41 |
| The report credited 9318197e with AGENTS.md and contract 15, named a code `engine_mismatch` that does not exist, gave the warm-cache size as a download, and dated the status-constant failure to the wrong commit; `docs/engines.md` said `tensa serve` starts the setup | Corrected above and in bc25afa8 |
| Spec departures without a decision: no system image and one environment (spec 9), a case document that cannot open a case (spec 5) | Decisions 41 and 42 |
| The stamp binds the Manifest only: a later change of Julia or depot is not seen until a session starts | Open point |

## Open points

- The worker-died message still says "ANDES operation" for a Sienna worker.
- The first request of a Sienna session takes 56 to 84 s (case load) and 40 to 47 s (power flow) on a Windows laptop.
- `GET /engines` says `editing` is true for Sienna, and the web client's element forms are built on ANDES model parameters: a Sienna session refuses a field it does not take with a 422 that names the fields it does take (`routine_options.edit`), but the forms do not yet offer only those.
- The pull request to `main` removes the `multiengine` push trigger from the workflows (decision 14).
- The Sienna setup stamp binds the Manifest only: a different Julia or depot after setup is reported available and fails or recompiles at the first session.
- The case document route answers the dynamic models of each unit without their parameter values; the values are a later unit, and the document's notes say so (commit 97f5246e).
