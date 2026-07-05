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
    corresponding: true
    # TODO before submission: add your ORCID here, e.g.  orcid: 0000-0000-0000-0000
    affiliation: 1
affiliations:
  - name: Embry-Riddle Aeronautical University, United States
    index: 1
date: 5 July 2026
bibliography: paper.bib
---

# Summary

TENSA (Transients, Eigenvalues & Network Simulation Application) is an open-source, browser-based workbench for power system modeling, simulation, and analysis. A user assembles a network on an interactive one-line diagram, placing buses, lines, transformers, machines, exciters, and governors, then runs any of five analyses from the interface: power flow, time-domain simulation, eigenvalue analysis, continuation power flow, and state estimation. Together these answer the working questions of power system studies: whether an operating point exists, how the system rides through a fault, and how far it sits from instability. Time-domain results stream into the plots while the solver is still running, and a voltage overlay animates on the diagram in step. Every operation available in the interface is also exposed through a documented HTTP and WebSocket API, so the same studies can be driven by a script or by an AI agent. All numerical computation is performed by ANDES, the hybrid symbolic-numeric simulator by @cui2021andes; TENSA contributes the interactive application layer around it. The software is released under the GNU General Public License (v3.0 or later), runs entirely on the user's machine, and is available at <https://github.com/Roger-GO/TENSA>.

![The interactive one-line diagram after a solved power flow on the WSCC 9-bus system [@anderson2003], with per-bus voltages and branch flows displayed. Busbars are tinted when a bus voltage approaches its configured limits.\label{fig:sld}](sld.png)

# Statement of need

Open-source power system simulation is dominated by script-driven workflows. That suits batch experiments, but it leaves three audiences underserved. Students and instructors need immediate visual feedback: place a generator, run the study, watch the voltages respond. Requiring fluency in a Python API before the first simulation raises the floor of every power system analysis course built on open tools. Researchers exploring a system, rather than sweeping one, face a related cost: each what-if question means editing case files or writing orchestration code, and a long time-domain run gives no feedback until it finishes. Finally, LLM-based agents are becoming practical operators of scientific software, and they need what a script needs: a documented, machine-readable interface with observable state. Commercial desktop tools do ship automation APIs, but those are proprietary and platform-bound; an open, web-native surface kept at parity with the GUI makes the same studies available to people and to programs on equal terms.

TENSA addresses the three at once because they share one requirement: a complete application layer over the solver, with interaction for people and an equivalent API for programs. The target users are instructors and students in power system analysis courses, researchers who need exploratory dynamic studies with live feedback, and developers building agent-driven simulation workflows.

# State of the field

Established open-source tools concentrate on steady-state and planning studies through code: MATPOWER [@zimmerman2011matpower], pandapower [@thurner2018pandapower], and PyPSA [@brown2018pypsa] are libraries first, with visualization as a plotting utility rather than an interactive surface. PSAT [@milano2005psat] pioneered an open graphical environment for both static and dynamic analysis, though its network editor depends on the proprietary MATLAB/Simulink platform. GridCal [@gridcal] provides an open desktop GUI with a schematic editor over a scriptable engine, focused on steady-state and planning studies. DPsim [@mirz2019dpsim] targets real-time and hardware-in-the-loop execution. Within the ANDES ecosystem itself, AGVis [@parsly2023agvis] streams simulation results onto a geographic map in the browser, as a visualization layer without model editing or an automation surface. Commercial packages (PSS/E, PowerFactory, PowerWorld) offer mature interactive environments and their own automation APIs, but closed licensing and formats limit reproducibility and portability. TENSA sits in the gap between these neighbors: it pairs an editable network diagram with validated dynamic simulation, streams results live during the run, and holds its automation API at parity with the interface, in a single locally served browser application.

Building this as a separate package, rather than contributing a GUI into ANDES itself, was a deliberate scope decision. The concerns TENSA owns (session lifecycle, process isolation, streaming transport, undoable editing, diagram synthesis, an HTTP surface) are application architecture, not simulation, and would burden a numerical library with web dependencies and release coupling. TENSA consumes only the public ANDES Python API, leaving the engine unmodified, so each project can evolve on its own schedule. The application layer is the contribution; the simulator is a dependency.

# Software design

The system has three tiers. A React/TypeScript single-page application renders the diagram, forms, and plots. A FastAPI service owns sessions, jobs, files, and streaming. Each session holds one `andes.System` inside a dedicated worker subprocess, so a diverging simulation cannot block or crash the API process, and concurrent sessions stay isolated. Long-running routines execute as non-blocking jobs with progress reporting and cancellation.

Three design decisions carry most of the user experience. First, streaming: during time-domain simulation the worker subprocess emits Apache Arrow record batches [@arrow] over a WebSocket at a capped rate, and the client renders them incrementally, so a ten-second study is watched, not awaited. Second, editing is clone-on-write: parameter changes apply to a copy of the case with undo, redo, and a diff view, and nothing mutates the loaded case until an explicit commit, which makes exploration safe. Third, the one-line diagram is synthesized, not hand-drawn: an initial layered layout from the Eclipse Layout Kernel [@elk] is refined by domain rules that render buses as busbars, assign each branch a cardinal connection side, fan feeders that share a side along the bar, and place machines and loads on the side of their bus facing away from the network, with a collision pass that slides overlapping devices along the bar rather than across the diagram. These rules came from iterating on rendered diagrams until standard cases read like textbook one-lines.

Agent access is held to the same standard as the interface, and that parity is checked rather than promised: a ledger generated from the route table maps every API capability to its GUI surface or to an explicitly recorded deferral, and continuous integration fails when a new route lands untagged. The API ships with an OpenAPI schema, a condensed `llms.txt` map written for LLM consumption, worked examples, and an optional Model Context Protocol server [@mcp] that exposes the workflow as tools for AI assistants. The codebase carries 2,524 automated tests across the Python service (745, including acceptance tests that compare against numerical results computed by ANDES) and the web client (1,779). A Playwright script also drives the released interface end-to-end, rebuilding the WSCC 9-bus system from an empty canvas and running power flow, a fault-perturbed time-domain study, eigenvalue analysis, and continuation power flow; its recording is the project's demo video.

# Research impact statement

TENSA is early in its public life, and this section reports only what has already happened. The tool supports the author's research on power infrastructure resilience, where interactive fault placement and streamed time-domain response shorten the loop between question and simulation. The scripted end-to-end walkthrough above doubles as a reproducibility artifact: the bundled script regenerates the complete build-and-analyze demonstration against a local server.

# AI usage disclosure

Substantial portions of the implementation were written with an AI coding agent (Claude, Anthropic) operating under the author's direction, including UI components, API routes, and tests. Because generated tests alone cannot vouch for generated code, verification relied on independent oracles: the acceptance suite compares against numerical results produced by ANDES itself, diagram and interaction behavior was checked against the live application in a browser throughout development, and the author reviewed changes before they were merged. This paper was drafted with AI assistance; the quantitative claims were re-derived from the repository (test counts from collection runs, capabilities from the route ledger), and the author verified the references and edited the final text.

# Acknowledgements

The author thanks the developers of ANDES for making the simulator openly available. All simulation capability described here rests on the work of the ANDES developers.

# References
