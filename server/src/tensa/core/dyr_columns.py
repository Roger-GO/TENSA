"""The columns of PSS/E ``.dyr`` records that ANDES reads in an order of its own.

ANDES 2.0.0's PSS/E reader names the columns of each ``.dyr`` model by the
``inputs`` list of its ``andes/io/psse-dyr.yaml``. For two exciters that list is
not the order PSS/E writes the record in, so every value after the first few
lands on another parameter:

- ``ESAC1A``: PSS/E writes ``TR TB TC KA TA VAMAX VAMIN TE KF TF KC KD KE E1
  SE(E1) E2 SE(E2) VRMAX VRMIN``; ANDES reads ``TR TB TC VAMAX VAMIN KA TA
  VRMAX VRMIN TE E1 SE1 E2 SE2 KC KD KE KF TF``. On the ESAC1A benchmark of
  PowerSimulationsDynamics (``KA`` 200, ``TA`` 0.05, ``TE`` 1.333, ``KE`` 1)
  ANDES held ``KA`` 7, ``TA`` -7 (which its own check then changed), ``TE``
  0.8 and ``KE`` 0.
- ``ESST1A``: PSS/E writes the flags ``UEL VOS`` and then ``TR VIMAX VIMIN TC
  TB TC1 TB1 KA TA VAMAX VAMIN VRMAX VRMIN KC KF TF KLR ILR``; ANDES reads
  ``TB TC TB1 TC1 VAMAX VAMIN KA TA ILR KLR VRMAX VRMIN KF TF KC`` after
  ``VIMIN``.

The PSS/E order is the one PowerSystems.jl reads (``psse_dynamic_mapping.yaml``),
whose benchmarks reproduce PSS/E's own results. Decision 25 of
``design/multiengine/decisions.md`` holds the case file as the reference for
what a system is: where an engine's reader departs from the file, its adapter
puts the file's value back and says so. ``put_back_dyr_columns`` does that for
the models in ``PSSE_COLUMNS``, on a System read with ``setup=False``. It
compares the table with the order of the installed ANDES (``andes_columns``)
and does nothing for a model whose order already agrees, so a release of ANDES
that reads PSS/E's order is left alone. ANDES checks the range of a parameter
(a time constant that must not be negative, for one) as its reader adds the
device, so a value put back here has not been through that check: it is the
file's, as PSS/E would run it.

Records are matched to devices as ANDES's reader matches them: the machine on
the record's bus with the record's id (``SynGen.find_idx`` on ``bus`` and
``subidx``), then the device of the model whose ``syn`` is that machine.
"""

from __future__ import annotations

import functools
import importlib
import logging
import math
import os
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

from tensa.core.messages import NOTICE_LOGGER

logger = logging.getLogger(NOTICE_LOGGER)

# The ANDES parameter each column of a PSS/E record sets, in PSS/E's order,
# after the bus number and the machine id. ``UELc`` and ``VOSc`` are where
# ANDES keeps ESST1A's two flags (its yaml maps ``UEL`` and ``VOS`` to them).
PSSE_COLUMNS: Final[dict[str, tuple[str, ...]]] = {
    "ESAC1A": (
        "TR", "TB", "TC", "KA", "TA", "VAMAX", "VAMIN", "TE", "KF", "TF",
        "KC", "KD", "KE", "E1", "SE1", "E2", "SE2", "VRMAX", "VRMIN",
    ),
    "ESST1A": (
        "UELc", "VOSc", "TR", "VIMAX", "VIMIN", "TC", "TB", "TC1", "TB1",
        "KA", "TA", "VAMAX", "VAMIN", "VRMAX", "VRMIN", "KC", "KF", "TF",
        "KLR", "ILR",
    ),
}


@dataclass(frozen=True)
class DyrRecord:
    """One record of a ``.dyr`` file: its model, bus, machine id and the
    values after them, as ANDES's reader splits them."""

    model: str
    bus: float
    machine_id: float
    values: tuple[float, ...]


def _number(token: str) -> float:
    try:
        return float(token)
    except ValueError:
        return math.nan


