"""The state the Wrapper's parts share, and the scrubber for ANDES messages."""

from __future__ import annotations

import re
import weakref
from pathlib import Path
from typing import TYPE_CHECKING

from tensa.core.case_events import CaseEvent
from tensa.core.disturbance import DisturbanceSpec
from tensa.core.edit_log import DeviceRef, Op
from tensa.core.errors import NoCaseLoadedError, SetupFailedError
from tensa.core.tds_controllers import ControllerBank
from tensa.engines.keys import KeyBook

if TYPE_CHECKING:
    from andes.system import System

    from tensa.core.clone_manager import CloneManager
    from tensa.core.pflow_options import PflowSettings
    from tensa.engines.identity import CaseIdentity


class WrapperBase:
    """The state every part of the Wrapper shares, and the two checks that
    routines begin with: a System is loaded, and ``setup()`` has run.

    The routines live in the sibling modules as mixins over this class; ``Wrapper``
    (``tensa.core.wrapper``) puts them together."""

    def __init__(
        self,
        *,
        workspace: str | Path | None = None,
        session_id: str | None = None,
        owner_pid: int | None = None,
    ) -> None:
        self._ss: System | None = None
        self._case_path: Path | None = None
        self._addfiles: list[Path] | None = None
        # The buses the loaded case file gives no ``Vn`` (ANDES fills in 110 kV),
        # worked out when the case is loaded: ANDES forgets it at ``setup()``.
        self._buses_without_vn: frozenset[int | str] = frozenset()
        # The ``Fault`` / ``Toggle`` / ``Alter`` devices the loaded case file
        # defines, read when it is loaded, before anything is added to the System.
        self._case_events: list[CaseEvent] = []
        # The disturbances a bundle import or snapshot restore replayed onto the
        # System, which the client never scheduled. Emptied with every new System.
        self._restored_events: list[CaseEvent] = []
        self._setup_failed: bool = False  # marks "requires reload"
        # ``_workspace`` is the per-launch workspace directory (the same one
        # the CLI hands the FastAPI app). Snapshot files (Unit 7) live under
        # ``<workspace>/snapshots/<case_basename>/``. ``None`` is honoured
        # by the snapshot routes — they 409 with an actionable message —
        # so the wrapper itself stays usable in pure unit tests that
        # don't touch the snapshot surface.
        self._workspace: Path | None = (
            Path(workspace) if workspace is not None else None
        )
        # ``_edit_log`` records, in order, every element added, changed or
        # deleted since the case was loaded (``tensa.core.edit_log``). The
        # pre-setup System is always the case file, or an empty System, with
        # this log applied: that is how an edit is taken back, how an element
        # of the case file is deleted, and how a blank session (which has no
        # file) comes back from ``reload_case``. It holds at most
        # ``EDIT_LOG_MAX`` entries; an edit past that is refused, since a
        # dropped entry would change what the next rebuild gives.
        self._edit_log: list[Op] = []
        # The edits ``undo_last_edit`` took back, newest last, for ``redo_edit``.
        # A new edit empties it.
        self._redo_log: list[Op] = []
        # The ``Fault`` / ``Toggle`` / ``Alter`` devices ``add_disturbance`` put
        # on the current System. Every other device of those models came with
        # the case file, which is what tells the two apart when one is deleted.
        self._client_events: list[DeviceRef] = []
        # ``_disturbance_log`` records every successfully-added disturbance
        # spec so callers can replay them after ``reload_case()`` —
        # the only escape hatch from the post-setup ``add()`` rejection
        # ANDES enforces. The replay step is explicit (``replay_disturbances``)
        # rather than wired into ``reload_case`` itself, because Unit 7
        # (snapshot save/load) needs the JSON-serialisable spec list as
        # snapshot metadata before any new System exists. Cleared by
        # ``load_case`` (and therefore by ``reload_case`` which delegates
        # to ``load_case``); explicit reset via ``clear_disturbances``.
        self._disturbance_log: list[DisturbanceSpec] = []
        # ``_se_measurements`` holds the in-memory ``Measurements`` object
        # populated by ``generate_measurements_from_pflow`` (Unit 13). The
        # two-step SE flow (generate → run) keeps the measurement count
        # visible to the UI before the (potentially slow) iteration cost,
        # and lets the user re-run SE against the same measurement set
        # without regenerating noise. Reset on ``load_case`` /
        # ``reload_case`` because a new System invalidates the cached
        # measurement model references.
        self._se_measurements: object | None = None
        # ``_session_id`` (Unit 21) names the clone-on-write scratch dir
        # ``<workspace>/.sessions/<session_id>/clone/``. ``None`` in pure
        # unit tests that don't exercise the clone surface — the clone
        # manager is constructed lazily and 409s without a workspace.
        self._session_id: str | None = session_id
        # ``_owner_pid`` is the parent server's pid, recorded in the clone scratch
        # dir's owner marker so a later server can tell the dir was abandoned.
        self._owner_pid: int | None = owner_pid
        # The clone-on-write manager (KTD-9) is created lazily on first
        # ``init_clone`` so a session that never edits pays nothing. It holds
        # the per-session clone files + undo/redo stacks.
        self._clone_manager: CloneManager | None = None
        # The controllers of the last time-domain run that had any (see
        # ``tensa.core.tds_controllers``), kept so a run that carries on where
        # that one stopped carries its controllers on too. It holds their state
        # and no reference to the System.
        self._controller_bank: ControllerBank | None = None
        # The identity of the case file (``tensa.engines.identity``) and the
        # book of the keys assigned from it (``tensa.engines.keys``): how every
        # element is named the same in every engine. Both live as long as the
        # case does: a reload, an undo, a redo and a delete keep them, since a
        # key never changes within a session; a new case or a blank system
        # starts a fresh book.
        self._identity: CaseIdentity | None = None
        self._key_book: KeyBook = KeyBook()
        # How many of the book's problem notes have been logged already, so a
        # note is logged once however often ``keys`` is called.
        self._key_notes_logged: int = 0
        # The case file the identity and the book belong to, as its path, its
        # modification time and its size: a ``load_case`` of another file, or of
        # the same path after the file changed on disk, starts them afresh; a
        # reload of the unchanged file keeps them.
        self._keyed_case: tuple[Path, int, int] | None = None
        # The settings of the last power flow ``run_pflow`` ran, with the System it
        # ran on (held weakly, so a System that was replaced is not kept alive). An
        # eigenvalue sweep solves the power flow of each System it builds with them,
        # so its points are taken at the operating point the session has.
        self._pflow_settings: tuple[weakref.ref[System], PflowSettings] | None = None

    def _require_loaded(self) -> System:
        if self._ss is None:
            raise NoCaseLoadedError("no case has been loaded")
        return self._ss

    def keys(self) -> KeyBook:
        """The keys of the loaded case's elements, assigning any not yet keyed.

        A key names an element the same way in every engine (section 4 of
        ``design/multiengine/spec.md``). Entries whose element is gone from the
        System (a delete rebuilt it without them) are dropped first, so a
        handle that comes back is keyed afresh; every other key is stable, and
        calling this twice changes nothing. A problem the assignment notes is
        logged once as a ``tensa.notice`` warning.
        """
        import logging

        from tensa.engines.andes.keys import assign_andes_keys

        ss = self._require_loaded()
        handles: set[tuple[str, str]] = set()
        models = getattr(ss, "models", None)
        if models is not None:
            for model_name, model in models.items():
                idx_var = getattr(model, "idx", None)
                values = getattr(idx_var, "v", None)
                if values is None:
                    continue
                try:
                    for value in list(values):
                        handles.add((model_name, str(value)))
                except TypeError:
                    continue
        self._key_book.retain(handles)
        assign_andes_keys(ss, self._identity, self._key_book)
        problems = self._key_book.problems
        if len(problems) > self._key_notes_logged:
            log = logging.getLogger("tensa.notice")
            for note in problems[self._key_notes_logged :]:
                log.warning("keys: %s", note)
            self._key_notes_logged = len(problems)
        return self._key_book

    def _ensure_setup(self) -> None:
        """Call ``ss.setup()`` if not yet committed.

        ANDES 2.0.0 verified contract (see ANDES_VERSIONS.md, contract #6):
        ``PFlow.run`` and ``TDS.run`` do NOT auto-call setup. We must call it
        explicitly. If setup returns False or raises, raise SetupFailedError
        and mark the wrapper as "requires reload" so the next caller is
        directed to ``reload_case``.
        """
        ss = self._require_loaded()
        if ss.is_setup:
            return
        if self._setup_failed:
            raise SetupFailedError(
                "previous setup() failed; the System is in an inconsistent state"
            )
        try:
            ok = ss.setup()
        except Exception as exc:  # noqa: BLE001
            self._setup_failed = True
            raise SetupFailedError(f"setup() raised: {exc}") from exc
        if not ok:
            self._setup_failed = True
            raise SetupFailedError("setup() returned False")


# Filesystem path patterns to strip from ANDES exception messages before
# they reach the API surface. Workspace paths leak per-user directory
# structure; the andes install path leaks the wheel layout. Both add noise
# without giving the client actionable detail.
_PATH_PATTERN = re.compile(r"/[\w./\-_]+(?:\.py|\.raw|\.dyr|\.xlsx|\.json|\.m)\b")


def _sanitize_message(message: str) -> str:
    """Strip filesystem paths from an ANDES exception message.

    Best-effort regex sweep — leaves the structural message intact while
    removing absolute paths that would otherwise leak workspace and
    install-tree details. Replaces matches with ``<path>``.
    """
    return _PATH_PATTERN.sub("<path>", message)
