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
CC_BY_URL = "https://creativecommons.org/licenses/by/4.0/"


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
    # The steady-state cases that have a file are what the dialog's second group holds, the
    # smallest first (the link-only entries are a group of their own).
    assert [e.id for e in catalog.examples if e.category == "steady-state" and e.has_file] == [
        "rts24",
        "ieee30",
        "ieee57",
        "rts_gmlc",
        "pegase89",
        "ieee118",
        "activsg200",
        "ieee300",
        "pegase1354",
        "activsg2000",
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
    "pglib_opf_case24_ieee_rts.m": "00b024c2e583b82452392514d2c22881c708ba7c",
    "pglib_opf_case30_ieee.m": "d429394621c797fa3893d4e4b6d8efa220a4015a",
    "pglib_opf_case57_ieee.m": "d8b0c9e8b45265e57f52b7ab96880ad3a874cde5",
}
# The copyright line each file's header states: the archive's data was entered by R. D. Christie
# (1999), and the RTS belongs to the IEEE (1979).
PGLIB_COPYRIGHT = {
    "pglib_opf_case24_ieee_rts.m": "Copyright (c) 1979 The Institute of Electrical and Electronics Engineers (IEEE)",
    "pglib_opf_case30_ieee.m": "Copyright (c) 1999 by Richard D. Christie, University of Washington",
    "pglib_opf_case57_ieee.m": "Copyright (c) 1999 by Richard D. Christie, University of Washington",
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
    assert PGLIB_COPYRIGHT[name] in header
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
        ("rts24", "pglib_opf_case24_ieee_rts.m", (24, 33, 38), 2850.0, 2220.5, 591.0, (175.0, 500.0)),
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
    # The limit of the slack is that of every unit it has: the RTS has three of 197 MW at bus 13.
    slack_bus = next(row[0] for row in bus if row[1] == 3)
    assert sum(row[8] for row in gen if row[0] == slack_bus) == slack_pmax
    rated = [row[5] for row in branch]
    assert (min(rated), max(rated)) == ratings
    assert all(row[11:13] == [-30.0, 30.0] for row in branch)
    # A power flow makes the slack take what the dispatch leaves: 257.8 MW inside its limit in
    # the 30-bus case, 411.7 MW, 167 MW over its limit, in the 57-bus one, and 1073.0 MW, 482 MW
    # over, in the RTS-24 one.
    reference = load_reference(example_id)
    assert reference is not None
    solved = next(c.expected for c in reference.checks if c.quantity == "pf.slack_p_mw")
    assert isinstance(solved, float)
    assert (solved > slack_pmax) == (example_id in ("ieee57", "rts24"))
    entry = load_catalog().get(example_id)
    assert entry is not None
    assert f"{solved:.1f} MW" in " ".join(entry.caveats)
    if example_id in ("ieee57", "rts24"):
        assert f"{solved - slack_pmax:.0f} MW over" in " ".join(entry.caveats)


def test_the_gallery_has_the_rts_24_rts_gmlc_and_activsg_200_cases_and_none_is_seeded() -> None:
    catalog = load_catalog()
    expected = {
        "rts24": ("pglib_opf_case24_ieee_rts.m", 24, 33, {"independent-solver"}),
        "rts_gmlc": ("RTS-GMLC.RAW", 73, 160, {"independent-solver", "published"}),
        "activsg200": (
            "case_ACTIVSg200.m",
            200,
            49,
            {"independent-solver", "stored-solution"},
        ),
    }
    for example_id, (path, buses, generators, kinds) in expected.items():
        example = catalog.get(example_id)
        assert example is not None, example_id
        assert not example.default and example.category == "steady-state"
        assert example.provenance.kind == "bundled" and example.provenance.path == path
        assert example.size is not None
        assert (example.size.buses, example.size.generators) == (buses, generators)
        assert example.analyses == ["pf"]
        assert example.verification is not None and example.verification.checks
        assert all(check.passed for check in example.verification.checks), example_id
        # A power flow only, checked against what TENSA did not compute: no baseline stands for one.
        assert {c.kind for c in example.verification.checks} == kinds, example_id
        # Every one is held to a solver that shares no code with TENSA, and says where its file is
        # from, pinned to what a later change to the source cannot move.
        assert example.provenance.retrieved is not None
        assert "/blob/" in (example.provenance.source_url or "")
        assert example.modifications and example.modifications[0].startswith("TENSA changed nothing")
    names = [f.name for e in catalog.examples for f in e.files()]
    assert len(names) == len({n.casefold() for n in names})
    # Only the RTS-GMLC one carries a notice that must go with every copy of its data.
    assert [e.id for e in catalog.examples if e.licence.notice] == ["rts_gmlc"]


def test_the_rts_24_file_is_credited_to_the_ieee_and_the_library_as_its_licence_asks() -> None:
    """CC BY 4.0 again, with another creator than the 30 and 57-bus files: the IEEE, whose
    copyright the header of the file states."""
    entry = load_catalog().get("rts24")
    assert entry is not None
    name = "pglib_opf_case24_ieee_rts.m"
    prov = entry.provenance
    assert prov.release == "PGLib-OPF v23.07" and prov.retrieved is not None
    assert prov.source_url == f"https://github.com/power-grid-lib/pglib-opf/blob/{PGLIB_COMMIT}/{name}"
    assert entry.licence.name == "CC BY 4.0" and entry.licence.url == CC_BY_URL
    credit = entry.licence.attribution or ""
    assert "The Institute of Electrical and Electronics Engineers (IEEE)" in credit
    assert "IEEE Reliability Test System Task Force" in credit and "pglib-opf v23.07" in credit
    assert "no change" in credit and "M. E. Brennan" in credit
    assert "@" not in credit  # the header's contact address is the file's, and is not repeated
    # The system's own paper, the library and its report, MATPOWER's paper (the file's format).
    dois = {c.doi for c in entry.citations}
    assert {"10.1109/TPAS.1979.319398", "10.1109/TPWRS.2010.2051168"} <= dois
    assert any(c.url == "https://arxiv.org/abs/1908.02788" for c in entry.citations)
    text = " ".join(c.text for c in entry.citations)
    assert "00b024c2e583b82452392514d2c22881c708ba7c" in text and "the paper's text" in text
    notice = (examples_dir() / "NOTICE.md").read_text(encoding="utf-8")
    assert PGLIB_COPYRIGHT[name] in notice and "pglib_opf_case24_ieee_rts.m" in notice
    assert "doi:10.1109/TPAS.1979.319398" in notice


# Where each bundled file that is not PGLib's comes from: the repository's git blob id of the file
# at the commit its entry names (so a copy that is not the source's own is found without a
# download), and the commit.
MATPOWER_81_COMMIT = "1a828c7af590714499284e36ee9c81273388c594"
RTS_GMLC_COMMIT = "3ece0d3725c844056132393ee252b3083dd4eab4"
SOURCE_BLOBS = {
    "case_ACTIVSg200.m": "7f707e91b414de417f25492f47ed81cee8e6c981",
    "case_ACTIVSg2000.m": "26c5add5b09e3d24d16cef254932ac385a37ebcc",
    "case89pegase.m": "71f1cf78dc523e4a3ffe532261d0525297cbab8b",
    "case1354pegase.m": "d6ede376f35af472b45b93ae771209c483427c26",
    "RTS-GMLC.RAW": "41372a04c008b48027fbec4c239014bf3791b776",
}
# What the header of each MATPOWER file says about who holds the copyright and under which licence.
MATPOWER_HEADERS = {
    "case_ACTIVSg200.m": (
        "%   MATPOWER\n%   Copyright (c) 2017 by A.B. Birchfield, T. Xu, K.M. Gegner, K.S. Shetye,\n"
        "%   and T.J. Overbye\n%   Licensed under the Creative Commons Attribution 4.0 International "
        "license,\n%   https://creativecommons.org/licenses/by/4.0/\n",
        "doi: 10.1109/TPWRS.2016.2616385",
    ),
    "case_ACTIVSg2000.m": (
        "%   MATPOWER\n%   Copyright (c) 2017-2018 by A.B. Birchfield, T. Xu, K.M. Gegner, K.S. Shetye,\n"
        "%   and T.J. Overbye\n%   Licensed under the Creative Commons Attribution 4.0 International "
        "license,\n%   https://creativecommons.org/licenses/by/4.0/\n",
        "doi: 10.1109/TPWRS.2016.2616385",
    ),
    "case89pegase.m": (
        "%   MATPOWER\n%   Copyright (c) 2015, 2016 by C\u00e9dric Josz, St\u00e9phane Fliscounakis, Jean Maeght,\n"
        "%   and Patrick Panciatici\n%   Licensed under the Creative Commons Attribution 4.0 International "
        "license,\n%   https://creativecommons.org/licenses/by/4.0/\n",
        "https://doi.org/10.1109/TPWRS.2013.2251015",
    ),
    "case1354pegase.m": (
        "%   MATPOWER\n%   Copyright (c) 2015, 2016 by C\u00e9dric Josz, St\u00e9phane Fliscounakis, Jean Maeght,\n"
        "%   and Patrick Panciatici\n%   Licensed under the Creative Commons Attribution 4.0 International "
        "license,\n%   https://creativecommons.org/licenses/by/4.0/\n",
        "https://doi.org/10.1109/TPWRS.2013.2251015",
    ),
}


@pytest.mark.parametrize("name", sorted(SOURCE_BLOBS))
def test_a_bundled_file_that_is_not_pglibs_is_its_sources_own_and_the_entry_pins_the_commit(
    name: str,
) -> None:
    data = (example_catalog.bundled_cases_dir() / name).read_bytes()
    assert hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest() == SOURCE_BLOBS[name]
    assert b"\r" not in data  # git must not have touched it
    entry = next(e for e in load_catalog().examples if e.provenance.path == name)
    prov = entry.provenance
    assert prov.sha256 == hashlib.sha256(data).hexdigest()
    if name == "RTS-GMLC.RAW":
        assert prov.source_url == (
            f"https://github.com/GridMod/RTS-GMLC/blob/{RTS_GMLC_COMMIT}"
            "/RTS_Data/FormattedData/PSSE/RTS-GMLC.RAW"
        )
        assert prov.release == "RTS-GMLC v0.2.3"
        # The one line of header the file has: the PowerWorld version it was saved from.
        first = data.decode("ascii").splitlines()[0]
        assert first.startswith(" 0,    100.00, 33, 0, 0, 60.00") and "Simulator Version 19" in first
        assert "November 07, 2017" in first
    else:
        assert prov.source_url == (
            f"https://github.com/MATPOWER/matpower/blob/{MATPOWER_81_COMMIT}/data/{name}"
        )
        assert prov.release == "MATPOWER 8.1"
        header = data.decode("utf-8")[:4000]
        copyright_lines, cited = MATPOWER_HEADERS[name]
        assert copyright_lines in header
        assert cited in header


def test_the_activsg_200_entry_credits_the_authors_and_says_what_the_page_it_comes_from_does_not() -> None:
    entry = load_catalog().get("activsg200")
    assert entry is not None
    assert entry.licence.name == "CC BY 4.0" and entry.licence.url == CC_BY_URL
    credit = entry.licence.attribution or ""
    assert "A. B. Birchfield, T. Xu, K. M. Gegner, K. S. Shetye and T. J. Overbye" in credit
    assert "MATPOWER Copyright (c) 2017" in credit and "no change" in credit
    assert "names no licence" in credit
    assert "10.1109/TPWRS.2016.2616385" in {c.doi for c in entry.citations}
    assert any("electricgrids.engr.tamu.edu" in (c.url or "") for c in entry.citations)
    text = " ".join(entry.caveats)
    assert "no relation to the actual grid" in text and "free for commercial or non-commercial use" in text
    assert "Texas A&M offers the case with dynamic models, which TENSA does not bundle" in text


def test_the_activsg_200_numbers_the_entry_quotes_are_the_file() -> None:
    text = (example_catalog.bundled_cases_dir() / "case_ACTIVSg200.m").read_text(encoding="ascii")
    bus, gen, branch = (_matpower_rows(text, field) for field in ("bus", "gen", "branch"))
    assert (len(bus), len(gen), len(branch)) == (200, 49, 245)
    # Columns: base kV of a bus; status, Vg and the limits of a generator; rate A of a branch.
    assert {row[9] for row in bus} == {13.8, 115.0, 230.0}
    assert sum(1 for row in bus if row[9] == 13.8) == 49  # the generator buses
    assert sum(row[2] for row in bus) == pytest.approx(1475.69)
    assert sum(row[3] for row in bus) == pytest.approx(420.55)
    assert sorted(row[5] for row in bus if row[5]) == [30.0, 30.0, 50.0, 80.0]
    assert sum(1 for row in gen if row[7]) == 38 and {row[5] for row in gen} == {1.04}
    assert (min(row[5] for row in branch), max(row[5] for row in branch)) == (7.4, 740.0)
    assert "mpc.dcline" not in text
    entry = load_catalog().get("activsg200")
    assert entry is not None
    caveats = " ".join(entry.caveats)
    for quoted in ("38 in service", "245 branches rated from 7.4 to 740 MVA", "1475.7 MW and 420.6 MVAr"):
        assert quoted in caveats
    assert "four shunts of 30 to 80 MVAr" in caveats


def test_the_gallery_has_the_pegase_and_activsg_2000_cases_and_none_is_seeded() -> None:
    catalog = load_catalog()
    expected = {
        "pegase89": ("case89pegase.m", 89, 12, {"independent-solver", "stored-solution"}),
        "pegase1354": ("case1354pegase.m", 1354, 260, {"independent-solver"}),
        "activsg2000": (
            "case_ACTIVSg2000.m",
            2000,
            544,
            {"independent-solver", "stored-solution"},
        ),
    }
    for example_id, (path, buses, generators, kinds) in expected.items():
        example = catalog.get(example_id)
        assert example is not None, example_id
        assert not example.default and example.category == "steady-state"
        assert example.provenance.kind == "bundled" and example.provenance.path == path
        assert example.size is not None
        assert (example.size.buses, example.size.generators) == (buses, generators)
        assert example.analyses == ["pf"]
        assert example.verification is not None and example.verification.checks
        assert all(check.passed for check in example.verification.checks), example_id
        # A power flow only, checked against what TENSA did not compute: no baseline stands for one.
        assert {c.kind for c in example.verification.checks} == kinds, example_id
        assert example.provenance.retrieved is not None
        assert "/blob/" in (example.provenance.source_url or "")
        assert example.modifications and example.modifications[0].startswith("TENSA changed nothing")
        assert example.licence.name == "CC BY 4.0" and example.licence.url == CC_BY_URL
        assert example.licence.notice is None
        # A case with no time-domain run has no baseline, and the entry says nothing rests on TENSA's own output.
        assert "nothing in it is a regression baseline" in example.verification.summary
    # The one that has the fewest buses and the ones with the most close the steady-state group.
    cases = [e.id for e in catalog.examples if e.category == "steady-state" and e.has_file]
    assert cases[-2:] == [
        "pegase1354",
        "activsg2000",
    ]


def test_the_pegase_files_are_credited_to_their_authors_at_rte_and_say_their_data_is_fictitious() -> None:
    catalog = load_catalog()
    for example_id, name in (("pegase89", "case89pegase.m"), ("pegase1354", "case1354pegase.m")):
        entry = catalog.get(example_id)
        assert entry is not None
        credit = entry.licence.attribution or ""
        assert "C\u00e9dric Josz, St\u00e9phane Fliscounakis, Jean Maeght and Patrick Panciatici" in credit
        assert "R\u00e9seau de Transport d'Electricit\u00e9 (RTE)" in credit
        assert "MATPOWER Copyright (c) 2015, 2016 by C\u00e9dric Josz" in credit and "no change" in credit
        assert f"release 8.1, {name}" in credit
        # The two papers the header of the file asks that a publication cite, each opened or checked.
        dois = {c.doi for c in entry.citations}
        assert {"10.1109/TPWRS.2013.2251015", "10.1109/TPWRS.2010.2051168"} <= dois
        assert any(c.url == "https://arxiv.org/abs/1603.01533" for c in entry.citations)
        text = " ".join(c.text for c in entry.citations)
        assert "The text of the paper was not read" in text and "behind a paywall and was not read" in text
        assert "did not resolve when checked" in text
        # The system is not a real one, and the entry says so before anything else.
        caveats = " ".join(entry.caveats)
        assert caveats.startswith("The data is fictitious.") and "not for the operation and planning" in caveats
        assert "phase shift" in caveats and "andes/io/matpower.py" in caveats
    # The authors' names are the file's own, accents and all, in the catalog and in the notice.
    notice = (examples_dir() / "NOTICE.md").read_text(encoding="utf-8")
    assert "Credit, PEGASE 89-bus and 1354-bus" in notice and "C\u00e9dric Josz, St\u00e9phane" in notice
    assert "doi:10.1109/TPWRS.2013.2251015" in notice and "arXiv:1603.01533" in notice


def test_the_activsg_2000_entry_credits_the_authors_and_says_what_the_page_it_comes_from_does_not() -> None:
    entry = load_catalog().get("activsg2000")
    assert entry is not None
    credit = entry.licence.attribution or ""
    assert "A. B. Birchfield, T. Xu, K. M. Gegner, K. S. Shetye and T. J. Overbye" in credit
    assert "MATPOWER Copyright (c) 2017-2018" in credit and "no change" in credit
    assert "names no licence" in credit
    assert "10.1109/TPWRS.2016.2616385" in {c.doi for c in entry.citations}
    assert any(
        c.url == "https://electricgrids.engr.tamu.edu/electric-grid-test-cases/activsg2000/"
        for c in entry.citations
    )
    text = " ".join(entry.caveats)
    assert "bears no relation to the actual grid" in text and "free for commercial or non-commercial use" in text
    assert "Texas A&M offers the case with dynamic models, which TENSA does not bundle" in text
    notice = (examples_dir() / "NOTICE.md").read_text(encoding="utf-8")
    assert "Credit, ACTIVSg2000" in notice and "MATPOWER Copyright (c) 2017-2018" in notice


def test_the_numbers_the_new_entries_quote_are_the_files() -> None:
    """Counts and totals as the entries give them, read from the files themselves (the PEGASE files
    are UTF-8: their authors' names have accents)."""
    quoted = {
        # file: (buses, generators, branches, load MW, load MVAr, generators in service,
        #        branches between buses of different base voltages, buses with a shunt)
        "case89pegase.m": (89, 12, 210, 5727.9, 1374.9, 12, 47, 44),
        "case1354pegase.m": (1354, 260, 1991, 73059.7, 13401.4, 260, 234, 1082),
        "case_ACTIVSg2000.m": (2000, 544, 3206, 67109.2, 19014.3, 432, 847, 149),
    }
    for name, (buses, gens, branches, mw, mvar, in_service, transformers, shunts) in quoted.items():
        text = (example_catalog.bundled_cases_dir() / name).read_text(encoding="utf-8")
        bus, gen, branch = (_matpower_rows(text.replace("Inf", "1e999"), f) for f in ("bus", "gen", "branch"))
        assert (len(bus), len(gen), len(branch)) == (buses, gens, branches), name
        assert sum(row[2] for row in bus) == pytest.approx(mw, abs=0.05), name
        assert sum(row[3] for row in bus) == pytest.approx(mvar, abs=0.05), name
        assert sum(1 for row in gen if row[7]) == in_service, name
        assert sum(1 for row in bus if row[4] or row[5]) == shunts, name
        kv = {row[0]: row[9] for row in bus}
        assert sum(1 for row in branch if kv[row[0]] != kv[row[1]]) == transformers, name
        # Nothing is out of service among the branches, and every branch's charging is 0 in the PEGASE files.
        assert all(row[10] == 1.0 for row in branch), name
        if "pegase" in name:
            assert all(row[4] == 0.0 for row in branch), name
        # The slack is the one bus of type 3, and its generator is in service.
        assert sum(1 for row in bus if row[1] == 3) == 1, name
    # The buses that carry a negative load: six, 2430.8 MW in all, in the 89-bus file; 52 and 1086.3 MW in the other.
    for name, count, total in (("case89pegase.m", 6, -2430.8), ("case1354pegase.m", 52, -1086.3)):
        rows = _matpower_rows((example_catalog.bundled_cases_dir() / name).read_text(encoding="utf-8"), "bus")
        negative = [row[2] for row in rows if row[2] < 0]
        assert len(negative) == count and sum(negative) == pytest.approx(total, abs=0.05), name
    # The two PEGASE files give a generator reactive limits of plus and minus infinity: 1354 two, 89 none.
    big = (example_catalog.bundled_cases_dir() / "case1354pegase.m").read_text(encoding="utf-8")
    assert len(re.findall(r"\bInf\b", big)) == 4 and "-Inf" in big
    entry = load_catalog().get("pegase1354")
    assert entry is not None and "of plus and minus infinity" in " ".join(entry.caveats)


# The notice of the NREL data use agreement, which must appear in all copies of the RTS-GMLC data.
NOTICE_FILE = "RTS-GMLC-NOTICE.md"


def test_the_nrel_notice_is_whole_in_the_catalog_beside_the_file_and_in_the_notice() -> None:
    """The agreement lets the data be copied provided that its entire notice appears in all copies.
    The repository's copy ends in the middle of a sentence, and TENSA's does not go further."""
    entry = load_catalog().get("rts_gmlc")
    assert entry is not None
    notice = entry.licence.notice
    assert notice is not None
    beside = (example_catalog.bundled_cases_dir() / NOTICE_FILE).read_text(encoding="utf-8")
    assert beside == notice + "\n"
    in_notice = (examples_dir() / "NOTICE.md").read_text(encoding="utf-8")
    assert "\n".join(example_catalog.quoted_notice(notice)) in in_notice
    # The agreement as the repository prints it: its grant, the credit it asks for, the indemnity
    # and the disclaimer, the last of them stopping where the repository's copy stops.
    assert notice.startswith("DATA USE DISCLAIMER AGREEMENT\n*(\u201cAgreement\u201d)*\n\n")
    assert "provided that this entire notice appears in all copies of the Data" in notice
    assert "the user agrees to credit DOE/NREL/ALLIANCE in any publication" in notice
    assert "YOU AGREE TO INDEMNIFY DOE/NREL/ALLIANCE" in notice
    assert notice.endswith("THAT ARISES OUT OF OR IN**")
    assert len(notice.split("\n\n")) == 4
    flowed = " ".join(in_notice.split())
    assert "ends in the middle of a sentence" in flowed and "TENSA has not completed it" in flowed
    # The entry's credit names what is asked and the places the notice is put.
    credit = entry.licence.attribution or ""
    assert "Barrows et al. (2020)" in credit and "may not be used in advertising or publicity" in credit
    assert NOTICE_FILE in credit and "EXAMPLE-SOURCES.md" in credit
    assert entry.licence.name == "NREL Data Use Disclaimer Agreement"
    assert entry.licence.url == f"https://github.com/GridMod/RTS-GMLC/blob/{RTS_GMLC_COMMIT}/README.md"
    assert "10.1109/TPWRS.2019.2925557" in {c.doi for c in entry.citations}


def test_the_notice_field_is_for_a_licence_and_has_a_limit() -> None:
    licence = {"name": "A licence", "notice": "Keep this with every copy."}
    (example,) = parse_catalog(json.dumps(_catalog(_entry(licence=licence)))).examples
    assert example.licence.notice == "Keep this with every copy."
    assert _entry()["licence"].get("notice") is None
    assert "notice" in _problem(_entry(licence={"name": "A licence", "notice": "x" * 4001}))
    assert example_catalog.quoted_notice("a\n\nb\n") == ["> a", ">", "> b"]


def test_the_rts_gmlc_entry_says_what_the_file_has_in_place_of_its_dc_line() -> None:
    entry = load_catalog().get("rts_gmlc")
    assert entry is not None
    text = " ".join(entry.caveats)
    # The DC line is not in the file: its section is empty, and two generator records named DC stand
    # for its ends. ANDES skips the section silently (the integration test shows it).
    assert "its two-terminal DC section is empty" in text
    assert "two generator records named DC" in text and "100 MW transfer is not in the case" in text
    assert "skips every other section, two-terminal DC data included, with no message" in text
    assert "160 generator records are the 158 generators" in text
    assert "98 of the 160 generator records are in service" in text
    assert "the report marks every one as locked" in text
    summary = entry.verification.summary if entry.verification else ""
    assert "PSS/E reader written for the check" in summary and "state the file stores is not a solution" in summary


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


LINK_ONLY = [
    "activsg200_dyn",
    "activsg2000_dyn",
    "wecc240",
    "pes_benchmarks",
    "nordic",
    "uw_dynamic",
    "matpower_library",
    "pglib_opf_library",
    "uw_archive",
    "tamu_repository",
    "edinburgh_gb",
]


def test_the_link_only_entries_close_the_catalog_and_hold_no_file_and_none_is_seeded() -> None:
    catalog = load_catalog()
    assert [e.id for e in catalog.examples if not e.has_file] == LINK_ONLY
    assert [e.id for e in catalog.examples][-len(LINK_ONLY) :] == LINK_ONLY
    for entry in catalog.examples:
        if entry.id in LINK_ONLY:
            assert not entry.default and entry.files() == [] and entry.extra_files == []
            assert entry.provenance.path is None and entry.provenance.sha256 is None


def test_every_link_only_entry_says_where_the_data_is_who_to_cite_and_what_was_tried() -> None:
    for example_id in LINK_ONLY:
        entry = load_catalog().get(example_id)
        assert entry is not None
        assert entry.links and all(link.url.startswith(("http://", "https://")) for link in entry.links)
        assert len({link.url for link in entry.links}) == len(entry.links), example_id
        assert entry.citations, example_id
        for citation in entry.citations:
            assert citation.text.strip() and citation.bibtex.startswith("@"), example_id
            assert citation.doi or citation.url, example_id
        assert entry.licence.url and entry.licence.attribution, example_id
        # The words of the verification are the entry's own: what was run or that nothing was.
        assert entry.verification is not None and entry.verification.summary.strip(), example_id
        assert entry.caveats, example_id


def test_a_link_only_entry_claims_only_checks_against_a_reference_that_is_not_tensas_own() -> None:
    """These entries were tried once, by a script, and no baseline of TENSA's own output is
    kept for them: a check is an independent solver's or the solution a file stores."""
    for example_id in LINK_ONLY:
        entry = load_catalog().get(example_id)
        assert entry is not None and entry.verification is not None
        for check in entry.verification.checks:
            assert check.kind in {"independent-solver", "stored-solution"}, example_id
        if not entry.verification.checks:
            assert "nothing is verified" in entry.verification.summary.lower() or (
                "nothing was run" in entry.verification.summary.lower()
            ), example_id


def test_what_a_link_only_entry_could_not_run_is_not_listed_among_its_analyses() -> None:
    """The cards show the analyses as badges: only what ran counts. The two dynamic datasets
    whose 10 s run does not start offer a power flow and no time-domain run."""
    catalog = load_catalog()
    for example_id in ("wecc240", "activsg2000_dyn"):
        entry = catalog.get(example_id)
        assert entry is not None
        assert entry.analyses == ["pf"], example_id
        assert any("does not start" in c for c in entry.caveats), example_id
        assert entry.verification is not None
        assert "time-domain" in entry.verification.summary
    for example_id in LINK_ONLY:
        entry = catalog.get(example_id)
        assert entry is not None and "tds" not in entry.analyses and "eig" not in entry.analyses


def test_a_check_that_failed_is_recorded_as_failed_with_its_reason() -> None:
    """The stored state of ACTIVSg2000's RAW file is not reproduced; the entry says so in its
    checks and its summary, and does not quietly drop the check."""
    entry = load_catalog().get("activsg2000_dyn")
    assert entry is not None and entry.verification is not None
    failed = [c for c in entry.verification.checks if not c.passed]
    assert [c.kind for c in failed] == ["stored-solution", "stored-solution"]
    assert all("outside the bound" in c.result for c in failed)
    assert "recorded as failed" in entry.verification.summary
    passed = [c for c in entry.verification.checks if c.passed]
    assert passed and all(c.kind == "independent-solver" for c in passed)


def test_the_datasets_that_could_not_be_downloaded_say_why_and_have_no_result() -> None:
    entry = load_catalog().get("activsg200_dyn")
    assert entry is not None and entry.verification is not None
    assert entry.verification.checks == []
    assert any("form" in c and "email" in c for c in entry.caveats)
    assert entry.analyses == []
