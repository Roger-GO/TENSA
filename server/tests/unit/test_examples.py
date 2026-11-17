"""Unit tests for the example cases: the first-run seeder and ``add_example`` (``core.examples``).

All filesystem interaction happens under ``tmp_path``. The ANDES cases directory and the
bundled one are monkeypatched, and each test that needs a catalog writes its own small one, so
the tests depend on neither the installed ANDES nor the shipped catalog (which has two tests of
its own at the end).
"""

from __future__ import annotations

import errno
import hashlib
import json
import os
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from tensa.core import examples
from tensa.core.example_catalog import Catalog, load_catalog, parse_catalog
from tensa.core.examples import (
    SOURCES_FILE,
    SUPPORTED_CASE_EXTENSIONS,
    ExampleExistsError,
    ExampleHasNoFileError,
    ExampleIntegrityError,
    ExampleSourceMissingError,
    UnknownExampleError,
    add_example,
    example_statuses,
    format_citations,
    seed_example_cases,
)
from tensa.security.paths import WorkspacePathError, list_workspace_files

pytestmark = pytest.mark.unit

_FILES = {
    "one/one.xlsx": b"one data",
    "two/two.xlsx": b"two data",
    "three/three.raw": b"three data",
    "three/three.dyr": b"three dynamics",
}

_EXTERNAL: dict[str, Any] = {
    "id": "texas",
    "title": "Elsewhere",
    "summary": "Held elsewhere.",
    "category": "dynamic",
    "provenance": {"kind": "external"},
    "licence": {"name": "As stated"},
    "links": [{"title": "Page", "url": "https://example.org"}],
}


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _entry(example_id: str, path: str, *, default: bool = False, **more: Any) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": example_id,
        "title": f"Case {example_id}",
        "summary": "A case for the tests.",
        "category": "dynamic",
        "size": {"buses": 3, "generators": 1},
        "analyses": ["pf", "tds"],
        "default": default,
        "provenance": {
            "kind": "andes",
            "path": path,
            "sha256": _sha(_FILES[path]),
            "release": "ANDES 2.0.0",
            "source_url": f"https://example.org/andes/{path}",
        },
        "citations": [
            {"text": f"Citation text of {example_id}.", "bibtex": f"@misc{{{example_id}}}"}
        ],
        "licence": {
            "name": "GPL-3.0-or-later",
            "url": "https://example.org/licence",
            "attribution": "Cite the paper.",
        },
        "modifications": ["a change"],
        "caveats": ["a caveat"],
    }
    entry.update(more)
    return entry


def _catalog(*entries: dict[str, Any]) -> Catalog:
    return parse_catalog(json.dumps({"version": 1, "examples": list(entries)}))


