"""Unit tests for the bundle assembler.

These tests exercise :mod:`tensa.core.bundle` directly without spinning
up a worker subprocess or touching ANDES — the assembler is a pure
function over `BundleInputs` so the round-trip / determinism / file-list
properties can be verified in isolation.
"""

from __future__ import annotations

import hashlib
import io
import json
import sys
import zipfile
from pathlib import Path
from typing import Any

import pytest

import tensa
from tensa.core.bundle import (
    BundleImportPlan,
    BundleInputs,
    BundleResolveChoices,
    BundleValidationError,
    assemble_bundle,
    build_manifest,
    case_entry_name_problem,
    case_files_from_workspace,
    check_exportable_case_files,
    extract_bundle,
    list_bundle_entries,
    read_bundle_manifest,
    validate_bundle,
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
        "tensa_version": tensa.__version__,
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
    assert manifest["tensa_version"] == tensa.__version__
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


# ---- import side: portable names + write-target containment ---------------


def _validate(zip_bytes: bytes, workspace: Path) -> BundleImportPlan:
    return validate_bundle(zip_bytes, workspace=workspace, current_andes_version="2.0.0")


def _extract(
    zip_bytes: bytes,
    workspace: Path,
    *,
    use_bundle_case: bool = True,
) -> dict[str, Any]:
    plan = _validate(zip_bytes, workspace)
    return extract_bundle(
        zip_bytes,
        workspace=workspace,
        resolve=BundleResolveChoices(use_bundle_case=use_bundle_case),
        plan=plan,
    )


# Names that are fine on Linux but misread by Windows (device, drive prefix,
# alternate data stream, stripped trailing dot/space), plus the older structural
# rejections (traversal, nesting, hidden files). Each must fail validation on
# EVERY platform, because a bundle is built on one OS and imported on another.
_UNSAFE_CASE_NAMES = [
    "CON.raw",
    "nul",
    "Aux.dyr",
    "COM1.raw",
    "lpt9.xlsx",
    "C:evil.raw",
    "case.raw:stream",
    "ieee14.raw.",
    "ieee14.raw ",
    "a?b.raw",
    "a*b.raw",
    "../evil.raw",
    "sub/ieee14.raw",
    "sub\\ieee14.raw",
    ".hidden.raw",
]


@pytest.mark.unit
@pytest.mark.parametrize("name", _UNSAFE_CASE_NAMES)
def test_validate_bundle_rejects_unsafe_primary_case_name(name: str, tmp_path: Path) -> None:
    zip_bytes = assemble_bundle(_minimal_inputs(case_files=((name, b"BUS 1\n"),)))
    with pytest.raises(BundleValidationError) as excinfo:
        _validate(zip_bytes, tmp_path)
    assert excinfo.value.category == "manifest-malformed"
    assert "unsafe name" in excinfo.value.detail or "nested case entry" in excinfo.value.detail
    assert list(tmp_path.iterdir()) == []


@pytest.mark.unit
@pytest.mark.parametrize("name", _UNSAFE_CASE_NAMES)
def test_validate_bundle_rejects_unsafe_addfile_name(name: str, tmp_path: Path) -> None:
    inputs = _minimal_inputs(
        case_files=(("ieee14.raw", b"BUS 1\n"), (name, b"GEN 1\n")),
    )
    with pytest.raises(BundleValidationError) as excinfo:
        _validate(assemble_bundle(inputs), tmp_path)
    assert excinfo.value.category == "manifest-malformed"


@pytest.mark.unit
def test_validate_bundle_names_the_windows_problem(tmp_path: Path) -> None:
    zip_bytes = assemble_bundle(_minimal_inputs(case_files=(("CON.raw", b"x"),)))
    with pytest.raises(BundleValidationError, match="reserved Windows device name"):
        _validate(zip_bytes, tmp_path)
    zip_bytes = assemble_bundle(_minimal_inputs(case_files=(("C:evil.raw", b"x"),)))
    with pytest.raises(BundleValidationError, match="drive prefix"):
        _validate(zip_bytes, tmp_path)


# ---- export side: refuse what import would refuse --------------------------

_ORDINARY_CASE_NAMES = ["ieee14.raw", "console.raw", "Kundur two-area (v2).dyr", "a.b.c", "naïve.raw"]


@pytest.mark.unit
@pytest.mark.parametrize("name", _UNSAFE_CASE_NAMES)
def test_export_refuses_a_case_file_the_import_would_reject(name: str) -> None:
    with pytest.raises(BundleValidationError) as excinfo:
        check_exportable_case_files(((name, b"BUS 1\n"),))
    assert excinfo.value.category == "unportable-name"
    assert repr(name) in excinfo.value.detail
    assert "Rename the file" in excinfo.value.detail


@pytest.mark.unit
def test_export_names_an_unsafe_addfile_not_the_primary() -> None:
    with pytest.raises(BundleValidationError) as excinfo:
        check_exportable_case_files((("ieee14.raw", b"BUS 1\n"), ("aux.dyr", b"GEN 1\n")))
    assert "'aux.dyr'" in excinfo.value.detail
    assert "ieee14.raw" not in excinfo.value.detail
    assert "reserved Windows device name" in excinfo.value.detail


@pytest.mark.unit
@pytest.mark.parametrize("name", _ORDINARY_CASE_NAMES)
def test_export_accepts_ordinary_case_names(name: str) -> None:
    check_exportable_case_files(((name, b"BUS 1\n"),))


@pytest.mark.unit
@pytest.mark.parametrize("name", [*_UNSAFE_CASE_NAMES, *_ORDINARY_CASE_NAMES])
def test_export_and_import_agree_on_every_case_name(name: str, tmp_path: Path) -> None:
    """One rule behind both directions: a bundle the exporter writes is one the
    importer reads, and the other way round."""
    zip_bytes = assemble_bundle(_minimal_inputs(case_files=((name, b"BUS 1\n"),)))
    try:
        _validate(zip_bytes, tmp_path)
        import_ok = True
    except BundleValidationError:
        import_ok = False
    try:
        check_exportable_case_files(((name, b"BUS 1\n"),))
        export_ok = True
    except BundleValidationError:
        export_ok = False
    assert export_ok == import_ok == (case_entry_name_problem(name) is None)


@pytest.mark.unit
def test_export_refuses_more_case_files_than_import_accepts() -> None:
    too_many = tuple((f"part{i}.raw", b"x") for i in range(17))
    with pytest.raises(BundleValidationError) as excinfo:
        check_exportable_case_files(too_many)
    assert excinfo.value.category == "too-many-case-files"
    check_exportable_case_files(too_many[:16])


@pytest.mark.unit
def test_validate_and_extract_accept_ordinary_names(tmp_path: Path) -> None:
    inputs = _minimal_inputs(
        case_files=(
            ("console.raw", b"BUS 1\n"),  # device name is only a prefix
            ("Kundur two-area (v2).dyr", b"GEN 1\n"),
        ),
    )
    zip_bytes = assemble_bundle(inputs)
    plan = _validate(zip_bytes, tmp_path)
    assert plan.case_files == ("console.raw", "Kundur two-area (v2).dyr")
    result = _extract(zip_bytes, tmp_path)
    assert Path(result["primary_path"]).read_bytes() == b"BUS 1\n"
    assert [Path(p).name for p in result["addfile_paths"]] == ["Kundur two-area (v2).dyr"]
    assert (tmp_path / "Kundur two-area (v2).dyr").read_bytes() == b"GEN 1\n"


@pytest.mark.unit
def test_extract_bundle_refuses_names_the_validator_would_have_caught(tmp_path: Path) -> None:
    """Defence in depth: ``extract_bundle`` re-checks every destination, so a
    plan that skipped (or outlived) validation still cannot write a device name."""
    zip_bytes = assemble_bundle(_minimal_inputs(case_files=(("CON.raw", b"x"),)))
    plan = BundleImportPlan(
        manifest={"case_filename": "CON.raw"},
        case_files=("CON.raw",),
    )
    with pytest.raises(BundleValidationError) as excinfo:
        extract_bundle(
            zip_bytes,
            workspace=tmp_path,
            resolve=BundleResolveChoices(),
            plan=plan,
        )
    assert excinfo.value.category == "unsafe-path"
    assert list(tmp_path.iterdir()) == []


@pytest.mark.unit
@pytest.mark.skipif(sys.platform == "win32", reason="POSIX symlinks")
def test_extract_bundle_refuses_symlink_that_escapes_the_workspace(tmp_path: Path) -> None:
    """An addfile name that is a symlink to a file outside the workspace must not
    be written through, and nothing else may be extracted first."""
    workspace = tmp_path / "ws"
    workspace.mkdir()
    outside = tmp_path / "outside.dyr"
    outside.write_bytes(b"precious")
    (workspace / "ieee14.dyr").symlink_to(outside)
    inputs = _minimal_inputs(
        case_files=(("ieee14.raw", b"BUS 1\n"), ("ieee14.dyr", b"GEN 1\n")),
    )
    zip_bytes = assemble_bundle(inputs)
    with pytest.raises(BundleValidationError) as excinfo:
        _extract(zip_bytes, workspace)
    assert excinfo.value.category == "unsafe-path"
    assert outside.read_bytes() == b"precious"
    assert not (workspace / "ieee14.raw").exists(), "partial extraction left a primary behind"


@pytest.mark.unit
@pytest.mark.skipif(sys.platform == "win32", reason="POSIX symlinks")
def test_extract_bundle_refuses_symlinked_primary(tmp_path: Path) -> None:
    workspace = tmp_path / "ws"
    workspace.mkdir()
    outside = tmp_path / "outside.raw"
    outside.write_bytes(b"precious")
    (workspace / "ieee14.raw").symlink_to(outside)
    zip_bytes = assemble_bundle(_minimal_inputs())
    with pytest.raises(BundleValidationError) as excinfo:
        _extract(zip_bytes, workspace)
    assert excinfo.value.category == "unsafe-path"
    assert outside.read_bytes() == b"precious"


@pytest.mark.unit
@pytest.mark.skipif(sys.platform == "win32", reason="POSIX symlinks")
def test_extract_bundle_refuses_symlinked_from_bundle_sibling(tmp_path: Path) -> None:
    """keep-my-file mode writes ``<case>.from-bundle`` beside the original; that
    sibling is a write target too."""
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / "ieee14.raw").write_bytes(b"workspace copy")  # sha differs: conflict
    outside = tmp_path / "outside"
    outside.write_bytes(b"precious")
    (workspace / "ieee14.raw.from-bundle").symlink_to(outside)
    zip_bytes = assemble_bundle(_minimal_inputs())
    with pytest.raises(BundleValidationError) as excinfo:
        _extract(zip_bytes, workspace, use_bundle_case=False)
    assert excinfo.value.category == "unsafe-path"
    assert outside.read_bytes() == b"precious"
    assert (workspace / "ieee14.raw").read_bytes() == b"workspace copy"


