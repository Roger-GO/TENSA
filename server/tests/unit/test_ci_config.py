"""The CI matrix, the package metadata, and ``scripts/ci-matrix.sh`` agree.

``.github/workflows/server.yml`` is where the supported operating systems and
Python versions are listed. Nothing else would notice if a Python version were
dropped from the matrix while its trove classifier stayed, or if the workflow
asked ``scripts/ci-matrix.sh`` for a stage the script does not have. These
tests read the repository files directly, so they skip when the tests run away
from a checkout.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path
from typing import Any

import pytest

pytestmark = pytest.mark.unit

# server/tests/unit/test_ci_config.py -> server/ and the repository root.
_SERVER_DIR = Path(__file__).resolve().parents[2]
_REPO_ROOT = _SERVER_DIR.parent
_WORKFLOW = _REPO_ROOT / ".github" / "workflows" / "server.yml"
_SCRIPT = _REPO_ROOT / "scripts" / "ci-matrix.sh"

_REQUIRED_OSES = {"ubuntu-latest", "macos-14", "windows-latest"}


def _workflow() -> dict[str, Any]:
    yaml = pytest.importorskip("yaml")
    if not _WORKFLOW.is_file():
        pytest.skip(".github/workflows/server.yml is not next to the tests")
    loaded = yaml.safe_load(_WORKFLOW.read_text(encoding="utf-8"))
    assert isinstance(loaded, dict)
    return loaded


def _pyproject() -> dict[str, Any]:
    pyproject = _SERVER_DIR / "pyproject.toml"
    if not pyproject.is_file():
        pytest.skip("server/pyproject.toml is not next to the tests")
    return tomllib.loads(pyproject.read_text(encoding="utf-8"))


def _classifier_pythons() -> set[str]:
    prefix = "Programming Language :: Python :: "
    return {
        c.removeprefix(prefix)
        for c in _pyproject()["project"]["classifiers"]
        if re.fullmatch(re.escape(prefix) + r"3\.\d+", c)
    }


def test_workflow_triggers_cover_main_improve_branches_pull_requests_and_manual_runs() -> None:
    workflow = _workflow()
    # PyYAML follows YAML 1.1, where a bare ``on`` key loads as ``True``.
    triggers = workflow.get("on", workflow.get(True))
    assert triggers is not None
    assert set(triggers["push"]["branches"]).issuperset({"main", "improve/**"})
    assert "pull_request" in triggers
    assert "workflow_dispatch" in triggers


def test_test_matrix_covers_three_operating_systems() -> None:
    matrix = _workflow()["jobs"]["test"]["strategy"]["matrix"]
    assert set(matrix["os"]).issuperset(_REQUIRED_OSES)


def test_test_matrix_pythons_match_the_package_classifiers() -> None:
    """Every declared Python version is tested, and nothing untested is declared."""
    matrix = _workflow()["jobs"]["test"]["strategy"]["matrix"]
    tested = {str(v) for v in matrix["python"]}
    assert tested == _classifier_pythons()
    # Quoted in the workflow: an unquoted 3.10 would load as the float 3.1.
    assert all(isinstance(v, str) for v in matrix["python"])


def test_dev_extra_carries_the_coverage_tooling() -> None:
    dev = " ".join(_pyproject()["project"]["optional-dependencies"]["dev"])
    assert "pytest-cov" in dev
    # [tool.coverage.run] patch = ["subprocess"] is rejected by older coverage.
    assert "coverage>=7.10" in dev
    assert _pyproject()["tool"]["coverage"]["run"]["patch"] == ["subprocess"]


def test_every_stage_the_workflow_asks_for_exists_in_the_script() -> None:
    if not _SCRIPT.is_file():
        pytest.skip("scripts/ci-matrix.sh is not next to the tests")
    script = _SCRIPT.read_text(encoding="utf-8")
    steps = [
        step
        for job in _workflow()["jobs"].values()
        for step in job.get("steps", [])
        if "run" in step
    ]
    requested = {
        match.group(1)
        for step in steps
        for match in re.finditer(r"ci-matrix\.sh\s+(\w+)", step["run"])
    }
    # Guards the regex: the workflow does call the script.
    assert requested.issuperset({"lint", "unit", "smoke", "full"})
    for stage in requested:
        assert re.search(rf"^\s*{stage}\)", script, re.MULTILINE), (
            f"scripts/ci-matrix.sh has no {stage!r} stage"
        )
