"""The CI matrix, the package metadata, and ``scripts/ci-matrix.sh`` agree.

``.github/workflows/server.yml`` is where the supported operating systems and
Python versions are listed. Nothing else would notice if a Python version were
dropped from the matrix while its trove classifier stayed, or if the workflow
asked ``scripts/ci-matrix.sh`` for a stage the script does not have. The release
workflow (``publish.yml``) is checked the same way: it must wait for the test
workflows and must build, check, and smoke-test the packages before uploading
them. The acceptance job and the web workflow's end-to-end job are checked for
being real (a placeholder that only echoed once passed as green). No workflow may ask
for a runner image GitHub has retired, and the end-to-end job's Playwright must be one
that installs its browser on the Ubuntu behind ``ubuntu-latest``: each of those fails a
job before its first step, with nothing in the log of the first one. These tests read
the repository files directly, so they skip when the tests run away from a checkout.
The last one reads the test run itself: it keeps a test id that only Windows
refuses from passing on the systems the whole suite runs on.
"""

from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path
from typing import Any

import pytest

from tests._repo import REPO_ROOT, pyproject

pytestmark = pytest.mark.unit

_WORKFLOWS = REPO_ROOT / ".github" / "workflows"
_WORKFLOW = _WORKFLOWS / "server.yml"
_SCRIPT = REPO_ROOT / "scripts" / "ci-matrix.sh"
_E2E_DIR = REPO_ROOT / "web" / "tests" / "e2e"
_PLAYWRIGHT_CONFIG = REPO_ROOT / "web" / "playwright.config.ts"

_REQUIRED_OSES = {"ubuntu-latest", "macos-15", "windows-latest"}

# Runner images GitHub no longer provides (`macos-14` went on 2 November 2026). A job
# that asks for one is cancelled at once with an annotation and no log, which is how
# both macOS legs of the test matrix went red with no step to read.
_RETIRED_RUNNER_IMAGES = (
    "macos-11",
    "macos-12",
    "macos-13",
    "macos-14",
    "ubuntu-18.04",
    "ubuntu-20.04",
    "windows-2019",
)

# The first Playwright release that installs Chromium on Ubuntu 26.04 (its release notes
# say "Playwright now supports Ubuntu 26.04"). `ubuntu-latest` has been moving to that
# image since 19 October 2026, and 1.59 stops with "Playwright does not support chromium
# on ubuntu26.04-x64".
_PLAYWRIGHT_FOR_UBUNTU_26_04 = (1, 61)
_FIRST_UBUNTU_NEEDING_PLAYWRIGHT_1_61 = (26, 4)


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


