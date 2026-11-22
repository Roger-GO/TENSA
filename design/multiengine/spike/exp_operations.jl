# Experiment for Phase 7 (operations): what PowerSimulations 0.34 needs and gives for the
# smallest study TENSA's files can state, a one-period economic dispatch on a MATPOWER case
# with gencost. Every step is tried on its own and reports what happened, so one failure does
# not hide the rest. Run in the project that has PowerSimulations, HiGHS and Ipopt:
#
#   julia --project=<sienna-env> exp_operations.jl <case.m> <out_dir>
using Dates, Logging
using PowerSystems, PowerSimulations, HiGHS
const PSY = PowerSystems
const PSI = PowerSimulations
Logging.global_logger(Logging.ConsoleLogger(stderr, Logging.Error))

case_file, out_dir = ARGS[1], ARGS[2]
mkpath(out_dir)

step(name) = println("\n==== ", name)
function attempt(f, name)
    step(name)
    try
        f()
    catch err
        println("FAILED: ", first(split(sprint(showerror, err), '\n')))
        nothing
    end
end

pkgver(m) = try string(pkgversion(m)) catch; "?" end
step("versions")
println("julia ", VERSION, "  PowerSystems ", pkgver(PSY), "  PowerSimulations ", pkgver(PSI), "  HiGHS ", pkgver(HiGHS))

sys = attempt("load the MATPOWER case") do
    s = System(case_file; runchecks = false)
    println("base power ", PSY.get_base_power(s), "  units ", PSY.get_units_base(s))
    for T in (PSY.ACBus, PSY.Line, PSY.Transformer2W, PSY.TapTransformer, PSY.ThermalStandard,
              PSY.RenewableDispatch, PSY.PowerLoad, PSY.StandardLoad, PSY.FixedAdmittance)
        n = length(collect(PSY.get_components(T, s)))
        n > 0 && println("  ", T, ": ", n)
    end
    s
end
sys === nothing && exit(1)

attempt("what a generator holds: limits and cost") do
    for g in PSY.get_components(PSY.ThermalStandard, sys)
        println(PSY.get_name(g), "  bus ", PSY.get_number(PSY.get_bus(g)),
                "  P ", PSY.get_active_power(g), "  limits ", PSY.get_active_power_limits(g),
                "  ramp ", PSY.get_ramp_limits(g), "  time limits ", PSY.get_time_limits(g),
                "  status ", PSY.get_status(g), "  must_run ", PSY.get_must_run(g))
        c = PSY.get_operation_cost(g)
        println("    cost type ", typeof(c))
        println("    cost ", c)
    end
end

attempt("bus types and the slack normalisation the other packages need") do
    for b in PSY.get_components(PSY.ACBus, sys)
        PSY.get_bustype(b) == PSY.ACBusTypes.SLACK && println("  SLACK at ", PSY.get_number(b))
        PSY.get_bustype(b) == PSY.ACBusTypes.REF && println("  REF at ", PSY.get_number(b))
    end
end

step("names PowerSimulations exports for templates, network models and formulations")
for n in sort(collect(names(PSI)))
    s = string(n)
    if occursin(r"template|PowerModel|Dispatch|Commitment|StaticPowerLoad|DecisionModel|read_|OptimizationProblemResults|NetworkModel|DeviceModel|ProblemTemplate|build!|solve!|get_optimizer|objective|dual"i, s)
        print(s, "  ")
    end
end
println()

# A decision model needs a forecast even for one period. The files hold none, so one step of
# each load at its own value is attached here; this is what TENSA would have to do in code.
resolution = Hour(1)
t0 = DateTime("2026-01-01T00:00:00")
attempt("attach a one-step time series to every load and transform to a forecast") do
    n = 0
    for T in (PSY.PowerLoad, PSY.StandardLoad)
        for l in collect(PSY.get_components(T, sys))
            data = PSY.TimeSeries.TimeArray([t0, t0 + resolution], [1.0, 1.0])
            ts = PSY.SingleTimeSeries(; name = "max_active_power", data = data,
                                      scaling_factor_multiplier = PSY.get_max_active_power)
            PSY.add_time_series!(sys, l, ts)
            n += 1
        end
    end
    println("loads given a series: ", n)
    PSY.transform_single_time_series!(sys, Hour(1), Hour(1))
    println("forecast horizon ", PSY.get_forecast_horizon(sys), "  resolution ", PSY.get_time_series_resolutions(sys))
end

function run_model(label, network)
    attempt("economic dispatch, one period, network model " * label) do
        template = PSI.template_economic_dispatch(; network_model = PSI.NetworkModel(network))
        println("template device models: ", [string(k) for k in keys(template.devices)])
        model = PSI.DecisionModel(template, sys; optimizer = HiGHS.Optimizer, horizon = Hour(1),
                                  name = "ed_" * label, store_variable_names = true)
        dir = joinpath(out_dir, label)
        mkpath(dir)
        b = PSI.build!(model; output_dir = dir)
        println("build: ", b)
        s = PSI.solve!(model)
        println("solve: ", s)
        res = PSI.OptimizationProblemResults(model)
        println("objective: ", PSI.get_objective_value(res))
        println("variables: ", PSI.list_variable_names(res))
        println("duals: ", PSI.list_dual_names(res))
        println("parameters: ", PSI.list_parameter_names(res))
        println("expressions: ", PSI.list_expression_names(res))
        for v in PSI.list_variable_names(res)
            df = PSI.read_variable(res, v)
            println("  ", v, " -> ", size(df), "  ", first(df, 1))
        end
        res
    end
end

run_model("copper_plate", PSI.CopperPlatePowerModel)
run_model("dc", PSI.DCPPowerModel)
run_model("ptdf", PSI.PTDFPowerModel)

attempt("what the solved dispatch is against the file's own dispatch") do
    total_load = sum(PSY.get_max_active_power(l) for T in (PSY.PowerLoad, PSY.StandardLoad) for l in PSY.get_components(T, sys); init = 0.0)
    total_gen = sum(PSY.get_active_power(g) for g in PSY.get_components(PSY.ThermalStandard, sys); init = 0.0)
    println("file: total load ", total_load, "  total generation ", total_gen, " (system base)")
end

println("\nEXPERIMENT DONE")
