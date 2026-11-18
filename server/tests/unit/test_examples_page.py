"""``docs/examples.md`` says what the example catalog says.

The page is written from ``catalog.json`` by ``scripts/gen_examples_page.py``. A catalog entry
that is edited without the page being written again fails here, and so does a page that is
edited by hand. The renderer is also fed small catalogs of its own, since the shipped one has
no link-only entry yet and every one of its entries has a verification. The tests skip when run
away from a checkout.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from tensa.core.example_catalog import Catalog, load_catalog, parse_catalog
from tests._repo import REPO_ROOT, SCRIPTS_DIR, load_module

pytestmark = pytest.mark.unit

PAGE = REPO_ROOT / "docs" / "examples.md"


@pytest.fixture(scope="module")
def script() -> ModuleType:
    return load_module("gen_examples_page", SCRIPTS_DIR / "gen_examples_page.py")


def _page_on_disk() -> str:
    if not PAGE.is_file():
        pytest.skip("docs/examples.md is not next to the tests")
    return PAGE.read_text(encoding="utf-8")


def test_the_page_is_the_one_the_catalog_gives(script: ModuleType) -> None:
    assert _page_on_disk() == script.render_page(load_catalog()), (
        "docs/examples.md is out of date with the example catalog: "
        "run python scripts/gen_examples_page.py"
    )


def test_check_mode_passes_on_this_checkout_and_writes_nothing(script: ModuleType) -> None:
    before = _page_on_disk()
    assert script.main(["--check"]) == 0
    assert PAGE.read_text(encoding="utf-8") == before


def test_check_mode_fails_on_a_page_that_is_missing_or_edited_and_the_script_writes_it_again(
    script: ModuleType, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    page = tmp_path / "examples.md"
    monkeypatch.setattr(script, "PAGE", page)
    monkeypatch.setattr(script, "REPO_ROOT", tmp_path)
    assert script.main(["--check"]) == 1
    assert "out of date" in capsys.readouterr().err

    assert script.main([]) == 0
    assert page.read_text(encoding="utf-8") == script.render_page(load_catalog())
    assert script.main(["--check"]) == 0

    page.write_text(page.read_text(encoding="utf-8") + "\nAn edit by hand.\n", encoding="utf-8")
    assert script.main(["--check"]) == 1


def test_the_page_has_a_section_with_an_anchor_for_each_case_and_the_table_links_to_it() -> None:
    page = _page_on_disk()
    for example in load_catalog().examples:
        assert f"### {example.title} {{ #{example.id} }}" in page
        assert f"(#{example.id})" in page


def test_the_page_uses_the_plain_punctuation_of_the_documentation() -> None:
    page = _page_on_disk()
    assert "—" not in page and "–" not in page
    assert not re.search("[\U0001f300-\U0001faff☀-➿]", page)


def test_the_page_is_in_the_navigation() -> None:
    yaml = pytest.importorskip("yaml")
    nav = REPO_ROOT / "mkdocs.yml"
    if not nav.is_file():
        pytest.skip("mkdocs.yml is not next to the tests")
    assert "examples.md" in json.dumps(yaml.safe_load(nav.read_text(encoding="utf-8"))["nav"])


# ---- the renderer, on catalogs the shipped one does not yet have --------------------------


def _catalog(*entries: dict[str, Any]) -> Catalog:
    return parse_catalog(json.dumps({"version": 1, "examples": list(entries)}))


_SHA = "b" * 64
_BUNDLED: dict[str, Any] = {
    "id": "pjm",
    "title": "A bundled case | with a pipe",
    "summary": "What it is for.",
    "category": "steady-state",
    "size": {"buses": 5, "generators": 2},
    "analyses": ["pf"],
    "provenance": {
        "kind": "bundled",
        "path": "pjm/pjm.m",
        "sha256": _SHA,
        "source_url": "https://example.org/pjm.m",
        "retrieved": "2026-11-17",
    },
    "extra_files": [{"path": "pjm/pjm.dyr", "sha256": _SHA, "role": "dynamics"}],
    "citations": [
        {"text": "Cited by DOI.", "bibtex": "@misc{doi}", "doi": "10.1000/xyz"},
        {"text": "Cited by link.", "bibtex": "@misc{link}", "url": "https://example.org/paper"},
        {"text": "Cited by neither.", "bibtex": "@misc{none}"},
    ],
    "licence": {
        "name": "CC BY 4.0",
        "url": "https://creativecommons.org/licenses/by/4.0/",
        "attribution": "Credit the authors.",
    },
    "modifications": ["Changed a unit", "Dropped a table"],
    "caveats": ["Not for OPF."],
    "verification": {
        "summary": "Checked against pandapower.",
        "checks": [
            {
                "name": "Voltages | magnitude",
                "kind": "independent-solver",
                "reference": "pandapower 3.5",
                "tolerance": "1e-4 pu",
                "result": "max 3e-6 pu",
                "passed": True,
            },
            {
                "name": "Swing",
                "kind": "regression-baseline",
                "reference": "TENSA 0.5",
                "tolerance": "none",
                "result": "recorded",
                "passed": False,
            },
        ],
    },
}
_EXTERNAL: dict[str, Any] = {
    "id": "texas",
    "title": "A dataset to download",
    "summary": "Held elsewhere.",
    "category": "dynamic",
    "provenance": {"kind": "external"},
    "licence": {"name": "As stated by the source"},
    "links": [
        {"title": "Source page", "url": "https://example.org/data", "note": "Needs a form."},
        {"title": "Mirror", "url": "https://example.org/mirror"},
    ],
}


def test_a_bundled_entry_shows_its_files_source_licence_changes_and_checks(
    script: ModuleType,
) -> None:
    page = script.render_page(_catalog(_BUNDLED))
    assert "- **File:** `pjm.m`, `pjm.dyr`" in page
    assert "Bundled with TENSA as `pjm/pjm.m` from <https://example.org/pjm.m>, retrieved 2026-11-17." in page
    assert f"SHA-256 `{_SHA}`" in page
    assert "**Licence.** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Credit the authors." in page
    assert "**Changes to the data.** Changed a unit; Dropped a table" in page
    assert "- Not for OPF." in page
    assert "- Cited by DOI. [DOI](https://doi.org/10.1000/xyz)" in page
    assert "- Cited by link. [Link](https://example.org/paper)" in page
    assert "- Cited by neither.\n" in page
    assert page.count("```bibtex") == 3


def test_a_pipe_in_a_table_cell_cannot_break_the_table(script: ModuleType) -> None:
    page = script.render_page(_catalog(_BUNDLED))
    assert "[A bundled case \\| with a pipe](#pjm)" in page
    assert "| Voltages \\| magnitude | an independent solver | pandapower 3.5 |" in page


def test_a_check_against_the_cases_own_earlier_output_is_labelled_as_no_verification(
    script: ModuleType,
) -> None:
    page = script.render_page(_catalog(_BUNDLED))
    assert "TENSA's own earlier output (a baseline, not a verification)" in page
    assert "| Swing |" in page and "| no |" in page
    assert "No verification is recorded" not in page


def test_a_case_with_no_verification_says_so(script: ModuleType) -> None:
    unchecked = {key: value for key, value in _BUNDLED.items() if key != "verification"}
    page = script.render_page(_catalog(unchecked))
    assert "**Verification.** No verification is recorded for this case yet." in page


def test_a_link_only_entry_has_links_and_no_file_row(script: ModuleType) -> None:
    page = script.render_page(_catalog(_EXTERNAL))
    assert "TENSA holds no file of this case" in page
    assert "- [Source page](https://example.org/data): Needs a form." in page
    assert "- [Mirror](https://example.org/mirror)\n" in page
    assert "- **File:**" not in page and "- **First run:**" not in page
    assert "| Link |" in page and "| - |" in page


def test_a_licence_notice_is_in_the_page_whole_as_a_quotation_after_the_licence(
    script: ModuleType,
) -> None:
    """A notice the licence says must appear in every copy goes into the page with its own
    paragraphs, so that the page is one more place that carries it."""
    notice = "AGREEMENT\n\nKeep this with every copy.\n\n**NO WARRANTY**"
    entry = {**_BUNDLED, "licence": {**_BUNDLED["licence"], "notice": notice}}
    page = script.render_page(_catalog(entry))
    block = "> AGREEMENT\n>\n> Keep this with every copy.\n>\n> **NO WARRANTY**\n"
    assert block in page
    assert page.index("**Licence.**") < page.index(block) < page.index("**Citations**")
    assert "The licence asks that this notice appear, in full, in every copy of the data:" in page
    # An entry whose licence has none has no such block.
    assert "every copy of the data" not in script.render_page(_catalog(_BUNDLED))


def test_the_shipped_page_carries_the_nrel_notice_of_the_rts_gmlc_case() -> None:
    page = _page_on_disk()
    notice = next(e for e in load_catalog().examples if e.id == "rts_gmlc").licence.notice
    assert notice is not None
    assert "\n".join(f"> {line}" if line else ">" for line in notice.split("\n")) in page
