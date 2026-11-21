"""MATPOWER v2 ``.m`` writer.

ANDES 2.0 ships a MATPOWER reader (``andes.io.matpower.m2mpc``) and a
System-to-mpc converter (``system2mpc``) but no dict-to-file writer. This
module fills the gap for the save flow: when the user picks ``m`` as the
save format, the substrate calls ``write_matpower(ss, path)``, the way
``tensa.core.psse_writer.write_raw`` is called for ``.raw``.

``system2mpc`` is not handed the session's System itself, for three reasons
found against ANDES 2.0.0:

- Before setup (the state a session is in until its first run) a numeric
  param's ``.v`` is a Python list, which ``system2mpc`` multiplies by a float
  and fails on. Turning those lists into arrays on the live System would
  break every element added after the save, since ``add`` appends to them.
- Before setup ``.v`` is also on the device's own base: the impedance of a
  line rated other than the system base, or with ``Vn1`` other than the
  voltage of its bus, is only converted at setup (``System.calc_pu_coeff``).
  A ``.m`` holds every value on the system base.
- A bus idx that is text reaches ``_get_bus_id_caller`` as a list of
  strings, whose numpy dtype is not ``object``, so the converter takes the
  text for a bus number and fails (``could not convert string to float``).

So ``system2mpc`` is given a view of the System (``_SystemView``): fresh
arrays on the system base, with every bus reference already turned into its
MATPOWER bus number. The System is not changed, so there is nothing to put
back.

Bus numbers: when every bus idx is a positive integer, it is the bus number.
Otherwise every bus is numbered ``uid + 1`` (1 to n in the order of the
case), the rule ANDES's ``_get_bus_id_caller`` states for text idxes. The
bus names are written in ``mpc.bus_name`` either way.

What a ``.m`` holds, and what it loses. ``write_matpower`` returns the
losses that apply to the System as notes, which ``save_case`` logs on
``tensa.notice`` so they reach the session's Messages log:

- Bus, PQ, Shunt, PV, Slack and Line, the power-flow data ``system2mpc``
  exports. Every other model (a machine, an exciter, a governor, a ZIP or
  other dynamic load, an area, a disturbance) is not in the file: save as
  ``xlsx`` or ``json`` to keep them.
- A MATPOWER bus has one load and one shunt, so the in-service ``PQ`` and
  ``Shunt`` devices of a bus are added up into it, and those out of service
  are left out. (``system2mpc`` keeps only the last device of a bus and
  ignores ``u``, so this writer fills those four columns itself.)
- Bus area and zone are written as zero (``system2mpc`` does not export
  them). A bus out of service is written as type 4 (isolated), which ANDES's
  reader reads back as a bus in service.
- The idx of every device: ANDES numbers the devices of a ``.m`` afresh when
  it reads one.

Conventions of the output, all of which ``m2mpc`` reads back:

- ``function mpc = <stem>`` header line, the file's stem sanitized to a
  MATLAB identifier (letters, digits, underscore, not starting with a
  digit; anything else becomes ``_``). ``m2mpc`` skips that line.
- ``mpc.version = '2';`` and ``mpc.baseMVA = <value>;``.
- ``mpc.bus``, ``mpc.gen``, ``mpc.branch`` sections, one row per device,
  each row ended by ``;``, in the column order ``m2mpc`` documents (bus:
  13 columns; gen: 21, slack rows first, which is the order
  ``system2mpc`` fills; branch: 17).
- ``mpc.bus_name = {`` ... ``};`` with one quoted name per line, last,
  because ``m2mpc`` has no end for that section. A character of a name
  the reader cannot carry is written as ``_`` (``_bus_name_text``).
- Percent-sign comments naming the columns above each section, as real
  MATPOWER cases have; the parser skips them.

Numbers are written ``%.10g``, and as plain integers where the value is
integral (bus ids, status, type), so the file stays diff-friendly. The
file is written as UTF-8 with LF line endings on every platform.
"""

from __future__ import annotations

import logging
import math
import re
from collections import Counter
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np

if TYPE_CHECKING:
    from andes.system import System

log = logging.getLogger("tensa.matpower_writer")