@pytest.fixture
def fake_cases_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A fake ``andes/cases`` tree holding the files the catalogs below name."""
    cases = tmp_path / "andes_pkg" / "cases"
    for rel, data in _FILES.items():
        target = cases / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    monkeypatch.setattr(examples, "_andes_cases_dir", lambda: cases)
    return cases


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    ws.mkdir(mode=0o700)
    return ws


@pytest.fixture
def catalog() -> Catalog:
    dyr = {"path": "three/three.dyr", "sha256": _sha(_FILES["three/three.dyr"]), "role": "dynamics"}
    return _catalog(
        _entry("one", "one/one.xlsx", default=True),
        _entry("two", "two/two.xlsx", default=True),
        _entry("three", "three/three.raw", extra_files=[dyr]),
    )


@pytest.fixture
def seeds(catalog: Catalog, monkeypatch: pytest.MonkeyPatch) -> Catalog:
    """The seeder reads this catalog instead of the shipped one."""
    monkeypatch.setattr(examples, "load_catalog", lambda: catalog)
    return catalog


# ---- seeding ----------------------------------------------------------------------------


def test_seeds_empty_workspace_with_the_default_entries_only(
    fake_cases_dir: Path, workspace: Path, seeds: Catalog
) -> None:
    copied = seed_example_cases(workspace)
    assert copied == ["one.xlsx", "two.xlsx"]
    assert (workspace / "one.xlsx").read_bytes() == _FILES["one/one.xlsx"]
    assert (workspace / "two.xlsx").read_bytes() == _FILES["two/two.xlsx"]
    assert not (workspace / "three.raw").exists()
    assert sorted(p.name for p in workspace.iterdir()) == [SOURCES_FILE, "one.xlsx", "two.xlsx"]


def test_the_seeder_reads_what_to_seed_from_the_catalog_not_from_a_list_of_its_own(
    fake_cases_dir: Path, workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    only_two = _catalog(_entry("two", "two/two.xlsx", default=True))
    monkeypatch.setattr(examples, "load_catalog", lambda: only_two)
    assert seed_example_cases(workspace) == ["two.xlsx"]


def test_does_not_seed_when_case_files_exist(
    fake_cases_dir: Path, workspace: Path, seeds: Catalog
) -> None:
    """A workspace with ANY supported case file is left untouched."""
    existing = workspace / "mycase.raw"
    existing.write_text("user data")
    assert seed_example_cases(workspace) == []
    assert sorted(p.name for p in workspace.iterdir()) == ["mycase.raw"]
    assert existing.read_text() == "user data"


def test_does_not_reseed_after_first_seed(
    fake_cases_dir: Path, workspace: Path, seeds: Catalog
) -> None:
    """A second call sees the seeded files as case files and is a no-op."""
    assert len(seed_example_cases(workspace)) == 2
    # User deletes one of the two; the survivor still blocks re-seeding.
    (workspace / "two.xlsx").unlink()
    assert seed_example_cases(workspace) == []
    assert not (workspace / "two.xlsx").exists()


def test_non_case_files_do_not_block_seeding(
    fake_cases_dir: Path, workspace: Path, seeds: Catalog
) -> None:
    """Unsupported extensions, hidden files, directories and the sources file don't count
    as case files: the workspace is still 'empty' for seeding purposes."""
    (workspace / "notes.txt").write_text("hi")
    (workspace / ".hidden.xlsx").write_text("hidden")
    (workspace / "subdir").mkdir()
    (workspace / SOURCES_FILE).write_text("# my notes\n")
    assert len(seed_example_cases(workspace)) == 2


def test_missing_andes_cases_dir_is_a_warning_not_a_crash(
    workspace: Path,
    seeds: Catalog,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """When ANDES's bundled cases can't be located, seeding logs and skips."""
    monkeypatch.setattr(examples, "_andes_cases_dir", lambda: None)
    with caplog.at_level("WARNING", logger="tensa.examples"):
        assert seed_example_cases(workspace) == []
    assert any("could not seed example case one" in r.message for r in caplog.records)
    assert list(workspace.iterdir()) == []


def test_partial_bundle_copies_what_exists(
    fake_cases_dir: Path,
    workspace: Path,
    seeds: Catalog,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A missing individual case is skipped with a warning; the others are still seeded."""
    (fake_cases_dir / "one" / "one.xlsx").unlink()
    with caplog.at_level("WARNING", logger="tensa.examples"):
        copied = seed_example_cases(workspace)
    assert copied == ["two.xlsx"]
    assert any("could not seed example case one" in r.message for r in caplog.records)


def test_seeder_never_raises(fake_cases_dir: Path, tmp_path: Path, seeds: Catalog) -> None:
    """A bogus workspace path (resolve fails inside list_workspace_files)
    is swallowed into an empty result: startup must never crash."""
    assert seed_example_cases(tmp_path / "does-not-exist") == []


