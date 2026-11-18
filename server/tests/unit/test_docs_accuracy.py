"""The documentation and the user-facing strings say what the code does.

Each check here is a drift that happened once: a README flag the CLI never had,
a default that was wrong, an OpenAPI summary promising a feature that had long
shipped, a description pointing at a route that does not exist. The checks read
the repository files and the live OpenAPI schema, so they skip when run away
from a checkout.
"""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
import typer
from starlette.testclient import TestClient

from tensa import cli, desktop
from tensa.api.app import make_app
from tensa.api.routes.reports import ReportRoutineEnum
from tensa.api.schemas import TdsTraces, TdsTraceSeries
from tensa.core.example_catalog import load_catalog
from tests._cli import cli_runner
from tests._repo import REPO_ROOT, pyproject

pytestmark = pytest.mark.unit


def _read(relative: str) -> str:
    path = REPO_ROOT / relative
    if not path.is_file():
        pytest.skip(f"{relative} is not next to the tests")
    return path.read_text(encoding="utf-8")


def _command_options(command: str) -> dict[str, Any]:
    """The long options of a ``tensa`` command, keyed by flag (``--help`` excluded).

    Typer ships its own copy of click's classes, so the options are read by attribute rather
    than by ``isinstance``.
    """
    found = typer.main.get_command(cli.app).commands[command]  # type: ignore[attr-defined]
    return {opt: param for param in found.params for opt in param.opts if opt.startswith("--")}


def _least(option: Any) -> Any:
    """The least value an option accepts: on its click type, or on the option itself in Typer
    0.29 and later, which have no click types."""
    return option.type.min if hasattr(option, "type") else option.min


def _serve_options() -> dict[str, Any]:
    return _command_options("serve")


# ---- the CLI documentation ---------------------------------------------------


def _documented_flags(command: str) -> dict[str, str]:
    """Flag -> its bullet in server/README.md's flag list of a command: the run of bullets
    that follows the line "`tensa <command>` flags:"."""
    lines = _read("server/README.md").splitlines()
    heading = f"`tensa {command}` flags:"
    assert heading in lines, f"server/README.md has no {heading!r} line"
    bullets: dict[str, str] = {}
    for line in lines[lines.index(heading) + 1 :]:
        if not line.strip() and not bullets:
            continue
        found = re.match(r"^- `(--[a-z][a-z-]*)[^`]*`.*$", line)
        if found is None:
            break
        bullets[found.group(1)] = line
    assert bullets, f"no flag bullets found under {heading!r}"
    return bullets


def _documented_serve_flags() -> dict[str, str]:
    return _documented_flags("serve")


def test_server_readme_lists_exactly_the_serve_flags_that_exist() -> None:
    documented = set(_documented_serve_flags())
    real = set(_serve_options())
    assert not documented - real, f"documented, not accepted: {sorted(documented - real)}"
    assert not real - documented, f"accepted, not documented: {sorted(real - documented)}"


def test_server_readme_states_the_real_defaults() -> None:
    bullets = _documented_serve_flags()
    options = _serve_options()

    def stated(flag: str, value: str) -> bool:
        return f"Default `{value}`" in bullets[flag]

    sessions = options["--max-sessions"].default
    assert stated("--max-sessions", f"{sessions:g}"), bullets["--max-sessions"]
    idle = options["--idle-timeout-seconds"].default
    assert stated("--idle-timeout-seconds", f"{idle:g}"), bullets["--idle-timeout-seconds"]
    workspace = options["--workspace"].default
    home_relative = "~/" + Path(workspace).relative_to(Path.home()).as_posix()
    assert stated("--workspace", home_relative), bullets["--workspace"]


def test_server_readme_lists_exactly_the_desktop_flags_that_exist() -> None:
    documented = set(_documented_flags("desktop"))
    real = set(_command_options("desktop"))
    assert not documented - real, f"documented, not accepted: {sorted(documented - real)}"
    assert not real - documented, f"accepted, not documented: {sorted(real - documented)}"


