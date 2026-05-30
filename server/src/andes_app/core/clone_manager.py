"""Clone-on-write substrate manager (Unit 21 / KTD-9, KTD-10).

On first edit the substrate clones the active case files (``.raw`` / ``.dyr``
/ ``.xlsx``) to a per-session scratch directory
``<workspace>/.sessions/<session_id>/clone/``. Each edit invokes a
format-specific writer (``core/clone_writers``) that modifies the clone in
place; the manager then re-loads the System from the clone with
``andes.load(setup=False) → setup()`` so PF / TDS / EIG / CPF / SE run against
the edited files. The clone files themselves are the persisted edit state — no
separate mutation log.

Undo / redo is file-diff-based (KTD-10): each successful edit pushes the prior
bytes of the edited clone file onto an in-memory undo stack (cap 50, oldest
evicted). ``undo`` restores the bytes and re-setups; ``redo`` re-applies. A
new edit after an undo clears the redo stack.

This module runs INSIDE the worker subprocess (it holds the live ``Wrapper``
and drives ``andes.load`` / ``setup``). It never touches the original case
files — only the clone. The parent ``SessionManager`` deletes the whole
``<workspace>/.sessions/<session_id>/`` tree on session reap.
"""

from __future__ import annotations

import contextlib
import math
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from andes_app.core.clone_writers import DyrLocator
from andes_app.core.clone_writers import apply_edit as _writer_apply_edit
from andes_app.core.errors import (
    CloneEditError,
    ElementNotFoundError,
    ElementValidationError,
    NoCaseLoadedError,
)
from andes_app.core.wrapper import (
    _CONTROLLER_MODEL_NAMES,
    allowed_param_names,
)

if TYPE_CHECKING:
    from andes_app.core.wrapper import Wrapper

# Undo/redo stack cap (KTD-10). Beyond this the oldest entry is evicted (LRU);
# an evicted edit can no longer be recovered via undo.
UNDO_STACK_CAP = 50

# Save-as target name: filesystem-safe, no separators / traversal. Mirrors the
# snapshot-name policy (``core/snapshot.validate_snapshot_name``) — 1-64 chars
# of ``[A-Za-z0-9._-]`` starting with an alphanumeric. The user supplies the
# stem only; the manager appends each clone file's extension.
_SAVE_AS_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-]{0,63}$")

_CONTROLLER_MODEL_SET = frozenset(_CONTROLLER_MODEL_NAMES)


@dataclass(frozen=True)
class CloneSnapshot:
    """One undo/redo stack entry: the prior bytes of one clone file.

    File-diff granularity (KTD-10): every edit touches exactly one clone file,
    so an undo entry is that file's path + its bytes BEFORE the edit. Restoring
    is a single ``write_bytes``.
    """

    path: Path
    data: bytes


@dataclass
class CloneEditResult:
    """Return shape of :meth:`CloneManager.apply_edit` (+ undo / redo).

    ``new_value`` is read back from the re-setup System
    (``ss.<model>.<param>.v[i]``). Note (per the spike) some params are
    per-unit-normalised at ``setup()`` so ``new_value`` (the live value) may
    differ from the value written to the file; the inspector's
    Modified-from-Original diff (Unit 23) compares FILE values, not ``*.v``.
    """

    model: str
    idx: str
    param: str
    new_value: Any
    undo_depth: int
    redo_depth: int


@dataclass
class CloneInitResult:
    """Return shape of :meth:`CloneManager.init_clone`."""

    clone_dir: str
    clone_files: list[str]
    already_initialized: bool


@dataclass
class CloneSaveAsResult:
    """Return shape of :meth:`CloneManager.save_as`."""

    name: str
    files: list[str] = field(default_factory=list)


