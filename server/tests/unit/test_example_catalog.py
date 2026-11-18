"""The example catalog: its schema refuses what would break an add, and the shipped file is sound.

``catalog.json`` is data that the seeder, the API, the command line and the documentation page
all read, so it is validated when it is loaded. These tests break one rule at a time on a small
hand-written entry, then hold the real catalog to the rules that need the files around it: the
checksums of what it names, the notice that carries every licence it uses, and the plain
punctuation the documentation keeps to.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import re
from pathlib import Path
from typing import Any

import pytest

from tensa import andes_version
from tensa.core import example_catalog
from tensa.core.example_catalog import (
    CatalogError,
    case_file_problem,
    examples_dir,
    load_catalog,
    parse_catalog,
)
from tensa.core.example_references import load_reference
from tests._repo import REPO_ROOT

pytestmark = pytest.mark.unit

_SHA = "a" * 64


def _entry(**overrides: Any) -> dict[str, Any]:
    """A valid ``andes`` entry; a test changes the one thing it is about."""
    entry: dict[str, Any] = {
        "id": "small",
        "title": "A small case",
        "summary": "What it is for.",
        "category": "dynamic",
        "size": {"buses": 3, "generators": 1},
        "analyses": ["pf", "tds"],
        "provenance": {"kind": "andes", "path": "small/small.xlsx", "sha256": _SHA},
        "licence": {"name": "GPL-3.0-or-later"},
    }
    entry.update(overrides)
    return entry


def _catalog(*entries: dict[str, Any]) -> dict[str, Any]:
    return {"version": 1, "examples": list(entries)}


def _problem(*entries: dict[str, Any]) -> str:
    """The message of the error a catalog of these entries is refused with."""
    with pytest.raises(CatalogError) as caught:
        parse_catalog(json.dumps(_catalog(*entries)))
    return str(caught.value)


def test_a_valid_entry_loads_and_names_its_files() -> None:
    catalog = parse_catalog(
        json.dumps(
            _catalog(
                _entry(
                    extra_files=[{"path": "small/small.dyr", "sha256": _SHA, "role": "dynamics"}]
                )
            )
        )
    )
    (example,) = catalog.examples
    assert [(f.path, f.name, f.primary) for f in example.files()] == [
        ("small/small.xlsx", "small.xlsx", True),
        ("small/small.dyr", "small.dyr", False),
    ]
    assert catalog.get("small") is example
    assert catalog.get("other") is None
    assert catalog.defaults() == []


def test_the_defaults_are_the_entries_marked_so_in_catalog_order() -> None:
    catalog = parse_catalog(
        json.dumps(
            _catalog(
                _entry(id="b", default=True, provenance={"kind": "andes", "path": "b.xlsx", "sha256": _SHA}),
                _entry(id="a", provenance={"kind": "andes", "path": "a.xlsx", "sha256": _SHA}),
                _entry(id="c", default=True, provenance={"kind": "andes", "path": "c.xlsx", "sha256": _SHA}),
            )
        )
    )
    assert [e.id for e in catalog.defaults()] == ["b", "c"]


def test_an_external_entry_has_links_and_no_file() -> None:
    external = {
        "id": "texas",
        "title": "A dataset to download",
        "summary": "Held elsewhere.",
        "category": "dynamic",
        "provenance": {"kind": "external"},
        "licence": {"name": "As stated by the source"},
        "links": [{"title": "Source page", "url": "https://example.org/data"}],
    }
    (example,) = parse_catalog(json.dumps(_catalog(external))).examples
    assert not example.has_file
    assert example.files() == []


@pytest.mark.parametrize(
    "path",
    [
        "../small.xlsx",
        "a/../small.xlsx",
        "/etc/small.xlsx",
        "a//small.xlsx",
        "./small.xlsx",
        "a\\small.xlsx",
        "",
        ".small.xlsx",
        "small.txt",
        "small",
        "CON.xlsx",
        "small.xlsx.",
        "a:b.xlsx",
        "small.layout.json",
        "small\x00.xlsx",
        "C:/small.xlsx",
        "con/small.xlsx",
        "a /small.xlsx",
    ],
)
def test_a_path_that_leaves_its_folder_or_is_no_case_name_is_refused(path: str) -> None:
    assert case_file_problem(path) is not None
    message = _problem(_entry(provenance={"kind": "andes", "path": path, "sha256": _SHA}))
    assert "file" in message


def test_an_extra_file_is_held_to_the_same_path_rules() -> None:
    message = _problem(
        _entry(extra_files=[{"path": "../small.dyr", "sha256": _SHA, "role": "dynamics"}])
    )
    assert "../small.dyr" in message


@pytest.mark.parametrize("path", ["small.xlsx", "a/b/small.RAW", "dir/case.m", "x.dyr", "y.json"])
def test_the_case_extensions_the_lister_shows_are_accepted(path: str) -> None:
    assert case_file_problem(path) is None


def test_ids_must_be_unique_and_a_plain_slug() -> None:
    assert "used twice" in _problem(
        _entry(provenance={"kind": "andes", "path": "a.xlsx", "sha256": _SHA}),
        _entry(provenance={"kind": "andes", "path": "b.xlsx", "sha256": _SHA}),
    )
    for bad in ("Upper", "has space", "../x", "", "-lead", "a" * 41):
        assert "id" in _problem(_entry(id=bad))


def test_two_entries_may_not_write_one_file_name_whatever_its_case() -> None:
    message = _problem(
        _entry(id="a", provenance={"kind": "andes", "path": "one/case.xlsx", "sha256": _SHA}),
        _entry(id="b", provenance={"kind": "andes", "path": "two/CASE.xlsx", "sha256": _SHA}),
    )
    assert "case.xlsx" in message
    assert "a, b" in message


def test_an_entry_may_not_write_one_name_twice() -> None:
    assert "written by" in _problem(
        _entry(extra_files=[{"path": "other/small.xlsx", "sha256": _SHA, "role": "again"}])
    )


@pytest.mark.parametrize(
    ("change", "fragment"),
    [
        ({"size": None}, "needs a size"),
        ({"analyses": []}, "at least one analysis"),
        ({"analyses": ["pf", "pf", "tds"]}, "listed twice"),
        ({"category": "steady-state"}, "power flow only"),
        ({"analyses": ["pf", "eig"]}, "time-domain run"),
        ({"provenance": {"kind": "andes", "path": "a.xlsx"}}, "path and the sha256"),
        ({"provenance": {"kind": "andes", "sha256": _SHA}}, "path and the sha256"),
        (
            {"provenance": {"kind": "bundled", "path": "a.xlsx", "sha256": _SHA}},
            "source_url",
        ),
        ({"provenance": {"kind": "andes", "path": "a.xlsx", "sha256": "ABC"}}, "sha256"),
        ({"unknown_field": 1}, "unknown_field"),
        ({"size": {"buses": 0, "generators": 1}}, "buses"),
        ({"citations": [{"text": "T", "bibtex": "@misc{}", "doi": "not-a-doi"}]}, "doi"),
        ({"citations": [{"text": "T", "bibtex": "@misc{}", "url": "javascript:alert(1)"}]}, "url"),
        ({"licence": {"name": "X", "url": "ftp://example.org/licence"}}, "url"),
    ],
)
def test_an_entry_that_does_not_hold_together_is_refused(
    change: dict[str, Any], fragment: str
) -> None:
    assert fragment in _problem(_entry(**change))


def test_a_bundled_entry_needs_the_url_and_the_day_it_was_retrieved() -> None:
    bundled = {
        "kind": "bundled",
        "path": "a.m",
        "sha256": _SHA,
        "source_url": "https://example.org/a.m",
        "retrieved": "2026-11-17",
    }
    (example,) = parse_catalog(json.dumps(_catalog(_entry(provenance=bundled)))).examples
    assert example.provenance.retrieved is not None
    without_date = {k: v for k, v in bundled.items() if k != "retrieved"}
    assert "retrieved" in _problem(_entry(provenance=without_date))


@pytest.mark.parametrize(
    ("change", "fragment"),
    [
        ({"links": []}, "needs links"),
        ({"default": True}, "cannot be a default"),
        ({"provenance": {"kind": "external", "path": "a.xlsx"}}, "has no file"),
        ({"extra_files": [{"path": "a.dyr", "sha256": _SHA, "role": "x"}]}, "has no file"),
    ],
)
def test_an_external_entry_that_claims_a_file_or_has_no_links_is_refused(
    change: dict[str, Any], fragment: str
) -> None:
    external: dict[str, Any] = {
        "id": "texas",
        "title": "Elsewhere",
        "summary": "Held elsewhere.",
        "category": "dynamic",
        "provenance": {"kind": "external"},
        "licence": {"name": "As stated"},
        "links": [{"title": "Page", "url": "https://example.org"}],
    }
    external.update(change)
    assert fragment in _problem(external)


def test_not_json_and_a_wrong_version_are_catalog_errors() -> None:
    with pytest.raises(CatalogError):
        parse_catalog("{not json")
    with pytest.raises(CatalogError):
        parse_catalog(json.dumps({"version": 2, "examples": []}))


def test_an_unreadable_catalog_file_is_a_catalog_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(example_catalog, "examples_dir", lambda: tmp_path)
    load_catalog.cache_clear()
    try:
        with pytest.raises(CatalogError, match=r"catalog\.json"):
            load_catalog()
    finally:
        load_catalog.cache_clear()


# ---- the catalog that ships ---------------------------------------------------------------


def test_the_shipped_catalog_loads_and_seeds_the_five_first_run_cases() -> None:
    catalog = load_catalog()
    assert [e.id for e in catalog.defaults()] == ["ieee14", "kundur", "wscc9", "ieee39", "npcc"]
    assert [f.name for e in catalog.defaults() for f in e.files()] == [
        "ieee14_full.xlsx",
        "kundur_full.xlsx",
        "wscc9.xlsx",
        "ieee39_full.xlsx",
        "npcc.xlsx",
    ]
    # The WECC case is in the gallery only: 179 buses is too many to open a first run on.
    wecc = catalog.get("wecc")
    assert wecc is not None and not wecc.default and wecc.category == "dynamic"


def test_the_gallery_has_the_three_small_variants_and_none_of_them_is_seeded() -> None:
    catalog = load_catalog()
    expected = {
        "kundur_pss": ("kundur/kundur_ieeest.xlsx", 10),
        "ieee14_fault": ("ieee14/ieee14_fault.xlsx", 14),
        "pjm5bus": ("5bus/pjm5bus.xlsx", 5),
    }
    for example_id, (path, buses) in expected.items():
        example = catalog.get(example_id)
        assert example is not None, example_id
        assert not example.default and example.category == "dynamic"
        assert example.provenance.kind == "andes" and example.provenance.path == path
        assert example.size is not None and example.size.buses == buses
        assert set(example.analyses) == {"pf", "tds", "eig"}
        assert example.verification is not None and example.verification.checks
        assert all(check.passed for check in example.verification.checks), example_id
    # The files are different from the seeded ones, so adding one never overwrites another.
    names = [f.name for e in catalog.examples for f in e.files()]
    assert len(names) == len({n.casefold() for n in names})


def test_the_gallery_has_the_two_renewable_cases_and_the_118_bus_case_and_none_is_seeded() -> None:
    catalog = load_catalog()
    expected = {
        "ieee14_solar": ("ieee14/ieee14_solar.xlsx", 14, "dynamic", {"pf", "tds", "eig"}),
        "ieee14_wt3": ("ieee14/ieee14_wt3.xlsx", 14, "dynamic", {"pf", "tds", "eig"}),
        "ieee118": ("matpower/case118.m", 118, "steady-state", {"pf"}),
    }
    for example_id, (path, buses, category, analyses) in expected.items():
        example = catalog.get(example_id)
        assert example is not None, example_id
        assert not example.default and example.category == category
        assert example.provenance.kind == "andes" and example.provenance.path == path
        assert example.size is not None and example.size.buses == buses
        assert set(example.analyses) == analyses
        assert example.verification is not None and example.verification.checks
        assert all(check.passed for check in example.verification.checks), example_id
        # Every case says where its data comes from: a source for the system and one for ANDES.
        assert example.citations and example.licence.name == "GPL-3.0-or-later"
    # The steady-state cases are what the dialog's second group holds, the smallest first.
    assert [e.id for e in catalog.examples if e.category == "steady-state"] == [
        "ieee30",
        "ieee57",
        "ieee118",
        "ieee300",
    ]
    # The renewable cases are the IEEE 14-bus case with a converter, which says what it is not.
    for example_id in ("ieee14_solar", "ieee14_wt3"):
        example = catalog.get(example_id)
        assert example is not None
        assert any("not the IEEE 14-bus case as the University of Washington" in c for c in example.caveats)


# The git blob ids of the two PGLib-OPF files in the repository's v23.07 release (a blob id is the
# SHA-1 of ``blob <size>\0`` and the bytes): a bundled file that is not the library's own is
# found by these without a download, whatever else changed in the catalog.
PGLIB_BLOBS = {
    "pglib_opf_case30_ieee.m": "d429394621c797fa3893d4e4b6d8efa220a4015a",
    "pglib_opf_case57_ieee.m": "d8b0c9e8b45265e57f52b7ab96880ad3a874cde5",
}
PGLIB_COMMIT = "dc6be4b2f85ca0e776952ec22cbd4c22396ea5a3"


def test_the_gallery_has_the_ieee_30_57_and_300_bus_cases_and_none_is_seeded() -> None:
    catalog = load_catalog()
    expected = {
        "ieee30": ("pglib_opf_case30_ieee.m", "bundled", 30, 6),
        "ieee57": ("pglib_opf_case57_ieee.m", "bundled", 57, 7),
        "ieee300": ("matpower/case300.m", "andes", 300, 69),
    }
    for example_id, (path, kind, buses, generators) in expected.items():
        example = catalog.get(example_id)
        assert example is not None, example_id
        assert not example.default and example.category == "steady-state"
        assert example.provenance.kind == kind and example.provenance.path == path
        assert example.size is not None
        assert (example.size.buses, example.size.generators) == (buses, generators)
        assert example.analyses == ["pf"]
        assert example.verification is not None and example.verification.checks
        assert all(check.passed for check in example.verification.checks), example_id
        # A power flow only: nothing of the case is TENSA's own earlier output.
        assert {c.kind for c in example.verification.checks} <= {
            "independent-solver",
            "stored-solution",
        }
        # Every one of them is checked against a solver that shares no code with TENSA.
        assert any(c.kind == "independent-solver" for c in example.verification.checks)
    # The names the files take in a workspace are not the names of any other case's file.
    names = [f.name for e in catalog.examples for f in e.files()]
    assert len(names) == len({n.casefold() for n in names})


def test_the_pglib_files_are_bundled_with_the_credit_the_licence_asks_for() -> None:
    """CC BY 4.0: the creator and the copyright, the licence and its link, where the material is
    from, and whether it was changed. The entry, the notice and the file's own header say it."""
    catalog = load_catalog()
    notice = (examples_dir() / "NOTICE.md").read_text(encoding="utf-8")
    for example_id, name in (
        ("ieee30", "pglib_opf_case30_ieee.m"),
        ("ieee57", "pglib_opf_case57_ieee.m"),
    ):
        example = catalog.get(example_id)
        assert example is not None
        prov = example.provenance
        assert prov.release == "PGLib-OPF v23.07" and prov.retrieved is not None
        # Pinned to the commit the tag names, which a later change to the repository cannot move.
        assert prov.source_url == (
            f"https://github.com/power-grid-lib/pglib-opf/blob/{PGLIB_COMMIT}/{name}"
        )
        assert example.licence.name == "CC BY 4.0"
        assert example.licence.url == "https://creativecommons.org/licenses/by/4.0/"
        credit = example.licence.attribution or ""
        assert "Richard D. Christie" in credit and "University of Washington" in credit
        assert "pglib-opf v23.07" in credit and "no change" in credit
        # The modification is stated, and it is that there is none.
        assert len(example.modifications) == 1
        assert example.modifications[0].startswith("TENSA changed nothing")
        # The citations name the archive the data is from, the library and its report.
        text = " ".join(c.text for c in example.citations)
        assert "labs.ece.uw.edu/pstca" in text and "arXiv:1908.02788" in text
        assert any(c.url == "https://arxiv.org/abs/1908.02788" for c in example.citations)
    # The notice copies the credit, the commit and the licence, once for the two files.
    assert "Copyright (c) 1999 by Richard D. Christie" in notice
    assert PGLIB_COMMIT in notice and "TENSA changed nothing" in notice
    assert "https://creativecommons.org/licenses/by/4.0/" in notice


