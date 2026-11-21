"""Experiment for Phase 4: does embedded Julia behave inside TENSA's worker model?

TENSA runs each session in a child process started with multiprocessing's spawn
context, talks to it over two Pipes, aborts a run through a multiprocessing Event,
and kills the child when a session is reaped. This script does the same with a
child that holds Julia through juliacall:

1. the child starts, loads the Sienna packages and a case, runs a power flow and
   answers over the Pipe;
2. a dynamic run is started and aborted from the parent by setting the Event, which
   a per-step callback inside Julia reads;
3. a second dynamic run is started and the child is killed mid-run; the parent
   must see a closed pipe and no process left.

    python exp_juliacall_worker.py <case.raw> <case.dyr> <scratch dir>
"""

from __future__ import annotations

import multiprocessing as mp
import os
import sys
import time


def child(ctrl, data, abort, raw: str, dyr: str, scratch: str) -> None:
    t0 = time.perf_counter()
    from juliacall import Main as jl

    jl.seval("using PowerSystems, PowerFlows, PowerSimulationsDynamics, Sundials, Logging")
    jl.seval("Logging.global_logger(Logging.ConsoleLogger(stderr, Logging.Error))")
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
        function run_tds(sys, dir, tf, on_step)
            sim = Simulation(ResidualModel, sys, dir, (0.0, tf))
            cond(u, t, integrator) = true
            function affect!(integrator)
                stop = on_step(integrator.t)
                (stop isa Bool ? stop : pyconvert(Bool, stop)) && PSID.SciMLBase.terminate!(integrator)
                return
            end
            push!(sim.callbacks, PSID.SciMLBase.DiscreteCallback(cond, affect!; save_positions = (false, false)))
            return string(execute!(sim, IDA(); dtmax = 0.005, enable_progress_bar = false))
        end
        """
    )
    jl.seval("using PythonCall: pyconvert")
    os.makedirs(scratch, exist_ok=True)
    system = None
    data.send({"type": "ready", "startup_s": time.perf_counter() - t0, "pid": os.getpid()})
    while True:
        try:
            cmd = ctrl.recv()
        except (EOFError, OSError):
            return
        op = cmd["op"]
        if op == "shutdown":
            data.send({"type": "result", "op": op})
            return
        t0 = time.perf_counter()
        if op == "load":
            system = jl.load_case(raw, dyr)
            n = int(jl.seval("s -> length(collect(PSY.get_components(PSY.ACBus, s)))")(system))
            data.send({"type": "result", "op": op, "buses": n, "s": time.perf_counter() - t0})
        elif op == "pflow":
            ok = bool(jl.seval("s -> solve_and_store_power_flow!(ACPowerFlow(), s)")(system))
            data.send({"type": "result", "op": op, "converged": ok, "s": time.perf_counter() - t0})
        elif op == "tds":
            steps = {"n": 0, "t": 0.0}

            def on_step(t):
                steps["n"] += 1
                steps["t"] = float(t)
                if steps["n"] % 50 == 0:
                    data.send({"type": "progress", "t": steps["t"], "n": steps["n"]})
                return abort.is_set()

            status = jl.run_tds(system, scratch, float(cmd["tf"]), on_step)
            data.send(
                {"type": "result", "op": op, "status": status, "steps": steps["n"], "t": steps["t"],
                 "aborted": abort.is_set(), "s": time.perf_counter() - t0}
            )


def wait_result(data, timeout: float):
    """Read messages until a result (or the pipe closes); return (result, progress count)."""
    progress = 0
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if data.poll(0.2):
            try:
                msg = data.recv()
            except (EOFError, OSError) as exc:
                return {"type": "pipe-closed", "error": type(exc).__name__}, progress
            if msg["type"] == "progress":
                progress += 1
                continue
            return msg, progress
    return {"type": "timeout"}, progress


def main() -> None:
    raw, dyr, scratch = sys.argv[1:4]
    ctx = mp.get_context("spawn")
    pc, cc = ctx.Pipe(duplex=True)
    pd, cd = ctx.Pipe(duplex=True)
    abort = ctx.Event()
    proc = ctx.Process(target=child, args=(cc, cd, abort, raw, dyr, scratch), name="sienna-worker-exp")
    t0 = time.perf_counter()
    proc.start()
    cc.close()
    cd.close()

    ready, _ = wait_result(pd, 600)
    print("1. child ready:", ready, f"(wall {time.perf_counter() - t0:.1f} s)")
    pc.send({"op": "load"})
    print("   load:", wait_result(pd, 600)[0])
    pc.send({"op": "pflow"})
    print("   pflow:", wait_result(pd, 600)[0])
    pc.send({"op": "pflow"})
    print("   pflow again:", wait_result(pd, 600)[0])

    # warm the dynamic path once so the abort test is not measuring compilation
    pc.send({"op": "tds", "tf": 0.2})
    print("   tds warm-up:", wait_result(pd, 900)[0])

    pc.send({"op": "tds", "tf": 200.0})
    time.sleep(1.0)
    t_abort = time.perf_counter()
    abort.set()
    res, progress = wait_result(pd, 120)
    print(f"2. abort: result {res}; progress messages before the result {progress}; "
          f"answered {time.perf_counter() - t_abort:.2f} s after the Event was set")
    abort.clear()

    pc.send({"op": "pflow"})
    print("   child still serves after an abort:", wait_result(pd, 120)[0])

    pc.send({"op": "tds", "tf": 2000.0})
    time.sleep(1.0)
    t_kill = time.perf_counter()
    proc.kill()
    proc.join(30)
    res, _ = wait_result(pd, 10)
    print(f"3. kill mid-run: exitcode {proc.exitcode}, alive {proc.is_alive()}, parent saw {res}, "
          f"reaped in {time.perf_counter() - t_kill:.2f} s")
    print("EXPERIMENT DONE")


if __name__ == "__main__":
    main()