def test_server_readme_states_the_real_desktop_defaults() -> None:
    bullets = _documented_flags("desktop")
    options = _command_options("desktop")

    def stated(flag: str, value: str) -> bool:
        return f"Default `{value}`" in bullets[flag]

    for flag in ("--max-sessions", "--idle-timeout-seconds", "--width", "--height"):
        default = options[flag].default
        assert stated(flag, f"{default:g}"), bullets[flag]
    workspace = options["--workspace"].default
    home_relative = "~/" + Path(workspace).relative_to(Path.home()).as_posix()
    assert stated("--workspace", home_relative), bullets["--workspace"]
    # The window sizes the readme gives as least are the ones the command refuses to go below.
    assert f"at least `{_least(options['--width'])}`" in bullets["--width"]
    assert f"at least `{_least(options['--height'])}`" in bullets["--height"]


def test_server_readme_gives_the_linux_fixes_the_desktop_command_gives() -> None:
    """The package a Linux user is told to install when a toolkit cannot start, and the
    way to make a virtual environment see GTK, read the same in the README as in the
    command's own messages (a message that moves on without the README sends people to a
    package that is no longer the answer)."""
    readme = _read("server/README.md")
    commands = [
        line.split(":", 1)[1].strip()
        for block in (desktop.XCB_CURSOR_INSTALL, desktop.WEBKITGTK_INSTALL)
        for line in block.splitlines()
    ]
    # One for each of the three families of distribution, for each of the two.
    assert len(commands) == 6
    for command in commands:
        assert re.fullmatch(r"sudo (?:apt install|dnf install|pacman -S) [\w. -]+", command)
        assert command in readme, command
    # The warning that stands in when the toolkit could not be tried names the same ones.
    for command in commands[:3]:
        assert command in desktop.QT_NEEDS_XCB_CURSOR
    assert "--system-site-packages" in readme
    # The one install command of each system, as the help and the messages give it.
    for platform in ("linux", "win32", "darwin"):
        assert desktop.install_command(platform=platform, extras=["desktop"]) in readme, platform
    assert "tensa serve --open" in readme


@pytest.mark.parametrize(
    "document",
    [
        "README.md",
        "CONTRIBUTING.md",
        "server/README.md",
        "web/README.md",
        "examples/README.md",
        "llms.txt",
    ],
)
def test_every_serve_flag_a_document_uses_exists(document: str) -> None:
    real = set(_serve_options())
    used: set[str] = set()
    for line in _read(document).splitlines():
        if "tensa serve" in line:
            used.update(re.findall(r"(?<![\w-])(--[a-z][a-z-]*)", line))
    assert used - real == set(), f"{document} passes flags `tensa serve` does not have"


@pytest.mark.parametrize("document", ["README.md", "server/README.md"])
def test_every_desktop_flag_a_document_uses_exists(document: str) -> None:
    real = set(_command_options("desktop"))
    used: set[str] = set()
    for line in _read(document).splitlines():
        if "tensa desktop" in line:
            used.update(re.findall(r"(?<![\w-])(--[a-z][a-z-]*)", line))
    assert used - real == set(), f"{document} passes flags `tensa desktop` does not have"


@pytest.mark.parametrize(
    "document",
    ["README.md", "server/README.md", "docs/agents.md", "docs/install.md", "llms.txt"],
)
def test_every_mcp_command_a_document_shows_says_where_the_server_is(document: str) -> None:
    """``tensa mcp`` takes exactly one of ``--workspace`` and ``--url`` and stops without
    one, so a command shown bare does not run."""
    fences = re.findall(r"```\w*\n(.*?)```", _read(document), flags=re.DOTALL)
    commands = [
        line.strip()
        for body in fences
        for line in body.splitlines()
        if re.match(r"\s*tensa mcp\b", line)
    ]
    for command in commands:
        assert ("--workspace" in command) != ("--url" in command), f"{document}: {command}"


