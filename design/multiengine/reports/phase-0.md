# Phase 0 report: groundwork

Date: 2026-11-20. Branch `multiengine`, cut from `main` at `3f2181a9`, pushed to GitHub.

## Installed (all user-scope, no admin, outside OneDrive in `%LOCALAPPDATA%\tensa-dev`)

| What | Version | How |
|---|---|---|
| Git for Windows | 2.56.1 | winget, user scope |
| Python environment | 3.12.10, ANDES 2.0.0, FastAPI 0.165.0, server installed editable with `dev` and `mcp` extras | `venv` + pip |
| Extra test tool | pytest-timeout 2.4.0 (local only, not a project dependency) | pip |
| Node | 22.23.5 portable zip from nodejs.org, SHA-256 checked | the MSI needs admin |
| pnpm | 11.0.8 | npm, into the portable Node |
| Web dependencies | from the committed lockfile | `pnpm install --frozen-lockfile`, virtual store outside OneDrive |
| Julia | 1.13.4 | juliaup via winget |
| Sienna | PowerSystems 5.12.5, PowerFlows 0.16.4, PowerNetworkMatrices 0.20.0, PowerSimulationsDynamics 0.16.2, PowerSimulations 0.34.2, HydroPowerSimulations 0.15.1, StorageSystemsSimulations 0.16.0, PowerSystemCaseBuilder 2.6.1, InfrastructureSystems 3.6.3 | Julia General registry, project `sienna-env` |
| Solvers and I/O | Sundials 6.3.0, OrdinaryDiffEq 6.111.0, HiGHS 1.27.0, Ipopt 1.16.0, Arrow 2.8.1 | same |
| Python to Julia bridge | juliacall (project `sienna-jc`) | pip |

## Baseline before any change (this PC, Windows 11)

| Check | Result |
|---|---|
| `ruff check src` | pass |
| `mypy --strict src` | 2 errors, both platform: `fcntl` (`security/paths.py:211`) and `os.sched_getaffinity` (`core/sweep.py:93`) do not exist on Windows. CI type-checks on Linux. |
| `pytest -m "not acceptance" tests/unit` | 3759 passed, 89 skipped, 3 min 36 s |
| `pytest -m smoke tests/integration` | 1 passed (real server, worker, power flow, short time-domain run) |
| Full `pytest` | not usable here: the acceptance walkthrough needs a POSIX shell, and an integration test left a worker idle for 30 minutes. CI runs these on Linux. |
| `pnpm lint` | pass |
| `pnpm format:check` | pass |
| `pnpm typecheck` | 1 error: `src/components/shell/OpenCasePage.tsx(44,23)` TS7006, a callback parameter typed through the `cmdk` package. Not touched by this work; to be compared with CI's result. |
| `pnpm test` | 6816 passed, 1 failed, 3 files not loaded, in 11 min 38 s. The 3 files hit `EBUSY: resource busy or locked` reading freshly installed packages (a scanner holding the file). The failure is `AppShell.test.tsx`, "mounts the command palette when it opens", again the `cmdk` palette. Both to be compared with CI's result. |

Linux checks: the server and web workflows now run on pushes to `multiengine` (commit `d0b8d8a6`), since this PC has no WSL and installing it needs admin.

## Worker infrastructure

- `.claude/kimi/kimi.py`: batch runner for `moonshotai/kimi-k3` on MindRouter, standard library only, capped at 150 requests per minute, resumable, key read at run time from the sibling folder's `.env`.
- `.claude/kimi/kimi_fix.py`: write-run-fix loop for one file (see the spike report for its limits).
- Runs so far: 001 inventory of TENSA's ANDES coupling (44 tasks), 002 ANDES capabilities and model sheets (130 tasks), 003 TGOV1 audit (3 tasks). 177 worker calls, none failed, none truncated.

## Inventories produced

- `andes-gaps.md`: what ANDES 2.0.0 can do that TENSA does not expose.
- `reports/model_matrix.md`: every dynamic model name against ANDES, Sienna's parser and Sienna's simulator. 14 run in both, 6 more are in ANDES and only parsed by Sienna, 45 are ANDES only, 11 Sienna only, 6 parsed by Sienna but simulated by neither; 59 Sienna component types have no `.dyr` name and are reachable only in code.
- `.claude/kimi/runs/001-inventory/out/`: per-module coupling reports. 25 of 38 modules are ANDES-specific throughout, which fixes the seam at the wrapper's public surface.