@pytest.mark.unit
@pytest.mark.skipif(sys.platform == "win32", reason="POSIX symlinks")
def test_extract_bundle_refuses_dangling_symlinked_addfile(tmp_path: Path) -> None:
    """The link's target does not exist yet, so ``exists()`` is False and only an
    ``lstat``-based check sees the symlink. ``write_bytes`` would otherwise create
    the file outside the workspace."""
    workspace = tmp_path / "ws"
    workspace.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    planted = outside / "planted.dyr"
    (workspace / "ieee14.dyr").symlink_to(planted)  # dangling
    inputs = _minimal_inputs(
        case_files=(("ieee14.raw", b"BUS 1\n"), ("ieee14.dyr", b"GEN 1\n")),
    )
    zip_bytes = assemble_bundle(inputs)
    with pytest.raises(BundleValidationError) as excinfo:
        _extract(zip_bytes, workspace)
    assert excinfo.value.category == "unsafe-path"
    assert not planted.exists(), "a dangling symlink redirected a write outside the workspace"
    assert not (workspace / "ieee14.raw").exists(), "partial extraction left a primary behind"


@pytest.mark.unit
@pytest.mark.skipif(sys.platform == "win32", reason="POSIX symlinks")
def test_extract_bundle_refuses_dangling_symlinked_primary(tmp_path: Path) -> None:
    workspace = tmp_path / "ws"
    workspace.mkdir()
    planted = tmp_path / "planted.raw"
    (workspace / "ieee14.raw").symlink_to(planted)  # dangling
    zip_bytes = assemble_bundle(_minimal_inputs())
    with pytest.raises(BundleValidationError) as excinfo:
        _extract(zip_bytes, workspace)
    assert excinfo.value.category == "unsafe-path"
    assert not planted.exists()


