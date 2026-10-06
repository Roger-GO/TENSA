# Contributing to TENSA

Thanks for your interest in improving TENSA! This guide covers everything you need to get a development environment running and land a PR.

## Development setup

The repo holds two independent packages:

- `server/` — Python 3.12+ FastAPI substrate (src layout, hatchling)
- `web/` — React 19 + TypeScript SPA (Vite 6, pnpm 11+)

```bash
# Server
python -m venv .venv
source .venv/bin/activate
pip install -e "./server[dev]"
tensa warm-cache          # optional ANDES code-gen cache (~30 s); serve does it in the background

# Web
cd web
pnpm install
```

Run the app in dev mode:

```bash
tensa serve --workspace ~/andes-cases --port 8000 --allow-origin http://127.0.0.1:5173   # terminal 1
cd web && VITE_ANDES_PORT=8000 pnpm dev                       # terminal 2 → http://127.0.0.1:5173
```

On Windows, use PowerShell. Activate the environment with `.venv\Scripts\Activate.ps1` (if it is blocked, `Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned` allows it for that window), and set the dev server's port variable on its own line:

```powershell
cd web
$env:VITE_ANDES_PORT = "8000"
pnpm dev
```

Windows on ARM is not supported: `kvxopt` and `pyarrow` publish no wheels for it.

## Tests and quality gates

All of these must pass before a PR is merged (CI enforces them):

