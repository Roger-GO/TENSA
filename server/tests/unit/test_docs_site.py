"""The documentation site builds from files that agree with the code.

``mkdocs.yml`` and ``docs/`` make the site, ``scripts/docs_reference.py`` writes its
Reference pages from the server's OpenAPI schema and its command line, and
``.github/workflows/docs.yml`` builds it in CI. MkDocs is not a dependency of the server, so
these tests do what its strict build would catch without it: every page is in the navigation
and every navigation entry is a page, the links and anchors between pages resolve, and the
pages name only the ``tensa`` commands, options and MCP tools that exist. They also check the
renderer on small schemas and on the live one, and the workflow's promise that nothing is
published until the repository owner opts in.

They read repository files, so they skip when run away from a checkout.
"""

from __future__ import annotations

import ast
import posixpath
import re
import unicodedata
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
import typer

from tensa import cli, desktop
from tests._repo import REPO_ROOT, SCRIPTS_DIR, SERVER_DIR, WEB_DIR, load_module, pyproject

pytestmark = pytest.mark.unit

DOCS = REPO_ROOT / "docs"
MKDOCS_YML = REPO_ROOT / "mkdocs.yml"
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "docs.yml"


# ---- loading ---------------------------------------------------------------------


def _yaml(path: Path) -> dict[str, Any]:
    yaml = pytest.importorskip("yaml")
    if not path.is_file():
        pytest.skip(f"{path.relative_to(REPO_ROOT).as_posix()} is not next to the tests")
    loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert isinstance(loaded, dict)
    return loaded


@pytest.fixture(scope="module")
def mkdocs() -> dict[str, Any]:
    return _yaml(MKDOCS_YML)


@pytest.fixture(scope="module")
def reference() -> ModuleType:
    return load_module("docs_reference", SCRIPTS_DIR / "docs_reference.py")


@pytest.fixture(scope="module")
def schema(reference: ModuleType) -> dict[str, Any]:
    built: dict[str, Any] = reference.build_schema()
    return built


@pytest.fixture(scope="module")
def generated(reference: ModuleType, schema: dict[str, Any]) -> dict[str, str]:
    """The Reference pages, by path under ``docs/``, rendered from the live code."""
    pages: dict[str, str] = reference.render_pages(schema, reference.build_cli_group())
    return pages


def _excluded(mkdocs: dict[str, Any]) -> list[str]:
    return [
        line.strip() for line in str(mkdocs.get("exclude_docs", "")).splitlines() if line.strip()
    ]


def _is_excluded(relative: str, patterns: list[str]) -> bool:
    return any(
        relative == pattern or (pattern.endswith("/") and relative.startswith(pattern))
        for pattern in patterns
    )


def _hand_written(mkdocs: dict[str, Any]) -> dict[str, str]:
    """Every Markdown page of ``docs/`` the site includes, by path under ``docs/``."""
    if not DOCS.is_dir():
        pytest.skip("docs/ is not next to the tests")
    patterns = _excluded(mkdocs)
    pages: dict[str, str] = {}
    for path in sorted(DOCS.rglob("*.md")):
        relative = path.relative_to(DOCS).as_posix()
        if not _is_excluded(relative, patterns):
            pages[relative] = path.read_text(encoding="utf-8")
    return pages


def _nav_pages(entries: Any) -> list[str]:
    """The pages a ``nav`` lists, in order, however deeply it nests."""
    found: list[str] = []
    if isinstance(entries, str):
        found.append(entries)
    elif isinstance(entries, list):
        for entry in entries:
            found.extend(_nav_pages(entry))
    elif isinstance(entries, dict):
        for value in entries.values():
            found.extend(_nav_pages(value))
    return found


# ---- Markdown, read the way MkDocs reads it ---------------------------------------

