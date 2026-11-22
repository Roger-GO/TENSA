"""Experiment: Julia embedded in a Python process through juliacall.

Measures start-up, a power flow, and a dynamic run whose per-step callback calls a
Python function (the path TENSA's worker would use to stream and to abort).
"""

from __future__ import annotations

import sys
import time

t0 = time.perf_counter()
from juliacall import Main as jl  # noqa: E402

t_import = time.perf_counter() - t0

raw, dyr, out_dir = sys.argv[1:4]
import os  # noqa: E402

os.makedirs(out_dir, exist_ok=True)

t0 = time.perf_counter()
jl.seval("using PowerSystems, PowerFlows, PowerSimulationsDynamics, Sundials, Logging")
jl.seval("Logging.global_logger(Logging.ConsoleLogger(stderr, Logging.Error))")
t_using = time.perf_counter() - t0

jl.seval(
    """
    const PSY = PowerSystems
    const PSID = PowerSimulationsDynamics
    function load_case(raw, dyr)
        sys = System(raw, dyr; runchecks = false)
        for b in PSY.get_components(PSY.ACBus, sys)
            PSY.get_bustype(b) == PSY.ACBusTypes.SLACK && PSY.set_bustype!(b, PSY.ACBusTypes.PV)
        end
        return sys
    end
    function bus_voltages(sys)
        return Dict(PSY.get_number(b) => PSY.get_magnitude(b) for b in PSY.get_components(PSY.ACBus, sys))
    end
    function run_with_callback(sys, out_dir, on_step)
        sim = Simulation(ResidualModel, sys, out_dir, (0.0, 10.0))
        cond(u, t, integrator) = true
        function affect!(integrator)
            # on_step is a Python function; a true return asks the run to stop
            stop = on_step(integrator.t, integrator.u)
            pyconvert_bool(stop) && PSID.SciMLBase.terminate!(integrator)
            return
        end
        push!(sim.callbacks, PSID.SciMLBase.DiscreteCallback(cond, affect!; save_positions = (false, false)))
        status = execute!(sim, IDA(); dtmax = 0.02, enable_progress_bar = false)
        return string(status)
    end
    """
)
jl.seval("using PythonCall: pyconvert; pyconvert_bool(x) = x isa Bool ? x : pyconvert(Bool, x)")

t0 = time.perf_counter()
system = jl.load_case(raw, dyr)
t_load = time.perf_counter() - t0

t0 = time.perf_counter()
converged = jl.seval("s -> solve_and_store_power_flow!(ACPowerFlow(), s)")(system)
t_pf = time.perf_counter() - t0
volts = jl.bus_voltages(system)

t0 = time.perf_counter()
jl.seval("s -> solve_and_store_power_flow!(ACPowerFlow(), s)")(system)
t_pf2 = time.perf_counter() - t0

calls = {"n": 0, "last_t": 0.0, "len_u": 0}


def on_step(t, u):
    calls["n"] += 1
    calls["last_t"] = float(t)
    calls["len_u"] = len(u)
    return float(t) >= 3.0  # ask to stop at 3 s


t0 = time.perf_counter()
status = jl.run_with_callback(system, out_dir, on_step)
t_tds = time.perf_counter() - t0

t0 = time.perf_counter()
calls.update(n=0)
status2 = jl.run_with_callback(system, out_dir, on_step)
t_tds2 = time.perf_counter() - t0

print(f"import juliacall: {t_import:.1f} s")
print(f"using Sienna packages: {t_using:.1f} s")
print(f"load case: {t_load:.1f} s")
print(f"power flow first call: {t_pf:.1f} s, second call: {t_pf2:.3f} s, converged={converged}")
print(f"bus 7 voltage: {volts[7]:.6f}")
print(f"dynamic run first: {t_tds:.1f} s status={status}; second: {t_tds2:.2f} s status={status2}")
print(f"python callback calls (second run): {calls['n']}, stopped at t={calls['last_t']:.3f}, state length {calls['len_u']}")
print("JULIACALL OK")
