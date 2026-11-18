#!/usr/bin/env python3
"""Compute the dynamics of a classical-model example case independently of TENSA.

Usage:
    python scripts/crosscheck_classical.py solve NETWORK.json [--example ID] [--write]
    python scripts/crosscheck_classical.py run   ID [--write]

A case whose machines are all classical (``GENCLS``: a constant voltage behind the transient
reactance, constant mechanical power) and whose loads are constant impedances, which is how
ANDES simulates the load of such a case, is a small set of equations that textbooks solve by
hand: Kron-reduce the network onto the machines' internal nodes, and the swing equations are

    d(delta_i)/dt = omega_s (omega_i - 1)
    2 H_i d(omega_i)/dt = Pm_i - Pe_i - D_i (omega_i - 1),    Pe_i = Re(E_i conj(sum_j Y_ij E_j)).

This script solves them with nothing of TENSA or ANDES in it (numpy and scipy only, and the
power flow by pandapower through ``scripts/crosscheck_pf.py``), and writes what the
verification harness compares TENSA's runs with:

- the modes: the eigenvalues of the swing equations linearised at the operating point
  (``eig.mode_frequency_hz`` and ``eig.mode_damping_ratio`` checks), which TENSA's eigenvalue
  analysis must reproduce;
- the case's disturbance (the fault and the line trip of the reference's ``disturbance.specs``)
  integrated with scipy's DOP853 at 1e-11 relative tolerance, sampled where TENSA's run
  records (``tds.*`` checks): the largest and the final spread of the rotor angles, the lowest
  bus voltage and the lowest machine frequency.

It works in two steps that meet at a file, like ``crosscheck_pf.py``, because ANDES and
pandapower live in two environments (see its docstring): ``dump`` there writes the network and
the machines ANDES holds, and ``solve`` here reads them. ``run`` does both.

What the model leaves out, which ANDES leaves out too in these cases: saliency, saturation,
exciters, governors and every load model but constant impedance. A case that has a machine
or a controller of another kind is refused. The one exception is a ``TG2`` governor, and only
when ``--governors inert`` says it does nothing: ANDES 2.0.0's ``TG2`` holds its speed input at
zero while its dead band is not enabled (``TG2.config.deadband``, off by default, and TENSA
does not expose it), so the machine keeps the mechanical power it started with and the swing
equations above are what a run of the case solves. With the dead band on, the governor acts and
this model is no longer the case.

The disturbance is what the case's file holds (its line trips and faults, which the dump
carries as ``file_events``) together with the ``specs`` of the reference's disturbance, as a
run of the harness has both. A load is a constant impedance at the voltage of
the power flow solution, as ANDES's default configuration treats it in a time-domain run
(a bus voltage outside 0.8 to 1.2 pu turns it back into constant power there; no case of
this check has one).
"""

from __future__ import annotations

import argparse
import contextlib
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

SCRIPTS = Path(__file__).resolve().parent
REPO_ROOT = SCRIPTS.parent
REFERENCES = REPO_ROOT / "server" / "src" / "tensa" / "examples" / "references"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from crosscheck_pf import (  # noqa: E402
    CrosscheckError,
    _ppc_from_network,
    _python_for,
    solve_ppc,
    write_reference,
)

GENERATED_BY = "scripts/crosscheck_classical.py"

# The time step of a disturbance run when the reference gives none: ANDES's default.
DEFAULT_STEP = 1.0 / 30.0
# What ``--governors`` takes: a case with a TG2 governor is refused, or its governor is held to do
# nothing (see the module docstring for why that is what ANDES 2.0.0 runs).
GOVERNOR_CHOICES = ("refuse", "inert")
GOVERNOR_HELP = (
    "refuse (default): a case with a governor is not a classical case; inert: hold a TG2 "
    "governor at its initial output, which is what ANDES 2.0.0 runs with its dead band off"
)
# How far from a mode's frequency the window of its check reaches, at most, as a fraction.
WINDOW_FRACTION = 0.2


# ----------------------------------------------------------------------------------------
# The network and the machines
# ----------------------------------------------------------------------------------------


def _numpy() -> Any:
    import numpy as np

    return np


