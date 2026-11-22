# TensaSiennaOps.jl: the operations of TENSA's Sienna engine, with
# PowerSimulations (PSI) and HiGHS. Included after TensaSienna.jl, and only
# when a session first asks for an operation, so a session that only solves
# power flows never loads PowerSimulations. It reaches the first module as
# Main.TensaSienna, which is where both files live when the tests and the
# Python worker include them into Main. The public function answers a JSON
# string.

module TensaSiennaOps

using PowerSystems
using PowerSimulations
using HiGHS
using Dates
using JSON3
using Logging

const PSY = PowerSystems
const PSI = PowerSimulations

import Main.TensaSienna as TS

export dispatch_json

# The message of a case with no cost data. The Python side
# (tensa.engines.sienna.dispatch.NO_COST_DATA_MESSAGE) holds the same string
# and the route maps it to 422; the two copies are pinned together by the
# route test, which sends this exact text through the worker.
const NO_COST_DATA = "the case has no generator cost data; economic dispatch needs gencost records"

const NETWORK_MODELS = ("copper_plate", "dc", "ptdf")

# The network model type of a name.
function _network_model(name::AbstractString)
    name == "copper_plate" && return PSI.CopperPlatePowerModel
    name == "dc" && return PSI.DCPPowerModel
    name == "ptdf" && return PSI.PTDFPowerModel
    throw(ArgumentError("network_model must be copper_plate, dc or ptdf, got $(name)"))
end

# The quadratic, linear and constant coefficients of a generator's cost curve,
# or nothing when the generator has no cost data. A MATPOWER gencost model 2
# row is read by PowerSystems as a CostCurve of QuadraticCurve(a, b, c) with
# the file's own numbers ($/MW^2h, $/MWh, $/h).
function _cost_coefficients(g)
    cost = PSY.get_operation_cost(g)
    cost isa PSY.ThermalGenerationCost || return nothing
    variable = PSY.get_variable(cost)
    variable isa PSY.CostCurve || return nothing
    curve = PSY.get_value_curve(variable)
    curve isa PSY.QuadraticCurve || return nothing
    a = PSY.get_quadratic_term(curve)
    b = PSY.get_proportional_term(curve)
    c = PSY.get_constant_term(curve)
    (a == 0.0 && b == 0.0 && c == 0.0) && return nothing
    return (a, b, c)
end

# Label every thermal generator's cost curve as being in natural units, so
# that the objective is the true cost in $/h of power in MW. PowerSystems
# reads a MATPOWER gencost model 2 row as QuadraticCurve(a, b, c) with the
# file's own numbers ($/MW^2h, $/MWh, $/h) but labels the curve with a per
# unit system, and PowerSimulations then evaluates it on power in per unit:
# the quadratic term weighs base_mva times too lightly against the linear
# one, and the dispatch is not the MATPOWER optimum. Labelled NATURAL_UNITS,
# PowerSimulations converts the curve itself, whatever the generator's base;
# a trial on this environment with costs 0.1 P^2 + 10 P and 0.1 P^2 + 20 P
# meeting 150 MW gave 100 MW and 50 MW at 3250 $/h, with the second
# generator's base at 100 or 200 MVA, where SYSTEM_BASE and DEVICE_BASE both
# gave 150 MW and 0 MW.
function _costs_in_natural_units!(sys)
    for g in PSY.get_components(PSY.ThermalStandard, sys)
        coefficients = _cost_coefficients(g)
        coefficients === nothing && continue
        a, b, c = coefficients
        cost = PSY.get_operation_cost(g)
        old = PSY.get_variable(cost)
        PSY.set_variable!(
            cost,
            PSY.CostCurve(
                PSY.QuadraticCurve(a, b, c),
                PSY.UnitSystem.NATURAL_UNITS,
                PSY.get_vom_cost(old),
            ),
        )
    end
    return nothing
end

