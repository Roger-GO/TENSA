"""Snapshots."""

from __future__ import annotations

import contextlib
import hashlib
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from tensa.core.case_events import event_from_spec
from tensa.core.disturbance import AlterSpec, DisturbanceSpec, FaultSpec, ToggleSpec
from tensa.core.errors import NoCaseLoadedError, SetupFailedError
from tensa.core.wrapper.base import _sanitize_message
from tensa.core.wrapper.case import CaseMixin

if TYPE_CHECKING:
    from tensa.core.snapshot import SnapshotMetadata


class SnapshotMixin(CaseMixin):
    """Save, restore, list and delete snapshots of a session."""

    def save_snapshot(
        self, name: str, *, force: bool = False, include_dill: bool = False
    ) -> dict[str, Any]:
        """Save the current System state as a snapshot — Unit 7.

        Composes up to two artefacts on disk:

        - ``<name>.json`` — sidecar metadata: ANDES + tensa versions,
          case filename + sha256, recorded ``_disturbance_log``,
          ``has_pflow`` / ``has_tds`` flags. The disturbance log is the
          default restore path's source of truth (Unit 6.5).
        - ``<name>.dill`` — ANDES's ``andes.utils.snapshot.save_ss`` blob,
          only when ``include_dill=True``. Carries the complete System
          state (DAE arrays, PF / TDS state) for the opt-in dill restore.
          Version-locked to the current ANDES install, and costly: a couple
          of seconds and 2-3 MB per save, which is why it is not written
          by default.

        ``force=False`` (default) refuses to overwrite an existing
        snapshot under the same name, raising
        :class:`SnapshotCollisionError` (mapped to HTTP 409 by the route
        layer). ``force=True`` overwrites silently, and drops the dill blob
        of the snapshot it replaces when ``include_dill`` is false.
        """
        from tensa import __version__ as tensa_version
        from tensa.core.snapshot import (
            SnapshotCollisionError,
            SnapshotMetadata,
            snapshot_dir,
            snapshot_paths,
            validate_snapshot_name,
            write_snapshot_files,
        )

        ss = self._require_loaded()
        if self._workspace is None:
            raise NoCaseLoadedError(
                "snapshot save requires a workspace; the substrate "
                "was launched without one"
            )
        validated = validate_snapshot_name(name)

        case_filename = (
            self._case_path.name if self._case_path is not None else None
        )
        # Ensure the directory exists before the snapshot files are written.
        snapshot_dir(self._workspace, case_filename)
        dill_path, json_path = snapshot_paths(
            self._workspace, case_filename, validated
        )
        if not force and (dill_path.exists() or json_path.exists()):
            raise SnapshotCollisionError(
                f"snapshot {validated!r} already exists; pass force=true "
                "to overwrite or pick a different name"
            )

        # Compute case sha256 for the metadata's integrity audit.
        case_sha256: str | None = None
        if self._case_path is not None and self._case_path.exists():
            try:
                case_sha256 = hashlib.sha256(
                    self._case_path.read_bytes()
                ).hexdigest()
            except OSError:
                # Best-effort — a missing-but-was-loaded case can still be
                # snapshotted from the in-memory System; the integrity
                # audit just won't have a hash to compare against.
                case_sha256 = None

        # Capture state flags BEFORE any save runs so we record the System's
        # current truth, not whatever side effect the save touches.
        has_pflow = bool(getattr(ss.PFlow, "converged", False))
        tds = getattr(ss, "TDS", None)
        has_tds = bool(getattr(tds, "initialized", False))

        import andes

        andes_version = str(getattr(andes, "__version__", "unknown"))

        dill_writer: Callable[[str], None] | None = None
        if include_dill:
            # ANDES's save_ss is dill-based; lazy-import keeps the wrapper's
            # own import cost paid only by callers that ask for the blob.
            from andes.utils.snapshot import save_ss

            def _save_dill(path: str) -> None:
                save_ss(path, ss)

            dill_writer = _save_dill

        try:
            saved_at = datetime.now(UTC).isoformat()
            metadata = SnapshotMetadata(
                andes_version=andes_version,
                tensa_version=str(tensa_version),
                case_filename=case_filename,
                case_sha256=case_sha256,
                disturbance_log=[
                    spec.model_dump() for spec in self._disturbance_log
                ],
                saved_at=saved_at,
                has_pflow=has_pflow,
                has_tds=has_tds,
            )

            dill_bytes, json_bytes = write_snapshot_files(
                dill_path=dill_path,
                json_path=json_path,
                dill_writer=dill_writer,
                metadata=metadata,
            )
        except SnapshotCollisionError:
            raise
        except Exception as exc:  # noqa: BLE001
            # Best-effort cleanup so a half-written snapshot doesn't get
            # surfaced by the listing endpoint.
            for p in (dill_path, json_path):
                with contextlib.suppress(OSError):
                    if p.exists():
                        p.unlink()
            raise SetupFailedError(
                f"snapshot save failed: {_sanitize_message(str(exc))}"
            ) from exc

        return {
            "name": validated,
            "metadata": metadata.to_dict(),
            "dill_bytes": dill_bytes,
            "metadata_bytes": json_bytes,
        }

    def _read_snapshot_record(self, name: str) -> _SnapshotRecord:
        """Read a snapshot's sidecar JSON without touching the System.

        Validates the name, locates the files under the loaded case's snapshot
        directory, bounds the disturbance log and rebuilds its specs through the
        discriminated union so ``add_disturbance`` accepts them. Raises
        :class:`SnapshotNotFoundError` / :class:`SnapshotMetadataError` as
        :meth:`restore_snapshot` documents.
        """
        from tensa.core.snapshot import (
            DISTURBANCE_LOG_CAP,
            SnapshotMetadataError,
            read_snapshot_metadata,
            snapshot_paths,
            validate_existing_snapshot_name,
        )

        if self._workspace is None:
            raise NoCaseLoadedError(
                "snapshot restore requires a workspace; the substrate "
                "was launched without one"
            )
        validated = validate_existing_snapshot_name(name)
        if self._ss is None and self._case_path is None:
            raise NoCaseLoadedError(
                "snapshot restore requires a loaded case to scope the "
                "snapshot directory; load a case first"
            )

        case_filename = (
            self._case_path.name if self._case_path is not None else None
        )
        dill_path, json_path = snapshot_paths(
            self._workspace, case_filename, validated
        )
        metadata = read_snapshot_metadata(json_path)
        if len(metadata.disturbance_log) > DISTURBANCE_LOG_CAP:
            raise SnapshotMetadataError(
                f"snapshot {validated!r} has "
                f"{len(metadata.disturbance_log)} disturbances; cap is "
                f"{DISTURBANCE_LOG_CAP}"
            )

        def _spec_from_dict(d: dict[str, Any]) -> DisturbanceSpec:
            kind = d.get("kind")
            if kind == "fault":
                return FaultSpec(**d)
            if kind == "toggle":
                return ToggleSpec(**d)
            if kind == "alter":
                return AlterSpec(**d)
            raise SnapshotMetadataError(
                f"snapshot disturbance has unknown kind: {kind!r}"
            )

        return _SnapshotRecord(
            name=validated,
            dill_path=dill_path,
            metadata=metadata,
            specs=[_spec_from_dict(raw) for raw in metadata.disturbance_log],
        )

    def restore_snapshot(
        self, name: str, *, use_dill_optimization: bool = False
    ) -> dict[str, Any]:
        """Restore a previously-saved snapshot — Unit 7.

        Replay-first restore:

        1. Read the sidecar JSON. With ``use_dill_optimization`` and an
           ANDES major.minor that differs from the current install (or no
           dill blob on disk), the dill path is skipped and
           ``fallback_reason`` is recorded for the response.
        2. Default path (replay): ``reload_case`` (drops ``is_setup`` and
           clears the in-memory ``_disturbance_log``) → re-add the JSON's
           recorded disturbances → ``_ensure_setup`` + ``run_pflow`` (when
           the snapshot was taken after a converged PF) to re-converge to
           the same operating point. Works on any ANDES version.
        3. Opt-in path (``use_dill_optimization=True``, version OK, dill
           present): ``andes.utils.snapshot.load_ss`` substitutes a System
           with the captured PF / TDS state, so nothing is reloaded or
           replayed and ``_ensure_setup`` + ``run_pflow`` are skipped. The
           JSON's disturbance log becomes the wrapper's ``_disturbance_log``
           (the blob already carries those disturbances). Any failure along
           the way falls back to the default path.

        Raises :class:`SnapshotNotFoundError` (404) when the named
        snapshot does not exist; :class:`SnapshotMetadataError` (422)
        on a corrupted sidecar.
        """
        from tensa.core.snapshot import RestoreSnapshotResult, versions_compatible

        # Read, bounded and parsed up front so a malformed log is refused
        # before the live System is touched.
        record = self._read_snapshot_record(name)
        validated = record.name
        dill_path = record.dill_path
        metadata = record.metadata
        specs = record.specs

        import andes

        current_version = str(getattr(andes, "__version__", "unknown"))
        version_ok = versions_compatible(metadata.andes_version, current_version)
        dill_available = dill_path.exists()

        used_dill = False
        fallback_reason: str | None = None

        if use_dill_optimization and not dill_available:
            fallback_reason = (
                f"dill blob {dill_path.name} not found alongside the "
                "metadata (the snapshot was saved without one); "
                "falling back to replay+PF"
            )
        elif use_dill_optimization and not version_ok:
            fallback_reason = (
                f"snapshot was written against ANDES "
                f"{metadata.andes_version}; current install is "
                f"{current_version} — dill format is version-locked, "
                "falling back to replay+PF"
            )

        if use_dill_optimization and version_ok and dill_available:
            # Opt-in path: load_ss builds the whole System, so the live one is
            # simply replaced. Nothing is reloaded or replayed beforehand; if
            # the load fails the live System is still in place and the replay
            # path below starts from it as usual.
            from andes.utils.snapshot import load_ss

            # Part B (defense in depth): the dill path has been observed to
            # corrupt the worker's multiprocessing pipe fd — the old System being
            # GC'd closes a file descriptor that collides with the worker's pipe,
            # killing the worker with ``OSError: [Errno 9] Bad file descriptor``.
            # Part A is the real safety net (worker death → clean recoverable
            # error); here we harden the path so ANY exception across the
            # load, the System swap, AND a post-load sanity access falls back
            # to the replay path instead of leaving the wrapper in a torn
            # state. The try therefore spans more than ``load_ss`` alone: a
            # corruption that surfaces only when the swapped-in System is first
            # touched (or when the old System is dropped) must still fall back.
            previous_ss = self._ss
            try:
                ss_loaded = load_ss(str(dill_path))
                # Swap in the dill-loaded System, then sanity-touch it so a
                # structurally broken restore surfaces NOW (and falls back)
                # instead of on the next routine call. ``is_setup`` is a cheap
                # attribute read that forces the object graph to be at least
                # walkable. Keeping ``previous_ss`` bound (no ``del``) means the
                # except arm can always restore it.
                self._ss = ss_loaded
                _ = getattr(ss_loaded, "is_setup", None)
                used_dill = True
            except Exception as exc:  # noqa: BLE001
                # Defensive: a corrupted dill (or a torn swap) should fall back,
                # not crash. Put the previous System back so the replay path
                # below starts from a consistent wrapper.
                fallback_reason = (
                    "dill load failed "
                    f"({type(exc).__name__}); falling back to replay+PF"
                )
                self._ss = previous_ss
                used_dill = False
                logging.getLogger("tensa.wrapper.snapshot").warning(
                    "snapshot %r dill path failed: %s; "
                    "falling back to replay+PF",
                    validated,
                    _sanitize_message(str(exc)),
                )

            if used_dill:
                # Same bookkeeping ``load_case`` does for a new System, with
                # the recorded disturbances adopted as the log: the blob
                # already holds them, so re-adding them would double them up.
                self._setup_failed = False
                self._se_measurements = None
                if self._case_path is not None:
                    self._edit_log = []
                    self._redo_log = []
                self._disturbance_log = list(specs)
                self._client_events = []
                self._restored_events = [event_from_spec(spec) for spec in specs]

        replayed = len(specs)
        if not used_dill:
            # Default path: reload (clears ``_disturbance_log`` + ``is_setup``),
            # replay the snapshot's disturbances onto the fresh pre-setup
            # System, then setup + PF. PF is idempotent; if the user only
            # wanted the disturbance list back (snapshot was saved pre-PF) the
            # meta's has_pflow=False tells us to stop before setup.
            self.reload_case()
            self._restored_events = []
            for spec in specs:
                self.add_disturbance(spec)
                self._restored_events.append(event_from_spec(spec))
            if metadata.has_pflow:
                self._ensure_setup()
                ss = self._require_loaded()
                ss.PFlow.run()

        return RestoreSnapshotResult(
            used_dill=used_dill,
            metadata=metadata,
            fallback_reason=fallback_reason,
            disturbances_replayed=replayed,
        ).__dict__ | {"metadata": metadata.to_dict()}

    def list_snapshots(self) -> list[dict[str, Any]]:
        """Return the listing of snapshots for the current case.

        Empty list (NOT an error) when no snapshots have been saved
        against this case yet, when no case has been loaded, or when
        the substrate has no workspace configured. The route layer
        ships an empty array in those cases so the UI's "Load
        snapshot…" menu can render its empty state without a
        round-trip dance.
        """
        from tensa.core.snapshot import list_snapshots_on_disk

        if self._workspace is None:
            return []
        case_filename = (
            self._case_path.name if self._case_path is not None else None
        )
        # When no case is loaded AND no blank session has been built,
        # there's nothing meaningful to list — return empty.
        if self._ss is None and self._case_path is None:
            return []
        entries = list_snapshots_on_disk(self._workspace, case_filename)
        return [
            {
                "name": e.name,
                "saved_at": e.saved_at,
                "has_pflow": e.has_pflow,
                "has_tds": e.has_tds,
                "has_dill": e.has_dill,
                "andes_version": e.andes_version,
                "disturbance_count": e.disturbance_count,
            }
            for e in entries
        ]

    def delete_snapshot(self, name: str) -> None:
        """Delete a snapshot by name. No-op-safe — re-deleting a
        previously-deleted snapshot raises :class:`SnapshotNotFoundError`.
        """
        from tensa.core.snapshot import delete_snapshot_files

        if self._workspace is None:
            raise NoCaseLoadedError(
                "snapshot delete requires a workspace; the substrate "
                "was launched without one"
            )
        case_filename = (
            self._case_path.name if self._case_path is not None else None
        )
        delete_snapshot_files(self._workspace, case_filename, name)


@dataclass(frozen=True)
class _SnapshotRecord:
    """A snapshot's sidecar read and validated: the disturbance specs are parsed
    and the log is within its cap, so nothing here can fail later."""

    name: str
    dill_path: Path
    metadata: SnapshotMetadata
    specs: list[DisturbanceSpec]
