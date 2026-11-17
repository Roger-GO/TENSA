#!/usr/bin/env python3
"""Solve an example case's power flow with pandapower, as an independent reference.

Usage:
    python scripts/crosscheck_pf.py dump  ID_OR_FILE -o NETWORK.json
    python scripts/crosscheck_pf.py solve NETWORK.json|CASE.m [--example ID] [--write]
    python scripts/crosscheck_pf.py run   ID [--write]

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
           that file, or straight from a MATPOWER ``.m`` file (read by matpowercaseframes,
           with no ANDES involved at all), solves it (Newton-Raphson, tolerance 1e-8 MVA,
           reactive limits not enforced, as TENSA's default), and prints the result, or with
           ``--write`` puts it into the reference file.
``run``    does both, each with the Python that has what it needs: the one running the script
           when that has it, otherwise ``--tensa-python`` or ``--verify-python`` (or the
           environment variables ``TENSA_PYTHON`` and ``TENSA_VERIFY_PYTHON``).

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
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
SERVER_SRC = REPO_ROOT / "server" / "src"
REFERENCES = SERVER_SRC / "tensa" / "examples" / "references"

# What marks a check as one this script wrote, so that running it again replaces that check
# and leaves the ones written by hand.
GENERATED_BY = "scripts/crosscheck_pf.py"

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


def _classical_machines(system: Any, pos: Any) -> dict[str, Any]:
    """The machines of the classical model (``GENCLS``) the case holds, per unit on the base.

    ``scripts/crosscheck_classical.py`` reads them. ANDES converts a machine's ``M``, ``D``,
    ``ra`` and ``xd1`` to the system base at ``setup()``, so the values are read as they are.
    ``other_models`` names every other device model of the case that is not part of the
    network (a round-rotor machine, an exciter, a governor), which the classical check cannot
    represent; ``events`` names the events of the file.
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
    why = (
        f"pandapower {result['pandapower']}, runpp (Newton-Raphson, tolerance 1e-8 MVA, reactive "
        f"limits not enforced) on {source}; written by scripts/crosscheck_pf.py"
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


def cmd_solve(args: argparse.Namespace) -> int:
    source = Path(args.network)
    bus_idx = None
    if source.suffix.lower() == ".m":
        ppc = _ppc_from_matpower_file(source)
        f_hz = 60.0
    else:
        network = json.loads(source.read_text(encoding="utf-8"))
        ppc = _ppc_from_network(network)
        f_hz = float(network.get("f_hz", 60.0))
        bus_idx = network["bus_idx"]
    result = solve_ppc(ppc, f_hz, bus_idx)
    if args.write:
        if not args.example:
            raise CrosscheckError("--write needs --example ID, the case the reference belongs to")
        what = (
            f"{source.name}, read by matpowercaseframes"
            if source.suffix.lower() == ".m"
            else f"the network ANDES holds for {network['source']}"
        )
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
