#!/usr/bin/env bash
# ci-matrix.sh — single entry point for both CI and local development.
# Runs the same checks CI runs, in the same order. Fail-fast.

set -euo pipefail

cd "$(dirname "$0")/../server"

echo "==> ruff check"
ruff check .

echo "==> mypy --strict"
mypy --strict src

echo "==> pytest (unit + integration, skip acceptance)"
pytest -m "not acceptance"

echo "==> All checks passed."
