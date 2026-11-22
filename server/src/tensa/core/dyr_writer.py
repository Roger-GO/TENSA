"""PSS/E ``.dyr`` writer: the dynamic models of a loaded ANDES System.

ANDES 2.0 ships a PSS/E dynamic reader (``andes.io.psse.read_add``, driven by
``andes/io/psse-dyr.yaml``) but no writer. This module is the exact inverse of
that reader: :func:`write_dyr` writes one record for every device of every
dynamic model of the System that the reader can read back (a yaml entry whose
``destination`` is the device's model), so a ``.raw`` written by
``tensa.core.psse_writer.write_raw`` plus the ``.dyr`` written here load
through ANDES (and through PowerSystems) as the case they were written from.

How a record is built, inverting ``read_add``:

- The yaml is read from the installed ANDES. A record is
  ``BUS 'MODEL' ID v1 v2 ... /`` with the values in the entry's ``inputs``
  order after ``BUS`` and ``ID``. A record longer than one line is continued
  on the next lines, each under 100 characters; the reader joins lines until
  the first ``/``. Numbers are written as Python's ``repr`` of the float, the shortest text that reads back as the same number, so that reading them
  back gives the same float; whole floats are written as integers.
- ``BUS`` and ``ID`` are what the reader's ``find`` looks the device's
  machine or generator up by: for a machine model (``GENROU``, ``GENCLS``,
  ``GENSAL``) the bus and ``subidx`` of the static generator its ``gen``
  names; for a controller (``syn`` names a machine) the bus and ``subidx``
  of that machine's static generator. The id is the static generator's
  ``subidx``, which is also the id ``write_raw`` writes for that generator
  (``_generator_block`` numbers the generators of a bus from 1 in model
  order, and ANDES's raw reader numbers ``subidx`` the same way), so the two
  files written together name the same generators.
- Each ``inputs`` column's value is the ANDES parameter the entry's
  ``outputs`` sets from it, read from the parameter's ``vin`` when the
  System has been set up (``setup()`` puts ``v`` on the system base; ``vin``
  keeps the value as the case gave it) and from ``v`` before setup. The
  conversions of the yaml are inverted: ``M: "<model>.H; lambda x: 2 * x"``
  writes ``H = M / 2``; ``busr: "...BUSR; lambda x: [None if (i == 0) else
  i for i in x]"`` writes 0 for ``None``; ``PLflag: "Fflag; lambda x: 1"``
  writes the ``Fflag`` column from the ``PLflag`` parameter (the reader
  ignores the column's value and sets 1). A column the reader reads and sets
  on no parameter (``Switch`` of ``IEEET1`` and its kin, ``Rselect`` and the
  rest of ``GGOV1``) is written as 0, the value the reader would ignore.
  A parameter that comes through ``get`` from another device (a machine's
  ``Sn`` from its static generator) is not written in the record: it travels
  in the ``.raw``.
- ``ESAC1A`` and ``ESST1A`` are written in PSS/E's column order, not
  ANDES's: ``PSSE_COLUMNS`` of ``tensa.core.dyr_columns`` has the order, and
  the load path puts the values back from it (contract 15 of
  ``server/ANDES_VERSIONS.md``), so a file this writer writes is read right
  by ANDES through TENSA and by PowerSystems.
- ``TGOV1N`` (ANDES-only; the same parameters as ``TGOV1``, with its
  reference summed after the droop) is written as a ``TGOV1`` record, with a
  note in the report that its reference path differs.
- A device of a model with no reader entry is not written; the report lists
  it (``skipped``: model and idx).
"""

from __future__ import annotations

import importlib
import logging
import math
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from tensa.core.dyr_columns import PSSE_COLUMNS
from tensa.core.psse_writer import raw_generator_ids

if TYPE_CHECKING:
    from andes.system import System

log = logging.getLogger("tensa.dyr_writer")

# The dynamic models of a System the writer walks, in the order their records
# are written: machines first, then their controllers, then the renewable
# chain, so the file reads as a PSS/E dynamic file does. A model of the
# System that is not listed and has a reader entry is still written, after
# these, in the yaml's order.
_MODEL_ORDER = (
    "GENCLS",
    "GENROU",
    "GENSAL",
    "IEEET1",
    "IEEET3",
    "IEEEX1",
    "EXDC2",
    "ESDC1A",
    "ESDC2A",
    "EXAC1",
    "EXAC2",
    "EXAC4",
    "AC8B",
    "EXST1",
    "ESST1A",
    "ESST3A",
    "ESST4B",
    "ESAC1A",
    "SEXS",
    "IEEEVC",
    "TGOV1",
    "TGOV1N",
    "GAST",
    "HYGOV",
    "IEESGO",
    "IEEEG1",
    "IEEEST",
    "ST2CUT",
    "REGCA1",
    "REECA1",
    "REECB1",
    "REPCA1",
    "WTDTA1",
    "WTARA1",
    "WTPTA1",
    "WTTQA1",
)