"""
    dispatch_json(s::TS.Session; network_model, duals = false) -> String

Solve the one-period economic dispatch of the loaded case. `network_model` is
"copper_plate", "dc" or "ptdf". The system is deep-copied first: the one-step
forecast every load needs, the relabelled cost curves and the ramp limits
taken off (one period has nothing to ramp from) go to the copy, never to the
session's system. The cost curves are labelled as natural units on the
copy so that the objective is the true cost in \$/h of power in MW (see
`_costs_in_natural_units!`).

The answer carries `objective_per_h` (the solver's objective, in \$/h) and `objective_check_per_h` (the cost recomputed from the
dispatch in MW and the file's own coefficients); the two agree to solver
tolerance. `generators` lists every dispatched generator with its bus, id and
MW. `slacks` lists every slack variable whose value is past 1e-6 MW (spec
section 13: slack variables always read back and reported when non-zero).
`duals` is empty unless `duals` is true; the copper plate model has no duals,
the dc and ptdf models may.

Throws an `ArgumentError` for a network model it does not know, an
`ErrorException` with the no-cost-data message when no generator of the case
has cost data, and an `ErrorException` whose first line is the status when
the build or the solve does not succeed.
"""
function dispatch_json(
    s::TS.Session;
    network_model::AbstractString,
    duals::Bool = false,
)::String
    network = _network_model(network_model)
    sys = deepcopy(s.sys)
    base_mva = PSY.get_base_power(sys)

    # Refuse a case without cost data: the check the probe's output supports
    # (a MATPOWER case without gencost gives generators with zero or missing
    # cost).
    has_cost = any(
        g -> _cost_coefficients(g) !== nothing,
        PSY.get_components(PSY.ThermalStandard, sys),
    )
    has_cost || throw(ErrorException(NO_COST_DATA))

    # The one-step forecast every load needs, on the copy (the probe's
    # pattern; both calls mutate the system).
    resolution = Hour(1)
    t0 = DateTime("2026-01-01T00:00:00")
    for T in (PSY.PowerLoad, PSY.StandardLoad)
        for l in collect(PSY.get_components(T, sys))
            data = PSY.TimeSeries.TimeArray([t0, t0 + resolution], [1.0, 1.0])
            ts = PSY.SingleTimeSeries(;
                name = "max_active_power",
                data = data,
                scaling_factor_multiplier = PSY.get_max_active_power,
            )
            PSY.add_time_series!(sys, l, ts)
        end
    end
    PSY.transform_single_time_series!(sys, Hour(1), Hour(1))

    _costs_in_natural_units!(sys)
    # One period has no period before it to ramp from: without this the
    # model holds each generator within its ramp of the output the file
    # stores, and a MATPOWER file's ramp columns of 0 (no data) pin every
    # generator there, which makes the problem infeasible.
    for g in PSY.get_components(PSY.ThermalStandard, sys)
        PSY.set_ramp_limits!(g, nothing)
    end

    logger = TS._NoteLogger()
    res = Logging.with_logger(logger) do
        # The keyword is `network`: the template takes any keyword and keeps
        # the copper plate for one it does not know, so the model is checked.
        template = PSI.template_economic_dispatch(; network = PSI.NetworkModel(network))
        PSI.get_network_model(template) isa PSI.NetworkModel{network} || throw(
            ErrorException("economic dispatch was built without the $(network_model) network model"),
        )
        # The template models PowerLoad alone; a case read from PSS/E holds
        # StandardLoad, which would otherwise be left out of the balance.
        PSI.set_device_model!(template, PSY.StandardLoad, PSI.StaticPowerLoad)
        model = PSI.DecisionModel(
            template,
            sys;
            optimizer = HiGHS.Optimizer,
            horizon = Hour(1),
            name = "tensa_ed",
            store_variable_names = true,
        )
        dir = mktempdir()
        built = PSI.build!(model; output_dir = dir)
        built == PSI.ModelBuildStatus.BUILT || throw(
            ErrorException("economic dispatch did not build: $(built)"),
        )
        solved = PSI.solve!(model)
        solved == PSI.RunStatus.SUCCESSFULLY_FINALIZED || throw(
            ErrorException("economic dispatch did not solve: $(solved)"),
        )
        PSI.OptimizationProblemResults(model)
    end
    notes = [
        Dict{String, Any}("level" => TS._level_name(l), "text" => TS._scrub(t, (s.raw, s.dyr))) for
        (l, t) in logger.records
    ]

    objective_per_h = PSI.get_objective_value(res)

    # The dispatch, in MW: the variable values are in MW (the probe's 38.0323
    # for gen-2 against a 2.59 pu load on a 100 MVA base).
    generators = Any[]
    total_dispatch_mw = 0.0
    variable = PSI.read_variable(res, "ActivePowerVariable__ThermalStandard")
    for row in eachrow(variable)
        name = String(row[:name])
        g = PSY.get_component(PSY.ThermalStandard, sys, name)
        bus = PSY.get_number(PSY.get_bus(g))
        p_mw = Float64(row[:value])
        total_dispatch_mw += p_mw
        push!(generators, (
            name = name,
            bus = bus,
            id = TS._generator_id(name, bus),
            p_mw = p_mw,
        ))
    end
    sort!(generators; by = x -> (x.bus, x.id, x.name))

    # The cost recomputed from the dispatch in MW and the file's own
    # coefficients, as PowerSystems holds them: a * P_mw^2 + b * P_mw + c.
    objective_check_per_h = 0.0
    for row in generators
        g = PSY.get_component(PSY.ThermalStandard, sys, row.name)
        coefficients = _cost_coefficients(g)
        coefficients === nothing && continue
        a, b, c = coefficients
        objective_check_per_h += a * row.p_mw^2 + b * row.p_mw + c
    end

    duals_list = Any[]
    if duals
        for dual_name in PSI.list_dual_names(res)
            rows = Any[]
            for row in eachrow(PSI.read_dual(res, dual_name))
                push!(rows, (element = string(row[:name]), value = Float64(row[:value])))
            end
            push!(duals_list, (name = String(dual_name), rows = rows))
        end
    end

    # Slack variables past 1e-6 MW. PowerSimulations names slack variables
    # with "Slack" in the variable key; the probe's run has none, so an empty
    # list is the common case.
    slacks = Any[]
    for variable_name in PSI.list_variable_names(res)
        occursin("Slack", String(variable_name)) || continue
        for row in eachrow(PSI.read_variable(res, variable_name))
            value = Float64(row[:value])
            abs(value) > 1e-6 || continue
            push!(slacks, (
                variable = String(variable_name),
                element = string(row[:name]),
                value = value,
            ))
        end
    end

    parameters = [String(name) for name in PSI.list_parameter_names(res)]
    expressions = [String(name) for name in PSI.list_expression_names(res)]

    total_load_mw = 0.0
    PSY.with_units_base(sys, PSY.UnitSystem.SYSTEM_BASE) do
        for T in (PSY.PowerLoad, PSY.StandardLoad)
            for l in PSY.get_components(T, sys)
                total_load_mw += PSY.get_max_active_power(l) * base_mva
            end
        end
    end

    # Copper plate, DC and PTDF are lossless: what is dispatched is the load,
    # unless a slack variable made up the difference (reported in slacks). A
    # load the model left out would be dispatched as nothing, so a balance that
    # does not hold is an error, not an answer.
    slack_mw = sum((abs(row.value) for row in slacks); init = 0.0)
    if abs(total_dispatch_mw - total_load_mw) > 1e-6 * max(1.0, total_load_mw) && slack_mw == 0.0
        throw(ErrorException(
            "economic dispatch did not meet the load: $(total_dispatch_mw) MW dispatched " *
            "for $(total_load_mw) MW of load",
        ))
    end

    return TS._to_json((
        status = "completed",
        network_model = String(network_model),
        objective_per_h = objective_per_h,
        objective_check_per_h = objective_check_per_h,
        base_mva = base_mva,
        total_load_mw = total_load_mw,
        total_dispatch_mw = total_dispatch_mw,
        generators = generators,
        duals = duals_list,
        slacks = slacks,
        parameters = parameters,
        expressions = expressions,
        notes = notes,
    ))
end

end # module