_FENCE = re.compile(r"^(\s*)(```+|~~~+)([^\n]*)\n(.*?)^\1\2\s*$", re.MULTILINE | re.DOTALL)
_INLINE_CODE = re.compile(r"(`+)(.+?)\1", re.DOTALL)
_LINK = re.compile(r"!?\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
_HEADING = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*$", re.MULTILINE)
_ATTR_ID = re.compile(r"[ \t]*\{[^}]*#([\w-]+)[^}]*\}\s*$")


def _fences(text: str) -> list[tuple[str, str]]:
    """The code blocks of a page as (language, body)."""
    return [(m.group(3).strip(), m.group(4)) for m in _FENCE.finditer(text)]


def _without_code(text: str) -> str:
    """The text with its fenced blocks and its inline code taken out."""
    return _INLINE_CODE.sub("", _FENCE.sub("", text))


def _slug(heading: str) -> str:
    """The id Python-Markdown's ``toc`` gives a heading."""
    text = re.sub(r"[`*_]", "", heading)
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^\w\s-]", "", text).strip().lower()
    return re.sub(r"[-\s]+", "-", text)


def _anchors(text: str) -> set[str]:
    """The ids of a page's headings: an explicit ``{ #id }``, or the heading's slug."""
    found: set[str] = set()
    for match in _HEADING.finditer(_FENCE.sub("", text)):
        title = match.group(2)
        explicit = _ATTR_ID.search(title)
        found.add(explicit.group(1) if explicit else _slug(title))
    return found


def _all_pages(mkdocs: dict[str, Any], generated: dict[str, str]) -> dict[str, str]:
    return {**_hand_written(mkdocs), **generated}


# ---- the navigation and the files ---------------------------------------------------


def test_the_navigation_lists_every_page_once_and_only_real_pages(
    mkdocs: dict[str, Any], generated: dict[str, str]
) -> None:
    listed = _nav_pages(mkdocs["nav"])
    assert len(listed) == len(set(listed)), "a page is in the navigation twice"
    pages = set(_all_pages(mkdocs, generated))
    assert set(listed) - pages == set(), "the navigation names pages that do not exist"
    # MkDocs' strict build warns about a page the navigation leaves out.
    assert pages - set(listed) == set(), "pages that the navigation leaves out"


def test_every_generated_page_has_a_place_in_the_navigation(
    mkdocs: dict[str, Any], generated: dict[str, str]
) -> None:
    assert set(generated) <= set(_nav_pages(mkdocs["nav"]))


def test_a_generated_page_does_not_shadow_a_page_written_by_hand(
    mkdocs: dict[str, Any], generated: dict[str, str]
) -> None:
    assert set(generated) & set(_hand_written(mkdocs)) == set()


def test_the_configuration_points_at_files_that_exist(mkdocs: dict[str, Any]) -> None:
    assert mkdocs["docs_dir"] == "docs"
    for hook in mkdocs["hooks"]:
        assert (REPO_ROOT / hook).is_file(), hook
    for key in ("logo", "favicon"):
        assert (DOCS / mkdocs["theme"][key]).is_file(), key
    for sheet in mkdocs["extra_css"]:
        assert (DOCS / sheet).is_file(), sheet
    assert (DOCS / "requirements.txt").is_file()


def test_what_the_configuration_excludes_is_there_to_exclude(mkdocs: dict[str, Any]) -> None:
    """An exclusion of a file that was renamed or deleted would quietly stop excluding."""
    patterns = _excluded(mkdocs)
    assert patterns, "nothing is excluded"
    for pattern in patterns:
        assert (DOCS / pattern.rstrip("/")).exists(), pattern


def test_the_site_does_not_carry_the_demo_video(mkdocs: dict[str, Any]) -> None:
    # 3.3 MB that the README links to on GitHub instead.
    assert _is_excluded("demo/ieee9-agent-demo.mp4", _excluded(mkdocs))


