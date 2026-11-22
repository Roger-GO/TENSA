# Experiment: can a PSID run report every accepted step and be stopped from outside?
# A DiscreteCallback is pushed into sim.callbacks before execute!, which builds its
# CallbackSet from that vector.
using PowerSystems, PowerFlows, PowerSimulationsDynamics, Sundials, Logging
const PSY = PowerSystems
const PSID = PowerSimulationsDynamics
const SciMLBase = PSID.SciMLBase  # PSID's own dependency; not a direct one of this project
Logging.global_logger(Logging.ConsoleLogger(stderr, Logging.Error))

raw, dyr, out_dir, stop_at = ARGS[1], ARGS[2], ARGS[3], parse(Float64, ARGS[4])
mkpath(out_dir)
t_start = time()
sys = System(raw, dyr; runchecks = false)
for b in PSY.get_components(PSY.ACBus, sys)
    PSY.get_bustype(b) == PSY.ACBusTypes.SLACK && PSY.set_bustype!(b, PSY.ACBusTypes.PV)
end
line = first(PSY.get_components(PSY.Line, sys))
sim = Simulation(ResidualModel, sys, out_dir, (0.0, 10.0), BranchTrip(1.0, Line, PSY.get_name(line)))
println("build status: ", sim.status, "  (", round(time() - t_start; digits = 1), " s since start)")

steps = Ref(0)
times = Float64[]
first_u = Ref{Any}(nothing)
abort_file = joinpath(out_dir, "ABORT")
isfile(abort_file) && rm(abort_file)

condition(u, t, integrator) = true
function affect!(integrator)
    steps[] += 1
    push!(times, integrator.t)
    first_u[] === nothing && (first_u[] = (length(integrator.u), typeof(integrator.u)))
    # Stop on an outside signal: here a file, in TENSA the control pipe's flag.
    if integrator.t >= stop_at && !isfile(abort_file)
        touch(abort_file)
    end
    if isfile(abort_file)
        SciMLBase.terminate!(integrator)
    end
    return
end
push!(sim.callbacks, SciMLBase.DiscreteCallback(condition, affect!; save_positions = (false, false)))

t0 = time()
status = execute!(sim, IDA(); dtmax = 0.02, enable_progress_bar = false)
println("execute status: ", status, "  wall ", round(time() - t0; digits = 2), " s")
println("callback calls: ", steps[], "  first t: ", first(times), "  last t: ", last(times))
println("state vector seen in callback: ", first_u[])
println("global state index available: ", hasproperty(sim.inputs, :global_index) || applicable(PSID.get_global_index, sim.inputs))
try
    res = read_results(sim)
    t, v = get_voltage_magnitude_series(res, 7)
    println("results readable after abort: ", length(t), " points up to t = ", last(t))
catch err
    println("results after abort: ERROR ", sprint(showerror, err)[1:min(end, 300)])
end
println("EXPERIMENT DONE total ", round(time() - t_start; digits = 1), " s")
