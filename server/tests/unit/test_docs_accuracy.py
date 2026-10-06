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
from typing import Any

import pytest
import typer

from tensa import cli, desktop
from tensa.api.app import make_app
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
    assert f"at least `{options['--width'].type.min}`" in bullets["--width"]
    assert f"at least `{options['--height'].type.min}`" in bullets["--height"]


def test_server_readme_gives_the_linux_fixes_the_desktop_command_gives() -> None:
    """The package a Linux user is told to install when Qt cannot start, and the way to
    make a virtual environment see GTK, read the same in the README as in the command's
    own messages (a message that moves on without the README sends people to a package
    that is no longer the answer)."""
    readme = _read("server/README.md")
    for message in (desktop.QT_NEEDS_XCB_CURSOR, desktop.TOOLKIT_HELP):
        for command in re.findall(
            r"sudo (?:apt install|dnf install|pacman -S) [\w.-]+(?: [\w.-]+)*(?=[ ,)]|\.$|\.\s|$)",
            message,
        ):
            assert command in readme, command
    assert "--system-site-packages" in readme
    assert "pywebview[qt]" in readme


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


def test_readme_gives_powershell_equivalents_for_the_posix_only_commands() -> None:
    readme = _read("README.md")
    fences = re.findall(r"```(\w+)\n(.*?)```", readme, flags=re.DOTALL)
    bash = "\n".join(body for lang, body in fences if lang == "bash")
    powershell = "\n".join(body for lang, body in fences if lang == "powershell")
    assert "source .venv/bin/activate" in bash
    assert r".venv\Scripts\Activate.ps1" in powershell
    assert re.search(r"^VITE_ANDES_PORT=\d+ pnpm dev", bash, flags=re.MULTILINE)
    assert re.search(r'^\$env:VITE_ANDES_PORT = "\d+"$', powershell, flags=re.MULTILINE)
    # `&&` is not a statement separator in Windows PowerShell 5.1, and a trailing backslash is not
    # a line continuation there, so the bash blocks avoid it too (one command per line).
    assert "&&" not in powershell
    assert not re.search(r"\\\n", bash)


def test_the_dev_mode_command_admits_the_vite_origin() -> None:
    # Without --allow-origin, requests that carry the dev server's Origin get a 400.
    for document in ("README.md", "CONTRIBUTING.md", "web/README.md"):
        lines = [
            line
            for line in _read(document).splitlines()
            if "tensa serve" in line and "5173" in line
        ]
        assert lines, f"{document} has no dev-mode `tensa serve` line"
        assert all("--allow-origin http://127.0.0.1:5173" in line for line in lines), document


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
