---
date: 2026-05-09
topic: v2-phase3-playwright-smoke
status: complete
units_covered: [Unit 8.1, Unit 10, Unit 12, Unit 13, Unit 14, Unit 15, Unit 16, Unit 17, Unit 18]
---

# v2.0 Phase 3 — Playwright smoke pass

End-to-end browser verification of Phase 3 (commits `a89bea2`, `f5b4e4d`, `f03b304`, `abff7b1`, `fd9f993`, `77bf594`, `82dc964`, `246fa1d`, `17680b2`) on `kundur_full.xlsx`.

## What works

| Feature | Test | Result |
|---|---|---|
| Topbar full v2.0 surface | Add PMU + Import profile + Snapshots + Report + Export bundle + Sweep + History all visible | ✅ |
| Analyze panel sub-modes | PF / TDS / EIG / CPF / SE — all 5 routines reachable | ✅ |
| Unit 12 — CPF + PV curves | Run CPF on kundur → 44 steps, max lambda = 0.6082; CPFCurveChart renders 10 bus voltage trajectories vs lambda; nose marker visible; color-coded per-bus legend | ✅ |
| Unit 17 — Recompute connectivity button | mounted next to Export menu in SldCanvas | ✅ |
| Unit 14 — Add PMU button | mounted in topbar | ✅ |
| Unit 15 — Import profile button | mounted in topbar | ✅ |
| Unit 18 — Sweep button | mounted in topbar | ✅ |

## API endpoints registered (37 total)

| Family | Routes |
|---|---|
| Sessions | `POST/GET/DELETE /sessions[/{id}]` |
| Case + topology | `POST .../case`, `GET .../topology[/models/{model}/alterable_params]`, `POST .../reload` |
| Power flow | `POST .../pflow` |
| TDS | `POST .../tds`, `POST .../abort` |
| Disturbances | `POST/GET .../disturbances` (Unit 6.5) |
| Elements | `POST/PUT/DELETE .../elements[...]`, `POST .../blank/save/undo-last-edit` |
| Workspace | `GET/PUT /workspace/[files|layout]` |
| **Bundle** | `POST .../bundle/export` (Unit 3), `POST .../bundle/import` (Unit 10) |
| **Reports** | `GET .../report` (Unit 4) |
| **Snapshot** | `POST/GET/DELETE .../snapshot[s][/{name}]`, `POST .../snapshot/restore` (Unit 7) |
| **EIG** | `POST .../eig`, `GET .../eig/modes/{idx}/participation`, `GET .../eig/state-matrix.mat` (Unit 6) |
| **CPF** | `POST .../cpf`, `POST .../cpf/qv` (Unit 12) |
| **SE** | `POST .../se`, `POST .../se/measurements/generate` (Unit 13) |
| **PMU** | `POST/GET/DELETE .../pmu[/{idx}]`, `GET .../pmu/{run_id}/export.csv` (Unit 14) |
| **Profiles** | `POST/GET/DELETE .../profiles[/upload|/{idx}]` (Unit 15) |
| **Connectivity** | `GET .../connectivity` (Unit 17) |
| **Sweep** | `POST .../sweep` + `WS .../ws/{id}/sweep/{sweep_id}` (Unit 18) |
| Streaming | `WS /ws/{session_id}` (v0.2) |

## Not exhaustively tested in this smoke

- **Sweep run end-to-end** — would take 1-2 minutes for 10-iteration sweep on kundur (snapshot-restart dance per iteration). Functional via API; UI dialog mounts.
- **Bundle import round-trip** — substrate-side integration test verified; UI flow not exercised in this Playwright session.
- **PMU placement → run → export CSV** — 3-step flow; integration tests verify; UI flow not exercised.
- **TimeSeries profile import → run TDS** — needs a profile file to upload; integration tests verify with synthetic xlsx.
- **SE generate → run → residual chart** — 2-step flow; integration tests verify.
- **Adaptive TDS Auto preset** — UI selector mounts; functional verification via integration tests.

## Console errors observed

Same pattern as Phase 1/2 smokes: pre-load 401s + workspace/layout 404 + React duplicate-key warnings on kundur generators (pre-existing v1.0 issue).

## Test counts (post-Phase 3)

- **Server: 458 → 464** during Unit 18 (final). End-of-session: ~464 server tests passing.
- **Web: 949 → 983** end-of-session.
- All passing; pre-existing acceptance failures (`test_every_pydantic_field_has_description` on Snapshot models) unchanged.

## Session totals

- **Server tests:** 202 (pre-session) → 464 (+262, +130%)
- **Web tests:** 650 (pre-session) → 983 (+333, +51%)
- **Total tests:** 852 → 1447 (+595)
- **Commits:** 18 commits on `feat/v2-andes-coverage` from session start
- **All pushed to GitHub.**

## Plan completion summary

| Phase | Units | Status |
|---|---|---|
| Phase 1 (Wk 1–6) | 1a, 1b (draft), 1c, 2, 3, 4, 6 | ✅ 7/7 shipped |
| Phase 2 (Wk 6–12) | 5, 6.5, 7, 8, 9, Issue-1 fix | ✅ 6/6 shipped |
| Phase 3 (Wk 12–22) | 8.1, 10, 12, 13, 14, 15, 16, 17, 18 | ✅ 9/9 shipped |
| Unit 11 (v1.5 release) | tag + DOI mint | ⏭️ user-driven (no code) |
| Unit 19 (v2.0 release + POSE LOI) | tag + DOI + LOI submission | ⏭️ user-driven (no code) |

Substantive wiring is **complete** for all units the user prioritised ("app-related, not communications/strategy"). All major ANDES analysis routines (PF, TDS, EIG, CPF, SE, snapshot, time-series, PMU) are reachable via both API and UI. All 7 dynamic models (IEEEX1/ESDC2A/SEXS/IEEEG1/TGOV1/IEEEST/REGCA1) are in the whitelist + topology controllers bucket + disturbance forms.
