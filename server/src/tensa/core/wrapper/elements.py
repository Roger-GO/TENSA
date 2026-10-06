"""Adding, editing, deleting, undoing and redoing topology elements."""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import asdict
from typing import TYPE_CHECKING, Any, Literal

from tensa.core.case_events import event_from_spec
from tensa.core.edit_log import (
    AddOp,
    DeleteOp,
    DeviceRef,
    DroppedDisturbance,
    EditOp,
    dependents,
    held_idx,
    is_event,
    plain_idx,
    spec_targets,
)
from tensa.core.errors import (
    DisturbanceCommitError,
    ElementHasDependentsError,
    ElementNotFoundError,
    ElementValidationError,
    SetupFailedError,
)
from tensa.core.esd1 import MODEL as ESD1_MODEL
from tensa.core.esd1 import check_edit as check_esd1_edit
from tensa.core.esd1 import log_base_notice as log_esd1_base_notice
from tensa.core.esd1 import prepare_add as prepare_esd1_add
from tensa.core.wrapper.base import _sanitize_message
from tensa.core.wrapper.case import CaseMixin
from tensa.core.wrapper.params import _PARAMS_BY_MODEL, allowed_param_names
from tensa.core.wrapper.results import (
    DeletedDisturbance,
    DeleteResult,
    TopologyEntry,
    TopologySnapshot,
)
from tensa.core.wrapper.topology import _system_base_mva

if TYPE_CHECKING:
    from andes.system import System