# The PSS/E model a record is written as when it differs from the ANDES
# model, and the note the report carries for it.
_WRITE_AS: dict[str, tuple[str, str]] = {
    "TGOV1N": (
        "TGOV1",
        "TGOV1N was written as a TGOV1 record; TGOV1N sums its reference "
        "after the droop where TGOV1 sums it before, so a run of the file "
        "in PSS/E or PowerSystems differs from ANDES's TGOV1N",
    ),
}

# Columns the reader reads and sets on no parameter: written as 0, the value
# the reader would ignore. Keyed by PSS/E model, then column name.
_IGNORED_COLUMNS: dict[str, frozenset[str]] = {
    "IEEET1": frozenset({"Switch"}),
    "IEEEX1": frozenset({"Switch"}),
    "EXDC2": frozenset({"Switch"}),
    "ESDC1A": frozenset({"Switch"}),
    "ESDC2A": frozenset({"Switch"}),
    "GGOV1": frozenset(
        {
            "Rselect",
            "Fswitch",
            "Tpelec",
            "maxerr",
            "minerr",
            "Kpgov",
            "KIgov",
            "Kdgov",
            "Tdgov",
            "VMAX",
            "VMIN",
            "Tact",
            "Kturb",
            "Wfnl",
            "Tb",
            "Tc",
            "Teng",
            "Tfload",
            "Kpload",
            "KIload",
            "Ldref",
            "Dm",
            "Ropen",
            "Rclose",
            "KImw",
            "Aset",
            "Ka",
            "Ta",
            "Trate",
            "db",
            "Tsa",
            "Tsb",
            "Rup",
            "Rdown",
        }
    ),
}


@dataclass(frozen=True)
class DyrSkipped:
    """A device that was not written: its model and its idx."""

    model: str
    idx: str


@dataclass
class DyrWriteReport:
    """What :func:`write_dyr` did: the records written per model, the devices
    no reader entry covers, and what the file cannot say (a model written as
    another, a column the reader ignores)."""

    records: dict[str, int] = field(default_factory=dict)
    skipped: list[DyrSkipped] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def _dyr_yaml() -> dict[str, Any]:
    """The installed ANDES's ``io/psse-dyr.yaml``. PyYAML comes with ANDES
    and has no type stubs, so it is imported the way
    ``tensa.core.dyr_columns`` imports it."""
    import andes  # heavy import, kept lazy

    yaml = importlib.import_module("yaml")
    path = Path(os.path.dirname(andes.__file__)) / "io" / "psse-dyr.yaml"
    loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
    return dict(loaded) if isinstance(loaded, dict) else {}


def _number(value: Any) -> str:
    """One value of a record, so that reading it back gives the same float.
    Whole floats are written as integers; the rest with 17 significant
    digits, which round-trips a double."""
    try:
        f = float(value)
    except (TypeError, ValueError):
        return "0"
    if not math.isfinite(f):
        return "0"
    if f == int(f) and abs(f) < 1e15:
        return str(int(f))
    # The shortest text that reads back as the same float (Python's repr).
    return repr(f)


def _param_value(model_obj: Any, name: str, position: int) -> Any:
    """The value of parameter ``name`` of device ``position``: from ``vin``
    when the System has been set up (``v`` is then on the system base and
    ``vin`` keeps the value as the case gave it), from ``v`` before setup."""
    param = getattr(model_obj, name, None)
    if param is None:
        return None
    values = getattr(param, "vin", None)
    if values is None or position >= len(values):
        values = getattr(param, "v", None)
    if values is None or position >= len(values):
        return None
    return values[position]


def _machine_of(ss: System, model_obj: Any, position: int) -> Any:
    """The machine (``SynGen`` idx) a device belongs to: the device itself
    for a machine model, its ``syn`` for a controller, the ``syn`` of its
    exciter for a stabiliser (which names its exciter in ``avr``), ``None``
    when it has none of these."""
    if hasattr(model_obj, "gen"):
        return model_obj
    syn = getattr(model_obj, "syn", None)
    if syn is not None and position < len(syn.v):
        return syn.v[position]
    avr = getattr(model_obj, "avr", None)
    if avr is not None and position < len(avr.v):
        try:
            return ss.Exciter.get(src="syn", idx=avr.v[position], attr="v")
        except Exception:  # noqa: BLE001 - an exciter that is not there names no machine
            return None
    return None