def read_dyr_records(text: str) -> list[DyrRecord]:
    """The records of a ``.dyr`` file, as ANDES 2.0.0's ``_read_dyr_dict``
    splits them: a record ends at the first ``/`` of a line (the rest of that
    line is dropped), the model is the text between the first two quotes, and
    the other tokens, commas taken as spaces, are numbers. A record with fewer
    than two tokens besides the model is left out."""
    records: list[DyrRecord] = []
    pending: list[str] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        if "/" not in line:
            pending.append(line)
            continue
        pending.append(line.split("/")[0])
        record = " ".join(pending)
        pending = []
        if not record.strip():
            continue
        parts = record.split("'")
        if len(parts) < 3:
            continue
        model = parts[1].strip()
        tokens = (parts[0] + " " + " ".join(parts[2:])).replace(",", " ").split()
        if len(tokens) < 2:
            continue
        numbers = [_number(token) for token in tokens]
        records.append(DyrRecord(model, numbers[0], numbers[1], tuple(numbers[2:])))
    return records


@functools.cache
def _andes_dyr_spec() -> Any:
    """The installed ANDES's ``io/psse-dyr.yaml``, read once; ``None`` when
    it cannot be read. PyYAML comes with ANDES and has no type stubs."""
    import andes  # heavy import, kept lazy

    yaml = importlib.import_module("yaml")
    path = Path(os.path.dirname(andes.__file__)) / "io" / "psse-dyr.yaml"
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - an unreadable yaml means nothing to correct
        return None


def andes_columns(model: str) -> tuple[str, ...] | None:
    """The parameters the installed ANDES sets from a record of ``model``, in
    column order after the bus and the id; ``None`` when its yaml has no
    ``inputs`` for the model or cannot be read."""
    try:
        entry = _andes_dyr_spec()[model]
        inputs = [str(name) for name in entry["inputs"]]
        outputs = {str(k): v for k, v in entry.get("outputs", {}).items()}
    except Exception:  # noqa: BLE001 - an unreadable yaml means nothing to correct
        return None
    # The yaml names an input by its PSS/E column and maps it to the ANDES
    # parameter through ``outputs`` (``UELc: UEL``); a plain name maps to itself.
    by_input = {str(source): target for target, source in outputs.items() if isinstance(source, str)}
    return tuple(by_input.get(name, name) for name in inputs[2:])


def _device_position(ss: Any, model_obj: Any, record: DyrRecord) -> int | None:
    """The position of the device of ``model_obj`` that ANDES made of
    ``record``: the one whose machine is on the record's bus with its id."""
    try:
        machine = ss.SynGen.find_idx(
            ["bus", "subidx"], [[record.bus], [record.machine_id]], allow_none=True
        )[0]
    except Exception:  # noqa: BLE001 - no machine means no device to correct
        return None
    if machine is None:
        return None
    syns = list(model_obj.syn.v)
    return syns.index(machine) if machine in syns else None


def put_back_dyr_columns(
    ss: Any, addfiles: Sequence[str | Path] | None, *, notify: bool = True
) -> list[str]:
    """Give each device ANDES read from a ``.dyr`` record of a model in
    ``PSSE_COLUMNS`` the record's values by PSS/E's column order.

    ``ss`` is the System just read from the case and ``addfiles``, still before
    ``setup()``. Answers one line per device corrected, naming the parameters
    that changed; with ``notify`` each line is also a warning on
    ``tensa.notice``, which the session's Messages log shows.
    """
    notes: list[str] = []
    for addfile in addfiles or ():
        path = Path(addfile)
        if path.suffix.lower() != ".dyr":
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for record in read_dyr_records(text):
            psse = PSSE_COLUMNS.get(record.model)
            model_obj = getattr(ss, record.model, None)
            if psse is None or model_obj is None:
                continue
            andes_order = andes_columns(record.model)
            if andes_order is None or andes_order[: len(psse)] == psse:
                continue
            position = _device_position(ss, model_obj, record)
            if position is None:
                continue
            changed: list[str] = []
            for column, name in enumerate(psse):
                if column >= len(record.values):
                    break
                param = getattr(model_obj, name, None)
                if param is None:
                    continue
                value = record.values[column]
                held = param.v[position]
                if held == value:
                    continue
                param.v[position] = value
                changed.append(f"{name} {value:g} (ANDES held {held:g})")
            if not changed:
                continue
            note = (
                f"{record.model} on the machine at bus {record.bus:g}, id {record.machine_id:g}: "
                "ANDES reads this model's .dyr columns in an order other than PSS/E's; "
                "the file's values were put back: " + ", ".join(changed)
            )
            notes.append(note)
            if notify:
                logger.warning("%s", note)
    return notes


__all__ = [
    "PSSE_COLUMNS",
    "DyrRecord",
    "andes_columns",
    "put_back_dyr_columns",
    "read_dyr_records",
]
