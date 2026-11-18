#!/usr/bin/env python3
"""Solve an example case's power flow with pandapower, as an independent reference.

Usage:
    python scripts/crosscheck_pf.py dump  ID_OR_FILE -o NETWORK.json
    python scripts/crosscheck_pf.py solve NETWORK.json|CASE.m [--example ID] [--write]
    python scripts/crosscheck_pf.py run   ID [--write]
    python scripts/crosscheck_pf.py stored ID [--write] [--enforce-q-limits]
    python scripts/crosscheck_pf.py report REPORT.txt --raw CASE.RAW --solved-raw SOLVED.RAW \\
        --example ID --origin TEXT [--write] [--enforce-q-limits]

TENSA solves a power flow with ANDES. To check it against a solver that shares none of its
code, this script solves the same data with pandapower and writes the bus voltages and angles
(and the losses and the slack's power) into the case's reference file
(``server/src/tensa/examples/references/<id>.json``), which ``scripts/verify_example_cases.py``
compares a run of TENSA with.

pandapower is NOT a dependency of TENSA and must not become one. It lives in an environment
of its own (``python -m venv verify-env``, then ``verify-env/bin/pip install pandapower
matpowercaseframes``; ``verify-env\\Scripts`` on Windows), and ANDES lives in TENSA's, so the
work is in two steps that meet at a file:

``dump``   (TENSA's environment, needs ANDES) loads a case and writes the network ANDES holds
           as a MATPOWER case in JSON: ``baseMVA``, ``bus``, ``gen`` and ``branch`` as rows of
           MATPOWER's columns, in the order of ``MATPOWER_BUS``, ``MATPOWER_GEN`` and
           ``MATPOWER_BRANCH`` below. ANDES values are read after ``setup``, per unit on the
           system base, the way its own power flow uses them. A model the power flow solves
           that the dump does not know (a switched shunt, a jumper) stops it with an error
           rather than give a reference for a different network.
``solve``  (the verification environment, needs pandapower) builds a pandapower network from
           that file, or straight from a MATPOWER ``.m`` file (read by matpowercaseframes) or a
           PSS/E ``.raw`` file (read by the reader in this script), with no ANDES involved at
           all, solves it (Newton-Raphson, tolerance 1e-8 MVA,
           reactive limits not enforced, as TENSA's default), and prints the result, or with
           ``--write`` puts it into the reference file.
``run``    does both, each with the Python that has what it needs: the one running the script
           when that has it, otherwise ``--tensa-python`` or ``--verify-python`` (or the
           environment variables ``TENSA_PYTHON`` and ``TENSA_VERIFY_PYTHON``).
``stored`` (TENSA's environment, needs ANDES) reads the solved state a case file carries (the
           bus voltages and angles and the slack's power, as the file holds them before any
           power flow of ANDES's) and writes them as ``stored-solution`` checks. They are
           worth writing only where the file's state is a solution: a RAW file written by
           PSS/E after it solved the case holds one, a file that was saved before the case was
           solved holds a state the power flow then moves (IEEE 39 holds one that is 0.2 pu
           from its solution), and the harness fails the check for such a file. A state kept
           to fewer digits than a solver gives, or saved from a run that was not tight, has a
           basis of its own in ``STORED_BASES``, with the tolerance its source allows (the IEEE
           118-bus data carries the archive's three-decimal state, which is 0.017 pu from a
           solution, and the IEEE 300-bus file the archive's state of data that has a phase
           shifter the file has lost).

``report`` (needs neither ANDES nor pandapower) reads a load flow report that PSS/E printed, as
           a published solution of a RAW file: the bus voltages and angles, and the power of the
           slack, as ``published`` checks. The report was made from a copy of the case's file, so
           the command first compares the two RAW files (every bus, every generator in service,
           every branch and transformer) and stops if the networks differ.

What the network holds, and where it differs from what ANDES solves, is listed in
``MODELLING`` below. The bus numbers are the ANDES ``idx`` of the buses, which is what
TENSA's power flow answers by.
"""

from __future__ import annotations

import argparse
import contextlib
import importlib.util
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, NamedTuple

REPO_ROOT = Path(__file__).resolve().parent.parent
SERVER_SRC = REPO_ROOT / "server" / "src"
REFERENCES = SERVER_SRC / "tensa" / "examples" / "references"

# What marks a check as one this script wrote, so that running it again replaces that check
# and leaves the ones written by hand. The stored solution has a mark of its own, since the
# power flow of ``solve`` and the state of ``stored`` are written at different times.
GENERATED_BY = "scripts/crosscheck_pf.py"
STORED_BY = "scripts/crosscheck_pf.py stored"
REPORT_BY = "scripts/crosscheck_pf.py report"
# What marks a check whose power flow is run with the reactive limits enforced (the check names
# it in ``pflow``), so that it is written beside the one at the defaults and not over it.
LIMITS_FLAG = " --enforce-q-limits"

# The columns of the arrays in a network file, as MATPOWER numbers them (case format v2).
MATPOWER_BUS = (
    "BUS_I",
    "BUS_TYPE",
    "PD",
    "QD",
    "GS",
    "BS",
    "BUS_AREA",
    "VM",
    "VA",
    "BASE_KV",
    "ZONE",
    "VMAX",
    "VMIN",
)
MATPOWER_GEN = (
    "GEN_BUS",
    "PG",
    "QG",
    "QMAX",
    "QMIN",
    "VG",
    "MBASE",
    "GEN_STATUS",
    "PMAX",
    "PMIN",
)
MATPOWER_BRANCH = (
    "F_BUS",
    "T_BUS",
    "BR_R",
    "BR_X",
    "BR_B",
    "RATE_A",
    "RATE_B",
    "RATE_C",
    "TAP",
    "SHIFT",
    "BR_STATUS",
    "ANGMIN",
    "ANGMAX",
)

MODELLING = """\
Where the pandapower network differs from what ANDES solves:
- ANDES adds 1e-8 to a line's r and x to keep a zero impedance away from a division by zero. The
  dump leaves it out; the effect is far under the tolerance of the check.
- A load is constant power here. ANDES turns a load into a constant impedance while its bus
  voltage is outside the load's [vmin, vmax] (0.8 to 1.2 pu by default); a case with a bus
  voltage that low is not a case this check is for.
- Reactive limits are not enforced (TENSA's default). A generator's reactive power is whatever
  holds its voltage.
- The conductance a line shares and the conductance and susceptance ANDES holds at one end of a
  line go in as shunts on the end buses (divided by the tap squared on the from side), which
  is what the ANDES line equations say; the susceptance a line shares is the branch's own.
- A MATPOWER branch with a ratio of 0 and a phase shift: MATPOWER takes the ratio as 1 and
  applies the shift, ANDES 2.0.0's reader (``andes/io/matpower.py``) calls a branch a
  transformer only when its ratio is not 0 (or is 1 with a shift) and drops the shift of any
  other. ``solve`` of a ``.m`` file leaves those shifts out too, so that the reference is the
  solution of the network ANDES holds, says which it left out, and gives how far the solution
  with them is (``shift_effect``). The dump holds what ANDES holds, so it needs no such step.
"""

# What the dump can be sure of: the models the power flow solves that it translates.
_TRANSLATED_MODELS = frozenset({"Bus", "PQ", "PV", "Slack", "Shunt", "Line"})
# What the power flow lists and the dump may leave out, because it does not change the solution.
_HARMLESS_MODELS = frozenset({"Area", "Region", "Zone", "Owner", "Fault", "Toggle", "Alter"})


class CrosscheckError(Exception):
    """The case cannot be turned into a network, or cannot be solved."""


# ----------------------------------------------------------------------------------------
# dump: ANDES system -> MATPOWER case (needs ANDES)
# ----------------------------------------------------------------------------------------