def test_the_documentation_link_of_the_package_is_the_published_site(
    mkdocs: dict[str, Any],
) -> None:
    """PyPI and ``pip show`` send a reader to the site GitHub Pages serves, which is the
    address the site is built for. The readmes link to it too, and none of them still
    sends a reader to the ``docs`` folder on GitHub, which was the link before the site
    was published."""
    site = mkdocs["site_url"]
    assert site == "https://roger-go.github.io/TENSA/"
    urls = pyproject()["project"]["urls"]
    assert urls["Documentation"] == site
    assert (DOCS / "index.md").is_file()
    steps = _hand_written(mkdocs)["contributing.md"]
    assert "server/pyproject.toml" in steps
    assert site in steps
    for name in ("README.md", "server/README.md", "CONTRIBUTING.md", "llms.txt"):
        text = (REPO_ROOT / name).read_text(encoding="utf-8")
        assert site in text, f"{name} does not link to the documentation site"
        assert f"{urls['Homepage']}/tree/main/docs" not in text, name


def test_links_to_the_site_from_outside_it_name_pages_and_headings_that_exist(
    mkdocs: dict[str, Any], generated: dict[str, str]
) -> None:
    """The readmes link to the published site by its address, which no build checks: a
    page that is renamed, or a heading that is reworded, would leave them at a 404 or at
    the top of the wrong section."""
    site = mkdocs["site_url"]
    pages = _all_pages(mkdocs, generated)
    anchors = {name: _anchors(text) for name, text in pages.items()}
    link = re.compile(re.escape(site) + r"([\w./#-]*)")
    problems: list[str] = []
    found = 0
    for name in ("README.md", "server/README.md", "CONTRIBUTING.md", "CHANGELOG.md", "llms.txt"):
        text = (REPO_ROOT / name).read_text(encoding="utf-8")
        for match in link.finditer(text):
            found += 1
            # A sentence that ends on the address ends on a full stop that is not part of it.
            path, _, fragment = match.group(1).rstrip(".").partition("#")
            page = f"{path.rstrip('/')}.md" if path else "index.md"
            if page not in pages:
                problems.append(f"{name}: {match.group(0)} is not a page of the site")
            elif fragment and fragment not in anchors[page]:
                problems.append(f"{name}: {match.group(0)} has no heading with that id")
    assert found, "no link to the site was found"
    assert not problems, "\n".join(problems)


def test_the_theme_fetches_nothing_from_a_third_party(mkdocs: dict[str, Any]) -> None:
    # The web fonts, and the star count a `repo_url` makes the theme ask GitHub for.
    assert mkdocs["theme"]["font"] is False
    assert "repo_url" not in mkdocs


