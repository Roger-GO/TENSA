"""Snapshot save/load orchestrator (Unit 7 of the v2.0 plan).

Snapshots compose two pieces, per the plan's KTD-4 contract:

- ``<name>.dill`` — ANDES's own ``andes.utils.snapshot.save_ss`` output. The
  dill payload carries the complete ``System`` state (DAE arrays, PF state,
  TDS state when post-TDS). It is **version-locked** to the ANDES version
  that produced it; ANDES exposes no runtime version check, so the substrate
  enforces one (refuses ``load_ss`` on minor-version mismatch and falls
  back to the always-works replay path).
- ``<name>.json`` — sidecar metadata that lives independently of the dill
  blob. Carries the recorded ``_disturbance_log`` (Unit 6.5) plus the
  manifest fields needed for the version check + integrity audit
  (``andes_version``, ``andes_app_version``, ``case_filename``,
  ``case_sha256``, ``saved_at``, ``has_pflow``, ``has_tds``).

The restore flow is two-tier:

1. **Always-works (slow path):** ``wrapper.reload_case`` →
   ``wrapper.replay_disturbances`` (from the JSON's log) →
   ``wrapper._ensure_setup`` + ``wrapper.run_pflow``. Reaches the same
   converged operating point through the same code paths the user
   would walk by hand.
2. **Optimisation (fast path):** if the JSON's ``andes_version`` matches
   the current install AND the dill file exists AND the caller passed
   ``use_dill_optimization=True``, swap in ``andes.utils.snapshot.load_ss``
   to skip the PF re-solve. The disturbance log is still replayed so the
   substrate's in-memory ``_disturbance_log`` stays consistent.

Snapshot directory layout (per plan):

    <workspace>/snapshots/<case_basename>/<name>.{dill,json}

``<case_basename>`` is the loaded case file's stem (e.g., ``ieee14`` for
``ieee14.raw``). Snapshots from different cases never collide. Snapshots
from the same case under the same name DO collide; the orchestrator
enforces a ``force=False`` default with 409-equivalent rejection on collide
(the route layer maps that into HTTP 409).

This module is import-time-cheap (no ANDES import). The expensive bits
(``save_ss`` / ``load_ss``) are gated by the worker-side caller and only
fire when needed.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from andes_app.core.errors import AndesAppError

log = logging.getLogger("andes-app.snapshot")


class SnapshotError(AndesAppError):
    """Base class for snapshot save/load failures.

    Concrete subclasses correspond to substrate-side failure modes the
    routes layer maps to specific HTTP statuses (404 / 409 / 422).
    """


class SnapshotNotFoundError(SnapshotError):
    """Raised when the named snapshot does not exist on disk.

    Routes layer surfaces as HTTP 404. ``list_snapshots`` is the canonical
    way to discover the available names.
    """


class SnapshotCollisionError(SnapshotError):
    """Raised when ``save_snapshot(name, force=False)`` finds an existing
    snapshot under the same name.

    Routes layer surfaces as HTTP 409. The caller can re-issue with
    ``force=True`` to overwrite.
    """


class SnapshotMetadataError(SnapshotError):
    """Raised when the sidecar JSON is missing, malformed, or fails the
    version-stamp check at load time.

    Routes layer surfaces as HTTP 422 with an actionable detail
    (e.g., "snapshot.json refers to ANDES X.Y but install is X.Z;
    falling back to slow restore path").
    """


class SnapshotVersionMismatchError(SnapshotError):
    """Raised when the snapshot's ANDES version differs from the current
    install at minor-version granularity.

    The orchestrator catches this internally during a dill-optimisation
    restore and falls back to the slow path; it leaks to the route layer
    only when the caller forced the dill path explicitly. Surfaces as
    HTTP 422 with the version delta in the detail.
    """


# ---- snapshot metadata ------------------------------------------------------


@dataclass(frozen=True)
class SnapshotMetadata:
    """Sidecar JSON metadata for a snapshot.

    Mirrors the ``<name>.json`` on-disk shape exactly. ``disturbance_log``
    is a list of plain dicts (already ``model_dump()``'d so the metadata
    is JSON-round-trippable without dragging the Pydantic models through
    the worker Pipe).
    """

    andes_version: str
    andes_app_version: str
    case_filename: str | None
    case_sha256: str | None
    disturbance_log: list[dict[str, Any]]
    saved_at: str
    has_pflow: bool
    has_tds: bool

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SnapshotMetadata:
        """Build from a parsed JSON object. Tolerant of missing optional
        fields (defaults to ``None`` / ``False`` / ``[]``); raises
        :class:`SnapshotMetadataError` only when required fields are
        absent or not strings.
        """
        andes_version = data.get("andes_version")
        andes_app_version = data.get("andes_app_version")
        if not isinstance(andes_version, str) or not isinstance(
            andes_app_version, str
        ):
            raise SnapshotMetadataError(
                "snapshot.json missing required string fields "
                "'andes_version' / 'andes_app_version'"
            )
        disturbance_log_raw = data.get("disturbance_log") or []
        if not isinstance(disturbance_log_raw, list):
            raise SnapshotMetadataError(
                "snapshot.json 'disturbance_log' must be a list of dicts"
            )
        disturbance_log = [d for d in disturbance_log_raw if isinstance(d, dict)]
        return cls(
            andes_version=andes_version,
            andes_app_version=andes_app_version,
            case_filename=(
                data.get("case_filename")
                if isinstance(data.get("case_filename"), str)
                else None
            ),
            case_sha256=(
                data.get("case_sha256")
                if isinstance(data.get("case_sha256"), str)
                else None
            ),
            disturbance_log=disturbance_log,
            saved_at=(
                data.get("saved_at")
                if isinstance(data.get("saved_at"), str)
                else ""
            ),
            has_pflow=bool(data.get("has_pflow", False)),
            has_tds=bool(data.get("has_tds", False)),
        )

    def to_dict(self) -> dict[str, Any]:
        """Return the JSON-friendly dict used to write the sidecar."""
        return {
            "andes_version": self.andes_version,
            "andes_app_version": self.andes_app_version,
            "case_filename": self.case_filename,
            "case_sha256": self.case_sha256,
            "disturbance_log": list(self.disturbance_log),
            "saved_at": self.saved_at,
            "has_pflow": self.has_pflow,
            "has_tds": self.has_tds,
        }


@dataclass(frozen=True)
class SnapshotEntry:
    """Listing-API view of a single snapshot on disk.

    The listing endpoint returns one entry per ``<name>.json`` found
    under ``<workspace>/snapshots/<case_basename>/``. ``has_dill``
    reflects whether the dill blob is also present (it should be, but
    a half-deleted snapshot directory shouldn't crash the listing).
    """

    name: str
    saved_at: str
    has_pflow: bool
    has_tds: bool
    has_dill: bool
    andes_version: str
    disturbance_count: int


# ---- name validation --------------------------------------------------------


# Snapshot names must be filesystem-safe (no slashes, no traversal).
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-]{0,63}$")


def validate_snapshot_name(name: str) -> str:
    """Validate a user-supplied snapshot name.

    Allowed: alphanumerics + ``.``, ``_``, ``-``. 1-64 chars. Must not
    start with a dot (avoids hidden files). Returns the name on success;
    raises :class:`SnapshotMetadataError` (mapped to 422) otherwise.

    The regex bans ``/``, ``\\``, ``..``, NUL, and every other path-
    traversal vector; the route layer can therefore concatenate
    ``<workspace>/snapshots/<case>/<name>.dill`` without further checks.
    """
    if not isinstance(name, str) or not _NAME_RE.match(name):
        raise SnapshotMetadataError(
            f"invalid snapshot name {name!r}; "
            "names must be 1-64 chars of [A-Za-z0-9._-] starting with "
            "an alphanumeric"
        )
    return name


# ---- version-stamp check ----------------------------------------------------


def _parse_minor(version: str) -> tuple[int, int] | None:
    """Parse ``"2.0.0"`` → ``(2, 0)``. Returns ``None`` on unrecognised
    shapes so the caller can fall back to a strict-equality check."""
    parts = version.split(".")
    if len(parts) < 2:
        return None
    try:
        return (int(parts[0]), int(parts[1]))
    except ValueError:
        return None


def versions_compatible(saved: str, current: str) -> bool:
    """Return True iff ``saved`` and ``current`` agree at major.minor.

    Falls back to strict-string-equality when either is unparseable
    (e.g., pre-release tags, custom-built ANDES installs). The
    conservative default prevents loading dill payloads across an ANDES
    minor bump where the pickle layout may have shifted under our feet.
    """
    s = _parse_minor(saved)
    c = _parse_minor(current)
    if s is None or c is None:
        return saved == current
    return s == c


# ---- on-disk layout helpers ------------------------------------------------


def _case_basename(case_filename: str | None) -> str:
    """Return the ``<case_basename>`` for the snapshot directory.

    ``ieee14.raw`` → ``ieee14``. ``None`` (blank session) → ``__blank__``
    so blank-session snapshots are bucketed separately and don't collide
    with case-loaded sessions.
    """
    if not case_filename:
        return "__blank__"
    stem = Path(case_filename).stem
    # Defence in depth — even if the case_filename smuggled in a slash,
    # the stem is just the last component sans extension.
    return stem if stem else "__blank__"


def snapshot_dir(workspace: Path, case_filename: str | None) -> Path:
    """Build (and create on demand) the per-case snapshot directory.

    Layout: ``<workspace>/snapshots/<case_basename>/``. The ``snapshots``
    parent is created with mode 0o700 to match the workspace ACL the
    CLI installs.
    """
    target = workspace / "snapshots" / _case_basename(case_filename)
    target.mkdir(parents=True, exist_ok=True)
    return target


def snapshot_paths(
    workspace: Path, case_filename: str | None, name: str
) -> tuple[Path, Path]:
    """Return ``(dill_path, json_path)`` for a given snapshot name.

    Does NOT create the directory; ``snapshot_dir`` does that on the save
    path. Listing / load just need the resolved paths to read.
    """
    base = workspace / "snapshots" / _case_basename(case_filename)
    return (base / f"{name}.dill", base / f"{name}.json")


# ---- save / restore / list / delete ----------------------------------------


@dataclass
class SaveSnapshotResult:
    """Return shape of :func:`save_snapshot`."""

    name: str
    metadata: SnapshotMetadata
    dill_bytes: int
    metadata_bytes: int


def write_snapshot_files(
    *,
    dill_path: Path,
    json_path: Path,
    dill_writer: Any,  # callable: (path: str) -> None — andes.utils.snapshot.save_ss
    metadata: SnapshotMetadata,
) -> tuple[int, int]:
    """Write the dill blob + sidecar JSON atomically (writer first, then
    JSON; the JSON's existence is what the listing endpoint keys on).

    ``dill_writer`` is injected to keep this module ANDES-free at import
    time. The wrapper passes ``andes.utils.snapshot.save_ss`` bound to
    the live System.

    Returns ``(dill_bytes, metadata_bytes)`` for the route layer's
    response.
    """
    # Write dill first; on failure the sidecar JSON never lands and the
    # listing won't surface a half-saved snapshot.
    dill_writer(str(dill_path))
    dill_bytes = dill_path.stat().st_size if dill_path.exists() else 0

    json_payload = json.dumps(metadata.to_dict(), indent=2, sort_keys=True)
    json_path.write_text(json_payload, encoding="utf-8")
    metadata_bytes = json_path.stat().st_size
    return dill_bytes, metadata_bytes


def read_snapshot_metadata(json_path: Path) -> SnapshotMetadata:
    """Parse the sidecar JSON. Raises :class:`SnapshotNotFoundError` if
    the file is missing, :class:`SnapshotMetadataError` on parse errors.
    """
    if not json_path.exists():
        raise SnapshotNotFoundError(
            f"snapshot metadata not found at {json_path.name}"
        )
    try:
        raw = json.loads(json_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SnapshotMetadataError(
            f"snapshot metadata is unreadable: {exc}"
        ) from exc
    if not isinstance(raw, dict):
        raise SnapshotMetadataError(
            f"snapshot metadata is not a JSON object: {type(raw).__name__}"
        )
    return SnapshotMetadata.from_dict(raw)


def list_snapshots_on_disk(
    workspace: Path, case_filename: str | None
) -> list[SnapshotEntry]:
    """Enumerate snapshots for the given case under ``workspace``.

    Returns an empty list when the directory doesn't exist (no snapshots
    have ever been saved against this case). Skips JSON files that fail
    to parse, logging a warning — a half-corrupt snapshot shouldn't
    block the listing of intact ones.
    """
    base = workspace / "snapshots" / _case_basename(case_filename)
    if not base.exists():
        return []
    entries: list[SnapshotEntry] = []
    for json_path in sorted(base.glob("*.json")):
        try:
            meta = read_snapshot_metadata(json_path)
        except SnapshotError as exc:
            log.warning(
                "snapshot listing skipping %s: %s", json_path.name, exc
            )
            continue
        dill_path = json_path.with_suffix(".dill")
        entries.append(
            SnapshotEntry(
                name=json_path.stem,
                saved_at=meta.saved_at,
                has_pflow=meta.has_pflow,
                has_tds=meta.has_tds,
                has_dill=dill_path.exists(),
                andes_version=meta.andes_version,
                disturbance_count=len(meta.disturbance_log),
            )
        )
    return entries


def delete_snapshot_files(
    workspace: Path, case_filename: str | None, name: str
) -> bool:
    """Delete a snapshot's dill + JSON files. Returns True if at least
    one file was removed; False if both were already absent (idempotent
    delete). Raises :class:`SnapshotNotFoundError` if NEITHER file
    exists — the routes layer maps that to 404.
    """
    validate_snapshot_name(name)
    dill_path, json_path = snapshot_paths(workspace, case_filename, name)
    removed = False
    for p in (dill_path, json_path):
        if p.exists():
            p.unlink()
            removed = True
    if not removed:
        raise SnapshotNotFoundError(
            f"snapshot {name!r} not found"
        )
    return removed


@dataclass
class RestoreSnapshotResult:
    """Return shape of :func:`restore_snapshot`.

    Tells the route layer (and the UI via the response body) which restore
    path was actually taken — the fast dill path or the slow replay path —
    so the success toast can call out the version-mismatch fallback.
    """

    used_dill: bool
    metadata: SnapshotMetadata
    fallback_reason: str | None = None
    disturbances_replayed: int = 0


# Defensive cap on disturbance log size in metadata. Far above any realistic
# session; prevents a corrupted JSON from triggering an unbounded replay.
DISTURBANCE_LOG_CAP = 1000


__all__ = [
    "DISTURBANCE_LOG_CAP",
    "RestoreSnapshotResult",
    "SaveSnapshotResult",
    "SnapshotCollisionError",
    "SnapshotEntry",
    "SnapshotError",
    "SnapshotMetadata",
    "SnapshotMetadataError",
    "SnapshotNotFoundError",
    "SnapshotVersionMismatchError",
    "delete_snapshot_files",
    "list_snapshots_on_disk",
    "read_snapshot_metadata",
    "snapshot_dir",
    "snapshot_paths",
    "validate_snapshot_name",
    "versions_compatible",
    "write_snapshot_files",
]