@dataclass
class CloneDiffResult:
    """Return shape of :meth:`CloneManager.clone_diff` (Unit 23).

    ``params`` maps each WHITELISTED controller param whose clone-file value
    differs from the original-file value to its ``{original, current}`` pair.
    Params that are unchanged (or absent on the device) are omitted, so an
    empty mapping means "no edits relative to the original".

    The comparison is on the FILE values read pre-setup (``setup=False``), not
    the per-unit-normalised live ``ss.<model>.<param>.v`` — matching the
    file-diff semantics the undo/redo stack tracks (KTD-10).
    """

    params: dict[str, dict[str, Any]] = field(default_factory=dict)


class CloneManager:
    """Per-session clone-on-write file manager.

    Lifecycle: ``init_clone`` → ``apply_edit`` (n times, with undo/redo) →
    ``save_as`` and/or ``reset_clone``. All edits are file-level, never
    in-memory ``ss.<model>.<param>.v[i] = ...`` writes.
    """

    def __init__(
        self,
        *,
        wrapper: Wrapper,
        workspace: Path | None,
        session_id: str | None,
    ) -> None:
        self._wrapper = wrapper
        self._workspace = workspace
        self._session_id = session_id
        self.original_paths: list[Path] = []
        self.clone_dir: Path | None = None
        self.clone_paths: list[Path] = []
        self.is_initialized: bool = False
        self.undo_stack: list[CloneSnapshot] = []
        self.redo_stack: list[CloneSnapshot] = []

    # ----- scratch-dir layout -----

    def _session_root(self) -> Path:
        """``<workspace>/.sessions/<session_id>/`` — the per-session scratch root.

        Mirrors the snapshot dir's per-session pattern. Raises when the
        substrate has no workspace / session id configured (pure unit tests
        that don't exercise the clone surface).
        """
        if self._workspace is None:
            raise CloneEditError(
                "clone editing requires a workspace; the substrate was "
                "launched without one"
            )
        if not self._session_id:
            raise CloneEditError(
                "clone editing requires a session id; the substrate was "
                "launched without one"
            )
        return self._workspace / ".sessions" / self._session_id

    # ----- init -----

    def init_clone(self) -> CloneInitResult:
        """Clone the active case files to the per-session scratch dir.

        Idempotent: if already initialized, returns the existing clone
        metadata with ``already_initialized=True`` (no re-copy — that would
        discard pending edits). Reads the originals from the wrapper's
        ``_case_path`` + ``_addfiles``.
        """
        if self.is_initialized and self.clone_dir is not None:
            return CloneInitResult(
                clone_dir=str(self.clone_dir),
                clone_files=[str(p) for p in self.clone_paths],
                already_initialized=True,
            )

        originals = self._wrapper_original_paths()
        if not originals:
            raise NoCaseLoadedError(
                "no case file is loaded; clone-on-write requires a case loaded "
                "from a file (blank sessions cannot be cloned)"
            )

        clone_dir = self._session_root() / "clone"
        # Fresh dir — drop any stale clone from a prior (reset) session.
        if clone_dir.exists():
            shutil.rmtree(clone_dir)
        clone_dir.mkdir(parents=True, exist_ok=True)

        clone_paths: list[Path] = []
        for original in originals:
            dest = clone_dir / original.name
            shutil.copy2(original, dest)
            clone_paths.append(dest)

        self.original_paths = list(originals)
        self.clone_dir = clone_dir
        self.clone_paths = clone_paths
        self.is_initialized = True
        self.undo_stack = []
        self.redo_stack = []

        return CloneInitResult(
            clone_dir=str(clone_dir),
            clone_files=[str(p) for p in clone_paths],
            already_initialized=False,
        )

    def _wrapper_original_paths(self) -> list[Path]:
        """Resolve the loaded case's original files: case path + addfiles."""
        case_path = getattr(self._wrapper, "_case_path", None)
        if case_path is None:
            return []
        paths: list[Path] = [Path(case_path)]
        addfiles = getattr(self._wrapper, "_addfiles", None) or []
        for addfile in addfiles:
            paths.append(Path(addfile))
        return paths

    # ----- edit -----

    def apply_edit(
        self, model: str, idx: str, param: str, value: Any
    ) -> CloneEditResult:
        """Apply one ``(model, idx, param) = value`` edit to the clone.

        Steps: whitelist re-check (defence in depth — the route validates
        first) → ``init_clone`` if needed → resolve the target clone file +
        (for ``.dyr``) the ``(bus, id)`` locator from the System → push the
        prior file bytes to the undo stack → dispatch to the format writer →
        ``andes.load(clone, setup=False) → setup()`` → read back the new value.

        A new edit clears the redo stack (KTD-10). On a writer / reload
        failure the clone file is restored from the pushed snapshot so the
        clone state is unchanged (atomic from the caller's view).
        """
        self._validate_whitelist(model, param)
        if not self.is_initialized:
            self.init_clone()

        target = self._target_clone_file(model, param)
        locator = self._dyr_locator(model, idx) if target.suffix.lower() == ".dyr" else None

        prior_bytes = target.read_bytes()
        try:
            _writer_apply_edit(target, model, str(idx), param, value, locator=locator)
            self._reload_from_clone()
        except Exception:
            # Restore the clone file so the edit is atomic — a failed write or
            # a clone that no longer setups leaves the clone byte-identical.
            target.write_bytes(prior_bytes)
            # Re-load the restored clone so the live System matches the files
            # again (best-effort; surface the ORIGINAL failure to the caller).
            with contextlib.suppress(Exception):
                self._reload_from_clone()
            raise

        self._push_undo(CloneSnapshot(path=target, data=prior_bytes))
        self.redo_stack = []

        new_value = self._read_back_value(model, idx, param)
        return CloneEditResult(
            model=model,
            idx=str(idx),
            param=param,
            new_value=new_value,
            undo_depth=len(self.undo_stack),
            redo_depth=len(self.redo_stack),
        )

    def _validate_whitelist(self, model: str, param: str) -> None:
        """Defence-in-depth whitelist check (the route checks first).

        ``model`` must be a dynamic-controller class; ``param`` must be one of
        that model's whitelisted params. NEVER reflective ``getattr``.
        """
        if model not in _CONTROLLER_MODEL_SET:
            raise ElementValidationError(
                f"{model!r} is not a dynamic-controller model; clone editing "
                "is only for controller params. Use the edit-element route "
                "for static-topology edits."
            )
        if param not in set(allowed_param_names(model)):
            raise ElementValidationError(
                f"param {param!r} is not editable on {model}; allowed: "
                f"{list(allowed_param_names(model))}"
            )

    def _target_clone_file(self, model: str, param: str) -> Path:
        """Pick the clone file that holds ``(model, param)``.

        ``.xlsx`` clones carry every controller param (100% coverage), so an
        xlsx clone is always the target. For a ``.raw`` + ``.dyr`` clone the
        ``.dyr`` holds dynamic-controller params; the ``.raw`` never does.
        """
        xlsx = self._clone_with_suffix(".xlsx")
        if xlsx is not None:
            return xlsx
        dyr = self._clone_with_suffix(".dyr")
        if dyr is not None:
            return dyr
        # No .xlsx and no .dyr — the controller param has no home (a .raw-only
        # case has no dynamic content). Route to the .raw writer, which raises
        # the "use edit-element" CloneEditError.
        raw = self._clone_with_suffix(".raw")
        if raw is not None:
            return raw
        raise CloneEditError(
            f"no clone file can hold {model}.{param}; the loaded case has no "
            ".xlsx or .dyr form"
        )

    def _clone_with_suffix(self, suffix: str) -> Path | None:
        for path in self.clone_paths:
            if path.suffix.lower() == suffix:
                return path
        return None

    def _dyr_locator(self, model: str, idx: str) -> DyrLocator:
        """Resolve the ``(bus, id)`` for a ``.dyr`` device from the System.

        ANDES does not retain the PSS/E circuit ID for most controller models,
        so ``id`` defaults to ``"1"`` (the dominant case); BUS disambiguates
        siblings of the same model in every bundled case.
        """
        ss = getattr(self._wrapper, "_ss", None)
        if ss is None:
            raise NoCaseLoadedError("no case loaded")
        model_obj = getattr(ss, model, None)
        if model_obj is None:
            raise ElementNotFoundError(f"model {model!r} not on the loaded System")
        idx_values = _values_of(model_obj, "idx")
        idx_str = str(idx)
        try:
            i = next(
                pos for pos, value in enumerate(idx_values) if str(value) == idx_str
            )
        except StopIteration as exc:
            raise ElementNotFoundError(
                f"no {model} with idx={idx!r} on the loaded System"
            ) from exc
        bus_values = _values_of(model_obj, "bus")
        if i >= len(bus_values):
            raise CloneEditError(
                f"{model} idx={idx!r} has no bus reference; cannot locate its "
                ".dyr record"
            )
        return DyrLocator(bus=str(bus_values[i]))

    def _read_back_value(self, model: str, idx: str, param: str) -> Any:
        """Read ``ss.<model>.<param>.v[i]`` for the edited device post-setup."""
        ss = getattr(self._wrapper, "_ss", None)
        if ss is None:
            return None
        model_obj = getattr(ss, model, None)
        if model_obj is None:
            return None
        idx_values = _values_of(model_obj, "idx")
        idx_str = str(idx)
        try:
            i = next(
                pos for pos, value in enumerate(idx_values) if str(value) == idx_str
            )
        except StopIteration:
            return None
        values = _values_of(model_obj, param)
        if i >= len(values):
            return None
        return _jsonable(values[i])

    # ----- undo / redo -----

    def _push_undo(self, snapshot: CloneSnapshot) -> None:
        self.undo_stack.append(snapshot)
        if len(self.undo_stack) > UNDO_STACK_CAP:
            # LRU eviction — oldest first. The evicted edit can no longer be
            # recovered via undo.
            self.undo_stack.pop(0)

    def undo(self) -> CloneEditResult:
        """Pop one edit: restore the prior clone-file bytes + re-setup.

        Pushes the CURRENT bytes onto the redo stack so ``redo`` can re-apply.
        Raises :class:`CloneEditError` when there is nothing to undo.
        """
        if not self.undo_stack:
            raise CloneEditError("nothing to undo")
        snapshot = self.undo_stack.pop()
        current_bytes = snapshot.path.read_bytes()
        snapshot.path.write_bytes(snapshot.data)
        self._reload_from_clone()
        self.redo_stack.append(CloneSnapshot(path=snapshot.path, data=current_bytes))
        return CloneEditResult(
            model="",
            idx="",
            param="",
            new_value=None,
            undo_depth=len(self.undo_stack),
            redo_depth=len(self.redo_stack),
        )

    def redo(self) -> CloneEditResult:
        """Re-apply one undone edit: restore the redo bytes + re-setup.

        Pushes the pre-redo bytes back onto the undo stack. Raises
        :class:`CloneEditError` when there is nothing to redo.
        """
        if not self.redo_stack:
            raise CloneEditError("nothing to redo")
        snapshot = self.redo_stack.pop()
        current_bytes = snapshot.path.read_bytes()
        snapshot.path.write_bytes(snapshot.data)
        self._reload_from_clone()
        self._push_undo(CloneSnapshot(path=snapshot.path, data=current_bytes))
        return CloneEditResult(
            model="",
            idx="",
            param="",
            new_value=None,
            undo_depth=len(self.undo_stack),
            redo_depth=len(self.redo_stack),
        )

    # ----- save-as / reset -----

    def save_as(self, name: str) -> CloneSaveAsResult:
        """Copy the clone files to ``<workspace>/<name>.<ext>``.

        ``name`` is the stem only (no extension, no separators / traversal);
        the manager appends each clone file's extension. Idempotent —
        re-invoking with the same name overwrites. The new files appear in the
        workspace listing immediately (so the UI's SavedCasesList shows them).
        """
        if not self.is_initialized:
            raise CloneEditError(
                "no clone to save; initialise a clone (make an edit) first"
            )
        if self._workspace is None:
            raise CloneEditError(
                "save-as requires a workspace; the substrate was launched "
                "without one"
            )
        safe = self._validate_save_as_name(name)
        written: list[str] = []
        for clone_path in self.clone_paths:
            dest = self._workspace / f"{safe}{clone_path.suffix}"
            # Defence in depth: the dest must resolve inside the workspace.
            self._assert_within_workspace(dest)
            shutil.copy2(clone_path, dest)
            written.append(str(dest))
        return CloneSaveAsResult(name=safe, files=written)

    def _validate_save_as_name(self, name: str) -> str:
        if not isinstance(name, str) or not _SAVE_AS_NAME_RE.match(name):
            raise CloneEditError(
                f"invalid save-as name {name!r}; names must be 1-64 chars of "
                "[A-Za-z0-9._-] starting with an alphanumeric (no path "
                "separators or traversal)"
            )
        return name

    def _assert_within_workspace(self, dest: Path) -> None:
        assert self._workspace is not None
        workspace = self._workspace.resolve()
        try:
            dest.resolve().relative_to(workspace)
        except ValueError as exc:
            raise CloneEditError(
                f"save-as target resolves outside the workspace: {dest}"
            ) from exc

    def reset_clone(self) -> None:
        """Discard the clone: delete the clone dir + revert to the originals.

        After reset the next edit re-initialises a fresh clone from the
        original files. Reloads the System from the originals so the live
        state matches. Idempotent — resetting an uninitialised clone is a
        no-op beyond clearing the stacks.
        """
        if self.clone_dir is not None and self.clone_dir.exists():
            shutil.rmtree(self.clone_dir)
        self.clone_dir = None
        self.clone_paths = []
        self.original_paths = []
        self.is_initialized = False
        self.undo_stack = []
        self.redo_stack = []
        # Revert the live System to the original files. ``reload_case`` re-runs
        # ``andes.load(setup=False)`` against the wrapper's ``_case_path`` —
        # which still points at the originals (the clone never rebinds it).
        if getattr(self._wrapper, "_case_path", None) is not None:
            self._wrapper.reload_case()

    # ----- diff (Unit 23) -----

    def clone_diff(self, model: str, idx: str) -> CloneDiffResult:
        """Diff the clone-file values vs the original-file values for one device.

        Returns the whitelisted controller params whose value in the clone file
        differs from the original file, each as ``{original, current}``. When no
        clone is initialised (no edits yet) the result is empty — there is
        nothing to diff. The comparison loads BOTH file sets with
        ``andes.load(setup=False)`` and reads each param's ``.v[i]`` for the
        device (file value, pre-normalisation), then compares.

        ``model`` must be a whitelisted dynamic-controller class (defence in
        depth — the route validates first). An unknown device idx yields an
        empty diff (the device simply has no params to compare).
        """
        self._validate_whitelist_model(model)
        if not self.is_initialized or not self.clone_paths:
            return CloneDiffResult()

        params = allowed_param_names(model)
        original_values = self._load_file_values(self.original_paths, model, idx, params)
        clone_values = self._load_file_values(self.clone_paths, model, idx, params)

        diff: dict[str, dict[str, Any]] = {}
        for param in params:
            original = original_values.get(param)
            current = clone_values.get(param)
            if original is None and current is None:
                continue
            if not _values_equal(original, current):
                diff[param] = {"original": original, "current": current}
        return CloneDiffResult(params=diff)

    def _validate_whitelist_model(self, model: str) -> None:
        """Whitelist the ``model`` only (the diff has no per-param input)."""
        if model not in _CONTROLLER_MODEL_SET:
            raise ElementValidationError(
                f"{model!r} is not a dynamic-controller model; clone diffing "
                "is only for controller params."
            )

    @staticmethod
    def _load_file_values(
        paths: list[Path], model: str, idx: str, params: tuple[str, ...]
    ) -> dict[str, Any]:
        """Read ``<model>.<param>.v[i]`` (pre-setup) for ``idx`` from ``paths``.

        Loads with ``setup=False`` so the values are the file values, not the
        per-unit-normalised post-setup live values. Returns a param→value map
        for the params present on the device; absent / unmatched params are
        simply omitted.
        """
        import andes  # heavy import — kept lazy

        if not paths:
            return {}
        case = paths[0]
        addfiles = [str(p) for p in paths[1:]] or None
        ss = andes.load(
            str(case),
            addfile=addfiles,
            setup=False,
            no_output=True,
            default_config=True,
        )
        if ss is None:
            return {}
        model_obj = getattr(ss, model, None)
        if model_obj is None:
            return {}
        idx_values = _values_of(model_obj, "idx")
        idx_str = str(idx)
        try:
            i = next(
                pos for pos, value in enumerate(idx_values) if str(value) == idx_str
            )
        except StopIteration:
            return {}
        out: dict[str, Any] = {}
        for param in params:
            values = _values_of(model_obj, param)
            if i < len(values):
                out[param] = _jsonable(values[i])
        return out

    # ----- reload helper -----

    def _reload_from_clone(self) -> None:
        """Re-load the System from the clone files: ``load(setup=False)`` + setup.

        Points ``andes.load`` at the cloned case + cloned addfiles so PF / TDS
        / etc. run against the edited files. Surfaces a setup failure as the
        wrapper's typed :class:`SetupFailedError` (caught by ``apply_edit`` for
        the atomic-restore path).
        """
        import andes  # heavy import — kept lazy

        if not self.clone_paths:
            raise CloneEditError("no clone files to reload")
        clone_case = self.clone_paths[0]
        clone_addfiles = [str(p) for p in self.clone_paths[1:]] or None

        ss = andes.load(
            str(clone_case),
            addfile=clone_addfiles,
            setup=False,
            no_output=True,
            default_config=True,
        )
        if ss is None:
            raise CloneEditError(
                f"andes.load returned None for clone {clone_case.name!r}"
            )
        # Rebind the wrapper's System to the clone-loaded one, then commit
        # setup so runs are ready. ``_bind_clone_system`` mirrors the state
        # reset ``load_case`` performs (without re-pointing ``_case_path`` at
        # the clone — the original path must survive for reset_clone()).
        self._wrapper._bind_clone_system(ss)  # noqa: SLF001 — internal by design


