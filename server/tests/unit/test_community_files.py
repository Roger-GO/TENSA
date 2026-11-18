"""The files a visitor to the repository looks for say what is true and agree with each other.

A reviewer, a first-time contributor and a user who is stuck read the same few files: the
README, ``SUPPORT.md``, ``SECURITY.md``, ``CODE_OF_CONDUCT.md``, the new-issue page
(``.github/ISSUE_TEMPLATE/config.yml``) and the documentation's Support and Citing pages. These
tests hold what they promise to the repository: the project asks for no email address, the
Code of Conduct is the Contributor Covenant and not a template with its blanks left in, the
ANDES range the support pages quote is the one ``pyproject.toml`` declares, the badges name
workflows that exist, and the license is written one way everywhere. They read repository files,
so they skip when run away from a checkout.
"""

from __future__ import annotations

import re
from typing import Any

import pytest

from tests._repo import REPO_ROOT, pyproject

pytestmark = pytest.mark.unit

SITE = "https://roger-go.github.io/TENSA/"
SECURITY_FORM = "https://github.com/Roger-GO/TENSA/security/advisories/new"
QA = "https://github.com/Roger-GO/TENSA/discussions/categories/q-a"
AUTHOR = "Rogelio Gracia Otalvaro"

# Emoji and the symbol blocks around them, as in ``test_docs_site.py``.
_EMOJI = re.compile("[\U0001f000-\U0001faff\u2600-\u27bf\ufe0f]")

# The files that tell a reader where to go, and none of them may name a mailbox.
CONTACT_FILES = [
    "SUPPORT.md",
    "SECURITY.md",
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    ".github/ISSUE_TEMPLATE/config.yml",
    "docs/support.md",
    "docs/citing.md",
    "docs/contributing-code.md",
]


def _read(relative: str) -> str:
    path = REPO_ROOT / relative
    if not path.is_file():
        # A checkout has the README: a file missing from one is the failure these tests are for.
        if (REPO_ROOT / "README.md").is_file():
            pytest.fail(f"{relative} is missing from the repository")
        pytest.skip(f"{relative} is not next to the tests")
    return path.read_text(encoding="utf-8")


def _yaml(relative: str) -> Any:
    yaml = pytest.importorskip("yaml")
    return yaml.safe_load(_read(relative))


def _section(text: str, heading: str) -> str:
    """The body of a level-2 section: from its heading to the next level-2 heading."""
    lines = text.splitlines()
    start = lines.index(f"## {heading}")
    body: list[str] = []
    for line in lines[start + 1 :]:
        if line.startswith("## "):
            break
        body.append(line)
    return "\n".join(body).strip()


def _andes_range() -> str:
    (requirement,) = [
        r for r in pyproject()["project"]["dependencies"] if r.replace(" ", "").startswith("andes")
    ]
    return requirement.replace(" ", "")


# ---- no mailbox ----------------------------------------------------------------------