def test_the_tooling_requirements_are_capped() -> None:
    path = DOCS / "requirements.txt"
    if not path.is_file():
        pytest.skip("docs/requirements.txt is not next to the tests")
    lines = [
        line.strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    names = {re.split(r"[<>=!~ ]", line, maxsplit=1)[0] for line in lines}
    assert {"mkdocs", "mkdocs-material"} <= names
    # MkDocs 2.0 drops the plugin and theme systems the Material theme is built on.
    assert all("<" in line for line in lines), lines
    assert any(line.startswith("mkdocs<") or re.match(r"mkdocs>=[\d.]+,<2", line) for line in lines)


# ---- the text of the pages ----------------------------------------------------------

# Emoji and the symbol blocks around them, and the variation selector that asks for one.
_EMOJI = re.compile("[\U0001f000-\U0001faff☀-➿️]")


def test_pages_use_no_em_dash_and_no_emoji(
    mkdocs: dict[str, Any], generated: dict[str, str]
) -> None:
    for name, text in _all_pages(mkdocs, generated).items():
        assert "—" not in text, f"{name} has an em dash"
        found = _EMOJI.search(text)
        assert found is None, f"{name} has an emoji: {found and found.group(0)!r}"


def test_every_page_has_one_title(mkdocs: dict[str, Any], generated: dict[str, str]) -> None:
    for name, text in _all_pages(mkdocs, generated).items():
        titles = [m for m in _HEADING.finditer(_FENCE.sub("", text)) if m.group(1) == "#"]
        assert len(titles) == 1, f"{name} has {len(titles)} level-1 headings"


def test_every_code_block_names_its_language(
    mkdocs: dict[str, Any], generated: dict[str, str]
) -> None:
    for name, text in _all_pages(mkdocs, generated).items():
        for language, body in _fences(text):
            assert language, f"{name} has a code block with no language: {body[:40]!r}"


def test_powershell_blocks_use_no_double_ampersand(mkdocs: dict[str, Any]) -> None:
    """`&&` is not a statement separator in Windows PowerShell 5.1, and a block shown for
    PowerShell has to run there."""
    for name, text in _hand_written(mkdocs).items():
        for language, body in _fences(text):
            if language == "powershell":
                assert "&&" not in body, f"{name} has && in a PowerShell block"


def test_the_install_page_has_a_powershell_version_of_each_posix_recipe(
    mkdocs: dict[str, Any],
) -> None:
    text = _hand_written(mkdocs)["install.md"]
    languages = re.findall(r"^\s*```(\w+)", text, flags=re.MULTILINE)
    assert languages.count("powershell") >= 2
    assert ".venv\\Scripts\\Activate.ps1" in text
    assert "source .venv/bin/activate" in text
    assert "Windows on ARM" in text


# ---- links ----------------------------------------------------------------------------


def test_links_and_images_resolve_to_pages_and_headings(
    mkdocs: dict[str, Any], generated: dict[str, str]
) -> None:
    pages = _all_pages(mkdocs, generated)
    images = {
        path.relative_to(DOCS).as_posix()
        for path in DOCS.rglob("*")
        if path.is_file() and path.suffix != ".md"
    }
    anchors = {name: _anchors(text) for name, text in pages.items()}
    problems: list[str] = []
    for name, text in pages.items():
        for match in _LINK.finditer(_without_code(text)):
            target = match.group(1)
            if re.match(r"[a-z][a-z0-9+.-]*:", target):  # https:, mailto:
                continue
            path, _, fragment = target.partition("#")
            resolved = (
                posixpath.normpath(posixpath.join(posixpath.dirname(name), path)) if path else name
            )
            if resolved not in pages and resolved not in images:
                problems.append(f"{name}: {target} is not a page or an image")
            elif fragment and resolved in pages and fragment not in anchors[resolved]:
                problems.append(f"{name}: {target} has no heading with that id")
    assert not problems, "\n".join(problems)


def test_images_stay_small_enough_for_a_repository() -> None:
    """contributing.md asks for screenshots under about 200 KB."""
    for path in [*sorted((DOCS / "img").glob("ui-*.jpg")), DOCS / "img" / "hero.jpeg"]:
        assert path.stat().st_size < 250_000, f"{path.name} is {path.stat().st_size} bytes"


def test_the_screenshots_the_pages_show_are_the_ones_the_script_takes(
    mkdocs: dict[str, Any],
) -> None:
    script = WEB_DIR / "scripts" / "docs-screenshots.mjs"
    if not script.is_file():
        pytest.skip("web/scripts/docs-screenshots.mjs is not next to the tests")
    taken = set(re.findall(r"'(ui-[\w-]+\.jpg)'", script.read_text(encoding="utf-8")))
    shown = {
        Path(target).name
        for text in _hand_written(mkdocs).values()
        for target in _LINK.findall(_without_code(text))
        if Path(target).name.startswith("ui-") and target.endswith(".jpg")
    }
    assert taken, "the script writes no ui-*.jpg"
    assert taken == shown, (
        f"taken but not shown: {taken - shown}; shown but not taken: {shown - taken}"
    )
    for name in taken:
        assert (DOCS / "img" / name).is_file(), f"docs/img/{name} is not committed"


def test_the_hero_image_is_one_the_script_takes(mkdocs: dict[str, Any]) -> None:
    """The picture at the top of the README and of the site's first page is taken by the
    script that takes the others, so it is taken again with them when the UI changes. A
    picture nothing shows is not kept: the one from before the project was renamed stayed
    in ``docs/img`` for as long as only the build's exclusion list named it."""
    script = WEB_DIR / "scripts" / "docs-screenshots.mjs"
    if not script.is_file():
        pytest.skip("web/scripts/docs-screenshots.mjs is not next to the tests")
    assert "'hero.jpeg'" in script.read_text(encoding="utf-8")
    assert (DOCS / "img" / "hero.jpeg").is_file()
    assert "](img/hero.jpeg)" in _hand_written(mkdocs)["index.md"]
    readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
    assert "](docs/img/hero.jpeg)" in readme
    shown = "\n".join([readme, *_hand_written(mkdocs).values()])
    for path in sorted((DOCS / "img").iterdir()):
        if path.suffix in {".jpg", ".jpeg", ".png", ".gif"}:
            assert f"img/{path.name}" in shown, f"no page shows docs/img/{path.name}"


# ---- what the pages say about the program ----------------------------------------------


def _commands() -> dict[str, Any]:
    group = typer.main.get_command(cli.app)
    return dict(group.commands)  # type: ignore[attr-defined]


def _options(command: Any) -> set[str]:
    return {opt for param in command.params for opt in param.opts if opt.startswith("--")}


def _code_lines(text: str) -> list[str]:
    """The lines of the code blocks, and of the inline code, of a page."""
    lines = [line for _, body in _fences(text) for line in body.splitlines()]
    lines += [m.group(2) for m in _INLINE_CODE.finditer(_FENCE.sub("", text))]
    return lines


def test_pages_name_only_commands_and_options_that_tensa_has(mkdocs: dict[str, Any]) -> None:
    commands = _commands()
    root_options = _options(typer.main.get_command(cli.app)) | {"--help"}
    problems: list[str] = []
    for name, text in _hand_written(mkdocs).items():
        for line in _code_lines(text):
            for match in re.finditer(r"\btensa[ \t]+(--\w[\w-]*|-\w+|[a-z][\w-]*)", line):
                word = match.group(1)
                if word.startswith("-"):
                    if word not in root_options:
                        problems.append(f"{name}: `tensa {word}` is not an option of tensa")
                    continue
                if word not in commands:
                    problems.append(f"{name}: `tensa {word}` is not a command")
                    continue
                used = set(re.findall(r"(?<![\w-])(--[a-z][a-z-]*)", line[match.end() :]))
                unknown = used - _options(commands[word]) - {"--help"}
                if unknown:
                    problems.append(f"{name}: `tensa {word}` is given {sorted(unknown)}")
    assert not problems, "\n".join(problems)


def test_the_quick_start_runs_the_server_the_way_the_readme_does(mkdocs: dict[str, Any]) -> None:
    text = _hand_written(mkdocs)["quickstart.md"]
    assert "tensa serve --workspace ~/tensa-cases --port 8000 --open" in text
    # The three example cases a new workspace is seeded with.
    for case in ("ieee14_full.xlsx", "kundur_full.xlsx", "wscc9.xlsx"):
        assert case in text


def test_the_pages_cover_the_desktop_window_the_logging_options_and_the_health_check(
    mkdocs: dict[str, Any],
) -> None:
    """What the README describes and the Reference pages only list: the pages a reader
    goes to first say how to get the window, how to make the server say more, and how
    to ask it whether it is up."""
    pages = _hand_written(mkdocs)
    install, trouble = pages["install.md"], pages["troubleshooting.md"]
    # The one install command of each system, as the command's help and messages give it.
    for platform in ("linux", "win32", "darwin"):
        command = desktop.install_command(platform=platform, extras=["desktop"])
        assert command in install, command
        assert command in trouble, command
    assert "tensa desktop" in pages["quickstart.md"]
    # The system library Qt aborts without, with the package for each distribution.
    for line in desktop.XCB_CURSOR_INSTALL.splitlines():
        package = line.split(":", 1)[1].strip()
        assert package in install, package
        assert package in trouble, package
    assert "tensa serve --open" in install and "tensa serve --open" in trouble
    for flag in ("--log-level", "--log-file", "--log-json"):
        assert flag in trouble, flag
    for name in ("troubleshooting.md", "api.md"):
        assert "/api/health" in pages[name], name


def test_the_tour_names_the_end_time_field_as_the_ui_labels_it(mkdocs: dict[str, Any]) -> None:
    panel = WEB_DIR / "src" / "components" / "tds" / "TdsConfigPanel.tsx"
    if not panel.is_file():
        pytest.skip("web/src/components/tds/TdsConfigPanel.tsx is not next to the tests")
    assert "end time (s)" in panel.read_text(encoding="utf-8")
    tour = _hand_written(mkdocs)["ui-tour.md"]
    assert "the end time (10 s by default)" in tour
    assert "final time" not in tour


def _mcp_tools() -> list[str]:
    source = SERVER_DIR / "src" / "tensa" / "mcp_server.py"
    tree = ast.parse(source.read_text(encoding="utf-8"))
    return [
        node.name
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef)
        and any(
            isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute) and d.func.attr == "tool"
            for d in node.decorator_list
        )
    ]


