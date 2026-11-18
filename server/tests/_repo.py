"""Where the repository's own files are, for the tests that read them.

Several tests read ``server/pyproject.toml``, the workflows, ``scripts/`` or the
web package files directly. They share the locations and the loaders here, and
skip when a file they read is missing, as it is when ``server/`` is copied out of
the checkout. (The sdist does not carry ``tests/`` at all, so the suite runs from
a checkout only.)
"""

from __future__ import annotations

import importlib.util
import re
import tomllib
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

# server/tests/_repo.py -> server/ and the repository root.
SERVER_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = SERVER_DIR.parent
WEB_DIR = REPO_ROOT / "web"
SCRIPTS_DIR = REPO_ROOT / "scripts"


def pyproject() -> dict[str, Any]:
    """``server/pyproject.toml``, parsed; skips the test when it is not there."""
    path = SERVER_DIR / "pyproject.toml"
    if not path.is_file():
        pytest.skip("server/pyproject.toml is not next to the tests")
    return tomllib.loads(path.read_text(encoding="utf-8"))


def load_module(name: str, path: Path) -> ModuleType:
    """Import a Python file that is not on the import path (a script, the build hook).

    Skips the test when the file is missing.
    """
    if not path.is_file():
        pytest.skip(f"{path.relative_to(REPO_ROOT).as_posix()} is not next to the tests")
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def matpower_rows(text: str, field: str) -> list[list[float]]:
    """The numbers of one block of a MATPOWER case file (``bus``, ``gen`` or ``branch``), a row
    to a list (``Inf`` reads as infinity)."""
    block = re.search(rf"mpc\.{field} = \[(.*?)\];", text, re.S)
    assert block is not None, field
    rows = []
    for line in block.group(1).splitlines():
        line = line.split("%")[0].strip().rstrip(";")
        if line:
            rows.append([float(value) for value in line.split()])
    return rows
