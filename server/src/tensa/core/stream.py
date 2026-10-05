"""Arrow IPC encoder + decimation aggregator for TDS streaming.

A run names its columns once, in ``stream_start.metadata.var_columns`` (one
name per selected state variable, ``t`` excluded), and then sends one frame
per emitted batch. A frame is a self-contained Arrow IPC stream holding one
RecordBatch of one or more rows with two columns:

- ``t``: float64, the simulated time of each row.
- ``v``: ``fixed_size_list<float64>[ncols]``, each row's values in
  ``var_columns`` order.

The names are never repeated and the frame's schema is two fields wide
however many variables are streamed, so a frame costs 8 bytes per value plus
a fixed few hundred bytes, and encoding or decoding one costs the same per
value. (One Arrow column per variable repeated every name in each frame's
schema and carried a field node and buffer descriptors per column, which on a
case with 1208 variables was a 134 KB frame for 9.7 KB of values.) A run that
selects variables with no members on the loaded case has no columns and its
frames carry ``t`` alone. The WebSocket ``start_tds`` config's ``vars`` list
selects which variable groups are included in each frame.

The variable groups (and the columns each contributes, in canonical
order) are:

- ``bus_v``     — ``Bus_<idx>_v`` (voltage magnitude, pu) +
  ``Bus_<idx>_a`` (voltage angle, rad) per bus.
- ``gen_state`` — ``Gen_<idx>_delta`` (rotor angle, rad) +
  ``Gen_<idx>_omega`` (per-unit speed, the frequency proxy) per SynGen.
- ``gen_power`` — ``Gen_<idx>_Pe`` (electrical active power, MW) +
  ``Gen_<idx>_Qe`` (electrical reactive power, MVar) per SynGen.
- ``line_flow`` — ``Line_<idx>_p`` (active power at terminal 1, MW) +
  ``Line_<idx>_q`` (reactive power at terminal 1, MVar) per line.
- ``load_pq``   — ``Load_<idx>_p`` (active consumption, MW) +
  ``Load_<idx>_q`` (reactive consumption, MVar) per PQ load.

The default selection is ``bus_v`` + ``gen_state`` so voltages, angles,
and the frequency proxy are always plottable without re-running.

Beyond the groups, a run can name ANDES variables one by one (``dae_vars``, see
``tensa.core.dae_vars``): ``omega GENROU 1``, ``vf GENROU 2``, any entry of
``dae.x_name`` or ``dae.y_name``. Each adds one column, after the groups' and
named exactly as ANDES names the variable, holding its value as ANDES stores it
(per unit or radians for most, in ANDES's own units, with no scaling).

Two streaming modes:

- ``decimation="none"`` — every callpert step is one row. If
  ``max_rate_hz`` is also configured, multiple source steps are batched
  into one Arrow batch every ``1/max_rate_hz`` simulated seconds (cuts
  Arrow framing overhead from ~50% to ~3% per the plan's N-rows-per-batch
  guidance). Otherwise every step is its own one-row batch (highest
  fidelity, highest overhead, useful for spectral debugging).
- ``decimation="mean"`` — every aggregation window emits one row whose
  values are the boxcar mean of source steps in that window. Anti-aliases
  oscillations above the output Nyquist *when the integrator is fixed-step*;
  on adaptive-step integrators (ANDES default) the math is best-effort,
  declared honestly via ``algorithm: "boxcar-mean-best-effort"`` in the
  stream-start metadata.

The ``StreamCollector`` reads the selected groups' values off the System at
each callpert step: it resolves where every value lives once, when the run
starts, and reads them with numpy after that. The ``StreamAggregator`` owns
the buffering decision; the worker just calls ``push(t, collector.collect())``
per callpert step and ``flush()`` at run end, and emits whatever rows the
aggregator returns as one Arrow batch.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from functools import lru_cache
from typing import TYPE_CHECKING, Any, Literal

import numpy as np
import pyarrow as pa
import pyarrow.ipc
from numpy.typing import NDArray

if TYPE_CHECKING:
    from andes.system import System


DecimationAlgorithm = Literal["none", "boxcar-mean", "boxcar-mean-best-effort"]
DecimationMode = Literal["none", "mean"]

# ``vars`` selector: each entry expands into a contiguous run of
# columns in each row (in the order listed in ``VAR_GROUPS``).
# Adding a group here + its branches in ``var_column_names`` and
# ``StreamCollector`` extends the run's columns and the per-tick collector;
# the worker's and the WS layer's ``vars`` validation iterate ``VAR_GROUPS``
# and follow automatically.
VarGroup = Literal["bus_v", "gen_state", "gen_power", "line_flow", "load_pq"]
VAR_GROUPS: tuple[VarGroup, ...] = (
    "bus_v",
    "gen_state",
    "gen_power",
    "line_flow",
    "load_pq",
)
# Default streamed vars: voltage (+ angle) + generator state so frequency
# (omega) is always plottable without re-running. The UI may default to a
# narrower display selection, but the wire carries both groups.
DEFAULT_VARS: tuple[VarGroup, ...] = ("bus_v", "gen_state")

# One row of a frame: the step's time and its values in column order. The
# collector produces arrays; plain lists work too (the tests build them).
StreamRow = tuple[float, Sequence[float] | NDArray[np.float64]]

log = logging.getLogger("tensa.stream")


# ---- columns ----------------------------------------------------------------


def _paired_columns(
    prefix: str, idx_values: list[int | str], first: str, second: str
) -> list[str]:
    """``<prefix>_<idx>_<first>`` then ``<prefix>_<idx>_<second>`` for each idx
    in turn: the two-values-per-device layout every group uses."""
    names: list[str] = []
    for idx in idx_values:
        names.append(f"{prefix}_{idx}_{first}")
        names.append(f"{prefix}_{idx}_{second}")
    return names


def var_column_names(
    var_groups: list[VarGroup] | tuple[VarGroup, ...],
    system: System,
    dae_vars: Sequence[str] = (),
) -> list[str]:
    """The names of the columns a run streams for ``var_groups`` on ``system``.

    ``var_groups`` is a subset of :data:`VAR_GROUPS`, empty only when
    ``dae_vars`` names something. The names come
    in canonical :data:`VAR_GROUPS` order whatever order the groups were listed
    in, each group contributing its two columns per device in idx order (see
    the module docstring), followed by the ``dae_vars`` names in the order given
    (each once), so the list fixes both the column count and the
    order of the values in every row. ``t`` is not among them. This is the list
    ``stream_start.metadata.var_columns`` sends the client, which is how it
    names the values of the frames that follow.
    """
    if not var_groups and not dae_vars:
        raise ValueError("var_groups must be a non-empty subset of VAR_GROUPS")
    requested = set(var_groups)
    unknown = requested - set(VAR_GROUPS)
    if unknown:
        raise ValueError(f"unknown var groups: {sorted(unknown)!r}")

    names: list[str] = []
    for group in VAR_GROUPS:
        if group not in requested:
            continue
        if group == "bus_v":
            names += _paired_columns("Bus", bus_idx_values_from_system(system), "v", "a")
        elif group == "gen_state":
            names += _paired_columns(
                "Gen", syngen_idx_values_from_system(system), "delta", "omega"
            )
        elif group == "gen_power":
            names += _paired_columns("Gen", syngen_idx_values_from_system(system), "Pe", "Qe")
        elif group == "line_flow":
            names += _paired_columns("Line", line_idx_values_from_system(system), "p", "q")
        elif group == "load_pq":
            names += _paired_columns("Load", pq_idx_values_from_system(system), "p", "q")
        else:  # pragma: no cover — exhaustively handled above
            raise ValueError(f"unexpected var group: {group!r}")
    return names + list(dict.fromkeys(dae_vars))


# ---- encoding ---------------------------------------------------------------


@lru_cache(maxsize=16)
def _frame_schema(n_columns: int) -> pa.Schema:
    """The wire schema of a frame carrying ``n_columns`` values per row."""
    fields = [pa.field("t", pa.float64())]
    if n_columns:
        fields.append(pa.field("v", pa.list_(pa.float64(), n_columns)))
    return pa.schema(fields)


def encode_batch(
    n_columns: int,
    rows: Iterable[StreamRow],
) -> bytes:
    """Encode one or more rows into a frame: a self-contained Arrow IPC
    stream chunk (see the module docstring for the layout).

    ``n_columns`` is how many values a row carries, the length of the run's
    :func:`var_column_names`. ``rows`` is an iterable of ``(t, values)``
    tuples, each ``values`` a list or array of those values in column order,
    and a row of any other length raises ``ValueError``. ``t`` and each value
    may arrive as numpy scalars or 0-d ndarrays (ANDES's ``dae.t`` is a numpy
    scalar); numpy coerces them to float64.
    """
    rows_list = list(rows)
    if not rows_list:
        # Empty batch is meaningless; signal up to caller.
        raise ValueError("encode_batch called with no rows")

    t = np.array([row_t for row_t, _ in rows_list], dtype=np.float64)
    values = np.array([row_values for _, row_values in rows_list], dtype=np.float64)
    if values.shape != (len(rows_list), n_columns):
        raise ValueError(
            f"every row must carry {n_columns} values (one per column); "
            f"got an array of shape {values.shape}"
        )

    wire_schema = _frame_schema(n_columns)
    columns: list[pa.Array] = [pa.array(t)]
    if n_columns:
        columns.append(
            pa.FixedSizeListArray.from_arrays(pa.array(values.reshape(-1)), n_columns)
        )
    batch = pa.RecordBatch.from_arrays(columns, schema=wire_schema)
    sink = pa.BufferOutputStream()
    with pa.ipc.new_stream(sink, wire_schema) as writer:
        writer.write_batch(batch)
    return bytes(sink.getvalue())


def decode_batch(payload: bytes) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    """Decode a frame written by :func:`encode_batch` into ``(t, values)``.

    ``t`` has one entry per row and ``values`` has shape ``(rows, columns)``,
    its columns in ``stream_start.metadata.var_columns`` order (shape
    ``(rows, 0)`` when the run has no columns). The server never decodes
    frames; this is the reference reader for tests and Python clients.
    """
    table = pa.ipc.open_stream(pa.py_buffer(payload)).read_all()
    t = np.asarray(table.column("t").to_numpy(), dtype=np.float64)
    if "v" not in table.column_names:
        return t, np.empty((len(t), 0), dtype=np.float64)
    column = table.column("v").combine_chunks()
    flat = np.asarray(column.flatten().to_numpy(), dtype=np.float64)
    return t, flat.reshape(len(t), column.type.list_size)


# ---- ANDES wiring -----------------------------------------------------------


def bus_idx_values_from_system(system: System) -> list[int | str]:
    """Return the ANDES bus idx values in the order their voltage and
    angle columns appear in a row."""
    return list(system.Bus.idx.v)


def syngen_idx_values_from_system(system: System) -> list[int | str]:
    """Return the ANDES SynGen idx values (across GENROU / GENCLS / etc.)
    in the order :class:`StreamCollector` reads them.

    ``ss.SynGen`` is the ANDES *group* parent of the dynamic generator
    models (``GENROU``, ``GENCLS``, ``PLBVFU1``). Static generators
    (``PV``, ``Slack``) are NOT in this group — they have no rotor state
    and contribute zero columns to the gen_state stream. On a case with
    no dynamic generators (e.g., a .raw loaded without a .dyr addfile),
    this returns ``[]`` and the gen_state and gen_power groups have no columns.
    """
    syngen = getattr(system, "SynGen", None)
    if syngen is None:
        return []
    try:
        return list(syngen.get_all_idxes())
    except AttributeError:  # pragma: no cover — older ANDES versions
        return []


def line_idx_values_from_system(system: System) -> list[int | str]:
    """Return the ANDES Line idx values in the order
    :class:`StreamCollector` reads them. Cases with no Line
    elements yield ``[]`` and the line_flow group has no columns."""
    line = getattr(system, "Line", None)
    if line is None:
        return []
    idx_var = getattr(line, "idx", None)
    if idx_var is None:
        return []
    return list(getattr(idx_var, "v", []))


def pq_idx_values_from_system(system: System) -> list[int | str]:
    """Return the ANDES PQ idx values in the order
    :class:`StreamCollector` reads them. Cases with no PQ
    loads yield ``[]`` and the load_pq group has no columns.

    Only the ``PQ`` model is included (constant-power loads). ZIP loads
    are a separate model and are not part of this group's contract.
    """
    pq = getattr(system, "PQ", None)
    if pq is None:
        return []
    idx_var = getattr(pq, "idx", None)
    if idx_var is None:
        return []
    return list(getattr(idx_var, "v", []))


# Line-flow attribute set read live from the System each callpert tick.
# Mirrors ``tensa.core.wrapper._extract_line_flows`` — ANDES does not
# expose ``ss.Line.p1`` / ``ss.Line.q1`` directly, so we recompute the same
# pi-equivalent expressions that ANDES injects into the bus1 power-balance
# equations. ``bh`` is needed for the Q1 shunt-susceptance term.
_LINE_FLOW_ATTRS: tuple[str, ...] = (
    "v1", "v2", "a1", "a2", "phi", "ue",
    "gh", "bh", "ghk", "bhk", "itap", "itap2",
)

_NAN = float("nan")
_NO_ADDRESSES: tuple[NDArray[np.intp], NDArray[np.intp]] = (
    np.empty(0, dtype=np.intp),
    np.empty(0, dtype=np.intp),
)


def _mva_base(system: System) -> float:
    """The system base MVA, ``100.0`` when the configuration does not say."""
    try:
        return float(getattr(system.config, "mva", 100.0))
    except (TypeError, ValueError):
        return 100.0


def _values(param: object, n: int) -> NDArray[np.float64] | None:
    """The ``n`` current values of an ANDES variable, parameter or service,
    or ``None`` when it has no values, another count, or non-numeric ones.

    The array is ANDES's own, not a copy: ANDES updates it in place at every
    step, so a caller must write out what it computes from it and never keep
    or return it.
    """
    values = getattr(param, "v", None)
    if values is None:
        return None
    try:
        array = np.asarray(values, dtype=np.float64)
    except (TypeError, ValueError):
        return None
    return array if array.shape == (n,) else None


class _Reader:
    """Fills the slice of a row that one variable group owns.

    A reader resolves what it reads (the model objects, the positions of its
    devices) once, when the run starts, and then reads ANDES's arrays with
    numpy at every step. The arrays themselves are read each time, not held:
    ANDES changes their contents as the run goes (a tripped line changes
    ``Line.ue``, an ``Alter`` changes ``PQ.Ppf``), and the stream shows that.
    """

    width: int

    def __init__(self) -> None:
        self._warned: set[str] = set()

    def read(self, out: NDArray[np.float64]) -> None:
        """Write the group's ``width`` values for the current step into ``out``."""
        raise NotImplementedError

    def _read(self, label: str, param: object, n: int) -> NDArray[np.float64] | None:
        """:func:`_values`, logging the first step it comes back empty."""
        values = _values(param, n)
        if values is None and label not in self._warned:
            self._warned.add(label)
            log.warning("%s is missing or not %d values long; emitting NaN columns", label, n)
        return values


