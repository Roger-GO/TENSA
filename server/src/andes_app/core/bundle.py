"""Reproducibility-bundle assembler (Unit 3 of the v2.0 plan).

Pure pack/unpack functions for the v2.0 ``.zip`` reproducibility bundle.
The bundle contract (KTD-5) is:

- ``case/<filename>`` (verbatim original case file when ``case.dirty == false``,
  else a canonical ``.xlsx`` export written via :func:`Wrapper.save_case`).
- ``case/<addfile>`` (any addfiles, verbatim, when the case has them).
- ``disturbances.json`` — serialised list of ``DisturbanceSpec`` Pydantic
  models from the substrate's in-memory list. Omitted when the list is
  empty.
- ``sim_params.json`` — last TDS run's ``tf``, ``h``, ``vars``,
  ``decimation``, ``max_rate_hz``. Omitted when no run has fired yet.
- ``results.csv`` — long-form serialisation of the last run's frames.
  Omitted when no run has fired yet OR the caller didn't supply the body
  (per the v2.0 plan's option (a) handling — frames live in the runs slice
  on the frontend, not the substrate, so the frontend ships the CSV body
  to this endpoint inline).
- ``manifest.json`` — ``{ andes_version, andes_app_version, case_filename,
  case_sha256, disturbance_count, run_id, exported_at, files: [...] }``.

Snapshots are NOT in the bundle (KTD-4): the dill payload is version-locked
and undermines portability. Snapshots ship in Unit 7 as a separate save/load
flow.

This module is import-time-cheap (no ANDES import). The expensive bits
(``Wrapper.save_case`` for dirty cases) are gated by the worker-side
caller and only fire when needed.
"""

from __future__ import annotations

import hashlib
import io
import json
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class BundleInputs:
    """Inputs that the bundle assembler needs to produce the ``.zip``.

    Lives as a frozen dataclass so the worker-side handler can build it
    once from disparate sources (filesystem reads, RPC args, version
    strings) and pass it as a single value to :func:`assemble_bundle`.
    """

    #: Mapping of in-zip filename → bytes for case-related files. The
    #: primary case file goes first; addfiles follow. The first entry
    #: becomes ``manifest.case_filename``.
    case_files: tuple[tuple[str, bytes], ...]
    #: Whether the case file(s) are the original workspace files
    #: verbatim (False) or a substrate-side canonical export (True).
    #: Surfaced in the manifest as ``case_canonical_export``.
    case_canonical_export: bool
    #: Disturbance specs as plain dicts (already model_dump()'d). When
    #: empty, ``disturbances.json`` is omitted from the bundle and the
    #: manifest's ``disturbance_count`` is 0.
    disturbances: tuple[dict[str, Any], ...]
    #: Last TDS run's sim params; ``None`` when no run has fired. When
    #: present, written verbatim as ``sim_params.json``.
    sim_params: dict[str, Any] | None
    #: Last TDS run's results as a long-form CSV body (UTF-8 string).
    #: ``None`` when no run has fired or when the caller chose not to
    #: ship the body. When present, written verbatim as ``results.csv``.
    results_csv: str | None
    #: Run id of the most recent TDS run, surfaced in the manifest.
    #: ``None`` when no run has fired.
    run_id: str | None
    #: ANDES package version (``andes.__version__``).
    andes_version: str
    #: ``andes_app`` package version (the substrate).
    andes_app_version: str


# ---- public API ------------------------------------------------------------


def build_manifest(inputs: BundleInputs, *, exported_at: str | None = None) -> dict[str, Any]:
    """Build the ``manifest.json`` body for a bundle.

    ``exported_at`` defaults to the current UTC time in ISO-8601 format.
    Tests pass a fixed value for determinism; production callers leave
    it ``None``.
    """
    ts = exported_at if exported_at is not None else datetime.now(UTC).isoformat()
    case_filename = inputs.case_files[0][0] if inputs.case_files else None
    case_sha256 = (
        hashlib.sha256(inputs.case_files[0][1]).hexdigest()
        if inputs.case_files
        else None
    )
    files: list[str] = []
    for name, _ in inputs.case_files:
        files.append(f"case/{name}")
    if inputs.disturbances:
        files.append("disturbances.json")
    if inputs.sim_params is not None:
        files.append("sim_params.json")
    if inputs.results_csv is not None:
        files.append("results.csv")
    files.append("manifest.json")
    return {
        "andes_version": inputs.andes_version,
        "andes_app_version": inputs.andes_app_version,
        "case_filename": case_filename,
        "case_sha256": case_sha256,
        "case_canonical_export": inputs.case_canonical_export,
        "disturbance_count": len(inputs.disturbances),
        "run_id": inputs.run_id,
        "exported_at": ts,
        "files": files,
    }


