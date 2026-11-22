"""The ``ext.sienna`` block of a TDS request: Sienna-native dynamic components.

Spec section 6.2: "Everything without a neutral meaning is the engine's own
and goes under ``ext.<engine>``, validated by that engine's adapter against a
list it publishes. No pass-through of arbitrary keys." The list this adapter
publishes is ``INVERTER_PARAMETER_SETS``; capabilities name its ids.

Two parameter sets at first scope, one grid-following and one grid-forming,
each a complete PSID ``DynamicInverter`` parameterisation in PowerSystems'
own constructor keyword names, so the Julia side is a table lookup and never
a key mapping. Each is one of PSID 0.16.2's own tested inverters, part for
part (``test/data_tests`` of the installed package), so no number is
invented and no combination is untried:

- ``gfl-omib``: ``inv_gfoll`` of ``test24.jl``: ``converter_low_power``,
  ``outer_control_gfoll`` (active and reactive power PI), ``current_mode_inner``,
  ``dc_source_lv``, ``reduced_pll`` and ``filt_gfoll`` of
  ``dynamic_test_data.jl``.
- ``gfm-omib``: ``inv_case78`` of ``dynamic_test_data.jl``:
  ``converter_high_power``, ``outer_control`` (virtual inertia and reactive
  power droop), ``inner_control`` (voltage mode), ``dc_source_lv``, ``pll``
  (Kaura) and ``filt``.

An inverter takes the power base of the generator it is given to.
"""

from __future__ import annotations

import math
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from tensa.core.errors import TdsRequestError
from tensa.engines.keys import KeyBook

# Each value is a dict with exactly the keys ``converter``, ``outer_control``,
# ``inner_control``, ``dc_source``, ``freq_estimator``, ``filter``, each a
# dict of the PSID constructor's keyword names to numbers. Tuples of the
# Julia constructors (limits, the Se pair) are lists here, which JSON carries.
INVERTER_PARAMETER_SETS: dict[str, dict[str, Any]] = {
    "gfl-omib": {
        "converter": {"rated_voltage": 690.0, "rated_current": 2.75},
        "outer_control": {
            "active": {"kind": "ActivePowerPI", "Kp_p": 2.0, "Ki_p": 30.0, "ωz": 0.132 * 2.0 * math.pi * 50.0},
            "reactive": {"kind": "ReactivePowerPI", "Kp_q": 2.0, "Ki_q": 30.0, "ωf": 0.132 * 2.0 * math.pi * 50.0},
        },
        "inner_control": {"kind": "CurrentModeControl", "kpc": 0.37, "kic": 0.7, "kffv": 1.0},
        "dc_source": {"voltage": 600.0},
        "freq_estimator": {
            "kind": "ReducedOrderPLL",
            "ω_lp": 1.32 * 2.0 * math.pi * 50.0,
            "kp_pll": 2.0,
            "ki_pll": 20.0,
        },
        "filter": {"kind": "LCLFilter", "lf": 0.009, "rf": 0.016, "cf": 2.5, "lg": 0.002, "rg": 0.003},
    },
    "gfm-omib": {
        "converter": {"rated_voltage": 138.0, "rated_current": 100.0},
        "outer_control": {
            "active": {"kind": "VirtualInertia", "Ta": 2.0, "kd": 400.0, "kω": 20.0},
            "reactive": {"kind": "ReactivePowerDroop", "kq": 0.2, "ωf": 1000.0},
        },
        "inner_control": {
            "kind": "VoltageModeControl",
            "kpv": 0.59,
            "kiv": 736.0,
            "kffv": 0.0,
            "rv": 0.0,
            "lv": 0.2,
            "kpc": 1.27,
            "kic": 14.3,
            "kffi": 0.0,
            "ωad": 50.0,
            "kad": 0.2,
        },
        "dc_source": {"voltage": 600.0},
        "freq_estimator": {"kind": "KauraPLL", "ω_lp": 500.0, "kp_pll": 0.084, "ki_pll": 4.69},
        "filter": {"kind": "LCLFilter", "lf": 0.08, "rf": 0.003, "cf": 0.074, "lg": 0.2, "rg": 0.01},
    },
}

# The parts every parameter set is made of, in the DynamicInverter's own order.
PARAMETER_SET_PARTS = (
    "converter",
    "outer_control",
    "inner_control",
    "dc_source",
    "freq_estimator",
    "filter",
)


class DynamicBranchSpec(BaseModel):
    """One branch to simulate dynamically (PSID's ``DynamicBranch``)."""

    model_config = ConfigDict(extra="forbid")

    target: str = Field(..., description="A branch key, ``branch:<from>-<to>-<ckt>``.")


class InverterSpec(BaseModel):
    """A PSID inverter attached to a generator that has no .dyr record."""

    model_config = ConfigDict(extra="forbid")

    target: str = Field(..., description="A generator key, ``gen:<bus>-<id>``.")
    parameter_set: str = Field(..., description="An id of ``INVERTER_PARAMETER_SETS``.")


