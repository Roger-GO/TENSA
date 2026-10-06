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


# ---- the diagram's layout ---------------------------------------------------


def _layout(**overrides: Any) -> dict[str, Any]:
    """A layout as the worker hands it to the assembler: a validated document's dict."""
    from tensa.core.layout import parse_layout

    doc: dict[str, Any] = {
        "schema_version": "2",
        "andes_version": "2.0.0",
        "coordinates": {"1": {"x": 10.0, "y": 20.0}, "2": {"x": 210.0, "y": 20.0}},
        "non_bus_coordinates": {"load": {"PQ_1": {"x": 10.0, "y": 90.0}}},
        "branches": {
            "line": {
                "Line_1": {
                    "routing": "polyline",
                    "bend_points": [{"x": 40.0, "y": 26.0}, {"x": 240.0, "y": 26.0}],
                }
            }
        },
        "figure": {"monochrome": True},
        "last_modified": "2026-10-06T08:00:00+00:00",
    }
    doc.update(overrides)
    return parse_layout(doc).model_dump()


def _with_entry(zip_bytes: bytes, name: str, data: bytes) -> bytes:
    """``zip_bytes`` with one entry replaced (or added)."""
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as src, zipfile.ZipFile(out, "w") as dst:
        for info in src.infolist():
            if info.filename != name:
                dst.writestr(info, src.read(info.filename))
        dst.writestr(name, data)
    return out.getvalue()


@pytest.mark.unit
def test_assemble_bundle_holds_the_layout_and_the_manifest_lists_it() -> None:
    layout = _layout()
    out = assemble_bundle(_minimal_inputs(layout=layout))
    assert "layout.json" in list_bundle_entries(out)
    with zipfile.ZipFile(io.BytesIO(out)) as zf:
        assert json.loads(zf.read("layout.json")) == layout
    files = read_bundle_manifest(out)["files"]
    assert files.index("layout.json") < files.index("manifest.json")


@pytest.mark.unit
def test_a_bundle_with_no_layout_has_no_layout_entry() -> None:
    out = assemble_bundle(_minimal_inputs())
    assert "layout.json" not in list_bundle_entries(out)
    assert "layout.json" not in read_bundle_manifest(out)["files"]


@pytest.mark.unit
def test_extract_bundle_puts_the_layout_beside_the_case(tmp_path: Path) -> None:
    layout = _layout()
    result = _extract(assemble_bundle(_minimal_inputs(layout=layout)), tmp_path)
    assert result["layout_restored"] is True
    assert result["warnings"] == []
    assert json.loads((tmp_path / "ieee14.raw.layout.json").read_text(encoding="utf-8")) == layout
    # The layout is no case file: it is not listed as one, nor loaded as an addfile.
    assert result["addfile_paths"] == []


@pytest.mark.unit
def test_extract_bundle_replaces_the_layout_the_workspace_had(tmp_path: Path) -> None:
    (tmp_path / "ieee14.raw.layout.json").write_text(
        json.dumps(_layout(coordinates={"99": {"x": 1.0, "y": 1.0}})), encoding="utf-8"
    )
    result = _extract(assemble_bundle(_minimal_inputs(layout=_layout())), tmp_path)
    assert result["layout_restored"] is True
    stored = json.loads((tmp_path / "ieee14.raw.layout.json").read_text(encoding="utf-8"))
    assert sorted(stored["coordinates"]) == ["1", "2"]


@pytest.mark.unit
def test_extract_bundle_without_a_layout_leaves_the_workspace_layout_alone(tmp_path: Path) -> None:
    """A bundle exported before layouts were bundled."""
    existing = json.dumps(_layout())
    (tmp_path / "ieee14.raw.layout.json").write_text(existing, encoding="utf-8")
    result = _extract(assemble_bundle(_minimal_inputs()), tmp_path)
    assert result["layout_restored"] is False
    assert result["warnings"] == []
    assert (tmp_path / "ieee14.raw.layout.json").read_text(encoding="utf-8") == existing


@pytest.mark.unit
def test_extract_bundle_upgrades_a_version_1_layout(tmp_path: Path) -> None:
    v1 = {
        "schema_version": "1",
        "andes_version": "2.0.0",
        "coordinates": {"1": {"x": 10.0, "y": 20.0}},
        "last_modified": "2026-05-07T12:00:00+00:00",
    }
    zip_bytes = _with_entry(
        assemble_bundle(_minimal_inputs()), "layout.json", json.dumps(v1).encode("utf-8")
    )
    assert _extract(zip_bytes, tmp_path)["layout_restored"] is True
    stored = json.loads((tmp_path / "ieee14.raw.layout.json").read_text(encoding="utf-8"))
    assert stored["schema_version"] == "2"
    assert stored["coordinates"] == v1["coordinates"]