@pytest.mark.parametrize("document", CONTACT_FILES)
def test_the_project_asks_for_no_email_address(document: str) -> None:
    """Reports go through GitHub, so nothing that says where to send one has an address."""
    found = re.findall(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", _read(document))
    assert found == [], f"{document} names an email address: {found}"


@pytest.mark.parametrize("document", ["SUPPORT.md", "SECURITY.md", "docs/support.md"])
def test_no_reply_time_is_promised(document: str) -> None:
    """One maintainer cannot keep a number of days, so none is given."""
    text = _read(document)
    pattern = r"\b(?:a|one|\d+)\s+(?:business\s+)?(?:hour|day|week)s?\b"
    promised = re.search(pattern, text, flags=re.IGNORECASE)
    assert promised is None, f"{document} promises a reply time: {promised and promised.group(0)}"
    assert "best effort" in text


@pytest.mark.parametrize(
    "document",
    [
        "README.md",
        "server/README.md",
        "CONTRIBUTING.md",
        "SUPPORT.md",
        "SECURITY.md",
        "CODE_OF_CONDUCT.md",
        ".github/ISSUE_TEMPLATE/config.yml",
    ],
)
def test_the_files_a_visitor_reads_use_no_em_dash_and_no_emoji(document: str) -> None:
    """The documentation site's pages are held to this by ``test_docs_site.py``; these are the
    files outside it that say the same things."""
    text = _read(document)
    assert "\u2014" not in text, f"{document} has an em dash"
    assert _EMOJI.search(text) is None, f"{document} has an emoji"


# ---- the security policy ----------------------------------------------------------------


def test_the_security_policy_sends_a_report_to_private_vulnerability_reporting() -> None:
    text = _read("SECURITY.md")
    assert SECURITY_FORM in text
    assert "https://github.com/Roger-GO/TENSA/security" in text
    assert "public issue" in text, "it must say a vulnerability is not an issue"
    assert "email" not in text.lower()
    # The trust model above it is still there.
    assert "## Trust model" in text


# ---- the Code of Conduct --------------------------------------------------------------------


def test_the_code_of_conduct_is_the_contributor_covenant_2_1() -> None:
    text = _read("CODE_OF_CONDUCT.md")
    headings = re.findall(r"^#{1,3} (.+)$", text, flags=re.MULTILINE)
    assert headings == [
        "Contributor Covenant Code of Conduct",
        "Our Pledge",
        "Our Standards",
        "Enforcement Responsibilities",
        "Scope",
        "Enforcement",
        "Enforcement Guidelines",
        "1. Correction",
        "2. Warning",
        "3. Temporary Ban",
        "4. Permanent Ban",
        "Attribution",
    ]
    assert "https://www.contributor-covenant.org/version/2/1/code_of_conduct.html" in text
    assert "version 2.1" in text
    assert "INSERT CONTACT METHOD" not in text, "the template's blank was left in"


def test_a_conduct_report_has_three_ways_in_and_none_is_a_mailbox() -> None:
    enforcement = _section(_read("CODE_OF_CONDUCT.md"), "Enforcement")
    assert SECURITY_FORM in enforcement
    assert "Conduct report" in enforcement
    assert "https://github.com/Roger-GO/TENSA/discussions" in enforcement
    assert "docs.github.com/en/communities/maintaining-your-safety-on-github" in enforcement


# ---- the new-issue page ------------------------------------------------------------------------


def test_the_new_issue_page_points_at_discussions_the_docs_and_the_private_form() -> None:
    config = _yaml(".github/ISSUE_TEMPLATE/config.yml")
    links = {link["url"]: link for link in config["contact_links"]}
    assert set(links) == {QA, SITE, SECURITY_FORM}
    for link in links.values():
        assert link["name"] and link["about"]
    # The templates it sits beside are still there, so the page offers both.
    for template in ("bug_report.md", "feature_request.md"):
        assert (REPO_ROOT / ".github" / "ISSUE_TEMPLATE" / template).is_file()
    assert config.get("blank_issues_enabled", True) is True


# ---- support ------------------------------------------------------------------------------------


@pytest.mark.parametrize("document", ["SUPPORT.md", "docs/support.md"])
def test_the_support_pages_say_where_to_ask_and_what_is_supported(document: str) -> None:
    text = _read(document)
    assert QA in text
    assert SECURITY_FORM in text
    assert "issues/new/choose" in text
    assert "latest release" in text
    assert "ANDES_VERSIONS.md" in text
    assert "one maintainer" in text


@pytest.mark.parametrize("document", ["SUPPORT.md", "docs/support.md"])
def test_the_andes_range_the_support_pages_quote_is_the_one_declared(document: str) -> None:
    quoted = re.findall(r"`(andes[^`]*)`", _read(document))
    assert quoted == [_andes_range()]


def test_the_support_pages_count_the_andes_contracts_as_the_file_does() -> None:
    text = _read("server/ANDES_VERSIONS.md")
    assert "## The fourteen API contracts" in text
    for document in ("SUPPORT.md", "docs/support.md"):
        assert "fourteen" in _read(document)


# ---- the README and the first page of the docs ---------------------------------------------------

ANALYSES = [
    "Power flow",
    "Time-domain simulation",
    "Eigenvalue analysis",
    "Continuation power flow",
    "State estimation",
]


def test_the_readme_and_the_docs_home_give_one_statement_of_need() -> None:
    readme = _section(_read("README.md"), "Why TENSA, and who it is for")
    home = _section(_read("docs/index.md"), "Why TENSA, and who it is for")
    assert readme == home, "the two statements have drifted apart"
    for audience in ("Students and instructors", "Researchers", "Developers of agent-driven"):
        assert audience in readme
    assert "script-first" in readme.lower()


def test_each_of_the_five_analyses_has_a_line_of_its_own() -> None:
    section = _section(_read("README.md"), "Why TENSA, and who it is for")
    bullets = [line for line in section.splitlines() if line.startswith("- **")]
    names = [m.group(1) for b in bullets if (m := re.match(r"- \*\*([^*]+)\*\*", b))]
    assert names == ANALYSES
    assert all(len(b) > 40 for b in bullets)


def test_the_readme_has_a_badge_for_each_workflow_and_each_workflow_exists() -> None:
    readme = _read("README.md")
    for workflow in ("server", "web", "docs"):
        text = _read(f".github/workflows/{workflow}.yml")
        assert re.search(rf"^name: {workflow}$", text, flags=re.MULTILINE), workflow
        badge = f"https://github.com/Roger-GO/TENSA/actions/workflows/{workflow}.yml/badge.svg"
        link = f"(https://github.com/Roger-GO/TENSA/actions/workflows/{workflow}.yml)"
        assert badge in readme, f"no badge for the {workflow} workflow"
        assert link in readme, f"the {workflow} badge links nowhere"


def test_the_readme_says_the_demo_is_a_script_and_the_script_calls_no_model() -> None:
    readme = _read("README.md")
    assert "An AI agent builds" not in readme
    assert "scripted walkthrough" in readme
    assert "calls no model" in readme
    script = _read("web/scripts/agent-demo.mjs")
    assert not re.search(r"anthropic|openai|claude|gemini", script, flags=re.IGNORECASE)
    # What the script says of itself, in its header and in the badge it draws over the page,
    # is what the README says: a scripted walkthrough, not an agent.
    assert "Scripted walkthrough" in script.split("*/", 1)[0]
    assert "SCRIPTED&nbsp;DEMO" in script
    assert not re.search(r"\bAI(?:&nbsp;|\s)agent\b", script, flags=re.IGNORECASE)


def test_the_readme_and_the_docs_say_where_to_get_help() -> None:
    readme = _read("README.md")
    assert "## Getting help" in readme
    for target in (QA, SECURITY_FORM, "./SUPPORT.md", "./SECURITY.md", "./CODE_OF_CONDUCT.md"):
        assert target in readme, target
    home = _read("docs/index.md")
    assert "(support.md)" in home and "(citing.md)" in home and "(contributing-code.md)" in home


def test_the_documentation_navigation_lists_the_new_pages() -> None:
    nav = _yaml("mkdocs.yml")["nav"]
    project = next(entry["Project"] for entry in nav if "Project" in entry)
    assert {name: page for entry in project for name, page in entry.items()} == {
        "Support": "support.md",
        "Citing TENSA": "citing.md",
        "Contributing code": "contributing-code.md",
        "Contributing to the docs": "contributing.md",
    }


# ---- contributing and citing ---------------------------------------------------------------------


def test_contributing_links_the_code_of_conduct_and_gives_the_right_commands() -> None:
    text = _read("CONTRIBUTING.md")
    assert "(./CODE_OF_CONDUCT.md)" in text
    assert "## Getting help and maintenance" in text
    assert "cd server && mypy --strict src" in text
    # From the root, mypy does not read the server's configuration.
    assert "`mypy --strict server/src`" not in text
    assert 'cd server && pytest -q -m "not acceptance" tests/unit' in text
    assert "cd web && pnpm test" in text


def test_the_docs_page_for_code_gives_commands_that_run_from_the_server_directory() -> None:
    text = _read("docs/contributing-code.md")
    assert "mypy --strict src" in text and "mypy --strict server/src" not in text
    assert 'pytest -q -m "not acceptance" tests/unit' in text
    assert "CODE_OF_CONDUCT.md" in text


def test_the_citing_page_cites_andes_as_the_citation_file_does() -> None:
    cff = _yaml("CITATION.cff")
    (paper,) = cff["references"]
    page = _read("docs/citing.md")
    assert paper["doi"] == "10.1109/TPWRS.2020.3017019"
    assert f"https://doi.org/{paper['doi']}" in page
    assert f"doi     = {{{paper['doi']}}}" in page
    assert paper["title"] in page
    assert f"{paper['start']}--{paper['end']}" in page
    assert str(paper["year"]) in page


def test_the_citing_page_gives_the_software_doi_when_there_is_one_and_says_so_when_not() -> None:
    page = _read("docs/citing.md")
    doi = _yaml("CITATION.cff").get("doi")
    if doi is None:
        assert "no DOI of its own yet" in page
    else:
        assert f"https://doi.org/{doi}" in page, "CITATION.cff has a DOI the Citing page lacks"
        assert "no DOI of its own yet" not in page
    assert "license = {GPL-3.0-or-later}" in page


# ---- one name for the author and one wording for the license -------------------------------------


def test_the_author_is_one_person_under_one_name() -> None:
    cff = _yaml("CITATION.cff")
    (author,) = cff["authors"]
    assert f"{author['given-names']} {author['family-names']}" == AUTHOR
    (packaged,) = pyproject()["project"]["authors"]
    assert packaged["name"] == AUTHOR
    assert packaged["email"] == "rollerg97@gmail.com"


def test_the_mailmap_shows_the_older_names_as_the_authors() -> None:
    entries = [
        line
        for line in _read(".mailmap").splitlines()
        if line.strip() and not line.startswith("#")
    ]
    proper = f"{AUTHOR} <rollerg97@gmail.com>"
    assert sorted(line.removeprefix(proper + " ") for line in entries) == [
        "RGO <114153840+Roger-GO@users.noreply.github.com>",
        "Roger Gracia <rollerg97@gmail.com>",
    ]
    assert all(line.startswith(proper + " ") for line in entries)


def test_the_license_is_gpl_3_or_later_in_every_place_that_names_it() -> None:
    expression = "GPL-3.0-or-later"
    assert pyproject()["project"]["license"] == expression
    assert _yaml("CITATION.cff")["license"] == expression
    assert f'"license": "{expression}"' in _read("web/package.json")
    for document in ("README.md", "server/README.md", "docs/index.md"):
        text = _read(document)
        assert expression in text, f"{document} does not name the license by its identifier"
        # What is left of the wording once the right forms are taken out must not name the
        # license at all: "GPLv3", "GPL v3.0" and "General Public License v3.0" alone are the
        # "only" reading that the identifier is not.
        allowed = r"GPL-3\.0-or-later|(?:GNU GPL|General Public License) v3\.0 or later"
        rest = re.sub(allowed, "", text)
        assert not re.search(r"GPL ?v?3|General Public License v3", rest), document


def test_the_license_text_is_the_gpl_3_the_identifier_names() -> None:
    text = _read("LICENSE")
    assert "GNU GENERAL PUBLIC LICENSE" in text
    assert "Version 3, 29 June 2007" in text