def dump_network(system: Any) -> dict[str, Any]:
    """The MATPOWER case of a set-up ANDES ``System``, as a JSON-able dict.

    ``system`` has been through ``setup()`` and not through a power flow, so every parameter
    is per unit on the system base and every status is as the case file gave it.
    """
    models = {
        name
        for name, model in system.models.items()
        if getattr(model.flags, "pflow", False) and model.n
    }
    unknown = sorted(models - _TRANSLATED_MODELS - _HARMLESS_MODELS)
    if unknown:
        raise CrosscheckError(
            "the case has devices the power flow solves that the dump does not translate: "
            + ", ".join(unknown)
        )
    base = float(system.config.mva)
    bus = system.Bus
    index = {idx: i for i, idx in enumerate(bus.idx.v)}
    if not index:
        raise CrosscheckError("the case has no buses")

    def pos(idx: Any, what: str) -> int:
        try:
            return index[idx]
        except KeyError:
            raise CrosscheckError(
                f"{what} is on bus {idx!r}, which the case does not have"
            ) from None

    if not all(bus.u.v):
        raise CrosscheckError(
            "the case has a bus that is out of service, which the dump leaves out"
        )
    rows = [[0.0] * len(MATPOWER_BUS) for _ in index]
    for i in range(len(index)):
        row = rows[i]
        # Numbered 1 to n; ``bus_idx`` says which ANDES idx each number is.
        row[0] = float(i + 1)
        row[1] = 1.0
        row[6] = float(bus.area.v[i]) if bus.area.v[i] else 1.0
        row[7] = 1.0
        row[9] = float(bus.Vn.v[i])
        row[10] = 1.0
        row[11] = float(bus.vmax.v[i])
        row[12] = float(bus.vmin.v[i])

    gens: list[list[float]] = []
    for model_name in ("PV", "Slack"):
        model = getattr(system, model_name)
        for k in range(model.n):
            i = pos(model.bus.v[k], f"{model_name} {model.idx.v[k]!r}")
            on = bool(model.u.v[k])
            gens.append(
                [
                    float(i + 1),
                    float(model.p0.v[k]) * base,
                    float(model.q0.v[k]) * base,
                    float(model.qmax.v[k]) * base,
                    float(model.qmin.v[k]) * base,
                    float(model.v0.v[k]),
                    base,
                    1.0 if on else 0.0,
                    float(model.pmax.v[k]) * base,
                    float(model.pmin.v[k]) * base,
                ]
            )
            if model_name == "Slack":
                if not on:
                    raise CrosscheckError("the slack generator is out of service")
                rows[i][1] = 3.0
                rows[i][7] = float(model.v0.v[k])
                rows[i][8] = math.degrees(float(model.a0.v[k]))
            elif on and rows[i][1] != 3.0:
                rows[i][1] = 2.0
                rows[i][7] = float(model.v0.v[k])
    if not any(row[1] == 3.0 for row in rows):
        raise CrosscheckError("the case has no slack bus")

    for k in range(system.PQ.n):
        if not system.PQ.u.v[k]:
            continue
        i = pos(system.PQ.bus.v[k], f"load {system.PQ.idx.v[k]!r}")
        rows[i][2] += float(system.PQ.p0.v[k]) * base
        rows[i][3] += float(system.PQ.q0.v[k]) * base

    def add_shunt(i: int, g: float, b: float) -> None:
        # MATPOWER: GS is the MW a shunt takes at 1 pu, BS the MVAr it injects at 1 pu.
        rows[i][4] += g * base
        rows[i][5] += b * base

    for k in range(system.Shunt.n):
        if system.Shunt.u.v[k]:
            i = pos(system.Shunt.bus.v[k], f"shunt {system.Shunt.idx.v[k]!r}")
            add_shunt(i, float(system.Shunt.g.v[k]), float(system.Shunt.b.v[k]))

    line = system.Line
    branches: list[list[float]] = []
    for k in range(line.n):
        i1 = pos(line.bus1.v[k], f"line {line.idx.v[k]!r}")
        i2 = pos(line.bus2.v[k], f"line {line.idx.v[k]!r}")
        tap = float(line.tap.v[k]) or 1.0
        on = bool(line.u.v[k])
        if on:
            # What ANDES keeps at the ends beyond the shared susceptance (see MODELLING).
            add_shunt(
                i1,
                (float(line.g1.v[k]) + 0.5 * float(line.g.v[k])) / tap**2,
                float(line.b1.v[k]) / tap**2,
            )
            add_shunt(i2, float(line.g2.v[k]) + 0.5 * float(line.g.v[k]), float(line.b2.v[k]))
        branches.append(
            [
                float(i1 + 1),
                float(i2 + 1),
                float(line.r.v[k]),
                float(line.x.v[k]),
                float(line.b.v[k]),
                float(line.rate_a.v[k]),
                float(line.rate_b.v[k]),
                float(line.rate_c.v[k]),
                tap,
                math.degrees(float(line.phi.v[k])),
                1.0 if on else 0.0,
                -360.0,
                360.0,
            ]
        )
    return {
        "baseMVA": base,
        "f_hz": float(system.config.freq),
        "bus_idx": list(bus.idx.v),
        "bus": rows,
        "gen": gens,
        "branch": branches,
        "branch_idx": list(line.idx.v),
        "machines": _classical_machines(system, pos),
        "columns": {
            "bus": list(MATPOWER_BUS),
            "gen": list(MATPOWER_GEN),
            "branch": list(MATPOWER_BRANCH),
        },
    }


# The groups whose devices the network of a dump stands for, or that change nothing in it.
_NETWORK_GROUPS = frozenset(
    {"ACLine", "ACNode", "ACTopology", "Collection", "StaticGen", "StaticLoad", "StaticShunt"}
)
_EVENT_GROUPS = frozenset({"TimedEvent"})


def _file_events(system: Any) -> list[dict[str, Any]]:
    """The line trips (``Toggle`` of a ``Line``) and faults the case file holds that are on.

    They are written the way ``POST /sessions/{id}/disturbances`` takes them, so that the
    classical check integrates what the file says without a second copy of it in the reference.
    A ``Toggle`` of another model is left out: the classical check refuses a disturbance it
    does not know when it reads one, and says so.
    """
    events: list[dict[str, Any]] = []
    toggles = system.Toggle
    for k in range(toggles.n):
        if toggles.u.v[k]:
            events.append(
                {
                    "kind": "toggle",
                    "model": str(toggles.model.v[k]),
                    "dev_idx": toggles.dev.v[k],
                    "t": float(toggles.t.v[k]),
                }
            )
    faults = system.Fault
    for k in range(faults.n):
        if faults.u.v[k]:
            events.append(
                {
                    "kind": "fault",
                    "bus_idx": faults.bus.v[k],
                    "tf": float(faults.tf.v[k]),
                    "tc": float(faults.tc.v[k]),
                    "xf": float(faults.xf.v[k]),
                    "rf": float(faults.rf.v[k]),
                }
            )
    return events


def _classical_machines(system: Any, pos: Any) -> dict[str, Any]:
    """The machines of the classical model (``GENCLS``) the case holds, per unit on the base.

    ``scripts/crosscheck_classical.py`` reads them. ANDES converts a machine's ``M``, ``D``,
    ``ra`` and ``xd1`` to the system base at ``setup()``, so the values are read as they are.
    ``other_models`` names every other device model of the case that is not part of the
    network (a round-rotor machine, an exciter, a governor), which the classical check cannot
    represent; ``events`` names the models of the events of the file and ``file_events`` gives
    the line trips and the faults among them as the disturbance specs the classical check
    integrates, so that a case whose disturbance is built into its file has one to check.
    """
    machines = system.GENCLS
    other = sorted(
        name
        for group, members in system.groups.items()
        if group not in _NETWORK_GROUPS | _EVENT_GROUPS
        for name, model in members.models.items()
        if model.n and name != "GENCLS"
    )
    events = sorted(
        name
        for group in _EVENT_GROUPS
        for name, model in system.groups[group].models.items()
        if model.n
    )
    return {
        "file_events": _file_events(system),
        "classical": [
            {
                "idx": machines.idx.v[k],
                "bus": float(pos(machines.bus.v[k], f"machine {machines.idx.v[k]!r}") + 1),
                "H": 0.5 * float(machines.M.v[k]),
                "D": float(machines.D.v[k]),
                "ra": float(machines.ra.v[k]),
                "xd1": float(machines.xd1.v[k]),
                "in_service": bool(machines.u.v[k]),
            }
            for k in range(machines.n)
        ],
        "other_models": other,
        "events": events,
    }


def _find_case(target: str) -> tuple[Path, str | None]:
    """The file to dump and the catalog id it belongs to, for an id or a path."""
    path = Path(target)
    if path.is_file():
        return path, None
    sys.path.insert(0, str(SERVER_SRC))
    from tensa.core import examples
    from tensa.core.example_catalog import bundled_cases_dir, load_catalog

    example = load_catalog().get(target)
    if example is None or not example.has_file:
        raise CrosscheckError(f"{target!r} is neither a file nor an example case with a file")
    prov = example.provenance
    assert prov.path is not None
    if prov.kind == "bundled":
        return bundled_cases_dir() / prov.path, example.id
    cases = examples._andes_cases_dir()  # noqa: SLF001
    if cases is None:
        raise CrosscheckError("ANDES is not installed, so its cases cannot be found")
    return cases / prov.path, example.id