def test_the_agents_page_lists_every_mcp_tool_and_no_other(mkdocs: dict[str, Any]) -> None:
    tools = _mcp_tools()
    assert tools, "no MCP tools found in mcp_server.py"
    text = _hand_written(mkdocs)["agents.md"]
    listed = re.findall(r"^\| `(\w+)` \|", text, flags=re.MULTILINE)
    assert set(listed) == set(tools), (
        f"listed but not a tool: {set(listed) - set(tools)}; "
        f"a tool the page leaves out: {set(tools) - set(listed)}"
    )


def test_the_troubleshooting_page_has_a_section_for_each_operating_system(
    mkdocs: dict[str, Any],
) -> None:
    text = _hand_written(mkdocs)["troubleshooting.md"]
    headings = {m.group(2) for m in _HEADING.finditer(_FENCE.sub("", text)) if m.group(1) == "##"}
    assert {"Linux", "macOS", "Windows"} <= headings


# ---- the workflow --------------------------------------------------------------------


def _workflow() -> dict[str, Any]:
    return _yaml(WORKFLOW)


def _steps_text(job: dict[str, Any]) -> str:
    return "\n".join(step["run"] for step in job["steps"] if "run" in step)


def test_the_workflow_builds_strictly_on_pull_requests_and_pushes() -> None:
    workflow = _workflow()
    triggers = workflow.get("on", workflow.get(True))
    assert {"push", "pull_request", "workflow_dispatch"} <= set(triggers)
    assert "main" in triggers["push"]["branches"]
    build = _steps_text(workflow["jobs"]["build"])
    assert "mkdocs build --strict" in build
    # The Reference pages import the server, and the build tools come from the pinned file.
    assert "docs/requirements.txt" in build
    assert "./server" in build