@pytest.mark.parametrize("name", sorted(PGLIB_BLOBS))
def test_a_bundled_pglib_file_is_the_librarys_own_with_its_header(name: str) -> None:
    source = example_catalog.bundled_cases_dir() / name
    data = source.read_bytes()
    assert hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest() == PGLIB_BLOBS[name]
    # LF only (git must not have touched it), and the header names its source and its licence.
    assert b"\r" not in data
    lines = data.decode("ascii").splitlines()
    assert lines[1].startswith("%%%%") and "IEEE PES Power Grid Library" in lines[2]
    assert "(https://github.com/power-grid-lib/pglib-opf)" in lines[3]
    header = "\n".join(lines[:30])
    assert "Copyright (c) 1999 by Richard D. Christie, University of Washington" in header
    assert "Licensed under the Creative Commons Attribution 4.0" in header
    assert "http://creativecommons.org/licenses/by/4.0/" in header


def _matpower_rows(text: str, field: str) -> list[list[float]]:
    """The numbers of one block of a MATPOWER case file (``bus``, ``gen`` or ``branch``)."""
    block = re.search(rf"mpc\.{field} = \[(.*?)\];", text, re.S)
    assert block is not None, field
    rows = []
    for line in block.group(1).splitlines():
        line = line.split("%")[0].strip().rstrip(";")
        if line:
            rows.append([float(value) for value in line.split()])
    return rows


