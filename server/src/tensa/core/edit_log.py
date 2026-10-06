"""The edits a session makes to its System before setup, kept so they can be replayed.

ANDES has no call that takes a device off a System and none that takes a change
back, so ``Wrapper`` keeps what it did instead: every element added, every
parameter changed and every element deleted since the case was loaded, in order.
The System a session holds before ``setup()`` is the case file (or an empty
System) with that log applied. That one rule is what the rest follows from:

- taking the last edit back is building the System again from the log without it,
  whatever kind of edit it was, and putting it back is building it with it;
- deleting an element the case file brought is one more entry, replayed like the
  others, so the file is never written and the delete can be taken back;
- a blank session's reload replays the whole log, edits and deletes included.

**Removing a device** (:func:`remove_device`) is the one step ANDES has nothing
for. Before ``setup()`` a device is one entry in each of its model's parameter
lists, one position in the model's ``uid`` map and one line in its group's
registry, so removing it is taking those out and numbering what is left again.
Contract 14 in ``server/ANDES_VERSIONS.md`` says what that rests on, and
``tests/integration/test_edit_log.py`` compares the result, on the bundled
cases, with a System that was read from a file that never had the device.

**What depends on a device** (:func:`referrers`, :func:`dependents`) is read from
the models' own declarations, the way ``Wrapper._native_references`` reads them:
an ``IdxParam`` names the group or the model it points into, a ``Toggle``, an
``Alter`` and a ``TimeSeries`` name theirs in a ``model`` param beside the
``dev``, and the few references ANDES declares without a target are listed in
``_UNTYPED_REFERENCES``. A device that is left naming one that is gone makes
``setup()`` fail (a machine without its static generator) or the time-domain run
raise (a ``Toggle`` on a line that is not there), so a delete either takes its
dependents with it or is refused.

The devices of the ``TimedEvent`` group (``Fault``, ``Toggle``, ``Alter``) are the
disturbances of a run. They are told apart from the rest here because a caller
is warned about them rather than asked to delete them one by one.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Literal

from tensa.core.disturbance import DisturbanceSpec, FaultSpec

# A device, as the model that holds it and its idx.
DeviceRef = tuple[str, int | str]

# The group ANDES puts ``Fault``, ``Toggle`` and ``Alter`` in.
EVENT_GROUP = "TimedEvent"

# Models that name what they act on in two params: the model (or group) in one
# and the device in an ``IdxParam`` that declares no target of its own.
_PAIRED_REFERENCES: dict[str, tuple[str, str]] = {
    "Toggle": ("model", "dev"),
    "Alter": ("model", "dev"),
    "TimeSeries": ("model", "dev"),
}

# References ANDES 2.0.0 declares without saying what they point into, with the
# group they do point into (from each model's own description of the param).
_UNTYPED_REFERENCES: dict[tuple[str, str], str] = {
    ("ST2CUT", "busr"): "ACNode",
    ("ST2CUT", "busr2"): "ACNode",
    ("PLL1", "bus"): "ACNode",
    ("PLL2", "bus"): "ACNode",
    ("WTARA1", "rego"): "RenGovernor",
    ("WTARV1", "rego"): "RenGovernor",
    ("WTPTA1", "rea"): "RenAerodynamics",
    ("WTTQA1", "rep"): "RenPitch",
    ("DGPRCT1", "dev"): "DG",
    ("DGPRCTExt", "dev"): "DG",
}

# ``IdxParam`` that hold the name of a parameter, not the idx of a device.
_NOT_REFERENCES: frozenset[tuple[str, str]] = frozenset(
    {("Alter", "src"), ("Alter", "attr")}
)


@dataclass(frozen=True)
class AddOp:
    """One device added: the params ``System.add`` was given, idx included."""

    model: str
    params: dict[str, Any]


@dataclass(frozen=True)
class EditOp:
    """Values written to one device's params, as they were written."""

    model: str
    idx: int | str
    params: dict[str, Any]


@dataclass(frozen=True)
class DroppedDisturbance:
    """A pending disturbance a delete dropped because it acted on what went.

    ``position`` is where it stood in the session's list of pending
    disturbances, and ``restored_position`` where it stood among the ones a
    bundle or a snapshot had replayed (``None`` when the client committed it),
    so taking the delete back puts both back where they were.
    """

    position: int
    spec: DisturbanceSpec
    restored_position: int | None = None