class SiennaExtSpec(BaseModel):
    """The ``ext.sienna`` block of a TDS request."""

    model_config = ConfigDict(extra="forbid")

    dynamic_branches: list[DynamicBranchSpec] = Field(
        default_factory=list,
        max_length=64,
        description=(
            "Branches simulated with their own dynamics (PSID's DynamicBranch) "
            "instead of as a static admittance, by branch key."
        ),
    )
    inverters: list[InverterSpec] = Field(
        default_factory=list,
        max_length=64,
        description=(
            "Generators without a dynamic model that run as a PSID inverter, "
            "each with one of the parameter sets the capabilities list."
        ),
    )


def _branch_address(key: str) -> tuple[int, int, str]:
    """The ``(from, to, ckt)`` of a branch key, split from the left as
    ``_add_handle`` in ``state.py`` splits an add's key."""
    rest = key.partition(":")[2]
    first, _, rest2 = rest.partition("-")
    second, _, ckt = rest2.partition("-")
    return int(first), int(second), ckt


def _generator_address(key: str) -> tuple[int, str]:
    """The ``(bus, id)`` of a generator key."""
    rest = key.partition(":")[2]
    bus, _, ordinal = rest.partition("-")
    return int(bus), ordinal


def _topology_branch(topology: dict[str, Any], name: Any) -> dict[str, Any] | None:
    """The topology's branch row whose Julia name is ``name``, as
    ``convert.py``'s ``_key(book, "Line", name)`` joins them."""
    rows: list[dict[str, Any]] = topology.get("branches", [])
    for row in rows:
        if str(row.get("name")) == str(name):
            return row
    return None


def _topology_generator(topology: dict[str, Any], name: Any) -> dict[str, Any] | None:
    """The topology's generator row whose Julia name is ``name``."""
    rows: list[dict[str, Any]] = topology.get("generators", [])
    for row in rows:
        if str(row.get("name")) == str(name):
            return row
    return None


def validate_ext(spec: SiennaExtSpec, book: KeyBook, topology: dict[str, Any]) -> None:
    """Check every target against the key book and the topology.

    Raises :class:`TdsRequestError` (the class ``run_tds``'s other refusals
    use, which the route maps to 422) with the exact messages the unit names.
    """
    seen_branches: set[str] = set()
    for branch in spec.dynamic_branches:
        key = branch.target
        entry = book.entry_of(key)
        if entry is None or entry.bucket not in ("line", "transformer", "branch"):
            raise TdsRequestError(f"ext.sienna: no branch with key {key}")
        if key in seen_branches:
            raise TdsRequestError(f"ext.sienna: branch {key} is listed twice")
        seen_branches.add(key)
        row = _topology_branch(topology, entry.idx)
        if row is not None and not bool(row.get("available", True)):
            raise TdsRequestError(f"ext.sienna: branch {key} is out of service")

    seen_generators: set[str] = set()
    for inverter in spec.inverters:
        key = inverter.target
        entry = book.entry_of(key)
        if entry is None or entry.bucket != "generator":
            raise TdsRequestError(f"ext.sienna: no generator with key {key}")
        if key in seen_generators:
            raise TdsRequestError(f"ext.sienna: generator {key} is listed twice")
        if inverter.parameter_set not in INVERTER_PARAMETER_SETS:
            sets = ", ".join(sorted(INVERTER_PARAMETER_SETS))
            raise TdsRequestError(
                f"ext.sienna: unknown inverter parameter set {inverter.parameter_set}; "
                f"the sets are {sets}"
            )
        seen_generators.add(key)
        row = _topology_generator(topology, entry.idx)
        if row is not None and not bool(row.get("available", True)):
            raise TdsRequestError(f"ext.sienna: generator {key} is out of service")
        for dynamic in topology.get("dynamics", []):
            if str(dynamic.get("generator")) == str(entry.idx):
                raise TdsRequestError(
                    f"ext.sienna: generator {key} already has a dynamic model; "
                    "an inverter is given only to a generator without one"
                )


def ext_to_json(spec: SiennaExtSpec, book: KeyBook) -> dict[str, Any]:
    """The JSON document the Julia side reads.

    ``{"dynamic_branches": [{"from": 7, "to": 8, "ckt": "1"}, ...],
    "inverters": [{"bus": 1, "id": "1", "parameter_set": "gfl-omib"}, ...]}``

    Addresses, not keys: the Julia module finds components by bus numbers and
    ids, as ``_check_disturbances`` does for ``branch_trip`` (``from``,
    ``to``, ``ckt``) and ``gen_trip`` (``bus``, ``id``). The key has already
    been validated; the address is parsed from it.
    """
    branches = []
    for branch in spec.dynamic_branches:
        from_bus, to_bus, ckt = _branch_address(branch.target)
        branches.append({"from": from_bus, "to": to_bus, "ckt": ckt})
    inverters = []
    for inverter in spec.inverters:
        bus, ordinal = _generator_address(inverter.target)
        inverters.append({"bus": bus, "id": ordinal, "parameter_set": inverter.parameter_set})
    return {"dynamic_branches": branches, "inverters": inverters}