@pytest.mark.parametrize(
    ("example_id", "name", "counts", "load", "scheduled", "slack_pmax", "ratings"),
    [
        ("ieee30", "pglib_opf_case30_ieee.m", (30, 6, 41), 283.4, 181.5, 271.0, (20.0, 267.0)),
        ("ieee57", "pglib_opf_case57_ieee.m", (57, 7, 80), 1250.8, 991.5, 245.0, (22.0, 1617.0)),
    ],
)
def test_the_numbers_the_pglib_entries_quote_are_the_files(
    example_id: str,
    name: str,
    counts: tuple[int, int, int],
    load: float,
    scheduled: float,
    slack_pmax: float,
    ratings: tuple[float, float],
) -> None:
    """What the caveats say of a PGLib file (a flat start, a set-point of 1.0 pu on every
    generator, a dispatch that does not cover the load, a rating on every branch) is what the
    file holds, and the slack of the reference solution is where they say it is against its
    limit."""
    text = (example_catalog.bundled_cases_dir() / name).read_text(encoding="ascii")
    bus, gen, branch = (_matpower_rows(text, field) for field in ("bus", "gen", "branch"))
    assert (len(bus), len(gen), len(branch)) == counts
    assert sum(row[2] for row in bus) == pytest.approx(load)
    # Columns: Vm and Va of a bus, Vg and Pmax of a generator, rate A and the angle limits of a
    # branch.
    assert {row[7] for row in bus} == {1.0} and {row[8] for row in bus} == {0.0}
    assert {row[5] for row in gen} == {1.0}
    assert sum(row[1] for row in gen) == pytest.approx(scheduled) and scheduled < load
    slack_bus = next(row[0] for row in bus if row[1] == 3)
    assert next(row[8] for row in gen if row[0] == slack_bus) == slack_pmax
    rated = [row[5] for row in branch]
    assert (min(rated), max(rated)) == ratings
    assert all(row[11:13] == [-30.0, 30.0] for row in branch)
    # A power flow makes the slack take what the dispatch leaves: 257.8 MW inside its limit in
    # the 30-bus case, and 411.7 MW, 167 MW over its limit, in the 57-bus one.
    reference = load_reference(example_id)
    assert reference is not None
    solved = next(c.expected for c in reference.checks if c.quantity == "pf.slack_p_mw")
    assert isinstance(solved, float)
    assert (solved > slack_pmax) == (example_id == "ieee57")
    entry = load_catalog().get(example_id)
    assert entry is not None
    assert f"{solved:.1f} MW" in " ".join(entry.caveats)
    if example_id == "ieee57":
        assert f"{solved - slack_pmax:.0f} MW over" in " ".join(entry.caveats)


