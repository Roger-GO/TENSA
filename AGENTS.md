# AGENTS.md — Project Conventions

This file is for any agent (human or AI) working in this repo. Read it before touching code.

## Project shape

- **Layout**: `server/` is the Python substrate package (PEP 621 + src layout, hatchling build backend). `web/` is the v0.1+ React UI (Vite 6 + React 19 + TS + Tailwind v4 + Radix; pnpm). The two are independent packages with their own CI workflows.
- **All file paths in commits, plans, and reviews are repo-relative.** Never use absolute paths in code, docs, or commit messages.

## Pinned versions

- **Python**: 3.12+ (development on 3.12; CI matrix may extend later)
- **FastAPI**: `>=0.119,<0.120`
- **ANDES**: `>=2.0,<3.0` (2.0.0 is the verified-against version; `server/ANDES_VERSIONS.md` tracks the seven API contracts the substrate depends on)
- **pyarrow**: latest stable (pinned in pyproject.toml at install time)
- **pydantic**: v2

ANDES upgrades are deliberate — never accept an automatic minor bump without re-running the curl walkthrough in CI.

## Architectural decisions (do not relitigate without a plan revision)

- **Substrate is Python-API-direct, not CLI-shell-out.** ANDES CLI is too thin for disturbances; we call `andes.load`, `ss.PFlow.run()`, `ss.TDS.run()`, etc. in-process from a subprocess worker.
- **Per-session subprocess + two `multiprocessing.Pipe`s (data + control).** Threads-in-process rejected (ANDES is GIL-bound and stateful).
- **TDS streaming via the `TDS.callpert` per-step hook.** No `streaming_step` monkey-patching. Worker-side credit accounting via `time.sleep` at credit ceiling; separate worker thread polls control Pipe for abort independently.
- **All disturbances (Fault, Toggle, Alter) require pre-setup state.** Single endpoint `POST /sessions/{id}/disturbances`. After PF/TDS commits setup, callers must `POST /sessions/{id}/reload` to add more — there is no fast-reload path; `andes.load(setup=False)` is the only mechanism.
- **`PFlow.run()` and `TDS.run()` do NOT auto-call `setup()`.** The wrapper calls `ss.setup()` explicitly first if `not ss.is_setup`. Verified against ANDES 2.0.0; PFlow.run on a non-setup System raises `IndexError`.
- **HTTP boundary uses ANDES `idx` + `name` directly.** No opaque substrate-ID layer. Researcher persona already knows `idx` from notebooks; abstraction adds friction without protecting against an actual ANDES API change (covered by the version pin).
- **Apache Arrow IPC over WebSocket for time-series.** N-rows-per-batch default; anti-aliased boxcar mean default with `?decimation=none` opt-out.
- **No authentication.** The app trusts the local OS user, binds to loopback by default, and warns loudly on non-loopback binds. WebSocket protocol: connect → server sends `{"type":"ready"}` → client sends its first command frame.

## Security posture

The trust model lives in the top-level docstring of `server/src/tensa/__init__.py` (canonical statement) and in `SECURITY.md`. Summary:

- **Local OS user is trusted** — case files contain Python expressions evaluated by ANDES at parse time, and the local user is the only authorized actor.
- **Loopback web origins from random browser tabs are NOT trusted** — defended via Host/Origin pure-ASGI middleware + precise CORS allow-list (no wildcards, no `null`, no extension origins).
- **Third-party case files are NOT trusted by the system** but ARE trusted by the user when they choose to load them. ANDES's secondary file reads are logged via `sys.audit` (best-effort, Python-level only — does not catch C-extension reads).
- **Network exposure is opt-in and unauthenticated** — `--bind 0.0.0.0` exposes the full API; users who need remote access on untrusted networks should front the server with an authenticating proxy or tunnel.
- **Windows**: workspace boundary is best-effort; warning emitted at startup.

## Doing the work

- **Patterns to follow** are listed per implementation unit in the plan. Read them before coding the unit.
- **Test-first signal** — when a plan unit carries an `Execution note: Start with a failing integration test...` line, honor it.
- **Tests live alongside the package**:
  - `server/tests/{unit,integration,acceptance}/` — Python; acceptance tests run only with `pytest -m acceptance`.
  - `web/tests/{unit,e2e}/` — TypeScript; `pnpm test` (Vitest) for unit, `pnpm test:e2e` (Playwright) for e2e. The e2e suite spawns its own dev server but expects the substrate to be running.
- **Style**:
  - Python: `ruff check` (lint) and `mypy --strict` (types) on `server/src/`. Both must pass before commit.
  - TypeScript: `pnpm lint` (ESLint, `--max-warnings 0`) and `pnpm typecheck` (TS strict + `noUncheckedIndexedAccess`) on `web/`. `pnpm format:check` (Prettier) must pass.
- **Commits are conventional** (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`). Scope is the implementation unit name when applicable: `feat(unit-3): FastAPI app skeleton + auth`.
- **Never use `git add .`** in this repo. Stage files explicitly per logical unit.

## web/ conventions

- **Package manager**: pnpm 11+. Install with `npm install -g pnpm` or `corepack enable`. The lockfile is checked in; `pnpm install --frozen-lockfile` runs in CI.
- **Node**: 22 LTS minimum (newer versions also work).
- **Component conventions**: 2-space indent, single quotes, trailing commas (Prettier-enforced). Named exports only — no default exports for components. Components in `src/components/<scope>/<Name>.tsx`; tests at `tests/unit/components/<scope>/<Name>.test.tsx`.
- **Styling**: Tailwind v4 utility classes only. Color/type/spacing/motion tokens live in `web/src/styles/tokens.css` (Unit 2 fills it in) and resolve via Tailwind's `@theme`. Never hardcode colors / spacing values in components — always go through tokens.
- **Radix wrappers** (`web/src/components/ui/*`) forward Radix's behavior unchanged and apply project tokens via Tailwind. Never re-implement Radix logic. Falsification gate (Unit 2): if the project-built component library doesn't out-look stock shadcn-with-tokens, downgrade.
- **API client**: types are codegen'd from the substrate's `/openapi.json` via `pnpm regen-api-types` into `src/api/generated.ts` (committed). Hand-authored brands (`SessionId`, `RunId`) live in `src/api/types.ts`.
- **`/api/*` prefix**: the Vite dev proxy strips `/api` and forwards to the substrate's root paths. Production (Unit 10) prefixes the substrate's routers with `/api` so the same client URL works in both modes.

## What goes where

- `server/src/tensa/api/` — FastAPI routers, schemas, app factory
- `server/src/tensa/core/` — wrapper, worker, session manager, Arrow streaming
- `server/src/tensa/security/` — workspace path validation, Host/Origin ASGI middleware
- `server/src/tensa/cache/` — precomputed `andes prepare` artifacts (built at wheel time; only IEEE 14 ships in the wheel)
- `server/tests/acceptance/walkthrough.sh` — the curl-only end-to-end acceptance test
- `examples/` — copy-paste API walkthroughs (curl + Python)
- `llms.txt` — condensed API map for LLM agents (update when routes change)

## Out of scope (do not add without discussion)

- Authentication / multi-user / SaaS features
- Contingency screening, OPF, market simulation, EMTP
- CIM/CGMES import
- Custom user-defined dynamic models authored at runtime
