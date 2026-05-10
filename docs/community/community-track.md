---
date: 2026-05-09
topic: community-track
status: active
owner: solo (single maintainer)
plan: docs/plans/2026-05-09-001-feat-v2-full-andes-coverage-plan.md
---

# v2.0 Community-Engagement Track

Per the v2.0 plan's KTD-11 ("Citation goal demoted; community-engagement track added"), this doc allocates **4 hours/week** of explicit community work in parallel with the engineering track. Without this, the citation flywheel won't materialize even if every implementation unit ships.

The track has three goals, in priority order:

1. **Validate funnel position** — confirm export gap is the binding adoption constraint (or surface what is)
2. **Drive design-partner adoption** — ≥1 research lab using the tool by month 9 (the Wk-by-Wk binding metric)
3. **Pre-qualify funding alternatives** — NSF POSE may not work; have backups ready by Wk 12

## Weekly Schedule (Wk 1–24)

| Wk | Engineering milestone | Community work (4 hr / week) |
|---|---|---|
| 1 | Unit 1a spike + 1b email + 1c doc | Send CURENT email (Cui). Post v1.0 demo to ANDES GitHub Discussions + Discord (if exists). Set up GitHub Sponsors page. |
| 2 | Unit 2 (export) start | Cold-email 5 ANDES-using research labs from recent IEEE PES papers (see candidate list below). Offer 30-min demo + free help loading their case. |
| 3 | Unit 2 cont. | Follow up unanswered cold emails. Schedule 1–2 demos. |
| 4 | Unit 3 (bundle export) start. **CURENT branch decision per KTD-3.** | Read NSF POSE Phase I RFA + last 2 cohorts of awardees. Draft 1-page LOI outline. |
| 5 | Unit 3 + Unit 4 (reports) | Read DOE EERE / ARPA-E PERFORM / NSF PIPP RFAs. 1-page comparative memo: which is plausible solo-PI, which needs partners. |
| 6 | **Unit 6 (EIG) — JOSS submission target.** | Write JOSS paper (3 pages). Co-author with Cui if KTD-3 branch (A); solo with substrate-first framing if (C/D). Submit to JOSS. |
| 7 | Phase 2 starts: Unit 5 + 6.5 | Demo video v1.5-MVP (5 min screen recording: load → PF → SLD → fault → TDS → EIG). Post to YouTube + LinkedIn + ANDES Discussions. |
| 8 | Unit 7 (snapshot) | Blog post on personal site: "Building a web GUI for ANDES — lessons from v1.0 to v1.5." Cross-post to relevant subreddits if any (r/electricalengineering, r/PowerEngineering). |
| 9 | Unit 8 (whitelist) | First design-partner check-in: have any of the cold-emailed labs actually used the tool? Document what they hit. |
| 10 | Unit 9 (multi-run + history) | Submit tutorial proposal to **NAPS 2026** (typically due Sept; check actual deadline). Topic: "Open-source web GUI for ANDES research workflows." |
| 11 | Unit 11 (v1.5 release) | Tag v1.5 release. Mint Zenodo DOI. Update README badges. Cross-post release announcement to ANDES Discussions. |
| 12 | Phase 3 starts: Unit 10 (bundle import) | **Co-PI commitment gate per KTD-12.** If no co-PI by EOW, demote NSF POSE; route to whichever alternative was best-fit per the Wk 5 memo. |
| 13 | Unit 12 (CPF) | Submit tutorial proposal to **IEEE PES GM 2027** (typically due Jan; check). |
| 14 | Unit 12 cont. + Unit 13 (SE) | Second design-partner check-in. Aggregate feedback into a 1-page issues-summary. Open GitHub issues from the feedback. |
| 15 | Unit 13 + Unit 14 (PMU) | Demo video v2.0-preview (focus on CPF + multi-run + EIG). |
| 16 | Unit 15 (TimeSeries) | Blog post: "What I learned wiring CPF + EIG + SE into a web GUI." |
| 17 | Unit 15 + Unit 16 (adaptive TDS) | Begin POSE / alternative full-proposal drafting. Co-author or solo per Wk 12 gate. |
| 18 | Unit 17 (connectivity) + Unit 18 (sweep) | **Co-PI re-confirmation checkpoint** (per doc-review P1 finding ADV-A06). |
| 19 | Unit 18 cont. | Solicit design-partner testimonials for the funding proposal. |
| 20 | Unit 18 cont. | Funding proposal: technical narrative + budget + biosketch. |
| 21 | Unit 18 + Unit 19 prep | Funding proposal: data management plan + facilities + letters of support. |
| 22 | **Unit 19 (v2.0 release + funding LOI).** | Tag v2.0. Mint Zenodo DOI. Submit funding LOI (POSE if Wk 12 gate passed; alternative otherwise). Conference tutorial slots confirmed. |
| 23 | Post-release stabilisation | First citation-count audit. Quote any external uses in social posts. |
| 24 | Post-release stabilisation | Plan a v2.5 brainstorm if signals indicate continued investment makes sense. |