def test_the_workflow_rebuilds_when_what_the_reference_is_written_from_changes() -> None:
    workflow = _workflow()
    triggers = workflow.get("on", workflow.get(True))
    for event in ("push", "pull_request"):
        paths = set(triggers[event]["paths"])
        assert {"docs/**", "mkdocs.yml", "scripts/docs_reference.py", "server/src/**"} <= paths


def test_nothing_is_published_until_the_owner_opts_in() -> None:
    workflow = _workflow()
    assert workflow["permissions"] == {"contents": "read"}
    jobs = workflow["jobs"]
    deploy = jobs["deploy"]
    assert deploy["needs"] == "build"
    condition = str(deploy["if"])
    assert "vars.DOCS_DEPLOY == 'true'" in condition
    assert "refs/heads/main" in condition
    # A pull request, which can come from a fork, never gets the Pages token.
    assert "pull_request" in condition
    assert deploy["permissions"] == {"pages": "write", "id-token": "write"}
    for name, job in jobs.items():
        if name != "deploy":
            assert "permissions" not in job, f"{name} asks for more than read access"
    uses = [step.get("uses", "") for step in deploy["steps"]]
    assert any(use.startswith("actions/deploy-pages@") for use in uses)
    built = [step.get("uses", "") for step in jobs["build"]["steps"]]
    assert any(use.startswith("actions/upload-pages-artifact@") for use in built)


def test_the_contributor_page_says_how_to_turn_publishing_on(mkdocs: dict[str, Any]) -> None:
    text = _hand_written(mkdocs)["contributing.md"]
    assert "DOCS_DEPLOY" in text
    assert "GitHub Actions" in text
    assert "Pages" in text


