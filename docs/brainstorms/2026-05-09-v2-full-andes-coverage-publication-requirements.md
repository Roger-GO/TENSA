---
date: 2026-05-09
topic: v2-full-andes-coverage-publication
revised: 2026-05-09
origin: docs/brainstorms/2026-05-07-accessible-andes-power-systems-app-requirements.md
---

# v2.0 — Full ANDES Coverage + JOSS Publication

## Problem Frame

v1.0 ships (Phase A + v0.1 + v0.2). It demonstrates the wedge — load → PF → SLD → disturbance → streaming TDS — and proves the substrate-first architecture works end-to-end. But on the spectrum from "demo" to "tool researchers cite in papers," v1.0 sits closer to demo. Honest gap analysis (this session, 2026-05-09):

- **Researchers can't publish from it** — no CSV / PNG / MAT export, no run history, no multi-run comparison. Every figure still has to be re-rendered in matplotlib.
- **Most ANDES capability isn't reachable** — the substrate currently exposes ~30–40% of ANDES's analysis surface. Eigenvalue / small-signal (`ss.EIG`), continuation power flow (`ss.CPF`), state estimation (`ss.SE`), snapshot save/load, custom time-series profiles, and the full exciter / governor / PSS / renewable model library are all wired ANDES-side but invisible UI-side.
- **The model whitelist is too thin** — Toggle/Alter only accept ~9 model classes. Real research cases use IEEEX1 / ESDC2A / IEEEG1 / TGOV1 / IEEEST / SEXS / REGCA1 / etc.
- **First-touch UX hits a wall** — default fault parameters (xf=0.0001, bolted) diverge most cases; the "Run TDS" button greets new users with "numerical instability" before they see anything work.

v2.0 closes this gap. The intent is to make the ANDES App **the canonical open-source GUI for ANDES research**: every routine ANDES exposes is reachable from the UI, every result researchers need is exportable in the formats journals accept, every published paper that uses the tool can be reproduced from a single bundle.

The publication play is the durable outcome. A JOSS paper plus a Zenodo DOI plus 10+ external citations within 12 months is the citation flywheel that justifies NSF POSE / DOE grant applications, that opens conference-tutorial slots, that makes the tool a CV anchor and a hiring lever. None of that is possible from v1.0 today.

## Goals & Success Criteria

**Primary goals (must hit by month 12):**

1. **Full ANDES analysis-surface coverage in the UI** — PF, TDS, EIG, CPF, SE, snapshot, time-series profiles, all reachable through the existing substrate-first architecture. PMU and synthetic-measurement export wired through.
2. **Publication-grade artefacts** — CSV / PNG / MAT export for every plot and every state-variable trajectory. Reproducibility bundle (case + disturbances + sim params + results) as a single download.
3. **JOSS paper accepted** — submission by month 4, accepted by month 6.
4. **Zenodo DOI** minted at v2.0 release tag. Every release tagged thereafter gets a new DOI.
5. **External citations ≥ 10** in papers / preprints / theses by month 12.
6. **NSF POSE Phase I LOI submitted** by month 9; full proposal by month 12 if the LOI is encouraged.

**Secondary goals (nice if achieved by month 12):**

- 200+ GitHub stars; 50+ weekly active users (telemetry-free, inferred from issue activity + GitHub traffic + community Discord).
- Tutorial slot at IEEE PES General Meeting 2027 or NAPS 2026.
- 1+ co-authored paper using the tool with an external research group.
- Endorsement / cross-link from the upstream CURENT/andes README.

**Explicit non-goals for v2.0:**

- No Sienna / Julia / multi-backend wiring. The backend is ANDES-only. (See "Architectural commitment: backend-adapter discipline" below — this is a future-proofing note, not a v2.0 deliverable.)
- No commercial SaaS, no closed-source fork, no billing, no multi-tenant auth. Local-only; loopback + per-launch token, identical to v1.0.
- No industry-vertical features that ANDES doesn't natively support (short-circuit IEC 60909, CIM/CGMES import, N-1 contingency screening as a first-class workflow, OPF, unit commitment, market simulation).
- No visual case builder beyond what v0.1.y already shipped (add/edit/delete element forms; no drag-from-palette topology authoring).
- No formal WCAG accessibility audit; spirit-only per v1.0's R20.
- No agent / AI chat surface in the UI (substrate remains agent-ready via OpenAPI; UI does not ship a chat panel).
- No WebGL / 3-D SLD rendering; the existing SVG canvas remains.
- No multi-user real-time collaboration; trust model stays single-user, loopback + per-launch token (identical to v1.0).
- No paid tier, no closed-source code, no premium features. Everything in v2.0 is MIT-licensed OSS.

