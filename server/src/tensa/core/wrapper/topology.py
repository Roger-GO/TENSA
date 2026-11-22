"""Reading the loaded System as a topology: the snapshot and one device."""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any, Literal

from tensa.core.edit_log import step_of
from tensa.core.errors import NoCaseLoadedError
from tensa.core.rated_voltage import still_without_rated_voltage
from tensa.core.wrapper.base import WrapperBase
from tensa.core.wrapper.params import _CONTROLLER_MODEL_NAMES, _PARAMS_BY_MODEL, ParamMeta
from tensa.core.wrapper.results import ParamValue, TopologyEntry, TopologySnapshot

if TYPE_CHECKING:
    from andes.system import System


class TopologyMixin(WrapperBase):
    """Read the loaded System as a :class:`TopologySnapshot`, or one device of it."""

    def topology_snapshot(self) -> TopologySnapshot:
        """Return the current topology view. ``state`` reflects whether ``setup()``
        has been called."""
        if self._ss is None:
            raise NoCaseLoadedError("no case has been loaded")
        return self._topology_snapshot_locked()

    def _topology_snapshot_locked(self) -> TopologySnapshot:
        """Build the topology snapshot from the loaded System.

        Lines and transformers are both backed by ANDES's ``Line`` model; the
        substrate splits them at the boundary (see :func:`_split_lines_transformers`).
        Pure transmission lines stay in ``lines``; branches that carry a transformer's
        marks move to ``transformers``.
        """
        assert self._ss is not None
        ss = self._ss
        state: Literal["pre-setup", "committed"] = (
            "committed" if ss.is_setup else "pre-setup"
        )
        all_lines = _collect_models(ss, ["Line"])
        lines, transformers = _split_lines_transformers(all_lines, _marked_as_transformers(ss))
        snapshot = TopologySnapshot(
            state=state,
            buses=_collect_models(ss, ["Bus"]),
            lines=lines,
            transformers=transformers,
            generators=_collect_models(
                ss,
                ["PV", "Slack", "GENROU", "GENCLS"],
            ),
            loads=_collect_models(ss, ["PQ", "ZIP"]),
            shunts=_collect_models(ss, ["Shunt"]),
            controllers=_collect_models(ss, list(_CONTROLLER_MODEL_NAMES)),
            freq_hz=_system_frequency_hz(ss),
            base_mva=_system_base_mva(ss),
            buses_without_vn=still_without_rated_voltage(ss, self._buses_without_vn),
            events=[*self._case_events, *self._restored_events],
            undo=step_of(self._edit_log[-1]) if self._edit_log else None,
            redo=step_of(self._redo_log[-1]) if self._redo_log else None,
        )
        book = self.keys()
        for entry in (
            *snapshot.buses,
            *snapshot.lines,
            *snapshot.transformers,
            *snapshot.generators,
            *snapshot.loads,
            *snapshot.shunts,
            *snapshot.controllers,
        ):
            entry.key = book.key_of(entry.kind, entry.idx)
        snapshot.has_dynamics = any(
            entry.bucket == "dynamic" for entry in book.entries()
        )
        return snapshot

    def _lookup_topology_entry(
        self, model: str, idx: int | str
    ) -> TopologyEntry | None:
        """Build a single ``TopologyEntry`` for a given model/idx pair.

        Returns ``None`` if the device isn't present on the System (e.g.,
        ``ss.add`` failed silently, or the model class isn't surfaced).
        """
        ss = self._ss
        if ss is None:
            return None
        model_obj = getattr(ss, model, None)
        if model_obj is None:
            return None
        idx_var = getattr(model_obj, "idx", None)
        idx_values = list(getattr(idx_var, "v", []) if idx_var is not None else [])
        idx_str = str(idx)
        try:
            i = next(
                pos for pos, value in enumerate(idx_values) if str(value) == idx_str
            )
        except StopIteration:
            return None
        name_var = getattr(model_obj, "name", None)
        name_values = list(
            getattr(name_var, "v", []) if name_var is not None else []
        )
        name = (
            str(name_values[i])
            if i < len(name_values)
            else str(idx_values[i])
        )
        params_metas = _PARAMS_BY_MODEL.get(model, ())
        all_params = _extract_params(model_obj, params_metas) if params_metas else []
        params = all_params[i] if i < len(all_params) else {}
        return TopologyEntry(
            idx=idx_values[i],
            name=name,
            kind=model,
            params=params,
            key=self.keys().key_of(model, idx_values[i]),
        )


