"""Which buses a case file gives a rated voltage for.

ANDES fills in 110 kV for a bus whose rated voltage (``Vn``) the case leaves out
or sets to zero, and keeps no record of it: the loaded System holds 110 either
way. A client that reads ``Vn`` as the bus's voltage base would then show a made-up
kV figure for such a case, so the server names the buses whose ``Vn`` is that
fill-in. What each reader leaves behind decides how:

- PSS/E RAW: a zero ``BASKV`` reaches the parameter, which corrects it and notes
  the device until ``System.setup`` reports the corrections and clears the list;
- xlsx: the rows of the ``Bus`` sheet stay on the System as ``df_in``;
- json: ANDES keeps nothing, so the file is read again;
- MATPOWER: ANDES keeps nothing and the reader swaps a ``baseKV`` of 0 for 110
  before the parameter sees it, so the bus matrix is parsed again.

``buses_without_rated_voltage`` has to run right after the case is loaded and
before ``setup()``. When the answer cannot be worked out (a reader ANDES has
changed, a file that no longer parses) it names every bus, so the client keeps
the voltages per unit instead of trusting one.
"""

from __future__ import annotations

import json
import logging
import math
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

logger = logging.getLogger("tensa.rated_voltage")

# The column of the MATPOWER bus matrix that holds ``baseKV``.
_MATPOWER_BASE_KV_COLUMN = 9


def buses_without_rated_voltage(ss: Any, case_path: Path) -> frozenset[int | str]:
    """The idx of every bus whose ``Vn`` the case at ``case_path`` does not give.

    ``ss`` is the System just loaded from it, still before ``setup()``.
    """
    idx_values = _bus_idx(ss)
    if not idx_values:
        return frozenset()
    try:
        flags = _not_given_flags(ss, case_path, idx_values)
    except Exception as exc:  # noqa: BLE001 - any failure falls back to "none is a base"
        logger.warning("could not tell which buses the case rates: %s: %s", type(exc).__name__, exc)
        flags = None
    if flags is None:
        return frozenset(idx_values)
    return frozenset(idx for idx, not_given in zip(idx_values, flags, strict=True) if not_given)


def still_without_rated_voltage(ss: Any, recorded: frozenset[int | str]) -> list[int | str]:
    """The ``recorded`` buses whose ``Vn`` is still ANDES's fill-in, in bus order.

    A bus whose ``Vn`` has been edited since the load now has a base the user gave,
    so it drops out. (One edited to exactly the fill-in value cannot be told from
    one left alone and stays in.)
    """
    if not recorded:
        return []
    bus = getattr(ss, "Bus", None)
    vn = getattr(bus, "Vn", None)
    if vn is None:
        return []
    default = vn.default
    return [
        idx
        for idx, value in zip(_bus_idx(ss), vn.v, strict=False)
        if idx in recorded and value == default
    ]


def _bus_idx(ss: Any) -> list[int | str]:
    idx_var = getattr(getattr(ss, "Bus", None), "idx", None)
    return list(getattr(idx_var, "v", None) or [])


def _not_given_flags(ss: Any, case_path: Path, idx_values: list[int | str]) -> list[bool] | None:
    """One flag per bus, in bus order: ``True`` when the case gives it no ``Vn``.

    ``None`` when the format is not one this knows how to read back.
    """
    input_format = getattr(getattr(ss, "files", None), "input_format", None)
    if input_format == "psse":
        corrections = getattr(ss.Bus, "_param_corrections", {})
        corrected = set(corrections.get(("Vn", "non_zero"), ()))
        return [idx in corrected for idx in idx_values]
    if input_format == "xlsx":
        rows: Sequence[Mapping[str, Any]] = ss.df_in["Bus"].to_dict(orient="records")
    elif input_format == "json":
        with case_path.open(encoding="utf-8") as handle:
            rows = json.load(handle)["Bus"]
    elif input_format == "matpower":
        from andes.io.matpower import m2mpc  # heavy import: kept lazy

        matrix = m2mpc(str(case_path))["bus"]
        rows = [{"Vn": row[_MATPOWER_BASE_KV_COLUMN]} for row in matrix]
    else:
        return None
    if len(rows) != len(idx_values):
        # The rows are not the buses the System holds, so none can be matched.
        return None
    return [_not_given(row.get("Vn")) for row in rows]


def _not_given(value: Any) -> bool:
    """Whether a ``Vn`` cell is one ANDES replaces: absent, blank or zero."""
    if value is None:
        return True
    try:
        number = float(value)
    except (TypeError, ValueError):
        return False
    return math.isnan(number) or number == 0.0