def assemble_bundle(inputs: BundleInputs, *, exported_at: str | None = None) -> bytes:
    """Pack ``inputs`` into a deterministic ``.zip`` and return its bytes.

    Determinism: every entry is written with a fixed mtime
    (``2026-01-01 00:00:00``) so two bundles assembled from the same
    inputs produce identical bytes. The ``manifest.exported_at`` field
    is the only timestamp that varies; tests pass a fixed
    ``exported_at`` for byte-equality checks.

    The zip is uncompressed-ish (``ZIP_DEFLATED`` with the lowest
    compression level) — case files and CSVs are typically already
    well-compressed text/binary, and the determinism story is easier
    when we don't have to worry about compression-level drift across
    Python versions.
    """
    manifest = build_manifest(inputs, exported_at=exported_at)
    buf = io.BytesIO()
    fixed_mtime = (2026, 1, 1, 0, 0, 0)
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as zf:
        # Case files first — keeps the most user-visible content at the
        # head of the archive when listed.
        for name, data in inputs.case_files:
            info = zipfile.ZipInfo(filename=f"case/{name}", date_time=fixed_mtime)
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, data)
        if inputs.disturbances:
            info = zipfile.ZipInfo(filename="disturbances.json", date_time=fixed_mtime)
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(
                info,
                json.dumps(list(inputs.disturbances), indent=2, sort_keys=True),
            )
        if inputs.sim_params is not None:
            info = zipfile.ZipInfo(filename="sim_params.json", date_time=fixed_mtime)
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(
                info,
                json.dumps(inputs.sim_params, indent=2, sort_keys=True),
            )
        if inputs.results_csv is not None:
            info = zipfile.ZipInfo(filename="results.csv", date_time=fixed_mtime)
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, inputs.results_csv)
        info = zipfile.ZipInfo(filename="manifest.json", date_time=fixed_mtime)
        info.compress_type = zipfile.ZIP_DEFLATED
        zf.writestr(info, json.dumps(manifest, indent=2, sort_keys=True))
    return buf.getvalue()


def list_bundle_entries(zip_bytes: bytes) -> list[str]:
    """Return the list of entry names in a bundle zip, in archive order.

    Helper used by the integration tests + the ``BundleExportDialog``
    preview. Pure read — the input bytes are not mutated.
    """
    with zipfile.ZipFile(io.BytesIO(zip_bytes), mode="r") as zf:
        return list(zf.namelist())


def read_bundle_manifest(zip_bytes: bytes) -> dict[str, Any]:
    """Parse and return the ``manifest.json`` entry from a bundle zip.

    Raises :class:`KeyError` if no manifest is present (which would
    indicate a corrupted or non-bundle zip).
    """
    with (
        zipfile.ZipFile(io.BytesIO(zip_bytes), mode="r") as zf,
        zf.open("manifest.json", "r") as fh,
    ):
        data = json.loads(fh.read().decode("utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"manifest.json is not a JSON object: {type(data).__name__}")
    return data


# ---- helpers ---------------------------------------------------------------


def case_files_from_workspace(
    primary_path: Path,
    addfiles: list[Path] | None,
) -> tuple[tuple[str, bytes], ...]:
    """Read a case file (and any addfiles) verbatim from the workspace.

    The first tuple element is the primary case file; addfiles follow in
    the order supplied. Each entry is ``(basename, bytes)``. Raises
    :class:`FileNotFoundError` if any file is missing.
    """
    out: list[tuple[str, bytes]] = []
    out.append((primary_path.name, primary_path.read_bytes()))
    for af in addfiles or []:
        out.append((af.name, af.read_bytes()))
    return tuple(out)


__all__ = [
    "BundleInputs",
    "assemble_bundle",
    "build_manifest",
    "case_files_from_workspace",
    "list_bundle_entries",
    "read_bundle_manifest",
]