## Scope: The Wiring Backlog

Two tiers. Tier 1 is the JOSS-paper-shippable cut. Tier 2 closes the rest of the ANDES surface and earns the "full coverage" claim.

### Tier 1 — JOSS-shippable (target: month 4)

These are the features that make researchers actually publish from the tool. Without them, no one cites. With them, the JOSS paper can credibly claim "full open-source GUI for ANDES research workflows."

| # | Feature | ANDES surface | UI surface | Acceptance criterion |
|---|---|---|---|---|
| 1 | **Eigenvalue / small-signal (EIG)** with mode shapes + participation factors + damping ratios | `andes/routines/eig.py` — `EIG.run / summary / report`, `EIG.As`, `EIG.N`, `EIG.W` | New "EIG" panel in right dock; eigenvalue scatter (real / imag); participation-factor table per selected mode; damping-ratio bar chart | User loads case, runs PF, runs EIG, identifies an under-damped inter-area mode, exports the eigenvalue table as CSV (depends on #2 — the EIG panel uses the same Export menu) |
| 2 | **CSV / PNG / MAT export** | `TDSData.plot`, `--state-matrix`, ad-hoc serializers | "Export" menu on every plot panel + scrub control + EIG panel + results table | Every visible chart and every numeric table can be saved as CSV (long-form per Open Question #5; data) and PNG (figure); state-matrix exports as `.mat` for MATLAB users |
| 3 | **Snapshot save / load** | `andes/utils/snapshot.py` — `save_ss`, `load_ss` (dill-based) | Snapshot button in top bar; named snapshots persisted alongside the case; "Load snapshot" replaces the current System | User runs PF, saves a converged-operating-point snapshot, restores it, runs 5 different TDS scenarios from the same starting state without re-loading the case |
| 4 | **Full model whitelist** for Toggle/Alter/element forms | `andes/models/exciter/`, `governor/`, `pss/`, `renewable/`, `motor/`, `dynload/` (~50 classes) | Existing forms expanded; model picker widens; alterable-params endpoint already handles introspection | User loads a kundur-style case with GENROU + IEEEX1 + IEEEG1 + IEEEST and can alter the IEEEST gain parameter at t=2.0 via the disturbance editor |
| 5 | **Multi-run overlay** | (pure UI on existing run-store) | Plot panel accepts ≥ 2 runs; per-run colour + label; legend toggle; aligned time axis | User runs the same TDS with three different fault clearing times and overlays the bus-16 voltage on a single chart |
| 6 | **Run-history persistence + reproducibility bundle** | (substrate-side; ANDES is deterministic) | "History" tab in right dock; runs persisted to workspace; "Export run bundle" produces `.zip` containing case + disturbance specs + sim params + results | Bundle exported from session A imports cleanly in session B with identical reproduced results |
| 7 | **PFlow / TDS / EIG report endpoints** | `PFlow.report / summary`, `TDS.summary`, `EIG.report` | "Report" tab in right dock; pretty-printed tables; copy-as-LaTeX-table action | User generates a PFlow report and pastes the LaTeX directly into a paper |
| 8 | **Default-parameter sanity** | (config / blank-spec defaults) | `blankFaultSpec` defaults to `xf=0.05` (representative, non-bolted); first-time-user flow works on IEEE 14 / 39 / kundur out of the box | New user clicks "Add disturbance" → "Add" → "Run TDS" on IEEE 14 and sees a non-divergent voltage transient, not a numerical-instability banner |

**Tier 1 ships v1.5 (the JOSS-paper-shippable release).** Estimated 8–12 weeks solo.

### Tier 2 — Full coverage (target: month 9)

These complete the "every ANDES routine reachable through the UI" claim. Without them, the JOSS paper still ships, but the "full coverage" bullet point isn't honest.

| # | Feature | ANDES surface | UI surface | Acceptance criterion |
|---|---|---|---|---|
| 9 | **Continuation power flow + PV / QV curves** | `andes/routines/cpf.py` — `CPF.run`, `CPF.run_qv(bus)` | New "CPF" mode in run-mode toggle; PV-curve plot panel; user-selectable parameterisation | User runs CPF on IEEE 14, sees the nose curve, identifies the voltage-collapse margin |
| 10 | **State estimation** | `andes/routines/se.py`, `SE.report`, `Measurements.generate_from_pflow()` | New "SE" mode; auto-generate measurements from PF solution; residual histogram; convergence panel | User generates a synthetic measurement set, perturbs one measurement, runs SE, sees the residual flag |
| 11 | **PMU model + synthetic PMU export** | `andes/models/measurement/pmu.py` (model exists; not exposed) | PMU placement editor (pick buses); auto-add PMUs at selected buses; export PMU output as CSV at full TDS rate | User places PMUs at 5 buses, runs TDS, exports synthetic PMU CSV at sub-cycle rate |
| 12 | **Time-series load / generation profiles** | `andes/models/timeseries.py` (CSV / XLSX schedule loading) | Profile import dialog; per-device profile assignment; profile preview chart | User loads an hourly load profile from CSV, runs a quasi-static TDS through 24 hours, sees voltage trajectory |
| 13 | **Adaptive TDS integrator (QNDF)** | `andes/routines/qndf.py`, `daeint.py` | TDS config exposes "fixed" vs "adaptive" stepping; adaptive shows tolerance + max-step | User who hits numerical instability with fixed-step retries with adaptive and the run completes |
| 14 | **Connectivity / island detection** | `System.connectivity()` | "Connectivity" status badge; post-disturbance island count; SLD greys out de-energised buses | User trips a critical line, sees the disconnected island highlighted in grey on the SLD |
| 15 | **Sub-cycle (PMU-rate) sample mode** for selected buses | (substrate-side: skip decimation for chosen buses) | Per-bus "raw stream" toggle in plot panel; full TDS rate reaches the UI for those buses | User selects bus 16, sees full-rate (e.g., 1 kHz if h=1ms) frequency oscillation |
| 16 | **Sensitivity / parametric sweep harness** | (orchestrator on top of TDS + snapshot) | Sweep dialog: pick parameter, range, steps; result viewer shows family of trajectories | User sweeps fault clearing time across 50 values from 0.05 to 0.5 s, sees the critical clearing time emerge |

**Tier 2 ships v2.0 (the "full coverage" release).** Estimated additional 8–10 weeks solo.

### Out-of-scope (Tier 3+, not v2.0)

Captured here so the boundary is explicit and `/ce-plan` doesn't accidentally pull them in:

- Short-circuit (IEC 60909) — not in ANDES; would require pandapower or similar.
- N-1 contingency *as a first-class workflow* — possible to scaffold via Tier 2 sweep harness, but the polished UX is out of scope.
- HVDC / ACDC converter models beyond what ANDES already exposes.
- CIM / CGMES import — not in ANDES.
- OPF / SCOPF / unit commitment / production cost — not in ANDES.
- Code generation (`ss.prepare`) — backend-only, no UX value at v2.0.
- Visual case builder beyond v0.1.y's existing forms.
- Multi-user collaboration / SaaS / hosted deployment.
- Custom user dynamic-model authoring in the UI (researchers continue to use Python / ANDES Python API directly).

## Architectural Commitment: Backend-Adapter Discipline

**This is a future-proofing note, not a v2.0 deliverable.**

The user has flagged a possible future move (closed-source commercial fork wired to Sienna / PowerSystems.jl) — see this brainstorm session's discussion. v2.0 does **not** wire any non-ANDES backend. But v2.0 does adopt one cheap discipline that keeps that future fork option open at near-zero cost today:

The wrapper / worker / disturbance / stream modules in `server/src/andes_app/core/` shall be reorganised as the implementation of an explicit `BackendAdapter` protocol. Method signatures (`run_pflow`, `run_tds`, `run_eig`, `run_cpf`, `run_se`, `apply_disturbance`, `extract_topology`, `stream_frames`, `save_snapshot`, `restore_snapshot`) are defined as the contract; the ANDES-specific implementation is the only one that ships in v2.0.

This is a refactor, not a rewrite. The cost is one extra abstraction layer (~1–2 days of work plus discipline applied to each Tier 1 / Tier 2 feature as it lands). The benefit is that a future Sienna or pandapower adapter is a *new file*, not a substrate rewrite.

If the user later decides not to pursue any non-ANDES backend, the discipline costs almost nothing — the protocol just collapses to a single concrete class.

## Sequencing & Milestones

Right-sized for a solo founder on a VAP-affiliated runway (~12 months of available time, ~30–50% engineering bandwidth alongside other commitments).

| Wk | Milestone | Status trigger |
|---|---|---|
| 1 | `BackendAdapter` protocol scaffolded; v1.0 wrapper / worker re-expressed as the ANDES implementation | Refactor lands without regressing the current test baseline (~708 tests as of 2026-05-09) |
| 1–2 | Tier-1 #2 CSV / PNG / MAT export | First plot exports successfully |
| 1–2 | Tier-1 #8 default-parameter sanity (xf default) | New-user smoke test passes on IEEE 14 |
| 2–4 | Tier-1 #1 EIG + report + participation factors | EIG panel renders for kundur case; CSV export works |
| 3–5 | Tier-1 #4 full model whitelist | IEEEX1 / IEEEG1 / IEEEST / SEXS appear in pickers; alterable-params introspection works for each |
| 4–5 | Tier-1 #3 snapshot save / load | Round-trip preserves PF + System state |
| 5–6 | Tier-1 #5 multi-run overlay | Two runs render with distinct colours on same axes |
| 6–7 | Tier-1 #7 reports (PFlow / TDS / EIG) + LaTeX export | Tables paste cleanly into a sample paper |
| 7–8 | Tier-1 #6 run-history + reproducibility bundle | Bundle exported from session A imports cleanly in session B |
| 8 | **v1.5 release tagged. Zenodo DOI minted. JOSS paper draft started.** | All Tier 1 acceptance criteria green |
| 9 | JOSS paper submitted | Editor assigns reviewer |
| 9–11 | Tier-2 #11 PMU + synthetic measurement export | PMU CSV exports at full TDS rate |
| 11–12 | Tier-2 #14 connectivity + #13 adaptive TDS | Island count updates after line trip; QNDF mode toggles cleanly |
| 12–14 | Tier-2 #9 CPF + PV / QV curves | Nose curve renders for IEEE 14 |
| 14–16 | Tier-2 #16 sensitivity sweep harness | 50-value clearing-time sweep produces the critical-clearing-time chart |
| 16–18 | Tier-2 #10 SE + #12 time-series profiles | SE residuals visible; 24h profile run completes |
| 18 | Tier-2 #15 sub-cycle PMU-rate streaming for selected buses | Bus 16 streams full TDS rate to UI |
| 20 | **v2.0 release tagged. New Zenodo DOI. JOSS paper presumably accepted by now.** | All Tier 2 acceptance criteria green |
| 24 | NSF POSE Phase I LOI submitted | LOI receipt acknowledged |
| 36 | First citation count audit; first co-authored paper by external group; community contribution-rate baseline established | ≥ 10 cited papers, ≥ 1 external co-author |

## Publication Strategy

**JOSS submission specifics:**
- Submit at v1.5 release, not v2.0. Tier 1 alone is more than enough to clear the JOSS bar (which is "the software is useful, the documentation is competent, the API is testable").
- Co-author with at least one external party (Hantao Cui at UTK CURENT is the obvious first ask — upstream blessing converts the tool from "fork" to "canonical companion"). Co-authorship doubles the chance of acceptance and triples the citation reach.
- Paper structure: ~3 pages; intro / functionality / typical use case / acknowledgements. The JOSS template is rigid and forgiving.
- Estimated time-to-acceptance: 6–10 weeks from submission.

**Zenodo DOI specifics:**
- One-click GitHub integration. Every tagged release on GitHub becomes a Zenodo record with its own DOI.
- The README cites the DOI for the latest release; the JOSS paper cites a fixed DOI of the v1.5 release as the "version of record."
- This makes the tool citable *before* the JOSS paper lands.

**NSF POSE Phase I LOI specifics:**
- Two-page LOI; full proposal is ~15 pages if encouraged.
- Phase I = $300k for 18 months; explicitly funds *governance and growth* of existing OSS. ANDES App at v2.0 with users would be a strong fit.
- Submit alongside a co-PI (department-affiliated faculty member, or upstream CURENT lead). Strengthens the proposal materially.
- LOI hit-rate ~30–40% for solid submissions; full-proposal hit-rate ~25–35%.

## Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **Solo-maintainer burnout** as user count grows post-publication | High | Set issue-triage budget upfront (≤ 4 hr / week). Adopt CONTRIBUTING.md + good-first-issue labels early. Recruit 1–2 external maintainers from the first wave of users. |
| **Feature creep from users** ("can you add OPF / CIM / multi-backend?") | High | Public ROADMAP.md with explicit "in scope / not in scope" boundaries. Point requesters at PyPSA / pandapower / Sienna for out-of-scope needs. |
| **JOSS paper reviewer asks for features we don't have** | Medium | Co-author selection; pre-flight the paper with one ANDES-community reviewer informally before submission. |
| **CURENT relationship goes badly** (no upstream blessing) | Medium | Engage Hantao Cui early — month 1, not month 8. Be specific: "I want to make this the canonical GUI for ANDES research; happy to defer to your governance preferences." |
| **Tier 1 / Tier 2 features uncover ANDES API quirks** that block clean wiring (precedent: `ss.add()` rejects after setup, TDS streaming has no public hook) | Medium | Reserve 20% schedule contingency. For each ANDES routine being wired, do a 1-day spike before committing to the full integration. |
| **The "easy VAP role" gets less easy** (course load increases, advisor asks for help, etc.) | Medium | Communicate scope to your VAP host upfront. Have a "minimum-viable JOSS submission" cut (~Tier 1 weeks 1–6) ready in case the schedule compresses. |
| **Backend-adapter refactor adds unnecessary complexity if the Sienna fork never happens** | Low | The refactor is genuinely cheap (~1–2 days). If it never gets used, it just looks like good code hygiene. Worst case is mild over-engineering, not a blocker. |
| **Citations don't materialise** (≥ 10 by month 12 misses) | Low | Even 3–5 citations + a JOSS paper + a Zenodo DOI is enough for a credible NSF POSE LOI. The bar isn't binary. |

## Open Questions (to resolve in /ce-plan, not here)

1. **EIG output volume** — for a kundur-style 11-bus case the eigenvalue count is small; for a 300-bus dynamic case, hundreds of eigenvalues. UI strategy for filtering / pagination / focus-by-damping-ratio?
2. **Snapshot file format** — dill (ANDES's native) or a portable JSON / Arrow representation? Dill is fast and complete but version-locked to the ANDES release; portable formats survive ANDES upgrades but lose runtime state.
3. **Multi-run overlay storage** — the runs slice already keys by `run_id`, but at what point does retained-runs memory pressure require eviction? Default cap?
4. **Sweep harness execution model** — sequential (simple, slow) or parallel-via-multiple-worker-subprocesses (complex, faster)? The substrate already supports per-session workers; reuse?
5. **CSV export schema** — long-form (one row per (time, variable)) or wide-form (one column per variable)? Pick based on what the typical ANDES user pastes into pandas.
6. **Adaptive TDS UX** — expose tolerance directly, or hide behind a "fast / accurate" preset? Preset is friendlier for new users but limits power-user control.
7. **PMU placement editor** — separate from disturbance editor or unified into a single "scenario" panel?
8. **JOSS paper authorship order** — single-author from VAP affiliation, or co-author with CURENT from the start? Affects negotiation timing.

## Success Definition (single-sentence form)

By the end of month 12, the ANDES App is the canonical open-source GUI for ANDES, has a JOSS paper accepted, holds a Zenodo DOI, has been cited in ≥ 10 external papers, and has an NSF POSE Phase I LOI submitted — and the substrate's backend-adapter abstraction means a future commercial fork (Sienna, pandapower, or anything else) is a manageable engineering project rather than a substrate rewrite.
