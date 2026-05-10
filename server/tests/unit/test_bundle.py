"""Unit tests for the bundle assembler.

These tests exercise :mod:`andes_app.core.bundle` directly without spinning
up a worker subprocess or touching ANDES — the assembler is a pure
function over `BundleInputs` so the round-trip / determinism / file-list
properties can be verified in isolation.
"""

from __future__ import annotations

import hashlib
import io
import json
import zipfile

import pytest

from andes_app.core.bundle import (
    BundleInputs,
    assemble_bundle,
    build_manifest,
    case_files_from_workspace,
    list_bundle_entries,
    read_bundle_manifest,
)


def _minimal_inputs(**overrides: object) -> BundleInputs:
    """Build a `BundleInputs` with sensible defaults; tests override the
    fields they care about."""
    base = {
        "case_files": (("ieee14.raw", b"BUS 1\nLINE 1 2\n"),),
        "case_canonical_export": False,
        "disturbances": (),
        "sim_params": None,
        "results_csv": None,
        "run_id": None,
        "andes_version": "2.0.0",
        "andes_app_version": "0.1.0.dev0",
    }
    base.update(overrides)
    return BundleInputs(**base)  # type: ignore[arg-type]


@pytest.mark.unit
def test_assemble_bundle_minimal_contains_case_and_manifest_only() -> None:
    """No disturbances, no sim params, no CSV → bundle has only the case
    file + manifest."""
    inputs = _minimal_inputs()
    out = assemble_bundle(inputs, exported_at="2026-05-09T12:00:00+00:00")
    entries = list_bundle_entries(out)
    assert "case/ieee14.raw" in entries
    assert "manifest.json" in entries
    assert "disturbances.json" not in entries
    assert "sim_params.json" not in entries
    assert "results.csv" not in entries


@pytest.mark.unit
def test_assemble_bundle_includes_disturbances_when_present() -> None:
    inputs = _minimal_inputs(
        disturbances=(
            {"kind": "fault", "bus_idx": 5, "tf": 1.0, "tc": 1.1, "xf": 0.0001, "rf": 0.0},
        ),
    )
    out = assemble_bundle(inputs, exported_at="2026-05-09T12:00:00+00:00")
    entries = list_bundle_entries(out)
    assert "disturbances.json" in entries
    with zipfile.ZipFile(io.BytesIO(out)) as zf:
        body = json.loads(zf.read("disturbances.json").decode("utf-8"))
    assert body == [
        {"kind": "fault", "bus_idx": 5, "tf": 1.0, "tc": 1.1, "xf": 0.0001, "rf": 0.0},
    ]


@pytest.mark.unit
def test_assemble_bundle_includes_sim_params_when_present() -> None:
    inputs = _minimal_inputs(
        sim_params={
            "tf": 5.0,
            "h": None,
            "vars": ["bus_v", "gen_state"],
            "decimation": "mean",
            "max_rate_hz": 30.0,
        },
    )
    out = assemble_bundle(inputs, exported_at="2026-05-09T12:00:00+00:00")
    entries = list_bundle_entries(out)
    assert "sim_params.json" in entries
    with zipfile.ZipFile(io.BytesIO(out)) as zf:
        body = json.loads(zf.read("sim_params.json").decode("utf-8"))
    assert body["tf"] == 5.0
    assert body["vars"] == ["bus_v", "gen_state"]


@pytest.mark.unit
def test_assemble_bundle_includes_results_csv_when_present() -> None:
    inputs = _minimal_inputs(results_csv="time,variable,value\n0,x,1\n0.01,x,1.001\n")
    out = assemble_bundle(inputs, exported_at="2026-05-09T12:00:00+00:00")
    entries = list_bundle_entries(out)
    assert "results.csv" in entries
    with zipfile.ZipFile(io.BytesIO(out)) as zf:
        body = zf.read("results.csv").decode("utf-8")
    assert body.startswith("time,variable,value")


@pytest.mark.unit
def test_manifest_records_case_sha256_and_filename() -> None:
    case_bytes = b"BUS 1\nLINE 1 2\n"
    inputs = _minimal_inputs(case_files=(("ieee14.raw", case_bytes),))
    out = assemble_bundle(inputs, exported_at="2026-05-09T12:00:00+00:00")
    manifest = read_bundle_manifest(out)
    assert manifest["case_filename"] == "ieee14.raw"
    assert manifest["case_sha256"] == hashlib.sha256(case_bytes).hexdigest()
    assert manifest["andes_version"] == "2.0.0"
    assert manifest["andes_app_version"] == "0.1.0.dev0"
    assert manifest["disturbance_count"] == 0
    assert manifest["case_canonical_export"] is False
    assert manifest["files"] == ["case/ieee14.raw", "manifest.json"]