def _bus_and_id(ss: System, model_obj: Any, position: int) -> tuple[Any, Any] | None:
    """The ``BUS`` and ``ID`` of the record of device ``position``: the bus
    and ``subidx`` of the static generator the device's machine names (the
    machine itself for a machine model)."""
    machine = _machine_of(ss, model_obj, position)
    if machine is None:
        return None
    if hasattr(model_obj, "gen") and model_obj is machine:
        machine_idx = model_obj.idx.v[position]
    else:
        machine_idx = machine
    try:
        gen_idx = ss.SynGen.get(src="gen", idx=machine_idx, attr="v")
    except Exception:  # noqa: BLE001 - a machine with no static generator is not written
        return None
    try:
        bus = ss.StaticGen.get(src="bus", idx=gen_idx, attr="v")
    except Exception:  # noqa: BLE001 - no static generator means no record
        return None
    # The id the .raw gives this generator, so the two files name one machine.
    machine_id = raw_generator_ids(ss).get(gen_idx)
    if machine_id is None:
        return None
    return bus, machine_id


def _outputs_by_input(entry: dict[str, Any]) -> dict[str, str]:
    """The ANDES parameter each input column sets, from the entry's
    ``outputs``: a plain value names the column it reads (``TR: TR``), a
    ``"<model>.<param>; lambda ..."`` value names the parameter the column
    feeds (``M`` from ``H``)."""
    by_input: dict[str, str] = {}
    for target, source in entry.get("outputs", {}).items():
        if not isinstance(source, str):
            continue
        if ";" in source:
            args = source.split(";")[0].split(",")[0].strip()
            column = args.split(".")[-1]
            by_input.setdefault(column, str(target))
        else:
            by_input.setdefault(source, str(target))
    return by_input


def _links_of(psse_model: str) -> frozenset[str]:
    """The ANDES parameters of a reader entry that a record does not carry:
    the ones its ``outputs`` fill from a ``get`` or a ``find`` (another
    device's value or idx), and the status and bus."""
    entry = _dyr_yaml().get(psse_model, {})
    if not isinstance(entry, dict):
        return frozenset({"u", "bus"})
    looked_up = set(entry.get("get", {}) or {}) | set(entry.get("find", {}) or {})
    targets = {
        str(target)
        for target, source in (entry.get("outputs", {}) or {}).items()
        if isinstance(source, str) and source.split(";")[0].strip() in looked_up
    }
    return frozenset(targets | {"u", "bus"})


def _column_value(
    ss: System,
    psse_model: str,
    model_obj: Any,
    position: int,
    column: str,
    by_input: dict[str, str],
) -> Any:
    """The value one column of the record of device ``position`` is written
    with, inverting what the reader does with the column."""
    if column in _IGNORED_COLUMNS.get(psse_model, frozenset()):
        return 0
    target = by_input.get(column)
    if target is None:
        return 0
    if target == "M":
        # The reader sets M = 2 * H; write H = M / 2.
        m = _param_value(model_obj, "M", position)
        try:
            return float(m) / 2.0
        except (TypeError, ValueError):
            return 0
    if target == "busr" or target == "busr2":
        # The reader turns a remote bus of 0 into None; write 0 for None.
        value = _param_value(model_obj, target, position)
        return 0 if value is None else value
    if target == "PLflag":
        # The reader sets PLflag to 1 whatever the Fflag column holds; write
        # the parameter it came from.
        return _param_value(model_obj, "PLflag", position) or 0
    if target in _links_of(psse_model):
        # A link, or a value the reader takes from another device through
        # ``get`` (GENCLS's xd1 is its generator's xs), travels in the .raw.
        return None
    return _param_value(model_obj, target, position)


def _record_tokens(
    ss: System,
    psse_model: str,
    entry: dict[str, Any],
    model_obj: Any,
    position: int,
) -> list[str] | None:
    """The tokens of one record (bus, model, id, values), or ``None`` when
    the device has no static generator to name."""
    found = _bus_and_id(ss, model_obj, position)
    if found is None:
        return None
    bus, subidx = found
    inputs = [str(name) for name in entry.get("inputs", [])]
    columns = inputs[2:]
    psse_order = PSSE_COLUMNS.get(psse_model)
    by_input = _outputs_by_input(entry)
    # ESAC1A and ESST1A are written in PSS/E's column order, which the load
    # path puts back (contract 15); a column PSS/E has and ANDES's inputs
    # lack keeps the parameter the table names.
    ordered = list(psse_order) if psse_order is not None else columns
    values: list[str] = []
    for column in ordered:
        value = _column_value(ss, psse_model, model_obj, position, column, by_input)
        if value is None:
            value = 0
        values.append(_number(value))
    return [_number(bus), f"'{psse_model}'", _number(subidx), *values]