@pytest.mark.parametrize(
    ("command", "install"),
    [("mcp", 'pip install "tensa[mcp]"'), ("desktop", 'pip install "tensa[desktop]"')],
)
def test_the_help_of_a_command_names_the_extra_it_needs(command: str, install: str) -> None:
    """The help is printed through Rich, which reads ``[mcp]`` as a style and prints
    nothing for it: ``tensa mcp --help`` said to ``pip install 'tensa'``."""
    result = cli_runner().invoke(cli.app, [command, "--help"])
    assert result.exit_code == 0, result.output
    assert install in " ".join(result.output.split())


def test_readmes_say_windows_on_arm_is_unsupported() -> None:
    # kvxopt (through ANDES) and pyarrow publish no win_arm64 wheels, so pip cannot install it.
    for document in ("README.md", "server/README.md", "CONTRIBUTING.md"):
        text = _read(document)
        assert "Windows on ARM is not supported" in text, document


def test_server_readme_reads_on_pypi() -> None:
    """``server/README.md`` is the package's long description, so it is written for a
    reader who has not cloned anything: it opens with how to install, and every link is
    absolute because PyPI does not resolve relative ones."""
    assert pyproject()["project"]["readme"] == "README.md"
    text = _read("server/README.md")
    assert "pip install tensa" in text
    assert text.index("pip install tensa") < text.index("pip install -e")
    targets = re.findall(r"\]\(([^)\s]+)\)", text)
    assert targets, "no links found in server/README.md"
    relative = [t for t in targets if not t.startswith(("https://", "http://"))]
    assert not relative, f"relative links do not resolve on PyPI: {relative}"


@pytest.mark.parametrize("document", ["llms.txt", "server/README.md"])
def test_api_docs_tell_callers_to_label_json_bodies(document: str) -> None:
    # FastAPI 0.133+ answers 422 to a JSON body without this header, which is what a
    # hand-built request (curl -d, requests' data=) sends.
    assert "Content-Type: application/json" in _read(document)


def _fenced(document: str, language: str) -> str:
    fences = re.findall(r"```(\w+)\n(.*?)```", _read(document), flags=re.DOTALL)
    return "\n".join(body for lang, body in fences if lang == language)


def test_the_readme_shows_only_commands_that_run_in_every_shell() -> None:
    """The README is where a Windows user starts too, and it has no PowerShell version
    of its commands: each one runs as written in PowerShell, in ``cmd.exe`` and in a POSIX
    shell. What only a POSIX shell takes (activating an environment, a variable set in
    front of a command) is in the pages that give both versions, below."""
    bash = _fenced("README.md", "bash")
    assert "pip install tensa" in bash and "tensa serve --open" in bash
    assert "source " not in bash
    assert "&&" not in bash
    assert "$(" not in bash and "`" not in bash
    assert not re.search(r"\\\n", bash)
    assert not re.search(r"^\s*[A-Z_]+=\S+ \S", bash, flags=re.MULTILINE)
    assert _fenced("README.md", "powershell") == ""


def test_contributing_gives_powershell_equivalents_for_the_posix_only_commands() -> None:
    bash = _fenced("CONTRIBUTING.md", "bash")
    powershell = _fenced("CONTRIBUTING.md", "powershell")
    contributing = _read("CONTRIBUTING.md")
    assert "source .venv/bin/activate" in bash
    assert r".venv\Scripts\Activate.ps1" in contributing
    assert re.search(r"VITE_ANDES_PORT=\d+ pnpm dev", bash)
    assert re.search(r'^\$env:VITE_ANDES_PORT = "\d+"$', powershell, flags=re.MULTILINE)
    # `&&` is not a statement separator in Windows PowerShell 5.1.
    assert "&&" not in powershell