def cmd_dump(args: argparse.Namespace) -> int:
    import andes

    path, _ = _find_case(args.target)
    system = andes.load(str(path), setup=False, no_output=True, default_config=True)
    system.setup()
    network = dump_network(system)
    network["source"] = path.name
    Path(args.output).write_text(json.dumps(network, indent=1) + "\n", encoding="utf-8")
    print(
        f"wrote {args.output}: {len(network['bus'])} buses, {len(network['gen'])} generators, "
        f"{len(network['branch'])} branches"
    )
    return 0


# ----------------------------------------------------------------------------------------
# stored: the solved state a case file carries (needs ANDES)
# ----------------------------------------------------------------------------------------


def stored_solution(system: Any) -> dict[str, Any]:
    """The state a case file stores, from a ``System`` read with ``setup=False``.

    The bus voltages (per unit) and angles (degrees) are the ``v0`` and ``a0`` the file gives,
    by the buses' idx, and the slack's power (MW) is the sum of the ``p0`` of its slack
    generators on the system base, all as the file holds them: no power flow has moved them.
    """
    bus = system.Bus
    if not bus.n or not system.Slack.n:
        raise CrosscheckError("the case has no buses or no slack generator")
    base = float(system.config.mva)
    return {
        "bus_voltage": {str(idx): float(v) for idx, v in zip(bus.idx.v, bus.v0.v, strict=True)},
        "bus_angle": {
            str(idx): math.degrees(float(a)) for idx, a in zip(bus.idx.v, bus.a0.v, strict=True)
        },
        "slack_p_mw": sum(float(p) for p in system.Slack.p0.v) * base,
    }


class StoredBasis(NamedTuple):
    """Where a case file's stored state comes from and how close it is to a solution.

    ``slack_p`` is ``None`` for a file that stores no power for its slack (the IEEE 300-bus
    file holds 0 there), and the check of it is then left out. ``omitted`` lists the buses
    (by idx) whose stored state is not a solution while the rest of the file's is, which the
    angle check leaves out and ``origin`` says why.
    """

    origin: str
    voltage: float
    angle: float
    slack_p: float | None
    omitted: tuple[str, ...] = ()


# A RAW file written by PSS/E after it solved the case: the digits the file keeps are the whole
# difference (five decimals of a per unit voltage, four of a degree).
RAW_BASIS = StoredBasis(
    origin="taken from the RAW file it was converted from, to the digits the file keeps",
    voltage=5e-5,
    angle=0.005,
    slack_p=0.1,
)

# A state some other way of keeping a solution: one the file does not hold to a solver's
# precision, so the tolerance is what its own source allows, and the case's entry says why.
STORED_BASES: dict[str, StoredBasis] = {
    # The final voltages and angles of the archive's IEEE CDF file, which MATPOWER's case118.m
    # carries in its bus data as the archive's three decimals of a voltage and two of an angle.
    # They are not a solution of the data: pandapower's and TENSA's solutions of it agree to 1e-7
    # pu and differ from the stored state by up to 0.0173 pu (bus 30) and 0.303 degrees (bus 1),
    # and the stored slack power by 2.5 MW, so the tolerance is the largest of those, rounded up.
    "ieee118": StoredBasis(
        origin=(
            "the final voltages and angles of the University of Washington archive's "
            "ieee118cdf.txt, which this file was converted from and carries to the archive's "
            "three decimals of a voltage and two of an angle; a state saved with the data and "
            "not a solution of it, since it differs from the solution of the same data by up to "
            "0.017 pu and 0.30 degrees"
        ),
        voltage=0.02,
        angle=0.35,
        slack_p=3.0,
    ),
    # The final voltages and angles of the archive's IEEE CDF file, as MATPOWER's case300.m carries
    # them. The archive's data has a phase shifter of -11.4 degrees on branch 196-2040 that the
    # file does not (its shift is 0), and that is why the stored state is off the file's solution: a
    # power flow of the data with the shifter lands on it to 3.2e-4 pu and 0.042 degrees, one of the
    # data as the file has it differs by up to 0.0085 pu and 9.76 degrees (bus 2040, with the
    # median at 0.026 degrees). The file stores no output for the slack (0 MW), so there is no
    # check of it.
    # The final voltages and angles of PowerWorld's solution of the original ACTIV_SG_200 case, as
    # case_ACTIVSg200.m carries them (seven decimals of a voltage, six of an angle). PowerWorld holds
    # the generators to their reactive limits, which a power flow of TENSA's default does not: four
    # generators (buses 67, 94, 114 and 167) are outside theirs without it, and pandapower with the
    # limits enforced lands on the stored state to 1.4e-5 pu and 0.0009 degrees. Without the limits
    # the gap is 0.0038 pu (bus 114) and 0.031 degrees, and the slack's power differs by 0.027 MW.
    "activsg200": StoredBasis(
        origin=(
            "the final voltages and angles of PowerWorld Simulator's solution of the original "
            "ACTIV_SG_200 case, which this file was created from; a state solved with the "
            "generators held to their reactive limits, so it differs from a power flow without "
            "them by up to 0.0038 pu and 0.031 degrees, at the buses of the four generators "
            "that are outside their limits without it"
        ),
        voltage=0.005,
        angle=0.05,
        slack_p=0.05,
    ),
    "ieee300": StoredBasis(
        origin=(
            "the final voltages and angles of the University of Washington archive's "
            "ieee300cdf.txt, which this file was converted from; a state saved with the "
            "archive's data and not a solution of the file's, which lacks the archive's "
            "-11.4 degree phase shifter on branch 196-2040, so it differs from the solution "
            "of the file by up to 0.0085 pu and 9.76 degrees"
        ),
        voltage=0.01,
        angle=10.0,
        slack_p=None,
    ),
    # The state RTE's snapshot gives the PEGASE 89-bus data, which MATPOWER's case89pegase.m carries
    # (six decimals of a voltage, six of an angle). It is a solution of the file's equations at 86
    # of the 89 buses: voltages to 1.6e-6 pu and angles to 0.002 degrees of pandapower's, and the
    # slack's power to 0.3 MW. At the three buses that hold a negative load behind a branch of one
    # bus (8581, 7526 and 2154, which are also the ends of the file's three phase shifters) the
    # stored angle is 24.5, 10.2 and 8.8 degrees from the solution of the network as ANDES reads it
    # (24.96, 10.41 and 8.93 from the one with the shifts) and the power left over at their
    # neighbours is up to 3,000 MW, so their angles are left out of the check (the voltages there
    # agree to 1.4e-6 pu). The cause was not found.
    "pegase89": StoredBasis(
        origin=(
            "the voltages and angles of RTE's snapshot that the PEGASE 89-bus data was made from, "
            "as this file carries them to six decimals; a solution of the file's equations "
            "except at the three buses 8581, 7526 and 2154, where the stored angle is 8.8 to 24.5 "
            "degrees from it (cause not found), so the angles of those three are left out"
        ),
        voltage=1e-5,
        angle=0.01,
        slack_p=0.5,
        omitted=("8581", "7526", "2154"),
    ),
    # PowerWorld's solution of the original ACTIV_SG_2000 case, as case_ACTIVSg2000.m carries it
    # (to nine decimals of a voltage and six of an angle). It is a solution of the file's equations
    # (no bus is left more than 0.06 MW unaccounted for) with 153 of its 392 generator buses at a
    # reactive limit (to 0.001 MVAr), which is not the set TENSA's enforcement ends with. A power
    # flow at the defaults differs from it by up to 0.0352 pu (bus 4195) and 0.639 degrees (bus
    # 3137), and the slack's power by 16.15 MW; with the limits enforced by up to 0.0308 pu (bus
    # 1070) and 0.885 degrees (bus 2059), and 3.5 MW. The tolerances are those gaps rounded up, so
    # the check catches only a gross error, and the case's entry says so.
    "activsg2000": StoredBasis(
        origin=(
            "the final voltages and angles of PowerWorld Simulator's solution of the original "
            "ACTIVSg2000 case, which this file was created from; a state solved with 153 of the "
            "392 generator buses at a reactive limit, not the set a power flow of TENSA holds "
            "there, so it differs from a power flow without the limits by up to 0.035 pu and "
            "0.64 degrees"
        ),
        voltage=0.04,
        angle=0.7,
        slack_p=17.0,
    ),
}