def _values_of(model_obj: Any, attr: str) -> list[Any]:
    """Return ``model_obj.<attr>.v`` as a plain list (numpy-array-safe).

    Avoids ``array or []`` truthiness ambiguity by checking ``is None``
    explicitly before ``list(...)``.
    """
    param = getattr(model_obj, attr, None)
    if param is None:
        return []
    values = getattr(param, "v", None)
    if values is None:
        return []
    try:
        return list(values)
    except TypeError:
        return []


def _values_equal(original: Any, current: Any) -> bool:
    """Compare two file values with a float tolerance.

    Numeric values are compared with ``math.isclose`` so a float round-trip
    through the file writer (e.g. ``0.49`` → ``0.49``) is treated as unchanged;
    non-numeric values fall back to ``==``.
    """
    if isinstance(original, bool) or isinstance(current, bool):
        return bool(original == current)
    if isinstance(original, int | float) and isinstance(current, int | float):
        return math.isclose(
            float(original), float(current), rel_tol=1e-9, abs_tol=1e-12
        )
    return bool(original == current)


def _jsonable(value: Any) -> Any:
    """Coerce a numpy / Python scalar read back from the System to a JSON
    primitive for the edit response."""
    if value is None:
        return None
    if isinstance(value, bool | int | float | str):
        return value
    item = getattr(value, "item", None)
    if callable(item):
        try:
            return _jsonable(item())
        except (TypeError, ValueError):
            return str(value)
    return str(value)