class _BusReader(_Reader):
    """``[v_0, a_0, v_1, a_1, ...]``: ``Bus.v.v`` (pu) and ``Bus.a.v`` (rad) in
    bus idx order. A missing or short array emits ``nan`` columns so the run
    never crashes over one bad read."""

    def __init__(self, system: System) -> None:
        super().__init__()
        self._bus = system.Bus
        self._n = len(bus_idx_values_from_system(system))
        self.width = 2 * self._n

    def read(self, out: NDArray[np.float64]) -> None:
        v = self._read("Bus.v.v", self._bus.v, self._n)
        a = self._read("Bus.a.v", getattr(self._bus, "a", None), self._n)
        out[0::2] = _NAN if v is None else v
        out[1::2] = _NAN if a is None else a


class _SynGenReader(_Reader):
    """Two named variables of the SynGen members, interleaved per device in idx
    order: ``[delta_0, omega_0, ...]`` or ``[Pe_0, Qe_0, ...]``, each times
    ``scale``.

    The members span several models (GENROU, GENCLS, ...), and ANDES's
    ``SynGen.get`` looks every idx up again on each call. This looks each up
    once, groups the members by model, and reads each model's array with one
    fancy index per step.
    """

    def __init__(
        self,
        system: System,
        idx_values: list[int | str],
        names: tuple[str, str],
        scale: float = 1.0,
    ) -> None:
        super().__init__()
        self.width = 2 * len(idx_values)
        self._scale = scale
        # model -> (positions in idx order, uids within the model)
        members: dict[int, tuple[Any, list[int], list[int]]] = {}
        models = system.SynGen.idx2model(idx_values) if idx_values else []
        for position, (idx, model) in enumerate(zip(idx_values, models, strict=True)):
            _model, positions, uids = members.setdefault(id(model), (model, [], []))
            positions.append(position)
            uids.append(model.idx2uid(idx))
        # (first-variable param, second-variable param, their columns, their uids)
        self._parts = [
            (
                getattr(model, names[0]),
                getattr(model, names[1]),
                2 * np.array(positions, dtype=np.intp),
                np.array(uids, dtype=np.intp),
            )
            for model, positions, uids in members.values()
        ]

    def read(self, out: NDArray[np.float64]) -> None:
        for first, second, columns, uids in self._parts:
            for offset, param in ((0, first), (1, second)):
                values = np.asarray(param.v, dtype=np.float64)[uids]
                out[columns + offset] = values if self._scale == 1.0 else values * self._scale