# The models a ``.m`` holds. Every other model with devices is reported as
# left out.
EXPORTED_MODELS: tuple[str, ...] = ("Bus", "PQ", "Shunt", "PV", "Slack", "Line")

_BUS_COLUMNS = "bus_i  type  Pd  Qd  Gs  Bs  area  Vm  Va  baseKV  zone  Vmax  Vmin"
_GEN_COLUMNS = (
    "bus  Pg  Qg  Qmax  Qmin  Vg  mBase  status  Pmax  Pmin  Pc1  Pc2  "
    "Qc1min  Qc1max  Qc2min  Qc2max  ramp_agc  ramp_10  ramp_30  ramp_q  apf"
)
_BRANCH_COLUMNS = (
    "fbus  tbus  r  x  b  rateA  rateB  rateC  ratio  angle  status  "
    "angmin  angmax  Pf  Qf  Pt  Qt"
)

# The params ``system2mpc`` reads of each model it is given.
_BUS_PARAMS = ("v0", "a0", "Vn", "vmax", "vmin")
_GEN_PARAMS = ("p0", "q0", "qmax", "qmin", "v0", "u", "pmax", "pmin")
_LINE_PARAMS = ("r", "x", "b", "rate_a", "rate_b", "rate_c", "tap", "phi", "u")

# The bus columns this writer fills itself from each load or shunt model:
# (model, ((column, param), ...)).
_ADDED_UP = (
    ("PQ", ((2, "p0"), (3, "q0"))),
    ("Shunt", ((4, "g"), (5, "b"))),
)


def _matlab_identifier(stem: str) -> str:
    """The file's stem as a valid MATLAB identifier: letters, digits and
    underscore, not starting with a digit; anything else becomes ``_``."""
    cleaned = re.sub(r"[^0-9A-Za-z_]", "_", stem)
    if not cleaned:
        return "mpc_case"
    if cleaned[0].isdigit():
        cleaned = f"case_{cleaned}"
    return cleaned


def _num(value: Any) -> str:
    """One number of a row: an integer where the value is integral, else
    ``%.10g``. Non-finite values (ANDES writes none here) become 0."""
    try:
        f = float(value)
    except (TypeError, ValueError):
        return "0"
    if not math.isfinite(f):
        return "0"
    if f.is_integer() and abs(f) < 1e15:
        return str(int(f))
    return f"{f:.10g}"


def _bus_name_text(name: Any) -> str:
    """A bus name as ANDES's reader can read it back. ``m2mpc`` reads a name
    line by splitting it on ``;`` and ``=``, dropping ``[`` and ``{``, ending
    the section at a ``]`` and stripping the quotes without undoing MATLAB's
    doubled quote, so each of those characters, and any control character,
    is written as ``_``. The count of names stays that of the buses, which
    ANDES's reader needs to apply them at all."""
    return re.sub(r"[';=\[\]{}\x00-\x1f\x7f]", "_", str(name))


def _section(name: str, columns: str, rows: Any) -> list[str]:
    """One ``mpc.<name> = [ ... ];`` section with its column comment."""
    lines = [f"% {columns}", f"mpc.{name} = ["]
    for row in rows:
        lines.append("\t" + "  ".join(_num(v) for v in row) + ";")
    lines.append("];")
    return lines


def _is_bus_number(idx: Any) -> bool:
    """Whether a bus idx can stand as a MATPOWER bus number as it is."""
    if isinstance(idx, bool):
        return False
    if isinstance(idx, (int, np.integer)):
        return int(idx) > 0
    if isinstance(idx, (float, np.floating)):
        f = float(idx)
        return math.isfinite(f) and f.is_integer() and f > 0
    return False


def bus_numbers(system: System) -> tuple[list[int], bool]:
    """The MATPOWER number of each bus, in uid order, and whether the buses
    were numbered afresh (``uid + 1``) because an idx is not a positive
    integer."""
    idxes = list(system.Bus.idx.v)
    if all(_is_bus_number(idx) for idx in idxes):
        return [int(idx) for idx in idxes], False
    return list(range(1, len(idxes) + 1)), True