def _record_lines(tokens: list[str]) -> list[str]:
    """One record as lines under 100 characters, the last ending in ``/``."""
    lines: list[str] = []
    current = ""
    for token in tokens:
        candidate = f"{current} {token}" if current else token
        if len(candidate) > 90 and current:
            lines.append(current)
            current = token
        else:
            current = candidate
    lines.append(f"{current} /")
    return lines


def write_dyr(ss: System, path: str | Path) -> DyrWriteReport:
    """Write the dynamic models of ``ss`` as a PSS/E ``.dyr`` file at
    ``path``, as the exact inverse of ANDES's reader. See the module
    docstring for the rules. Returns the report of what was written."""
    yaml_spec = _dyr_yaml()
    # The PSS/E models whose destination is a model of the System, in the
    # write order: the listed models first, then any other reader entry.
    destinations: dict[str, str] = {}
    for psse_model, entry in yaml_spec.items():
        if not isinstance(entry, dict):
            continue
        destination = entry.get("destination")
        inputs = entry.get("inputs")
        if not destination or not inputs or len(inputs) < 2:
            continue
        if inputs[0] != "BUS" or inputs[1] != "ID":
            # Toggle and Fault records are events, not dynamic models.
            continue
        # Several PSS/E models can read into one ANDES model (GENSAL into
        # GENROU); a device is written as the PSS/E model of its own name
        # when there is one, else as the first that reads into it.
        if str(psse_model) == str(destination):
            destinations[str(destination)] = str(psse_model)
        else:
            destinations.setdefault(str(destination), str(psse_model))

    # An ANDES-only model written as a PSS/E model of the same parameters
    # (TGOV1N as TGOV1) has no reader entry of its own.
    for andes_model, (psse_model, _note) in _WRITE_AS.items():
        if psse_model in yaml_spec:
            destinations.setdefault(andes_model, psse_model)

    report = DyrWriteReport()
    lines: list[str] = []
    order = [m for m in _MODEL_ORDER if m in destinations]
    order += sorted(m for m in destinations if m not in _MODEL_ORDER)
    noted: set[str] = set()
    for andes_model in order:
        model_obj = getattr(ss, andes_model, None)
        n = int(getattr(model_obj, "n", 0) or 0) if model_obj is not None else 0
        if model_obj is None or n == 0:
            continue
        psse_model, note = _WRITE_AS.get(andes_model, (destinations[andes_model], ""))
        entry = yaml_spec.get(psse_model)
        if not isinstance(entry, dict):
            entry = yaml_spec.get(destinations[andes_model], {})
        if note and andes_model not in noted:
            report.notes.append(note)
            noted.add(andes_model)
        written = 0
        for position in range(n):
            tokens = _record_tokens(ss, psse_model, entry, model_obj, position)
            if tokens is None:
                idx = model_obj.idx.v[position] if hasattr(model_obj, "idx") else str(position)
                report.skipped.append(DyrSkipped(model=andes_model, idx=str(idx)))
                continue
            lines.extend(_record_lines(tokens))
            written += 1
        if written:
            report.records[psse_model] = report.records.get(psse_model, 0) + written

    # A dynamic device of a model no reader entry covers is listed, not
    # written. The models walked are the ones ANDES groups as dynamic.
    for group_name in ("SynGen", "Exciter", "TurbineGov", "PSS", "RenGen",
                       "RenExciter", "RenGovernor", "RenAerodynamics",
                       "RenPitch", "DynLoad"):
        group = ss.groups.get(group_name) if hasattr(ss, "groups") else None
        if group is None:
            continue
        for model_name, model_obj in group.models.items():
            if model_name in destinations:
                continue
            n = int(getattr(model_obj, "n", 0) or 0)
            for position in range(n):
                idx = model_obj.idx.v[position] if hasattr(model_obj, "idx") else str(position)
                report.skipped.append(DyrSkipped(model=model_name, idx=str(idx)))

    target = Path(path)
    text = "\n".join(lines) + "\n" if lines else ""
    # ``newline`` keeps the LF endings on every platform.
    target.write_text(text, encoding="utf-8", newline="\n")
    log.info(
        "wrote PSS/E dyr file: %s (%d records, %d skipped)",
        target,
        sum(report.records.values()),
        len(report.skipped),
    )
    return report


__all__ = ["DyrSkipped", "DyrWriteReport", "write_dyr"]
