"""Loading, reloading, rebuilding, creating and saving the case."""

from __future__ import annotations

import contextlib
import logging
import os
import tempfile
import zipfile
from collections.abc import Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Literal

from tensa.core.case_events import CaseEvent, events_in_case
from tensa.core.codegen_cache import wait_for_background_warm
from tensa.core.disturbance import DisturbanceSpec
from tensa.core.edit_log import Op, apply_op, step_of
from tensa.core.errors import (
    CaseLoadError,
    CaseSaveError,
    ElementValidationError,
    NoCaseLoadedError,
    SystemAlreadyLoadedError,
)
from tensa.core.rated_voltage import buses_without_rated_voltage
from tensa.core.wrapper.base import _sanitize_message
from tensa.core.wrapper.disturbances import DisturbanceMixin
from tensa.core.wrapper.results import TopologySnapshot
from tensa.core.wrapper.topology import TopologyMixin

if TYPE_CHECKING:
    from andes.system import System


class CaseMixin(TopologyMixin, DisturbanceMixin):
    """Everything that replaces or writes the System: load, reload, rebuild, adopt
    a rebuilt System, create a blank one, save the case."""

    def load_case(
        self, path: str | Path, addfiles: list[str | Path] | None = None
    ) -> TopologySnapshot:
        """Load an ANDES case file with ``setup=False`` so disturbances can be
        added before commit. Resets all wrapper state.

        Raises ``CaseLoadError`` on any failure (file not found, parse error,
        format detection failure). The wrapper survives the failure — a
        subsequent ``load_case`` call with a valid path works.
        """
        case_path = Path(path)
        resolved_addfiles: list[Path] | None = (
            [Path(a) for a in addfiles] if addfiles else None
        )
        ss = self._load_system(case_path, resolved_addfiles)

        self._ss = ss
        self._case_path = case_path
        self._addfiles = resolved_addfiles
        self._buses_without_vn = buses_without_rated_voltage(ss, case_path)
        self._case_events = events_in_case(ss)
        self._setup_failed = False
        # Loading from a real case file makes that file the base again: the
        # edits recorded against the prior System are gone with it.
        self._edit_log = []
        self._redo_log = []
        # Disturbances added against the prior System reference are gone —
        # the new System has none. Callers that need to keep them across a
        # reload must capture them via ``list_disturbances()`` BEFORE
        # ``reload_case`` and then ``replay_disturbances()`` AFTER.
        self._disturbance_log = []
        self._client_events = []
        self._restored_events = []
        # SE measurements (Unit 13) are scoped to the previous System's
        # device idxes; load/reload invalidates them. The user must
        # call /se/measurements/generate again on the new System.
        self._se_measurements = None
        return self._topology_snapshot_locked()

    @staticmethod
    def _load_system(case_path: Path, addfiles: list[Path] | None) -> System:
        """Read a case into a new System, before ``setup()``.

        Touches nothing on the wrapper, so a caller can build a System and
        decide afterwards whether to keep it. Raises ``CaseLoadError``.
        """
        import andes  # heavy import — kept lazy

        if not case_path.exists():
            raise CaseLoadError(str(case_path), "file does not exist")

        # A 0-byte file (e.g. a save that was interrupted before the atomic
        # write landed) is not a valid case; ANDES would raise a cryptic
        # "File is not a zip file". Catch it early with an actionable message.
        with contextlib.suppress(OSError):
            if case_path.stat().st_size == 0:
                raise CaseLoadError(
                    str(case_path),
                    "the file is empty or corrupt — re-save the case "
                    "(an interrupted save can leave a 0-byte file)",
                )

        # Building the System is what makes ANDES generate code it lacks, so wait for
        # the server's background generation instead of running a second one.
        wait_for_background_warm()
        try:
            ss = andes.load(
                str(case_path),
                addfile=[str(a) for a in addfiles] if addfiles else None,
                setup=False,
                no_output=True,
                default_config=True,
            )
        except CaseLoadError:
            raise
        except Exception as exc:  # noqa: BLE001 — wrap and re-raise
            detail = str(exc)
            if "not a zip" in detail.lower() or "badzipfile" in detail.lower():
                detail = (
                    "the file is empty or corrupt — re-save the case "
                    "(an interrupted save can leave a 0-byte/invalid file)"
                )
            raise CaseLoadError(str(case_path), detail) from exc

        if ss is None:
            raise CaseLoadError(str(case_path), "andes.load returned None")
        return ss

    def reload_case(self) -> TopologySnapshot:
        """Re-load the current case to return to pre-setup state.

        Honest about cost: this calls ``andes.load(setup=False)`` again — full
        re-parse. ANDES has no public mechanism to skip the parse and only
        revert ``is_setup``; ``System.reset()`` always re-calls setup, and
        ``System.reload()`` always re-parses.

        A case file's reload is the file again: the edits made since it was
        loaded (``self._edit_log``) are gone with the System they were made on.

        Blank-session reload (no underlying case file): re-create
        ``andes.System()`` and replay every entry recorded in
        ``self._edit_log``, since the log is all a blank session has. Failed
        replays leave the wrapper in a partial state and raise
        ``ElementValidationError`` — caller can retry ``create_blank()`` to
        start over.

        Either way the committed disturbances are gone: the new System has
        none, so the log of them is emptied with it.
        """
        if self._case_path is None:
            if not self._edit_log:
                raise NoCaseLoadedError(
                    "no case has been loaded; call load_case() or create_blank() first"
                )
            return self._reload_blank_locked()
        return self.load_case(
            self._case_path,
            addfiles=[str(a) for a in self._addfiles] if self._addfiles else None,
        )

    def _reload_blank_locked(self) -> TopologySnapshot:
        """Re-create the blank System and replay every recorded edit."""
        import andes  # heavy import — kept lazy

        log = logging.getLogger("tensa.wrapper.replay")
        wait_for_background_warm()
        ss = andes.System()
        replay = list(self._edit_log)  # snapshot — replays may mutate
        self._ss = ss
        self._setup_failed = False
        self._edit_log = []
        # As ``load_case`` does for a case file: the disturbances committed on
        # the prior System are not on this one. Left in the log, the next
        # delete, undo or redo would add them to the System it builds.
        self._disturbance_log = []
        self._client_events = []
        self._restored_events = []
        self._se_measurements = None
        for op in replay:
            try:
                apply_op(ss, op)
            except Exception as exc:  # noqa: BLE001
                log.warning(
                    "replay rejected by ANDES on model=%r: %s",
                    op.model,
                    _sanitize_message(str(exc)),
                )
                raise ElementValidationError(
                    f"replay failed at model {op.model!r}: "
                    f"{_sanitize_message(str(exc))}"
                ) from exc
            self._edit_log.append(op)
        return self._topology_snapshot_locked()

    def _build_system(self, ops: Sequence[Op]) -> System:
        """A new pre-setup System: the case file, or an empty one, with ``ops`` applied.

        Touches nothing on the wrapper. A caller builds the System it wants
        and swaps it in with ``_adopt_system`` once that worked, so a failure
        here leaves the session as it was. Raises ``ElementValidationError``
        naming the entry that could not be replayed.
        """
        if self._case_path is not None:
            ss = self._load_system(self._case_path, self._addfiles)
        else:
            import andes  # heavy import — kept lazy

            wait_for_background_warm()
            ss = andes.System()
        for op in ops:
            try:
                apply_op(ss, op)
            except Exception as exc:  # noqa: BLE001
                step = step_of(op)
                raise ElementValidationError(
                    f"could not replay the {step.op} of {step.model} "
                    f"{step.idx!r}: {_sanitize_message(str(exc))}"
                ) from exc
        return ss

    def _adopt_system(
        self,
        ss: System,
        *,
        edit_log: Sequence[Op],
        redo_log: Sequence[Op],
        disturbances: Sequence[DisturbanceSpec],
        restored_events: Sequence[CaseEvent],
    ) -> None:
        """Make ``ss`` (from ``_build_system``) the session's System.

        ``disturbances`` are the pending ones the session keeps: each is added
        to ``ss`` again, since a System that was built afresh has none. If
        ANDES refuses one, the session is put back as it was and the error
        raised.
        """
        before = (
            self._ss,
            self._setup_failed,
            self._edit_log,
            self._redo_log,
            self._case_events,
            self._disturbance_log,
            self._client_events,
            self._restored_events,
            self._se_measurements,
        )
        self._ss = ss
        self._setup_failed = False
        self._edit_log = list(edit_log)
        self._redo_log = list(redo_log)
        # Read before a pending disturbance is added back: what ``ss`` holds
        # now is what the case file defines, less what a delete removed.
        self._case_events = events_in_case(ss)
        self._disturbance_log = []
        self._client_events = []
        self._restored_events = list(restored_events)
        self._se_measurements = None
        try:
            for spec in disturbances:
                self.add_disturbance(spec)
        except Exception:
            (
                self._ss,
                self._setup_failed,
                self._edit_log,
                self._redo_log,
                self._case_events,
                self._disturbance_log,
                self._client_events,
                self._restored_events,
                self._se_measurements,
            ) = before
            raise

    def save_case(
        self, format: Literal["xlsx", "json", "raw"], filename: str
    ) -> Path:
        """Write the current System to a workspace file.

        Three formats:

        - ``xlsx`` — ANDES native, via ``andes.io.xlsx.write``.
        - ``json`` — ANDES JSON, via ``andes.io.json.write``.
        - ``raw`` — PSS/E v33, via the substrate's hand-rolled writer
          (``tensa.core.psse_writer.write_raw``). ANDES 2.0 has no
          built-in PSS/E writer; the substrate ships one for the
          power-flow data (Bus, PQ, Shunt, PV/Slack, Line, 2W
          transformer). A ``.raw`` holds no dynamic data, so the dynamic
          models of the case (a ZIP on its PQ, a machine on its PV or
          Slack) are not in it.

        Writing over the file the case was loaded from makes that file the new
        base of the session: it now holds the edits made since the load, so
        ``_edit_log`` and ``_redo_log`` are emptied (an undo or a delete would
        otherwise reload the file and apply those edits a second time). That
        write is refused
        while the System holds disturbances a client committed or a restore
        replayed, because they would become part of the case file.

        Returns the absolute path of the written file. Caller (the
        route handler) is responsible for canonicalizing ``filename``
        against the workspace and rejecting traversal.
        """
        ss = self._require_loaded()
        target = Path(filename)
        if format not in ("xlsx", "json", "raw"):  # pragma: no cover — Literal
            raise ElementValidationError(
                f"unsupported save format {format!r}; supported: xlsx, json, raw"
            )
        overwrites_open_case = self._is_open_case_file(target)
        if overwrites_open_case and (self._disturbance_log or self._restored_events):
            raise CaseSaveError(
                "the system holds disturbances for a run, and saving over "
                f"{target.name} would make them part of that case. Save it under "
                "a new name, or reload the case first"
            )

        # ATOMIC WRITE. The ANDES xlsx/json writers are NOT atomic: they create
        # the target at 0 bytes and only flush content at close(), so any failure
        # between open and close (ANDES choking on a from-scratch System, a worker
        # kill, etc.) leaves a 0-byte file that masquerades as a real case and
        # fails to load with "File is not a zip file". Write to a temp file in the
        # SAME directory (so os.replace is atomic on one filesystem), validate it
        # is non-empty + a valid container, then atomically rename onto target.
        # On any failure the temp is removed and a CaseSaveError (422) is raised;
        # an existing valid file at ``target`` is never clobbered by a failed write.
        # The temp file keeps the real ``.{format}`` extension (the ANDES/pandas
        # xlsx writer validates the extension and rejects e.g. ``.tmp``) but a
        # leading ``.`` so it is a hidden dotfile — ``list_workspace_files``
        # excludes names starting with ``.``, so the in-flight temp never shows
        # up in the case picker even during the sub-millisecond write window.
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(
            prefix=f".{target.stem}.save-", suffix=f".{format}", dir=str(target.parent)
        )
        os.close(fd)
        tmp_path = Path(tmp_name)
        try:
            # ANDES's writers call ``confirm_overwrite`` → ``input()`` when the
            # file exists; the temp always exists (mkstemp created it), so force
            # ``overwrite=True`` to avoid the TTY-less worker raising EOFError.
            if format == "xlsx":
                from andes.io import xlsx

                xlsx.write(ss, str(tmp_path), overwrite=True)
            elif format == "json":
                from andes.io import json as andes_json

                andes_json.write(ss, str(tmp_path), overwrite=True)
            else:  # raw
                from tensa.core.psse_writer import write_raw

                write_raw(ss, str(tmp_path))

            # Validate the artifact BEFORE exposing it. A 0-byte or truncated
            # write must never become a "saved case".
            if not tmp_path.exists() or tmp_path.stat().st_size == 0:
                raise CaseSaveError(
                    f"the {format} writer produced an empty file "
                    "(the System may be incomplete — add buses/lines/generators "
                    "and ensure power flow can solve before saving)"
                )
            if format == "xlsx" and not zipfile.is_zipfile(str(tmp_path)):
                raise CaseSaveError(
                    "the xlsx writer produced a corrupt (non-zip) file"
                )

            os.replace(str(tmp_path), str(target))
        except CaseSaveError:
            with contextlib.suppress(OSError):
                tmp_path.unlink()
            raise
        except Exception as exc:  # noqa: BLE001 — wrap so no raw writer error leaks
            with contextlib.suppress(OSError):
                tmp_path.unlink()
            raise CaseSaveError(_sanitize_message(str(exc))) from exc
        if overwrites_open_case:
            self._edit_log = []
            self._redo_log = []
        return target

    def _is_open_case_file(self, target: Path) -> bool:
        """Whether ``target`` is the file the loaded case was read from."""
        if self._case_path is None:
            return False
        try:
            return os.path.samefile(target, self._case_path)
        except OSError:  # one of the two does not exist
            return False

    def create_blank(self) -> TopologySnapshot:
        """Create a brand-new empty ``andes.System()`` for this session.

        409s if a System is already loaded — the caller should reload or
        open a fresh session. The edit log is reset so the new blank
        session starts from zero.
        """
        if self._ss is not None:
            raise SystemAlreadyLoadedError(
                "a System is already loaded; call reload_case() or open a "
                "fresh session"
            )
        import andes  # heavy import — kept lazy

        wait_for_background_warm()
        self._ss = andes.System()
        self._case_path = None
        self._addfiles = None
        self._setup_failed = False
        self._edit_log = []
        self._redo_log = []
        self._client_events = []
        return self._topology_snapshot_locked()