def _classifier_pythons() -> set[str]:
    prefix = "Programming Language :: Python :: "
    return {
        c.removeprefix(prefix)
        for c in pyproject()["project"]["classifiers"]
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


def _runner_labels(workflow: dict[str, Any]) -> set[str]:
    """Every runner label a workflow's jobs ask for, the entries of a matrix included, in
    lower case (GitHub does not tell ``macOS-14`` from ``macos-14``). A `runs-on` this does
    not read stops the test rather than let a retired image through unseen: an expression
    other than ``matrix.os`` over a list, and a group (a runner group names no image)."""
    labels: set[str] = set()
    for job in workflow.get("jobs", {}).values():
        runs_on = job.get("runs-on", [])
        if isinstance(runs_on, dict):
            # ``{group: ..., labels: ...}``: the labels are the ones that name an image.
            runs_on = runs_on.get("labels", [])
        asked = [runs_on] if isinstance(runs_on, str) else list(runs_on)
        matrix = job.get("strategy", {}).get("matrix", {})
        for label in asked:
            if label == "${{ matrix.os }}":
                entries = matrix["os"]
                assert isinstance(entries, list), f"teach _runner_labels to read {entries!r}"
                labels.update(entries)
                labels.update(entry["os"] for entry in matrix.get("include", []) if "os" in entry)
            else:
                assert "${{" not in label, f"teach _runner_labels to read {label!r}"
                labels.add(label)
    return {label.lower() for label in labels}


def test_the_runner_label_reader_reads_every_form_of_runs_on_or_refuses_it() -> None:
    def labels(job: dict[str, Any]) -> set[str]:
        return _runner_labels({"jobs": {"j": job}})

    assert labels({"runs-on": "macOS-14"}) == {"macos-14"}
    assert labels({"runs-on": {"group": "big", "labels": ["macOS-14-large"]}}) == {"macos-14-large"}
    assert labels({"runs-on": {"group": "big"}}) == set()
    matrix = {"os": ["ubuntu-latest", "macOS-14"], "include": [{"os": "windows-2019"}]}
    assert labels({"runs-on": "${{ matrix.os }}", "strategy": {"matrix": matrix}}) == {
        "ubuntu-latest",
        "macos-14",
        "windows-2019",
    }
    # An expression for the list is not read as the characters of its text.
    with pytest.raises(AssertionError, match="teach _runner_labels"):
        labels({"runs-on": "${{ matrix.os }}", "strategy": {"matrix": {"os": "${{ fromJSON(x) }}"}}})
    with pytest.raises(AssertionError, match="teach _runner_labels"):
        labels({"runs-on": "${{ inputs.runner }}"})


def test_the_ubuntu_of_a_job_is_read_from_its_label() -> None:
    assert _ubuntu_of("ubuntu-latest") is None
    assert _ubuntu_of("Ubuntu-26.04") == (26, 4)
    assert _ubuntu_of("ubuntu-24.04-arm") == (24, 4)
    with pytest.raises(AssertionError, match="teach _ubuntu_of"):
        _ubuntu_of(["self-hosted", "linux"])


def test_no_workflow_asks_for_a_runner_image_that_is_retired() -> None:
    """No job asks for an image GitHub has retired, a matrix entry included. The `-large`,
    `-xlarge` and `-intel` forms of a retired image are retired with it."""
    if not _WORKFLOW.is_file():
        pytest.skip("the workflows are not next to the tests")
    workflows = sorted(_WORKFLOWS.glob("*.yml"))
    assert workflows, "no workflows found"
    for path in workflows:
        labels = _runner_labels(_load(path))
        retired = sorted(
            label
            for label in labels
            for image in _RETIRED_RUNNER_IMAGES
            if label == image or label.startswith(image + "-")
        )
        assert retired == [], f"{path.name} asks for a retired runner image"
    # Guards the reader: the matrix of the test job is among the labels it finds.
    assert _runner_labels(_workflow()) >= _REQUIRED_OSES


def test_test_matrix_pythons_match_the_package_classifiers() -> None:
    """Every declared Python version is tested, and nothing untested is declared."""
    matrix = _workflow()["jobs"]["test"]["strategy"]["matrix"]
    tested = {str(v) for v in matrix["python"]}
    assert tested == _classifier_pythons()
    # Quoted in the workflow: an unquoted 3.10 would load as the float 3.1.
    assert all(isinstance(v, str) for v in matrix["python"])


def test_dev_extra_carries_the_coverage_tooling() -> None:
    dev = " ".join(pyproject()["project"]["optional-dependencies"]["dev"])
    assert "pytest-cov" in dev
    # [tool.coverage.run] patch = ["subprocess"] is rejected by older coverage.
    assert "coverage>=7.10" in dev
    assert pyproject()["tool"]["coverage"]["run"]["patch"] == ["subprocess"]


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
    assert requested.issuperset({"lint", "unit", "smoke", "full", "acceptance"})
    for stage in requested:
        assert re.search(rf"^\s*{stage}\)", script, re.MULTILINE), (
            f"scripts/ci-matrix.sh has no {stage!r} stage"
        )


def test_lint_does_not_wait_for_the_web_build() -> None:
    """Lint, types, and the GUI-parity check read no UI: the editable install's
    build hook skips it and the parity check builds its app with a stand-in for
    the SPA. Waiting for ``web-dist`` held the static checks back behind a pnpm
    install and build for nothing."""
    job = _workflow()["jobs"]["lint"]
    assert "needs" not in job
    assert not [step for step in job["steps"] if "download-artifact" in step.get("uses", "")]
    # The test legs still need it: the smoke test serves the real page.
    assert "web-dist" in _workflow()["jobs"]["test"]["needs"]


def test_the_smoke_test_runs_even_when_the_unit_tests_fail() -> None:
    """An ``if:`` without a status function carries an implicit ``success()``, so
    the smoke step was skipped on macOS and Windows exactly when the unit tests
    failed there, which is when its answer is most needed."""
    steps = _workflow()["jobs"]["test"]["steps"]
    smoke = [s for s in steps if "ci-matrix.sh smoke" in s.get("run", "")]
    assert len(smoke) == 1
    condition = str(smoke[0]["if"])
    assert "!cancelled()" in condition or "always()" in condition


def test_the_acceptance_job_runs_the_acceptance_suite() -> None:
    """The job was an ``echo`` placeholder, so its green check meant nothing."""
    steps = _workflow()["jobs"]["acceptance"]["steps"]
    run = "\n".join(step["run"] for step in steps if "run" in step)
    assert re.search(r"ci-matrix\.sh\s+acceptance\b", run)
    # The suite needs httpx and websockets, which only the dev extra carries.
    assert 'pip install -e "./server[dev]"' in run
    names = " ".join(str(step.get("name", "")) for step in steps).lower()
    assert "placeholder" not in names


def test_one_job_runs_the_mcp_server_on_the_older_major_of_the_sdk() -> None:
    """The ``mcp`` extra takes 1.x and 2.x, and ``[dev]`` installs the newest, so every other
    job only ever sees 2.x. This one installs 1.x and runs the type check and the tests that
    import the MCP server or start it."""
    run = _run_text(_workflow()["jobs"]["mcp-1x"])
    assert 'pip install -e "./server[dev]" "mcp<2"' in run
    assert "mypy --strict src" in run
    assert "tests/unit/test_client_examples.py" in run
    assert "tests/integration/test_examples_api.py" in run


def test_the_acceptance_stage_selects_the_acceptance_marker() -> None:
    if not _SCRIPT.is_file():
        pytest.skip("scripts/ci-matrix.sh is not next to the tests")
    script = _SCRIPT.read_text(encoding="utf-8")
    stage = re.search(r"^\s*acceptance\)\n(.*?)^\s*;;", script, re.MULTILINE | re.DOTALL)
    assert stage is not None, "scripts/ci-matrix.sh has no acceptance stage"
    assert "pytest -m acceptance" in stage.group(1)
    # The default stage stays fast: acceptance is something you ask for.
    all_stage = re.search(r"^\s*all\)\n(.*?)^\s*;;", script, re.MULTILINE | re.DOTALL)
    assert all_stage is not None
    assert "acceptance" not in all_stage.group(1)


def _step_index(steps: list[dict[str, Any]], needle: str) -> int:
    """Position of the one step whose command contains ``needle``."""
    (index,) = [i for i, step in enumerate(steps) if needle in step.get("run", "")]
    return index


def test_the_web_workflow_runs_the_e2e_suite_against_a_started_substrate() -> None:
    workflow = _load(_WORKFLOWS / "web.yml")
    steps = workflow["jobs"]["e2e"]["steps"]
    run = "\n".join(step["run"] for step in steps if "run" in step)
    assert "playwright install" in run
    # The substrate looks for web/dist when it starts, so the UI is built first,
    # and the tests only run once the server is up.
    build = _step_index(steps, "pnpm build")
    serve = _step_index(steps, "tensa serve")
    tests = _step_index(steps, "pnpm test:e2e")
    assert build < serve < tests
    # The tests use the UI the substrate serves, not a Vite dev server.
    env = steps[tests]["env"]
    assert env["E2E_NO_WEBSERVER"] == "1"
    assert env["E2E_BASE_URL"].startswith("http://127.0.0.1:")
    # The suite drives the real server, so a server-only change must run it.
    for event in ("push", "pull_request"):
        assert "server/**" in _triggers(workflow)[event]["paths"], event


@pytest.mark.parametrize(
    ("workflow_file", "job", "first_server_step"),
    [
        ("server.yml", "test", "ci-matrix.sh"),
        ("server.yml", "acceptance", "ci-matrix.sh acceptance"),
        ("web.yml", "e2e", "tensa serve"),
    ],
)
def test_a_job_that_restores_the_andes_cache_stamps_it_before_a_server_starts(
    workflow_file: str, job: str, first_server_step: str
) -> None:
    """``tensa serve`` checks an unstamped cache in a background process, which would
    compete with the tests for a runner's cores. A cache hit is never saved again,
    so a restored entry only gets its stamp from a step that runs after the restore."""
    steps = _load(_WORKFLOWS / workflow_file)["jobs"][job]["steps"]
    (restore,) = [
        i
        for i, step in enumerate(steps)
        if str(step.get("uses", "")).startswith("actions/cache@")
        and step["with"]["path"] == "~/.andes/pycode"
    ]
    warm = _step_index(steps, "tensa warm-cache")
    first_server = min(i for i, step in enumerate(steps) if first_server_step in step.get("run", ""))
    assert restore < warm < first_server


def _read_required(path: Path) -> str:
    """Text of a repository file; a missing one fails in a checkout."""
    if not _WORKFLOW.is_file():
        pytest.skip("the repository files are not next to the tests")
    assert path.is_file(), f"{path.relative_to(REPO_ROOT)} is missing"
    return path.read_text(encoding="utf-8")


def test_the_node_version_is_the_same_wherever_it_is_named() -> None:
    """``web/.nvmrc`` is what ``nvm use`` gives a developer, the workflows' ``node-version``
    what CI runs, and ``engines`` in ``web/package.json`` the oldest that is supported. A
    test that passes on a newer Node can fail on the one CI runs (the two expose different
    globals), so the local default must be CI's, and both the major of the oldest supported,
    whose floor is the minor and patch release of it that the tools need. A newer major may
    need a later release of its own (jsdom asks for 24.15 on Node 24), which ``engines``
    names after it."""
    nvmrc = REPO_ROOT / "web" / ".nvmrc"
    package = REPO_ROOT / "web" / "package.json"
    if not nvmrc.is_file() or not package.is_file():
        pytest.skip("web/ is not next to the tests")
    local = nvmrc.read_text(encoding="utf-8").strip().removeprefix("v")
    assert re.fullmatch(r"\d+", local), f"web/.nvmrc should name a major version, not {local!r}"

    used: dict[str, set[str]] = {}
    for path in sorted(_WORKFLOWS.glob("*.yml")):
        for job in _load(path).get("jobs", {}).values():
            for step in job.get("steps", []):
                if "actions/setup-node" in str(step.get("uses", "")):
                    used.setdefault(str(step["with"]["node-version"]), set()).add(path.name)
    assert used, "no workflow sets up Node"
    assert set(used) == {local}, f"web/.nvmrc says {local}, the workflows use {used}"

    engines = json.loads(package.read_text(encoding="utf-8"))["engines"]["node"]
    oldest, *newer = (part.strip() for part in engines.split("||"))
    assert re.fullmatch(rf"(\^|>=){local}\.\d+\.\d+", oldest), engines
    for later in newer:
        floor = re.fullmatch(r">=(\d+)\.\d+\.\d+", later)
        assert floor is not None and int(floor.group(1)) > int(local), engines


def test_no_e2e_file_depends_on_the_removed_auth_token() -> None:
    """The app has no authentication, so ``ANDES_TEST_TOKEN`` and ``#token=`` lead nowhere."""
    _read_required(_PLAYWRIGHT_CONFIG)
    specs = sorted(_E2E_DIR.glob("*.spec.ts"))
    assert specs, "no Playwright specs found"
    for path in [_PLAYWRIGHT_CONFIG, *specs]:
        text = path.read_text(encoding="utf-8")
        assert "ANDES_TEST_TOKEN" not in text, path.name
        assert "#token=" not in text, path.name


def test_the_flagship_e2e_spec_is_not_skipped() -> None:
    spec = _read_required(_E2E_DIR / "load-pf-flow.spec.ts")
    assert re.search(r"^test\(", spec, re.MULTILINE)
    assert "test.fixme" not in spec
    assert "test.skip" not in spec


def test_every_e2e_spec_ends_the_sessions_its_pages_open() -> None:
    """A page that loads the UI opens a session, and one the test runner closes does not end it.
    ``fixtures.ts`` ends them after each test, for the specs that take ``test``
    from it: one that took Playwright's own would leave its sessions to idle out,
    and enough of those inside three minutes fill the server (``--max-sessions``),
    after which the next page has no session and its test cannot open a case."""
    fixtures = _read_required(_E2E_DIR / "fixtures.ts")
    assert "/api/sessions/" in fixtures and ".delete(" in fixtures
    specs = sorted(_E2E_DIR.glob("*.spec.ts"))
    assert specs, "no Playwright specs found"
    for path in specs:
        text = path.read_text(encoding="utf-8")
        assert "from '@playwright/test'" not in text, path.name
        assert re.search(r"^import \{ test\b[^}]*\} from '\./fixtures';$", text, re.MULTILINE), (
            path.name
        )


def test_the_e2e_job_says_which_closed_page_keeps_its_session() -> None:
    """A tab that a person closes gives its session back as it goes
    (``useSessionRelease.ts``); only a page the test runner closes leaves one behind,
    which is why the fixtures end them. The comment on the job has to say that, and
    not that a closed tab keeps its session, which was true before the UI released it."""
    release = _read_required(REPO_ROOT / "web" / "src" / "api" / "useSessionRelease.ts")
    assert "pagehide" in release and "keepalive" in release
    text = _read_required(_WORKFLOWS / "web.yml")
    comments = " ".join(
        line.strip().lstrip("#").strip()
        for line in text.splitlines()
        if line.strip().startswith("#")
    )
    assert "a closed tab does not end it" not in comments
    assert "a page the test runner closes does not" in comments


def _ubuntu_of(runs_on: Any) -> tuple[int, int] | None:
    """The Ubuntu release a job's ``runs-on`` names, or ``None`` when it names the moving
    ``ubuntu-latest`` (which is on the newest release, so the newest is what to check)."""
    label = runs_on if isinstance(runs_on, str) else ""
    label = label.lower()
    if label == "ubuntu-latest":
        return None
    named = re.fullmatch(r"ubuntu-(\d+)\.(\d+)(?:-.*)?", label)
    assert named is not None, f"teach _ubuntu_of to read the runs-on {runs_on!r} of the e2e job"
    return int(named.group(1)), int(named.group(2))


def test_the_locked_playwright_installs_its_browser_on_the_ubuntu_the_e2e_job_runs_on() -> None:
    """The e2e job installs Chromium with ``playwright install --with-deps``, which an
    older Playwright refuses on a newer Ubuntu before it installs anything. While the
    job rides ``ubuntu-latest`` the lockfile's release (what ``--frozen-lockfile`` gets)
    has to be one that knows the image the label moves to; a job pinned to an image has
    nothing to check here."""
    jobs = _load(_WORKFLOWS / "web.yml")["jobs"]
    ubuntu = _ubuntu_of(jobs["e2e"]["runs-on"])
    if ubuntu is not None and ubuntu < _FIRST_UBUNTU_NEEDING_PLAYWRIGHT_1_61:
        pytest.skip("the e2e job is pinned to an Ubuntu older than 26.04, which Playwright 1.59 handles")
    lock = _read_required(REPO_ROOT / "web" / "pnpm-lock.yaml")
    found = re.search(
        r"^ {6}'@playwright/test':\n {8}specifier: \S+\n {8}version: (\d+)\.(\d+)\.\d+$",
        lock,
        re.MULTILINE,
    )
    assert found is not None, "web/pnpm-lock.yaml has no @playwright/test in its importer"
    locked = (int(found.group(1)), int(found.group(2)))
    assert locked >= _PLAYWRIGHT_FOR_UBUNTU_26_04, (
        f"@playwright/test {found.group(1)}.{found.group(2)} cannot install Chromium on "
        "Ubuntu 26.04: raise it, or pin the e2e job to an Ubuntu image Playwright supports"
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


_DEPENDABOT = REPO_ROOT / ".github" / "dependabot.yml"


def _load_required(path: Path) -> dict[str, Any]:
    """Like ``_load``, but a missing file fails when the other workflows are here.

    Away from a checkout there is nothing to read and the test skips. In a
    checkout, deleting the file must not turn its tests into silent skips.
    """
    if _WORKFLOW.is_file():
        assert path.is_file(), f"{path.relative_to(REPO_ROOT)} is missing"
    return _load(path)


def test_dependabot_watches_every_manifest_monthly() -> None:
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
        assert (REPO_ROOT / directory.lstrip("/") / manifest).is_file(), update
        assert update["schedule"]["interval"] == "monthly"


def test_dependabot_sends_one_pull_request_per_ecosystem_with_every_kind_of_update() -> None:
    """Three pull requests a month and not a dozen: each ecosystem has one group that takes
    every dependency (``*``) and every update type (no ``update-types`` filter)."""
    updates = _load_required(_DEPENDABOT)["updates"]
    for update in updates:
        groups = update["groups"]
        assert len(groups) == 1, update["package-ecosystem"]
        (group,) = groups.values()
        assert group["patterns"] == ["*"], update["package-ecosystem"]
        assert "update-types" not in group, update["package-ecosystem"]


def test_dependabot_does_not_raise_a_lower_bound_a_library_does_not_need_raised() -> None:
    """The server is a library: a requirement changes only when the newest release is outside
    it, so a pull request does not raise ``uvicorn>=0.30`` to the newest for no reason."""
    updates = _load_required(_DEPENDABOT)["updates"]
    (pip,) = [u for u in updates if u["package-ecosystem"] == "pip"]
    assert pip["versioning-strategy"] == "increase-if-necessary"


def test_dependabot_leaves_andes_minor_and_major_upgrades_to_a_person() -> None:
    """AGENTS.md: ANDES upgrades are deliberate, never an automatic minor bump."""
    updates = _load_required(_DEPENDABOT)["updates"]
    (pip,) = [u for u in updates if u["package-ecosystem"] == "pip"]
    (andes,) = [i for i in pip["ignore"] if i["dependency-name"] == "andes"]
    assert set(andes["update-types"]) == {
        "version-update:semver-major",
        "version-update:semver-minor",
    }


def test_dependabot_leaves_juliacall_to_a_person() -> None:
    """The sienna extra pins the juliacall whose PythonCall the shipped Julia Manifest
    holds; a new one needs a new Manifest, which no pull request of Dependabot makes."""
    updates = _load_required(_DEPENDABOT)["updates"]
    (pip,) = [u for u in updates if u["package-ecosystem"] == "pip"]
    (juliacall,) = [i for i in pip["ignore"] if i["dependency-name"] == "juliacall"]
    assert "update-types" not in juliacall and "versions" not in juliacall


def test_the_node_types_stay_on_the_major_of_the_oldest_supported_node() -> None:
    """``@types/node`` describes one major of Node's API. On a newer one than the oldest
    Node the UI supports (``engines``, the one CI runs), a configuration or a test that
    calls what that Node lacks type-checks and fails on CI, so the types follow
    ``engines`` and Dependabot does not propose their next major."""
    updates = _load_required(_DEPENDABOT)["updates"]
    (npm,) = [u for u in updates if u["package-ecosystem"] == "npm"]
    (types,) = [i for i in npm.get("ignore", []) if i["dependency-name"] == "@types/node"]
    assert types["update-types"] == ["version-update:semver-major"]
    package = REPO_ROOT / "web" / "package.json"
    if not package.is_file():
        pytest.skip("web/ is not next to the tests")
    declared = json.loads(package.read_text(encoding="utf-8"))
    floor = re.match(r"(?:\^|>=)(\d+)\.", declared["engines"]["node"])
    typed = re.fullmatch(r"\^(\d+)\.\d+\.\d+", declared["devDependencies"]["@types/node"])
    assert floor is not None and typed is not None, declared["engines"]
    assert typed.group(1) == floor.group(1)


def test_audit_workflow_checks_both_halves_on_a_schedule() -> None:
    """Advisories appear without a commit, so the audit also runs weekly and on demand."""
    workflow = _load_required(_WORKFLOWS / "audit.yml")
    triggers = _triggers(workflow)
    assert "schedule" in triggers
    assert "workflow_dispatch" in triggers
    jobs = workflow["jobs"]
    assert "pip-audit" in _run_text(jobs["python"])
    assert "pnpm audit --prod" in _run_text(jobs["web"])
    # The audited packages are what a user installs, so the mcp extra is in,
    # on both majors of the SDK it allows.
    python = _run_text(jobs["python"])
    assert '"./server[mcp]"' in python
    assert '"./server[mcp]" "mcp<2"' in python
    assert python.count("pip-audit --path") == 2


# Windows caps one environment variable, name and value together, at 32767
# characters, and pytest keeps the id of the running test in one.
_WINDOWS_ENV_MAX = 32767


def test_every_test_id_fits_in_a_windows_environment_variable(
    request: pytest.FixtureRequest,
) -> None:
    """A parametrized value is part of its test's id unless the case is given an
    ``id``. An id past the limit runs everywhere but on Windows, where pytest
    cannot set ``PYTEST_CURRENT_TEST`` and the test errors at setup and at
    teardown. This fails on every system instead, for the tests this run
    collected."""
    too_long = [
        f"{item.nodeid[:100]}... ({len(item.nodeid)} characters)"
        for item in request.session.items
        if len(f"PYTEST_CURRENT_TEST={item.nodeid} (teardown)") > _WINDOWS_ENV_MAX
    ]
    assert too_long == []


_SIENNA_WORKFLOW = _WORKFLOWS / "sienna.yml"
_SIENNA_MANIFEST = (
    REPO_ROOT / "server" / "src" / "tensa" / "engines" / "sienna" / "envs" / "dyn" / "Manifest.toml"
)


def _sienna_workflow() -> dict[str, Any]:
    return _load_required(_SIENNA_WORKFLOW)


def _sienna_step_using(action: str) -> dict[str, Any]:
    steps = _sienna_workflow()["jobs"]["sienna"]["steps"]
    (step,) = [step for step in steps if str(step.get("uses", "")).startswith(action + "@")]
    return step


def test_the_sienna_workflow_exists_parses_and_triggers_on_the_server_push_branches() -> None:
    """The engine's tests skip in every other job, so this workflow is what holds
    Sienna on CI. Its push branches are server.yml's exactly, the temporary
    branch included, so an engine change on such a branch is tested there."""
    workflow = _sienna_workflow()
    assert workflow["name"] == "sienna"
    assert "sienna" in workflow["jobs"]
    triggers = _triggers(workflow)
    server_branches = _triggers(_workflow())["push"]["branches"]
    assert triggers["push"]["branches"] == server_branches
    assert "pull_request" in triggers
    assert "workflow_dispatch" in triggers
    assert workflow["permissions"] == {"contents": "read"}


def test_the_sienna_workflow_installs_the_julia_the_packaged_manifest_was_resolved_for() -> None:
    """The setup refuses a Julia whose major.minor is not the Manifest's, so the
    workflow's Julia must be the Manifest's. The test reads ``julia_version`` from
    the Manifest itself, so a re-resolved Manifest cannot leave CI on another
    Julia, and the depot's cache key names the Julia the job installs."""
    manifest = tomllib.loads(_read_required(_SIENNA_MANIFEST))
    major_minor = ".".join(str(manifest["julia_version"]).split(".")[:2])
    version = str(_sienna_step_using("julia-actions/setup-julia")["with"]["version"])
    assert version.startswith(major_minor + "."), (version, manifest["julia_version"])
    assert f"julia-{version}-" in _sienna_step_using("actions/cache")["with"]["key"]


def test_the_sienna_depot_cache_key_hashes_the_manifest_and_names_a_real_path() -> None:
    """The depot is only wanted for the Manifest it was built from, so the key
    hashes it and has no restore-keys. A key that named a moved file would hash
    nothing and silently share one depot across Manifests."""
    options = _sienna_step_using("actions/cache")["with"]
    assert options["path"] == "~/.julia"
    assert "restore-keys" not in options
    hashed = re.search(r"hashFiles\('([^']+)'\)", options["key"])
    assert hashed is not None, options["key"]
    assert hashed.group(1) == _SIENNA_MANIFEST.relative_to(REPO_ROOT).as_posix()
    assert _SIENNA_MANIFEST.is_file()


def test_the_sienna_job_sets_the_environment_up_and_runs_both_test_suites() -> None:
    """The project's own command sets the environment up before any test runs,
    the Julia module's own test file runs against it, and pytest selects the
    tests marked sienna with the project named. The job must not set
    TENSA_SIENNA_SKIP_STAMP, which would let a half-set-up project pass for
    ready, and a test that skips fails the job (the JUnit report is read)."""
    job = _sienna_workflow()["jobs"]["sienna"]
    steps = job["steps"]
    warm = _step_index(steps, "tensa warm-cache --engine sienna")
    julia_tests = _step_index(steps, "server/tests/julia/runtests.jl")
    pytest_tests = _step_index(steps, "pytest -m sienna")
    assert warm < julia_tests < pytest_tests
    assert (REPO_ROOT / "server" / "tests" / "julia" / "runtests.jl").is_file()
    assert "TENSA_SIENNA_PROJECT" in steps[pytest_tests]["env"]
    assert "--junitxml" in steps[pytest_tests]["run"]
    assert '.find("skipped")' in steps[pytest_tests]["run"]
    # The steps pipe into tee, which hides a failure unless bash runs with
    # pipefail, and GitHub gives it that only when the shell is named.
    assert job["defaults"]["run"]["shell"] == "bash"
    assert "TENSA_SIENNA_SKIP_STAMP" not in _read_required(_SIENNA_WORKFLOW)


def test_the_sienna_job_passes_pytest_no_option_of_a_plugin_the_dev_extra_lacks() -> None:
    """``--timeout`` is pytest-timeout's, which is not a dependency of the
    project: on a runner pytest would stop on the unknown option."""
    run = _run_text(_sienna_workflow()["jobs"]["sienna"])
    dev = " ".join(pyproject()["project"]["optional-dependencies"]["dev"])
    if "pytest-timeout" not in dev:
        assert "--timeout" not in run


def _matches_a_file(pattern: str) -> bool:
    """Whether a workflow ``paths`` pattern matches a file of the checkout. A
    pattern ending in ``/**`` matches every file under its folder."""
    if pattern.endswith("/**"):
        folder = REPO_ROOT / pattern.removesuffix("/**")
        return folder.is_dir() and any(path.is_file() for path in folder.rglob("*"))
    return any(path.is_file() for path in REPO_ROOT.glob(pattern))


def test_every_path_filter_of_the_sienna_workflow_matches_an_existing_file() -> None:
    """A paths filter that names a moved file matches nothing, and the job then
    never runs for the change it was written for, with no error anywhere. Each
    filter must match at least one file that is in the repository, and the push
    and pull request filters are the same list."""
    triggers = _triggers(_sienna_workflow())
    filters = triggers["push"]["paths"]
    assert filters == triggers["pull_request"]["paths"]
    assert filters, "the sienna workflow has no paths filters"
    for pattern in filters:
        assert _matches_a_file(pattern), f"paths filter {pattern!r} matches no file"


def test_the_paper_draft_is_built_with_the_open_journals_action_and_kept_as_an_artifact() -> None:
    """The submission form asks the author to confirm that the paper compiles. This is the
    check that it does: the journal's own action, on a push that changes ``paper/``."""
    workflow = _load_required(_WORKFLOWS / "draft-pdf.yml")
    triggers = _triggers(workflow)
    assert "paper/**" in triggers["push"]["paths"]
    assert "workflow_dispatch" in triggers
    assert workflow["permissions"] == {"contents": "read"}

    steps = workflow["jobs"]["paper"]["steps"]
    uses = [str(step.get("uses", "")) for step in steps]
    (build,) = [
        i for i, name in enumerate(uses) if name.startswith("openjournals/openjournals-draft-action@")
    ]
    (upload,) = [i for i, name in enumerate(uses) if name.startswith("actions/upload-artifact@")]
    assert uses[0].startswith("actions/checkout@") and 0 < build < upload
    # The action has no release tags, and `master` moves: the build is pinned to a commit of it,
    # so a paper builds the same way twice, and the checkout is the major the server workflow uses.
    assert re.fullmatch(r"openjournals/openjournals-draft-action@[0-9a-f]{40}", uses[build])
    server_checkouts = {
        str(step["uses"])
        for job in _load(_WORKFLOW)["jobs"].values()
        for step in job.get("steps", [])
        if str(step.get("uses", "")).startswith("actions/checkout@")
    }
    assert server_checkouts == {uses[0]}

    options = steps[build]["with"]
    assert options == {"journal": "joss", "paper-path": "paper/paper.md"}
    assert (REPO_ROOT / options["paper-path"]).is_file()
    # The action writes the PDF beside the paper, and the upload must read it from there.
    assert steps[upload]["with"]["path"] == "paper/paper.pdf"
    assert steps[upload]["with"]["if-no-files-found"] == "error"
