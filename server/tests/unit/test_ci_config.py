"""The CI matrix, the package metadata, and ``scripts/ci-matrix.sh`` agree.

``.github/workflows/server.yml`` is where the supported operating systems and
Python versions are listed. Nothing else would notice if a Python version were
dropped from the matrix while its trove classifier stayed, or if the workflow
asked ``scripts/ci-matrix.sh`` for a stage the script does not have. The release
workflow (``publish.yml``) is checked the same way: it must wait for the test
workflows and must build, check, and smoke-test the packages before uploading
them. These tests read the repository files directly, so they skip when the
tests run away from a checkout.
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
_WORKFLOWS = _REPO_ROOT / ".github" / "workflows"
_WORKFLOW = _WORKFLOWS / "server.yml"
_SCRIPT = _REPO_ROOT / "scripts" / "ci-matrix.sh"

_REQUIRED_OSES = {"ubuntu-latest", "macos-14", "windows-latest"}


def _load(path: Path) -> dict[str, Any]:
    yaml = pytest.importorskip("yaml")
    if not path.is_file():
        pytest.skip(f".github/workflows/{path.name} is not next to the tests")
    loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert isinstance(loaded, dict)
    return loaded


def _workflow() -> dict[str, Any]:
    return _load(_WORKFLOW)


def _triggers(workflow: dict[str, Any]) -> dict[str, Any]:
    # PyYAML follows YAML 1.1, where a bare ``on`` key loads as ``True``.
    triggers = workflow.get("on", workflow.get(True))
    assert isinstance(triggers, dict)
    return triggers


def _run_text(job: dict[str, Any]) -> str:
    return "\n".join(step["run"] for step in job["steps"] if "run" in step)


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
    triggers = _triggers(_workflow())
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


def test_the_test_workflows_can_be_called_from_the_release_workflow() -> None:
    for name in ("server.yml", "web.yml"):
        assert "workflow_call" in _triggers(_load(_WORKFLOWS / name)), name


def test_publish_waits_for_the_test_workflows_and_the_build() -> None:
    jobs = _load(_WORKFLOWS / "publish.yml")["jobs"]
    assert jobs["server-tests"]["uses"] == "./.github/workflows/server.yml"
    assert jobs["web-tests"]["uses"] == "./.github/workflows/web.yml"
    assert set(jobs["publish"]["needs"]) == {"server-tests", "web-tests", "build"}


def test_only_the_publish_job_can_mint_an_oidc_token() -> None:
    workflow = _load(_WORKFLOWS / "publish.yml")
    assert "id-token" not in workflow["permissions"]
    for name, job in workflow["jobs"].items():
        granted = job.get("permissions", {}).get("id-token")
        assert (granted == "write") == (name == "publish"), name


def test_publish_builds_the_wheel_from_the_sdist_and_checks_what_it_built() -> None:
    build = _load(_WORKFLOWS / "publish.yml")["jobs"]["build"]
    run = _run_text(build)
    # Neither --sdist nor --wheel: build then makes the wheel from the sdist.
    (command,) = [line for line in run.splitlines() if "-m build" in line]
    assert "--sdist" not in command
    assert "--wheel" not in command
    # The tag must be the package version, and only a tag run may get that far.
    assert "GITHUB_REF_TYPE" in run
    assert re.search(r'scripts/check_dist\.py\s+server/dist\s+--tag\s+"\$GITHUB_REF_NAME"', run)
    assert "twine check --strict" in run
    # A clean environment installs the wheel and runs it.
    assert 'bin/tensa" --help' in run
    assert 'bin/tensa" --version' in run
    assert "static" in run
    assert "index.html" in run


def test_publish_uploads_what_the_build_job_checked() -> None:
    jobs = _load(_WORKFLOWS / "publish.yml")["jobs"]
    uploaded = [s for s in jobs["build"]["steps"] if "upload-artifact" in s.get("uses", "")]
    downloaded = [s for s in jobs["publish"]["steps"] if "download-artifact" in s.get("uses", "")]
    assert len(uploaded) == len(downloaded) == 1
    assert uploaded[0]["with"]["name"] == downloaded[0]["with"]["name"]
    publish = [s for s in jobs["publish"]["steps"] if "pypi-publish" in s.get("uses", "")]
    assert len(publish) == 1
    assert publish[0]["with"]["packages-dir"] == downloaded[0]["with"]["path"]


_DEPENDABOT = _REPO_ROOT / ".github" / "dependabot.yml"


def _load_required(path: Path) -> dict[str, Any]:
    """Like ``_load``, but a missing file fails when the other workflows are here.

    Away from a checkout there is nothing to read and the test skips. In a
    checkout, deleting the file must not turn its tests into silent skips.
    """
    if _WORKFLOW.is_file():
        assert path.is_file(), f"{path.relative_to(_REPO_ROOT)} is missing"
    return _load(path)


def test_dependabot_watches_every_manifest_weekly() -> None:
    """Python, web, and workflow dependencies each have an update entry that points at real files."""
    updates = _load_required(_DEPENDABOT)["updates"]
    manifests = {
        "pip": ("/server", "pyproject.toml"),
        "npm": ("/web", "package.json"),
        "github-actions": ("/", ".github/workflows/server.yml"),
    }
    assert {u["package-ecosystem"] for u in updates} == set(manifests)
    for update in updates:
        directory, manifest = manifests[update["package-ecosystem"]]
        assert update["directory"] == directory
        assert (_REPO_ROOT / directory.lstrip("/") / manifest).is_file(), update
        assert update["schedule"]["interval"] == "weekly"


def test_dependabot_leaves_andes_minor_and_major_upgrades_to_a_person() -> None:
    """AGENTS.md: ANDES upgrades are deliberate, never an automatic minor bump."""
    updates = _load_required(_DEPENDABOT)["updates"]
    (pip,) = [u for u in updates if u["package-ecosystem"] == "pip"]
    (andes,) = [i for i in pip["ignore"] if i["dependency-name"] == "andes"]
    assert set(andes["update-types"]) == {
        "version-update:semver-major",
        "version-update:semver-minor",
    }


def test_audit_workflow_checks_both_halves_on_a_schedule() -> None:
    """Advisories appear without a commit, so the audit also runs weekly and on demand."""
    workflow = _load_required(_WORKFLOWS / "audit.yml")
    triggers = _triggers(workflow)
    assert "schedule" in triggers
    assert "workflow_dispatch" in triggers
    jobs = workflow["jobs"]
    assert "pip-audit" in _run_text(jobs["python"])
    assert "pnpm audit --prod" in _run_text(jobs["web"])
    # The audited packages are what a user installs, so the mcp extra is in.
    assert '"./server[mcp]"' in _run_text(jobs["python"])