# ---- the renderer, on small schemas ----------------------------------------------------


def _schema(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "info": {"title": "T", "version": "9.9.9"},
        "paths": {
            "/api/things/{thing_id}": {
                "post": {
                    "tags": ["pflow"],
                    "summary": "Do a thing — quickly.",
                    "operationId": "doThing",
                    "description": (
                        "Calls :meth:`ss.thing` on ``<case>`` and ``{id}``.\n"
                        "- a list item straight after a line\n"
                        "- another\n\n"
                        "# not a heading"
                    ),
                    "parameters": [
                        {
                            "name": "thing_id",
                            "in": "path",
                            "required": True,
                            "schema": {"type": "string"},
                        },
                        {
                            "name": "limit",
                            "in": "query",
                            "required": False,
                            "description": "How many | at most.",
                            "schema": {"type": "integer", "minimum": 1, "maximum": 9, "default": 3},
                        },
                    ],
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {"schema": {"$ref": "#/components/schemas/Body"}}
                        },
                    },
                    "responses": {
                        "200": {
                            "description": "Done",
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "#/components/schemas/Result"}
                                }
                            },
                        },
                        "404": {"description": "No such thing."},
                        "422": {
                            "description": "Validation Error",
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "#/components/schemas/HTTPValidationError"}
                                }
                            },
                        },
                    },
                }
            }
        },
        "components": {
            "schemas": {
                "Result": {
                    "type": "object",
                    "description": "What comes back <raw> and {x}.",
                    "properties": {"ok": {"type": "boolean", "description": "Whether it worked."}},
                    "required": ["ok"],
                },
                "Body": {
                    "type": "object",
                    "required": ["name"],
                    "properties": {
                        "name": {"type": "string", "minLength": 1, "description": "A name."},
                        "kind": {
                            "anyOf": [
                                {"type": "string", "enum": ["a", "b"]},
                                {"type": "null"},
                            ],
                            "default": "a",
                        },
                        "result": {"$ref": "#/components/schemas/Result"},
                        "many": {"type": "array", "items": {"$ref": "#/components/schemas/Result"}},
                        "pairs": {"type": "object", "additionalProperties": {"type": "number"}},
                        "tag": {"const": "fault", "type": "string"},
                    },
                },
                "HTTPValidationError": {"type": "object", "properties": {}},
                "Mode": {"type": "string", "enum": ["fast", "slow"], "description": "How."},
            }
        },
    }
    base.update(overrides)
    return base


def test_a_route_gets_a_heading_with_a_stable_anchor_and_its_summary(reference: ModuleType) -> None:
    page = reference.render_api(_schema())
    assert "### `POST /api/things/{thing_id}` { #dothing }" in page
    # The long dash of the schema's text becomes the plain one the documentation uses.
    assert "**Do a thing - quickly.**" in page
    assert "—" not in page


def test_the_routes_are_grouped_under_a_readable_tag_title(reference: ModuleType) -> None:
    page = reference.render_api(_schema())
    assert "\n## Power flow\n" in page
    assert "- **Power flow**" in page
    unknown = _schema()
    unknown["paths"]["/api/things/{thing_id}"]["post"]["tags"] = ["brand-new"]
    assert "\n## Brand new\n" in reference.render_api(unknown)


def test_descriptions_become_markdown_that_cannot_break_the_page(reference: ModuleType) -> None:
    page = reference.render_api(_schema())
    # An RST role is code, and markup in a code span is left alone.
    assert "Calls `ss.thing` on ``<case>`` and ``{id}``." in page
    # A list needs a blank line before it, and a stray heading mark is escaped.
    assert "\n\n- a list item straight after a line\n- another\n" in page
    assert "\\# not a heading" in page
    # Outside code, angle brackets and braces are entities.
    models = reference.render_models(_schema())
    assert "What comes back &lt;raw&gt; and &#123;x&#125;." in models


