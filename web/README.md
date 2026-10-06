# tensa web

Vite 6 + React 19 + TypeScript + Tailwind v4 + Radix Primitives. Talks to the
`tensa` substrate over HTTP (`/api/*`) and WebSocket (`/api/ws/*`). What the UI
does is described in the [root README](../README.md); what changed in each
release is in the [CHANGELOG](../CHANGELOG.md).

## Prerequisites

- Node 22 LTS or newer. Install via [`nvm`](https://github.com/nvm-sh/nvm) or
  your platform package manager. CI runs the checks on Node 22, which
  `.nvmrc` names: `nvm use` in this directory selects it. A newer Node works
  for development, but the two do not give a test the same globals (on Node 22
  `Response.blob()` answers with Node's own `Blob`, not jsdom's), so run
  `pnpm test` on Node 22 before pushing a change to the tests.
- `pnpm` 11 or newer. Install with `npm install -g pnpm` or `corepack enable`.
- The substrate running locally (`tensa serve` from the `server/` package; see
  the repo root README).

## Quick start

```bash
# 1. Install deps (run once after each pull that touches package.json)
pnpm install

# 2. Start the substrate (from a separate shell, in the repo root).
#    Use --port to pick a stable port the dev proxy can target, and
#    --allow-origin to admit Vite's dev server through Host/Origin + CORS
#    (without it, requests from the dev server's origin get a 400).
tensa serve --port 8000 --allow-origin http://127.0.0.1:5173

# 3. Start the Vite dev server
pnpm dev
# -> http://127.0.0.1:5173
```

The substrate has no authentication, so there is no token to pass. Open the UI
at `http://127.0.0.1:5173`, not `localhost:5173`: the allowed origin is matched
as spelled.

If you bind the substrate to a non-default port, point the dev proxy at it:

```bash
VITE_ANDES_PORT=8123 pnpm dev
```

In PowerShell, set the variable on its own line:

```powershell
$env:VITE_ANDES_PORT = "8123"
pnpm dev
```

## Scripts

- `pnpm dev`: Vite dev server with proxy to the substrate.
- `pnpm build`: type-check + production build to `dist/`. `tensa serve` serves
  `dist/` from a checkout, and the wheel build bundles it, so a single
  `pip install tensa` ships the UI.
- `pnpm typecheck`: TypeScript project-references check; `pnpm build` runs
  this implicitly.
- `pnpm lint`: ESLint with `--max-warnings 0`. CI fails on any warning.
- `pnpm format` / `pnpm format:check`: Prettier (with the Tailwind plugin
  for class-name sorting). Run `pnpm format` before committing.
- `pnpm test`: Vitest unit tests in `tests/unit/`.
- `pnpm test:coverage`: the same with the v8 coverage provider (report in
  `coverage/`).
- `pnpm test:e2e`: Playwright e2e tests in `tests/e2e/`. They drive the real
  UI against a real substrate, so one has to be running; the comment at the top
  of `playwright.config.ts` has the commands for both ways to run them.
- `pnpm regen-api-types`: regenerate `src/api/generated.ts` from the
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
    ├── interaction-states.md
    └── design-system-decision.md
```

## Conventions

- 2-space indent, single quotes, trailing commas (Prettier-enforced).
- Named exports only for components, no default exports.
- Strict TypeScript with `noUncheckedIndexedAccess`. Prefer narrow types at
  module boundaries; use the branded `SessionId` / `RunId` from
  `src/api/types.ts` rather than raw `string`.
- Components live in `src/components/<scope>/<Name>.tsx`. Tests next to
  them under `tests/unit/components/<scope>/<Name>.test.tsx`.
- Tailwind classes only, no global CSS for component-specific styling
  outside `globals.css`. Color/type/spacing/motion tokens live in
  `tokens.css` and resolve via Tailwind v4's `@theme`.
- Radix wrappers (`src/components/ui/*`) forward Radix's behavior unchanged
  and apply project tokens via Tailwind classes. Never re-implement Radix
  logic.

## Contributing

PRs against this package run a CI workflow (`.github/workflows/web.yml`)
that executes `pnpm install`, `pnpm typecheck`, `pnpm lint`,
`pnpm format:check`, `pnpm test:coverage`, and `pnpm build`, and then drives the
real UI with Playwright (`pnpm test:e2e`) against a real substrate. All of
them must pass.