@pytest.mark.unit
@pytest.mark.parametrize(
    "data",
    [b"{not json", b'{"schema_version": "2"}', b'{"coordinates": {"1": {"x": "left"}}}'],
)
def test_a_layout_that_does_not_validate_is_left_out_with_a_warning(
    tmp_path: Path, data: bytes
) -> None:
    """The case and its disturbances reproduce the result; a bad layout does
    not stop the import."""
    zip_bytes = _with_entry(assemble_bundle(_minimal_inputs()), "layout.json", data)
    result = _extract(zip_bytes, tmp_path)
    assert (tmp_path / "ieee14.raw").read_bytes() == b"BUS 1\nLINE 1 2\n"
    assert result["layout_restored"] is False
    assert result["warnings"] == [
        "the bundle's layout.json is not a valid layout; the diagram layout was not imported"
    ]
    assert not (tmp_path / "ieee14.raw.layout.json").exists()


@pytest.mark.unit
def test_a_layout_entry_too_large_to_read_is_left_out_without_being_read(tmp_path: Path) -> None:
    from tensa.core.layout import MAX_LAYOUT_FILE_BYTES

    zip_bytes = _with_entry(
        assemble_bundle(_minimal_inputs()), "layout.json", b" " * (MAX_LAYOUT_FILE_BYTES + 1)
    )
    result = _extract(zip_bytes, tmp_path)
    assert result["layout_restored"] is False
    assert result["warnings"] == [
        f"the bundle's layout.json is {MAX_LAYOUT_FILE_BYTES + 1} bytes, too large to read; "
        "the diagram layout was not imported"
    ]
    assert not (tmp_path / "ieee14.raw.layout.json").exists()


@pytest.mark.unit
def test_the_layout_entry_is_the_layout_as_it_is_stored_beside_a_case(tmp_path: Path) -> None:
    """One stored form, the one the layout's cap is measured on: a layout that
    fits beside a case fits in a bundle, and the other way round."""
    from tensa.core.layout import layout_json, parse_layout

    layout = _layout()
    out = assemble_bundle(_minimal_inputs(layout=layout))
    with zipfile.ZipFile(io.BytesIO(out)) as zf:
        entry = zf.read("layout.json")
    assert entry == layout_json(parse_layout(layout))
    _extract(out, tmp_path)
    assert (tmp_path / "ieee14.raw.layout.json").read_bytes() == entry


@pytest.mark.unit
def test_an_indented_layout_entry_is_imported_when_the_layout_in_it_fits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The cap is on the layout, not on the entry: a bundle written with
    indentation holds the same layout in more bytes."""
    from tensa.core.layout import layout_json, parse_layout

    layout = _layout()
    stored = len(layout_json(parse_layout(layout)))
    indented = json.dumps(layout, indent=2).encode("utf-8")
    assert len(indented) > stored
    monkeypatch.setattr("tensa.core.layout.MAX_LAYOUT_BYTES", stored)
    zip_bytes = _with_entry(assemble_bundle(_minimal_inputs()), "layout.json", indented)
    result = _extract(zip_bytes, tmp_path)
    assert result["layout_restored"] is True
    assert result["warnings"] == []
    assert json.loads((tmp_path / "ieee14.raw.layout.json").read_text(encoding="utf-8")) == layout


@pytest.mark.unit
def test_a_layout_entry_holding_a_layout_over_the_cap_is_left_out(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from tensa.core.layout import layout_json, parse_layout

    layout = _layout()
    stored = len(layout_json(parse_layout(layout)))
    zip_bytes = assemble_bundle(_minimal_inputs(layout=layout))
    monkeypatch.setattr("tensa.core.layout.MAX_LAYOUT_BYTES", stored - 1)
    result = _extract(zip_bytes, tmp_path)
    assert (tmp_path / "ieee14.raw").exists()
    assert result["layout_restored"] is False
    assert result["warnings"] == [
        f"the bundle's layout.json is too large (the layout takes {stored} bytes as it is "
        f"stored; the cap is {stored - 1}); the diagram layout was not imported"
    ]
    assert not (tmp_path / "ieee14.raw.layout.json").exists()


@pytest.mark.unit
@pytest.mark.parametrize(
    "bundle_layout",
    [None, b"{not json"],
    ids=["no-layout", "a-layout-that-does-not-validate"],
)
def test_a_case_replaced_by_a_bundle_with_no_layout_does_not_keep_the_old_one(
    tmp_path: Path, bundle_layout: bytes | None
) -> None:
    """The layout beside the workspace's file was made for the system that
    file held. Left there, it would be drawn over the bundle's system."""
    (tmp_path / "ieee14.raw").write_bytes(b"another system under the same name")
    sidecar = tmp_path / "ieee14.raw.layout.json"
    sidecar.write_text(json.dumps(_layout()), encoding="utf-8")
    zip_bytes = assemble_bundle(_minimal_inputs())
    if bundle_layout is not None:
        zip_bytes = _with_entry(zip_bytes, "layout.json", bundle_layout)

    result = _extract(zip_bytes, tmp_path, use_bundle_case=True)
    assert (tmp_path / "ieee14.raw").read_bytes() == b"BUS 1\nLINE 1 2\n"
    assert not sidecar.exists()
    assert result["layout_restored"] is False
    assert result["warnings"][-1] == (
        "the diagram layout beside workspace 'ieee14.raw' was removed: "
        "it was made for the file the bundle's copy replaced"
    )
    assert len(result["warnings"]) == (2 if bundle_layout is None else 3)