class ElementsMixin(CaseMixin):
    """Add, change and delete topology elements, and undo or redo any of them.

    Every edit goes through the edit log (``tensa.core.edit_log``), which is how a
    System is built again with an edit taken back."""

    @classmethod
    def _native_references(cls, ss: Any, model: str, params: dict[str, Any]) -> None:
        """Give each device reference in ``params`` the idx the case holds, in place.

        A reference names another device by its idx: a load's ``bus``, a
        machine's ``gen``, an exciter's ``syn``. A JSON client sends an idx as
        text (the web form sends every one that way) while a RAW or xlsx case
        holds integers. ANDES takes the text at ``add()`` and fails only inside
        ``setup()`` ("device not exist with idx=5"), which leaves the session
        needing a reload. Which params are references, and to which group or
        model, is read from the model's own ``IdxParam`` declarations, so every
        model the builder takes is covered. A value that names no device is
        left as it is, for ANDES to refuse in its own words.
        """
        idx_params = getattr(getattr(ss, model, None), "idx_params", None)
        if not isinstance(idx_params, dict):
            return
        for name, param in idx_params.items():
            raw = params.get(name)
            if raw is None or isinstance(raw, bool):
                continue
            candidates = cls._reference_targets(ss, getattr(param, "model", None))
            if not candidates:
                continue
            try:
                if raw in candidates:
                    continue
            except (TypeError, ValueError):  # pragma: no cover - exotic idx types
                pass
            raw_str = str(raw)
            for candidate in candidates:
                if str(candidate) == raw_str:
                    params[name] = candidate
                    break

    @staticmethod
    def _reference_targets(ss: Any, target: Any) -> list[Any]:
        """The idx of every device a reference to ``target`` can name.

        ``target`` is what ANDES's ``IdxParam.model`` holds: a group
        (``ACNode``, ``StaticGen``, ``SynGen``) or a single model (``Bus``).
        Empty when it is neither, or when nothing of that kind exists yet.
        """
        if not isinstance(target, str):
            return []
        group = getattr(ss, "groups", {}).get(target)
        if group is not None:
            return list(group.get_all_idxes())
        target_model = getattr(ss, "models", {}).get(target)
        idx_values = getattr(getattr(target_model, "idx", None), "v", None)
        return list(idx_values) if idx_values else []

    def _inject_line_voltage_base(self, ss: Any, params: dict[str, Any]) -> None:
        """Fill a Line/Transformer's Vn1/Vn2 from its connected buses and Sn
        from the system MVA base, in-place, when the caller omitted them.

        ANDES rebases line r/x/b from (Sn, Vn1) to the system base; if Vn1/Vn2
        default to 110 kV instead of the actual bus voltages, system-base
        impedances are mangled and PF diverges (see add_element). Deriving the
        base from the buses makes entered system-base impedances correct and
        makes a Vn1≠Vn2 pair read as a transformer automatically.
        """
        bus = getattr(ss, "Bus", None)
        if bus is None:
            return

        def _bus_vn(bus_idx: Any) -> float | None:
            try:
                uid = bus.idx2uid(bus_idx)
                return float(bus.Vn.v[uid])
            except Exception:  # noqa: BLE001 — best-effort derivation
                return None

        if "Vn1" not in params and params.get("bus1") is not None:
            vn1 = _bus_vn(params["bus1"])
            if vn1 is not None:
                params["Vn1"] = vn1
        if "Vn2" not in params and params.get("bus2") is not None:
            vn2 = _bus_vn(params["bus2"])
            if vn2 is not None:
                params["Vn2"] = vn2
        if "Sn" not in params:
            mva = getattr(getattr(ss, "config", None), "mva", None)
            if mva is not None:
                params["Sn"] = float(mva)

    def add_element(
        self, model: str, params: dict[str, Any]
    ) -> TopologyEntry:
        """Add a topology element (Bus, Line, generator, load, shunt) to the
        pre-setup System.

        Mirrors ``add_disturbance``'s pre-setup gate. Whitelists every key in
        ``params`` against ``_PARAMS_BY_MODEL[model]`` BEFORE invoking
        ``ss.add(...)`` so unknown keys never reach ANDES. On success,
        records the call in ``self._edit_log`` so it can be taken back
        (``undo_last_edit``) and a blank session can recover via
        ``reload_case()``.

        Returns a freshly-built ``TopologyEntry`` for the new element.
        """
        ss = self._require_editable()
        self._require_room_in_edit_log()

        allowed = allowed_param_names(model)
        if not allowed:
            raise ElementValidationError(
                f"unknown model {model!r}; supported models: "
                f"{sorted(_PARAMS_BY_MODEL.keys())}"
            )
        unknown = sorted(set(params.keys()) - set(allowed))
        if unknown:
            raise ElementValidationError(
                f"unknown param keys for {model}: {unknown}; "
                f"allowed keys: {list(allowed)}"
            )

        # A reference sent as text ("5") must name the device the case holds as
        # an integer (5), or setup() fails later. Done before anything reads a
        # reference, the line's voltage base below included.
        self._native_references(ss, model, params)

        # A Line/Transformer's r/x/b are per-unit on the line's own voltage base
        # (Vn1/Vn2) and MVA base (Sn). When a researcher builds from scratch and
        # only gives bus1/bus2 + r/x, ANDES defaults Vn1/Vn2 to 110 kV, so the
        # entered system-base impedances get RE-BASED against the wrong voltage
        # (e.g. 0.0576 → 2.56 for a 16.5 kV terminal) and power flow diverges.
        # Derive the voltage base from the connected buses and the MVA base from
        # the system, so impedances entered on the system base are interpreted
        # correctly. The form doesn't surface Vn1/Vn2, so this server-side
        # derivation is the single source of truth. Only fills when absent — an
        # explicit Vn1/Vn2/Sn from the caller still wins.
        if model == "Line":
            self._inject_line_voltage_base(ss, params)

        # ANDES GENROU has no ``H`` parameter — it carries inertia as ``M`` (=2H).
        # The form exposes the more intuitive inertia constant ``H``; convert it
        # to ``M`` so the value actually takes effect (ANDES silently ignored a
        # raw ``H`` field and the machine got a default inertia).
        if model == "GENROU" and "H" in params:
            try:
                params["M"] = 2.0 * float(params.pop("H"))
            except (TypeError, ValueError):
                params.pop("H", None)

        # GENROU reactance-ordering guard: merge the user's params over the
        # ANDES defaults and require xd > xd1 > xd2 > xl (and the q-axis
        # equivalent) BEFORE the device reaches ``ss.add``. ANDES accepts a
        # violating set silently and the TDS later goes numerically unstable;
        # rejecting here with an actionable 422 names the silent default that
        # conflicts with the user's explicit values.
        if model == "GENROU":
            genrou_defaults = {
                name: float(getattr(ss.GENROU, name).default)
                for name in _GENROU_REACTANCE_NAMES
            }
            _validate_genrou_reactances(params, genrou_defaults)

        # An ESD1 battery left without a rating gets the system base, and its
        # values and its static generator are checked here: ANDES takes them
        # all and the run fails, or misleads, later (``tensa.core.esd1``).
        if model == ESD1_MODEL:
            prepare_esd1_add(ss, params, _system_base_mva(ss))

        # ANDES counts the device in before it reads the params, so an add it
        # refuses for a missing mandatory one leaves a half-built device on the
        # System (an idx with param lists one short), and the next setup, power
        # flow or time-domain run fails on the mismatched lists. Refused here,
        # nothing has been touched.
        missing = _missing_mandatory(ss, model, params)
        if missing:
            raise ElementValidationError(
                f"{model} cannot be added without {', '.join(missing)}: ANDES has "
                f"no default for {'it' if len(missing) == 1 else 'them'}"
            )

        # Snapshot the params for replay BEFORE ANDES gets a chance to
        # mutate the dict in-place — ``ss.add`` pops ``idx`` (and possibly
        # other identifier fields) out of the input dict during model
        # registration. Without the pre-call copy, replay would call
        # ``ss.add`` without the idx, and ANDES would auto-prefix the new
        # device's idx (``Bus_1`` instead of ``1``), breaking idempotent
        # reload.
        replay_snapshot = dict(params)
        try:
            idx = ss.add(model, params)
        except Exception as exc:  # noqa: BLE001
            raise ElementValidationError(
                f"ANDES rejected add({model!r}, ...): {_sanitize_message(str(exc))}"
            ) from exc
        self._record_add(model, replay_snapshot, idx)

        if model == ESD1_MODEL:
            log_esd1_base_notice(idx, replay_snapshot.get("Sn"), _system_base_mva(ss))

        # Build the TopologyEntry from the just-added device.
        entry = self._lookup_topology_entry(model, idx)
        if entry is None:
            # Defensive — ss.add reported success but the device isn't
            # surfaced via the standard introspection path. This indicates
            # a model whose ANDES introspection differs (e.g., a model
            # we haven't tested). Surface a clear error rather than
            # returning a garbage entry.
            raise ElementValidationError(
                f"ANDES accepted add({model!r}) but no device with idx={idx!r} "
                "was found on read-back"
            )
        return entry

    def edit_element(
        self, model: str, idx: int | str, params: dict[str, Any]
    ) -> TopologyEntry:
        """Edit parameters on an existing topology element.

        Same pre-setup gate as ``add_element``. Whitelists keys against
        ``_PARAMS_BY_MODEL[model]``. For each ``(param, value)`` pair, sets
        ``getattr(getattr(ss, model), param).v[i] = value`` where ``i`` is
        the index of ``idx`` in ``ss.<model>.idx.v``. What was written goes
        into ``self._edit_log``, so the change survives a rebuild of the
        System and can be taken back.

        Returns the updated ``TopologyEntry``.
        """
        ss = self._require_editable()

        allowed = allowed_param_names(model)
        if not allowed:
            raise ElementValidationError(
                f"unknown model {model!r}; supported models: "
                f"{sorted(_PARAMS_BY_MODEL.keys())}"
            )
        unknown = sorted(set(params.keys()) - set(allowed))
        if unknown:
            raise ElementValidationError(
                f"unknown param keys for {model}: {unknown}; "
                f"allowed keys: {list(allowed)}"
            )

        model_obj = getattr(ss, model, None)
        if model_obj is None:
            raise ElementValidationError(
                f"model {model!r} not present on the loaded System"
            )
        idx_var = getattr(model_obj, "idx", None)
        idx_values = list(getattr(idx_var, "v", []) if idx_var is not None else [])
        # Look up the device by string-equality on idx, since idx values can
        # be ints (from PSS/E .raw) or strings (from .xlsx) and the API
        # surface always passes them as strings.
        idx_str = str(idx)
        try:
            i = next(
                pos for pos, value in enumerate(idx_values) if str(value) == idx_str
            )
        except StopIteration as exc:
            raise ElementNotFoundError(
                f"no {model} with idx={idx!r}"
            ) from exc

        # A changed reference gets the idx the case holds, as an add's does.
        params = dict(params)
        self._native_references(ss, model, params)

        if model == "GENROU":
            params = self._genrou_edit_params(model_obj, i, params)

        # Every value is checked before any is written, so a refused one leaves
        # the device as it was.
        from andes.core.param import NumParam

        writes: list[tuple[str, Any, Any]] = []
        for pname, value in params.items():
            if pname in ("idx", "name"):
                # idx / name updates are not safe at the array-write level —
                # they would desync internal indexes. Reject explicitly.
                raise ElementValidationError(
                    f"editing {pname!r} is not supported; create a new "
                    f"element instead"
                )
            param = getattr(model_obj, pname, None)
            param_v = getattr(param, "v", None) if param is not None else None
            if param_v is None:
                raise ElementValidationError(
                    f"param {pname!r} not editable on {model}"
                )
            if isinstance(param, NumParam):
                value = _edit_number(model, pname, value)
            writes.append((pname, param_v, value))

        if model == ESD1_MODEL:
            check_esd1_edit(ss, i, {pname: value for pname, _, value in writes})

        self._require_room_in_edit_log()
        written: dict[str, Any] = {}
        try:
            for pname, param_v, value in writes:
                try:
                    # ANDES service params expose .v as a numpy array — direct
                    # element write is the documented way to alter a single
                    # device's parameter.
                    param_v[i] = value
                except Exception as exc:  # noqa: BLE001
                    raise ElementValidationError(
                        f"ANDES rejected {model}.{pname}={value!r}: "
                        f"{_sanitize_message(str(exc))}"
                    ) from exc
                written[pname] = value
        finally:
            # Recorded even when a later value was refused: the System holds
            # the ones before it, and the log has to say what the System holds.
            if written:
                self._edit_log.append(EditOp(model=model, idx=idx_values[i], params=written))
                self._redo_log = []

        if model == ESD1_MODEL and "Sn" in params:
            log_esd1_base_notice(idx_values[i], params["Sn"], _system_base_mva(ss))

        entry = self._lookup_topology_entry(model, idx_values[i])
        if entry is None:  # pragma: no cover — should never happen post-write
            raise ElementValidationError(
                f"could not read back {model} idx={idx!r} after edit"
            )
        return entry

    @staticmethod
    def _genrou_edit_params(
        model_obj: Any, i: int, params: dict[str, Any]
    ) -> dict[str, Any]:
        """The params of a GENROU edit as ANDES holds them.

        The schema offers the inertia constant ``H``, which ANDES has no param
        for: it holds ``M`` (= 2H), as ``add_element`` converts it. A table
        that lists ``H`` has to be able to write it back, so the edit takes it
        too. An edit giving both ``H`` and ``M`` is refused, since the two say
        the same thing and could disagree; a caller that holds both (the
        tables do) sends the one that changed. ``H`` must be a number above
        zero. A change to a reactance is checked against the ordering the
        machine needs (see ``_validate_genrou_reactance_edit``) on the values
        the machine holds.
        """
        edited = dict(params)
        if "H" in edited:
            if "M" in edited:
                raise ElementValidationError(
                    "set the inertia as H or as M (M = 2H), not both in one edit"
                )
            raw_h = edited.pop("H")
            try:
                if isinstance(raw_h, bool):
                    raise TypeError("a boolean is not a number")
                h = float(raw_h)
            except (TypeError, ValueError) as exc:
                raise ElementValidationError(
                    f"GENROU param 'H' must be a number; got {raw_h!r}"
                ) from exc
            if not math.isfinite(h) or h <= 0.0:
                raise ElementValidationError(
                    f"GENROU param 'H' must be a number above zero; got {raw_h!r}"
                )
            edited["M"] = 2.0 * h
        if any(name in edited for name in _GENROU_REACTANCE_NAMES):
            current: dict[str, float] = {}
            for name in _GENROU_REACTANCE_NAMES:
                param = getattr(model_obj, name, None)
                values = getattr(param, "v", None)
                held = (
                    values[i]
                    if values is not None and i < len(values)
                    else getattr(param, "default", 0.0)
                )
                try:
                    current[name] = float(held)
                except (TypeError, ValueError) as exc:
                    raise ElementValidationError(
                        f"GENROU {name} holds {held!r}, which is not a number; "
                        "set it to one before changing the reactances"
                    ) from exc
            _validate_genrou_reactance_edit(current, edited)
        return edited

    def _require_editable(self) -> System:
        """The loaded System, which every edit needs to find before ``setup()``."""
        ss = self._require_loaded()
        if self._setup_failed:
            raise SetupFailedError(
                "previous setup() failed; the System is in an inconsistent state"
            )
        if ss.is_setup:
            raise DisturbanceCommitError()
        return ss

    def _require_undoable(self) -> System:
        """The loaded System, for an undo: not one that is set up.

        Unlike an edit, an undo builds the System again, so it is also the way
        out of one whose ``setup()`` failed.
        """
        ss = self._require_loaded()
        if ss.is_setup and not self._setup_failed:
            raise DisturbanceCommitError()
        return ss

    def _require_room_in_edit_log(self) -> None:
        """Refuse an edit the log has no room to record.

        An entry dropped to make room would change what the next rebuild
        gives (an element back that was deleted, a value back that was
        changed), so the edit is refused instead, before it touches anything.
        """
        if len(self._edit_log) >= EDIT_LOG_MAX:
            raise ElementValidationError(
                f"this session holds {EDIT_LOG_MAX} edits, the most it keeps to "
                "rebuild the system from. Save the case and open the saved file "
                "to go on editing"
            )

    def _record_add(self, model: str, params: dict[str, Any], idx: int | str) -> None:
        """Note a device ``ss.add`` just took, with the idx ANDES gave it.

        The idx is recorded also when the caller left it to ANDES, so a replay
        gives the device the same one whatever the System holds by then.
        """
        self._edit_log.append(AddOp(model=model, params={**params, "idx": idx}))
        self._redo_log = []

    def undo_last_edit(self) -> TopologySnapshot:
        """Take back the last edit: an element added, changed or deleted.

        The System is built again from the case file (or from nothing, for a
        blank session) and every recorded edit but the last, so the edits
        before it stay, and so do the pending disturbances, which are added
        to the new System. The edit goes to ``redo_edit``. Undoing a delete
        also puts back the pending disturbances the delete dropped.

        A System whose ``setup()`` failed can be undone out of that state,
        since the rebuild replaces it; one that is set up cannot, as with any
        other edit (``DisturbanceCommitError``).

        Raises ``ElementValidationError`` when there is nothing to undo, or
        when the edit added an element a pending disturbance now acts on.
        """
        ss = self._require_undoable()
        if not self._edit_log:
            raise ElementValidationError("no edits to undo")
        op = self._edit_log[-1]
        kept = self._edit_log[:-1]
        disturbances = list(self._disturbance_log)
        restored_events = list(self._restored_events)
        if isinstance(op, AddOp):
            acting = [
                spec
                for spec in disturbances
                if spec_targets(ss, spec, [(op.model, op.params["idx"])])
            ]
            if acting:
                raise ElementValidationError(
                    f"cannot undo the addition of {op.model} {op.params['idx']!r}: "
                    f"{len(acting)} pending disturbance(s) act on it. Reload the "
                    "case to clear them first"
                )
        elif isinstance(op, DeleteOp):
            for dropped in sorted(op.dropped, key=lambda d: d.position):
                disturbances.insert(min(dropped.position, len(disturbances)), dropped.spec)
            for dropped in sorted(
                (d for d in op.dropped if d.restored_position is not None),
                key=lambda d: d.restored_position or 0,
            ):
                assert dropped.restored_position is not None
                restored_events.insert(
                    min(dropped.restored_position, len(restored_events)),
                    event_from_spec(dropped.spec),
                )
        self._adopt_system(
            self._build_system(kept),
            edit_log=kept,
            redo_log=[*self._redo_log, op],
            disturbances=disturbances,
            restored_events=restored_events,
        )
        return self._topology_snapshot_locked()

    def redo_edit(self) -> TopologySnapshot:
        """Put back the edit ``undo_last_edit`` took back last.

        The System is built again with the edit as the last one. A delete is
        done again as a delete, and takes with it what it took the first time.
        If something else has come to depend on the element since (a
        disturbance committed in between), it is refused with that, as a first
        delete would be (``ElementHasDependentsError``). Raises
        ``ElementValidationError`` when there is nothing to redo.
        """
        self._require_editable()
        if not self._redo_log:
            raise ElementValidationError("no edits to redo")
        op = self._redo_log[-1]
        remaining = self._redo_log[:-1]
        if isinstance(op, DeleteOp):
            self._delete(op.model, op.idx, cascade=True, again=op)
            self._redo_log = remaining
        else:
            ops = [*self._edit_log, op]
            self._adopt_system(
                self._build_system(ops),
                edit_log=ops,
                redo_log=remaining,
                disturbances=self._disturbance_log,
                restored_events=self._restored_events,
            )
        return self._topology_snapshot_locked()

    def delete_element(
        self, model: str, idx: int | str, *, cascade: bool = False
    ) -> DeleteResult:
        """Delete one element of the System, whether the case file brought it
        or this session added it.

        ``model`` is any ANDES model the System has a device of. A device that
        ``add_disturbance`` put there is not one: it is a pending disturbance,
        which a reload clears.

        What depends on the element cannot stay without it: the devices that
        name it (a line on a bus, a machine on a static generator, an exciter
        on that machine, and so on down), and the disturbances that act on
        any of those, whether the case file defines them, a bundle or a
        snapshot replayed them, or a client committed them. With any of
        those, the delete is refused with ``ElementHasDependentsError``,
        which lists them, unless ``cascade`` is true, in which case they all
        go with it.

        The System is built again from the case file and the recorded edits
        with the delete as the last of them, so the case file is not written,
        the pending disturbances that remain are added to the new System, and
        ``undo_last_edit`` brings everything back. A failure leaves the
        session as it was.

        Raises ``ElementValidationError`` for a model ANDES does not have,
        ``ElementNotFoundError`` when the System holds no such device.
        """
        self._require_editable()
        self._require_room_in_edit_log()
        result = self._delete(model, idx, cascade=cascade)
        self._redo_log = []
        return result

    def _delete(
        self,
        model: str,
        idx: int | str,
        *,
        cascade: bool,
        again: DeleteOp | None = None,
    ) -> DeleteResult:
        """``delete_element`` without its gates, shared with ``redo_edit``.

        ``again`` is the recorded delete a redo does again. The cascade a
        redo asks for is the one that delete made: anything else that would
        have to go with the element now is in the way.
        """
        live = self._require_loaded()
        # Membership in ``ss.models`` is the whitelist: the name never reaches
        # an attribute lookup unless ANDES has a model called that.
        if model not in live.models:
            raise ElementValidationError(
                f"unknown model {model!r}; the loaded System has devices of: "
                f"{sorted(name for name, m in live.models.items() if m.n)}"
            )
        target_idx = held_idx(live.models[model], idx)
        if target_idx is None:
            raise ElementNotFoundError(f"no {model} with idx={idx!r}")
        target: DeviceRef = (model, target_idx)
        if target in self._client_events:
            raise ElementValidationError(
                f"{model} {target_idx!r} is a disturbance committed for the next "
                "run, not part of the case. Reload the case to clear the "
                "committed disturbances"
            )

        # Looked up on the live System so a refusal costs no reload. The
        # client's own disturbance devices are left out here and found among
        # the pending specs instead.
        bound = [
            ref
            for ref in dependents(live, model, target_idx)
            if ref not in self._client_events
        ]
        elements = [ref for ref in bound if not is_event(live, ref[0])]
        case_events = [ref for ref in bound if is_event(live, ref[0])]
        going = [target, *elements]
        dropped: list[DroppedDisturbance] = []
        # A pending disturbance that a bundle or a snapshot replayed is also
        # in ``_restored_events``; it leaves that list with the spec.
        kept_restored = list(range(len(self._restored_events)))
        for position, spec in enumerate(self._disturbance_log):
            if not spec_targets(live, spec, going):
                continue
            event = event_from_spec(spec)
            restored_position = next(
                (i for i in kept_restored if self._restored_events[i] == event), None
            )
            if restored_position is not None:
                kept_restored.remove(restored_position)
            dropped.append(
                DroppedDisturbance(
                    position=position, spec=spec, restored_position=restored_position
                )
            )
        disturbances = [
            *(self._deleted_event(live, ref) for ref in case_events),
            *(self._deleted_spec(d) for d in dropped),
        ]
        entries = [
            entry
            for entry in (self._lookup_topology_entry(m, i) for m, i in elements)
            if entry is not None
        ]

        # What the caller did not ask to lose: all of it without ``cascade``,
        # and for a redo what the delete did not take the first time.
        unasked_entries, unasked_disturbances = entries, disturbances
        if again is not None:
            taken = set(again.devices)
            taken_specs = [d.spec for d in again.dropped]
            unasked_entries = [e for e in entries if (e.kind, e.idx) not in taken]
            unasked_disturbances = [
                self._deleted_event(live, ref) for ref in case_events if ref not in taken
            ]
            for d in dropped:
                if d.spec in taken_specs:
                    taken_specs.remove(d.spec)
                else:
                    unasked_disturbances.append(self._deleted_spec(d))
        elif cascade:
            unasked_entries, unasked_disturbances = [], []
        if unasked_entries or unasked_disturbances:
            raise ElementHasDependentsError(
                model=model,
                idx=target_idx,
                # Plain dicts, so the error can cross the worker Pipe without
                # a dataclass import on the parent side.
                dependents=[
                    {"idx": e.idx, "name": e.name, "kind": e.kind, "params": dict(e.params)}
                    for e in unasked_entries[:DELETE_DEPENDENTS_CAP]
                ],
                total=len(unasked_entries),
                disturbances=[
                    asdict(d) for d in unasked_disturbances[:DELETE_DEPENDENTS_CAP]
                ],
                disturbances_total=len(unasked_disturbances),
            )

        target_entry = self._lookup_topology_entry(model, target_idx)
        # The dependents go before what they depend on, the case's events
        # first of all, so no entry of the log leaves a reference dangling.
        op = DeleteOp(
            model=model,
            idx=target_idx,
            devices=(*case_events, *reversed(elements), target),
            dropped=tuple(dropped),
        )
        ops = [*self._edit_log, op]
        gone = {d.position for d in dropped}
        self._adopt_system(
            self._build_system(ops),
            edit_log=ops,
            redo_log=self._redo_log,
            disturbances=[
                spec for i, spec in enumerate(self._disturbance_log) if i not in gone
            ],
            restored_events=[self._restored_events[i] for i in kept_restored],
        )
        deleted = [*entries]
        if target_entry is not None:
            deleted.append(target_entry)
        return DeleteResult(
            topology=self._topology_snapshot_locked(),
            deleted=deleted,
            disturbances=disturbances,
        )

    @staticmethod
    def _deleted_event(ss: Any, ref: DeviceRef) -> DeletedDisturbance:
        """One of the case's own ``Fault`` / ``Toggle`` / ``Alter`` devices, as a delete reports it."""
        model, idx = ref
        model_obj = ss.models[model]
        position = list(model_obj.idx.v).index(idx)

        def held(name: str) -> Any:
            values = getattr(getattr(model_obj, name, None), "v", None)
            return None if values is None or position >= len(values) else values[position]

        # As ``tensa.core.case_events`` reads them: a device that is switched
        # off, or whose time is below zero, never fires.
        t: float | None
        try:
            t = float(held("tf" if model == "Fault" else "t"))
            if not t >= 0 or (held("u") is not None and float(held("u")) == 0):
                t = None
        except (TypeError, ValueError):
            t = None
        kind: Literal["fault", "toggle", "alter"] = (
            "fault" if model == "Fault" else "toggle" if model == "Toggle" else "alter"
        )
        return DeletedDisturbance(
            source="case",
            kind=kind,
            model="Bus" if model == "Fault" else _text_or_none(held("model")),
            dev_idx=plain_idx(held("bus" if model == "Fault" else "dev")),
            t=t,
            name=_text_or_none(held("name")),
        )

    def _deleted_spec(self, dropped: DroppedDisturbance) -> DeletedDisturbance:
        """A pending disturbance, as a delete reports it."""
        event = event_from_spec(dropped.spec)
        return DeletedDisturbance(
            source="committed" if dropped.restored_position is None else "restored",
            kind=event.kind,
            model=event.model,
            dev_idx=event.dev_idx,
            t=event.t,
        )