@dataclass(frozen=True)
class DeleteOp:
    """One element deleted, with everything that went with it.

    ``devices`` is every device the delete removes from the System the log is
    replayed on: the element itself, last, after the devices that depended on
    it and the case's own events that acted on any of them. ``dropped`` is not
    replayed (a pending disturbance is not part of that System); it is what
    taking the delete back has to put back.
    """

    model: str
    idx: int | str
    devices: tuple[DeviceRef, ...]
    dropped: tuple[DroppedDisturbance, ...] = ()


Op = AddOp | EditOp | DeleteOp


@dataclass(frozen=True)
class EditStep:
    """What one entry of the log did, for a client to name it.

    ``params`` are the names an edit wrote, and ``also`` is how many devices a
    delete removed besides the one it names.
    """

    op: Literal["add", "edit", "delete"]
    model: str
    idx: int | str | None
    params: tuple[str, ...] = ()
    also: int = 0


def step_of(op: Op) -> EditStep:
    """The step a log entry amounts to."""
    if isinstance(op, AddOp):
        return EditStep(op="add", model=op.model, idx=plain_idx(op.params.get("idx")))
    if isinstance(op, EditOp):
        return EditStep(
            op="edit", model=op.model, idx=plain_idx(op.idx), params=tuple(op.params)
        )
    return EditStep(
        op="delete", model=op.model, idx=plain_idx(op.idx), also=len(op.devices) - 1
    )


# ----- replay -----


def apply_op(ss: Any, op: Op) -> None:
    """Do to ``ss`` what ``op`` records. ``ss`` must not be set up."""
    if isinstance(op, AddOp):
        # A copy: ANDES takes ``idx`` out of the dict it is given.
        ss.add(op.model, dict(op.params))
    elif isinstance(op, EditOp):
        model_obj = ss.models[op.model]
        position = device_position(model_obj, op.idx)
        if position is None:
            raise KeyError(f"no {op.model} with idx={op.idx!r}")
        for name, value in op.params.items():
            getattr(model_obj, name).v[position] = value
    else:
        for model, idx in op.devices:
            remove_device(ss, model, idx)


def ops_to_dicts(ops: Iterable[Op]) -> list[dict[str, Any]]:
    """The log as plain dicts, for another process to replay.

    The pending disturbances a delete dropped are left out: they are not part
    of what a replay builds.
    """
    out: list[dict[str, Any]] = []
    for op in ops:
        if isinstance(op, AddOp):
            out.append({"op": "add", "model": op.model, "params": dict(op.params)})
        elif isinstance(op, EditOp):
            out.append(
                {"op": "edit", "model": op.model, "idx": op.idx, "params": dict(op.params)}
            )
        else:
            out.append(
                {
                    "op": "delete",
                    "model": op.model,
                    "idx": op.idx,
                    "devices": [[model, idx] for model, idx in op.devices],
                }
            )
    return out


def ops_from_dicts(rows: Iterable[Mapping[str, Any]]) -> list[Op]:
    """The log :func:`ops_to_dicts` wrote."""
    ops: list[Op] = []
    for row in rows:
        kind = row.get("op")
        if kind == "add":
            ops.append(AddOp(model=str(row["model"]), params=dict(row["params"])))
        elif kind == "edit":
            ops.append(
                EditOp(model=str(row["model"]), idx=row["idx"], params=dict(row["params"]))
            )
        elif kind == "delete":
            ops.append(
                DeleteOp(
                    model=str(row["model"]),
                    idx=row["idx"],
                    devices=tuple((str(model), idx) for model, idx in row["devices"]),
                )
            )
        else:
            raise ValueError(f"unknown edit {kind!r}")
    return ops


# ----- devices -----


def device_position(model_obj: Any, idx: int | str) -> int | None:
    """Where ``idx`` stands in a model's lists, or ``None`` when it holds no such device.

    An idx is matched as the model holds it (a number as a number, whatever
    integer type ANDES read it into, and text as text) and, failing that, by
    its text: a RAW case holds integers and a client sends text.
    """
    held = _values(getattr(model_obj, "idx", None))
    for position, value in enumerate(held):
        if isinstance(value, str) == isinstance(idx, str) and value == idx:
            return position
    text = str(idx)
    for position, value in enumerate(held):
        if str(value) == text:
            return position
    return None


def held_idx(model_obj: Any, idx: int | str) -> int | str | None:
    """``idx`` as the model holds it, or ``None`` when it holds no such device."""
    position = device_position(model_obj, idx)
    if position is None:
        return None
    held: int | str = plain_idx(model_obj.idx.v[position])
    return held


