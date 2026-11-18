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
import shutil
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from tensa.core import examples
from tensa.core.example_catalog import Catalog, load_catalog, parse_catalog, quoted_notice
from tensa.core.examples import (
    SOURCES_FILE,
    SUPPORTED_CASE_EXTENSIONS,
    AddResult,
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


def _add_at_once(
    ids: list[str], workspace: Path, catalog: Catalog
) -> tuple[dict[str, AddResult], list[BaseException]]:
    """Add every id from its own thread, all released together; the results and any failures."""
    start = threading.Barrier(len(ids))
    results: dict[str, AddResult] = {}
    failures: list[BaseException] = []

    def add(example_id: str) -> None:
        try:
            start.wait(timeout=10)
            results[example_id] = add_example(example_id, workspace, catalog=catalog)
        except BaseException as exc:  # noqa: BLE001 - reported by the caller's assertion
            failures.append(exc)

    threads = [threading.Thread(target=add, args=(example_id,)) for example_id in ids]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    return results, failures


def test_cases_added_at_the_same_moment_each_keep_their_section(
    fake_cases_dir: Path,
    tmp_path: Path,
    catalog: Catalog,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The server runs each add in a worker thread, so adds overlap. The sources file is read,
    changed and written back, and every add must find the sections the others wrote."""
    real_lstat = examples._lstat  # noqa: SLF001

    def slow_on_the_sources_file(path: Path) -> os.stat_result | None:
        # Stretches the gap between reading the sources file and writing it, so an add
        # that does not take turns is overtaken by the others every time.
        info = real_lstat(path)
        if path.name == SOURCES_FILE:
            time.sleep(0.03)
        return info

    monkeypatch.setattr(examples, "_lstat", slow_on_the_sources_file)
    ids = ["one", "two", "three"]
    for round_number in range(3):
        ws = tmp_path / f"ws{round_number}"
        ws.mkdir(mode=0o700)
        results, failures = _add_at_once(ids, ws, catalog)
        assert failures == []
        assert {i: r.warnings for i, r in results.items()} == dict.fromkeys(ids, ())
        text = (ws / SOURCES_FILE).read_text(encoding="utf-8")
        for example_id in ids:
            assert text.count(f"<!-- tensa-example:{example_id} -->") == 1
            assert text.count(f"<!-- /tensa-example:{example_id} -->") == 1
        assert text.count("# Example case sources") == 1


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


def _bundled_tree(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, content: bytes) -> Catalog:
    """A bundled case whose shipped file is ``content``, and the catalog that names it."""
    bundled = tmp_path / "bundled"
    (bundled / "b").mkdir(parents=True)
    (bundled / "b" / "b.m").write_bytes(content)
    monkeypatch.setattr(examples, "bundled_cases_dir", lambda: bundled)
    return _catalog(_bundled_entry(content))


def _differs(workspace: Path, catalog: Catalog) -> tuple[bool, bool]:
    (status,) = example_statuses(workspace, catalog)
    return status.in_workspace, status.differs


def test_a_bundled_file_in_the_workspace_is_the_shipped_one_unless_its_bytes_say_otherwise(
    workspace: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    shipped = b"function mpc = b"
    catalog = _bundled_tree(tmp_path, monkeypatch, shipped)
    assert _differs(workspace, catalog) == (False, False)

    add_example("b", workspace, catalog=catalog)
    assert _differs(workspace, catalog) == (True, False)

    # What an earlier release put under the name, or an edit: of another size, then of the same.
    (workspace / "b.m").write_bytes(b"function mpc = an older b")
    assert _differs(workspace, catalog) == (True, True)
    (workspace / "b.m").write_bytes(b"function mpc = c")
    assert len(b"function mpc = c") == len(shipped)
    assert _differs(workspace, catalog) == (True, True)

    # Adding it over the file puts the shipped one there, and the flag goes.
    add_example("b", workspace, overwrite=True, catalog=catalog)
    assert _differs(workspace, catalog) == (True, False)


def test_a_file_of_another_size_than_the_shipped_one_is_not_opened(
    workspace: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    catalog = _bundled_tree(tmp_path, monkeypatch, b"small")
    (workspace / "b.m").write_bytes(b"x" * 1_000_000)
    reads: list[int] = []
    real_open = open

    def counting_open(*args: Any, **kwargs: Any) -> Any:
        handle = real_open(*args, **kwargs)
        reads.append(1)
        return handle

    monkeypatch.setattr("builtins.open", counting_open)
    assert _differs(workspace, catalog) == (True, True)
    # The sizes differ, so the file was not even opened.
    assert reads == []


def test_only_a_bundled_case_can_differ(
    fake_cases_dir: Path, workspace: Path, catalog: Catalog
) -> None:
    """A copy from the user's own ANDES is whatever that installation has, and Add already says
    when it is not the recorded file; a link has no file."""
    (workspace / "one.xlsx").write_bytes(b"the user's own edit")
    assert {s.example.id: s.differs for s in example_statuses(workspace, catalog)} == {
        "one": False,
        "two": False,
        "three": False,
    }
    (status,) = example_statuses(workspace, _catalog(_EXTERNAL))
    assert status.differs is False


def test_a_bundled_file_that_is_not_in_the_workspace_does_not_differ(
    workspace: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    catalog = _bundled_tree(tmp_path, monkeypatch, b"function mpc = b")
    (workspace / "unrelated.m").write_bytes(b"other")
    assert _differs(workspace, catalog) == (False, False)


@pytest.mark.skipif(sys.platform == "win32", reason="symlinks need privileges on Windows")
def test_a_symlink_in_the_workspace_is_not_compared(
    workspace: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    catalog = _bundled_tree(tmp_path, monkeypatch, b"function mpc = b")
    target = tmp_path / "elsewhere.m"
    target.write_bytes(b"other")
    (workspace / "b.m").symlink_to(target)
    assert _differs(workspace, catalog) == (False, False)


def test_the_bundled_wscc9_that_ships_is_not_the_file_an_earlier_release_seeded(
    workspace: Path,
) -> None:
    """0.5.0 seeded ANDES's ``wscc9.xlsx`` (a network with no machines, other reactances on three
    lines) under the name this release gives its own file."""
    andes_cases = examples._andes_cases_dir()  # noqa: SLF001
    if andes_cases is None or not (andes_cases / "wscc9" / "wscc9.xlsx").is_file():
        pytest.skip("ANDES is not installed")
    shutil.copy(andes_cases / "wscc9" / "wscc9.xlsx", workspace / "wscc9.xlsx")
    flags = {s.example.id: s.differs for s in example_statuses(workspace, load_catalog())}
    assert flags["wscc9"] is True
    add_example("wscc9", workspace, overwrite=True)
    flags = {s.example.id: s.differs for s in example_statuses(workspace, load_catalog())}
    assert flags["wscc9"] is False


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
        "ieee39_full.xlsx",
        "npcc.xlsx",
    ]
    listed = [p.name for p in list_workspace_files(workspace, SUPPORTED_CASE_EXTENSIONS)]
    assert listed == [
        "ieee14_full.xlsx",
        "ieee39_full.xlsx",
        "kundur_full.xlsx",
        "npcc.xlsx",
        "wscc9.xlsx",
    ]
    assert "(`ieee14`)" in (workspace / SOURCES_FILE).read_text(encoding="utf-8")


def test_every_shipped_example_has_a_source_file_in_the_installed_andes(tmp_path: Path) -> None:
    if examples._andes_cases_dir() is None:  # noqa: SLF001
        pytest.skip("ANDES is not installed")
    for status in example_statuses(tmp_path, load_catalog()):
        if status.example.has_file:
            assert status.available, status.example.id


@pytest.mark.parametrize("example_id", ["ieee30", "ieee57"])
def test_a_bundled_pglib_case_is_added_byte_for_byte_with_its_credit_beside_it(
    workspace: Path, example_id: str
) -> None:
    """The two PGLib-OPF files need no ANDES: they are copied from the package as they were
    taken, and the sources file names the creator, the licence with its link, where the file is
    from and that nothing was changed, which is what CC BY 4.0 asks of whoever passes it on."""
    example = load_catalog().get(example_id)
    assert example is not None and example.provenance.path is not None
    result = add_example(example_id, workspace)
    assert result.warnings == ()
    (written,) = result.files
    source = examples.bundled_cases_dir() / example.provenance.path
    assert (workspace / written.name).read_bytes() == source.read_bytes()
    text = (workspace / SOURCES_FILE).read_text(encoding="utf-8")
    assert f"## {example.title} (`{example_id}`)" in text
    assert f"bundled with TENSA as `{example.provenance.path}`" in text
    assert "https://github.com/power-grid-lib/pglib-opf/blob/dc6be4b2f85ca0e776952ec22cbd4c22396ea5a3/" in text
    assert f"sha256 `{example.provenance.sha256}`" in text
    assert "CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)" in text
    assert "Richard D. Christie, University of Washington Electrical Engineering" in text
    assert "- Modifications: TENSA changed nothing" in text
    assert "arXiv:1908.02788" in text and "labs.ece.uw.edu/pstca/pf" in text
    assert "ANDES installed" not in text
    # It is a case the workspace lists, and the status says it is there and is the shipped one.
    assert written.name in [p.name for p in list_workspace_files(workspace, SUPPORTED_CASE_EXTENSIONS)]
    (status,) = [s for s in example_statuses(workspace, load_catalog()) if s.example.id == example_id]
    assert status.in_workspace and not status.differs


def test_the_rts_24_case_is_added_byte_for_byte_with_the_ieees_credit_beside_it(
    workspace: Path,
) -> None:
    """Another creator than the 30 and 57-bus files: the sources file names the IEEE, the system's
    paper and the library, with the licence link and that nothing was changed."""
    result = add_example("rts24", workspace)
    assert result.warnings == ()
    (written,) = result.files
    source = examples.bundled_cases_dir() / "pglib_opf_case24_ieee_rts.m"
    assert written.name == "pglib_opf_case24_ieee_rts.m"
    assert (workspace / written.name).read_bytes() == source.read_bytes()
    text = (workspace / SOURCES_FILE).read_text(encoding="utf-8")
    assert "bundled with TENSA as `pglib_opf_case24_ieee_rts.m`" in text
    assert "CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)" in text
    assert "The Institute of Electrical and Electronics Engineers (IEEE)" in text
    assert "doi:10.1109/TPAS.1979.319398" in text and "arXiv:1908.02788" in text
    assert "- Modifications: TENSA changed nothing" in text
    # No notice goes with these data, so the sources file has no such block.
    assert "in every copy of the data" not in text


def test_the_activsg_200_case_is_added_byte_for_byte_with_its_authors_credited(
    workspace: Path,
) -> None:
    result = add_example("activsg200", workspace)
    assert result.warnings == ()
    (written,) = result.files
    source = examples.bundled_cases_dir() / "case_ACTIVSg200.m"
    assert (workspace / written.name).read_bytes() == source.read_bytes()
    text = (workspace / SOURCES_FILE).read_text(encoding="utf-8")
    assert "A. B. Birchfield, T. Xu, K. M. Gegner, K. S. Shetye and T. J. Overbye" in text
    assert "/MATPOWER/matpower/blob/1a828c7af590714499284e36ee9c81273388c594/data/" in text
    assert "doi:10.1109/TPWRS.2016.2616385" in text and "in every copy of the data" not in text


def test_the_activsg_2000_case_is_added_byte_for_byte_with_its_authors_credited(
    workspace: Path,
) -> None:
    result = add_example("activsg2000", workspace)
    assert result.warnings == ()
    (written,) = result.files
    assert written.name == "case_ACTIVSg2000.m"
    source = examples.bundled_cases_dir() / "case_ACTIVSg2000.m"
    assert (workspace / written.name).read_bytes() == source.read_bytes()
    text = (workspace / SOURCES_FILE).read_text(encoding="utf-8")
    assert "A. B. Birchfield, T. Xu, K. M. Gegner, K. S. Shetye and T. J. Overbye" in text
    assert "MATPOWER Copyright (c) 2017-2018" in text
    assert "/MATPOWER/matpower/blob/1a828c7af590714499284e36ee9c81273388c594/data/case_ACTIVSg2000.m" in text
    assert "electricgrids.engr.tamu.edu/electric-grid-test-cases/activsg2000/" in text
    assert "- Modifications: TENSA changed nothing" in text and "in every copy of the data" not in text


@pytest.mark.parametrize(
    ("example_id", "name"),
    [("pegase89", "case89pegase.m"), ("pegase1354", "case1354pegase.m")],
)
def test_a_pegase_case_is_added_byte_for_byte_with_the_credit_of_rte_s_authors_in_utf_8(
    workspace: Path, example_id: str, name: str
) -> None:
    """The files carry accented names (C\u00e9dric Josz, St\u00e9phane Fliscounakis) in UTF-8: the copy
    is the bundled bytes, and the sources file written beside it keeps the names as they are."""
    source = examples.bundled_cases_dir() / name
    data = source.read_bytes()
    assert "C\u00e9dric Josz".encode() in data and b"\r" not in data
    result = add_example(example_id, workspace)
    assert result.warnings == ()
    (written,) = result.files
    assert written.name == name
    assert (workspace / name).read_bytes() == data
    text = (workspace / SOURCES_FILE).read_text(encoding="utf-8")
    assert "C\u00e9dric Josz, St\u00e9phane Fliscounakis, Jean Maeght and Patrick Panciatici" in text
    assert "R\u00e9seau de Transport d'Electricit\u00e9 (RTE)" in text
    assert "arXiv:1603.01533" in text and "doi:10.1109/TPWRS.2013.2251015" in text
    assert f"/MATPOWER/matpower/blob/1a828c7af590714499284e36ee9c81273388c594/data/{name}" in text
    assert "CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)" in text
    assert "- Modifications: TENSA changed nothing" in text and "in every copy of the data" not in text
    assert name in [p.name for p in list_workspace_files(workspace, SUPPORTED_CASE_EXTENSIONS)]


def test_the_rts_gmlc_case_is_added_with_the_whole_nrel_notice_beside_it(workspace: Path) -> None:
    """The agreement lets the data be copied provided its entire notice appears in all copies, so
    the sources file the case is added with holds the notice, every word, as a quotation, and
    adding the case again leaves one copy of it."""
    example = load_catalog().get("rts_gmlc")
    assert example is not None and example.licence.notice is not None
    result = add_example("rts_gmlc", workspace)
    assert result.warnings == ()
    (written,) = result.files
    assert written.name == "RTS-GMLC.RAW"
    source = examples.bundled_cases_dir() / "RTS-GMLC.RAW"
    assert (workspace / written.name).read_bytes() == source.read_bytes()
    # It is a case the workspace lists, whatever the case of its extension.
    assert "RTS-GMLC.RAW" in [p.name for p in list_workspace_files(workspace, SUPPORTED_CASE_EXTENSIONS)]
    text = (workspace / SOURCES_FILE).read_text(encoding="utf-8")
    quoted = "\n".join(quoted_notice(example.licence.notice))
    assert quoted in text
    assert "The licence asks that this notice appear, in full, in every copy of the data:" in text
    assert "NREL Data Use Disclaimer Agreement" in text and "DOE/NREL/ALLIANCE" in text
    # The block sits inside the case's own section, before its citations.
    start = text.index("<!-- tensa-example:rts_gmlc -->")
    assert start < text.index(quoted) < text.index("Cite:") < text.index("<!-- /tensa-example:rts_gmlc -->")
    again = add_example("rts_gmlc", workspace, overwrite=True)
    assert again.files[0].replaced
    assert (workspace / SOURCES_FILE).read_text(encoding="utf-8").count(quoted) == 1
    # The notice is the sources file's, not a case's: the other cases' sections have none.
    add_example("rts24", workspace)
    assert (workspace / SOURCES_FILE).read_text(encoding="utf-8").count(quoted) == 1
