---
title: 'TENSA: an interactive web workbench for power system simulation'
tags:
  - power systems
  - dynamic simulation
  - Python
  - TypeScript
  - web application
  - AI agents
authors:
  - name: Rogelio Gracia Otalvaro
    orcid: 0009-0001-7331-1745
    corresponding: true
    affiliation: 1
affiliations:
  - name: Embry-Riddle Aeronautical University, United States
    index: 1
date: 11 July 2026
bibliography: paper.bib
---

# Summary

TENSA (Transients, Eigenvalues & Network Simulation Application) is an open-source, browser-based workbench for studying electric power grids. A user assembles a network on an interactive one-line diagram, the field's standard schematic, then runs any of five analyses from the interface: power flow, time-domain simulation, eigenvalue analysis, continuation power flow, and state estimation. Together these answer the working questions of grid studies: whether an operating point exists, how the system rides through a fault, and how far it sits from instability. Time-domain trajectories stream into the plots while the solver is still running, and a voltage overlay animates on the diagram in step (\autoref{fig:sld}). Every operation available in the interface is also exposed through a documented HTTP and WebSocket API, so the same studies can be driven by a script or by an AI agent. All numerical computation is performed by ANDES, the hybrid symbolic-numeric simulator of @cui2021andes; TENSA contributes the interactive application layer around it. TENSA is released under the GNU GPL (v3.0 or later), installs from PyPI with the interface bundled, runs entirely on the user's machine, and is developed at <https://github.com/Roger-GO/TENSA>.

![The interactive one-line diagram after a solved power flow on the WSCC 9-bus system [@anderson2003], with per-bus voltages and branch flows displayed. Busbars are tinted when a bus voltage approaches its configured limits.\label{fig:sld}](sld.png)

# Statement of need

Open-source power system simulation is dominated by script-driven workflows. That suits batch experiments, but it underserves three audiences. Students and instructors need immediate visual feedback: place a generator, run the study, watch the voltages respond. Requiring fluency in a Python API before the first simulation raises the floor of every power system analysis course built on open tools. Researchers exploring a system, rather than sweeping one, face a related cost: each what-if question means editing case files or writing orchestration code, and a long time-domain run gives no feedback until it finishes. Finally, LLM-based agents are becoming practical operators of scientific software, and they need what a script needs: a documented, machine-readable interface with observable state. Commercial desktop tools ship automation APIs, but those are proprietary and platform-bound. An open, web-native surface kept at parity with the GUI makes the same studies available to people and to programs on equal terms.

TENSA addresses the three at once because they share one requirement: a complete application layer over the solver, with interaction for people and an equivalent API for programs. Its target users are instructors and students, researchers running exploratory dynamic studies, and developers building agent-driven workflows.

# State of the field

Established open-source tools concentrate on steady-state and planning studies through code: MATPOWER [@zimmerman2011matpower], pandapower [@thurner2018pandapower], and PyPSA [@brown2018pypsa] are libraries first, with visualization as a plotting utility rather than an interactive surface. PSAT [@milano2005psat] pioneered an open graphical environment for static and dynamic analysis, though its network editor depends on the proprietary MATLAB/Simulink platform. GridCal [@gridcal] offers an open desktop GUI with a schematic editor over a scriptable engine, focused on steady-state studies. DPsim [@mirz2019dpsim] targets real-time and hardware-in-the-loop execution. Within the ANDES ecosystem, AGVis [@parsly2023agvis] streams simulation results onto a geographic map in the browser, as a visualization layer without model editing or an automation surface. Commercial packages (PSS/E, PowerFactory, PowerWorld) are mature but closed, which limits reproducibility. TENSA sits in the gap: an editable network diagram paired with validated dynamic simulation, live result streaming, and an automation API held at parity with the interface, in a single locally served browser application.

A separate, fast-moving line of work attaches LLM agents to established solvers. PowerMCP exposes PowerWorld, PSS/E, and OpenDSS as Model Context Protocol tools under the PowerAgent road map [@zhang2025poweragent; @powermcp]; Grid-Agent [@zhang2025gridagent] and X-GridAgent [@wen2025xgridagent] build agentic assistants for violation mitigation and grid analysis; Grid-Orch [@liu2026gridorch] orchestrates OpenDSS behind a chat interface; and code-generating agents drive MATPOWER studies end to end [@wang2026agentic]. A survey of this space names human oversight of agent actions among its central open challenges [@ghosh2026survey]. These systems put the agent in front: the person directs work through a chat transcript and reads results back as text. TENSA approaches the same convergence from the opposite side: a workbench for the person first, with the identical surface held open to agents, so a human can watch an agent's fault study unfold on the live diagram and streaming plots inside the same session. That is a shared, observable workspace the chat-first stacks do not provide, and a direct affordance for the oversight challenge the survey raises.

Building this as a separate package, rather than contributing a GUI into ANDES itself, was a deliberate scope decision. The concerns TENSA owns (session lifecycle, process isolation, streaming transport, undoable editing, diagram synthesis, an HTTP surface) are application architecture, not simulation, and would burden a numerical library with web dependencies and release coupling. TENSA consumes only the public ANDES Python API, leaving the engine unmodified. The application layer is the contribution; the simulator is a dependency.