def _bus_uids(system: System) -> dict[Any, int]:
    """The uid of each bus by its idx."""
    return {idx: uid for uid, idx in enumerate(system.Bus.idx.v)}


def _system_base(system: System, model: Any, name: str) -> Any:
    """``model.<name>`` on the system base, as a fresh float array.

    After setup ANDES holds it so already. Before setup it is on the
    device's base, and is converted here by the coefficients
    ``System.calc_pu_coeff`` applies at setup: the same ``Sn``, ``Vn`` and
    bus voltage, picked by the same property flags of the param.
    """
    param = getattr(model, name)
    values = np.array(param.v, dtype=float)
    if system.is_setup or model.n == 0:
        return values
    sb = float(system.config.mva)
    sn: Any = np.asarray(model.Sn.v, dtype=float) if "Sn" in model.__dict__ else sb
    vb: Any = 1.0
    vn: Any = 1.0
    bus_vn = np.asarray(system.Bus.Vn.v, dtype=float)
    uids = _bus_uids(system)
    if "bus" in model.__dict__:
        vb = bus_vn[[uids[ref] for ref in model.bus.v]]
        vn = np.asarray(model.Vn.v, dtype=float) if "Vn" in model.__dict__ else vb
    elif "bus1" in model.__dict__:
        vb = bus_vn[[uids[ref] for ref in model.bus1.v]]
        vn = np.asarray(model.Vn1.v, dtype=float) if "Vn1" in model.__dict__ else vb
    zn = vn**2 / sn
    zb = vb**2 / sb
    coeffs: dict[str, Any] = {
        "voltage": vn / vb,
        "power": sn / sb,
        "ipower": sb / sn,
        "current": (sn / vn) / (sb / vb),
        "z": zn / zb,
        "y": zb / zn,
    }
    for prop, coeff in coeffs.items():
        if param.get_property(prop) is True:
            return values * coeff
    return values


class _Param:
    """A param of the view: only the ``.v`` that ``system2mpc`` reads."""

    def __init__(self, values: Any) -> None:
        self.v = values


class _Model:
    """A model of the view: ``n``, its params as attributes, and the
    ``idx2uid`` that ``system2mpc`` calls on the Bus with bus numbers."""

    def __init__(
        self, n: int, params: dict[str, _Param], uid_of: dict[int, int] | None = None
    ) -> None:
        self.n = n
        for name, param in params.items():
            setattr(self, name, param)
        self._uid_of = uid_of or {}

    def idx2uid(self, numbers: Any) -> list[int]:
        return [self._uid_of[int(number)] for number in np.atleast_1d(numbers)]


class _Config:
    def __init__(self, mva: float) -> None:
        self.mva = mva


class _SystemView:
    """What ``system2mpc`` reads of a System: fresh arrays on the system
    base, every bus reference given as its MATPOWER bus number. ``PQ`` and
    ``Shunt`` are empty here; ``write_matpower`` adds them up itself."""

    def __init__(self, system: System, numbers: list[int]) -> None:
        self.config = _Config(float(system.config.mva))
        number_of = dict(zip(list(system.Bus.idx.v), numbers, strict=True))

        def refs(values: Any) -> _Param:
            return _Param(np.array([number_of[value] for value in values], dtype=float))

        bus = system.Bus
        bus_params = {name: _Param(_system_base(system, bus, name)) for name in _BUS_PARAMS}
        bus_params["idx"] = _Param(np.array(numbers, dtype=np.int64))
        bus_params["name"] = _Param(list(bus.name.v))
        uid_of = {number: uid for uid, number in enumerate(numbers)}
        self.Bus = _Model(bus.n, bus_params, uid_of)
        self.PQ = _Model(0, {})
        self.Shunt = _Model(0, {})
        for model_name, extra in (("PV", ()), ("Slack", ("a0",))):
            model = getattr(system, model_name)
            params = {
                name: _Param(_system_base(system, model, name))
                for name in (*_GEN_PARAMS, *extra)
            }
            params["bus"] = refs(model.bus.v)
            setattr(self, model_name, _Model(model.n, params))
        line = system.Line
        line_params = {name: _Param(_system_base(system, line, name)) for name in _LINE_PARAMS}
        line_params["bus1"] = refs(line.bus1.v)
        line_params["bus2"] = refs(line.bus2.v)
        self.Line = _Model(line.n, line_params)


