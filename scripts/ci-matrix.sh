#!/usr/bin/env bash
# ci-matrix.sh — single entry point for both CI and local development.
# Runs the same checks CI runs, in the same order. Fail-fast.
#
# Usage: scripts/ci-matrix.sh [STAGE] [PYTEST_ARGS...]
#
#   all     (default) lint, then the full suite
#   lint    ruff and mypy --strict
#   unit    tests/unit (every operating system in the CI matrix runs this)
#   smoke   the cross-platform smoke test: serve, load IEEE 14, PF, short TDS
#   full    unit and integration tests together (everything but acceptance)
#
# Extra arguments go to pytest, e.g. `ci-matrix.sh full --cov`. In CI the lint
# job runs `lint`, the Linux test legs run `full`, and the macOS and Windows
# legs run `unit` and then `smoke`. Locally, `all` is the whole gate.

set -euo pipefail

cd "$(dirname "$0")/../server"

stage="${1:-all}"
if [ "$#" -gt 0 ]; then
  shift
fi

lint() {
  echo "==> ruff check"
  ruff check .

  echo "==> mypy --strict"
  mypy --strict src
}

full() {
  echo "==> pytest (unit + integration, skip acceptance)"
  pytest -m "not acceptance" "$@"
}

case "$stage" in
  all)
    lint
    full "$@"
    ;;
  lint)
    lint
    ;;
  unit)
    echo "==> pytest tests/unit"
    pytest -m "not acceptance" tests/unit "$@"
    ;;
  smoke)
    echo "==> pytest -m smoke"
    pytest -m smoke tests/integration "$@"
    ;;
  full)
    full "$@"
    ;;
  *)
    echo "usage: $0 [all|lint|unit|smoke|full] [PYTEST_ARGS...]" >&2
    exit 2
    ;;
esac

echo "==> All checks passed."
