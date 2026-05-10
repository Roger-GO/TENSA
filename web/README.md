# andes-app web (v0.2)

Vite 6 + React 19 + TypeScript + Tailwind v4 + Radix Primitives. Talks to the
`andes-app` substrate over HTTP (`/api/*`) and WebSocket (`/ws/*`).

## What's in v0.2

The v0.2 release builds on v0.1.y with the transient-simulation wedge: define
disturbances on a timeline, run TDS, watch frames stream into a plot in real
time, and scrub backward/forward through the result.

- **TDS streaming pipeline** — WebSocket transport + Apache Arrow IPC decode,
  geometric typed-array storage in the runs slice, UI-clamped 30 Hz output
  rate, automatic reconnect with `last_seq` resume, terminal-state taxonomy
  for buffer-evicted / run-not-found / auth-failed paths.
- **Disturbance editor** — `DisturbancePanel` + `DisturbanceTimeline` with
  draggable Fault / Toggle / Alter markers. Form validation per-row;
  per-disturbance error badges; commit only when all rows valid. Empty
  disturbances list runs a free-evolution simulation (no spurious 422).
- **Animated SLD overlay** — bus voltage band colors update at the substrate's
  clamped 30 Hz rate; selective redraw for only changed buses; single shared
  `requestAnimationFrame` loop driven from the App root.
- **Plot library** — stacked uPlot instances per variable group with shared
  cursor sync; `VariableTreePicker` checkbox tree for column selection;
  `ScrubControl` for time-axis scrubbing across plot + SLD in lockstep.
- **Run lifecycle controls** — `RunButton` extends from PF-only to PF-or-TDS
  with auto-mode based on disturbance presence + manual override; abort flow
  via `POST /sessions/{id}/abort`; `RunStatusBadge` reflects connection +
  run state.
- **Numerical-error surfaces** — non-modal `NumericalErrorBanner` above the
  right dock + slide-out `NumericalErrorDetails` (last 5 frames + worst
  mismatch column). Inspector + scrub remain accessible.
- **Panel picker tab strip** — right-dock top region cycles between Inspector,
  Disturbances, Plot, and TDS config panels. Auto-switches to Plot on run
  start; locks the Disturbances tab while a run is in flight.
- **TDS config panel** — `tf`, `h` (override or substrate-adaptive), variable
  groups (`bus_v` / `gen_state` / `line_flow`), `max_rate_hz` UI clamp.

Full scope and rationale:
[`docs/plans/2026-05-07-003-feat-v02-ui-disturbance-tds-streaming-plan.md`](../docs/plans/2026-05-07-003-feat-v02-ui-disturbance-tds-streaming-plan.md).

## What's in v0.1.y

The v0.1.y intermezzo (extending v0.1.x on `feat/v01-ui`) closes the structural
gaps the v0.1.x plan deferred and lays the foundation v0.2 needs:

- **Element deletion** — trash-icon `DeleteElementButton` on the Properties tab
  removes user-added elements pre-setup. Cascade detection blocks Bus deletes
  with attached Lines / Generators / Loads / Shunts and surfaces the dependents
  list. Case-file-originated elements reject with a "use Reload" message.
- **Layout overhaul** — collision push-out post-process eliminates element
  overlap on user-built systems and stress topologies (5 generators on one
  bus, IEEE 39, IEEE 300). Push-out is deterministic + idempotent; drag
  overrides take precedence.
- **Sidecar non-bus coordinates** — `SidecarLayout.non_bus_coordinates`
  persists generator / load / shunt drag positions across reload + Save System,
  not just bus drags. Old sidecars without the field read cleanly as `{}`.
- **Session resilience** — a stale session id self-heals: a 404 on
  `/api/sessions/{id}/*` triggers automatic recreation, the failing query
  retries against the new id, and the user sees a brief "Reconnecting…" badge
  instead of a sticky error. The sticky-error gate in `useEnsureSession` is
  removed; create attempts are now idempotent. Pre-setup recovery only — mid-PF
  is v0.2 territory.
- **Sidecar improvements + test coverage backfill** — every v0.1.x component
  with public behavioural surface (SaveSystemButton, NewSystemButton,
  WorkflowToolbar, BusIdxSelect, CancelConfirmDialog, ElementForm, StubEdge,
  TransformerEdge) now has dedicated unit tests at the EditElementButton
  coverage bar.

