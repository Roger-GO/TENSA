"""Acceptance test for ``andes-app warm-cache``.

Verifies the subcommand runs end-to-end against the installed ANDES, and
that ``~/.andes/pycode/`` exists afterwards (the cache that subsequent
``andes.load`` calls reuse to skip the cold-start prep).
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.acceptance
def test_warm_cache_runs_green_and_populates_cache_dir() -> None:
    """``python -m andes_app warm-cache --quick --incremental`` exits 0 and
    leaves ``~/.andes/pycode/`` populated with at least one file.

    Uses ``--quick --incremental`` to keep the test fast even on a cold
    cache (full prep takes ~30-90 s). The acceptance gate is "did the
    cache directory end up populated?", not "did every model regenerate".
    """
    pytest.importorskip("andes")

    result = subprocess.run(
        [sys.executable, "-m", "andes_app", "warm-cache", "--quick", "--incremental"],
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
        capture_output=True,
        text=True,
        timeout=180,
    )
    if result.returncode != 0:
        pytest.fail(
            "warm-cache failed.\n"
            f"exit code: {result.returncode}\n"
            f"stdout:\n{result.stdout}\n"
            f"stderr:\n{result.stderr}\n"
        )

    cache_dir = Path.home() / ".andes" / "pycode"
    assert cache_dir.is_dir(), f"expected {cache_dir} to be populated after warm-cache"
    n_files = sum(1 for p in cache_dir.iterdir() if p.is_file())
    assert n_files > 0, f"expected non-empty {cache_dir}, got {n_files} files"

    # The warm-cache log line "cache ready: N files, X MB" should be present
    # in stderr so users can confirm the prep succeeded.
    assert "cache ready" in result.stderr, (
        f"expected 'cache ready' line in stderr; got:\n{result.stderr}"
    )
