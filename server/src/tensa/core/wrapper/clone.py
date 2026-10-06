"""Clone-on-write editing of the case files."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, cast

from tensa.core.case_events import events_in_case
from tensa.core.wrapper.base import WrapperBase

if TYPE_CHECKING:
    from andes.system import System

    from tensa.core.clone_manager import CloneManager
    from tensa.core.wrapper import Wrapper


class CloneMixin(WrapperBase):
    """Clone-on-write editing of the case files, which
    :class:`~tensa.core.clone_manager.CloneManager` does."""

    def _clone_mgr(self) -> CloneManager:
        """Return (creating on first use) this session's clone manager."""
        # Deferred import — ``clone_manager`` imports wrapper-level symbols
        # (``_CONTROLLER_MODEL_NAMES``, ``allowed_param_names``), so importing
        # it at module top would create an import cycle.
        from tensa.core.clone_manager import CloneManager as _CloneManager

        if self._clone_manager is None:
            self._clone_manager = _CloneManager(
                # ``self`` is the assembled ``Wrapper``, which the manager reloads and
                # rebinds; this mixin alone is typed as the clone methods only.
                wrapper=cast("Wrapper", self),
                workspace=self._workspace,
                session_id=self._session_id,
                owner_pid=self._owner_pid,
            )
        return self._clone_manager

    def init_clone(self) -> dict[str, Any]:
        """Initialise (or return) the per-session clone of the active case.

        Delegates to :class:`~tensa.core.clone_manager.CloneManager`.
        Returns a JSON-friendly dict of the clone metadata.
        """
        result = self._clone_mgr().init_clone()
        return {
            "clone_dir": result.clone_dir,
            "clone_files": result.clone_files,
            "already_initialized": result.already_initialized,
        }

    def apply_clone_edit(
        self, model: str, idx: int | str, param: str, value: Any
    ) -> dict[str, Any]:
        """Apply one clone-on-write edit and return the new value + stack depths."""
        result = self._clone_mgr().apply_edit(model, str(idx), param, value)
        return self._clone_edit_payload(result)

    def undo_clone_edit(self) -> dict[str, Any]:
        """Undo the most recent clone edit (restore prior file state + re-setup)."""
        result = self._clone_mgr().undo()
        return self._clone_edit_payload(result)

    def redo_clone_edit(self) -> dict[str, Any]:
        """Redo the most recently undone clone edit."""
        result = self._clone_mgr().redo()
        return self._clone_edit_payload(result)

    def save_clone_as(self, name: str, *, overwrite: bool = False) -> dict[str, Any]:
        """Copy the clone files to the workspace as ``<name>.<ext>``."""
        result = self._clone_mgr().save_as(name, overwrite=overwrite)
        return {"name": result.name, "files": result.files}

    def reset_clone(self) -> dict[str, Any]:
        """Discard the clone, delete its scratch dir, and revert to the originals."""
        self._clone_mgr().reset_clone()
        return {"reset": True}

    def clone_diff(self, model: str, idx: int | str) -> dict[str, Any]:
        """Diff the clone-file vs original-file values for one device (Unit 23).

        Returns ``{"params": {param: {original, current}}}`` for the
        whitelisted controller params that differ; an empty mapping when there
        is no clone (no edits) or nothing changed.
        """
        result = self._clone_mgr().clone_diff(model, str(idx))
        return {"params": result.params}

    @staticmethod
    def _clone_edit_payload(result: Any) -> dict[str, Any]:
        return {
            "model": result.model,
            "idx": result.idx,
            "param": result.param,
            "new_value": result.new_value,
            "undo_depth": result.undo_depth,
            "redo_depth": result.redo_depth,
        }

    def _bind_clone_system(self, ss: System) -> None:
        """Bind a clone-loaded ``System`` to this wrapper and commit ``setup()``.

        Used only by the clone manager's reload path. Mirrors the state reset
        ``load_case`` performs (clears disturbance / SE / replay caches keyed
        on the prior System) WITHOUT re-pointing ``_case_path`` / ``_addfiles``
        at the clone — the original paths must survive so ``reset_clone`` can
        revert to them. Commits ``setup()`` so PF / TDS / EIG / CPF / SE are
        ready against the edited files; a setup failure surfaces as
        :class:`SetupFailedError`.
        """
        self._ss = ss
        self._setup_failed = False
        self._edit_log = []
        self._redo_log = []
        self._disturbance_log = []
        self._client_events = []
        self._case_events = events_in_case(ss)
        self._restored_events = []
        self._se_measurements = None
        self._ensure_setup()