@pytest.mark.unit
def test_a_bundle_with_no_layout_leaves_the_layout_of_a_case_it_does_not_change(
    tmp_path: Path,
) -> None:
    """The workspace already holds the bundle's case, byte for byte, with a
    layout of its own: that layout still describes the file."""
    (tmp_path / "ieee14.raw").write_bytes(b"BUS 1\nLINE 1 2\n")
    mine = json.dumps(_layout())
    (tmp_path / "ieee14.raw.layout.json").write_text(mine, encoding="utf-8")
    result = _extract(assemble_bundle(_minimal_inputs()), tmp_path)
    assert result["warnings"] == []
    assert (tmp_path / "ieee14.raw.layout.json").read_text(encoding="utf-8") == mine


@pytest.mark.unit
def test_keeping_the_workspace_case_keeps_its_layout_when_the_bundle_has_none(
    tmp_path: Path,
) -> None:
    (tmp_path / "ieee14.raw").write_bytes(b"workspace copy")
    mine = json.dumps(_layout(coordinates={"7": {"x": 7.0, "y": 7.0}}))
    (tmp_path / "ieee14.raw.layout.json").write_text(mine, encoding="utf-8")
    result = _extract(assemble_bundle(_minimal_inputs()), tmp_path, use_bundle_case=False)
    assert (tmp_path / "ieee14.raw").read_bytes() == b"workspace copy"
    assert (tmp_path / "ieee14.raw.layout.json").read_text(encoding="utf-8") == mine
    assert len(result["warnings"]) == 1  # the copy saved for comparison


@pytest.mark.unit
@pytest.mark.skipif(sys.platform == "win32", reason="POSIX symlinks")
def test_a_symlink_where_the_replaced_case_layout_would_be_is_left_alone(tmp_path: Path) -> None:
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / "ieee14.raw").write_bytes(b"another system under the same name")
    planted = tmp_path / "planted.json"
    planted.write_text(json.dumps(_layout()), encoding="utf-8")
    (workspace / "ieee14.raw.layout.json").symlink_to(planted)
    result = _extract(assemble_bundle(_minimal_inputs()), workspace, use_bundle_case=True)
    assert planted.exists()
    assert (workspace / "ieee14.raw.layout.json").is_symlink()
    assert result["warnings"] == ["workspace 'ieee14.raw' overwritten with bundle copy"]


@pytest.mark.unit
def test_keeping_the_workspace_case_keeps_its_layout_too(tmp_path: Path) -> None:
    (tmp_path / "ieee14.raw").write_bytes(b"workspace copy")
    mine = json.dumps(_layout(coordinates={"7": {"x": 7.0, "y": 7.0}}))
    (tmp_path / "ieee14.raw.layout.json").write_text(mine, encoding="utf-8")
    zip_bytes = assemble_bundle(_minimal_inputs(layout=_layout()))
    result = _extract(zip_bytes, tmp_path, use_bundle_case=False)
    assert result["layout_restored"] is False
    assert (tmp_path / "ieee14.raw.layout.json").read_text(encoding="utf-8") == mine
    assert result["warnings"][-1] == (
        "the bundle's diagram layout was not imported: workspace 'ieee14.raw' "
        "was kept, and its own layout with it"
    )


@pytest.mark.unit
@pytest.mark.skipif(sys.platform == "win32", reason="POSIX symlinks")
def test_a_symlink_where_the_layout_goes_is_not_written_through(tmp_path: Path) -> None:
    workspace = tmp_path / "ws"
    workspace.mkdir()
    planted = tmp_path / "planted.json"
    (workspace / "ieee14.raw.layout.json").symlink_to(planted)  # dangling
    result = _extract(assemble_bundle(_minimal_inputs(layout=_layout())), workspace)
    assert not planted.exists()
    # The case is imported all the same; only the layout is given up, with a warning.
    assert (workspace / "ieee14.raw").exists()
    assert result["layout_restored"] is False
    assert len(result["warnings"]) == 1
    assert "diagram layout could not be written" in result["warnings"][0]