def test_the_dev_mode_command_admits_the_vite_origin() -> None:
    # Without --allow-origin, requests that carry the dev server's Origin get a 400.
    for document in ("CONTRIBUTING.md", "web/README.md"):
        lines = [
            line
            for line in _read(document).splitlines()
            if "tensa serve" in line and "5173" in line
        ]
        assert lines, f"{document} has no dev-mode `tensa serve` line"
        assert all("--allow-origin http://127.0.0.1:5173" in line for line in lines), document
    # The README sends a contributor to CONTRIBUTING.md for it; a line it has is held too.
    readme = [line for line in _read("README.md").splitlines() if "5173" in line]
    assert all("--allow-origin http://127.0.0.1:5173" in line for line in readme)
    assert "CONTRIBUTING.md" in _read("README.md")


def test_the_demo_recorder_presses_all_modes_only_while_modes_are_hidden() -> None:
    """**All modes** of the eigenvalue scatter is a toggle, and the scatter opens on every
    mode when none is poorly damped. A recorder that pressed it without looking hid them
    all, and the README's demo ended on an empty plot."""
    scatter = _read("web/src/components/analyze/EIGScatter.tsx")
    assert 'data-testid="eig-scatter-filter-toggle"' in scatter
    assert "aria-pressed={showingAll}" in scatter
    recorder = _read("web/scripts/agent-demo.mjs")
    toggle = recorder.index("eig-scatter-filter-toggle")
    after = recorder[toggle : toggle + 800]
    assert "getAttribute('aria-pressed')" in after
    assert re.search(r"if \(!showingAll\) await \w+\.click\(\)", after)


# ---- stale planning text -----------------------------------------------------

# A promise about the future ("lands in Phase 2"), a plan reference, or a query parameter that
# never existed.
_FORWARD_LOOKING = re.compile(
    r"\b(?:lands?|ships?|arrives?)\s+in\s+(?:Unit|Phase|v\d)"
    r"|\bwill\s+land\b"
    r"|\bfuture\s+plan\b"
    r"|\bper\s+Phase\s+[A-Z0-9]\b"
    r"|\?stream=ws"
    r"|\bin\s+v0\.1\b",
    flags=re.IGNORECASE,
)


def _strings(node: Any, path: str = "") -> list[tuple[str, str]]:
    if isinstance(node, dict):
        return [s for k, v in node.items() for s in _strings(v, f"{path}/{k}")]
    if isinstance(node, list):
        return [s for i, v in enumerate(node) for s in _strings(v, f"{path}[{i}]")]
    if isinstance(node, str):
        return [(path, node)]
    return []