class ClassicalModel:
    """A network of constant impedances with classical machines, ready to be switched.

    ``network`` is a dump of ``crosscheck_pf.py`` and ``voltages`` the complex bus voltages
    of the case's power flow solution, in the order of ``network['bus']``. ``governors`` is
    ``refuse`` (a case with a governor is not a classical case) or ``inert`` (a ``TG2`` is held
    to do nothing, as ANDES 2.0.0 runs it: see the module docstring).
    """

    def __init__(self, network: dict[str, Any], voltages: Any, governors: str = "refuse") -> None:
        np = _numpy()
        machines = network.get("machines") or {}
        other = [
            m
            for m in machines.get("other_models") or []
            if not (governors == "inert" and m == "TG2")
        ]
        if other:
            raise CrosscheckError(
                "the case has devices the classical model does not represent: " + ", ".join(other)
            )
        self.machines = [m for m in machines.get("classical", []) if m.get("in_service", True)]
        if not self.machines:
            raise CrosscheckError("the case has no machine of the classical model")
        self.base = float(network["baseMVA"])
        self.f_hz = float(network.get("f_hz", 60.0))
        self.bus_numbers = [int(row[0]) for row in network["bus"]]
        self.position = {number: i for i, number in enumerate(self.bus_numbers)}
        self.bus_idx = [str(i) for i in network["bus_idx"]]
        self.branches = [[float(x) for x in row] for row in network["branch"]]
        self.branch_idx = [str(i) for i in network.get("branch_idx", [])]
        self.v = np.asarray(voltages, dtype=complex)
        n = len(self.bus_numbers)
        bus = np.asarray(network["bus"], dtype=float)
        self._shunt = (bus[:, 4] + 1j * bus[:, 5]) / self.base
        demand = (bus[:, 2] + 1j * bus[:, 3]) / self.base
        # A constant impedance that takes the load's power at the solution's voltage.
        self._load = np.conj(demand) / np.abs(self.v) ** 2
        self._demand = demand
        self.m = len(self.machines)
        self.machine_bus = [self.position[int(mc["bus"])] for mc in self.machines]
        if len(set(self.machine_bus)) != self.m:
            raise CrosscheckError("two machines on one bus are not handled")
        self.h = np.array([float(mc["H"]) for mc in self.machines])
        self.d = np.array([float(mc["D"]) for mc in self.machines])
        self.y_machine = np.array(
            [1.0 / complex(float(mc["ra"]), float(mc["xd1"])) for mc in self.machines]
        )
        self.omega_s = 2.0 * math.pi * self.f_hz
        self.n = n
        self._initial_state()

    # -- admittances ---------------------------------------------------------------

    def bus_admittance(self, out: frozenset[int] = frozenset(), fault: Any = None) -> Any:
        """The bus admittance matrix with the loads and the machines' own admittances in.

        ``out`` holds the positions in the branch list of the branches that are open and
        ``fault`` is ``(bus position, admittance)`` of a fault, or ``None``. The matrix is
        MATPOWER's ``makeYbus`` with the loads added as shunts.
        """
        np = _numpy()
        y = np.zeros((self.n, self.n), dtype=complex)
        for k, row in enumerate(self.branches):
            if row[10] <= 0 or k in out:
                continue
            f, t = self.position[int(row[0])], self.position[int(row[1])]
            tap = (row[8] or 1.0) * np.exp(1j * math.radians(row[9]))
            ys = 1.0 / complex(row[2], row[3])
            half_b = 0.5j * row[4]
            y[f, f] += (ys + half_b) / (tap * np.conj(tap))
            y[t, t] += ys + half_b
            y[f, t] -= ys / np.conj(tap)
            y[t, f] -= ys / tap
        y += np.diag(self._shunt)
        y += np.diag(self._load)
        if fault is not None:
            y[fault[0], fault[0]] += fault[1]
        return y

    def _initial_state(self) -> None:
        """The machines' internal voltages and mechanical powers at the power flow solution."""
        np = _numpy()
        # Without the loads, which the power flow takes as power: what the network injects
        # at a bus is what the machine there delivers less the load.
        y_plain = self.bus_admittance() - np.diag(self._load)
        injected = self.v * np.conj(y_plain @ self.v)
        self.e0 = np.zeros(self.m, dtype=complex)
        self.pm = np.zeros(self.m)
        self.terminal_power = np.zeros(self.m, dtype=complex)
        for k, (i, mc) in enumerate(zip(self.machine_bus, self.machines, strict=True)):
            s_gen = injected[i] + self._demand[i]
            current = np.conj(s_gen / self.v[i])
            e = self.v[i] + complex(float(mc["ra"]), float(mc["xd1"])) * current
            self.e0[k] = e
            self.pm[k] = float((e * np.conj(current)).real)
            self.terminal_power[k] = s_gen

    def reduced(self, **switch: Any) -> Any:
        """The admittance matrix reduced to the machines' internal nodes (Kron reduction)."""
        np = _numpy()
        y_bus = self.bus_admittance(**switch)
        y_nn = y_bus.copy()
        y_ng = np.zeros((self.n, self.m), dtype=complex)
        for k, i in enumerate(self.machine_bus):
            y_nn[i, i] += self.y_machine[k]
            y_ng[i, k] = -self.y_machine[k]
        y_gg = np.diag(self.y_machine)
        return y_gg - y_ng.T @ np.linalg.solve(y_nn, y_ng)

    def bus_voltages(self, e: Any, **switch: Any) -> Any:
        """The bus voltages for internal voltages ``e`` (a vector) on a network."""
        np = _numpy()
        y_nn = self.bus_admittance(**switch)
        current = np.zeros(self.n, dtype=complex)
        for k, i in enumerate(self.machine_bus):
            y_nn[i, i] += self.y_machine[k]
            current[i] += self.y_machine[k] * e[k]
        return np.linalg.solve(y_nn, current)

    # -- modes ---------------------------------------------------------------------

    def jacobian(self, delta: Any, e_abs: Any, y_red: Any) -> Any:
        """``d Pe / d delta`` of the machines, per unit, at the angles ``delta``."""
        np = _numpy()
        g, b = y_red.real, y_red.imag
        diff = delta[:, None] - delta[None, :]
        pair = e_abs[:, None] * e_abs[None, :]
        # d/d delta_j of E_i E_j (G cos(d_i - d_j) + B sin(d_i - d_j)), j != i.
        off = pair * (g * np.sin(diff) - b * np.cos(diff))
        np.fill_diagonal(off, 0.0)
        k = off.copy()
        np.fill_diagonal(k, -off.sum(axis=1))
        return k

    def modes(self) -> list[dict[str, float]]:
        """The oscillatory eigenvalues of the swing equations at the initial state."""
        np = _numpy()
        y_red = self.reduced()
        delta = np.angle(self.e0)
        k = self.jacobian(delta, np.abs(self.e0), y_red)
        m = self.m
        mass = 2.0 * self.h
        a = np.zeros((2 * m, 2 * m))
        a[:m, m:] = self.omega_s * np.eye(m)
        a[m:, :m] = -(k / mass[:, None])
        a[m:, m:] = -np.diag(self.d / mass)
        eigenvalues = np.linalg.eigvals(a)
        out = []
        for z in eigenvalues:
            if z.imag > 1e-6:
                magnitude = abs(z)
                out.append(
                    {
                        "frequency_hz": float(z.imag / (2.0 * math.pi)),
                        "damping": float(-z.real / magnitude) + 0.0,
                    }
                )
        return sorted(out, key=lambda mode: mode["frequency_hz"])

    # -- the disturbance -----------------------------------------------------------

    def schedule(self, specs: list[dict[str, Any]]) -> list[tuple[float, str, Any]]:
        """The switching of a disturbance as ``(time, what, detail)``, in time order."""
        events: list[tuple[float, str, Any]] = []
        for spec in specs:
            kind = spec.get("kind")
            if kind == "fault":
                bus = str(spec["bus_idx"])
                if bus not in self.bus_idx:
                    raise CrosscheckError(f"the fault is on bus {bus!r}, which the case lacks")
                z = complex(float(spec.get("rf", 0.0)), float(spec.get("xf", 1e-4)))
                admittance = 1.0 / z
                where = self.position[self.bus_numbers[self.bus_idx.index(bus)]]
                events.append((float(spec["tf"]), "fault on", (where, admittance)))
                events.append((float(spec["tc"]), "fault off", None))
            elif kind == "toggle":
                if spec.get("model") != "Line":
                    raise CrosscheckError("only a Line can be toggled in this check")
                dev = str(spec["dev_idx"])
                if dev not in self.branch_idx:
                    raise CrosscheckError(f"the line {dev!r} is not a branch of the case")
                events.append((float(spec["t"]), "toggle", self.branch_idx.index(dev)))
            else:
                raise CrosscheckError(f"the disturbance {kind!r} is not handled")
        return sorted(events, key=lambda event: event[0])

    def simulate(
        self,
        specs: list[dict[str, Any]],
        tf: float,
        step: float,
    ) -> dict[str, float]:
        """Integrate the disturbance to ``tf`` and measure it the way the harness does.

        The metrics are taken at the instants a run with this ``step`` records, ``k * step``
        and the switching times, so that what differs from TENSA's run is the integration and
        not the sampling. The speeds are those of the machines, as a frequency.
        """
        np = _numpy()
        from scipy.integrate import solve_ivp

        events = self.schedule(specs)
        times = sorted({0.0, tf, *(t for t, _, _ in events if 0.0 < t < tf)})
        state = np.concatenate([np.angle(self.e0), np.ones(self.m)])
        e_abs = np.abs(self.e0)
        mass = 2.0 * self.h
        out: set[int] = set()
        fault: Any = None
        grid_times: list[float] = []
        deltas: list[Any] = []
        omegas: list[Any] = []
        voltages: list[Any] = []

        def rhs_for(y_red: Any) -> Any:
            def rhs(_t: float, y: Any) -> Any:
                delta, omega = y[: self.m], y[self.m :]
                e = e_abs * np.exp(1j * delta)
                pe = (e * np.conj(y_red @ e)).real
                return np.concatenate(
                    [
                        self.omega_s * (omega - 1.0),
                        (self.pm - pe - self.d * (omega - 1.0)) / mass,
                    ]
                )

            return rhs

        pending = list(events)
        for start, stop in zip(times[:-1], times[1:], strict=True):
            while pending and pending[0][0] <= start + 1e-12:
                _, what, detail = pending.pop(0)
                if what == "fault on":
                    fault = detail
                elif what == "fault off":
                    fault = None
                else:
                    out = out ^ {detail}
            switch = {"out": frozenset(out), "fault": fault}
            y_red = self.reduced(**switch)
            first = math.ceil(start / step - 1e-9)
            samples = [k * step for k in range(first, int(math.floor(stop / step + 1e-9)) + 1)]
            samples = [t for t in samples if start - 1e-9 <= t <= stop + 1e-9]
            if not samples or abs(samples[0] - start) > 1e-9:
                samples.insert(0, start)
            if abs(samples[-1] - stop) > 1e-9 and stop == tf:
                samples.append(stop)
            solution = solve_ivp(
                rhs_for(y_red),
                (start, stop),
                state,
                method="DOP853",
                rtol=1e-11,
                atol=1e-13,
                t_eval=np.array(samples),
            )
            if not solution.success:
                raise CrosscheckError(f"the integration failed: {solution.message}")
            for index, t in enumerate(solution.t):
                if grid_times and abs(t - grid_times[-1]) < 1e-9:
                    # The instant a switch acts is sampled again with the new network: what
                    # the run records at it has the event in.
                    deltas.pop()
                    omegas.pop()
                    voltages.pop()
                    grid_times.pop()
                delta = solution.y[: self.m, index]
                omega = solution.y[self.m :, index]
                grid_times.append(float(t))
                deltas.append(delta)
                omegas.append(omega)
                voltages.append(np.abs(self.bus_voltages(e_abs * np.exp(1j * delta), **switch)))
            state = solution.y[:, -1]
        spread = np.array([d.max() - d.min() for d in deltas])
        return {
            "max_angle_spread_deg": float(np.degrees(spread.max())),
            "final_angle_spread_deg": float(np.degrees(spread[-1])),
            "min_voltage_pu": float(np.min(voltages)),
            "frequency_nadir_hz": float(self.f_hz * np.min(omegas)),
        }