@pytest.mark.unit
@pytest.mark.skipif(sys.platform == "win32", reason="POSIX symlinks")
def test_extract_bundle_refuses_dangling_symlinked_from_bundle_sibling(tmp_path: Path) -> None:
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / "ieee14.raw").write_bytes(b"workspace copy")  # sha differs: conflict
    planted = tmp_path / "planted"
    (workspace / "ieee14.raw.from-bundle").symlink_to(planted)  # dangling
    zip_bytes = assemble_bundle(_minimal_inputs())
    with pytest.raises(BundleValidationError) as excinfo:
        _extract(zip_bytes, workspace, use_bundle_case=False)
    assert excinfo.value.category == "unsafe-path"
    assert not planted.exists()
    assert (workspace / "ieee14.raw").read_bytes() == b"workspace copy"


@pytest.mark.unit
def test_extract_bundle_keep_workspace_copy_writes_sibling(tmp_path: Path) -> None:
    (tmp_path / "ieee14.raw").write_bytes(b"workspace copy")
    zip_bytes = assemble_bundle(_minimal_inputs())
    result = _extract(zip_bytes, tmp_path, use_bundle_case=False)
    assert (tmp_path / "ieee14.raw").read_bytes() == b"workspace copy"
    assert (tmp_path / "ieee14.raw.from-bundle").read_bytes() == b"BUS 1\nLINE 1 2\n"
    assert Path(result["primary_path"]).name == "ieee14.raw"
    assert result["warnings"] == [
        "workspace 'ieee14.raw' preserved; bundle copy saved to ieee14.raw.from-bundle for comparison"
    ]