# Cap on the per-session edit log. An edit past it is refused (see
# ``Wrapper._require_room_in_edit_log``). A system built element by element
# takes a few entries per bus, so this leaves room for one of a few thousand
# buses, and replaying the whole log stays a fraction of a second.
EDIT_LOG_MAX = 10_000


# Maximum number of dependents, and of disturbances, returned in the 422
# ``DeleteBlockedResponse`` body. The full counts are reported separately as
# ``total`` and ``disturbances_total`` so the UI can render a "Showing 25 of N"
# footer when truncated. 25 is enough to see what a delete would take with it
# on any realistic case.
DELETE_DEPENDENTS_CAP = 25


def _missing_mandatory(ss: Any, model: str, params: Mapping[str, Any]) -> list[str]:
    """The params ANDES marks mandatory for ``model`` that ``params`` leaves out.

    What ANDES's own ``add`` would refuse, found before it runs: a param flagged
    ``mandatory`` whose value is absent, ``None`` or NaN.
    """
    declared = getattr(getattr(ss, model, None), "params", None)
    if not isinstance(declared, dict):
        return []
    missing: list[str] = []
    for name, param in declared.items():
        get_property = getattr(param, "get_property", None)
        if not callable(get_property) or not get_property("mandatory"):
            continue
        value = params.get(name)
        if value is None or (isinstance(value, float) and math.isnan(value)):
            missing.append(str(name))
    return missing