class _LineFlowReader(_Reader):
    """``[p_0, q_0, p_1, q_1, ...]``: the P and Q flow at terminal 1 of each
    line in idx order, in MW / MVar.

    Mirrors :func:`tensa.core.wrapper._extract_line_flows`'s formulae (P1 and
    Q1 of the standard pi-equivalent line model with off-nominal tap + phase
    shift) as array expressions over the live algebraic-variable values and
    line parameters. A non-finite result (e.g., a divergent step) emits
    ``nan`` rather than raising — uPlot handles NaN gaps and the substrate
    must not crash a long sim over a single bad line value.
    """

    def __init__(self, system: System, n: int) -> None:
        super().__init__()
        self._n = n
        self.width = 2 * n
        line = getattr(system, "Line", None)
        self._params = [(name, getattr(line, name, None)) for name in _LINE_FLOW_ATTRS]
        self._mva = _mva_base(system)

    def read(self, out: NDArray[np.float64]) -> None:
        arrays: dict[str, NDArray[np.float64]] = {}
        for name, param in self._params:
            values = self._read(f"Line.{name}.v", param, self._n)
            if values is None:
                out[:] = _NAN
                return
            arrays[name] = values
        v1, v2 = arrays["v1"], arrays["v2"]
        gh, bh, ghk, bhk = arrays["gh"], arrays["bh"], arrays["ghk"], arrays["bhk"]
        itap, itap2 = arrays["itap"], arrays["itap2"]
        with np.errstate(all="ignore"):
            d = arrays["a1"] - arrays["a2"] - arrays["phi"]
            cos_d = np.cos(d)
            sin_d = np.sin(d)
            p_pu = arrays["ue"] * (
                v1 * v1 * (gh + ghk) * itap2 - v1 * v2 * (ghk * cos_d + bhk * sin_d) * itap
            )
            # Q1 mirrors wrapper._extract_line_flows exactly: the shunt term
            # uses (bh + bhk) and the series cross-term flips sign vs. P1.
            q_pu = arrays["ue"] * (
                -v1 * v1 * (bh + bhk) * itap2 - v1 * v2 * (ghk * sin_d - bhk * cos_d) * itap
            )
            out[0::2] = p_pu * self._mva
            out[1::2] = q_pu * self._mva
        out[~np.isfinite(out)] = _NAN