## Design-Partner Candidate List

Cold-email targets — labs that already use ANDES per recent IEEE PES papers and GitHub activity. Goal: convert 2 of 5 into active users by Wk 9.

| # | Lab / PI | Affiliation | Why a fit |
|---|---|---|---|
| 1 | Hantao Cui (CURENT) | UTK | ANDES upstream maintainer; ideal co-author |
| 2 | Fangxing "Fran" Li | UTK | NSF POSE-friendly PI; possible co-PI |
| 3 | Daniel Tabas / Federico Milano group | UCD (Ireland) | International power-systems OSS community |
| 4 | NREL ESIF group | NREL | Hosts ANDES events; potential design partner + funding bridge |
| 5 | Anjan Bose / Anurag Srivastava group | WSU | Active in stability research using ANDES |
| 6 | (replace from issue activity) | — | Watch ANDES GitHub issues for active users; contact 2–3 |

Track responses + status in `docs/outreach/` (one file per contact).

## NSF POSE Alternative Pre-Qualification (for Wk 5 memo)

Quick-screen the four alternatives the v2.0 plan named as POSE backups. Pick by Wk 12.

### Option 1: NSF POSE Phase I (primary)
- **$/duration:** $300k / 18 months
- **Acceptance rate (recent):** ~30–40% LOI, ~25–35% full proposal (origin doc estimate; verify against recent cohorts)
- **Coalition expectation:** Multi-maintainer + multi-institution evidence preferred. Solo-PI submissions historically weaker.
- **Fit for ANDES App:** Strong on technical merit; moderate on community-evidence axis at v1.5; better at v2.0.

### Option 2: DOE EERE / SETO / Grid Modernization Initiative
- **$/duration:** Varies; topic-specific calls; $100k–$2M tiers
- **Coalition expectation:** Industry partner usually required (utility, IPP, integrator)
- **Fit:** Need to identify which active call accepts power-systems software tooling. Read recent FOAs.

### Option 3: ARPA-E PERFORM (or successor program)
- **$/duration:** Up to $5M / multi-year
- **Coalition expectation:** Heavy — typically multi-org consortium
- **Fit:** Out of reach for solo founder unless joining an existing consortium.

### Option 4: NSF PIPP (Predictive Intelligence for Pandemic Prevention) — wrong program; replace with NSF CSSI or PIPP-grid analog
- Likely candidates: **NSF CSSI** (Cyberinfrastructure for Sustained Scientific Innovation, $600k–$3M), **NSF SBIR Phase I** ($275k, 6 mo)
- **Coalition:** CSSI prefers multi-PI; SBIR is solo-friendly
- **Fit:** SBIR is the most realistic solo-founder path if commercial wedge is identified by Wk 12

### Pre-qualification action (Wk 5)
Read each program's most recent call. Identify:
1. Solo-PI eligibility
2. Required deliverables
3. Submission deadlines through 2027
4. Recent awardees in adjacent domains (power-systems software, scientific OSS)

Write a 1-page comparative memo. Decide Wk 12 fallback before the gate fires.

## Demo Video + Blog Cadence

- **v1.5-MVP video (Wk 7):** 5 min, IEEE 14 walkthrough. Title: "An open-source web GUI for ANDES — v1.5 first look."
- **v2.0-preview video (Wk 15):** 8 min, kundur_full case with EIG + multi-run + CPF.
- **v2.0 release video (Wk 22):** 10 min, full feature tour.
- **Blog posts:** Wk 8 (v1.5 lessons), Wk 16 (Phase 3 progress + design-partner stories), Wk 22 (v2.0 launch).
- **Cross-post targets:** YouTube, LinkedIn, personal site, ANDES Discussions, r/electricalengineering / r/PowerEngineering (if rule-compliant), CURENT mailing list (if exists).

## Tracking

This doc updates weekly. Status format:
- ✅ done
- 🟡 in progress
- ⛔ blocked (with reason)
- ❌ skipped (with reason)

Add a "Wk N status" table row at the top of this file each Friday.