# The same, for a state that was solved with the generators held to their reactive limits, which a
# power flow run with ``enforce_q_limits`` is compared with (TENSA's default does not enforce them).
STORED_BASES_ENFORCED: dict[str, StoredBasis] = {
    # With the limits enforced TENSA's power flow is 0.0308 pu, 0.885 degrees and 3.5 MW from
    # PowerWorld's state (it holds another set of generators at their limits), held to those
    # gaps rounded up.
    "activsg2000": StoredBasis(
        origin=(
            "the final voltages and angles of PowerWorld Simulator's solution of the original "
            "ACTIVSg2000 case, which this file was created from; a state solved with 153 of the "
            "392 generator buses at a reactive limit, where a power flow of TENSA with the "
            "limits enforced ends with another set, so it differs from it by up to 0.031 pu "
            "and 0.89 degrees"
        ),
        voltage=0.035,
        angle=1.0,
        slack_p=4.0,
    ),
    # With the limits enforced, TENSA lands on PowerWorld's state to 1.4e-5 pu and 0.0009 degrees;
    # the slack's power is 384.399 MW against the 384.37 the file stores, 0.029 MW.
    "activsg200": StoredBasis(
        origin=(
            "the final voltages and angles of PowerWorld Simulator's solution of the original "
            "ACTIV_SG_200 case, which this file was created from; a state solved with the "
            "generators held to their reactive limits, which is how the power flow compared "
            "with it is run"
        ),
        voltage=1e-4,
        angle=0.005,
        slack_p=0.05,
    ),
}


def _stored_checks(
    state: dict[str, Any],
    file_name: str,
    basis: StoredBasis = RAW_BASIS,
    enforce_q_limits: bool = False,
) -> list[dict[str, Any]]:
    """The ``stored-solution`` checks of a reference file that a case file's state gives.

    With ``enforce_q_limits`` they are checks of a power flow run with the reactive limits
    enforced (the check says so in ``pflow``), written under a ``generated_by`` of their own.
    """
    why = (
        f"the solved state stored in {file_name} ({basis.origin}; TENSA did not compute it); "
        "written by scripts/crosscheck_pf.py stored"
    )
    common: dict[str, Any] = {"kind": "stored-solution", "reference": why, "generated_by": STORED_BY}
    suffix = ""
    if enforce_q_limits:
        suffix = ", reactive limits enforced"
        common["reference"] += LIMITS_FLAG + "; the power flow compared with it is run with the reactive limits enforced"
        common["generated_by"] += LIMITS_FLAG
        common["pflow"] = {"enforce_q_limits": True}
    left_out = set(basis.omitted)
    checks = [
        {
            "name": "Bus voltage magnitudes against the solution stored in the case file" + suffix,
            "quantity": "pf.bus_voltage_pu",
            "expected": {k: round(v, 9) for k, v in state["bus_voltage"].items()},
            "tolerance": {"abs": basis.voltage},
            **common,
        },
        {
            "name": "Bus voltage angles against the solution stored in the case file" + suffix,
            "quantity": "pf.bus_angle_deg",
            "expected": {k: round(v, 7) for k, v in state["bus_angle"].items() if k not in left_out},
            "tolerance": {"abs": basis.angle},
            **common,
        },
    ]
    if basis.slack_p is not None:
        checks.append(
            {
                "name": "Slack active power against the solution stored in the case file" + suffix,
                "quantity": "pf.slack_p_mw",
                "expected": round(state["slack_p_mw"], 6),
                "tolerance": {"abs": basis.slack_p},
                **common,
            }
        )
    return checks


def cmd_stored(args: argparse.Namespace) -> int:
    import andes

    path, example_id = _find_case(args.id)
    system = andes.load(str(path), setup=False, no_output=True, default_config=True)
    enforce = bool(getattr(args, "enforce_q_limits", False))
    if enforce:
        basis = STORED_BASES_ENFORCED.get(example_id or "")
        if basis is None:
            raise CrosscheckError(
                f"{args.id!r} has no stored state solved with the reactive limits enforced"
            )
    else:
        basis = STORED_BASES.get(example_id or "", RAW_BASIS)
    checks = _stored_checks(stored_solution(system), path.name, basis, enforce)
    if not args.write:
        print(json.dumps(checks, indent=1))
        return 0
    if example_id is None:
        raise CrosscheckError("--write needs an example id, not a file")
    target = Path(args.reference) if args.reference else REFERENCES / f"{example_id}.json"
    write_reference(
        example_id, checks, target, generated_by=STORED_BY + (LIMITS_FLAG if enforce else "")
    )
    print(f"wrote {len(checks)} checks to {target}")
    return 0


# ----------------------------------------------------------------------------------------
# report: a published PSS/E solution (needs neither ANDES nor pandapower)
# ----------------------------------------------------------------------------------------

# How close a power flow has to be to what a PSS/E report prints. The report gives a voltage to
# four decimals (a rounding of 5e-5 pu) and an angle to two (0.005 degrees), and the slack's
# power to 0.1 MW. The report was solved with the generators held to their reactive limits (the
# ones at a limit are marked in it). A power flow of TENSA that holds them differs from it by
# 5.8e-5 pu and 0.0053 degrees on the RTS-GMLC case, which is the rounding, so those are held to
# 1e-4 pu and 0.01 degrees. One that does not (TENSA's default) differs by 1.0e-4 pu and 0.0054
# degrees, since twenty-two generators are 0.5 MVAr or less past a limit, and is held to twice
# the first and four times the rounding of the second.
REPORT_VOLTAGE_TOLERANCE = 2e-4
REPORT_ANGLE_TOLERANCE = 0.02
REPORT_SLACK_TOLERANCE = 0.1
REPORT_VOLTAGE_TOLERANCE_ENFORCED = 1e-4
REPORT_ANGLE_TOLERANCE_ENFORCED = 0.01

_REPORT_BUS = re.compile(r"^\s*BUS\s+(\d+)\s.*?\s%\s*([0-9.]+)PU\s+(-?[0-9.]+)")
_REPORT_GENERATION = re.compile(r"^\s*FROM GENERATION\s+(-?[0-9.]+)")


def parse_psse_report(text: str) -> tuple[dict[int, tuple[float, float]], dict[int, float]]:
    """The bus voltages and angles, and the generation of each bus, of a PSS/E load flow report.

    A bus block starts with ``BUS <number> <name> <kV> CKT ... % <voltage>PU <angle>``; a bus
    that has generation has a line ``FROM GENERATION <MW> <MVAr>`` under it. The first gives
    ``{bus: (voltage in pu, angle in degrees)}`` and the second ``{bus: MW}``.
    """
    state: dict[int, tuple[float, float]] = {}
    generation: dict[int, float] = {}
    current: int | None = None
    for line in text.splitlines():
        header = _REPORT_BUS.match(line)
        if header:
            current = int(header.group(1))
            state[current] = (float(header.group(2)), float(header.group(3)))
            continue
        found = _REPORT_GENERATION.match(line)
        if found and current is not None:
            generation[current] = float(found.group(1))
    if not state:
        raise CrosscheckError("the report holds no bus block (BUS <number> ... PU <angle>)")
    return state, generation


def _branch_key(row: list[float]) -> tuple[float, ...]:
    """A branch as a tuple that two listings of it share. A branch with no tap and no shift is
    the same whichever end is called its from end, so its ends go in order."""
    ends = (row[0], row[1])
    if row[8] in (0.0, 1.0) and row[9] == 0.0:
        ends = tuple(sorted(ends))  # type: ignore[assignment]
    return (*ends, *(round(v, 9) for v in row[2:11]))


def network_differences(a: dict[str, Any], b: dict[str, Any]) -> list[str]:
    """What differs between two RAW files that a power flow notices, as sentences (none: the
    same network and dispatch).

    Not compared: the voltage and angle a bus is stored at, the settings of a generator that is
    out of service, the order the branches are listed in and the end a branch with no tap is
    listed from.
    """
    problems: list[str] = []
    if float(a["baseMVA"]) != float(b["baseMVA"]):
        problems.append(f"the system base differs: {a['baseMVA']} and {b['baseMVA']} MVA")
    buses_a = {int(r[0]): r for r in a["bus"]}
    buses_b = {int(r[0]): r for r in b["bus"]}
    if buses_a.keys() != buses_b.keys():
        problems.append("the two files do not hold the same buses")
    for number in sorted(buses_a.keys() & buses_b.keys()):
        ra, rb = buses_a[number], buses_b[number]
        # Type, active and reactive load, shunt conductance and susceptance, base voltage.
        if any(abs(ra[i] - rb[i]) > 1e-9 for i in (1, 2, 3, 4, 5, 9)):
            problems.append(f"bus {number} differs in its type, load, shunt or base voltage")
    in_service = [sorted(tuple(g[:7]) for g in net["gen"] if g[7] > 0) for net in (a, b)]
    if in_service[0] != in_service[1]:
        problems.append("the generators in service differ")
    keys = [sorted(_branch_key(r) for r in net["branch"]) for net in (a, b)]
    if keys[0] != keys[1]:
        problems.append("the branches and transformers differ")
    return problems