class _LoadReader(_Reader):
    """``[p_0, q_0, p_1, q_1, ...]``: the P and Q consumption of each PQ load in
    idx order, in MW / MVar.

    Mirrors :func:`tensa.core.wrapper._extract_load_consumption` for the PQ
    model: reads ``Ppf`` / ``Qpf`` (the post-PF active / reactive power, pu)
    and scales by the system base MVA. Falls back to the ``p0`` / ``q0``
    set-points if ``Ppf`` / ``Qpf`` are unavailable. Non-finite values emit
    ``nan`` rather than raising.
    """

    def __init__(self, system: System, n: int) -> None:
        super().__init__()
        self._n = n
        self.width = 2 * n
        pq = getattr(system, "PQ", None)
        self._p = self._first(pq, "Ppf", "p0")
        self._q = self._first(pq, "Qpf", "q0")
        self._mva = _mva_base(system)

    @staticmethod
    def _first(model: object, *names: str) -> object | None:
        for name in names:
            param: object | None = getattr(model, name, None)
            if param is not None:
                return param
        return None

    def read(self, out: NDArray[np.float64]) -> None:
        for column, label, param in ((0, "PQ.Ppf.v", self._p), (1, "PQ.Qpf.v", self._q)):
            values = self._read(label, param, self._n)
            if values is None:
                out[column::2] = _NAN
                continue
            scaled = values * self._mva
            scaled[~np.isfinite(scaled)] = _NAN
            out[column::2] = scaled