def test_the_ieee_300_file_is_the_one_matpower_8_0_holds_and_the_entry_says_what_it_lacks() -> None:
    entry = load_catalog().get("ieee300")
    assert entry is not None
    prov = entry.provenance
    assert prov.path == "matpower/case300.m" and prov.release == "ANDES 2.0.0"
    text = " ".join(entry.caveats)
    # The three ways it is not the archive's data, and what its stored state is not.
    assert "buses 8, 10, 20, 138, 9002, 9051 and 9053" in text
    assert "buses 196 and 2040" in text and "-11.4 degrees" in text
    assert "bus 7049" in text and "2399.01 MW" in text
    assert "not a solution of the file's data" in text
    assert "base of 110 kV" in text and "no such bus" in text
    assert entry.licence.name == "GPL-3.0-or-later"
    assert any("MATPOWER/matpower/blob/8.0/data/case300.m" in (c.url or "") for c in entry.citations)


def test_the_wind_turbine_entry_does_not_hide_its_growing_mode_and_the_118_entry_says_what_it_is_not() -> (
    None
):
    catalog = load_catalog()
    wind = catalog.get("ieee14_wt3")
    assert wind is not None and wind.verification is not None
    assert any(c.startswith("The case has a growing mode.") for c in wind.caveats)
    assert "growing mode" in wind.summary
    assert "not stable" in wind.verification.summary
    # The solar case has no such mode and does not say it has.
    solar = catalog.get("ieee14_solar")
    assert solar is not None and not any("growing mode" in c for c in solar.caveats)
    case118 = catalog.get("ieee118")
    assert case118 is not None
    text = " ".join(case118.caveats)
    # Not the archive's file in two respects, and the stored state is not a solution.
    assert "15 buses" in text and "86-87 and 68-116" in text
    assert "is not a solution of the data" in text
    # The base 110 kV rule of ANDES's reader does not apply: there is no bus with a base of 0.
    assert "110 kV" in text and "does not apply" in text