def cmd_report(args: argparse.Namespace) -> int:
    raw_path, solved_path, report_path = Path(args.raw), Path(args.solved_raw), Path(args.report)
    mine, solved = _ppc_from_raw_file(raw_path), _ppc_from_raw_file(solved_path)
    problems = network_differences(mine, solved)
    if problems:
        raise CrosscheckError(
            f"{solved_path.name} is not the network of {raw_path.name}: " + "; ".join(problems)
        )
    state, generation = parse_psse_report(report_path.read_text(encoding="utf-8", errors="replace"))
    numbers = [int(row[0]) for row in mine["bus"]]
    missing = [n for n in numbers if n not in state]
    if missing:
        raise CrosscheckError(f"the report has no block for bus {missing[0]} of {raw_path.name}")
    slack = next((int(r[0]) for r in mine["bus"] if int(r[1]) == 3), None)
    if slack is None or slack not in generation:
        raise CrosscheckError("the report gives no generation for the slack bus of the case")
    enforce = bool(getattr(args, "enforce_q_limits", False))
    why = (
        f"{args.origin}. PSS/E printed it after solving {solved_path.name}, which holds the same "
        f"network and dispatch as {raw_path.name} (compared by scripts/crosscheck_pf.py report: "
        "every bus, every generator in service, every branch and transformer, apart from what a "
        "power flow does not use: the stored state, the settings of generators out of service and "
        "the end a branch with no tap is listed from); TENSA did not compute it. It prints a "
        "voltage to four decimals, an angle to two and the power of a generator to 0.1 MW"
    )
    common: dict[str, Any] = {"kind": "published", "reference": why, "generated_by": REPORT_BY}
    suffix = ""
    voltage, angle = REPORT_VOLTAGE_TOLERANCE, REPORT_ANGLE_TOLERANCE
    if enforce:
        suffix = ", reactive limits enforced"
        voltage, angle = REPORT_VOLTAGE_TOLERANCE_ENFORCED, REPORT_ANGLE_TOLERANCE_ENFORCED
        common["reference"] += (
            "; the report was solved with the generators held to their reactive limits, and the "
            "power flow compared with it is run that way"
        )
        common["generated_by"] += LIMITS_FLAG
        common["pflow"] = {"enforce_q_limits": True}
    checks = [
        {
            "name": "Bus voltage magnitudes against the PSS/E solution" + suffix,
            "quantity": "pf.bus_voltage_pu",
            "expected": {str(n): state[n][0] for n in numbers},
            "tolerance": {"abs": voltage},
            **common,
        },
        {
            "name": "Bus voltage angles against the PSS/E solution" + suffix,
            "quantity": "pf.bus_angle_deg",
            "expected": {str(n): state[n][1] for n in numbers},
            "tolerance": {"abs": angle},
            **common,
        },
        {
            "name": "Slack active power against the PSS/E solution" + suffix,
            "quantity": "pf.slack_p_mw",
            "expected": generation[slack],
            "tolerance": {"abs": REPORT_SLACK_TOLERANCE},
            **common,
        },
    ]
    if not args.write:
        print(json.dumps(checks, indent=1))
        return 0
    target = Path(args.reference) if args.reference else REFERENCES / f"{args.example}.json"
    write_reference(
        args.example, checks, target, generated_by=REPORT_BY + (LIMITS_FLAG if enforce else "")
    )
    print(f"wrote {len(checks)} checks to {target}")
    return 0


# ----------------------------------------------------------------------------------------
# solve: MATPOWER case -> pandapower (needs pandapower)
# ----------------------------------------------------------------------------------------


def _ppc_from_network(network: dict[str, Any]) -> dict[str, Any]:
    import numpy as np

    return {
        "baseMVA": network["baseMVA"],
        "bus": np.array(network["bus"], dtype=float),
        "gen": np.array(network["gen"], dtype=float),
        "branch": np.array(network["branch"], dtype=float),
    }


def _ppc_from_matpower_file(path: Path) -> dict[str, Any]:
    """A MATPOWER ``.m`` file as the same arrays, read by matpowercaseframes (no ANDES)."""
    from matpowercaseframes import CaseFrames

    frames = CaseFrames(str(path))
    return {
        "baseMVA": float(frames.baseMVA),
        "bus": frames.bus.to_numpy(dtype=float),
        "gen": frames.gen.to_numpy(dtype=float),
        "branch": frames.branch.to_numpy(dtype=float),
    }


def andes_reads(ppc: dict[str, Any]) -> dict[str, Any]:
    """The case as ANDES's MATPOWER reader holds it (see ``MODELLING``): the phase shift of a
    branch whose ratio is 0 is dropped, and ``dropped_shifts`` lists ``[from, to, degrees]``
    of each one.

    A branch with a ratio of 0 is the plain line of the format (MATPOWER reads the ratio as 1),
    and a phase shifter that does not say its ratio is how RTE's PEGASE data gives one.
    """
    import numpy as np

    branch = np.array(ppc["branch"], dtype=float)
    dropping = (branch[:, 8] == 0.0) & (branch[:, 9] != 0.0)
    dropped = [[int(r[0]), int(r[1]), float(r[9])] for r in branch[dropping]]
    branch[dropping, 9] = 0.0
    return {**ppc, "branch": branch, "dropped_shifts": dropped}


def _raw_fields(line: str) -> list[str]:
    """The comma-separated fields of one line of a PSS/E RAW file.

    A field in single quotes keeps its commas, a ``/`` outside quotes starts a comment, and
    every field is stripped (a quoted ID such as ``'1 '`` is ``1``).
    """
    fields: list[str] = []
    current: list[str] = []
    quoted = False
    for char in line:
        if quoted:
            if char == "'":
                quoted = False
            else:
                current.append(char)
        elif char == "'":
            quoted = True
        elif char == "/":
            break
        elif char == ",":
            fields.append("".join(current).strip())
            current = []
        else:
            current.append(char)
    fields.append("".join(current).strip())
    return fields


def _raw_number(fields: list[str], i: int, default: float = 0.0) -> float:
    """Field ``i`` of a RAW record as a number; a field the record leaves out is ``default``."""
    if i >= len(fields) or not fields[i]:
        return default
    return float(fields[i])


# The sections of a version 33 RAW file in the order the file gives them, and what this reader
# does with a record of each: ``read`` (it is part of the network), ``skip`` (it changes no power
# flow) or ``refuse`` (a power flow of the file needs a model that this reader does not have, so
# a file that holds one is not given a reference for a different network).
_RAW_SECTIONS: tuple[tuple[str, str], ...] = (
    ("bus", "read"),
    ("load", "read"),
    ("fixed shunt", "read"),
    ("generator", "read"),
    ("branch", "read"),
    ("transformer", "read"),
    ("area", "skip"),
    ("two-terminal dc", "refuse"),
    ("voltage source converter", "refuse"),
    ("impedance correction", "refuse"),
    ("multi-terminal dc", "refuse"),
    ("multi-section line", "refuse"),
    ("zone", "skip"),
    ("inter-area transfer", "skip"),
    ("owner", "skip"),
    ("facts control device", "refuse"),
    ("switched shunt", "read"),
    ("gne device", "refuse"),
    # PSS/E writes this one; PowerWorld's files end after the GNE devices.
    ("induction machine", "refuse"),
)


def _raw_sections(text: str) -> tuple[list[str], dict[str, list[list[str]]]]:
    """The header fields of a RAW file and the records of each section, one list of fields per
    line (``_ppc_from_raw_file`` joins the lines of a transformer's record)."""
    lines = text.splitlines()
    if len(lines) < 3:
        raise CrosscheckError("the RAW file is too short to have a header")
    header = _raw_fields(lines[0])
    revision = int(_raw_number(header, 2))
    if revision != 33:
        raise CrosscheckError(f"the RAW file is revision {revision}; this reader is written for 33")
    sections: dict[str, list[list[str]]] = {}
    names = iter(_RAW_SECTIONS)
    current: list[list[str]] = []
    for line in lines[3:]:
        stripped = line.strip()
        if stripped.upper() == "Q":
            break
        if re.fullmatch(r"0\s*(/.*)?", stripped):
            name = next(names, None)
            if name is None:
                raise CrosscheckError("the RAW file has more sections than version 33 defines")
            sections[name[0]] = current
            current = []
        elif stripped:
            current.append(_raw_fields(stripped))
    if len(sections) < len(_RAW_SECTIONS) - 1:
        raise CrosscheckError(
            f"the RAW file has {len(sections)} sections where version 33 has {len(_RAW_SECTIONS)}"
        )
    for name, action in _RAW_SECTIONS:
        if action == "refuse" and sections.get(name):
            raise CrosscheckError(
                f"the RAW file has {name} data, which this reader does not model, so a power "
                "flow of it would be a power flow of another network"
            )
    return header, sections