class _DaeReader(_Reader):
    """``[value_0, value_1, ...]``: the ANDES variables named in ``names``, each
    read from ``dae.x`` (a state) or ``dae.y`` (an algebraic variable) as ANDES
    stores it, with no scaling.

    Where a variable sits is looked up by name in ``dae.x_name`` and
    ``dae.y_name`` and not from the model's own address arrays: those names
    exist only once ANDES has set up the time-domain run (the collector is built
    before that), and the addresses of a static device that a dynamic one
    replaces are stale after it. The lookup is made when the first value is read,
    and again if the name lists have changed length since, which is what
    happens if a collector reads before ``TDS.init()`` has run. A name that is
    not in either list reads as ``nan``, logged once.
    """

    def __init__(self, system: System, names: Sequence[str]) -> None:
        super().__init__()
        self._dae = system.dae
        self._names = list(names)
        self.width = len(self._names)
        self._seen: tuple[int, int] | None = None
        self._x: tuple[NDArray[np.intp], NDArray[np.intp]] = _NO_ADDRESSES
        self._y: tuple[NDArray[np.intp], NDArray[np.intp]] = _NO_ADDRESSES

    def _locate(self) -> None:
        """(Re)build the columns and the ``dae`` addresses they read."""
        dae = self._dae
        self._seen = (len(dae.x_name), len(dae.y_name))
        column_of = {name: column for column, name in enumerate(self._names)}
        found: list[tuple[list[int], list[int]]] = []
        for dae_names in (dae.x_name, dae.y_name):
            columns: list[int] = []
            addresses: list[int] = []
            for address, name in enumerate(dae_names):
                column = column_of.get(name)
                if column is not None:
                    columns.append(column)
                    addresses.append(address)
            found.append((columns, addresses))
        (x_columns, x_addresses), (y_columns, y_addresses) = found
        self._x = (np.array(x_columns, dtype=np.intp), np.array(x_addresses, dtype=np.intp))
        self._y = (np.array(y_columns, dtype=np.intp), np.array(y_addresses, dtype=np.intp))

    def read(self, out: NDArray[np.float64]) -> None:
        dae = self._dae
        if self._seen != (len(dae.x_name), len(dae.y_name)):
            self._locate()
            missing = self.width - len(self._x[0]) - len(self._y[0])
            if missing and "dae_vars" not in self._warned:
                self._warned.add("dae_vars")
                log.warning(
                    "%d of %d ANDES variables are not in dae.x_name or dae.y_name; "
                    "emitting NaN columns for them",
                    missing,
                    self.width,
                )
        out[:] = _NAN
        for (columns, addresses), values in ((self._x, dae.x), (self._y, dae.y)):
            if len(columns):
                out[columns] = np.asarray(values, dtype=np.float64)[addresses]


