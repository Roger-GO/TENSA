"""Unit tests for the engine stamp on snapshots (multi-engine unit 3.7).

Covers the core module (``tensa.core.snapshot``) and the wrapper mixin
(``tensa.core.wrapper.snapshot``): the stamp written at save, the read-back
default for a pre-unit sidecar, and the refusal of a foreign-engine restore.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import Mock

import pytest

from tensa.core.snapshot import (
    SnapshotEngineMismatchError,
    SnapshotMetadata,
    list_snapshots_on_disk,
    write_snapshot_files,
)
from tensa.core.wrapper.snapshot import SnapshotMixin


def _metadata_dict(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "andes_version": "2.0.0",
        "tensa_version": "0.4.0",
        "case_filename": "ieee14.raw",
        "case_sha256": "ab" * 32,
        "disturbance_log": [],
        "saved_at": "2026-11-20T00:00:00+00:00",
        "has_pflow": True,
        "has_tds": False,
    }
    base.update(overrides)
    return base


def test_metadata_roundtrip_writes_engine() -> None:
    meta = SnapshotMetadata(
        andes_version="2.0.0",
        tensa_version="0.4.0",
        engine="andes",
        case_filename="ieee14.raw",
        case_sha256="ab" * 32,
        disturbance_log=[],
        saved_at="2026-11-20T00:00:00+00:00",
        has_pflow=True,
        has_tds=False,
    )
    assert meta.to_dict()["engine"] == "andes"
    assert meta.summary()["engine"] == "andes"


def test_from_dict_defaults_missing_engine_to_andes() -> None:
    meta = SnapshotMetadata.from_dict(_metadata_dict())
    assert meta.engine == "andes"


def test_from_dict_non_string_engine_reads_as_andes() -> None:
    meta_null = SnapshotMetadata.from_dict(_metadata_dict(engine=None))
    assert meta_null.engine == "andes"
    meta_int = SnapshotMetadata.from_dict(_metadata_dict(engine=3))
    assert meta_int.engine == "andes"


def test_from_dict_preserves_foreign_engine() -> None:
    meta = SnapshotMetadata.from_dict(_metadata_dict(engine="sienna"))
    assert meta.engine == "sienna"


def test_list_snapshots_on_disk_carries_engine(tmp_path: Path) -> None:
    snap_dir = tmp_path / "snapshots" / "ieee14"
    snap_dir.mkdir(parents=True)
    foreign = SnapshotMetadata.from_dict(_metadata_dict(engine="sienna"))
    write_snapshot_files(
        dill_path=snap_dir / "s1.dill",
        json_path=snap_dir / "s1.json",
        dill_writer=None,
        metadata=foreign,
    )
    pre_unit = SnapshotMetadata.from_dict(_metadata_dict())
    # A pre-unit sidecar has no engine key at all; write it by hand.
    payload = pre_unit.to_dict()
    del payload["engine"]
    (snap_dir / "s2.json").write_text(json.dumps(payload), encoding="utf-8")

    entries = {e.name: e for e in list_snapshots_on_disk(tmp_path, "ieee14.raw")}
    assert entries["s1"].engine == "sienna"
    assert entries["s2"].engine == "andes"


class _SnapshotDouble(SnapshotMixin):
    """A SnapshotMixin with the shared state stubbed for a workspace on disk."""

    def __init__(self, workspace: Path) -> None:
        self._workspace = workspace
        self._ss = Mock()
        self._ss.PFlow.converged = False
        self._ss.TDS.initialized = False
        self._case_path = workspace / "ieee14.raw"
        self._case_path.write_bytes(b"case bytes")
        self._disturbance_log: list[object] = []
        self._edit_log: list[object] = []
        self._redo_log: list[object] = []
        self._client_events: list[object] = []
        self._restored_events: list[object] = []
        self._setup_failed = False
        self._se_measurements = None
        self.reload_case = Mock()
        self.add_disturbance = Mock()
        self._ensure_setup = Mock()

    def _require_loaded(self) -> object:
        return self._ss


def _write_sidecar(
    workspace: Path, name: str, *, engine: str | None = "andes"
) -> None:
    snap_dir = workspace / "snapshots" / "ieee14"
    snap_dir.mkdir(parents=True, exist_ok=True)
    data = _metadata_dict()
    if engine is not None:
        data["engine"] = engine
    (snap_dir / f"{name}.json").write_text(json.dumps(data), encoding="utf-8")


def test_restore_refuses_foreign_snapshot_before_touching_system(
    tmp_path: Path,
) -> None:
    double = _SnapshotDouble(tmp_path)
    _write_sidecar(tmp_path, "s1", engine="sienna")

    with pytest.raises(SnapshotEngineMismatchError) as excinfo:
        double.restore_snapshot("s1")
    message = str(excinfo.value)
    assert "saved by the sienna engine" in message
    assert "this session runs andes" in message
    double.reload_case.assert_not_called()


def test_restore_accepts_pre_unit_snapshot(tmp_path: Path) -> None:
    double = _SnapshotDouble(tmp_path)
    _write_sidecar(tmp_path, "s1", engine=None)

    result = double.restore_snapshot("s1")
    assert result["used_dill"] is False
    double.reload_case.assert_called_once_with()


def test_save_snapshot_stamps_andes(tmp_path: Path) -> None:
    double = _SnapshotDouble(tmp_path)
    double.save_snapshot("s1")

    sidecar = tmp_path / "snapshots" / "ieee14" / "s1.json"
    data = json.loads(sidecar.read_text(encoding="utf-8"))
    assert data["engine"] == "andes"
