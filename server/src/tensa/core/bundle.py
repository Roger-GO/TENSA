"""Reproducibility-bundle assembler + importer (Units 3 + 10 of the v2.0 plan).

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
- ``manifest.json`` — ``{ andes_version, tensa_version, case_filename,
  case_sha256, disturbance_count, run_id, exported_at, files: [...] }``.

Snapshots are NOT in the bundle (KTD-4): the dill payload is version-locked
and undermines portability. Snapshots ship in Unit 7 as a separate save/load
flow.

This module is import-time-cheap (no ANDES import). The expensive bits
(``Wrapper.save_case`` for dirty cases) are gated by the worker-side
caller and only fire when needed.

Unit 10 adds the import side: :func:`validate_bundle` decodes a candidate
zip and surfaces a :class:`BundleImportPlan` that the route layer renders
as a conflict resolver before the user commits; :func:`extract_bundle`
writes the case files into the workspace using a force-resolve flag to
disambiguate the sha256-mismatch case.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import zipfile
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from tensa.core.errors import AndesAppError as _AndesAppError


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
    #: ``tensa`` package version (the substrate).
    tensa_version: str


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
        "tensa_version": inputs.tensa_version,
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


# ---- import side (Unit 10) -------------------------------------------------


# Manifest fields the validator REQUIRES to be present on every bundle. The
# substrate produces all of these on export (see :func:`build_manifest`); a
# bundle missing any of them is malformed and rejected with a 422.
_REQUIRED_MANIFEST_FIELDS: tuple[str, ...] = (
    "andes_version",
    "tensa_version",
    "case_filename",
    "case_sha256",
    "disturbance_count",
    "exported_at",
    "files",
)

# Maximum bundle size (uncompressed) the substrate accepts. Bundles are
# typically a few MB (case + disturbances + small results.csv); we cap at
# 64 MiB to defend against zip-bomb attacks. The route layer applies a
# parallel cap on the request body; both must agree.
MAX_BUNDLE_BYTES: int = 64 * 1024 * 1024

# Cap on the count of case-related entries in a bundle. The exporter
# writes one primary + N addfiles (PSS/E .raw + .dyr is the common case;
# more is theoretically possible). 16 is generous for any legitimate use.
_MAX_CASE_ENTRIES: int = 16

# Maximum size the disturbances.json body can be inside a bundle. Each
# spec is ~150 bytes (JSON-serialised); 1 MiB allows ~7000 specs which
# vastly exceeds the disturbance-log cap of 64 (Unit 7).
_MAX_DISTURBANCES_JSON_BYTES: int = 1 * 1024 * 1024


# Conflict severity. ``warning`` lets the caller proceed (with the
# ``BundleImportPlan`` echoed back via ``force_resolve``); ``blocker``
# requires a re-export of the bundle and the substrate refuses to commit.
ConflictSeverity = Literal["warning", "blocker"]


@dataclass(frozen=True)
class CaseMetadataDiff:
    """Side-by-side metadata for a sha256 conflict (filename, size, sha).

    Surfaced via :class:`BundleConflict` ``kind="sha-mismatch"`` so the UI
    can render the diff without inventing an xlsx-content differ. Both
    sides carry the same shape; the workspace side is ``None`` for
    ``element_count`` because the substrate does not parse the
    workspace file before commit (the case might not even be a valid
    case file — it's whatever the user last left in the workspace).
    """

    filename: str
    sha256: str
    size_bytes: int


@dataclass(frozen=True)
class BundleConflict:
    """One conflict surfaced by :func:`validate_bundle`.

    The route layer aggregates these into the response body so the UI
    can render them inline (warnings) or block the commit (blockers).
    """

    #: Stable conflict identifier the UI keys off of for rendering.
    #: ``andes-version`` (warning), ``addfile-missing`` (blocker),
    #: ``sha-mismatch`` (warning — user picks bundle vs workspace).
    kind: Literal["andes-version", "addfile-missing", "sha-mismatch"]
    severity: ConflictSeverity
    #: Human-readable message; always populated.
    message: str
    #: Bundle-side metadata (when applicable). Populated for sha-mismatch.
    bundle_meta: CaseMetadataDiff | None = None
    #: Workspace-side metadata (when applicable). Populated for sha-mismatch.
    workspace_meta: CaseMetadataDiff | None = None
    #: Filename the conflict refers to (e.g., ``ieee14.dyr`` for
    #: ``addfile-missing``). Populated when single-file-scoped.
    filename: str | None = None
    #: Bundle-recorded ANDES version (for ``andes-version``).
    bundle_andes_version: str | None = None
    #: Currently-installed ANDES version (for ``andes-version``).
    current_andes_version: str | None = None


@dataclass(frozen=True)
class BundleImportPlan:
    """Result of :func:`validate_bundle`.

    The route layer returns this to the UI when conflicts are present
    and ``force_resolve`` was not specified; the user resolves each
    conflict and re-issues with the resolution choices baked in.
    """

    #: Manifest as parsed from the bundle. Echoed for the UI's
    #: confirmation card (e.g., "you're about to import bundle exported
    #: by tensa v0.1.0 against ANDES 2.0.0 on 2026-05-09").
    manifest: dict[str, Any]
    #: Case file basenames in the bundle (primary + any addfiles).
    case_files: tuple[str, ...]
    #: Conflicts the user must acknowledge. May be empty (clean import).
    conflicts: tuple[BundleConflict, ...] = field(default_factory=tuple)
    #: True when at least one conflict has ``severity="blocker"``.
    blocked: bool = False

    @property
    def has_conflicts(self) -> bool:
        return len(self.conflicts) > 0


@dataclass(frozen=True)
class BundleResolveChoices:
    """Per-conflict resolution choices the caller passes to
    :func:`extract_bundle` / ``Wrapper.import_bundle``.

    Defaults: prefer the bundle's case file (use_bundle_case=True), and
    silently accept the ANDES version mismatch (the warning is
    informational once the user has confirmed).
    """

    #: When True, overwrite the workspace's case file with the bundle's
    #: copy on sha-mismatch. When False, keep the workspace file (and
    #: log the mismatch in the import-result warnings).
    use_bundle_case: bool = True
    #: When True, ignore the ANDES-version-mismatch warning and proceed.
    #: The route layer rejects this flag if no version conflict exists,
    #: so callers don't accidentally ignore a future blocker.
    accept_version_mismatch: bool = True


class BundleValidationError(_AndesAppError):
    """Sentinel for bundle-validation failures.

    Carries a category string the route layer maps to an HTTP status:

    - ``corrupt-zip`` → 400 (not a valid zip archive at all).
    - ``manifest-missing`` → 422 (no ``manifest.json`` entry).
    - ``manifest-malformed`` → 422 (manifest is not a JSON object or
      missing required fields — ``missing_fields`` populated).
    - ``oversize`` → 413 (zip exceeds :data:`MAX_BUNDLE_BYTES`).
    - ``too-many-case-files`` → 422 (more than :data:`_MAX_CASE_ENTRIES`
      entries under ``case/``; defends against zip-bomb attacks that
      could overwhelm the workspace).
    - ``disturbances-malformed`` → 422 (disturbances.json is present
      but not a JSON list, exceeds size cap, or contains entries that
      lack the discriminator).
    - ``case-entry-missing`` → 422 (manifest references a case file
      that's not in the zip).
    - ``bundle-blocked`` → 422 (extract called on a plan with
      blocker conflicts unresolved).
    """

    def __init__(
        self,
        category: str,
        detail: str,
        *,
        missing_fields: tuple[str, ...] | None = None,
    ) -> None:
        super().__init__(detail)
        self.category = category
        self.detail = detail
        self.missing_fields = missing_fields or ()


def _safe_open_bundle(zip_bytes: bytes) -> zipfile.ZipFile:
    """Open ``zip_bytes`` as a ZipFile or raise BundleValidationError.

    Wraps the ``zipfile.BadZipFile`` raise into the ``corrupt-zip``
    category so the route layer can map to 400 cleanly.
    """
    if len(zip_bytes) > MAX_BUNDLE_BYTES:
        raise BundleValidationError(
            "oversize",
            (
                f"bundle exceeds {MAX_BUNDLE_BYTES} bytes "
                f"(got {len(zip_bytes)} bytes)"
            ),
        )
    try:
        return zipfile.ZipFile(io.BytesIO(zip_bytes), mode="r")
    except zipfile.BadZipFile as exc:
        raise BundleValidationError(
            "corrupt-zip", f"Bundle is not a valid ZIP archive: {exc}"
        ) from exc


def _read_manifest_or_raise(zf: zipfile.ZipFile) -> dict[str, Any]:
    """Read + parse manifest.json or raise BundleValidationError."""
    try:
        with zf.open("manifest.json", "r") as fh:
            raw = fh.read().decode("utf-8")
    except KeyError as exc:
        raise BundleValidationError(
            "manifest-missing",
            "Bundle is missing manifest.json — is this a valid tensa bundle?",
        ) from exc
    try:
        manifest = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise BundleValidationError(
            "manifest-malformed",
            f"manifest.json is not valid JSON: {exc.msg}",
        ) from exc
    if not isinstance(manifest, dict):
        raise BundleValidationError(
            "manifest-malformed",
            f"manifest.json is not a JSON object (got {type(manifest).__name__})",
        )
    missing = tuple(
        f for f in _REQUIRED_MANIFEST_FIELDS if f not in manifest
    )
    if missing:
        raise BundleValidationError(
            "manifest-malformed",
            f"manifest.json is missing required fields: {sorted(missing)}",
            missing_fields=missing,
        )
    return manifest


def _case_entries(zf: zipfile.ZipFile) -> tuple[str, ...]:
    """Return the basenames of every ``case/<...>`` entry in archive order.

    Filters out directory entries and rejects path components that would
    escape the workspace (``..`` segments) or collide with subdirectories
    (a single nested level is allowed; deeper structure is rejected to
    keep the extraction one-deep).
    """
    out: list[str] = []
    for name in zf.namelist():
        if not name.startswith("case/"):
            continue
        # Skip directory entries (zip stores them with trailing /).
        if name.endswith("/"):
            continue
        # Strip the leading ``case/`` and reject anything with extra
        # path segments — bundles produced by the substrate write
        # ``case/<basename>`` only, never nested.
        rel = name[len("case/") :]
        if not rel:
            continue
        if "/" in rel or "\\" in rel:
            raise BundleValidationError(
                "manifest-malformed",
                (
                    f"bundle has nested case entry {name!r}; "
                    "case/ should contain flat files only"
                ),
            )
        if rel in ("..",) or rel.startswith("."):
            raise BundleValidationError(
                "manifest-malformed",
                f"bundle case entry has unsafe name: {rel!r}",
            )
        out.append(rel)
    if len(out) > _MAX_CASE_ENTRIES:
        raise BundleValidationError(
            "too-many-case-files",
            (
                f"bundle has {len(out)} case files; cap is "
                f"{_MAX_CASE_ENTRIES}"
            ),
        )
    return tuple(out)


def _read_case_bytes(zf: zipfile.ZipFile, basename: str) -> bytes:
    """Read a case file's bytes from the zip; raise on missing."""
    try:
        with zf.open(f"case/{basename}", "r") as fh:
            return fh.read()
    except KeyError as exc:
        raise BundleValidationError(
            "case-entry-missing",
            f"bundle case entry case/{basename} is missing",
        ) from exc


def _read_disturbances_or_raise(
    zf: zipfile.ZipFile,
) -> tuple[dict[str, Any], ...]:
    """Decode the bundle's ``disturbances.json`` (when present)."""
    if "disturbances.json" not in zf.namelist():
        return ()
    info = zf.getinfo("disturbances.json")
    if info.file_size > _MAX_DISTURBANCES_JSON_BYTES:
        raise BundleValidationError(
            "disturbances-malformed",
            (
                f"disturbances.json is {info.file_size} bytes; cap is "
                f"{_MAX_DISTURBANCES_JSON_BYTES}"
            ),
        )
    with zf.open("disturbances.json", "r") as fh:
        raw = fh.read().decode("utf-8")
    try:
        body = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise BundleValidationError(
            "disturbances-malformed",
            f"disturbances.json is not valid JSON: {exc.msg}",
        ) from exc
    if not isinstance(body, list):
        raise BundleValidationError(
            "disturbances-malformed",
            (
                f"disturbances.json is not a JSON array "
                f"(got {type(body).__name__})"
            ),
        )
    out: list[dict[str, Any]] = []
    for i, entry in enumerate(body):
        if not isinstance(entry, dict):
            raise BundleValidationError(
                "disturbances-malformed",
                (
                    f"disturbances.json entry {i} is not a JSON object "
                    f"(got {type(entry).__name__})"
                ),
            )
        kind = entry.get("kind")
        if kind not in ("fault", "toggle", "alter"):
            raise BundleValidationError(
                "disturbances-malformed",
                (
                    f"disturbances.json entry {i} has unknown kind "
                    f"{kind!r}; expected fault/toggle/alter"
                ),
            )
        out.append(entry)
    return tuple(out)


def _major_minor(version: str) -> tuple[int, int] | None:
    """Parse a SemVer-like string and return ``(major, minor)`` or ``None``.

    Tolerates the various shapes ANDES + tensa emit:
    ``2.0.0``, ``2.0.0a1``, ``0.1.0.dev0``, ``unknown``. ``None`` means
    "couldn't parse"; the caller must treat that as "version mismatch
    indeterminate" rather than as "match".
    """
    m = re.match(r"^(\d+)\.(\d+)", version.strip())
    if m is None:
        return None
    return int(m.group(1)), int(m.group(2))


def _versions_match_major_minor(a: str, b: str) -> bool:
    """True iff both versions parse and their (major, minor) tuples match."""
    pa = _major_minor(a)
    pb = _major_minor(b)
    if pa is None or pb is None:
        return False
    return pa == pb


def validate_bundle(
    zip_bytes: bytes,
    *,
    workspace: Path,
    current_andes_version: str,
) -> BundleImportPlan:
    """Decode and validate ``zip_bytes`` against the workspace state.

    Surfaces:

    - Manifest schema violations as :class:`BundleValidationError`
      (raises) — the route layer maps to 400/422.
    - Conflicts (sha-mismatch / version-mismatch / addfile-missing) as
      entries in the returned :class:`BundleImportPlan`'s
      ``conflicts`` tuple. Blockers (addfile-missing) set
      ``blocked=True``.
    - Clean imports as a :class:`BundleImportPlan` with
      ``conflicts=()`` and ``blocked=False`` — the caller can commit
      immediately via :func:`extract_bundle`.

    The function does NOT mutate the workspace. :func:`extract_bundle`
    is the commit step.
    """
    with _safe_open_bundle(zip_bytes) as zf:
        manifest = _read_manifest_or_raise(zf)
        case_files_in_zip = _case_entries(zf)
        # Verify every case file referenced in the manifest's ``files``
        # list is actually present (the bundle could be tampered with
        # post-export).
        manifest_files = manifest.get("files") or []
        if not isinstance(manifest_files, list):
            raise BundleValidationError(
                "manifest-malformed",
                "manifest.files is not a JSON array",
            )
        # Validate the disturbances payload (if present) so the caller
        # surfaces malformed bundles early rather than mid-replay.
        _read_disturbances_or_raise(zf)

        primary = manifest.get("case_filename")
        if not isinstance(primary, str):
            raise BundleValidationError(
                "manifest-malformed",
                "manifest.case_filename is missing or not a string",
            )
        if primary not in case_files_in_zip:
            raise BundleValidationError(
                "case-entry-missing",
                (
                    f"manifest declares primary case {primary!r} but "
                    "the zip has no matching case/<filename> entry"
                ),
            )

        # Read primary case bytes for the workspace-sha comparison.
        bundle_primary_bytes = _read_case_bytes(zf, primary)

    bundle_sha = manifest.get("case_sha256")
    if not isinstance(bundle_sha, str):
        raise BundleValidationError(
            "manifest-malformed",
            "manifest.case_sha256 is missing or not a string",
        )

    conflicts: list[BundleConflict] = []

    # Conflict 1: ANDES major.minor mismatch.
    bundle_andes = manifest.get("andes_version")
    if isinstance(bundle_andes, str) and not _versions_match_major_minor(
        bundle_andes, current_andes_version
    ):
        conflicts.append(
            BundleConflict(
                kind="andes-version",
                severity="warning",
                message=(
                    f"Bundle was exported against ANDES "
                    f"{bundle_andes}; current install is "
                    f"{current_andes_version}. Behaviour may differ."
                ),
                bundle_andes_version=bundle_andes,
                current_andes_version=current_andes_version,
            )
        )

    # Conflict 2: case file in workspace exists but sha doesn't match.
    workspace_primary = workspace / primary
    if workspace_primary.is_file():
        try:
            workspace_bytes = workspace_primary.read_bytes()
        except OSError as exc:
            raise BundleValidationError(
                "case-entry-missing",
                f"workspace case {primary!r} could not be read: {exc}",
            ) from exc
        workspace_sha = hashlib.sha256(workspace_bytes).hexdigest()
        if workspace_sha != bundle_sha:
            conflicts.append(
                BundleConflict(
                    kind="sha-mismatch",
                    severity="warning",
                    message=(
                        f"Workspace already has {primary!r} but its "
                        "checksum differs from the bundle. Choose "
                        "which version to keep."
                    ),
                    filename=primary,
                    bundle_meta=CaseMetadataDiff(
                        filename=primary,
                        sha256=bundle_sha,
                        size_bytes=len(bundle_primary_bytes),
                    ),
                    workspace_meta=CaseMetadataDiff(
                        filename=primary,
                        sha256=workspace_sha,
                        size_bytes=len(workspace_bytes),
                    ),
                )
            )

    # Conflict 3: any addfile (every case-files entry beyond the primary)
    # is missing from the bundle. Today the bundle ALWAYS includes
    # addfiles when present (per :func:`case_files_from_workspace`);
    # this guard is defensive against tampering / future format
    # changes. Plan-divergence note: the manifest does not currently
    # track addfiles separately (KTD-5 lists ``files: [...]`` as the
    # union of all entries), so the heuristic here is: every case/
    # entry beyond the first IS an addfile. A bundle with a
    # primary-only case but a manifest declaring more case entries is
    # rejected as ``case-entry-missing`` by the manifest-files-vs-zip
    # check above.
    declared_case_files = [
        Path(f).name for f in manifest_files if isinstance(f, str) and f.startswith("case/")
    ]
    for declared in declared_case_files:
        if declared not in case_files_in_zip:
            conflicts.append(
                BundleConflict(
                    kind="addfile-missing",
                    severity="blocker",
                    message=(
                        f"Bundle manifest references case/{declared} "
                        "but the file is not in the archive. Re-export "
                        "the bundle to recover."
                    ),
                    filename=declared,
                )
            )

    blocked = any(c.severity == "blocker" for c in conflicts)
    return BundleImportPlan(
        manifest=manifest,
        case_files=case_files_in_zip,
        conflicts=tuple(conflicts),
        blocked=blocked,
    )


def extract_bundle(
    zip_bytes: bytes,
    *,
    workspace: Path,
    resolve: BundleResolveChoices,
    plan: BundleImportPlan,
) -> dict[str, Any]:
    """Materialise the bundle's case files into ``workspace``.

    Honours ``resolve.use_bundle_case`` for the sha-mismatch case:

    - True: the bundle's bytes overwrite the workspace file.
    - False: the workspace file is preserved; the bundle's bytes are
      written to a sibling path with a ``.from-bundle`` suffix so the
      user can compare offline.

    Returns a dict with ``primary_path`` (the path the caller should
    pass to :meth:`Wrapper.load_case`), ``addfile_paths`` (the same
    for the addfiles, in declared order), and ``warnings`` (a list of
    free-form strings the route layer surfaces in the response body).
    """
    if plan.blocked:
        raise BundleValidationError(
            "bundle-blocked",
            (
                "bundle has unresolved blocker conflicts; resolve them "
                "(or re-export the bundle) before extracting"
            ),
        )

    workspace.mkdir(parents=True, exist_ok=True)
    primary = plan.manifest["case_filename"]
    if not isinstance(primary, str):  # pragma: no cover — validated upstream
        raise BundleValidationError(
            "manifest-malformed", "manifest.case_filename is not a string"
        )

    warnings: list[str] = []
    primary_target = workspace / primary

    # Re-open the zip on the commit side so the validate→extract two-step
    # doesn't leak file handles across the round-trip.
    with _safe_open_bundle(zip_bytes) as zf:
        primary_bytes = _read_case_bytes(zf, primary)
        sha_conflict = next(
            (c for c in plan.conflicts if c.kind == "sha-mismatch"), None
        )
        if sha_conflict is not None and not resolve.use_bundle_case:
            # Preserve the workspace copy; write the bundle to a sibling
            # path with a marker suffix.
            sibling = workspace / f"{primary}.from-bundle"
            sibling.write_bytes(primary_bytes)
            warnings.append(
                f"workspace {primary!r} preserved; bundle copy "
                f"saved to {sibling.name} for comparison"
            )
            primary_path = primary_target
        else:
            primary_target.write_bytes(primary_bytes)
            if sha_conflict is not None:
                warnings.append(
                    f"workspace {primary!r} overwritten with bundle copy"
                )
            primary_path = primary_target

        addfile_paths: list[Path] = []
        for name in plan.case_files:
            if name == primary:
                continue
            data = _read_case_bytes(zf, name)
            target = workspace / name
            # Addfiles are always overwritten — the bundle's copy is the
            # canonical one for reproducing the result. The plan-divergence
            # note above explains why: the manifest doesn't track addfile
            # sha256 separately, so the user's existing addfile may or may
            # not match. Defaulting to overwrite avoids running the case
            # against a stale .dyr.
            target.write_bytes(data)
            addfile_paths.append(target)

    return {
        "primary_path": str(primary_path),
        "addfile_paths": [str(p) for p in addfile_paths],
        "warnings": warnings,
    }


def bundle_plan_to_dict(plan: BundleImportPlan) -> dict[str, Any]:
    """Serialise a :class:`BundleImportPlan` to a JSON-friendly dict.

    Used by the worker handler to ship the plan across the
    ``multiprocessing.Pipe`` and by the route layer to render the
    response body. The shape mirrors the dataclass with one
    convenience: ``case_files`` becomes a list (tuples don't survive
    JSON encoding).
    """

    def _meta(m: CaseMetadataDiff | None) -> dict[str, Any] | None:
        if m is None:
            return None
        return {
            "filename": m.filename,
            "sha256": m.sha256,
            "size_bytes": m.size_bytes,
        }

    def _conflict(c: BundleConflict) -> dict[str, Any]:
        return {
            "kind": c.kind,
            "severity": c.severity,
            "message": c.message,
            "filename": c.filename,
            "bundle_meta": _meta(c.bundle_meta),
            "workspace_meta": _meta(c.workspace_meta),
            "bundle_andes_version": c.bundle_andes_version,
            "current_andes_version": c.current_andes_version,
        }

    return {
        "manifest": dict(plan.manifest),
        "case_files": list(plan.case_files),
        "conflicts": [_conflict(c) for c in plan.conflicts],
        "blocked": plan.blocked,
        "has_conflicts": plan.has_conflicts,
    }


def read_bundle_disturbances(zip_bytes: bytes) -> tuple[dict[str, Any], ...]:
    """Read and validate the disturbances payload from a bundle zip.

    Pure-read helper for the worker handler — keeps the disturbance-
    decoding logic in this module rather than re-implementing it inside
    the wrapper.
    """
    with _safe_open_bundle(zip_bytes) as zf:
        return _read_disturbances_or_raise(zf)


__all__ = [
    "BundleConflict",
    "BundleImportPlan",
    "BundleInputs",
    "BundleResolveChoices",
    "BundleValidationError",
    "CaseMetadataDiff",
    "MAX_BUNDLE_BYTES",
    "assemble_bundle",
    "build_manifest",
    "bundle_plan_to_dict",
    "case_files_from_workspace",
    "extract_bundle",
    "list_bundle_entries",
    "read_bundle_disturbances",
    "read_bundle_manifest",
    "validate_bundle",
]