class StreamCollector:
    """Reads the selected variable groups' values and named ANDES variables off a
    System at each step.

    Built once per run, after the System is set up: the addresses of every
    value are resolved then (which SynGen model holds each generator and at
    what position, which line arrays to read), so a step is a handful of
    numpy reads rather than a Python loop over devices and a dictionary
    lookup per generator. :meth:`collect` returns one row, a float64 array in
    the column order :func:`var_column_names` lays out, and builds a new
    array each time: ANDES updates its own arrays in place, and the
    aggregator keeps rows until a window closes.
    """

    def __init__(
        self,
        system: System,
        var_groups: list[VarGroup] | tuple[VarGroup, ...],
        dae_vars: Sequence[str] = (),
    ) -> None:
        requested = set(var_groups)
        unknown = requested - set(VAR_GROUPS)
        if unknown:
            raise ValueError(f"unknown var groups: {sorted(unknown)!r}")

        syngen_idx_values = syngen_idx_values_from_system(system)
        readers: list[_Reader] = []
        # Canonical group order, so the row matches ``var_column_names``
        # whatever order the client listed ``vars`` in.
        for group in VAR_GROUPS:
            if group not in requested:
                continue
            if group == "bus_v":
                readers.append(_BusReader(system))
            elif group == "gen_state":
                readers.append(
                    _SynGenReader(system, syngen_idx_values, ("delta", "omega"))
                )
            elif group == "gen_power":
                readers.append(
                    _SynGenReader(
                        system, syngen_idx_values, ("Pe", "Qe"), _mva_base(system)
                    )
                )
            elif group == "line_flow":
                readers.append(
                    _LineFlowReader(system, len(line_idx_values_from_system(system)))
                )
            elif group == "load_pq":
                readers.append(
                    _LoadReader(system, len(pq_idx_values_from_system(system)))
                )
        if dae_vars:
            # Last, in the order asked, as ``var_column_names`` lists them.
            readers.append(_DaeReader(system, list(dict.fromkeys(dae_vars))))

        # (reader, first column, one past its last column)
        self._slots: list[tuple[_Reader, int, int]] = []
        start = 0
        for reader in readers:
            if reader.width:
                self._slots.append((reader, start, start + reader.width))
                start += reader.width
        self.n_columns = start

    def collect(self) -> NDArray[np.float64]:
        """The current step's values, one per column (a new array each call)."""
        row = np.empty(self.n_columns, dtype=np.float64)
        for reader, start, stop in self._slots:
            reader.read(row[start:stop])
        return row


