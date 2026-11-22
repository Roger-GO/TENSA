"""Unit tests for the engine stamp on bundles (multi-engine unit 3.7).

Covers the core module (``tensa.core.bundle``) and the wrapper mixin
(``tensa.core.wrapper.bundle``): the stamp written into the manifest, the
read-back default for a pre-unit bundle, and the refusal of a foreign-engine
import.
"""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from unittest.mock import Mock

import pytest

from tensa.core.bundle import (
    BundleInputs,
    BundleValidationError,
    assemble_bundle,
    build_manifest,
    bundle_plan_to_dict,
    validate_bundle,
)
from tensa.core.wrapper.bundle import BundleMixin

CASE_BYTES = b"0 / END OF BUS DATA\n"


def _inputs(**overrides: object) -> BundleInputs:
    base: dict[str, object] = {
        "case_files": (("ieee14.raw", CASE_BYTES),),
        "case_canonical_export": False,
        "disturbances": (),
        "sim_params": None,
        "results_csv": None,
        "run_id": None,
        "andes_version": "2.0.0",
        "tensa_version": "0.4.0",
        "engine": "andes",
    }
    base.update(overrides)
    return BundleInputs(**base)  # type: ignore[arg-type]


def _rezip_with_manifest(zip_bytes: bytes, manifest: dict[str, object]) -> bytes:
    """Rebuild a bundle zip with a replaced manifest.json body."""
    with zipfile.ZipFile(io.BytesIO(zip_bytes), mode="r") as zf:
        entries = {name: zf.read(name) for name in zf.namelist()}
    entries["manifest.json"] = json.dumps(manifest).encode("utf-8")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w") as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return buf.getvalue()


def test_manifest_carries_engine() -> None:
    manifest = build_manifest(
        _inputs(), exported_at="2026-11-20T00:00:00+00:00"
    )
    assert manifest["engine"] == "andes"


def test_validate_bundle_defaults_missing_engine(tmp_path: Path) -> None:
    zip_bytes = assemble_bundle(
        _inputs(), exported_at="2026-11-20T00:00:00+00:00"
    )
    manifest = json.loads(
        zipfile.ZipFile(io.BytesIO(zip_bytes)).read("manifest.json")
    )
    del manifest["engine"]
    pre_unit = _rezip_with_manifest(zip_bytes, manifest)

    plan = validate_bundle(
        pre_unit, workspace=tmp_path, current_andes_version="2.0.0"
    )
    assert plan.engine == "andes"
    assert plan.conflicts == ()


def test_validate_bundle_reads_foreign_engine(tmp_path: Path) -> None:
    zip_bytes = assemble_bundle(
        _inputs(engine="sienna"), exported_at="2026-11-20T00:00:00+00:00"
    )
    plan = validate_bundle(
        zip_bytes, workspace=tmp_path, current_andes_version="2.0.0"
    )
    assert plan.engine == "sienna"


def test_plan_serialisation_carries_engine(tmp_path: Path) -> None:
    zip_bytes = assemble_bundle(
        _inputs(engine="sienna"), exported_at="2026-11-20T00:00:00+00:00"
    )
    plan = validate_bundle(
        zip_bytes, workspace=tmp_path, current_andes_version="2.0.0"
    )
    assert bundle_plan_to_dict(plan)["engine"] == "sienna"


class _BundleDouble(BundleMixin):
    """A BundleMixin with the shared state stubbed for a workspace on disk."""

    def __init__(self, workspace: Path) -> None:
        self._workspace = workspace
        self.load_case = Mock()
        self.add_disturbance = Mock()
        self._restored_events: list[object] = []


def test_import_bundle_refuses_foreign_engine(tmp_path: Path) -> None:
    zip_bytes = assemble_bundle(
        _inputs(engine="sienna"), exported_at="2026-11-20T00:00:00+00:00"
    )
    double = _BundleDouble(tmp_path)

    with pytest.raises(BundleValidationError) as excinfo:
        double.import_bundle(zip_bytes)
    assert excinfo.value.category == "engine-mismatch"
    assert "written by the sienna engine" in excinfo.value.detail
    assert "this session runs andes" in excinfo.value.detail
    double.load_case.assert_not_called()


def test_import_bundle_accepts_pre_unit_bundle(tmp_path: Path) -> None:
    zip_bytes = assemble_bundle(
        _inputs(), exported_at="2026-11-20T00:00:00+00:00"
    )
    manifest = json.loads(
        zipfile.ZipFile(io.BytesIO(zip_bytes)).read("manifest.json")
    )
    del manifest["engine"]
    pre_unit = _rezip_with_manifest(zip_bytes, manifest)

    double = _BundleDouble(tmp_path)
    result = double.import_bundle(pre_unit)
    assert result["status"] == "committed"
    double.load_case.assert_called_once()


def test_engine_mismatch_precedes_conflict_plan(tmp_path: Path) -> None:
    # A foreign-engine bundle that also has an ANDES version mismatch is
    # refused outright, not surfaced as a resolvable plan.
    zip_bytes = assemble_bundle(
        _inputs(engine="sienna", andes_version="99.0.0"),
        exported_at="2026-11-20T00:00:00+00:00",
    )
    double = _BundleDouble(tmp_path)

    with pytest.raises(BundleValidationError) as excinfo:
        double.import_bundle(zip_bytes)
    assert excinfo.value.category == "engine-mismatch"
    double.load_case.assert_not_called()
