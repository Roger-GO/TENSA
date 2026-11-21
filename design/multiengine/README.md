# Multi-engine TENSA (ANDES + Sienna)

Work in progress on the `multiengine` branch. `main` is unchanged until the pull request.

## Goal

1. Run the same study on more than one engine and compare the results.
2. Offer what each engine can do that the others cannot: everything ANDES has, including what TENSA does not expose yet, and the three core Sienna packages (PowerSystems.jl, PowerSimulationsDynamics.jl, PowerSimulations.jl) with PowerFlows.jl and PowerNetworkMatrices.jl.
3. A neutral language for cases, studies and results that maps to each engine.

## What is here

| File | What it is |
|---|---|
| `spec.md` | The specification: neutral language, identity, capabilities, fidelity, engine interface, build order. Everything after Phase 2 builds on it. |
| `decisions.md` | Every design decision taken, with its reason, in order. |
| `reports/phase-0.md` | Environments, versions and the test baseline before any change. |
| `reports/phase-1-spike.md` | The same case in both engines: what agreed, what had to be aligned, timings, the bridge to Julia. |
| `reports/andes-gaps.md` | What ANDES 2.0.0 can do that TENSA does not expose. |
| `reports/model_matrix.md` | Every dynamic model name against ANDES, Sienna's parser and Sienna's simulator. |
| `reports/spec-review-1.md` | The first review of the specification, merged, with the verdict on each correction. |
| `reports/phase-3.md` | The engine seam: what exists, the evidence, what went wrong and what changed because of it. |
| `reports/phase-4.md` | A Sienna session that loads a case and solves its power flow: the pieces, the agreement with ANDES, timings, what went wrong, open points. |
| `reports/phase-7a.md` | The ANDES capabilities added: what each route does, what running ANDES showed, the evidence, open points, findings for upstream. |
| `spike/` | The throwaway scripts behind the spike report, kept so its numbers can be reproduced. They read paths under `%LOCALAPPDATA%\tensa-dev`. |

## Phases

| Phase | Content | State |
|---|---|---|
| 0 | Environments, baseline, inventories | done |
| 1 | Spike: both engines on one case; bridge to Julia | done |
| 2 | Specification | draft 2, reviewed once |
| 3 | Engine seam: sessions name an engine, capabilities, identity, keys, web client | done (`reports/phase-3.md`) |
| 4 | Sienna: case, topology, power flow | done (`reports/phase-4.md`); the cold start of a session is an open point |
| 5 | Sienna: dynamics, streaming, small-signal, model audits | |
| 6 | Comparison: API and UI | |
| 7 | Sienna-only capabilities (matrices, DC power flow, operations) | |
| 7A | ANDES capabilities not yet in TENSA | server side done but for the pandapower bridge, deferred (`reports/phase-7a.md`); web surfaces in progress |
| 8 | Editing under Sienna, packaging, CI with Julia, docs, pull request | |

## How the work is done

- Design, task breakdown and verification by the architect; inventories, per-module implementation, independent tests, fixes and reviews by many parallel worker-model calls that read only the source and documentation they are given.
- Nothing lands unless `ruff`, `mypy --strict` and `pytest` pass for the server and lint, type check, format check and tests pass for the web client; a claim about Sienna is checked by running Julia; a claim that engines agree is checked numerically.
- The Linux suites run in GitHub CI on every push to this branch (the push trigger added in the first commit is removed before the pull request).

Paths under `.claude/` named in the reports are local tooling and are not in the repository.