def test_the_entries_say_what_the_files_do_not_do_so_that_nobody_reads_more_into_them() -> None:
    """Two things a reader would assume and a run does not give: a stabiliser that damps, and
    governors that act. The entries say neither happens, and the first is not offered as an
    improvement."""
    catalog = load_catalog()
    kundur = catalog.get("kundur_pss")
    assert kundur is not None
    assert any("does not add damping" in caveat for caveat in kundur.caveats)
    assert "no improvement" in (kundur.verification.summary if kundur.verification else "")
    pjm = catalog.get("pjm5bus")
    assert pjm is not None
    assert any("The governors do nothing" in caveat for caveat in pjm.caveats)
    assert "TG2" in " ".join(pjm.caveats)
    # What the case is checked against does not come from TENSA: no baseline stands for a check.
    assert pjm.verification is not None
    assert {c.kind for c in pjm.verification.checks} <= {
        "independent-solver",
        "ring-down",
    }


def test_the_shipped_catalog_is_the_json_a_reader_of_the_file_sees() -> None:
    text = (examples_dir() / "catalog.json").read_text(encoding="utf-8")
    assert parse_catalog(text) is not None
    assert json.loads(text)["version"] == 1


def _andes_case(path: str) -> Path | None:
    spec = importlib.util.find_spec("andes")
    if spec is None or not spec.submodule_search_locations:
        return None
    return Path(next(iter(spec.submodule_search_locations))) / "cases" / path