def _ppc_from_raw_file(path: Path) -> dict[str, Any]:
    """A PSS/E RAW file (revision 33) as the same arrays, read here with no ANDES.

    This is a reader of its own, written from the PSS/E data format and not from ANDES's reader,
    so a power flow of the result checks ANDES's reading of the file as well as its solution. It
    reads what a power flow of a file like the RTS-GMLC one needs: buses, constant-power loads,
    fixed shunts, generators, branches, two-winding transformers and fixed switched shunts. What
    would change the network and is not modelled here (a DC line, a three-winding transformer, a
    load with a constant-current or constant-admittance part, a generator that regulates another
    bus, a phase shifter, a magnetising admittance given as losses) stops it with an error.

    The rules of PSS/E that matter: a bus of type 2 with no generator in service is a load bus, a
    generator on a type 3 bus is the swing, a transformer's tap ratio is ``WINDV1 / WINDV2`` when
    the windings are given in per unit of the bus voltage (``CW`` 1), and its impedance is in per
    unit of the system base (``CZ`` 1) or of the winding base (``CZ`` 2).
    """
    header, sections = _raw_sections(path.read_text(encoding="ascii", errors="replace"))
    base = _raw_number(header, 1)
    if base <= 0:
        raise CrosscheckError("the RAW file has no system base")

    buses: dict[int, list[float]] = {}
    for f in sections["bus"]:
        number = int(_raw_number(f, 0))
        if number in buses:
            raise CrosscheckError(f"bus {number} is listed twice")
        # BUS_I, TYPE, PD, QD, GS, BS, AREA, VM, VA, BASE_KV, ZONE, VMAX, VMIN
        buses[number] = [
            float(number),
            _raw_number(f, 3, 1.0),
            0.0,
            0.0,
            0.0,
            0.0,
            _raw_number(f, 4, 1.0),
            _raw_number(f, 7, 1.0),
            _raw_number(f, 8),
            _raw_number(f, 2),
            _raw_number(f, 5, 1.0),
            _raw_number(f, 9, 1.1),
            _raw_number(f, 10, 0.9),
        ]

    def bus(number: float, what: str) -> list[float]:
        try:
            return buses[abs(int(number))]
        except KeyError:
            raise CrosscheckError(f"{what} is on bus {int(number)}, which the file lacks") from None

    for f in sections["load"]:
        if any(_raw_number(f, i) for i in (7, 8, 9, 10)):
            raise CrosscheckError(
                f"the load on bus {f[0]} has a constant-current or constant-admittance part"
            )
        if _raw_number(f, 2, 1.0) > 0:
            row = bus(_raw_number(f, 0), f"a load ({f[1]})")
            row[2] += _raw_number(f, 5)
            row[3] += _raw_number(f, 6)
    for f in sections["fixed shunt"]:
        if _raw_number(f, 2, 1.0) > 0:
            row = bus(_raw_number(f, 0), f"a fixed shunt ({f[1]})")
            row[4] += _raw_number(f, 3)
            row[5] += _raw_number(f, 4)
    for f in sections["switched shunt"]:
        # MODSW 0 is a shunt that stays at BINIT, the only kind this reader models.
        if int(_raw_number(f, 1)) != 0:
            raise CrosscheckError(f"the switched shunt on bus {f[0]} is adjustable")
        if _raw_number(f, 3, 1.0) > 0:
            bus(_raw_number(f, 0), "a switched shunt")[5] += _raw_number(f, 9)

    gens: list[list[float]] = []
    for f in sections["generator"]:
        number = int(_raw_number(f, 0))
        bus(number, f"a generator ({f[1]})")
        regulated = int(_raw_number(f, 7))
        if regulated not in (0, number):
            raise CrosscheckError(f"the generator {f[1]} on bus {number} regulates bus {regulated}")
        # GEN_BUS, PG, QG, QMAX, QMIN, VG, MBASE, GEN_STATUS, PMAX, PMIN
        gens.append(
            [
                float(number),
                _raw_number(f, 2),
                _raw_number(f, 3),
                _raw_number(f, 4),
                _raw_number(f, 5),
                _raw_number(f, 6, 1.0),
                _raw_number(f, 8, base),
                1.0 if _raw_number(f, 14, 1.0) > 0 else 0.0,
                _raw_number(f, 16),
                _raw_number(f, 17),
            ]
        )
    # A PV bus whose generators are all out of service is a load bus.
    online = {int(g[0]) for g in gens if g[7] > 0}
    for number, row in buses.items():
        if row[1] == 2 and number not in online:
            row[1] = 1.0

    branches: list[list[float]] = []
    for f in sections["branch"]:
        i, j = int(abs(_raw_number(f, 0))), int(abs(_raw_number(f, 1)))
        in_service = _raw_number(f, 13, 1.0) > 0
        # The conductance and susceptance a line has at each end, in per unit of the system base;
        # they go with the line, so a line that is out of service has none.
        for end, g, b in ((i, 9, 10), (j, 11, 12)):
            row = bus(end, "a branch")
            if in_service:
                row[4] += _raw_number(f, g) * base
                row[5] += _raw_number(f, b) * base
        # F_BUS, T_BUS, BR_R, BR_X, BR_B, RATE_A, RATE_B, RATE_C, TAP, SHIFT, BR_STATUS, ANGMIN, ANGMAX
        branches.append(
            [
                float(i),
                float(j),
                _raw_number(f, 3),
                _raw_number(f, 4),
                _raw_number(f, 5),
                _raw_number(f, 6),
                _raw_number(f, 7),
                _raw_number(f, 8),
                0.0,
                0.0,
                1.0 if in_service else 0.0,
                -360.0,
                360.0,
            ]
        )

    records = sections["transformer"]
    k = 0
    while k < len(records):
        first = records[k]
        if int(_raw_number(first, 2)) != 0:
            raise CrosscheckError(
                f"the transformer {first[0]}-{first[1]}-{first[2]} has three windings"
            )
        if k + 4 > len(records):
            raise CrosscheckError("the transformer data ends in the middle of a record")
        impedance, winding1, winding2 = records[k + 1], records[k + 2], records[k + 3]
        k += 4
        i, j = int(_raw_number(first, 0)), int(_raw_number(first, 1))
        cw, cz, cm = (int(_raw_number(first, n)) for n in (4, 5, 6))
        if cm != 1 and (_raw_number(first, 7) or _raw_number(first, 8)):
            raise CrosscheckError(f"the transformer {i}-{j} gives its magnetising branch as losses")
        if cz not in (1, 2) or cw not in (1, 2, 3):
            raise CrosscheckError(f"the transformer {i}-{j} has the codes CW {cw} and CZ {cz}")
        if _raw_number(winding1, 2):
            raise CrosscheckError(f"the transformer {i}-{j} is a phase shifter")
        row_i, kv_j = bus(i, "a transformer"), bus(j, "a transformer")[9]
        kv_i = row_i[9]
        tap1, tap2 = _raw_number(winding1, 0, 1.0), _raw_number(winding2, 0, 1.0)
        if cw == 1:
            ratio = tap1 / tap2
        elif cw == 2:
            ratio = (tap1 / kv_i) / (tap2 / kv_j)
        else:
            ratio = (tap1 * _raw_number(winding1, 1, kv_i) / kv_i) / (
                tap2 * _raw_number(winding2, 1, kv_j) / kv_j
            )
        scale = base / _raw_number(impedance, 2, base) if cz == 2 else 1.0
        status = int(_raw_number(first, 11, 1.0))
        if status > 0:
            # The magnetising admittance (per unit of the system base) is at the winding 1 bus.
            row_i[4] += _raw_number(first, 7) * base
            row_i[5] += _raw_number(first, 8) * base
        branches.append(
            [
                float(i),
                float(j),
                _raw_number(impedance, 0) * scale,
                _raw_number(impedance, 1) * scale,
                0.0,
                _raw_number(winding1, 3),
                _raw_number(winding1, 4),
                _raw_number(winding1, 5),
                ratio,
                0.0,
                1.0 if status > 0 else 0.0,
                -360.0,
                360.0,
            ]
        )

    return {
        "baseMVA": base,
        "f_hz": _raw_number(header, 5, 60.0),
        "bus": list(buses.values()),
        "gen": gens,
        "branch": branches,
    }