def _coerce_scalar(value: Any) -> ParamValue | None:
    """Coerce a numpy / Python scalar to a JSON-friendly primitive.

    Returns None if the value is None, an array of length != 1, or a type the
    schema doesn't accept. The topology endpoint silently drops None entries
    so this is a safe filter rather than an error path.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float):
        # Reject non-finite floats — the schema doesn't allow NaN / Inf in
        # JSON-serialized topology params.
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return value
    if isinstance(value, str):
        return value
    # numpy scalar: has .item()
    item = getattr(value, "item", None)
    if callable(item):
        try:
            return _coerce_scalar(item())
        except (TypeError, ValueError):
            return None
    return None


def _extract_params(
    model: Any, param_metas: tuple[ParamMeta, ...]
) -> list[dict[str, ParamValue]]:
    """For each device in ``model``, return a dict of the requested params.

    Defensive: missing params, zero-length arrays, and length mismatches are
    skipped silently. Returns one dict per device, in the same order as
    ``model.idx.v``.

    ``idx`` and ``name`` are skipped — those are surfaced at the
    ``TopologyEntry`` level by ``_collect_models``.
    """
    n = int(getattr(model, "n", 0))
    if n <= 0:
        return []
    per_device: list[dict[str, ParamValue]] = [{} for _ in range(n)]
    for meta in param_metas:
        if meta.name in ("idx", "name"):
            continue
        param = getattr(model, meta.name, None)
        if param is None:
            continue
        values = getattr(param, "v", None)
        if values is None:
            continue
        try:
            vlist = list(values)
        except TypeError:
            continue
        if len(vlist) != n:
            continue
        for i, raw in enumerate(vlist):
            coerced = _coerce_scalar(raw)
            if coerced is None:
                continue
            per_device[i][meta.name] = coerced
    return per_device


def _collect_models(ss: System, model_names: list[str]) -> list[TopologyEntry]:
    """Walk a list of ANDES model class names on the System and collect their
    devices into a flat list keyed by idx + name.

    ANDES exposes models as attributes on the System (e.g., ``ss.Bus``,
    ``ss.Line``). Each model has ``.idx.v`` (idx values) and ``.name.v``
    (human names) when populated. Empty / absent models are skipped.
    """
    entries: list[TopologyEntry] = []
    for model_name in model_names:
        model = getattr(ss, model_name, None)
        if model is None:
            continue
        idx_var = getattr(model, "idx", None)
        if idx_var is None:
            continue
        idx_values = list(getattr(idx_var, "v", []))
        if not idx_values:
            continue
        name_values: list[str]
        name_var = getattr(model, "name", None)
        if name_var is not None and getattr(name_var, "v", None) is not None:
            name_values = [str(v) for v in name_var.v]
        else:
            name_values = [str(idx) for idx in idx_values]
        param_metas = _PARAMS_BY_MODEL.get(model_name, ())
        per_device_params = (
            _extract_params(model, param_metas) if param_metas else [{} for _ in idx_values]
        )
        for i, (idx, name) in enumerate(zip(idx_values, name_values, strict=True)):
            params = per_device_params[i] if i < len(per_device_params) else {}
            entries.append(
                TopologyEntry(idx=idx, name=name, kind=model_name, params=params)
            )
    return entries


def _system_frequency_hz(ss: System) -> float | None:
    """The system nominal frequency in Hz, or ``None`` when ``ss.config.freq``
    is missing, not a number, or not a positive finite value."""
    configured: Any = getattr(ss.config, "freq", None)
    try:
        freq = float(configured)
    except (TypeError, ValueError):
        return None
    return freq if math.isfinite(freq) and freq > 0 else None


def _system_base_mva(ss: System) -> float | None:
    """The system MVA base, or ``None`` when ``ss.config.mva`` is missing, not
    a number, or not a positive finite value."""
    configured: Any = getattr(ss.config, "mva", None)
    try:
        mva = float(configured)
    except (TypeError, ValueError):
        return None
    return mva if math.isfinite(mva) and mva > 0 else None


# Two ends of a branch rated further apart than this (as a fraction of the larger) are
# two voltage levels, which only a transformer joins. A level that a case rounds
# differently at the two ends stays a line; the closest two levels a transformer joins in
# the example cases of ANDES are 1 % apart (20.7 and 20.9 kV).
_LEVEL_GAP = 0.001


def _marked_as_transformers(ss: System) -> frozenset[int | str]:
    """The idx of every ``Line`` that the case marks as a transformer.

    ANDES flags a transformer with ``trans`` (a PSS/E reader sets it; so does a case
    written for it) and gives it the rated voltage of each end in ``Vn1`` and ``Vn2``,
    so a branch joining two voltage levels is one whether or not it carries a flag. A
    transformer at its nominal ratio has neither a tap nor a phase shift to tell it
    apart, which is how every step-up unit of the WSCC 9 and Kundur cases looked.
    """
    model = getattr(ss, "Line", None)
    if model is None:
        return frozenset()
    columns: dict[str, list[Any]] = {}
    for name in ("idx", "trans", "Vn1", "Vn2"):
        values = getattr(getattr(model, name, None), "v", None)
        try:
            columns[name] = [] if values is None else list(values)
        except TypeError:
            columns[name] = []
    marked: set[int | str] = set()
    for i, idx in enumerate(columns["idx"]):
        if _is_set(columns["trans"], i) or _joins_two_levels(
            _number(columns["Vn1"], i), _number(columns["Vn2"], i)
        ):
            marked.add(idx)
    return frozenset(marked)


def _number(values: list[Any], i: int) -> float | None:
    """``values[i]`` as a finite number, or ``None``."""
    try:
        number = float(values[i])
    except (IndexError, TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _is_set(values: list[Any], i: int) -> bool:
    """Whether ``values[i]`` is a set ANDES flag (a ``trans`` of 1)."""
    number = _number(values, i)
    return number is not None and number != 0.0


def _joins_two_levels(vn1: float | None, vn2: float | None) -> bool:
    """Whether the rated voltages of the two ends of a branch are two different levels."""
    if vn1 is None or vn2 is None or vn1 <= 0.0 or vn2 <= 0.0:
        return False
    return abs(vn1 - vn2) > _LEVEL_GAP * max(vn1, vn2)


def _split_lines_transformers(
    line_entries: list[TopologyEntry],
    marked: frozenset[int | str] = frozenset(),
) -> tuple[list[TopologyEntry], list[TopologyEntry]]:
    """Partition ANDES Line entries into pure lines vs. transformers.

    A Line is a transformer if its tap is non-default (|tap - 1.0| > 1e-9) or its
    phase shift is non-zero (|phi| > 1e-9), tolerant of float drift from PSS/E .raw
    imports where tap is stored as 1.0 + epsilon, or if its idx is in ``marked``
    (ANDES's ``trans`` flag, or two rated voltages that differ: see
    :func:`_marked_as_transformers`).

    Devices without a readable ``tap``/``phi`` (older ANDES models, custom
    extensions) and not marked default to the ``lines`` bucket.
    """
    lines: list[TopologyEntry] = []
    transformers: list[TopologyEntry] = []
    for entry in line_entries:
        tap = entry.params.get("tap")
        phi = entry.params.get("phi")
        try:
            tap_offset = abs(float(tap) - 1.0) if tap is not None else 0.0
        except (TypeError, ValueError):
            tap_offset = 0.0
        try:
            phi_abs = abs(float(phi)) if phi is not None else 0.0
        except (TypeError, ValueError):
            phi_abs = 0.0
        if tap_offset > 1e-9 or phi_abs > 1e-9 or entry.idx in marked:
            transformers.append(entry)
        else:
            lines.append(entry)
    return lines, transformers