def _add_up_loads(system: System, bus: Any) -> tuple[int, list[Any]]:
    """Add the in-service PQ and Shunt devices into the bus rows, in MW and
    MVAr. Returns how many were out of service and left out, and the buses
    that had more than one of a kind added up."""
    mva = float(system.config.mva)
    uids = _bus_uids(system)
    dropped = 0
    merged: list[Any] = []
    for model_name, columns in _ADDED_UP:
        model = getattr(system, model_name)
        if model.n == 0:
            continue
        status = np.asarray(model.u.v, dtype=float)
        rows = np.array([uids[ref] for ref in model.bus.v], dtype=int)
        for column, name in columns:
            np.add.at(bus[:, column], rows, _system_base(system, model, name) * mva * status)
        dropped += int(np.count_nonzero(status == 0))
        counts = Counter(ref for ref, u in zip(model.bus.v, status, strict=True) if u)
        merged.extend(ref for ref, count in counts.items() if count > 1)
    return dropped, list(dict.fromkeys(merged))


def _notes(system: System, renumbered: bool, dropped: int, merged: list[Any]) -> list[str]:
    """What the ``.m`` does not hold of the System, in words for the user."""
    notes: list[str] = []
    left_out = sorted(
        f"{name} ({model.n})"
        for name, model in system.models.items()
        if name not in EXPORTED_MODELS and model.n > 0
    )
    if left_out:
        notes.append(
            "a MATPOWER file holds the power-flow data only; not written: "
            + ", ".join(left_out)
            + ". Save as xlsx or json to keep them"
        )
    if renumbered:
        notes.append(
            "a bus idx is not a positive integer, so the buses are numbered "
            "1 to n in the order of the case; their names are kept"
        )
    if merged:
        notes.append(
            "a MATPOWER bus has one load and one shunt: the devices on bus "
            + ", ".join(str(idx) for idx in merged)
            + " are added up into one"
        )
    if dropped:
        notes.append(f"{dropped} load or shunt device(s) out of service are not written")
    return notes


def write_matpower(system: System, path: str | Path) -> list[str]:
    """Write the System to a MATPOWER v2 ``.m`` file at ``path``.

    Returns notes on what the file does not hold of the System (empty when
    it holds all of it). Raises ``OSError`` if the file can't be written,
    ``KeyError`` for a device on a bus the System does not have, and
    whatever ``andes.io.matpower.system2mpc`` raises. The System is read,
    never changed. The caller (``save_case``) writes into a temporary file
    of the workspace, validates it and moves it onto the target.
    """
    from andes.io.matpower import system2mpc

    target = Path(path)
    numbers, renumbered = bus_numbers(system)
    mpc = system2mpc(_SystemView(system, numbers))

    bus = mpc["bus"]
    dropped, merged = _add_up_loads(system, bus)
    bus[np.asarray(system.Bus.u.v, dtype=float) == 0, 1] = 4

    output: list[str] = [
        f"function mpc = {_matlab_identifier(target.stem)}",
        "% MATPOWER v2 case (tensa export)",
        "",
        "mpc.version = '2';",
        "",
        f"mpc.baseMVA = {_num(mpc['baseMVA'])};",
        "",
    ]
    output.extend(_section("bus", _BUS_COLUMNS, bus))
    output.append("")
    output.extend(_section("gen", _GEN_COLUMNS, mpc["gen"]))
    output.append("")
    output.extend(_section("branch", _BRANCH_COLUMNS, mpc["branch"]))

    if system.Bus.n > 0:
        output.append("")
        output.append("mpc.bus_name = {")
        for name, idx in zip(mpc["bus_name"], system.Bus.idx.v, strict=True):
            output.append(f"\t'{_bus_name_text(idx if name is None else name)}';")
        output.append("};")

    target.write_text("\n".join(output) + "\n", encoding="utf-8", newline="\n")
    log.info("wrote MATPOWER v2 file: %s (%d lines)", target, len(output))
    return _notes(system, renumbered, dropped, merged)