def build_network(ppc: dict[str, Any], f_hz: float = 60.0) -> Any:
    """A pandapower network that holds exactly the MATPOWER case ``ppc`` (see ``MODELLING``).

    pandapower's own ``from_ppc`` is not used. On IEEE 14 as ANDES has it (four transformers
    between 69 and 138 kV, with the tap on the lower-voltage from side) it builds a network
    whose admittance matrix differs from MATPOWER's at the ends of those transformers, and
    solves a power flow 5.6e-3 pu off the case's own equations; the cause was not looked into.
    Here every branch is a transformer whose from side is its high-voltage side, with the tap
    as the ratio of its rated voltages and its impedance on the to side, which is what a
    MATPOWER branch is. ``check_network`` compares the admittance matrix of the result with
    the case's, so a difference cannot go unnoticed.
    """
    import numpy as np
    import pandapower as pp

    bus = np.asarray(ppc["bus"], dtype=float)
    gen = np.asarray(ppc["gen"], dtype=float)
    branch = np.asarray(ppc["branch"], dtype=float)
    base = float(ppc["baseMVA"])
    net = pp.create_empty_network(sn_mva=base, f_hz=f_hz)
    kv: dict[int, float] = {}
    for row in bus:
        number = int(row[0])
        kv[number] = float(row[9]) if row[9] > 0 else 1.0
        pp.create_bus(net, vn_kv=kv[number], index=number, in_service=int(row[1]) != 4)
    shunts: dict[int, list[float]] = {int(row[0]): [row[4], -row[5]] for row in bus}
    for row in bus:
        if row[2] or row[3]:
            pp.create_load(net, int(row[0]), p_mw=row[2], q_mvar=row[3])

    # Generators: one per bus, with the active power of every generator in service there.
    types = {int(row[0]): int(row[1]) for row in bus}
    angle = {int(row[0]): float(row[8]) for row in bus}
    by_bus: dict[int, list[Any]] = {}
    for row in gen:
        if row[7] > 0:
            by_bus.setdefault(int(row[0]), []).append(row)
    for number, rows in by_bus.items():
        p_mw = float(sum(r[1] for r in rows))
        q_mvar = float(sum(r[2] for r in rows))
        vm = float(rows[0][5])
        if types[number] == 3:
            pp.create_ext_grid(net, number, vm_pu=vm, va_degree=angle[number])
        elif types[number] == 2:
            pp.create_gen(net, number, p_mw=p_mw, vm_pu=vm)
        else:
            pp.create_sgen(net, number, p_mw=p_mw, q_mvar=q_mvar)

    for row in branch:
        if row[10] <= 0:
            continue
        f, t = int(row[0]), int(row[1])
        tap = float(row[8]) or 1.0
        r_pu, x_pu, b_pu = float(row[2]), float(row[3]), float(row[4])
        z = (r_pu**2 + x_pu**2) ** 0.5
        pp.create_transformer_from_parameters(
            net,
            hv_bus=f,
            lv_bus=t,
            sn_mva=base,
            vn_hv_kv=kv[f] * tap,
            vn_lv_kv=kv[t],
            vk_percent=float(np.sign(x_pu)) * z * 100.0,
            vkr_percent=r_pu * 100.0,
            pfe_kw=0.0,
            i0_percent=0.0,
            shift_degree=float(row[9]),
        )
        # The charging susceptance is half at each end, the from end behind the tap.
        shunts[f][1] -= 0.5 * b_pu * base / tap**2
        shunts[t][1] -= 0.5 * b_pu * base
    for number, (p_mw, q_mvar) in shunts.items():
        if p_mw or q_mvar:
            pp.create_shunt(net, number, q_mvar=q_mvar, p_mw=p_mw, vn_kv=kv[number])
    return net


def check_network(net: Any, ppc: dict[str, Any], tolerance: float = 1e-9) -> float:
    """The largest difference between pandapower's bus admittance matrix and the case's, in pu.

    The matrix is MATPOWER's own definition (``makeYbus``) built here from ``ppc``; pandapower's
    is the one its power flow just used. Raises ``CrosscheckError`` above ``tolerance``.
    """
    import numpy as np

    bus = np.asarray(ppc["bus"], dtype=float)
    branch = np.asarray(ppc["branch"], dtype=float)
    base = float(ppc["baseMVA"])
    position = {int(row[0]): i for i, row in enumerate(bus)}
    n = len(bus)
    y = np.zeros((n, n), dtype=complex)
    for row in branch:
        if row[10] <= 0:
            continue
        f, t = position[int(row[0])], position[int(row[1])]
        tap = (float(row[8]) or 1.0) * np.exp(1j * np.deg2rad(float(row[9])))
        ys = 1.0 / complex(row[2], row[3])
        half_b = 0.5j * row[4]
        y[f, f] += (ys + half_b) / (tap * np.conj(tap))
        y[t, t] += ys + half_b
        y[f, t] -= ys / np.conj(tap)
        y[t, f] -= ys / tap
    y += np.diag((bus[:, 4] + 1j * bus[:, 5]) / base)
    ours = net._ppc["internal"]["Ybus"].toarray()  # noqa: SLF001
    lookup = net._pd2ppc_lookups["bus"]  # noqa: SLF001
    order = [int(lookup[int(row[0])]) for row in bus]
    theirs = ours[np.ix_(order, order)]
    worst = float(np.abs(theirs - y).max())
    if worst > tolerance:
        raise CrosscheckError(
            f"the pandapower network differs from the case: its admittance matrix is off by "
            f"{worst:.3g} pu"
        )
    return worst


def solve_ppc(
    ppc: dict[str, Any], f_hz: float = 60.0, bus_idx: list[Any] | None = None
) -> dict[str, Any]:
    """Solve a MATPOWER case with pandapower.

    ``bus_voltage`` and ``bus_angle`` are keyed by the bus's ANDES idx: ``bus_idx[i]`` for the
    ``i``-th bus of the case, or the bus number itself for a case read from a ``.m`` file.
    """
    import numpy as np
    import pandapower as pp

    net = build_network(ppc, f_hz)
    try:
        pp.runpp(
            net,
            algorithm="nr",
            init="flat",
            calculate_voltage_angles=True,
            tolerance_mva=1e-8,
            max_iteration=100,
            enforce_q_lims=False,
            trafo_model="pi",
            numba=False,
        )
    except Exception as exc:  # pandapower raises its own LoadflowNotConverged
        raise CrosscheckError(f"pandapower did not solve the power flow: {exc}") from exc
    admittance_gap = check_network(net, ppc)
    numbers = [int(n) for n in np.asarray(ppc["bus"])[:, 0]]
    names = [str(i) for i in bus_idx] if bus_idx is not None else [str(n) for n in numbers]
    vm: dict[str, float] = {}
    va: dict[str, float] = {}
    for number, name in zip(numbers, names, strict=True):
        vm[name] = round(float(net.res_bus.at[number, "vm_pu"]), 9)
        va[name] = round(float(net.res_bus.at[number, "va_degree"]), 7)
    return {
        "bus_voltage": vm,
        "bus_angle": va,
        "loss_mw": round(float(net.res_trafo.pl_mw.sum()), 6),
        "slack_p_mw": round(float(net.res_ext_grid.p_mw.sum()), 6),
        "pandapower": pp.__version__,
        "admittance_gap_pu": admittance_gap,
    }


def _reference_checks(result: dict[str, Any], source: str) -> list[dict[str, Any]]:
    """The checks of a reference file that a pandapower solution gives."""
    held = ""
    if result.get("dropped_shifts"):
        effect = result["shift_effect"]
        held = (
            f", with the phase shift of {len(result['dropped_shifts'])} branches that have a "
            "ratio of 0 left out, as ANDES's MATPOWER reader holds them (MATPOWER applies "
            f"them, and the solution with them differs from this one by at most "
            f"{effect['bus_voltage_pu']:.2g} pu in a bus voltage and "
            f"{effect['bus_angle_deg']:.2g} degrees in a bus angle)"
        )
    why = (
        f"pandapower {result['pandapower']}, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive "
        f"limits not enforced) on {source}{held}; written by scripts/crosscheck_pf.py"
    )
    common = {
        "kind": "independent-solver",
        "reference": why,
        "generated_by": GENERATED_BY,
    }
    return [
        {
            "name": "Bus voltage magnitudes against pandapower",
            "quantity": "pf.bus_voltage_pu",
            "expected": result["bus_voltage"],
            "tolerance": {"abs": 1e-4},
            **common,
        },
        {
            "name": "Bus voltage angles against pandapower",
            "quantity": "pf.bus_angle_deg",
            "expected": result["bus_angle"],
            "tolerance": {"abs": 0.01},
            **common,
        },
        {
            "name": "Network losses against pandapower",
            "quantity": "pf.loss_mw",
            "expected": result["loss_mw"],
            "tolerance": {"abs": 0.01, "rel": 1e-3},
            **common,
        },
        {
            "name": "Slack active power against pandapower",
            "quantity": "pf.slack_p_mw",
            "expected": result["slack_p_mw"],
            "tolerance": {"abs": 0.01, "rel": 1e-3},
            **common,
        },
    ]