def test_a_catalog_that_cannot_be_loaded_does_not_stop_the_server_starting(
    workspace: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def broken() -> Catalog:
        raise RuntimeError("catalog is damaged")

    monkeypatch.setattr(examples, "load_catalog", broken)
    with caplog.at_level("WARNING", logger="tensa.examples"):
        assert seed_example_cases(workspace) == []
    assert any("catalog is damaged" in r.message for r in caplog.records)


# ---- adding one -------------------------------------------------------------------------


def test_add_copies_the_file_and_says_what_it_wrote(
    fake_cases_dir: Path, workspace: Path, catalog: Catalog
) -> None:
    result = add_example("one", workspace, catalog=catalog)
    assert [(f.name, f.size_bytes, f.replaced) for f in result.files] == [
        ("one.xlsx", len(_FILES["one/one.xlsx"]), False)
    ]
    assert result.warnings == ()
    assert result.example.id == "one"
    assert (workspace / "one.xlsx").read_bytes() == _FILES["one/one.xlsx"]


def test_add_takes_every_file_of_an_entry_the_case_file_first(
    fake_cases_dir: Path, workspace: Path, catalog: Catalog
) -> None:
    result = add_example("three", workspace, catalog=catalog)
    assert [f.name for f in result.files] == ["three.raw", "three.dyr"]
    assert (workspace / "three.dyr").read_bytes() == _FILES["three/three.dyr"]


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX permission bits")
def test_added_files_are_private_to_the_user_as_an_upload_is(
    fake_cases_dir: Path, workspace: Path, catalog: Catalog
) -> None:
    add_example("one", workspace, catalog=catalog)
    assert stat.S_IMODE((workspace / "one.xlsx").stat().st_mode) == 0o600
    assert stat.S_IMODE((workspace / SOURCES_FILE).stat().st_mode) == 0o600
    assert not [p for p in workspace.iterdir() if p.name.startswith(".example.")]


def test_add_never_overwrites_unless_asked(
    fake_cases_dir: Path, workspace: Path, catalog: Catalog
) -> None:
    (workspace / "one.xlsx").write_bytes(b"the user's own file")
    with pytest.raises(ExampleExistsError, match=r"one\.xlsx"):
        add_example("one", workspace, catalog=catalog)
    assert (workspace / "one.xlsx").read_bytes() == b"the user's own file"

    result = add_example("one", workspace, overwrite=True, catalog=catalog)
    assert [f.replaced for f in result.files] == [True]
    assert (workspace / "one.xlsx").read_bytes() == _FILES["one/one.xlsx"]


def test_an_entry_is_never_half_added(
    fake_cases_dir: Path, workspace: Path, catalog: Catalog
) -> None:
    """One of its files is taken: the others are not written either."""
    (workspace / "three.dyr").write_bytes(b"mine")
    with pytest.raises(ExampleExistsError):
        add_example("three", workspace, catalog=catalog)
    assert not (workspace / "three.raw").exists()
    assert (workspace / "three.dyr").read_bytes() == b"mine"
    assert not (workspace / SOURCES_FILE).exists()


def test_a_name_taken_between_the_check_and_the_write_is_not_replaced_and_the_rest_is_undone(
    fake_cases_dir: Path, workspace: Path, catalog: Catalog, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two writers of one name cannot both win: the claim is a hard link, which refuses a name
    that exists. The file this call had already made is taken away again."""
    real = examples.write_private_temp

    def lose_the_race_for_the_second_file(parent: Path, data: bytes, *, prefix: str) -> Path:
        tmp = real(parent, data, prefix=prefix)
        if data == _FILES["three/three.dyr"]:
            (workspace / "three.dyr").write_bytes(b"the other writer won")
        return tmp

    monkeypatch.setattr(examples, "write_private_temp", lose_the_race_for_the_second_file)
    with pytest.raises(ExampleExistsError):
        add_example("three", workspace, catalog=catalog)
    assert (workspace / "three.dyr").read_bytes() == b"the other writer won"
    assert sorted(p.name for p in workspace.iterdir()) == ["three.dyr"]


def test_add_works_where_hard_links_are_refused(
    fake_cases_dir: Path, workspace: Path, catalog: Catalog, monkeypatch: pytest.MonkeyPatch
) -> None:
    """FAT volumes and some network mounts have no hard links: the file still lands."""

    def no_links(src: object, dst: object) -> None:
        raise OSError(errno.EPERM, "hard links are not supported here")

    monkeypatch.setattr(os, "link", no_links)
    add_example("one", workspace, catalog=catalog)
    assert (workspace / "one.xlsx").read_bytes() == _FILES["one/one.xlsx"]
    assert not [p for p in workspace.iterdir() if p.name.startswith(".example.")]


def test_a_directory_in_the_way_is_a_conflict_even_when_replacing(
    fake_cases_dir: Path, workspace: Path, catalog: Catalog
) -> None:
    (workspace / "one.xlsx").mkdir()
    with pytest.raises(ExampleExistsError, match="not a regular file"):
        add_example("one", workspace, overwrite=True, catalog=catalog)


@pytest.mark.skipif(sys.platform == "win32", reason="symlinks need privileges on Windows")
def test_a_symlink_in_the_way_is_refused_and_not_followed(
    fake_cases_dir: Path, workspace: Path, catalog: Catalog, tmp_path: Path
) -> None:
    outside = tmp_path / "outside.xlsx"
    outside.write_bytes(b"outside")
    (workspace / "one.xlsx").symlink_to(outside)
    with pytest.raises(WorkspacePathError, match="symlink"):
        add_example("one", workspace, overwrite=True, catalog=catalog)
    assert outside.read_bytes() == b"outside"


def test_an_unknown_id_and_a_link_only_entry_are_refused_with_a_reason(
    fake_cases_dir: Path, workspace: Path
) -> None:
    catalog = _catalog(_entry("one", "one/one.xlsx"), _EXTERNAL)
    with pytest.raises(UnknownExampleError, match="known: one, texas"):
        add_example("nope", workspace, catalog=catalog)
    with pytest.raises(ExampleHasNoFileError, match="links"):
        add_example("texas", workspace, catalog=catalog)
    assert list(workspace.iterdir()) == []


def test_an_unknown_id_is_not_echoed_whole(workspace: Path, catalog: Catalog) -> None:
    with pytest.raises(UnknownExampleError) as caught:
        add_example("x" * 5000, workspace, catalog=catalog)
    assert len(str(caught.value)) < 200


def test_a_file_the_source_does_not_have_is_a_missing_source(
    fake_cases_dir: Path, workspace: Path, catalog: Catalog
) -> None:
    (fake_cases_dir / "one" / "one.xlsx").unlink()
    with pytest.raises(ExampleSourceMissingError, match=r"one/one\.xlsx"):
        add_example("one", workspace, catalog=catalog)
    assert list(workspace.iterdir()) == []


def test_without_andes_an_andes_case_cannot_be_added(
    workspace: Path, catalog: Catalog, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(examples, "_andes_cases_dir", lambda: None)
    with pytest.raises(ExampleSourceMissingError, match="ANDES is not installed"):
        add_example("one", workspace, catalog=catalog)


def test_an_andes_file_that_is_not_the_recorded_one_is_added_with_a_warning(
    fake_cases_dir: Path,
    workspace: Path,
    catalog: Catalog,
    caplog: pytest.LogCaptureFixture,
) -> None:
    (fake_cases_dir / "one" / "one.xlsx").write_bytes(b"a newer release's file")
    with caplog.at_level("WARNING", logger="tensa.examples"):
        result = add_example("one", workspace, catalog=catalog)
    (warning,) = result.warnings
    assert "one/one.xlsx" in warning
    assert _sha(b"a newer release's file") in warning
    assert "ANDES 2.0.0" in warning
    assert (workspace / "one.xlsx").read_bytes() == b"a newer release's file"
    assert any("one/one.xlsx" in r.message for r in caplog.records)
    # The warning stays with the case, in the file that records where it came from.
    assert "Warning: one/one.xlsx" in (workspace / SOURCES_FILE).read_text(encoding="utf-8")


def _bundled_entry(content: bytes) -> dict[str, Any]:
    return _entry(
        "b",
        "one/one.xlsx",
        provenance={
            "kind": "bundled",
            "path": "b/b.m",
            "sha256": _sha(content),
            "source_url": "https://example.org/b.m",
            "retrieved": "2026-11-17",
        },
    )


def test_a_bundled_file_that_is_not_the_recorded_one_is_refused(
    workspace: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bundled = tmp_path / "bundled"
    (bundled / "b").mkdir(parents=True)
    (bundled / "b" / "b.m").write_bytes(b"tampered")
    monkeypatch.setattr(examples, "bundled_cases_dir", lambda: bundled)
    with pytest.raises(ExampleIntegrityError, match="reinstall"):
        add_example("b", workspace, catalog=_catalog(_bundled_entry(b"what was shipped")))
    assert list(workspace.iterdir()) == []


def test_a_bundled_file_is_copied_from_the_package_with_its_source_recorded(
    workspace: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bundled = tmp_path / "bundled"
    (bundled / "b").mkdir(parents=True)
    (bundled / "b" / "b.m").write_bytes(b"function mpc = b")
    monkeypatch.setattr(examples, "bundled_cases_dir", lambda: bundled)
    result = add_example("b", workspace, catalog=_catalog(_bundled_entry(b"function mpc = b")))
    assert [f.name for f in result.files] == ["b.m"]
    text = (workspace / SOURCES_FILE).read_text(encoding="utf-8")
    assert "bundled with TENSA as `b/b.m`" in text
    assert "source https://example.org/b.m, retrieved 2026-11-17" in text
    assert "ANDES installed" not in text


# ---- the file that records the sources ------------------------------------------------


def test_the_sources_file_records_source_licence_modifications_and_citations(
    fake_cases_dir: Path, workspace: Path, catalog: Catalog
) -> None:
    add_example("one", workspace, catalog=catalog)
    text = (workspace / SOURCES_FILE).read_text(encoding="utf-8")
    assert text.startswith("# Example case sources\n")
    assert "## Case one (`one`)" in text
    assert "- Files: `one.xlsx`" in text
    assert f"sha256 `{_sha(_FILES['one/one.xlsx'])}`" in text
    assert "https://example.org/andes/one/one.xlsx" in text
    assert "- Licence: GPL-3.0-or-later (https://example.org/licence). Cite the paper." in text
    assert "- Modifications: a change." in text
    assert "- Caveat: a caveat" in text
    assert "- Citation text of one." in text


def test_each_added_case_has_its_own_section_and_adding_again_replaces_it(
    fake_cases_dir: Path, workspace: Path, catalog: Catalog
) -> None:
    add_example("one", workspace, catalog=catalog)
    add_example("two", workspace, catalog=catalog)
    add_example("one", workspace, overwrite=True, catalog=catalog)
    text = (workspace / SOURCES_FILE).read_text(encoding="utf-8")
    assert text.count("<!-- tensa-example:one -->") == 1
    assert text.count("<!-- tensa-example:two -->") == 1
    assert text.index("(`one`)") < text.index("(`two`)")


def test_what_the_user_wrote_in_the_sources_file_is_kept(
    fake_cases_dir: Path, workspace: Path, catalog: Catalog
) -> None:
    (workspace / SOURCES_FILE).write_text("# My notes\n\nKeep this line.\n", encoding="utf-8")
    add_example("one", workspace, catalog=catalog)
    add_example("one", workspace, overwrite=True, catalog=catalog)
    text = (workspace / SOURCES_FILE).read_text(encoding="utf-8")
    assert text.startswith("# My notes\n\nKeep this line.\n")
    assert text.count("<!-- tensa-example:one -->") == 1


def test_the_sources_file_is_not_a_case_and_does_not_make_a_workspace_non_empty(
    fake_cases_dir: Path, workspace: Path, catalog: Catalog
) -> None:
    add_example("one", workspace, catalog=catalog)
    listed = [p.name for p in list_workspace_files(workspace, SUPPORTED_CASE_EXTENSIONS)]
    assert listed == ["one.xlsx"]
    (workspace / "one.xlsx").unlink()
    assert list_workspace_files(workspace, SUPPORTED_CASE_EXTENSIONS) == []


def test_a_sources_file_that_cannot_be_written_is_a_warning_and_the_case_is_still_added(
    fake_cases_dir: Path, workspace: Path, catalog: Catalog
) -> None:
    (workspace / SOURCES_FILE).mkdir()
    result = add_example("one", workspace, catalog=catalog)
    assert (workspace / "one.xlsx").is_file()
    (warning,) = result.warnings
    assert warning.startswith(f"could not update {SOURCES_FILE}")


def test_a_sources_file_too_big_to_be_ours_is_left_alone_with_a_warning(
    fake_cases_dir: Path, workspace: Path, catalog: Catalog
) -> None:
    big = b"x" * (examples._SOURCES_MAX_BYTES + 1)  # noqa: SLF001
    (workspace / SOURCES_FILE).write_bytes(big)
    result = add_example("one", workspace, catalog=catalog)
    assert (workspace / "one.xlsx").is_file()
    assert (workspace / SOURCES_FILE).read_bytes() == big
    assert "is over" in result.warnings[0]


# ---- what is true of this workspace and this machine -----------------------------------


def test_the_statuses_say_what_is_in_the_workspace_and_what_can_be_found(
    fake_cases_dir: Path, workspace: Path, catalog: Catalog
) -> None:
    add_example("one", workspace, catalog=catalog)
    (fake_cases_dir / "two" / "two.xlsx").unlink()
    flags = {s.example.id: (s.in_workspace, s.available) for s in example_statuses(workspace, catalog)}
    assert flags == {"one": (True, True), "two": (False, False), "three": (False, True)}


def test_a_link_only_entry_is_neither_in_the_workspace_nor_available(workspace: Path) -> None:
    (status,) = example_statuses(workspace, _catalog(_EXTERNAL))
    assert (status.in_workspace, status.available) == (False, False)


def test_a_workspace_that_does_not_exist_has_none_of_the_cases(
    fake_cases_dir: Path, tmp_path: Path, catalog: Catalog
) -> None:
    statuses = example_statuses(tmp_path / "missing", catalog)
    assert [s.in_workspace for s in statuses] == [False, False, False]


@pytest.mark.skipif(sys.platform == "win32", reason="symlinks need privileges on Windows")
def test_a_symlink_is_not_a_case_in_the_workspace(
    fake_cases_dir: Path, workspace: Path, catalog: Catalog, tmp_path: Path
) -> None:
    target = tmp_path / "elsewhere.xlsx"
    target.write_bytes(b"x")
    (workspace / "one.xlsx").symlink_to(target)
    flags = {s.example.id: s.in_workspace for s in example_statuses(workspace, catalog)}
    assert flags["one"] is False


# ---- citations --------------------------------------------------------------------------


def test_citations_come_as_text_or_as_bibtex(catalog: Catalog) -> None:
    one = catalog.get("one")
    assert one is not None
    assert format_citations(one) == "Citation text of one."
    assert format_citations(one, bibtex=True) == "@misc{one}"
    cited_twice = _catalog(
        _entry(
            "one",
            "one/one.xlsx",
            citations=[
                {"text": "First.", "bibtex": "@misc{a}"},
                {"text": "Second.", "bibtex": "@misc{b}"},
            ],
        )
    ).examples[0]
    assert format_citations(cited_twice) == "First.\n\nSecond."
    assert format_citations(_catalog(_entry("x", "one/one.xlsx", citations=[])).examples[0]) == ""


# ---- locating ANDES ---------------------------------------------------------------------


def test_the_andes_cases_folder_is_found_without_importing_andes() -> None:
    """Importing ANDES takes seconds and is the workers' business, not the server process's."""
    code = (
        "import sys\n"
        "from tensa.core.examples import _andes_cases_dir\n"
        "cases = _andes_cases_dir()\n"
        "assert cases is not None and (cases / 'ieee14' / 'ieee14_full.xlsx').is_file(), cases\n"
        "assert 'andes' not in sys.modules\n"
    )
    done = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, check=False, timeout=120
    )
    assert done.returncode == 0, done.stderr


# ---- the catalog that ships -------------------------------------------------------------


def test_the_shipped_defaults_seed_an_empty_workspace_from_the_installed_andes(
    workspace: Path,
) -> None:
    if examples._andes_cases_dir() is None:  # noqa: SLF001
        pytest.skip("ANDES is not installed")
    assert seed_example_cases(workspace) == [
        "ieee14_full.xlsx",
        "kundur_full.xlsx",
        "wscc9.xlsx",
    ]
    listed = [p.name for p in list_workspace_files(workspace, SUPPORTED_CASE_EXTENSIONS)]
    assert listed == ["ieee14_full.xlsx", "kundur_full.xlsx", "wscc9.xlsx"]
    assert "(`ieee14`)" in (workspace / SOURCES_FILE).read_text(encoding="utf-8")


def test_every_shipped_example_has_a_source_file_in_the_installed_andes(tmp_path: Path) -> None:
    if examples._andes_cases_dir() is None:  # noqa: SLF001
        pytest.skip("ANDES is not installed")
    for status in example_statuses(tmp_path, load_catalog()):
        if status.example.has_file:
            assert status.available, status.example.id
