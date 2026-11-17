"""``tensa examples``: list, add and cite the example cases.

The commands work on a workspace folder directly, so no server is needed. Each test gives them a
small catalog of its own and a fake ``andes/cases`` tree, except the last two, which read the
catalog that ships.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

from tensa import cli
from tensa.core import examples
from tensa.core.example_catalog import Catalog, load_catalog, parse_catalog
from tensa.core.examples import SOURCES_FILE
from tests._cli import cli_runner

pytestmark = pytest.mark.unit

runner = cli_runner()

_FILES = {"a/a.xlsx": b"case a", "b/b.xlsx": b"case b"}


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _entry(example_id: str, path: str, **more: Any) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": example_id,
        "title": f"Case {example_id}",
        "summary": "A case for the tests.",
        "category": "dynamic",
        "size": {"buses": 14, "generators": 5},
        "analyses": ["pf", "tds", "eig"],
        "default": example_id == "a",
        "provenance": {"kind": "andes", "path": path, "sha256": _sha(_FILES[path])},
        "citations": [
            {"text": f"Text {example_id}.", "bibtex": f"@misc{{{example_id}}}"},
            {"text": "Second.", "bibtex": "@misc{second}"},
        ],
        "licence": {"name": "GPL-3.0-or-later"},
    }
    entry.update(more)
    return entry


@pytest.fixture
def catalog(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Catalog:
    cases = tmp_path / "andes_cases"
    for rel, data in _FILES.items():
        (cases / rel).parent.mkdir(parents=True, exist_ok=True)
        (cases / rel).write_bytes(data)
    external = {
        "id": "texas",
        "title": "Elsewhere",
        "summary": "Held elsewhere.",
        "category": "dynamic",
        "provenance": {"kind": "external"},
        "licence": {"name": "As stated"},
        "links": [{"title": "Page", "url": "https://example.org/texas"}],
    }
    made = parse_catalog(
        json.dumps(
            {
                "version": 1,
                "examples": [
                    _entry("a", "a/a.xlsx"),
                    _entry("b", "b/b.xlsx", citations=[]),
                    external,
                ],
            }
        )
    )
    monkeypatch.setattr(examples, "_andes_cases_dir", lambda: cases)
    monkeypatch.setattr(examples, "load_catalog", lambda: made)
    monkeypatch.setattr(cli, "load_catalog", lambda: made)
    return made


def test_the_command_group_names_its_three_commands() -> None:
    result = runner.invoke(cli.app, ["examples", "--help"])
    assert result.exit_code == 0, result.output
    for name in ("list", "add", "cite"):
        assert name in result.output


def test_list_shows_each_case_with_its_size_analyses_and_state(
    catalog: Catalog, tmp_path: Path
) -> None:
    ws = tmp_path / "ws"
    result = runner.invoke(cli.app, ["examples", "list", "--workspace", str(ws)])
    assert result.exit_code == 0, result.output
    rows = [line.split() for line in result.output.strip().splitlines()]
    assert rows[0] == ["ID", "TITLE", "SIZE", "ANALYSES", "FIRST", "RUN", "STATE"]
    assert rows[1][0] == "a" and "14 buses, 5 gens" in result.output.splitlines()[1]
    assert "pf tds eig" in result.output
    assert rows[1][-2:] == ["not", "added"]
    assert rows[3][-2:] == ["link", "only"]
    # Looking is not touching: a workspace that is not there stays not there.
    assert not ws.exists()


def test_list_marks_the_cases_that_are_in_the_workspace(catalog: Catalog, tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    assert runner.invoke(cli.app, ["examples", "add", "a", "--workspace", str(ws)]).exit_code == 0
    result = runner.invoke(cli.app, ["examples", "list", "--workspace", str(ws)])
    lines = result.output.strip().splitlines()
    assert lines[1].split()[-1] == "added"
    assert lines[2].split()[-2:] == ["not", "added"]


def test_list_json_is_the_whole_catalog_with_the_state(catalog: Catalog, tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    runner.invoke(cli.app, ["examples", "add", "a", "--workspace", str(ws)])
    result = runner.invoke(cli.app, ["examples", "list", "--json", "--workspace", str(ws)])
    assert result.exit_code == 0, result.output
    listed = json.loads(result.output)
    assert [e["id"] for e in listed] == ["a", "b", "texas"]
    assert [e["in_workspace"] for e in listed] == [True, False, False]
    assert [e["available"] for e in listed] == [True, True, False]
    assert listed[0]["citations"][0]["bibtex"] == "@misc{a}"
    assert listed[2]["links"][0]["url"] == "https://example.org/texas"


def test_add_copies_the_cases_and_says_where_the_sources_are_recorded(
    catalog: Catalog, tmp_path: Path
) -> None:
    ws = tmp_path / "new" / "workspace"
    result = runner.invoke(cli.app, ["examples", "add", "a", "b", "--workspace", str(ws)])
    assert result.exit_code == 0, result.output
    assert "a: added a.xlsx" in result.output
    assert "b: added b.xlsx" in result.output
    assert str(ws / SOURCES_FILE) in result.output
    assert (ws / "a.xlsx").read_bytes() == _FILES["a/a.xlsx"]
    assert "(`b`)" in (ws / SOURCES_FILE).read_text(encoding="utf-8")


def test_add_leaves_a_file_that_is_there_alone_and_force_replaces_it(
    catalog: Catalog, tmp_path: Path
) -> None:
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "a.xlsx").write_bytes(b"mine")
    result = runner.invoke(cli.app, ["examples", "add", "a", "--workspace", str(ws)])
    assert result.exit_code == 1
    assert "a.xlsx" in result.stderr and "--force" in result.stderr
    assert (ws / "a.xlsx").read_bytes() == b"mine"

    forced = runner.invoke(cli.app, ["examples", "add", "a", "--force", "--workspace", str(ws)])
    assert forced.exit_code == 0, forced.output
    assert "a: replaced a.xlsx" in forced.output
    assert (ws / "a.xlsx").read_bytes() == _FILES["a/a.xlsx"]


def test_a_directory_in_the_way_is_not_met_with_the_advice_to_force(
    catalog: Catalog, tmp_path: Path
) -> None:
    ws = tmp_path / "ws"
    (ws / "a.xlsx").mkdir(parents=True)
    result = runner.invoke(cli.app, ["examples", "add", "a", "--force", "--workspace", str(ws)])
    assert result.exit_code == 1
    assert "not a regular file" in result.stderr and "--force replaces" not in result.stderr


def test_one_case_that_cannot_be_added_does_not_stop_the_others(
    catalog: Catalog, tmp_path: Path
) -> None:
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "a.xlsx").write_bytes(b"mine")
    result = runner.invoke(cli.app, ["examples", "add", "a", "b", "--workspace", str(ws)])
    assert result.exit_code == 1
    assert (ws / "b.xlsx").read_bytes() == _FILES["b/b.xlsx"]
    assert "error: a:" in result.stderr


def test_an_id_the_catalog_does_not_have_is_a_usage_error_and_nothing_is_added(
    catalog: Catalog, tmp_path: Path
) -> None:
    ws = tmp_path / "ws"
    result = runner.invoke(cli.app, ["examples", "add", "a", "nope", "--workspace", str(ws)])
    assert result.exit_code == 2
    assert "no example case 'nope'" in result.output
    assert not ws.exists()


def test_a_case_that_is_only_a_link_cannot_be_added(catalog: Catalog, tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    result = runner.invoke(cli.app, ["examples", "add", "texas", "--workspace", str(ws)])
    assert result.exit_code == 2
    assert "link" in result.output
    assert not ws.exists()


def test_an_andes_file_that_is_not_the_recorded_one_is_a_warning_on_stderr(
    catalog: Catalog, tmp_path: Path
) -> None:
    (tmp_path / "andes_cases" / "a" / "a.xlsx").write_bytes(b"a newer file")
    result = runner.invoke(cli.app, ["examples", "add", "a", "--workspace", str(tmp_path / "ws")])
    assert result.exit_code == 0, result.output
    assert "warning: a:" in result.stderr
    assert "a: added a.xlsx" in result.stdout


def test_cite_prints_the_citations_and_bibtex_with_the_flag(catalog: Catalog) -> None:
    text = runner.invoke(cli.app, ["examples", "cite", "a"])
    assert text.exit_code == 0, text.output
    assert text.stdout.strip() == "Text a.\n\nSecond."
    bibtex = runner.invoke(cli.app, ["examples", "cite", "a", "--bibtex"])
    assert bibtex.stdout.strip() == "@misc{a}\n\n@misc{second}"


def test_cite_says_so_when_a_case_has_no_citations_and_refuses_an_unknown_id(
    catalog: Catalog,
) -> None:
    none = runner.invoke(cli.app, ["examples", "cite", "b"])
    assert none.exit_code == 1
    assert "no citations" in none.stderr
    assert none.stdout == ""
    unknown = runner.invoke(cli.app, ["examples", "cite", "nope"])
    assert unknown.exit_code == 2


def test_the_shipped_catalog_is_what_list_shows(tmp_path: Path) -> None:
    result = runner.invoke(
        cli.app, ["examples", "list", "--json", "--workspace", str(tmp_path / "ws")]
    )
    assert result.exit_code == 0, result.output
    assert [e["id"] for e in json.loads(result.output)] == [e.id for e in load_catalog().examples]


@pytest.mark.parametrize("example_id", [e.id for e in load_catalog().examples])
def test_every_shipped_case_can_be_cited_in_both_forms(example_id: str) -> None:
    text = runner.invoke(cli.app, ["examples", "cite", example_id])
    assert text.exit_code == 0, text.output
    assert text.stdout.strip()
    bibtex = runner.invoke(cli.app, ["examples", "cite", example_id, "--bibtex"])
    assert bibtex.exit_code == 0, bibtex.output
    assert bibtex.stdout.strip().startswith("@")