# Software design

The system has three tiers: a React/TypeScript single-page application, a FastAPI service that owns sessions, jobs, files, and streaming, and one `andes.System` per session. Each decision below records the trade-off behind it.

**Process isolation over in-process concurrency.** ANDES solvers are blocking and CPU-bound, and a diverging simulation can spin indefinitely. Running each session's `System` inside a dedicated worker subprocess costs inter-process plumbing, but a runaway run stays killable, a crash cannot take the server down, and sessions cannot corrupt each other's state. Long routines execute as non-blocking jobs with progress and cancellation.

**Columnar streaming over request-response.** Polling JSON for time-domain results would either flood the wire or lag the solver. The worker instead emits Apache Arrow record batches [@arrow] over a WebSocket at a capped rate; columnar frames are cheap to serialize and nearly free to parse, so a ten-second study is watched, not awaited, without destabilizing the interface.

**Clone-on-write editing over direct mutation.** Parameter changes apply to a copy of the case, with undo, redo, and a diff view; nothing touches the loaded case until an explicit commit. The copy costs memory, negligible at case scale, and buys the safe exploration the target workflows are made of.

**Domain rules over generic graph layout.** A general-purpose layout engine alone produced diagrams no power engineer would accept. TENSA seeds positions with the Eclipse Layout Kernel [@elk], then applies rules that encode one-line drafting conventions: buses render as busbars, each branch is assigned a cardinal connection side, feeders sharing a side fan out along the bar, and machines and loads sit on the side of their bus facing away from the network, with a collision pass that slides devices along the bar rather than across the diagram. These rules are the domain expertise of the tool, refined by iterating until standard cases read like textbook one-lines.

**Mechanically enforced parity over convention.** GUI-API parity decays silently if it is only a policy, so it is checked: a ledger generated from the route table maps every API capability to its GUI surface or to an explicitly recorded deferral, and continuous integration fails when a new route lands untagged. The API ships with an OpenAPI schema, a condensed `llms.txt` map for LLM consumption, worked examples, and an optional Model Context Protocol server [@mcp]. The codebase carries 2,525 automated tests across the Python service (746, including acceptance tests that drive the real engine end-to-end and assert physical invariants such as generation-load balance) and the web client (1,779).

# Research impact statement

TENSA is a new tool, so the evidence here is of the early-stage kind: an analysis the software enables, a comparative benchmark, reproducible materials, and community-readiness signals. Every quantitative claim is backed by committed artifacts, and the scripted portions regenerate from a fresh checkout.

The central artifact is a benchmark study that TENSA both hosts and is measured by. It reimplements the budgeted N-2 contingency-screening protocol of PowerAgentBench-SS [@mylonas2026powerbenchss] natively on TENSA's public API: on the IEEE 39-bus case, a hidden oracle over all 562 connectivity-safe double outages is computed through the same public validate operation in 162 seconds on laptop-class hardware, 0.3 s per outage-solve-restore cycle. Within a budget of 40 validations, an LLM agent (Claude Opus 4.8, via a budget-enforcing CLI whose action log is committed with the results) and a scripted greedy baseline each recover 0.25 of the hidden top-20 with fully evidence-backed submissions, against 0.10 for random. The study produced a finding: the oracle's most severe contingencies are parallel-corridor pair synergies that single-outage probing cannot see; in the audited run, that made a late strategy pivot unrecoverable within budget. The environment is AC where the original benchmark is DC, so scores are deliberately not comparable; the study's role is to exercise an agent-operated, human-auditable workflow under a published protocol. Preparing it also surfaced and fixed a missing API capability (editable branch service status), demonstrating the evaluation loop feeding back into the tool.

The second artifact is the end-to-end walkthrough: a script drives the released interface to build the WSCC 9-bus system from an empty canvas and run four analyses, doubling as the demo video and a whole-workflow acceptance check. Community-readiness signals accompany both: a tagged release published to PyPI via Trusted Publishing with the interface bundled, citation metadata, continuous integration that gates lint, strict typing, tests, and the parity ledger, and an agent-facing surface (`llms.txt`, MCP) for the agentic power systems community surveyed above.

# AI usage disclosure

Substantial portions of the implementation were written with an AI coding agent (Claude, Anthropic) operating under the author's direction, including UI components, API routes, and tests. The problem framing and the design decisions described above, the process model, the streaming transport, the editing model, the diagram rules, the parity policy, and the benchmark protocol, are the author's. Because generated tests alone cannot vouch for generated code, verification leaned on checks a generator cannot game: acceptance tests assert physical invariants of the solved system rather than generated expectations, behavior was checked against the live application in a browser throughout development, and the author reviewed changes before they were merged. The LLM agent run inside the benchmark study is itself a disclosed use of AI, with its full budget log committed alongside the results. This paper was drafted with AI assistance; the quantitative claims were re-derived from the repository, and the author verified the references and edited the final text.

# Acknowledgements

TENSA is built on ANDES; the author thanks its developers for making a validated, open-source power system simulator freely available. All simulation capability described here is provided by ANDES.

# References