# GENROU reactance-ordering chains. Standard round-rotor machine physics:
# synchronous > transient > subtransient > leakage, on both axes. ANDES does
# not enforce this at ``ss.add`` time; a violation only surfaces later as a
# numerically unstable (or outright wrong) TDS.
_GENROU_REACTANCE_CHAINS: tuple[tuple[str, ...], ...] = (
    ("xd", "xd1", "xd2", "xl"),
    ("xq", "xq1", "xq2", "xl"),
)


# All GENROU reactance params participating in the ordering check.
_GENROU_REACTANCE_NAMES: tuple[str, ...] = (
    "xl", "xd", "xq", "xd1", "xq1", "xd2", "xq2",
)


def _validate_genrou_reactances(
    params: Mapping[str, Any], defaults: Mapping[str, float]
) -> None:
    """Validate GENROU reactance ordering on the user+default merged set.

    ``params`` is the user's (whitelisted) add-element payload; ``defaults``
    maps each reactance name to the ANDES default that applies when the user
    omitted it. The merged values must satisfy the d-axis chain
    ``xd > xd1 > xd2 > xl`` and the q-axis chain ``xq > xq1 > xq2 > xl``.

    The danger scenario this protects against: a researcher enters textbook
    *transient* values (e.g. ``xd1=0.0608``) without the subtransient set, so
    ANDES's defaults (``xd2=0.3``) silently violate the ordering and the TDS
    goes numerically unstable. The error message names the offending pair,
    flags which value is a silent default, and says how to fix it.

    Raises :class:`ElementValidationError` (→ HTTP 422) on violation.
    """
    merged: dict[str, float] = {}
    user_set: set[str] = set()
    for name in _GENROU_REACTANCE_NAMES:
        if name in params and params[name] is not None:
            try:
                merged[name] = float(params[name])
            except (TypeError, ValueError) as exc:
                raise ElementValidationError(
                    f"GENROU param {name!r} must be a number; "
                    f"got {params[name]!r}"
                ) from exc
            user_set.add(name)
        else:
            merged[name] = float(defaults.get(name, 0.0))

    for chain in _GENROU_REACTANCE_CHAINS:
        for hi, lo in zip(chain, chain[1:], strict=False):
            if merged[hi] > merged[lo]:
                continue
            chain_str = " > ".join(chain)
            silent_defaults = [n for n in (hi, lo) if n not in user_set]
            if silent_defaults:
                origin = (
                    f" ({' and '.join(silent_defaults)} "
                    f"{'is the ANDES default' if len(silent_defaults) == 1 else 'are the ANDES defaults'} "
                    "because you did not set "
                    f"{'it' if len(silent_defaults) == 1 else 'them'})"
                )
            else:
                origin = ""
            raise ElementValidationError(
                f"GENROU reactances must satisfy {chain_str}; "
                f"got {hi}={merged[hi]:g} <= {lo}={merged[lo]:g}{origin}. "
                "Set xd2/xq2 (and Td10/Td20/Tq10/Tq20 as needed) explicitly "
                "to match your machine data, or leave the whole reactance "
                "set at defaults."
            )


