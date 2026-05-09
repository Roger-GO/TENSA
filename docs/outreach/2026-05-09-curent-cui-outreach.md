---
date: 2026-05-09
recipient: Hantao Cui (UTK CURENT, ANDES creator/maintainer)
status: draft (not yet sent)
purpose: Initiate CURENT relationship for v2.0 plan KTD-3 branch decision (Wk 4)
---

# CURENT outreach — initial email (draft)

## Recipient

- **Hantao Cui** — UTK / CURENT, ANDES creator and primary maintainer
- Email: (look up at `https://hantao-cui.github.io/` or via `https://github.com/cuihantao`)
- Optional CC: **Fangxing "Fran" Li** (UTK, NSF POSE-friendly PI; possible co-PI per community-track Wk 5 memo)

## Subject

> ANDES App — open-source web GUI for ANDES research (seeking your input + possible collaboration)

## Body (draft — review/personalize before sending)

> Dear Prof. Cui,
>
> I'm writing because I've spent the past several months building an open-source web GUI on top of ANDES, and the project has reached a point where your feedback — and ideally your endorsement or collaboration — would significantly shape its trajectory.
>
> The tool, **ANDES App**, sits as a thin substrate-first layer on top of ANDES's Python API: FastAPI backend running per-session worker subprocesses against `andes.System`, with a React UI rendering the single-line diagram, streaming time-domain results over WebSocket via Apache Arrow IPC, and surfacing a disturbance editor + animated SLD overlays during TDS runs. v1.0 (load + PF + SLD + disturbance + TDS) shipped recently; v2.0 wires the full ANDES analysis surface — EIG, CPF, SE, snapshots, full exciter/governor/PSS/renewable model library, time-series profiles, multi-run overlay, reproducibility bundles.
>
> Working demo (loopback-only, ~30 sec to install): **\[INSERT GITHUB REPO LINK\]**
> Quick screen-recording walkthrough on IEEE 39 + a Bus-16 fault: **\[INSERT VIDEO LINK\]**
>
> I'm writing now because I'm preparing a JOSS paper submission and an NSF POSE Phase I LOI, both of which would be materially stronger with your involvement. Three specific asks, in priority order:
>
> 1. **Co-authorship on the JOSS paper.** I'd be honored to have you as a co-author. The paper's framing is the substrate-first architecture + the publication-grade reproducibility bundle (case + disturbance specs + sim params + results in a single `.zip`) + the EIG/CPF/SE wiring decisions that round out ANDES's reach into the GUI. Happy to share the draft outline before I write it.
>
> 2. **A cross-link from the upstream `andes/` README.** Even a single sentence ("a community-maintained web GUI is available at ...") would dramatically improve the tool's discoverability among the ANDES user base, who are exactly the researchers I most want to serve.
>
> 3. **Governance preference.** If you'd prefer the project live under the `CURENT/` GitHub organization rather than my personal account, I'm open to that — your call. The MIT license and substrate-first architecture make this trivial to do; what matters is which arrangement you think best serves the ANDES community long-term.
>
> A 30-min video call when convenient would be ideal — I can demo the tool live, walk through the v2.0 plan, and answer any questions about the architecture. Failing that, this email + the demo video should give you enough context to react.
>
> The plan timeline is built around a Wk-4 decision point (early June 2026) on this collaboration question, so any signal — even a "received, will think about it" — is useful.
>
> Thank you for ANDES itself. Building on top of it has been a pleasure; the API is far more amenable to GUI integration than most simulation libraries I've worked with.
>
> Best,
> \[YOUR NAME\]
> \[YOUR AFFILIATION (VAP institution)\]
> \[YOUR PERSONAL SITE / GOOGLE SCHOLAR\]

## Pre-send checklist

- [ ] Replace `[INSERT GITHUB REPO LINK]` with the public repo URL (push the OSS branch first if not yet public)
- [ ] Replace `[INSERT VIDEO LINK]` with a 3–5 min screen recording (use the v1.0 IEEE 39 + Bus-16-fault demo from prior session screenshots as the basis)
- [ ] Replace `[YOUR NAME]` / `[YOUR AFFILIATION]` / `[YOUR PERSONAL SITE / GOOGLE SCHOLAR]`
- [ ] Personalize one sentence based on a recent CURENT publication or GitHub activity (signals you've actually read their work)
- [ ] CC Fangxing Li if pursuing the co-PI angle for NSF POSE
- [ ] Save sent-version to `docs/outreach/2026-05-09-curent-cui-outreach-sent.md` after sending

## KTD-3 branch tracking

Per plan KTD-3, four branches at Wk 4 (with the doc-review P1 ADV-A04 addition):
- **(A)** Yes, co-author + cross-link → joint JOSS paper, "canonical GUI" framing stays
- **(B)** Yes, but project should live under `CURENT/` org → evaluate governance dilution vs. discoverability win
- **(C)** No / explicit decline → reframe success to "actively-maintained, JOSS-published, frequently-cited" and proceed independently
- **(D)** Ambiguous / no definitive response by Wk 4 → continue solo on JOSS draft AND continue outreach (call request, conference meeting, GitHub PR to ANDES README); re-evaluate at Wk 8

Track Cui's response (or non-response) in this file. Update branch determination by Wk 4.