def write_reference(
    example_id: str,
    checks: list[dict[str, Any]],
    path: Path,
    generated_by: str = GENERATED_BY,
) -> None:
    """Put ``checks`` in the reference file, replacing the ones ``generated_by`` wrote before."""
    if path.exists():
        document = json.loads(path.read_text(encoding="utf-8"))
        if document.get("id") != example_id:
            raise CrosscheckError(f"{path.name} is the reference of {document.get('id')!r}")
    else:
        document = {"version": 1, "id": example_id, "checks": []}
    kept = [c for c in document.get("checks", []) if c.get("generated_by") != generated_by]
    document["checks"] = [*checks, *kept]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(format_json(document) + "\n", encoding="utf-8")


def format_json(value: Any, indent: int = 0) -> str:
    """JSON with two-space indentation; a flat map or a list of plain values goes on one line.

    A map of numbers (the buses' values) may be 400 characters long on its line, a flat map of
    other values 100.
    """
    pad = "  " * (indent + 1)
    end = "  " * indent
    if isinstance(value, dict):
        if not value:
            return "{}"
        if not any(isinstance(v, dict | list) for v in value.values()):
            body = ", ".join(f"{json.dumps(k)}: {json.dumps(v)}" for k, v in value.items())
            numbers = all(
                isinstance(v, int | float) and not isinstance(v, bool) for v in value.values()
            )
            if len(body) < (400 if numbers else 100):
                return "{" + body + "}"
        items = [f"{pad}{json.dumps(k)}: {format_json(v, indent + 1)}" for k, v in value.items()]
        return "{\n" + ",\n".join(items) + "\n" + end + "}"
    if isinstance(value, list):
        if not value:
            return "[]"
        if all(not isinstance(v, dict | list) for v in value):
            return json.dumps(value)
        items = [f"{pad}{format_json(v, indent + 1)}" for v in value]
        return "[\n" + ",\n".join(items) + "\n" + end + "]"
    return json.dumps(value)


def _shift_effect(held: dict[str, Any], kept: dict[str, Any]) -> dict[str, Any]:
    """How far the solution with the phase shifts kept is from the one without them: the
    largest difference of a bus voltage (pu) and of a bus angle (degrees), and the bus of each."""
    volts = {b: abs(held["bus_voltage"][b] - v) for b, v in kept["bus_voltage"].items()}
    angles = {b: abs(held["bus_angle"][b] - a) for b, a in kept["bus_angle"].items()}
    v_bus = max(volts, key=lambda b: volts[b])
    a_bus = max(angles, key=lambda b: angles[b])
    return {
        "bus_voltage_pu": round(volts[v_bus], 9),
        "bus_voltage_bus": v_bus,
        "bus_angle_deg": round(angles[a_bus], 7),
        "bus_angle_bus": a_bus,
    }


def cmd_solve(args: argparse.Namespace) -> int:
    source = Path(args.network)
    bus_idx = None
    suffix = source.suffix.lower()
    if suffix == ".m":
        file_ppc = _ppc_from_matpower_file(source)
        ppc = andes_reads(file_ppc)
        f_hz = 60.0
    elif suffix == ".raw":
        ppc = _ppc_from_raw_file(source)
        f_hz = float(ppc["f_hz"])
    else:
        network = json.loads(source.read_text(encoding="utf-8"))
        ppc = _ppc_from_network(network)
        f_hz = float(network.get("f_hz", 60.0))
        bus_idx = network["bus_idx"]
    result = solve_ppc(ppc, f_hz, bus_idx)
    if ppc.get("dropped_shifts"):
        result["dropped_shifts"] = ppc["dropped_shifts"]
        result["shift_effect"] = _shift_effect(result, solve_ppc(file_ppc, f_hz, bus_idx))
    if args.write:
        if not args.example:
            raise CrosscheckError("--write needs --example ID, the case the reference belongs to")
        if suffix == ".m":
            what = f"{source.name}, read by matpowercaseframes"
        elif suffix == ".raw":
            what = f"{source.name}, read by the PSS/E reader of scripts/crosscheck_pf.py"
        else:
            what = f"the network ANDES holds for {network['source']}"

        checks = _reference_checks(result, what)
        path = Path(args.reference) if args.reference else REFERENCES / f"{args.example}.json"
        write_reference(args.example, checks, path)
        print(f"wrote {len(checks)} checks to {path}")
    else:
        print(json.dumps(result, indent=1))
    return 0


# ----------------------------------------------------------------------------------------
# run: both steps, each in the interpreter that can
# ----------------------------------------------------------------------------------------


def _can_import(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def _python_for(option: str | None, env: str, module: str) -> str:
    if option:
        return option
    if _can_import(module):
        return sys.executable
    if os.environ.get(env):
        return os.environ[env]
    raise CrosscheckError(
        f"this Python has no {module}: pass the interpreter that has it, or set {env}"
    )


def cmd_run(args: argparse.Namespace) -> int:
    tensa_python = _python_for(args.tensa_python, "TENSA_PYTHON", "andes")
    verify_python = _python_for(args.verify_python, "TENSA_VERIFY_PYTHON", "pandapower")
    script = str(Path(__file__).resolve())
    with tempfile.TemporaryDirectory(prefix="tensa-crosscheck-") as tmp:
        network = str(Path(tmp) / "network.json")
        subprocess.run([tensa_python, script, "dump", args.id, "-o", network], check=True)
        command = [verify_python, script, "solve", network, "--example", args.id]
        if args.write:
            command.append("--write")
        if args.reference:
            command += ["--reference", args.reference]
        subprocess.run(command, check=True)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=__doc__.split("\n\n")[0] if __doc__ else None,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=MODELLING,
    )
    sub = parser.add_subparsers(dest="command", required=True)
    dump = sub.add_parser(
        "dump", help="write the network of a case as a MATPOWER case (needs ANDES)"
    )
    dump.add_argument("target", help="an example id, or a case file ANDES reads")
    dump.add_argument("-o", "--output", required=True, help="the network file to write")
    dump.set_defaults(func=cmd_dump)
    solve = sub.add_parser(
        "solve", help="solve a network file or a MATPOWER .m file (needs pandapower)"
    )
    solve.add_argument("network", help="a network file from `dump`, or a MATPOWER .m file")
    solve.add_argument("--example", help="the example id the reference belongs to")
    solve.add_argument("--write", action="store_true", help="write the reference file")
    solve.add_argument("--reference", help="the reference file to write (default: the case's own)")
    solve.set_defaults(func=cmd_solve)
    run = sub.add_parser(
        "run", help="dump in TENSA's environment and solve in the verification one"
    )
    run.add_argument("id", help="an example id")
    run.add_argument("--write", action="store_true", help="write the reference file")
    run.add_argument("--reference", help="the reference file to write (default: the case's own)")
    run.add_argument(
        "--tensa-python",
        help="a Python with ANDES (default: this one, or TENSA_PYTHON)",
    )
    run.add_argument(
        "--verify-python",
        help="a Python with pandapower (default: this one, or TENSA_VERIFY_PYTHON)",
    )
    run.set_defaults(func=cmd_run)
    stored = sub.add_parser(
        "stored", help="write the solved state a case file carries as a reference (needs ANDES)"
    )
    stored.add_argument("id", help="an example id")
    stored.add_argument("--write", action="store_true", help="write the reference file")
    stored.add_argument("--reference", help="the reference file to write (default: the case's own)")
    stored.add_argument(
        "--enforce-q-limits",
        action="store_true",
        help="checks of a power flow run with the reactive limits enforced, for a state solved so",
    )
    stored.set_defaults(func=cmd_stored)
    report = sub.add_parser(
        "report", help="write the solution a PSS/E report prints as a reference (a RAW case)"
    )
    report.add_argument("report", help="the PSS/E load flow report, as text")
    report.add_argument("--raw", required=True, help="the case's RAW file")
    report.add_argument(
        "--solved-raw", required=True, help="the RAW file PSS/E made the report from"
    )
    report.add_argument("--example", required=True, help="the example id the reference belongs to")
    report.add_argument(
        "--origin", required=True, help="where the report is from, named so it can be found"
    )
    report.add_argument("--write", action="store_true", help="write the reference file")
    report.add_argument("--reference", help="the reference file to write (default: the case's own)")
    report.add_argument(
        "--enforce-q-limits",
        action="store_true",
        help="checks of a power flow run with the reactive limits enforced, for a report solved so",
    )
    report.set_defaults(func=cmd_report)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except CrosscheckError as exc:
        print(f"crosscheck_pf: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    with contextlib.suppress(AttributeError):
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    sys.exit(main())