@pytest.mark.unit
def test_manifest_files_list_reflects_optional_components() -> None:
    inputs = _minimal_inputs(
        disturbances=(
            {"kind": "fault", "bus_idx": 5, "tf": 1.0, "tc": 1.1},
        ),
        sim_params={"tf": 5.0},
        results_csv="time,variable,value\n",
        run_id="run-abc",
    )
    out = assemble_bundle(inputs, exported_at="2026-05-09T12:00:00+00:00")
    manifest = read_bundle_manifest(out)
    assert manifest["files"] == [
        "case/ieee14.raw",
        "disturbances.json",
        "sim_params.json",
        "results.csv",
        "manifest.json",
    ]
    assert manifest["disturbance_count"] == 1
    assert manifest["run_id"] == "run-abc"


@pytest.mark.unit
def test_assemble_bundle_is_deterministic_across_invocations() -> None:
    """Same inputs + same exported_at → byte-equal bundles. Used to assert
    bundle reproducibility across sessions on the same ANDES version."""
    inputs = _minimal_inputs(
        disturbances=({"kind": "fault", "bus_idx": 5, "tf": 1.0, "tc": 1.1},),
    )
    a = assemble_bundle(inputs, exported_at="2026-05-09T12:00:00+00:00")
    b = assemble_bundle(inputs, exported_at="2026-05-09T12:00:00+00:00")
    assert a == b


@pytest.mark.unit
def test_assemble_bundle_supports_addfiles() -> None:
    """PSS/E .raw + .dyr addfile → bundle includes both verbatim."""
    inputs = _minimal_inputs(
        case_files=(
            ("ieee14.raw", b"BUS 1\nLINE 1 2\n"),
            ("ieee14.dyr", b"GENROU ...\n"),
        ),
    )
    out = assemble_bundle(inputs, exported_at="2026-05-09T12:00:00+00:00")
    entries = list_bundle_entries(out)
    assert "case/ieee14.raw" in entries
    assert "case/ieee14.dyr" in entries


@pytest.mark.unit
def test_case_files_from_workspace_reads_primary_and_addfile(tmp_path) -> None:  # type: ignore[no-untyped-def]
    primary = tmp_path / "ieee14.raw"
    addfile = tmp_path / "ieee14.dyr"
    primary.write_bytes(b"primary-content")
    addfile.write_bytes(b"addfile-content")
    out = case_files_from_workspace(primary, [addfile])
    assert out == (("ieee14.raw", b"primary-content"), ("ieee14.dyr", b"addfile-content"))


@pytest.mark.unit
def test_case_files_from_workspace_handles_no_addfiles(tmp_path) -> None:  # type: ignore[no-untyped-def]
    primary = tmp_path / "ieee14.raw"
    primary.write_bytes(b"primary-content")
    out = case_files_from_workspace(primary, None)
    assert out == (("ieee14.raw", b"primary-content"),)


@pytest.mark.unit
def test_build_manifest_uses_default_exported_at_when_absent() -> None:
    """``exported_at`` defaults to ISO-8601 current UTC; presence + format
    is the only thing we check (we don't pin to a wall clock)."""
    inputs = _minimal_inputs()
    manifest = build_manifest(inputs)
    assert isinstance(manifest["exported_at"], str)
    assert len(manifest["exported_at"]) > 0
    # ISO-8601 UTC offset suffix
    assert manifest["exported_at"].endswith("+00:00")


@pytest.mark.unit
def test_assemble_bundle_canonical_export_flag_propagates_to_manifest() -> None:
    inputs = _minimal_inputs(
        case_files=(("blank-system.xlsx", b"PK\x03\x04 fake xlsx"),),
        case_canonical_export=True,
    )
    out = assemble_bundle(inputs, exported_at="2026-05-09T12:00:00+00:00")
    manifest = read_bundle_manifest(out)
    assert manifest["case_canonical_export"] is True
    assert manifest["case_filename"] == "blank-system.xlsx"


@pytest.mark.unit
def test_disturbances_json_is_sorted_for_diff_friendliness() -> None:
    """The bundle's ``disturbances.json`` is sorted-keyed so two diffs of
    the same logical content don't show ordering noise."""
    inputs = _minimal_inputs(
        disturbances=(
            {"tf": 1.0, "kind": "fault", "bus_idx": 5, "tc": 1.1},
        ),
    )
    out = assemble_bundle(inputs, exported_at="2026-05-09T12:00:00+00:00")
    with zipfile.ZipFile(io.BytesIO(out)) as zf:
        body = zf.read("disturbances.json").decode("utf-8")
    # sort_keys=True sorts inside each object
    assert body.index('"bus_idx"') < body.index('"kind"') < body.index('"tc"') < body.index('"tf"')