def _validate_genrou_reactance_edit(
    current: Mapping[str, float], edits: Mapping[str, Any]
) -> None:
    """Refuse an edit that breaks the GENROU reactance ordering.

    ``current`` holds the machine's reactances as it has them; ``edits`` is the
    edit's params. Only an ordering the edit takes part in is checked, so a case
    whose data already breaks a pair elsewhere does not block an unrelated
    change. A reactance given as null is an error, not a value to skip: the
    machine would hold it as null and the next edit would fail on it. Raises
    :class:`ElementValidationError` (HTTP 422) on a violation, naming the pair.
    """
    merged = dict(current)
    edited: set[str] = set()
    for name in _GENROU_REACTANCE_NAMES:
        if name in edits:
            try:
                merged[name] = float(edits[name])
            except (TypeError, ValueError) as exc:
                raise ElementValidationError(
                    f"GENROU param {name!r} must be a number; got {edits[name]!r}"
                ) from exc
            edited.add(name)
    for chain in _GENROU_REACTANCE_CHAINS:
        for hi, lo in zip(chain, chain[1:], strict=False):
            if hi not in edited and lo not in edited:
                continue
            if merged[hi] > merged[lo]:
                continue
            raise ElementValidationError(
                f"GENROU reactances must satisfy {' > '.join(chain)}; this edit "
                f"leaves {hi}={merged[hi]:g} <= {lo}={merged[lo]:g}. Change the "
                "other reactances in the same edit, so the set stays in order."
            )


def _edit_number(model: str, name: str, value: Any) -> Any:
    """The value an edit gives a numeric ANDES parameter, or a 422.

    A number goes through as it is, and so does a boolean (a status switch such
    as ``u`` takes one). A string that reads as a number is turned into it. What
    is not a number, a null, and a value that is not finite are refused: the
    pre-setup parameter list takes anything, and the case would fail later in
    ANDES, far from the edit that put the value there.
    """
    if isinstance(value, bool):
        return value
    try:
        number = value if isinstance(value, int | float) else float(value)
    except (TypeError, ValueError) as exc:
        raise ElementValidationError(
            f"{model} param {name!r} must be a number; got {value!r}"
        ) from exc
    if isinstance(number, float) and not math.isfinite(number):
        raise ElementValidationError(
            f"{model} param {name!r} must be a finite number; got {value!r}"
        )
    return number


def _text_or_none(value: Any) -> str | None:
    """``value`` as text, with ``None`` left as it is."""
    return None if value is None else str(value)