Full scope and rationale:
[`docs/plans/2026-05-08-002-feat-v01y-deletion-layout-prerequisites-plan.md`](../docs/plans/2026-05-08-002-feat-v01y-deletion-layout-prerequisites-plan.md).

## Prerequisites

- Node 22 LTS (or newer; this scaffold works on Node 25). Install via
  [`nvm`](https://github.com/nvm-sh/nvm) or your platform package manager.
- `pnpm` 9+. Install with `npm install -g pnpm` or `corepack enable`.
- The substrate running locally (`andes-app serve` from the `server/`
  package — see the repo root README).

## Quick start

```bash
# 1. Install deps (run once after each pull that touches package.json)
pnpm install

# 2. Start the substrate (from a separate shell, in the repo root)
#    Use --port to pick a stable port the dev proxy can target, and
#    --allow-origin to admit Vite's dev server through Host/Origin + CORS.
andes-app serve --port 8000 --allow-origin http://127.0.0.1:5173 --open

# 3. Start the Vite dev server
pnpm dev
# → http://127.0.0.1:5173
```

When you launch with `--open`, the substrate constructs
`http://<host>:<port>/#token=<value>` and opens your default browser. The UI
extracts the token from `location.hash`, stores it in `sessionStorage`, then
clears the fragment via `history.replaceState`. The token is **never** sent
to the server in the URL fragment — the browser never transmits it. Without
`--open`, paste the token from the file path the substrate prints to stderr
into the auth modal on first load.

If you bind the substrate to a non-default port, point the dev proxy at it:

```bash
VITE_ANDES_PORT=8123 pnpm dev
```

## Scripts

- `pnpm dev` — Vite dev server with proxy to the substrate.
- `pnpm build` — type-check + production build to `dist/`. The wheel-bundling
  unit (Unit 10) wires `dist/` into the Python wheel so a single
  `pip install andes-app` ships the UI.
- `pnpm typecheck` — TypeScript project-references check; `pnpm build` runs
  this implicitly.
- `pnpm lint` — ESLint with `--max-warnings 0`. CI fails on any warning.
- `pnpm format` / `pnpm format:check` — Prettier (with the Tailwind plugin
  for class-name sorting). Run `pnpm format` before committing.
- `pnpm test` — Vitest unit tests in `tests/unit/`.
- `pnpm test:e2e` — Playwright e2e tests in `tests/e2e/`. Requires the
  substrate to be running.
- `pnpm regen-api-types` — regenerate `src/api/generated.ts` from the
  substrate's `/openapi.json`. Run after any substrate API change.

## Structure

```
web/
├── src/
│   ├── api/         # generated TS types, fetch wrapper, TanStack Query hooks
│   ├── components/  # ui/ (Radix-wrapped), shell/, sld/, inspector/, …
│   ├── icons/       # IEC 60617 SVGs
│   ├── store/       # Zustand slices
│   ├── styles/      # tokens.css + globals.css
│   ├── App.tsx
│   └── main.tsx
├── tests/
│   ├── unit/        # Vitest
│   └── e2e/         # Playwright
└── docs/
    ├── interaction-states.md   # R19 deliverable
    └── design-system-decision.md
```

## Conventions

- 2-space indent, single quotes, trailing commas (Prettier-enforced).
- Named exports only for components — no default exports.
- Strict TypeScript with `noUncheckedIndexedAccess`. Prefer narrow types at
  module boundaries; use the branded `SessionId` / `RunId` from
  `src/api/types.ts` rather than raw `string`.
- Components live in `src/components/<scope>/<Name>.tsx`. Tests next to
  them under `tests/unit/components/<scope>/<Name>.test.tsx`.
- Tailwind classes only — no global CSS for component-specific styling
  outside `globals.css`. Color/type/spacing/motion tokens live in
  `tokens.css` and resolve via Tailwind v4's `@theme`.
- Radix wrappers (`src/components/ui/*`) forward Radix's behavior unchanged
  and apply project tokens via Tailwind classes. Never re-implement Radix
  logic.

## Contributing

PRs against this package run a CI workflow (`.github/workflows/web.yml`)
that executes `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`,
and `pnpm build`. All five must pass.
