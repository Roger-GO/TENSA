"""Unit tests for ``tensa.core.snapshot`` (Unit 7 of the v2.0 plan).

These tests exercise the pure helpers in the snapshot module — name
validation, version-stamp comparison, on-disk layout, listing-on-disk,
and the dataclass round-trips. No ANDES required: the orchestrator
deliberately keeps ANDES at arm's length so the version-stamp policy
can be unit-tested without spinning up a System.

Integration coverage (the wrapper-level save/restore against a real
ANDES System) lives in ``tests/integration/test_snapshot_api.py``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tensa.core.snapshot import (
    SnapshotCollisionError,
    SnapshotEntry,
    SnapshotMetadata,
    SnapshotMetadataError,
    SnapshotNotFoundError,
    delete_snapshot_files,
    list_snapshots_on_disk,
    read_snapshot_metadata,
    snapshot_dir,
    snapshot_paths,
    validate_snapshot_name,
    versions_compatible,
    write_snapshot_files,
)

# ---- name validation -------------------------------------------------------


@pytest.mark.unit
@pytest.mark.parametrize(
    "name",
    [
        "scenario-A",
        "scenario_a",
        "snap1",
        "S",
        "a.b.c",
        "ABC123",
        "x" * 64,
    ],
)
def test_validate_snapshot_name_accepts_safe_names(name: str) -> None:
    assert validate_snapshot_name(name) == name


@pytest.mark.unit
@pytest.mark.parametrize(
    "name",
    [
        "",
        ".hidden",
        "../traversal",
        "a/b",
        "a\\b",
        "x" * 65,
        "name with space",
        "name\nwith\nnewline",
        "name\x00null",
        "-leadingdash",  # we require leading alphanumeric
        "_leadingunderscore",
    ],
)
def test_validate_snapshot_name_rejects_unsafe_names(name: str) -> None:
    with pytest.raises(SnapshotMetadataError):
        validate_snapshot_name(name)


# ---- version compatibility -------------------------------------------------


@pytest.mark.unit
@pytest.mark.parametrize(
    "saved,current,expected",
    [
        ("2.0.0", "2.0.0", True),
        ("2.0.1", "2.0.5", True),  # patch-level still compatible
        ("2.0.0", "2.1.0", False),  # minor bump → incompatible
        ("2.0.0", "3.0.0", False),  # major bump → incompatible
        ("2.0", "2.0", True),
        ("2.0.0", "2.0", True),  # mixed precision; still major.minor match
        ("custom", "custom", True),  # unparseable falls back to ==
        ("custom", "other", False),
    ],
)
def test_versions_compatible(saved: str, current: str, expected: bool) -> None:
    assert versions_compatible(saved, current) is expected


# ---- metadata round-trip ---------------------------------------------------


@pytest.mark.unit
def test_snapshot_metadata_round_trips_through_json() -> None:
    """A SnapshotMetadata → dict → JSON → dict → SnapshotMetadata round-trip
    must preserve every field. The integration tests rely on this when
    re-reading a sidecar across a session restart."""
    meta = SnapshotMetadata(
        andes_version="2.0.0",
        tensa_version="0.1.0.dev0",
        case_filename="ieee14.raw",
        case_sha256="0" * 64,
        disturbance_log=[
            {"kind": "fault", "bus_idx": 5, "tf": 1.0, "tc": 1.1, "xf": 0.0001, "rf": 0.0},
        ],
        saved_at="2026-05-09T12:34:56+00:00",
        has_pflow=True,
        has_tds=False,
    )
    payload = meta.to_dict()
    blob = json.dumps(payload)
    restored = SnapshotMetadata.from_dict(json.loads(blob))
    assert restored == meta


@pytest.mark.unit
def test_snapshot_metadata_from_dict_rejects_missing_versions() -> None:
    """Missing required strings → SnapshotMetadataError."""
    with pytest.raises(SnapshotMetadataError):
        SnapshotMetadata.from_dict({})
    with pytest.raises(SnapshotMetadataError):
        SnapshotMetadata.from_dict({"andes_version": "2.0.0"})


@pytest.mark.unit
def test_snapshot_metadata_from_dict_tolerates_missing_optionals() -> None:
    """Optional fields default to None / empty / False."""
    meta = SnapshotMetadata.from_dict(
        {"andes_version": "2.0.0", "tensa_version": "0.1.0"}
    )
    assert meta.case_filename is None
    assert meta.case_sha256 is None
    assert meta.disturbance_log == []
    assert meta.saved_at == ""
    assert meta.has_pflow is False
    assert meta.has_tds is False


@pytest.mark.unit
def test_snapshot_metadata_rejects_non_list_disturbance_log() -> None:
    with pytest.raises(SnapshotMetadataError):
        SnapshotMetadata.from_dict(
            {
                "andes_version": "2.0.0",
                "tensa_version": "0.1.0",
                "disturbance_log": "not-a-list",
            }
        )


# ---- on-disk layout helpers ------------------------------------------------


@pytest.mark.unit
def test_snapshot_dir_creates_per_case_directory(tmp_path: Path) -> None:
    """``snapshot_dir`` materialises ``<workspace>/snapshots/<case>/``."""
    target = snapshot_dir(tmp_path, "ieee14.raw")
    assert target.exists()
    assert target.is_dir()
    assert target == tmp_path / "snapshots" / "ieee14"


@pytest.mark.unit
def test_snapshot_dir_handles_blank_session(tmp_path: Path) -> None:
    """Blank-session snapshots bucket under ``__blank__`` so they don't
    collide with case-loaded sessions."""
    target = snapshot_dir(tmp_path, None)
    assert target == tmp_path / "snapshots" / "__blank__"


@pytest.mark.unit
def test_snapshot_paths_matches_snapshot_dir_layout(tmp_path: Path) -> None:
    dill, json_path = snapshot_paths(tmp_path, "ieee14.raw", "scenario-A")
    assert dill == tmp_path / "snapshots" / "ieee14" / "scenario-A.dill"
    assert json_path == tmp_path / "snapshots" / "ieee14" / "scenario-A.json"


# ---- write / read sidecar --------------------------------------------------


def _write_dummy_dill(path: str) -> None:
    """Stand-in for ``andes.utils.snapshot.save_ss`` — writes a 4-byte
    PK header so the byte-count check is non-trivial."""
    Path(path).write_bytes(b"PK\x03\x04")


@pytest.mark.unit
def test_write_snapshot_files_writes_both(tmp_path: Path) -> None:
    """Happy path: dill + JSON land at the right paths with non-zero sizes."""
    target = snapshot_dir(tmp_path, "ieee14.raw")
    dill_path = target / "scenario-A.dill"
    json_path = target / "scenario-A.json"
    meta = SnapshotMetadata(
        andes_version="2.0.0",
        tensa_version="0.1.0.dev0",
        case_filename="ieee14.raw",
        case_sha256=None,
        disturbance_log=[],
        saved_at="2026-05-09T00:00:00+00:00",
        has_pflow=False,
        has_tds=False,
    )
    dill_bytes, json_bytes = write_snapshot_files(
        dill_path=dill_path,
        json_path=json_path,
        dill_writer=_write_dummy_dill,
        metadata=meta,
    )
    assert dill_bytes == 4
    assert json_bytes > 0
    assert dill_path.exists()
    assert json_path.exists()
    # Sidecar JSON survives a re-read.
    re_read = read_snapshot_metadata(json_path)
    assert re_read == meta


@pytest.mark.unit
def test_read_snapshot_metadata_missing_file_raises_not_found(tmp_path: Path) -> None:
    with pytest.raises(SnapshotNotFoundError):
        read_snapshot_metadata(tmp_path / "missing.json")


@pytest.mark.unit
def test_read_snapshot_metadata_malformed_json_raises_metadata_error(
    tmp_path: Path,
) -> None:
    bad = tmp_path / "bad.json"
    bad.write_text("{not valid json")
    with pytest.raises(SnapshotMetadataError):
        read_snapshot_metadata(bad)


@pytest.mark.unit
def test_read_snapshot_metadata_non_object_raises_metadata_error(
    tmp_path: Path,
) -> None:
    bad = tmp_path / "bad.json"
    bad.write_text('"a string, not a dict"')
    with pytest.raises(SnapshotMetadataError):
        read_snapshot_metadata(bad)


# ---- listing ---------------------------------------------------------------


@pytest.mark.unit
def test_list_snapshots_on_disk_empty_when_dir_missing(tmp_path: Path) -> None:
    """No directory → empty list, not an error."""
    assert list_snapshots_on_disk(tmp_path, "ieee14.raw") == []


@pytest.mark.unit
def test_list_snapshots_on_disk_returns_one_per_json(tmp_path: Path) -> None:
    """Every parseable JSON sidecar surfaces; dill presence sets ``has_dill``."""
    target = snapshot_dir(tmp_path, "ieee14.raw")
    meta = SnapshotMetadata(
        andes_version="2.0.0",
        tensa_version="0.1.0",
        case_filename="ieee14.raw",
        case_sha256=None,
        disturbance_log=[{"kind": "fault", "bus_idx": 5, "tf": 1.0, "tc": 1.1}],
        saved_at="2026-05-09T00:00:00+00:00",
        has_pflow=True,
        has_tds=False,
    )
    write_snapshot_files(
        dill_path=target / "snap-a.dill",
        json_path=target / "snap-a.json",
        dill_writer=_write_dummy_dill,
        metadata=meta,
    )
    # Snapshot with dill missing — listing should still surface it.
    write_snapshot_files(
        dill_path=target / "snap-b.dill",
        json_path=target / "snap-b.json",
        dill_writer=_write_dummy_dill,
        metadata=meta,
    )
    (target / "snap-b.dill").unlink()

    entries = list_snapshots_on_disk(tmp_path, "ieee14.raw")
    assert len(entries) == 2
    names = {e.name for e in entries}
    assert names == {"snap-a", "snap-b"}
    by_name = {e.name: e for e in entries}
    assert by_name["snap-a"].has_dill is True
    assert by_name["snap-b"].has_dill is False
    assert by_name["snap-a"].disturbance_count == 1
    assert by_name["snap-a"].has_pflow is True
    assert by_name["snap-a"].andes_version == "2.0.0"


@pytest.mark.unit
def test_list_snapshots_on_disk_skips_corrupted_json(tmp_path: Path) -> None:
    """A corrupt sidecar is logged + skipped; intact siblings still surface."""
    target = snapshot_dir(tmp_path, "ieee14.raw")
    (target / "broken.json").write_text("{not valid")
    meta = SnapshotMetadata(
        andes_version="2.0.0",
        tensa_version="0.1.0",
        case_filename=None,
        case_sha256=None,
        disturbance_log=[],
        saved_at="",
        has_pflow=False,
        has_tds=False,
    )
    write_snapshot_files(
        dill_path=target / "ok.dill",
        json_path=target / "ok.json",
        dill_writer=_write_dummy_dill,
        metadata=meta,
    )
    entries = list_snapshots_on_disk(tmp_path, "ieee14.raw")
    assert len(entries) == 1
    assert entries[0].name == "ok"


# ---- delete ----------------------------------------------------------------


@pytest.mark.unit
def test_delete_snapshot_files_removes_both(tmp_path: Path) -> None:
    target = snapshot_dir(tmp_path, "ieee14.raw")
    meta = SnapshotMetadata(
        andes_version="2.0.0",
        tensa_version="0.1.0",
        case_filename=None,
        case_sha256=None,
        disturbance_log=[],
        saved_at="",
        has_pflow=False,
        has_tds=False,
    )
    write_snapshot_files(
        dill_path=target / "doomed.dill",
        json_path=target / "doomed.json",
        dill_writer=_write_dummy_dill,
        metadata=meta,
    )
    assert delete_snapshot_files(tmp_path, "ieee14.raw", "doomed") is True
    assert not (target / "doomed.dill").exists()
    assert not (target / "doomed.json").exists()


@pytest.mark.unit
def test_delete_snapshot_files_missing_raises_not_found(tmp_path: Path) -> None:
    with pytest.raises(SnapshotNotFoundError):
        delete_snapshot_files(tmp_path, "ieee14.raw", "ghost")


@pytest.mark.unit
def test_delete_snapshot_files_validates_name(tmp_path: Path) -> None:
    """Name validation runs first — ``../foo`` never reaches the filesystem."""
    with pytest.raises(SnapshotMetadataError):
        delete_snapshot_files(tmp_path, "ieee14.raw", "../foo")


# ---- error type identity ---------------------------------------------------


@pytest.mark.unit
def test_snapshot_error_subclasses_inherit_from_tensa_error() -> None:
    """Worker forwards exception class names as ``category``; the routes
    layer relies on the subclass identity to map to the right HTTP status.
    """
    from tensa.core.errors import AndesAppError

    assert issubclass(SnapshotNotFoundError, AndesAppError)
    assert issubclass(SnapshotCollisionError, AndesAppError)
    assert issubclass(SnapshotMetadataError, AndesAppError)


# ---- entry dataclass -------------------------------------------------------


@pytest.mark.unit
def test_snapshot_entry_carries_listing_fields() -> None:
    e = SnapshotEntry(
        name="x",
        saved_at="2026-05-09T00:00:00+00:00",
        has_pflow=True,
        has_tds=False,
        has_dill=True,
        andes_version="2.0.0",
        disturbance_count=2,
    )
    assert e.name == "x"
    assert e.has_dill is True
    assert e.disturbance_count == 2