# ----------------------------------------------------------------------------------------
# The check: network file -> pandapower power flow -> model -> reference checks
# ----------------------------------------------------------------------------------------


def power_flow_voltages(network: dict[str, Any]) -> Any:
    """The complex bus voltages of the network's power flow, solved by pandapower."""
    np = _numpy()
    ppc = _ppc_from_network(network)
    result = solve_ppc(ppc, float(network.get("f_hz", 60.0)), network["bus_idx"])
    voltage = np.array([result["bus_voltage"][str(i)] for i in network["bus_idx"]])
    angle = np.radians([result["bus_angle"][str(i)] for i in network["bus_idx"]])
    return voltage * np.exp(1j * angle)


def load_plan(reference: Path) -> tuple[list[dict[str, Any]], float, float]:
    """The disturbance ``(specs, tf, step)`` of a reference file (``specs`` may be empty)."""
    document = json.loads(reference.read_text(encoding="utf-8"))
    plan = document.get("disturbance")
    if not plan:
        raise CrosscheckError(f"{reference.name} gives no disturbance to integrate")
    return (
        list(plan.get("specs") or []),
        float(plan.get("tf", 10.0)),
        float(plan.get("h") or DEFAULT_STEP),
    )


def disturbance_events(
    network: dict[str, Any], specs: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """What acts in a run of the harness: the events of the case's file, then the ``specs``."""
    events = [*((network.get("machines") or {}).get("file_events") or []), *specs]
    if not events:
        raise CrosscheckError("neither the reference nor the case's file gives a disturbance")
    return events


def solve_network(
    network: dict[str, Any],
    specs: list[dict[str, Any]],
    tf: float,
    step: float,
    governors: str = "refuse",
) -> dict[str, Any]:
    """Everything the check computes for one network, as a JSON-able dict.

    The disturbance integrated is the events of the case's file followed by ``specs``, which is
    what a run of the harness has acting.
    """
    import numpy as np
    import scipy

    voltages = power_flow_voltages(network)
    model = ClassicalModel(network, voltages, governors)
    modes = model.modes()
    y_red = model.reduced()
    return {
        "modes": modes,
        "disturbance": model.simulate(disturbance_events(network, specs), tf, step),
        "initial_state": {
            "E_magnitude": [round(float(x), 6) for x in np.abs(model.e0)],
            "delta_deg": [round(float(x), 5) for x in np.degrees(np.angle(model.e0))],
            "Pm_pu": [round(float(x), 6) for x in model.pm],
            "reduced_admittance": [
                [[round(float(z.real), 5), round(float(z.imag), 5)] for z in row] for row in y_red
            ],
        },
        "numpy": np.__version__,
        "scipy": scipy.__version__,
    }


def reference_checks(result: dict[str, Any], source: str, step: float) -> list[dict[str, Any]]:
    """The checks of a reference file that these computations give."""
    why = (
        f"the swing equations of the classical model solved independently of TENSA and ANDES "
        f"({source}: Kron reduction, linearisation, scipy DOP853), numpy {result['numpy']}, "
        f"scipy {result['scipy']}; written by scripts/crosscheck_classical.py"
    )
    common = {"kind": "independent-solver", "reference": why, "generated_by": GENERATED_BY}
    checks: list[dict[str, Any]] = []
    modes = result["modes"]
    for k, mode in enumerate(modes):
        freq = mode["frequency_hz"]
        neighbours = [m["frequency_hz"] for j, m in enumerate(modes) if j != k]
        room = min([WINDOW_FRACTION * freq, *(abs(freq - f) / 2 for f in neighbours)])
        window = [round(freq - room, 3), round(freq + room, 3)]
        label = f"mode {k + 1} of {len(modes)}, {freq:.3f} Hz"
        checks.append(
            {
                "name": f"Frequency of {label}, against the linearised swing equations",
                "quantity": "eig.mode_frequency_hz",
                "expected": round(freq, 6),
                "tolerance": {"abs": 0.001},
                "window_hz": window,
                **common,
            }
        )
        checks.append(
            {
                "name": f"Damping ratio of {label}, against the linearised swing equations",
                "quantity": "eig.mode_damping_ratio",
                "expected": round(mode["damping"], 6) + 0.0,
                "tolerance": {"abs": 1e-4},
                "window_hz": window,
                **common,
            }
        )
    metrics = result["disturbance"]
    shown = f"integrated with a step of {step:.6g} s"
    for name, quantity, key, tol in (
        (
            "Largest rotor angle spread in the disturbance run",
            "tds.max_angle_spread_deg",
            "max_angle_spread_deg",
            {"abs": 0.05},
        ),
        (
            "Rotor angle spread at the end of the disturbance run",
            "tds.final_angle_spread_deg",
            "final_angle_spread_deg",
            {"abs": 0.5},
        ),
        (
            "Lowest bus voltage in the disturbance run",
            "tds.min_voltage_pu",
            "min_voltage_pu",
            {"abs": 5e-5},
        ),
        (
            "Lowest machine frequency in the disturbance run",
            "tds.frequency_nadir_hz",
            "frequency_nadir_hz",
            {"abs": 0.002},
        ),
    ):
        checks.append(
            {
                "name": name,
                "quantity": quantity,
                "expected": round(metrics[key], 6),
                "tolerance": tol,
                **common,
                "reference": why + f"; {shown}",
            }
        )
    return checks


def cmd_solve(args: argparse.Namespace) -> int:
    source = Path(args.network)
    network = json.loads(source.read_text(encoding="utf-8"))
    if args.example:
        reference = Path(args.reference) if args.reference else REFERENCES / f"{args.example}.json"
        specs, tf, step = load_plan(reference)
    else:
        raise CrosscheckError(
            "solve needs --example ID, whose reference file holds the disturbance"
        )
    result = solve_network(network, specs, tf, step, args.governors)
    if args.write:
        what = f"the network and machines ANDES holds for {network['source']}"
        if args.governors == "inert":
            what += (
                ", its TG2 governors held at their initial output because ANDES 2.0.0 does not "
                "move them with the dead band off"
            )
        checks = reference_checks(result, what, step)
        write_reference(args.example, checks, reference, GENERATED_BY)
        print(f"wrote {len(checks)} checks to {reference}")
    else:
        print(json.dumps(result, indent=1))
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    tensa_python = _python_for(args.tensa_python, "TENSA_PYTHON", "andes")
    verify_python = _python_for(args.verify_python, "TENSA_VERIFY_PYTHON", "pandapower")
    pf_script = str(SCRIPTS / "crosscheck_pf.py")
    script = str(Path(__file__).resolve())
    with tempfile.TemporaryDirectory(prefix="tensa-crosscheck-") as tmp:
        network = str(Path(tmp) / "network.json")
        subprocess.run([tensa_python, pf_script, "dump", args.id, "-o", network], check=True)
        command = [verify_python, script, "solve", network, "--example", args.id]
        command += ["--governors", args.governors]
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
    )
    sub = parser.add_subparsers(dest="command", required=True)
    solve = sub.add_parser(
        "solve", help="compute the modes and the disturbance of a network file (needs pandapower)"
    )
    solve.add_argument("network", help="a network file from `crosscheck_pf.py dump`")
    solve.add_argument("--example", help="the example id, whose reference holds the disturbance")
    solve.add_argument("--write", action="store_true", help="write the reference file")
    solve.add_argument("--reference", help="the reference file (default: the case's own)")
    solve.add_argument(
        "--governors", choices=GOVERNOR_CHOICES, default="refuse", help=GOVERNOR_HELP
    )
    solve.set_defaults(func=cmd_solve)
    run = sub.add_parser(
        "run", help="dump in TENSA's environment and solve in the verification one"
    )
    run.add_argument("id", help="an example id")
    run.add_argument("--write", action="store_true", help="write the reference file")
    run.add_argument("--reference", help="the reference file (default: the case's own)")
    run.add_argument("--governors", choices=GOVERNOR_CHOICES, default="refuse", help=GOVERNOR_HELP)
    run.add_argument(
        "--tensa-python", help="a Python with ANDES (default: this one, or TENSA_PYTHON)"
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
        print(f"crosscheck_classical: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    with contextlib.suppress(AttributeError):
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    sys.exit(main())