def test_tables_carry_types_limits_defaults_and_links(reference: ModuleType) -> None:
    page = reference.render_api(_schema())
    assert "| `thing_id` | path | string | yes |  |" in page
    # A pipe in a description is escaped so that it stays in its cell.
    assert "How many \\| at most. Limits: min 1, max 9. Default `3`." in page
    assert "Media type `application/json`: [Body](models.md#body)" in page
    assert "| `name` | string | yes | A name. Limits: min length 1. |" in page
    assert '| `kind` | string or null | no | One of `a`, `b`. Default `"a"`. |' in page
    assert "| `result` | [Result](models.md#result) | no |" in page
    assert "| `many` | array of [Result](models.md#result) | no |" in page
    assert "| `pairs` | object (names to number) | no |" in page
    assert '| `tag` | `"fault"` | no |' in page
    assert "| 200 | Done | `application/json` [Result](models.md#result) |" in page


def test_the_generic_validation_error_row_is_left_out_but_a_422_with_a_meaning_stays(
    reference: ModuleType,
) -> None:
    page = reference.render_api(_schema())
    assert "| 404 | No such thing. |" in page
    assert "Validation Error" not in page
    meaningful = _schema()
    meaningful["paths"]["/api/things/{thing_id}"]["post"]["responses"]["422"] = {
        "description": "ANDES refused it.",
        "content": {
            "application/json": {"schema": {"$ref": "#/components/schemas/ProblemDetails"}}
        },
    }
    assert "| 422 | ANDES refused it. |" in reference.render_api(meaningful)


def test_models_are_sorted_and_link_to_each_other_within_the_page(reference: ModuleType) -> None:
    page = reference.render_models(_schema())
    names = re.findall(r"^## (\w+) \{ #", page, flags=re.MULTILINE)
    assert names == sorted(names) == ["Body", "HTTPValidationError", "Mode", "Result"]
    assert "| `result` | [Result](#result) | no |" in page
    assert "## Mode { #mode }" in page
    assert "Type: string." in page
    assert "One of `fast`, `slow`." in page


def test_a_schema_without_routes_still_renders(reference: ModuleType) -> None:
    empty: dict[str, Any] = {"info": {"version": "1"}}
    assert reference.render_api(empty).startswith("# API routes")
    assert reference.render_models(empty).startswith("# API models")


# ---- the Reference pages, from the live code ---------------------------------------------


def test_every_route_of_the_app_is_in_the_api_reference(
    generated: dict[str, str], schema: dict[str, Any], reference: ModuleType
) -> None:
    page = generated[reference.API_PAGE]
    missing = [
        f"{method.upper()} {path}"
        for path, item in schema["paths"].items()
        for method in item
        if f"### `{method.upper()} {path}` {{ #" not in page
    ]
    assert not missing, f"routes the reference leaves out: {missing}"


def test_every_model_of_the_app_is_in_the_models_reference(
    generated: dict[str, str], schema: dict[str, Any], reference: ModuleType
) -> None:
    page = generated[reference.MODELS_PAGE]
    for name in schema["components"]["schemas"]:
        assert re.search(rf"^## {re.escape(name)} \{{ #", page, flags=re.MULTILINE), name


def test_the_generated_pages_hold_no_raw_html(generated: dict[str, str]) -> None:
    """Markdown passes a tag through, so `<case>` in a description would vanish from the page."""
    for name, page in generated.items():
        text = _INLINE_CODE.sub("", _FENCE.sub("", page))
        found = re.search(r"<[A-Za-z/!]", text)
        assert found is None, (
            f"{name} has raw markup near {text[found.start() : found.start() + 40]!r}"
        )


def test_the_command_line_reference_lists_every_command_and_option(
    generated: dict[str, str], reference: ModuleType
) -> None:
    page = generated[reference.CLI_PAGE]
    for name, command in _commands().items():
        assert f"## `tensa {name}`" in page, name
        for option in _options(command):
            assert f"`{option}`" in page, f"{name} {option}"
    assert "`--version`" in page


def test_the_command_line_reference_does_not_print_the_home_directory(
    generated: dict[str, str], reference: ModuleType
) -> None:
    page = generated[reference.CLI_PAGE]
    assert str(Path.home()) not in page
    assert "`~/.tensa/cases`" in page
