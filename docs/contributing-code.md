# Contributing code

Contributions are welcome. TENSA has one maintainer (see [Support](support.md)), so a review takes the time it takes, and a change that is easy to review is merged sooner. This page is the short version. [CONTRIBUTING.md](https://github.com/Roger-GO/TENSA/blob/main/CONTRIBUTING.md) in the repository is the full one: every check CI runs, the conventions and how a release is made. Everyone who takes part follows the [code of conduct](https://github.com/Roger-GO/TENSA/blob/main/CODE_OF_CONDUCT.md).

## Before you start

- For anything bigger than a small fix, open an [issue](https://github.com/Roger-GO/TENSA/issues/new/choose) or a thread in [Discussions](https://github.com/Roger-GO/TENSA/discussions) first, so that the work does not go into a change that cannot be merged.
- Some things are out of scope: authentication, multi-user hosting, contingency screening inside the server (the [study in `examples/`](https://github.com/Roger-GO/TENSA/tree/main/examples/contingency_screening) runs outside it, over its API), optimal power flow, market simulation, EMTP, CIM/CGMES import, and dynamic models written at run time. Ask before you start on one of them.
- Documentation changes are welcome too. [Contributing to the docs](contributing.md) says how the site is built.

## Set up

[Install from source](install.md#install-from-source) gives the commands for Linux, macOS and Windows. For the tests, install the server with its `dev` extra, in the same environment:

```bash
pip install -e "./server[dev]"
```

## Quick check

These two are the fast ones, and they catch most mistakes: the server's unit tests, which leave out the integration and acceptance suites that start real servers and workers, and the UI's unit tests, which leave out the end-to-end tests that drive a browser. They run as written in PowerShell too.

```bash
cd server
pytest -q -m "not acceptance" tests/unit
cd ../web
pnpm test
```

## Before you open a pull request

CI runs the whole server suite on Linux, and on macOS and Windows the unit tests and a smoke test (a real server, a power flow and a short time-domain run). Lint, types, the acceptance suite and every web job run on Linux only. A change that passes these locally rarely fails there:

```bash
cd server
ruff check src tests
mypy --strict src
pytest -q -m "not acceptance" tests/unit tests/integration
cd ../web
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

Also:

- Add a test that fails without your change.
- Add a line under **Unreleased** in the [changelog](https://github.com/Roger-GO/TENSA/blob/main/CHANGELOG.md).
- Change the documentation a change makes wrong. Pages are plain prose, with no em dashes and no emoji.
- Write conventional commit messages (`feat(scope): ...`, `fix(scope): ...`, `docs: ...`) and stage the files you mean to commit by name.
- If you change a route or a schema, regenerate the web client's types (`cd web && pnpm regen-api-types`) and update `llms.txt`.

A pull request starts the same checks in CI. [CONTRIBUTING.md](https://github.com/Roger-GO/TENSA/blob/main/CONTRIBUTING.md) lists the rest, including the end-to-end tests, which drive a real browser against a real server.
