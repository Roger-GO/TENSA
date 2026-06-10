# Contributing to ANDES App

Thanks for your interest in improving ANDES App! This guide covers everything you need to get a development environment running and land a PR.

## Development setup

The repo holds two independent packages:

- `server/` — Python 3.12+ FastAPI substrate (src layout, hatchling)
- `web/` — React 19 + TypeScript SPA (Vite 6, pnpm 11+)

```bash
# Server
python -m venv .venv && source .venv/bin/activate
pip install -e './server[dev]'
andes-app warm-cache          # one-time ANDES code-gen cache (~30 s)

# Web
cd web
pnpm install
```

Run the app in dev mode:

```bash
andes-app serve --workspace ~/andes-cases --port 8000        # terminal 1
cd web && VITE_ANDES_PORT=8000 pnpm dev                       # terminal 2 → :5173
```

## Tests and quality gates

All of these must pass before a PR is merged (CI enforces them):

| Area | Command |
|---|---|
| Server lint | `ruff check server/src server/tests` |
| Server types | `mypy --strict server/src` |
| Server tests | `cd server && PYTHONPATH=src pytest tests/unit tests/integration` |
| Server acceptance | `cd server && PYTHONPATH=src pytest tests/acceptance -m acceptance` (slow; runs real ANDES sims) |
| Web types | `cd web && pnpm typecheck` |
| Web lint/format | `cd web && pnpm lint && pnpm format:check` |
| Web tests | `cd web && pnpm test` |
| Web build | `cd web && pnpm build` |

## Conventions

- **Commits** are conventional: `feat(scope): ...`, `fix(scope): ...`, `refactor:`, `chore:`, `docs:`, `test:`.
- **Python**: ruff + `mypy --strict`. Every Pydantic schema field carries a `description` (the OpenAPI schema is a first-class product for API consumers and agents).
- **TypeScript**: ESLint with `--max-warnings 0`, strict TS with `noUncheckedIndexedAccess`. Named exports only for components. Tailwind v4 tokens (`web/src/styles/tokens.css`) — never hardcode colors/spacing.
- **API types are codegen'd**: after changing server schemas/routes, run `cd web && pnpm regen-api-types` (boots a throwaway server, fetches `/openapi.json`, regenerates `web/src/api/generated.ts`). Never hand-edit `generated.ts`.
- **Stage files explicitly** — no `git add .`.

## Making changes that touch the API surface

1. Change the server (routes/schemas) with tests.
2. Regenerate the TypeScript types (`pnpm regen-api-types`).
3. Update the web client/UI.
4. If you added/renamed endpoints, update `llms.txt` and, if relevant, `examples/`.

## Reporting bugs / requesting features

Use the GitHub issue templates. For bugs, include the case file (or a minimal reproduction), the exact request/UI action, and the response/`ProblemDetails` payload if there is one.

## Code of conduct

Be kind, be constructive, assume good intent.