| Area | Command |
|---|---|
| Server lint | `ruff check server/src server/tests` |
| Server types | `mypy --strict server/src` |
| Server tests | `cd server && PYTHONPATH=src pytest tests/unit tests/integration` |
| Server smoke test | `cd server && pytest -m smoke tests/integration` (starts a real server and worker; macOS and Windows CI run it alongside the unit tests) |
| Server coverage | `cd server && pytest -m "not acceptance" --cov --cov-report=html` (report in `server/htmlcov`) |
| Server acceptance | `scripts/ci-matrix.sh acceptance`, or `cd server && PYTHONPATH=src pytest tests/acceptance -m acceptance` (slow; each test starts its own server and runs real ANDES sims; CI runs it in the `acceptance` job) |
| Web types | `cd web && pnpm typecheck` |
| Web lint/format | `cd web && pnpm lint && pnpm format:check` |
| Web tests | `cd web && pnpm test` |
| Web coverage | `cd web && pnpm test:coverage` (report in `web/coverage`) |
| Web build | `cd web && pnpm build` |
| Docs site | `pip install -r docs/requirements.txt -e ./server`, then `mkdocs build --strict` from the repository root (the pages are in `docs/`; the build fails on a broken link) |
| Large files | `python scripts/check_large_files.py --base origin/main` (a file your change adds or makes bigger must be 1 MiB or less; see [Media and other large files](#media-and-other-large-files)) |
| Web e2e | `cd web && pnpm build`, start `tensa serve --port 8765 --workspace "$(mktemp -d)" --max-sessions 32`, then `E2E_BASE_URL=http://127.0.0.1:8765 E2E_NO_WEBSERVER=1 pnpm test:e2e` (a real browser against a real server; `pnpm exec playwright install chromium` once; the `e2e` job in `web.yml` does the same; other modes are described in `web/playwright.config.ts`). If something else holds port 8765, `tensa serve` says so and stops: use another port in both commands, or the tests run against whatever is listening there |

The table is written for a POSIX shell. In PowerShell, leave out the `PYTHONPATH=src` prefix (the editable install already puts `tensa` on the path), set environment variables on their own line (`$env:E2E_BASE_URL = "http://127.0.0.1:8765"`), and pass `--workspace` a directory you made yourself instead of `$(mktemp -d)`.

CI runs the server tests on Linux, macOS (Apple silicon), and Windows with Python 3.12 and 3.13. `scripts/ci-matrix.sh [all|lint|unit|smoke|full|acceptance]` runs the same stages locally.

Dependencies are kept current by weekly Dependabot pull requests (`.github/dependabot.yml`), and `.github/workflows/audit.yml` runs `pip-audit` on a fresh install of the server (with the `mcp` extra) and `pnpm audit --prod` on the web lockfile every Monday and whenever a dependency file changes. A failed audit step is a finding to read, not a broken build, until the baseline is clean. Before raising a range in `server/pyproject.toml`, run the full suite in an environment that holds the new version: `fastapi` is capped at the next minor after the newest release the suite passed on, because FastAPI can break callers in a minor release.

## Conventions

- **Commits** are conventional: `feat(scope): ...`, `fix(scope): ...`, `refactor:`, `chore:`, `docs:`, `test:`.
- **Python**: ruff + `mypy --strict`. Every Pydantic schema field carries a `description` (the OpenAPI schema is a first-class product for API consumers and agents).
- **TypeScript**: ESLint with `--max-warnings 0`, strict TS with `noUncheckedIndexedAccess`. Named exports only for components. Tailwind v4 tokens (`web/src/styles/tokens.css`) — never hardcode colors/spacing.
- **API types are codegen'd**: after changing server schemas/routes, run `cd web && pnpm regen-api-types` (boots a throwaway server, fetches `/openapi.json`, regenerates `web/src/api/generated.ts`). Never hand-edit `generated.ts`.
- **Version** is set in one place, `server/pyproject.toml`. `tensa.__version__`, the OpenAPI version, and the `tensa_version` stamped on bundles and snapshots read it from the installed package metadata, so re-run `pip install -e ./server` after a bump. `web/package.json` and `CITATION.cff` carry copies; `server/tests/unit/test_version.py` fails if any of them drift.
- **Stage files explicitly** — no `git add .`.

## Releasing

1. Set the new version in `server/pyproject.toml`, `web/package.json`, and `CITATION.cff` (`server/tests/unit/test_version.py` fails if they differ), and move the `[Unreleased]` changelog entries under it.
2. Tag the commit `vX.Y.Z` (the tag must name the package version) and publish a GitHub release for it.
3. `.github/workflows/publish.yml` runs the server and web test workflows, builds the UI, the sdist, and the wheel from that sdist, checks them (`scripts/check_dist.py`: tag equals version, UI bundled, no source maps, license included), installs the wheel into a clean environment, and uploads it to PyPI with Trusted Publishing. It publishes nothing if any step fails.

To build the same packages locally, build the UI first and then run the build: `cd web && pnpm install && pnpm build`, then `pip install build && python -m build server`. `python scripts/check_dist.py server/dist` runs the same checks. The build fails when `web/dist` is missing, so a package never ships without the UI. An editable install (`pip install -e ./server`) does not need the UI built first.

## Documentation

The documentation site is MkDocs with the Material theme: the pages are Markdown files in `docs/`, listed in `mkdocs.yml`, and `mkdocs serve` previews them. Its Reference pages (the command line, the API routes and the API models) are written from the code while the site builds, so a change to a route's description or an option's help text is a change to the documentation, and no page needs editing. [`docs/contributing.md`](./docs/contributing.md) explains how to build the site, how to write a page, how to take the screenshots again, and how the repository owner turns on publishing to GitHub Pages. Docs are plain prose: no em dashes and no emoji.

## Media and other large files

What is committed stays in every clone for good, and the project does not rewrite its history to take a file back out, so a large file costs every contributor for as long as the repository lives. Two files already weigh more than they should have: the demo video `docs/demo/ieee9-agent-demo.mp4` (about 3.3 MiB) and the GIF `docs/img/demo.gif` (about 1.4 MiB). The README embeds both, so they stay where they are, and no new file should join them.

- **The limit is 1 MiB.** A file your change adds, or makes bigger, has to be 1 MiB (1,048,576 bytes) or less. The `large-files` workflow (`.github/workflows/large-files.yml`) checks every pull request and every push to `main`, and `python scripts/check_large_files.py --base origin/main` runs the same check on your branch. A file your change does not touch is not checked, and a large file that is moved or made smaller passes. The check reads what the change comes to, so a file added in one commit and deleted in the next gets through it, yet a merge that keeps the commits keeps the file in the history. If a large file got into a branch by mistake, take it out of the branch's commits before the merge.
- **Screenshots** are JPEG, or an optimized PNG for flat diagrams, no wider than about 1600 px, and under 200 KB. [`docs/contributing.md`](./docs/contributing.md) shows how the UI tour's images are taken again.
- **Recordings** stay out of the repository. Attach the video or GIF to the pull request, an issue or a GitHub release, and link to it. A clip that has to live in the repository is trimmed, scaled down and given a lower frame rate until it is under the limit.
- **A real exception** is a decision for the reviewer. Add the path to `.github/large-files-allowed.txt` in the same pull request, one path per line with a `#` comment that says why the file has to be in the repository.

## Making changes that touch the API surface

1. Change the server (routes/schemas) with tests.
2. Regenerate the TypeScript types (`pnpm regen-api-types`).
3. Update the web client/UI.
4. If you added/renamed endpoints, update `llms.txt` and, if relevant, `examples/`.

## Reporting bugs / requesting features

Use the GitHub issue templates. For bugs, include the case file (or a minimal reproduction), the exact request/UI action, and the response/`ProblemDetails` payload if there is one.

## Code of conduct

Be kind, be constructive, assume good intent.