def is_event(ss: Any, model: str) -> bool:
    """Whether ``model`` is one of the disturbances of a run (``Fault``, ``Toggle``, ``Alter``)."""
    return getattr(ss.models.get(model), "group", None) == EVENT_GROUP


def remove_device(ss: Any, model: str, idx: int | str) -> None:
    """Take one device off a System that has not been set up.

    Every param of the model loses the device's entry, the model and its group
    number what is left again, and a correction ANDES had noted for the device
    is forgotten with it. Params that copy another model's values (``ExtParam``)
    hold nothing before ``setup()`` unless a parser linked them early, as the
    PSS/E dynamic file's does; whatever they hold is cut the same way, and
    ``setup()`` fills them afresh.

    Raises ``KeyError`` when the model holds no such device, and
    ``RuntimeError`` on a System that is set up: its arrays have addresses by
    then, and nothing here moves those.
    """
    if getattr(ss, "is_setup", False):
        raise RuntimeError("a device cannot be removed once the System is set up")
    model_obj = ss.models[model]
    position = device_position(model_obj, idx)
    if position is None:
        raise KeyError(f"no {model} with idx={idx!r}")
    held = model_obj.idx.v[position]
    count = model_obj.n

    for param in model_obj.params.values():
        for attr in ("v", "vin", "pu_coeff"):
            values: Any = getattr(param, attr, None)
            if isinstance(values, list):
                if len(values) == count:
                    del values[position]
            elif getattr(values, "ndim", 0) >= 1 and len(values) == count:
                import numpy as np

                setattr(param, attr, np.delete(values, position, axis=0))

    model_obj.n = count - 1
    _renumber(model_obj.uid, model_obj.idx.v)
    for noted in model_obj._param_corrections.values():  # noqa: SLF001 - contract 14
        while held in noted:
            noted.remove(held)

    group = ss.groups[model_obj.group]
    registry = group._idx2model  # noqa: SLF001 - contract 14
    del registry[held]
    _renumber(group.uid, registry)


def _renumber(uid: dict[Any, int], order: Iterable[Any]) -> None:
    """Make ``uid`` map each idx in ``order`` to its position, in place."""
    uid.clear()
    for position, idx in enumerate(order):
        uid[idx] = position


# ----- references -----


def referrers(ss: Any, targets: Iterable[DeviceRef]) -> list[DeviceRef]:
    """The devices that name one of ``targets`` in a reference param.

    Each target is given with its idx as the System holds it (a reference is
    matched the way ANDES looks it up). A device is listed once, in the order
    the System holds its models, and a target is never listed itself.
    """
    wanted = _TargetSet(ss, targets)
    found: list[DeviceRef] = []
    for name, model_obj in ss.models.items():
        idx_values = _values(getattr(model_obj, "idx", None))
        if not idx_values:
            continue
        hits: set[int] = set()
        for target, values in _references(ss, name, model_obj):
            for position, value in enumerate(values[: len(idx_values)]):
                kind = target[position] if isinstance(target, list) else target
                if wanted.holds(kind, value):
                    hits.add(position)
        for position in sorted(hits):
            ref = (name, plain_idx(idx_values[position]))
            if not wanted.is_target(ref):
                found.append(ref)
    return found


def dependents(ss: Any, model: str, idx: int | str) -> list[DeviceRef]:
    """Every device that cannot stay once ``(model, idx)`` is gone, nearest first.

    The devices that name it, the devices that name those, and so on. ``idx``
    is the device's idx as the System holds it. The disturbances among them
    are included; :func:`is_event` tells them apart.
    """
    start: DeviceRef = (model, idx)
    found: list[DeviceRef] = []
    while True:
        nearer = referrers(ss, [start, *found])
        if not nearer:
            return found
        found.extend(nearer)


def spec_targets(ss: Any, spec: DisturbanceSpec, targets: Iterable[DeviceRef]) -> bool:
    """Whether a pending disturbance acts on one of ``targets``.

    A fault names a bus, a toggle and an alter a model (or a group) and a
    device. The idx is compared by its text, as ``Wrapper.add_disturbance``
    matches it to the device.
    """
    wanted = _TargetSet(ss, targets)
    if isinstance(spec, FaultSpec):
        return wanted.holds("Bus", spec.bus_idx, by_text=True)
    return wanted.holds(spec.model, spec.dev_idx, by_text=True)