# ---- batch recorder -----------------------------------------------------------

# The most values (rows times columns) a batch run keeps and returns. A response
# of this size is about 10 MB of JSON.
MAX_TRACE_VALUES = 500_000


class TraceRecorder:
    """Keeps every step's row of a :class:`StreamCollector`, for a batch run that
    returns the values it recorded, where a streaming run sends them as frames.

    Rows are kept at full resolution (every step ANDES takes) until
    ``max_values`` values are held; the rows after that are dropped and
    :attr:`truncated` says so, so a long run on a big selection still returns
    its summary.
    """

    def __init__(
        self,
        collector: StreamCollector,
        names: Sequence[str],
        max_values: int = MAX_TRACE_VALUES,
    ) -> None:
        self._collector = collector
        self._names = list(names)
        self._max_rows = max(1, max_values // max(1, collector.n_columns))
        self._t: list[float] = []
        self._rows: list[NDArray[np.float64]] = []
        self.truncated = False

    def record(self, t: float, system: object) -> None:
        """Take the collector's row for the step at time ``t``."""
        if len(self._t) >= self._max_rows:
            self.truncated = True
            return
        self._t.append(float(t))
        self._rows.append(self._collector.collect())

    def result(self) -> dict[str, Any]:
        """``{"t": [...], "variables": [{"name", "values"}, ...], "truncated": bool}``,
        a value that is not a number (``nan``, ``inf``) as ``None``."""
        values = (
            np.vstack(self._rows) if self._rows else np.empty((0, len(self._names)), np.float64)
        )
        return {
            "t": list(self._t),
            "variables": [
                {
                    "name": name,
                    "values": [
                        float(v) if math.isfinite(v) else None for v in values[:, column]
                    ],
                }
                for column, name in enumerate(self._names)
            ],
            "truncated": self.truncated,
        }


# ---- aggregator -------------------------------------------------------------


@dataclass
class StreamAggregator:
    """Buffers per-step ``(t, values)`` snapshots and decides when to emit.

    Modes:

    - ``decimation="none"`` + ``max_rate_hz=None`` — every push emits as a
      one-row batch (no aggregation; one Arrow batch per source step).
    - ``decimation="none"`` + ``max_rate_hz=N`` — buffer until
      ``next_emit_t``, then emit all buffered rows as one Arrow batch
      (N-rows-per-batch; cuts Arrow framing overhead).
    - ``decimation="mean"`` + ``max_rate_hz=N`` — buffer until
      ``next_emit_t``, then emit one row whose values are the mean of all
      buffered values (anti-aliased decimation; output rate = N Hz).

    ``decimation="mean"`` requires ``max_rate_hz`` (the aggregation window
    is ``1/max_rate_hz`` simulated seconds). The constructor raises
    ``ValueError`` if the combination is invalid.
    """

    decimation: DecimationMode
    max_rate_hz: float | None
    fixed_step: bool = False  # ANDES TDS.config.fixt
    _next_emit_t: float | None = None
    _buffer: list[StreamRow] | None = None

    def __post_init__(self) -> None:
        if self.decimation == "mean" and self.max_rate_hz is None:
            raise ValueError(
                "decimation='mean' requires max_rate_hz to be set "
                "(the aggregation window is 1/max_rate_hz seconds)"
            )
        self._buffer = []

    @property
    def algorithm(self) -> DecimationAlgorithm:
        """Honest algorithm label for the stream-start metadata."""
        if self.decimation == "none":
            return "none"
        # For mean: only label "boxcar-mean" if integrator is fixed-step;
        # otherwise the math is best-effort because samples aren't uniformly
        # spaced in simulated time.
        return "boxcar-mean" if self.fixed_step else "boxcar-mean-best-effort"

    @property
    def output_rate_hz(self) -> float | None:
        """Output emission rate (Hz) declared in the stream-start metadata.

        ``None`` when no rate-bound aggregation is active (every source
        step emits)."""
        return self.max_rate_hz if self.max_rate_hz is not None else None

    @property
    def aggregation_window(self) -> float | None:
        """Aggregation window in simulated seconds, or ``None`` if no rate."""
        return 1.0 / self.max_rate_hz if self.max_rate_hz is not None else None

    def push(
        self, t: float, values: Sequence[float] | NDArray[np.float64]
    ) -> list[StreamRow] | None:
        """Add a per-step snapshot. Returns the list of rows to emit as one
        Arrow batch, or ``None`` if no emit is due yet.

        The aggregator keeps ``values`` until its window closes, so the caller
        must pass a row of its own, not a view of an array that is changed in
        place afterwards.

        Window alignment is anchored to the t=0 simulation origin so windows
        are predictable: [0, W), [W, 2W), ... A sample at exactly the
        boundary t=k*W belongs to window k (the higher-numbered one) and
        seeds the new window's buffer; the previous window's accumulated
        rows emit.
        """
        assert self._buffer is not None  # set in __post_init__
        # ANDES calls ``callpert`` with the same mutable 0-d array (``dae.t``)
        # every step, so a buffered row that kept the reference would read as
        # the newest step's time once emitted. Take the value now.
        t = float(t)
        window = self.aggregation_window

        if window is None:
            # decimation="none" + no rate → emit immediately, no buffering.
            return [(t, values)]

        # Anchor the first emit deadline to the t=0 origin: the next boundary
        # is the smallest k*W strictly greater than t. (k = floor(t/W) + 1)
        if self._next_emit_t is None:
            self._next_emit_t = (int(t // window) + 1) * window

        if t < self._next_emit_t:
            # Still inside the current window — buffer and don't emit.
            self._buffer.append((t, values))
            return None

        # Window boundary crossed. Drain the previous window's contents and
        # emit them now; the just-pushed sample belongs to the new window.
        rows = self._drain_buffer()

        # Advance the window. Multiple boundaries may have passed in rare
        # cases (large jumps in simulated t); align next_emit_t to the next
        # boundary strictly greater than the current sample.
        while self._next_emit_t <= t:
            self._next_emit_t += window

        # Seed the new window with the just-pushed sample.
        self._buffer.append((t, values))
        return rows

    def flush(self) -> list[StreamRow] | None:
        """Emit any buffered rows at end of run. Returns ``None`` if buffer
        is empty (e.g., no callpert fired since the last emit)."""
        assert self._buffer is not None
        if not self._buffer:
            return None
        return self._drain_buffer()

    def _drain_buffer(self) -> list[StreamRow]:
        assert self._buffer is not None
        rows: list[StreamRow]
        if self.decimation == "none":
            rows = list(self._buffer)
        else:  # mean
            t_mean = sum(b[0] for b in self._buffer) / len(self._buffer)
            window = np.array([b[1] for b in self._buffer], dtype=np.float64)
            rows = [(t_mean, window.mean(axis=0))]
        self._buffer.clear()
        return rows


__all__ = [
    "DEFAULT_VARS",
    "MAX_TRACE_VALUES",
    "VAR_GROUPS",
    "DecimationAlgorithm",
    "DecimationMode",
    "StreamAggregator",
    "StreamCollector",
    "StreamRow",
    "TraceRecorder",
    "VarGroup",
    "bus_idx_values_from_system",
    "decode_batch",
    "encode_batch",
    "line_idx_values_from_system",
    "pq_idx_values_from_system",
    "syngen_idx_values_from_system",
    "var_column_names",
]