@pytest.fixture(scope="module")
def openapi_schema(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    return make_app(workspace=tmp_path_factory.mktemp("workspace")).openapi()


def test_openapi_text_makes_no_promise_about_the_future(
    openapi_schema: dict[str, Any],
) -> None:
    found = [
        f"{where}: {text[:100]!r}"
        for where, text in _strings(openapi_schema)
        if _FORWARD_LOOKING.search(text)
    ]
    assert not found, "stale planning text in the API schema:\n" + "\n".join(found)


# A pointer into the planning documents, which are not in the repository: a "Unit 5b" or
# "KTD-20" tag, a "v3.1 plan", or a path under ``docs/plans``.
_PLAN_PROVENANCE = re.compile(r"\bKTD-\d+|\bUnit\s+\d+|\bv\d+\.\d+\s+plan\b|docs/plans/")


def test_openapi_text_carries_no_plan_provenance(openapi_schema: dict[str, Any]) -> None:
    """The schema is public output (``/openapi.json``, the generated web types, the
    docs a client reads): a tag that points into the planning documents tells its
    reader nothing."""
    found = [
        f"{where}: {m.group(0)!r} in {text[:80]!r}"
        for where, text in _strings(openapi_schema)
        for m in [_PLAN_PROVENANCE.search(text)]
        if m
    ]
    assert not found, "plan provenance in the API schema:\n" + "\n".join(found)


def test_openapi_text_only_names_routes_that_exist(openapi_schema: dict[str, Any]) -> None:
    def normalize(path: str) -> str:
        path = re.sub(r"\{[^}]*\}", "{}", path)
        return path.removeprefix("/api").rstrip("/")

    routes = {
        (method.upper(), normalize(path))
        for path, methods in openapi_schema["paths"].items()
        for method in methods
    }

    def exists(method: str, mentioned: str) -> bool:
        # Descriptions often drop the ``/sessions/{id}`` prefix ("POST /reload"), so a mentioned
        # path matches any route that ends with it on a segment boundary.
        wanted = normalize(mentioned)
        return any(m == method and (p == wanted or p.endswith(wanted)) for m, p in routes)

    mention = re.compile(r"\b(GET|POST|PUT|PATCH|DELETE)\s+(/[A-Za-z0-9_\-./{}]*[A-Za-z0-9_}])")
    missing = [
        f"{where}: {m.group(1)} {m.group(2)}"
        for where, text in _strings(openapi_schema)
        for m in mention.finditer(text)
        if not exists(m.group(1), m.group(2))
    ]
    assert not missing, "descriptions name routes that do not exist:\n" + "\n".join(missing)


def test_save_case_schema_says_raw_is_supported(openapi_schema: dict[str, Any]) -> None:
    schemas = openapi_schema["components"]["schemas"]
    request = schemas["SaveCaseRequest"]
    assert "raw" in request["properties"]["format"]["enum"]
    assert not re.search(r"only xlsx and json|raw.{0,40}not supported", request["description"], re.S)


def test_cli_strings_name_no_future_plan() -> None:
    source = Path(cli.__file__).read_text(encoding="utf-8")
    found = [
        node.value[:100]
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and _FORWARD_LOOKING.search(node.value)
    ]
    assert not found, found


def test_package_metadata_and_workflows_carry_no_stale_planning_text() -> None:
    description = json.loads(_read("web/package.json"))["description"]
    assert not re.search(r"\bv\d+\.\d+|\bUnit\s+\d", description), description
    # publish.yml exists, so a note about an "eventual" publish workflow is stale.
    for workflow in sorted((REPO_ROOT / ".github" / "workflows").glob("*.yml")):
        text = workflow.read_text(encoding="utf-8")
        assert not re.search(r"\beventual\b|\blands when\b", text), workflow.name
        # Plan-provenance tags (a "Unit 16" or "KTD-12" note) and a version in the workflow's
        # name, which is what the checks are listed under on a pull request.
        tag = re.search(r"\bKTD-\d+|\bUnit\s+\d+|^name:.*\bv\d+\.\d+", text, re.MULTILINE)
        assert tag is None, f"{workflow.name} mentions {tag and tag.group(0)!r}"


# The single files that became packages: ``api/schemas/``, ``core/wrapper/`` and
# ``core/session/`` on the server, ``api/queries/`` in the web UI. No file of those names
# is left, so a comment or a page that still names one points at nothing.
_SPLIT_MODULE = re.compile(r"(?<![\w-])(?:schemas|wrapper|session)\.py\b|(?<![\w-])queries\.ts\b")
_TEXT_SUFFIXES = {".py", ".ts", ".tsx", ".md", ".yml", ".toml", ".txt", ".sh", ".mjs", ".json"}
_NOT_SOURCE = {"node_modules", "dist", "site", "__pycache__", ".venv", "coverage", "htmlcov"}


def _written_by_hand() -> list[Path]:
    """The text files someone wrote: the sources and the tests of both packages, the web
    scripts, the pages, the examples, the scripts and the workflows, with the pages at the
    top of the repository, of ``server/`` and of ``web/``. Left out are ``CHANGELOG.md``,
    which tells the history with the names of its time, ``paper/``, whatever is installed or
    built, and this file, which has to spell what it looks for."""
    roots = [
        REPO_ROOT / "server" / "src",
        REPO_ROOT / "server" / "tests",
        REPO_ROOT / "web" / "src",
        REPO_ROOT / "web" / "tests",
        REPO_ROOT / "web" / "scripts",
        REPO_ROOT / "docs",
        REPO_ROOT / "examples",
        REPO_ROOT / "scripts",
        REPO_ROOT / ".github",
    ]
    if not all(root.is_dir() for root in roots):
        pytest.skip("the repository is not next to the tests")
    files = [path for root in roots for path in root.rglob("*")]
    for folder in (REPO_ROOT, REPO_ROOT / "server", REPO_ROOT / "web"):
        files += [*folder.glob("*.md"), *folder.glob("*.txt")]
    kept: list[Path] = []
    for path in files:
        if path.suffix not in _TEXT_SUFFIXES or not path.is_file():
            continue
        relative = path.relative_to(REPO_ROOT)
        if _NOT_SOURCE & set(relative.parts) or relative.as_posix() == "CHANGELOG.md":
            continue
        if path == Path(__file__).resolve():
            continue
        kept.append(path)
    return kept


def _lines_with(pattern: re.Pattern[str]) -> list[str]:
    """``path:line: match`` for every line of a hand-written file that ``pattern`` finds."""
    found: list[str] = []
    for path in _written_by_hand():
        relative = path.relative_to(REPO_ROOT).as_posix()
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            match = pattern.search(line)
            if match:
                found.append(f"{relative}:{number}: {match.group(0)}")
    return found


def test_nothing_names_a_module_that_became_a_package() -> None:
    # The files themselves are gone, which is what makes a mention of one stale.
    for gone in (
        "server/src/tensa/api/schemas.py",
        "server/src/tensa/core/wrapper.py",
        "server/src/tensa/core/session.py",
        "web/src/api/queries.ts",
    ):
        assert not (REPO_ROOT / gone).exists(), gone
    stale = _lines_with(_SPLIT_MODULE)
    assert not stale, "these name a file that is now a package:\n" + "\n".join(stale)


# The folder the commands on the pages keep their cases in. It was ``~/andes-cases`` while
# the project was called ANDES App.
_OLD_CASES_FOLDER = re.compile(r"andes-cases", flags=re.IGNORECASE)


def test_every_page_and_help_text_names_the_same_cases_folder() -> None:
    """A reader takes a command from one page and the next from another, and a folder
    that changes its name on the way reads as two folders. The README and the site had
    moved to ``~/tensa-cases`` while the help of ``tensa mcp``, which the site prints in its
    command reference, the examples and ``CONTRIBUTING.md`` still said ``~/andes-cases``."""
    stale = _lines_with(_OLD_CASES_FOLDER)
    assert not stale, "these still name the old cases folder:\n" + "\n".join(stale)
    result = cli_runner().invoke(cli.app, ["mcp", "--help"])
    assert result.exit_code == 0, result.output
    assert "tensa mcp --workspace ~/tensa-cases" in " ".join(result.output.split())
    for document in ("CONTRIBUTING.md", "examples/README.md", "examples/run_fault_study.py"):
        assert "tensa serve --workspace ~/tensa-cases" in _read(document), document


# ---- what a reader who runs the pages literally finds -------------------------

# A run's traces are one ``t`` and a list of ``{name, values}``; the metrics route takes a
# series with its own ``t`` and ``y``, and the COMTRADE route ``channels``. The batch
# routes' ``TdsTraces`` is what a real run answers with, so the snippets are fed that.
_TRACES = TdsTraces(
    t=[0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0],
    variables=[
        TdsTraceSeries(name="omega GENROU 1", values=[1.0, 1.001, 1.004, 1.0, 0.998, 1.0, 1.0]),
        TdsTraceSeries(name="omega GENROU 2", values=[1.0, 1.002, 1.006, 1.001, 0.997, 1.0, 1.0]),
    ],
    truncated=False,
).model_dump()


def _python_blocks(text: str) -> list[str]:
    return re.findall(r"```python\n(.*?)```", text, flags=re.DOTALL)


def _client(tmp_path: Path) -> TestClient:
    return TestClient(
        make_app(workspace=tmp_path, static_override=tmp_path),
        base_url="http://127.0.0.1:8000",
    )


def test_the_api_guides_snippet_sends_a_batch_runs_traces_the_way_the_routes_take_them(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The guide said to feed ``traces`` to the metrics and COMTRADE routes as they are, and both
    answered 422. The snippet that replaced it is run here, with the batch run answered by a
    stand-in and the two routes by the app itself."""
    (block,) = [b for b in _python_blocks(_read("docs/api.md")) if "/response-metrics" in b]
    assert block.startswith("import httpx\n")
    answers: dict[str, Any] = {}
    client = _client(tmp_path)

    def post(url: str, *, json: Any = None, timeout: float | None = None) -> Any:
        if url.endswith("/tds"):
            assert json["dae_vars"], "the run has to name the variables it records"
            return SimpleNamespace(json=lambda: {"traces": _TRACES})
        route = "/api" + url.split("/api", 1)[1]
        answers[route] = client.post(route, json=json)
        return answers[route]

    monkeypatch.chdir(tmp_path)
    exec(
        compile(block.removeprefix("import httpx\n"), "docs/api.md", "exec"),
        {"httpx": SimpleNamespace(post=post)},
    )

    metrics = answers["/api/response-metrics"]
    assert metrics.status_code == 200, metrics.text
    assert [r["name"] for r in metrics.json()["results"]] == [
        v["name"] for v in _TRACES["variables"]
    ]
    assert all(r["error"] is None for r in metrics.json()["results"])
    record = answers["/api/comtrade"]
    assert record.status_code == 200, record.text
    assert record.headers["content-type"] == "application/zip"
    assert (tmp_path / "fault.zip").read_bytes() == record.content


@pytest.mark.parametrize("route", ["/api/response-metrics", "/api/comtrade"])
def test_a_batch_runs_traces_as_they_stand_are_refused_by_both_routes(
    tmp_path: Path, route: str
) -> None:
    """The guide says so, so a change that makes the routes take ``traces`` has to change it."""
    assert _client(tmp_path).post(route, json=_TRACES).status_code == 422
    assert "A request that sends `traces` itself answers 422." in _read("docs/api.md")


def test_the_report_route_is_documented_with_its_required_routine(
    openapi_schema: dict[str, Any],
) -> None:
    """``GET .../report`` answered 422 to the call the guide showed, which had no ``routine``."""
    operation = openapi_schema["paths"]["/api/sessions/{session_id}/report"]["get"]
    (routine,) = [p for p in operation["parameters"] if p["name"] == "routine"]
    assert routine["required"] is True
    guide, llms = _read("docs/api.md"), _read("llms.txt")
    assert "routine=pflow" in guide and "routine=pflow|tds|eig" in llms
    for value in ReportRoutineEnum:
        assert f"`{value.value}`" in guide or f"routine={value.value}" in guide, value
    assert " ".join(r.value for r in ReportRoutineEnum) == "pflow tds eig"


# Where a case is loaded by name in a page, a script or the map for agents.
_CASE_NAMED = re.compile(
    r"""primary_path["']?\s*[:=]\s*["']([^"'$]+)["']"""
    r"""|load_case\(\s*["']([^"']+)["']"""
    r"""|CASE:-([\w.-]+)}"""
)


def test_every_case_a_page_or_script_loads_is_a_file_the_server_adds_to_a_workspace() -> None:
    """``llms.txt`` loaded ``ieee14/ieee14_full.xlsx``, a folder the workspace does not have: the
    files of the catalog sit in the root of the workspace, whatever folder ANDES keeps them in."""
    named = {
        file.name for example in load_catalog().examples for file in example.files() if file.primary
    }
    assert {"ieee14_full.xlsx", "kundur_full.xlsx", "wscc9.xlsx"} <= named
    documents = [
        "README.md",
        "server/README.md",
        "llms.txt",
        "docs/api.md",
        "docs/quickstart.md",
        "docs/agents.md",
        "examples/walkthrough.sh",
        "examples/run_fault_study.py",
        "examples/tensa_client.py",
    ]
    found = [
        (document, next(g for g in match.groups() if g))
        for document in documents
        for match in _CASE_NAMED.finditer(_read(document))
    ]
    assert len(found) >= 6, found
    strangers = [(d, name) for d, name in found if name not in named]
    assert not strangers, f"these load a case the workspace does not hold: {strangers}"


def test_the_examples_describe_what_their_scripts_do() -> None:
    """``run_fault_study.py`` prints the lowest final bus voltage and not a frequency nadir, and a
    workspace that the server starts on has the case already."""
    readme, script = _read("examples/README.md"), _read("examples/run_fault_study.py")
    assert "Lowest final bus voltage" in script
    assert "nadir" not in readme
    assert "lowest final bus voltage" in readme
    walkthrough = _read("examples/walkthrough.sh")
    assert "copied in" not in walkthrough
    assert "tensa examples add ieee14" in walkthrough


# The figures the pages gave for generating ANDES's code before anyone measured it: about 30 s
# on a laptop (half a minute, a multi-minute prep) and 1.5 MB. Measured with ANDES 2.0.0: the
# first case load waits about 10 s, ``tensa warm-cache`` takes 10 to 25 s, the code is 0.6 MB.
_UNMEASURED_CACHE_FIGURES = re.compile(
    r"about 30 s(?:econds)? on a laptop|\(~30 s\)|about half a minute|~1\.5 MB|multi-minute"
    r"|(?<!\d )30 s or more|30 seconds on a laptop",
    flags=re.IGNORECASE,
)


def test_no_page_or_help_text_gives_the_unmeasured_figures_for_generating_andes_code() -> None:
    stale = _lines_with(_UNMEASURED_CACHE_FIGURES)
    assert not stale, "these still carry a figure nobody measured:\n" + "\n".join(stale)
    # The pages that say how long the code takes say the figure that was measured.
    for document in ("docs/quickstart.md", "docs/install.md", "docs/troubleshooting.md"):
        assert "10 seconds" in _read(document), document
    assert "10 to 25 seconds" in _read("docs/install.md")
    assert "0.6 MB" in _read("docs/install.md")


def test_the_contributor_pages_say_what_ci_runs_on_each_system() -> None:
    """They said CI runs everything on Linux, macOS and Windows. Only the server tests run on all
    three, and on macOS and Windows they are the unit tests and the smoke test."""
    for document in ("CONTRIBUTING.md", "docs/contributing-code.md"):
        text = _read(document)
        assert "CI runs everything" not in text, document
        assert "smoke test" in text, document
    assert "macOS and Windows the unit tests and a smoke test" in _read("docs/contributing-code.md")


_PNPM_BUILTINS = {"install", "exec", "add", "remove", "dlx", "run", "audit", "outdated", "i"}


def test_every_pnpm_script_a_page_names_is_a_script_of_the_web_package() -> None:
    scripts = json.loads(_read("web/package.json"))["scripts"]
    named = {
        match.group(1)
        for path in _written_by_hand()
        if path.suffix == ".md"
        for match in re.finditer(
            r"\bpnpm (?:run )?([a-z][\w:-]*)", path.read_text(encoding="utf-8")
        )
        if match.group(1) not in _PNPM_BUILTINS
    }
    assert {"regen-api-types", "typecheck", "lint", "test", "build"} <= named
    missing = sorted(named - set(scripts))
    assert not missing, f"the pages name pnpm scripts that web/package.json lacks: {missing}"


def test_regen_api_types_starts_a_throwaway_server_and_reads_its_openapi() -> None:
    """The script read ``server/openapi.json``, a file that is not in the repository, printed a
    hint when it failed and exited 0, so the command the contributor pages give did nothing."""
    scripts = json.loads(_read("web/package.json"))["scripts"]
    assert scripts["regen-api-types"] == "bash scripts/regenerate-api-types.sh"
    assert "server/openapi.json" not in json.dumps(scripts)
    assert (REPO_ROOT / "web" / "scripts" / "regenerate-api-types.sh").is_file()
