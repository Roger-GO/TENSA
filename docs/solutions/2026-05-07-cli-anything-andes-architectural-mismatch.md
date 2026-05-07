# CLI-Anything is structurally mismatched to a Python-API-direct ANDES wrapper

**Date**: 2026-05-07
**Context**: Phase A planning for the ANDES App. The original brainstorm proposed using HKUDS/CLI-Anything as a runtime layer between ANDES and the FastAPI substrate.
**Decision**: Do NOT use CLI-Anything in any role for this project. No spike needed.

## What CLI-Anything actually is

[HKUDS/CLI-Anything](https://github.com/HKUDS/CLI-Anything) is a Claude Code marketplace plugin that runs a 7-phase pipeline (Analyze → Design → Implement → Plan Tests → Write Tests → Document → Publish) and produces a Click-based Python CLI package + tests + SKILL.md as **generated source code that the team owns and maintains**. It is a one-shot scaffolding tool, not a runtime layer or library.

## Why it's mismatched here

The ANDES App substrate must:

1. Expose disturbance management (`Fault`, `Toggle`, `Alter`) — these are not CLI-accessible in ANDES (verified: `andes` CLI exposes only `run | plot | doc | misc | prepare | selftest`; disturbances are case-file rows or pre-setup Python-API ops via `ss.add('Fault', ...)`).
2. Stream TDS results in-process via the `TDS.callpert` per-step hook — `andes run -r tds` writes `.lst/.npz` files only at end-of-run.
3. Manage a long-lived `andes.System` instance per session via `multiprocessing.Process`, calling `andes.load(setup=False)`, `ss.PFlow.run()`, `ss.TDS.run()` directly.

CLI-Anything wraps CLIs. ANDES's CLI surface is too thin for our needs. Our substrate is a Python-API-direct wrapper, not a CLI shell-out, so there is no CLI to wrap. CLI-Anything's output (a Click CLI invoking subprocess.run on the wrapped tool) does not serve any Phase A requirement, and a hand-rolled Typer CLI for `andes-app serve` is a 50-line job that needs no scaffolding tool.

## What we use instead

Direct `andes.load()` / `ss.PFlow.run()` / `ss.TDS.run()` calls in a Python wrapper inside a per-session subprocess. Typer for the `andes-app` CLI. FastAPI directly for HTTP/WebSocket. No intermediate code-generation step.

## How to apply (for future ANDES wrapper projects)

CLI-Anything is the right tool when wrapping a meaningful CLI surface that you want to drive programmatically. It is the wrong tool when:

- The underlying tool's CLI is too narrow to expose the operations you need.
- You need a stateful, long-lived process (one System per session) rather than one-shot subprocess invocations.
- You need streaming hooks (e.g., per-integration-step callbacks) that the CLI doesn't surface.

ANDES hits all three. The substrate-first architecture from the brainstorm survives without CLI-Anything; in fact it's cleaner this way.