def test_a_recorded_andes_checksum_is_the_checksum_of_the_release_it_names() -> None:
    """Held only for the release the catalog was written against: another release may
    have changed a file, which is what the add warns about, not a mistake in the catalog."""
    checked = 0
    for example in load_catalog().examples:
        prov = example.provenance
        if prov.kind != "andes" or prov.release != f"ANDES {andes_version()}":
            continue
        for file in example.files():
            source = _andes_case(file.path)
            assert source is not None and source.is_file(), file.path
            assert hashlib.sha256(source.read_bytes()).hexdigest() == file.sha256, file.path
            checked += 1
    if not checked:
        pytest.skip(f"the catalog was not written against the installed ANDES {andes_version()}")


def test_a_bundled_file_is_the_one_the_catalog_recorded() -> None:
    for example in load_catalog().examples:
        if example.provenance.kind != "bundled":
            continue
        for file in example.files():
            source = example_catalog.bundled_cases_dir() / file.path
            assert hashlib.sha256(source.read_bytes()).hexdigest() == file.sha256, file.path


def test_git_leaves_the_bundled_case_files_byte_for_byte_as_they_came() -> None:
    """A bundled file is held to a checksum; ``* text=auto eol=lf`` would rewrite the line
    endings of one that came with CRLF, and a Windows checkout would differ again."""
    attributes = REPO_ROOT / ".gitattributes"
    if not attributes.is_file():
        pytest.skip(".gitattributes is not next to the tests")
    lines = attributes.read_text(encoding="utf-8").splitlines()
    assert "server/src/tensa/examples/cases/** -text" in lines