class _TargetSet:
    """A set of devices, asked whether a reference into a model or a group names one."""

    def __init__(self, ss: Any, targets: Iterable[DeviceRef]) -> None:
        self._targets: set[tuple[str, str]] = set()
        # The names a reference can use for each target: its model's and its
        # group's, with the other names ANDES knows either by (``ACNode`` is
        # also ``ACTopology``, ``Toggle`` also ``Toggler``).
        self._by_kind: dict[str, list[int | str]] = {}
        for model, idx in targets:
            self._targets.add((model, str(idx)))
            for kind in _names_for(ss, model):
                self._by_kind.setdefault(kind, []).append(idx)

    def is_target(self, ref: DeviceRef) -> bool:
        return (ref[0], str(ref[1])) in self._targets

    def holds(self, kind: Any, value: Any, *, by_text: bool = False) -> bool:
        if value is None or not isinstance(kind, str):
            return False
        candidates = self._by_kind.get(kind)
        if not candidates:
            return False
        if by_text:
            text = str(value)
            return any(str(idx) == text for idx in candidates)
        try:
            return any(value == idx for idx in candidates)
        except (TypeError, ValueError):  # pragma: no cover - exotic idx types
            return False


def _names_for(ss: Any, model: str) -> set[str]:
    """Every name a reference can use for the devices of ``model``."""
    model_obj = ss.models.get(model)
    names = {model}
    if model_obj is None:
        return names
    aliases = getattr(ss, "model_aliases", None) or {}
    names.update(alias for alias, held in aliases.items() if held is model_obj)
    group = ss.groups.get(getattr(model_obj, "group", None))
    if group is not None:
        names.update(name for name, held in ss.groups.items() if held is group)
    return names


def _references(ss: Any, name: str, model_obj: Any) -> list[tuple[str | list[Any], list[Any]]]:
    """The reference params of one model: what each points into, and its values.

    What a param points into is one group or model name for all the devices,
    or, for a model that names it per device, a list with one name each.
    """
    out: list[tuple[str | list[Any], list[Any]]] = []
    paired = _PAIRED_REFERENCES.get(name)
    idx_params = getattr(model_obj, "idx_params", None)
    if not isinstance(idx_params, dict):
        return out
    for param_name, param in idx_params.items():
        if (name, param_name) in _NOT_REFERENCES:
            continue
        values = _values(param)
        if not values:
            continue
        target = getattr(param, "model", None)
        if target is None and paired is not None and param_name == paired[1]:
            kinds = _values(getattr(model_obj, paired[0], None))
            out.append((kinds + [None] * (len(values) - len(kinds)), values))
            continue
        if target is None:
            target = _UNTYPED_REFERENCES.get((name, param_name))
        if isinstance(target, str) and (target in ss.groups or target in ss.models):
            out.append((target, values))
    return out


def reference_params(ss: Any) -> dict[tuple[str, str], str | None]:
    """Every ``IdxParam`` of every model with what :func:`referrers` takes it to point into.

    ``None`` is a param it does not follow: one that names a parameter, or one
    ANDES declares without a target and that is not listed here. A model that
    names the target per device has ``"<model>"``. For the tests, which hold
    this against the installed ANDES.
    """
    out: dict[tuple[str, str], str | None] = {}
    for name, model_obj in ss.models.items():
        paired = _PAIRED_REFERENCES.get(name)
        for param_name, param in getattr(model_obj, "idx_params", {}).items():
            target = getattr(param, "model", None)
            if (name, param_name) in _NOT_REFERENCES:
                out[(name, param_name)] = None
            elif target is None and paired is not None and param_name == paired[1]:
                out[(name, param_name)] = f"<{paired[0]}>"
            elif target is None:
                out[(name, param_name)] = _UNTYPED_REFERENCES.get((name, param_name))
            else:
                out[(name, param_name)] = target
    return out


def _values(holder: Any) -> list[Any]:
    """``holder.v`` as a list, empty when there is none."""
    values = getattr(holder, "v", None)
    return [] if values is None else list(values)


def plain_idx(value: Any) -> Any:
    """An idx as a plain ``int`` or ``str``: ANDES hands back numpy scalars too."""
    if value is None or isinstance(value, int | str):
        return value
    item = value.item() if hasattr(value, "item") else value
    return item if isinstance(item, int | str) else str(item)