def test_the_notice_carries_every_licence_the_catalog_uses() -> None:
    notice = (examples_dir() / "NOTICE.md").read_text(encoding="utf-8")
    for example in load_catalog().examples:
        if not example.has_file:
            continue
        assert example.licence.name in notice, example.id
        if example.licence.url:
            assert example.licence.url in notice, example.id


def _strings(node: Any) -> list[str]:
    if isinstance(node, str):
        return [node]
    if isinstance(node, dict):
        return [s for v in node.values() for s in _strings(v)]
    if isinstance(node, list):
        return [s for v in node for s in _strings(v)]
    return []


def test_the_catalog_text_has_no_long_dash_and_no_emoji() -> None:
    """What the catalog says goes into the documentation page, which keeps to plain
    punctuation, and into a file in the user's workspace."""
    text = (examples_dir() / "catalog.json").read_text(encoding="utf-8")
    for value in _strings(json.loads(text)):
        assert "—" not in value and "–" not in value, value
        assert not re.search("[\U0001f300-\U0001faff☀-➿]", value), value


def test_every_file_entry_of_the_catalog_names_what_it_must() -> None:
    """A file entry can be added, so it says where its file is from and how to credit it."""
    for example in load_catalog().examples:
        if not example.has_file:
            continue
        assert example.provenance.sha256 and example.provenance.source_url, example.id
        assert example.citations, example.id
        for citation in example.citations:
            assert citation.text.strip() and citation.bibtex.startswith("@"), example.id


def test_a_loaded_catalog_is_not_changed_by_a_caller() -> None:
    first = load_catalog()
    assert load_catalog() is first
    with pytest.raises(ValueError, match="frozen"):
        first.examples[0].title = "changed"  # type: ignore[misc]
