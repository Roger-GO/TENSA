# TensaSiennaOps.jl: the operations of TENSA's Sienna engine, with
# PowerSimulations (PSI), HiGHS and Ipopt. Included after TensaSienna.jl, and
# only when a session first asks for an operation, so a session that only
# solves power flows never loads PowerSimulations. It reaches the first
# module as Main.TensaSienna, which is where both files live when the tests
# and the Python worker include them into Main. The public function answers a
# JSON string.

module TensaSiennaOps

using PowerSystems
using PowerSimulations
using HiGHS
using Ipopt
using Dates
using JSON3
using Logging

const PSY = PowerSystems
const PSI = PowerSimulations

import Main.TensaSienna as TS

export dispatch_json, uc_json, apply_series!, sim_json

# The message of a case with no cost data. The Python side
# (tensa.engines.sienna.dispatch.NO_COST_DATA_MESSAGE) holds the same string
# and the route maps it to 422; the two copies are pinned together by the
# route test, which sends this exact text through the worker.
const NO_COST_DATA = "the case has no generator cost data; economic dispatch needs gencost records"

const NETWORK_MODELS = ("copper_plate", "dc", "ptdf", "ac")

# The network model type of a name.
function _network_model(name::AbstractString)
    name == "copper_plate" && return PSI.CopperPlatePowerModel
    name == "dc" && return PSI.DCPPowerModel
    name == "ptdf" && return PSI.PTDFPowerModel
    name == "ac" && return PSI.ACPPowerModel
    throw(ArgumentError("network_model must be copper_plate, dc, ptdf or ac, got $(name)"))
end

# The optimizer of a network model: HiGHS for the linear models, Ipopt for
# the AC model, which is nonlinear. Ipopt is run quiet; the tolerances are
# its defaults, which the hand checks' 1e-4 MW and 1e-6 pu sit well inside.
function _optimizer_for(network)
    network == PSI.ACPPowerModel && return PSI.optimizer_with_attributes(
        Ipopt.Optimizer,
        "print_level" => 0,
    )
    return HiGHS.Optimizer
end

# The quadratic, linear and constant coefficients of a generator's cost curve
# as PowerSystems holds it, or nothing when the generator has no curve of that
# shape. A MATPOWER gencost model 2 row is read by PowerSystems as a CostCurve
# of QuadraticCurve(a, b, 0) with the file's own numbers ($/MW^2h, $/MWh):
# the constant term is not in the curve (see `_cost_coefficients`).
function _curve_coefficients(g)
    cost = PSY.get_operation_cost(g)
    cost isa PSY.ThermalGenerationCost || return nothing
    variable = PSY.get_variable(cost)
    variable isa PSY.CostCurve || return nothing
    curve = PSY.get_value_curve(variable)
    curve isa PSY.QuadraticCurve || return nothing
    a = PSY.get_quadratic_term(curve)
    b = PSY.get_proportional_term(curve)
    c = PSY.get_constant_term(curve)
    return (a, b, c)
end

# The cost of a generator as the case file gives it: the quadratic and linear
# coefficients and the constant term c0 of a*P^2 + b*P + c0 ($/MW^2h, $/MWh,
# $/h), or nothing when the generator has no cost data. PowerSystems splits a
# MATPOWER polynomial: every term but the last goes into the curve and the
# last, c0, into ThermalGenerationCost.fixed (make_thermal_gen in
# PowerSystems' power_models_data.jl), so c0 is the curve's constant term
# plus `fixed`.
function _cost_coefficients(g)
    curve = _curve_coefficients(g)
    curve === nothing && return nothing
    a, b, c = curve
    c0 = c + Float64(PSY.get_fixed(PSY.get_operation_cost(g)))
    (a == 0.0 && b == 0.0 && c0 == 0.0) && return nothing
    return (a, b, c0)
end

# The cost of every thermal generator of a system, by component name, as
# `_cost_coefficients` reads it. Taken before an operation changes the copy's
# cost data, so the recomputed costs use the file's own numbers.
function _costs_by_name(sys)
    out = Dict{String, Union{Nothing, NTuple{3, Float64}}}()
    for g in PSY.get_components(PSY.ThermalStandard, sys)
        coefficients = _cost_coefficients(g)
        out[PSY.get_name(g)] = coefficients === nothing ? nothing : Float64.(coefficients)
    end
    return out
end

# Put each thermal generator's constant cost term on the copy as a cost per
# commitment step. PowerSimulations charges `get_fixed(cost)` and the curve's
# constant term once per step a unit is committed (`proportional_cost` for
# OnVariable in its thermal_generation.jl, with no step length), while it
# charges the energy terms times the step length in hours. A constant term is
# in $/h, so on a step of `step_h` hours it is c0 * step_h: the curve keeps
# its quadratic and linear terms and `fixed` becomes c0 * step_h, and the
# objective is then the true cost at any resolution. Called after
# `_costs_in_natural_units!`.
function _fixed_cost_per_step!(sys, step_h::Float64)
    for g in PSY.get_components(PSY.ThermalStandard, sys)
        coefficients = _cost_coefficients(g)
        coefficients === nothing && continue
        a, b, c0 = coefficients
        cost = PSY.get_operation_cost(g)
        old = PSY.get_variable(cost)
        PSY.set_variable!(
            cost,
            PSY.CostCurve(
                PSY.QuadraticCurve(a, b, 0.0),
                PSY.UnitSystem.NATURAL_UNITS,
                PSY.get_vom_cost(old),
            ),
        )
        PSY.set_fixed!(cost, c0 * step_h)
    end
    return nothing
end

# A fresh folder for one PowerSimulations build, inside the session's scratch
# folder (spec section 12: an engine writes only there), never the system's
# temporary directory. `_in_run_dir` removes it once the operation has read
# its results, whether it succeeded or not; `cleanup = true` is the fallback
# when Julia exits first.
_run_dir(s::TS.Session, prefix::AbstractString) =
    mktempdir(s.scratch; prefix = prefix * "-", cleanup = true)

# Call `f` with a fresh run folder and remove the folder afterwards. A folder
# that cannot be removed (a file still held open on Windows) is left to the
# `cleanup` of `_run_dir` and logged at debug level; it never fails the call.
function _in_run_dir(f, s::TS.Session, prefix::AbstractString)
    dir = _run_dir(s, prefix)
    try
        return f(dir)
    finally
        try
            rm(dir; recursive = true, force = true)
        catch e
            @debug "the run folder could not be removed" dir exception = e
        end
    end
end

# The operations rows of the case facts (the Python side's `generator_ops`,
# one per mpc.gen row in file order), keyed by the name PowerSystems gives the
# generator of each row: gen-<row of mpc.gen>, from the row's own `row` field
# or, for a row without one, its place in the list. A row whose name no
# component of the system has is left out.
function _ops_by_name(sys, ops)
    out = Dict{String, Any}()
    ops === nothing && return out
    for (i, row) in enumerate(ops)
        number = get(row, "row", nothing)
        number = number === nothing ? i : Int(number)
        name = "gen-$(number)"
        PSY.get_component(PSY.ThermalStandard, sys, name) === nothing && continue
        out[name] = row
    end
    return out
end

# A ramp field of an operations row as a number, or nothing.
function _ramp_field(row, field::AbstractString)
    row === nothing && return nothing
    value = get(row, field, nothing)
    value === nothing && return nothing
    return Float64(value)
end

# Set every thermal generator's ramp limit on the copy to the rate the case
# facts' operations row publishes in its `op` block (RAMP_AGC where the file
# gives it, else RAMP_10 / 10, in MW per minute; see
# tensa.engines.case_facts.matpower_ramp_mw_per_min), and no limit where the
# row gives none or there is no row. PowerSystems' own reading is not used: it
# takes the RAMP_AGC column whenever the column exists, so a RAMP_AGC of 0 (no
# data) becomes a limit of 0, and without the column it takes RAMP_10, in MW
# per 10 minutes, as MW per minute (calculate_ramp_limit in its common.jl).
function _ramps_as_published!(sys, ops)
    by_name = _ops_by_name(sys, ops)
    PSY.with_units_base(sys, PSY.UnitSystem.NATURAL_UNITS) do
        for g in PSY.get_components(PSY.ThermalStandard, sys)
            row = get(by_name, PSY.get_name(g), nothing)
            up = _ramp_field(row, "ramp_up_mw_per_min")
            down = _ramp_field(row, "ramp_down_mw_per_min")
            down === nothing && (down = up)
            if up === nothing || up <= 0.0 || down <= 0.0
                PSY.set_ramp_limits!(g, nothing)
            else
                PSY.set_ramp_limits!(g, (up = up, down = down))
            end
        end
    end
    return nothing
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
        coefficients = _curve_coefficients(g)
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

# The variable of a name, or nothing when the results do not hold it.
function _read_variable_or_nothing(res, name::AbstractString)
    String(name) in [String(n) for n in PSI.list_variable_names(res)] || return nothing
    return PSI.read_variable(res, name)
end

# The AC quantities of the solved model: bus voltages and angles, generator
# reactive power, branch flows at both ends and the losses. The variables are
# read from the optimization results, not from a power flow solved again. The
# variable keys are the ones a trial on this environment (PowerSimulations
# 0.34.2, ACPPowerModel) listed: VoltageAngle__ACBus and
# VoltageMagnitude__ACBus for the buses, ReactivePowerVariable__ThermalStandard
# for the generators, and FlowActivePowerFromToVariable__Line and its three
# counterparts (ToFrom, ReactivePowerFromTo, ReactivePowerToFrom) per branch
# type, the same four for __Transformer2W and __TapTransformer.
function _ac_quantities(res, sys, generators)
    names = Set(String(n) for n in PSI.list_variable_names(res))

    buses = Any[]
    if "VoltageMagnitude__ACBus" in names && "VoltageAngle__ACBus" in names
        magnitudes = PSI.read_variable(res, "VoltageMagnitude__ACBus")
        angles = PSI.read_variable(res, "VoltageAngle__ACBus")
        angle_of = Dict(String(row[:name]) => Float64(row[:value]) for row in eachrow(angles))
        for row in eachrow(magnitudes)
            name = String(row[:name])
            bus = PSY.get_component(PSY.ACBus, sys, name)
            bus === nothing && continue
            push!(buses, (
                name = name,
                bus = PSY.get_number(bus),
                v_pu = Float64(row[:value]),
                angle_rad = get(angle_of, name, 0.0),
            ))
        end
    else
        throw(ErrorException("the AC results hold no bus voltage variables"))
    end
    sort!(buses; by = x -> x.bus)

    # Generator reactive power, matched to the dispatch rows by name.
    q_of = Dict{String, Float64}()
    if "ReactivePowerVariable__ThermalStandard" in names
        for row in eachrow(PSI.read_variable(res, "ReactivePowerVariable__ThermalStandard"))
            q_of[String(row[:name])] = Float64(row[:value])
        end
    end

    # Every branch type the results hold the four flows of: Line,
    # Transformer2W (a MATPOWER branch whose ratio is exactly 1.0, or 0 with a
    # shift of 0 marked a transformer), TapTransformer and any other the
    # template models. The type is read off the variable key's suffix.
    branch_types = Any[]
    for name in names
        m = match(r"^FlowActivePowerFromToVariable__(\w+)$", name)
        m === nothing && continue
        tag = String(m.captures[1])
        isdefined(PSY, Symbol(tag)) || continue
        T = getfield(PSY, Symbol(tag))
        T isa Type && T <: PSY.ACBranch || continue
        push!(branch_types, (T, tag))
    end
    sort!(branch_types; by = last)

    branches = Any[]
    total_losses_mw = 0.0
    for (T, tag) in branch_types
        keys = (
            "FlowActivePowerFromToVariable__$(tag)",
            "FlowActivePowerToFromVariable__$(tag)",
            "FlowReactivePowerFromToVariable__$(tag)",
            "FlowReactivePowerToFromVariable__$(tag)",
        )
        all(k -> k in names, keys) || continue
        p_from = PSI.read_variable(res, keys[1])
        p_to = PSI.read_variable(res, keys[2])
        q_from = PSI.read_variable(res, keys[3])
        q_to = PSI.read_variable(res, keys[4])
        p_to_of = Dict(String(row[:name]) => Float64(row[:value]) for row in eachrow(p_to))
        q_from_of = Dict(String(row[:name]) => Float64(row[:value]) for row in eachrow(q_from))
        q_to_of = Dict(String(row[:name]) => Float64(row[:value]) for row in eachrow(q_to))
        for row in eachrow(p_from)
            name = String(row[:name])
            br = PSY.get_component(T, sys, name)
            br === nothing && continue
            f, t = TS._arc_numbers(br)
            pf = Float64(row[:value])
            pt = get(p_to_of, name, 0.0)
            qf = get(q_from_of, name, 0.0)
            qt = get(q_to_of, name, 0.0)
            losses_mw = pf + pt
            total_losses_mw += losses_mw
            push!(branches, (
                name = name,
                from = f,
                to = t,
                ckt = TS._branch_ckt(name),
                p_from_mw = pf,
                q_from_mvar = qf,
                p_to_mw = pt,
                q_to_mvar = qt,
                losses_mw = losses_mw,
                losses_mvar = qf + qt,
            ))
        end
    end
    sort!(branches; by = x -> (x.from, x.to, x.ckt, x.name))
    return buses, branches, q_of, total_losses_mw
end

# The bus shunts of a system (FixedAdmittance and SwitchedAdmittance that are
# available), as "<name> at bus <number>". PowerSimulations' AC model hands
# PowerModels an empty shunt table (`"shunt" => Dict()` in its
# pm_translator.jl) and has no device model for either type, so an AC
# dispatch leaves them out; the answer says which.
function _bus_shunts(sys)
    out = String[]
    for T in (PSY.FixedAdmittance, PSY.SwitchedAdmittance)
        for c in PSY.get_components(T, sys)
            PSY.get_available(c) || continue
            push!(out, "$(PSY.get_name(c)) at bus $(PSY.get_number(PSY.get_bus(c)))")
        end
    end
    return sort!(out)
end

"""
    dispatch_json(s::TS.Session; network_model, duals = false) -> String

Solve the one-period economic dispatch of the loaded case. `network_model` is
"copper_plate", "dc", "ptdf" or "ac". The system is deep-copied first: the
one-step forecast every load needs, the relabelled cost curves and the ramp
limits taken off (one period has nothing to ramp from) go to the copy, never
to the session's system. The cost curves are labelled as natural units on the
copy so that the objective is the true cost in \$/h of power in MW (see
`_costs_in_natural_units!`). The linear models solve with HiGHS; the AC model
holds the full AC power flow equations and solves with Ipopt.

The answer carries `objective_check_per_h`, the cost of the dispatch as
MATPOWER counts it: a * P^2 + b * P + c0 of every dispatched generator, from
the dispatch in MW and the file's own coefficients, the constant term c0
included for every unit, since in a dispatch every available unit is on.
`fixed_per_h` is the sum of those c0. `objective_per_h` is the solver's
objective, in \$/h, which has no constant term: PowerSystems keeps c0 out of
the curve (in ThermalGenerationCost.fixed) and PowerSimulations' dispatch
formulation charges `fixed` only through a commitment variable, which a
dispatch has none of. So `objective_per_h + fixed_per_h` equals
`objective_check_per_h` to solver tolerance. `generators`
lists every dispatched generator with its bus, id and MW. With
`network_model = "ac"` the answer also carries `buses` (voltage in pu and
angle in radians per bus), `branches` (P and Q at both ends and the losses,
in MW and MVAr), each generator's `q_mvar`, and `total_losses_mw`; the load
balance is dispatch against load plus losses, since the AC model is not
lossless. The AC model leaves bus shunts out (PowerSimulations hands
PowerModels no shunt table), so an AC dispatch of a case with fixed or
switched shunts carries a warning note naming them. `slacks` lists every
slack variable whose value is past 1e-6 MW (spec section 13: slack variables
always read back and reported when non-zero). `duals` is empty unless
`duals` is true; the copper plate model has no duals, the dc and ptdf models
may. The build's folder under the session's scratch folder is removed before
the answer is returned.

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
    return _in_run_dir(s, "ed") do dir
        _dispatch_json(s, dir, network, network_model, duals)
    end
end

function _dispatch_json(
    s::TS.Session,
    dir::AbstractString,
    network,
    network_model::AbstractString,
    duals::Bool,
)::String
    sys = deepcopy(s.sys)
    base_mva = PSY.get_base_power(sys)
    costs = _costs_by_name(sys)

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
            optimizer = _optimizer_for(network),
            horizon = Hour(1),
            name = "tensa_ed",
            store_variable_names = true,
        )
        # Spec section 12: simulation files only under the session's scratch.
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
    shunts = network == PSI.ACPPowerModel ? _bus_shunts(sys) : String[]
    if !isempty(shunts)
        push!(notes, Dict{String, Any}(
            "level" => "warning",
            "text" => "PowerSimulations' AC model leaves bus shunts out of the " *
                      "optimization; the dispatch is solved without " *
                      join(shunts, ", "),
        ))
    end

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

    # The AC quantities, only for the AC model: bus voltages and angles,
    # generator reactive power, branch flows and losses. The linear models'
    # answers are unchanged, field for field.
    is_ac = network == PSI.ACPPowerModel
    buses = Any[]
    branches = Any[]
    total_losses_mw = 0.0
    if is_ac
        buses, branches, q_of, total_losses_mw = _ac_quantities(res, sys, generators)
        generators = [
            merge(row, (q_mvar = get(q_of, row.name, 0.0),)) for row in generators
        ]
    end

    # The cost recomputed from the dispatch in MW and the file's own
    # coefficients, as MATPOWER counts it: a * P_mw^2 + b * P_mw + c0 of every
    # dispatched unit (every available unit is on in a dispatch).
    objective_check_per_h = 0.0
    fixed_per_h = 0.0
    for row in generators
        coefficients = get(costs, row.name, nothing)
        coefficients === nothing && continue
        a, b, c0 = coefficients
        objective_check_per_h += a * row.p_mw^2 + b * row.p_mw + c0
        fixed_per_h += c0
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
    # unless a slack variable made up the difference (reported in slacks). The
    # AC model is not lossless: what is dispatched is the load plus the
    # losses. A load the model left out would be dispatched as nothing, so a
    # balance that does not hold is an error, not an answer.
    slack_mw = sum((abs(row.value) for row in slacks); init = 0.0)
    if is_ac
        if abs(total_dispatch_mw - total_load_mw - total_losses_mw) > 1e-6 * max(1.0, total_load_mw) && slack_mw == 0.0
            throw(ErrorException(
                "economic dispatch did not meet the load: $(total_dispatch_mw) MW dispatched " *
                "for $(total_load_mw) MW of load and $(total_losses_mw) MW of losses",
            ))
        end
    elseif abs(total_dispatch_mw - total_load_mw) > 1e-6 * max(1.0, total_load_mw) && slack_mw == 0.0
        throw(ErrorException(
            "economic dispatch did not meet the load: $(total_dispatch_mw) MW dispatched " *
            "for $(total_load_mw) MW of load",
        ))
    end

    answer = (
        status = "completed",
        network_model = String(network_model),
        objective_per_h = objective_per_h,
        objective_check_per_h = objective_check_per_h,
        fixed_per_h = fixed_per_h,
        base_mva = base_mva,
        total_load_mw = total_load_mw,
        total_dispatch_mw = total_dispatch_mw,
        generators = generators,
        duals = duals_list,
        slacks = slacks,
        parameters = parameters,
        expressions = expressions,
        notes = notes,
    )
    if is_ac
        answer = merge(answer, (
            buses = buses,
            branches = branches,
            total_losses_mw = total_losses_mw,
        ))
    end
    return TS._to_json(answer)
end

# The message of a request whose series block does not fit the case or the
# horizon.
const UC_BAD_SERIES = "the series block must give one positive finite factor per period"

# Set every generator's initial state to off: MATPOWER carries no commitment
# state, and the unit's rule is that a generator on in the first period pays
# its start-up.
function _initial_state_off!(sys)
    for g in PSY.get_components(PSY.ThermalStandard, sys)
        PSY.set_status!(g, false)
        PSY.set_active_power!(g, 0.0)
        PSY.set_time_at_status!(g, 10000.0)
    end
    return nothing
end

# Apply the per-generator overrides: a JSON object keyed by component name,
# values objects with optional fields startup_cost, min_up_h, min_down_h,
# must_run. Answer the names that matched no generator (the caller throws).
function _apply_uc_overrides!(sys, overrides_json::AbstractString)
    overrides = JSON3.read(overrides_json)
    missed = String[]
    for (name_key, fields) in overrides
        name = String(name_key)
        g = PSY.get_component(PSY.ThermalStandard, sys, name)
        if g === nothing
            push!(missed, name)
            continue
        end
        cost = PSY.get_operation_cost(g)
        for (field, value) in fields
            field = String(field)
            if field == "startup_cost"
                cost isa PSY.ThermalGenerationCost &&
                    PSY.set_start_up!(cost, Float64(value))
            elseif field == "min_up_h"
                limits = PSY.get_time_limits(g)
                down = limits === nothing ? 0.0 : Float64(limits.down)
                PSY.set_time_limits!(g, (up = Float64(value), down = down))
            elseif field == "min_down_h"
                limits = PSY.get_time_limits(g)
                up = limits === nothing ? 0.0 : Float64(limits.up)
                PSY.set_time_limits!(g, (up = up, down = Float64(value)))
            elseif field == "must_run"
                value == true && PSY.set_must_run!(g, true)
            end
        end
    end
    return missed
end

# The cost of one generator over the horizon, split into energy (the
# quadratic and linear terms at the dispatched MW, times the step length in
# hours: the curve is in $/h), start-up (one start per period the generator
# comes on, the initial state being off, at the copy's start-up cost) and
# fixed (the constant term c0, in $/h, per committed step times the step
# length). `coefficients` is the file's (a, b, c0), taken before the copy's
# cost data was changed.
function _commitment_cost_parts(g, coefficients, on::Vector{Float64}, p_mw::Vector{Float64}, step_h::Float64)
    coefficients === nothing && return (energy = 0.0, startup = 0.0, fixed = 0.0)
    a, b, c0 = coefficients
    energy = step_h * sum((a * p^2 + b * p for p in p_mw); init = 0.0)
    fixed = c0 * step_h * count(==(1.0), on)
    starts = count(t -> on[t] == 1.0 && (t == 1 || on[t - 1] == 0.0), 1:length(on))
    startup = Float64(PSY.get_start_up(PSY.get_operation_cost(g))) * starts
    return (energy = energy, startup = startup, fixed = fixed)
end

"""
    uc_json(s::TS.Session; network_model, horizon_h, resolution_min, series_json, overrides_json, ops_json) -> String

Solve the unit commitment of the loaded case: `template_unit_commitment` over
`horizon_h` hours at a resolution of `resolution_min` minutes, with HiGHS at
a MIP gap of 1e-9, on a deep copy of the system. `series_json` is a JSON
array of one positive factor per period; the Python side lists every load of
the case with those factors in the series payload. `overrides_json` is a
JSON object of per-generator additions (start-up cost, minimum up and down
times, must-run) keyed by component name. `ops_json` carries the case facts'
operations rows (`generator_ops`, one per mpc.gen row), whose ramp rate is
set on the copy (`_ramps_as_published!`), so the commitment enforces the
ramp the `op` block publishes. The start-up cost is the gencost row's
STARTUP column, which PowerSystems carries into
ThermalGenerationCost.start_up, unless an override replaces it. Every
generator starts off, so one committed in the first period pays a start-up.

The answer lists, per period, each generator's on/off and MW, the cost split
into energy (the quadratic and linear terms times the step length), start-up
and fixed (the gencost constant term c0, in \$/h, per committed step times
the step length), and every slack variable past 1e-6 MW. `objective` is the
solver's: the constant term is put on the copy as c0 times the step length
per committed step (`_fixed_cost_per_step!`), so it equals `objective_check`
to solver tolerance, except that PowerSimulations leaves the constant term of
a must-run unit out of its objective, which `objective_check` keeps. The
build's folder under the session's scratch folder is removed before the
answer is returned.
"""
function uc_json(
    s::TS.Session;
    network_model::AbstractString,
    horizon_h::Int,
    resolution_min::Int,
    series_json::AbstractString,
    overrides_json::AbstractString,
    ops_json::AbstractString = "null",
)::String
    network = _network_model(network_model)
    return _in_run_dir(s, "uc") do dir
        _uc_json(
            s, dir, network, network_model, horizon_h, resolution_min,
            series_json, overrides_json, ops_json,
        )
    end
end

function _uc_json(
    s::TS.Session,
    dir::AbstractString,
    network,
    network_model::AbstractString,
    horizon_h::Int,
    resolution_min::Int,
    series_json::AbstractString,
    overrides_json::AbstractString,
    ops_json::AbstractString,
)::String
    sys = deepcopy(s.sys)
    base_mva = PSY.get_base_power(sys)
    costs = _costs_by_name(sys)
    step_h = resolution_min / 60

    factors = JSON3.read(series_json, Vector{Float64})
    n = length(factors)
    if n * resolution_min != horizon_h * 60 || any(f -> !isfinite(f) || f <= 0.0, factors)
        bad = findfirst(f -> !isfinite(f) || f <= 0.0, factors)
        throw(ArgumentError(
            UC_BAD_SERIES * ": got $(n) factor(s) over $(horizon_h) hours at " *
            "$(resolution_min) minutes" *
            (bad === nothing ? "" : ", factor $(factors[bad]) at period $(bad)"),
        ))
    end

    has_cost = any(
        g -> _cost_coefficients(g) !== nothing,
        PSY.get_components(PSY.ThermalStandard, sys),
    )
    has_cost || throw(ErrorException(NO_COST_DATA))

    _costs_in_natural_units!(sys)
    _fixed_cost_per_step!(sys, step_h)

    # The ramp the op block publishes, in MW per minute; no limit where it
    # publishes none.
    _ramps_as_published!(sys, JSON3.read(ops_json))

    # Every generator starts off, so one committed in the first period pays
    # its start-up (MATPOWER carries no commitment state).
    _initial_state_off!(sys)

    missed = _apply_uc_overrides!(sys, overrides_json)
    isempty(missed) || throw(ArgumentError("no generator named " * join(missed, ", ")))

    # The load profile, through the operations data's own mechanism: every
    # load of the case listed with the request's factors, one forecast window
    # over the whole profile.
    resolution = Second(resolution_min * 60)
    loads = Any[]
    for T in (PSY.PowerLoad, PSY.StandardLoad)
        for l in PSY.get_components(T, sys)
            push!(loads, Dict("name" => PSY.get_name(l), "factors" => factors))
        end
    end
    payload = Dict(
        "start" => "2026-01-01T00:00:00",
        "resolution_s" => resolution_min * 60,
        "steps" => n,
        "loads" => loads,
    )
    apply_series!(sys, JSON3.write(payload))

    logger = TS._NoteLogger()
    res = Logging.with_logger(logger) do
        # The keyword is `network`: the template takes any keyword and keeps
        # the copper plate for one it does not know, so the model is checked.
        template = PSI.template_unit_commitment(; network = PSI.NetworkModel(network))
        # The template's ThermalBasicUnitCommitment has no minimum up and down
        # times; ThermalStandardUnitCommitment holds a generator's time_limits.
        PSI.set_device_model!(template, PSY.ThermalStandard, PSI.ThermalStandardUnitCommitment)
        PSI.get_network_model(template) isa PSI.NetworkModel{network} || throw(
            ErrorException("unit commitment was built without the $(network_model) network model"),
        )
        # The template models PowerLoad alone; a case read from PSS/E holds
        # StandardLoad, which would otherwise be left out of the balance.
        PSI.set_device_model!(template, PSY.StandardLoad, PSI.StaticPowerLoad)
        model = PSI.DecisionModel(
            template,
            sys;
            optimizer = PSI.optimizer_with_attributes(
                HiGHS.Optimizer,
                "mip_rel_gap" => 1e-9,
            ),
            horizon = Hour(horizon_h),
            resolution = Minute(resolution_min),
            name = "tensa_uc",
            store_variable_names = true,
        )
        # Spec section 12: simulation files only under the session's scratch.
        built = PSI.build!(model; output_dir = dir)
        built == PSI.ModelBuildStatus.BUILT || throw(
            ErrorException("unit commitment did not build: $(built)"),
        )
        solved = PSI.solve!(model)
        solved == PSI.RunStatus.SUCCESSFULLY_FINALIZED || throw(
            ErrorException("unit commitment did not solve: $(solved)"),
        )
        PSI.OptimizationProblemResults(model)
    end
    notes = [
        Dict{String, Any}("level" => TS._level_name(l), "text" => TS._scrub(t, (s.raw, s.dyr))) for
        (l, t) in logger.records
    ]

    objective = PSI.get_objective_value(res)

    t0 = DateTime("2026-01-01T00:00:00")
    periods = [string(t0 + resolution * k) for k in 0:(n - 1)]

    # The commitment and the dispatch, per period and generator. The on/off
    # variable is binary; a value not within 1e-3 of an integer means HiGHS
    # solved the relaxation, which is an error, not an answer.
    power = PSI.read_variable(res, "ActivePowerVariable__ThermalStandard")
    commitment = PSI.read_variable(res, "OnVariable__ThermalStandard")
    p_of = Dict{Tuple{String, String}, Float64}()
    for row in eachrow(power)
        p_of[(String(row[:name]), string(row[:DateTime]))] = Float64(row[:value])
    end
    on_of = Dict{Tuple{String, String}, Float64}()
    for row in eachrow(commitment)
        name = String(row[:name])
        stamp = string(row[:DateTime])
        value = Float64(row[:value])
        rounded = round(value)
        abs(value - rounded) <= 1e-3 || throw(ErrorException(
            "the commitment is not integral: $(name) in period $(stamp) is $(value)",
        ))
        on_of[(name, stamp)] = rounded
    end

    generators = Any[]
    cost_energy = 0.0
    cost_startup = 0.0
    cost_fixed = 0.0
    for g in PSY.get_components(PSY.ThermalStandard, sys)
        name = PSY.get_name(g)
        bus = PSY.get_number(PSY.get_bus(g))
        on = [get(on_of, (name, periods[t]), 0.0) for t in 1:n]
        p_mw = [get(p_of, (name, periods[t]), 0.0) for t in 1:n]
        parts = _commitment_cost_parts(g, get(costs, name, nothing), on, p_mw, step_h)
        cost_energy += parts.energy
        cost_startup += parts.startup
        cost_fixed += parts.fixed
        push!(generators, (
            name = name,
            bus = bus,
            id = TS._generator_id(name, bus),
            on = [v == 1.0 for v in on],
            p_mw = p_mw,
            energy = parts.energy,
            startup = parts.startup,
            fixed = parts.fixed,
        ))
    end
    sort!(generators; by = x -> (x.bus, x.id, x.name))

    # Slack variables past 1e-6 MW, with the period of each.
    slacks = Any[]
    for variable_name in PSI.list_variable_names(res)
        occursin("Slack", String(variable_name)) || continue
        for row in eachrow(PSI.read_variable(res, variable_name))
            value = Float64(row[:value])
            abs(value) > 1e-6 || continue
            push!(slacks, (
                variable = String(variable_name),
                element = string(row[:name]),
                time = string(row[:DateTime]),
                value = value,
            ))
        end
    end

    parameters = [String(name) for name in PSI.list_parameter_names(res)]
    expressions = [String(name) for name in PSI.list_expression_names(res)]

    base_load_mw = 0.0
    PSY.with_units_base(sys, PSY.UnitSystem.SYSTEM_BASE) do
        for T in (PSY.PowerLoad, PSY.StandardLoad)
            for l in PSY.get_components(T, sys)
                base_load_mw += PSY.get_max_active_power(l) * base_mva
            end
        end
    end
    total_load_mw = [base_load_mw * factors[t] for t in 1:n]

    # The dispatch must meet the load in every period, unless a slack
    # variable made up the difference (reported in slacks).
    slack_by_period = Dict{String, Float64}()
    for row in slacks
        slack_by_period[row.time] = get(slack_by_period, row.time, 0.0) + abs(row.value)
    end
    for t in 1:n
        dispatched = sum(row.p_mw[t] for row in generators)
        if abs(dispatched - total_load_mw[t]) > 1e-6 * max(1.0, total_load_mw[t]) &&
           get(slack_by_period, periods[t], 0.0) == 0.0
            throw(ErrorException(
                "unit commitment did not meet the load in period $(t): " *
                "$(dispatched) MW dispatched for $(total_load_mw[t]) MW of load",
            ))
        end
    end

    cost_total = cost_energy + cost_startup + cost_fixed
    return TS._to_json((
        status = "completed",
        network_model = String(network_model),
        horizon_h = horizon_h,
        resolution_min = resolution_min,
        periods = periods,
        base_mva = base_mva,
        objective = objective,
        objective_check = cost_total,
        cost = (
            energy = cost_energy,
            startup = cost_startup,
            fixed = cost_fixed,
            total = cost_total,
        ),
        total_load_mw = total_load_mw,
        generators = generators,
        slacks = slacks,
        parameters = parameters,
        expressions = expressions,
        notes = notes,
    ))
end

"""
    apply_series!(sys, payload_json) -> Nothing

Apply a series block's load profiles to a system (always the deep copy the op
made). `payload_json` is a JSON string with `start` (ISO 8601), `resolution_s`,
`steps`, and `loads`, a list of `name` plus `factors`. Every listed load gets
a SingleTimeSeries named "max_active_power" whose values are the factors, with
`scaling_factor_multiplier = PSY.get_max_active_power`, and
`transform_single_time_series!` shapes the horizon. Loads not listed keep no
time series (factor 1.0).
"""
function apply_series!(sys, payload_json::AbstractString)
    payload = JSON3.read(payload_json)
    t0 = DateTime(payload[:start])
    resolution = Second(round(Int, payload[:resolution_s]))
    steps = Int(payload[:steps])
    
    for entry in payload[:loads]
        name = String(entry[:name])
        factors = Float64.(entry[:factors])
        
        # Try both PowerLoad and StandardLoad
        load = PSY.get_component(PSY.PowerLoad, sys, name)
        if load === nothing
            load = PSY.get_component(PSY.StandardLoad, sys, name)
        end
        load === nothing && throw(ErrorException("series profile references $(name), which no load of the case has"))
        
        data = PSY.TimeSeries.TimeArray(t0 .+ resolution .* (0:steps-1), factors)
        ts = PSY.SingleTimeSeries(;
            name = "max_active_power",
            data = data,
            scaling_factor_multiplier = PSY.get_max_active_power,
        )
        PSY.add_time_series!(sys, load, ts)
    end
    
    # One forecast window over the whole profile: a model that spans the
    # profile's steps reads every period of it.
    horizon = resolution * steps
    PSY.transform_single_time_series!(sys, horizon, horizon)
    return nothing
end

# The message of a load profile whose length is not 96. The Python side
# (tensa.engines.sienna.sim.BAD_PROFILE_MESSAGE) holds the same string; the
# Python check fires first for requests over the wire.
const BAD_PROFILE = "load_profile must hold 96 numbers, one per 15-minute step of the day"

# The cost of one stage over the day, recomputed from its dispatch in MW and
# the file's own coefficients, as uc_json's objective_check is
# (`_commitment_cost_parts`): the quadratic and linear terms at the dispatched
# MW times the step length, the constant term c0 per committed step times the
# step length, and one start-up per period the generator comes on (the
# initial state being off). `on` is the commitment per stage step (nothing
# for the real-time stage, whose cost has no start-up or fixed part: the
# commitment is the day-ahead stage's), `p_mw` the dispatch per step,
# `step_h` the step length in hours, `coefficients` the file's (a, b, c0).
function _stage_cost(g, coefficients, on, p_mw::Vector{Float64}, step_h::Float64)
    coefficients === nothing && return 0.0
    if on === nothing
        a, b, _ = coefficients
        return step_h * sum((a * p^2 + b * p for p in p_mw); init = 0.0)
    end
    parts = _commitment_cost_parts(g, coefficients, on, p_mw, step_h)
    return parts.energy + parts.fixed + parts.startup
end

"""
    sim_json(s::TS.Session; load_profile, network_model = "copper_plate") -> String

Run the two-stage simulation of the loaded case: a day-ahead unit commitment
at hourly resolution over the day (the `uc_json` model:
`template_unit_commitment` with `ThermalStandardUnitCommitment`, the ramp
rates the `op` block publishes and the constant cost term per committed step
set on the copy, every unit starting off), then a real-time economic
dispatch at 15 minutes (the `dispatch_json` model:
`template_economic_dispatch`) held to that commitment through a
`SemiContinuousFeedforward` on `OnVariable`, one simulation step over the
day. `load_profile` is 96 fractions of each load's `max_active_power`, one
per 15-minute step of the day (1.0 is the case's load); the day-ahead stage's
hourly value at hour h is the mean of the four quarter-hours, which is what
`transform_single_time_series!` makes of the 15-minute series at hourly
resolution. The system is deep-copied first: the time series, the relabelled
cost curves, the ramp rates and the initial state go to the copy, never to
the session's system. `ops_json` is the case facts' operations rows, as for
`uc_json`.

The answer lists, per stage and per period, each generator's on/off
(day-ahead) and MW, the cost of each stage recomputed from its dispatch and
the file's own gencost coefficients (the day-ahead stage's with its start-up
costs and the gencost constant term c0 per committed hour), and every slack
variable past 1e-6 MW with its step. Times are implicit: step i of DA is hour i - 1 of the day from
2026-01-01T00:00:00, step j of RT is 15 minutes times j - 1; the Python side
reconstructs timestamps from `resolution_minutes` and that fixed start date.
The simulation's store goes in a fresh folder `sim-<stamp>` inside the
session's scratch folder (spec section 12) and is removed once the results
are read, or once the build or the solve has failed.

Throws an `ArgumentError` for a bad profile or network model, an
`ErrorException` with the no-cost-data message when no generator of the case
has cost data, and an `ErrorException` whose message starts with the stage
name for a build, solve or balance failure.
"""
function sim_json(
    s::TS.Session;
    load_profile::AbstractVector,
    network_model::AbstractString = "copper_plate",
    ops_json::AbstractString = "null",
)::String
    # From Python the profile arrives as a PyList; the numbers are copied out.
    load_profile = Float64[Float64(v) for v in load_profile]
    length(load_profile) == 96 || throw(ArgumentError(BAD_PROFILE))
    bad = findfirst(v -> !isfinite(v) || v < 0.0, load_profile)
    bad === nothing || throw(
        ArgumentError("load_profile entries must be finite numbers >= 0, " *
                    "got $(load_profile[bad]) at step $(bad)"),
    )
    network = _network_model(network_model)
    return _in_run_dir(s, "sim") do out_dir
        _sim_json(s, out_dir, load_profile, network, network_model, ops_json)
    end
end

function _sim_json(
    s::TS.Session,
    out_dir::AbstractString,
    load_profile::Vector{Float64},
    network,
    network_model::AbstractString,
    ops_json::AbstractString,
)::String
    sys = deepcopy(s.sys)
    base_mva = PSY.get_base_power(sys)
    costs = _costs_by_name(sys)

    has_cost = any(
        g -> _cost_coefficients(g) !== nothing,
        PSY.get_components(PSY.ThermalStandard, sys),
    )
    has_cost || throw(ErrorException(NO_COST_DATA))

    _costs_in_natural_units!(sys)
    # The day-ahead stage commits by the hour; the real-time stage has no
    # commitment variable and so no constant term.
    _fixed_cost_per_step!(sys, 1.0)

    # The ramp the op block publishes, in MW per minute; no limit where it
    # publishes none.
    _ramps_as_published!(sys, JSON3.read(ops_json))

    # Every generator starts off, so one committed in the first hour pays a
    # start-up (MATPOWER carries no commitment state).
    _initial_state_off!(sys)

    # The load profile as two time series of every load, one per stage, as
    # PowerSimulations' own two-stage test sets them up: the day-ahead
    # stage's hourly series, each hour the mean of its four quarter-hours,
    # given for two days (the day repeated: a single forecast window is stored
    # with an interval of zero, which no model can name, so the series holds
    # two windows 24 hours apart; the one simulation step reads the first),
    # and the real-time stage's 15-minute
    # series (the 96 steps and three more, the last repeated, so the one-hour
    # window that starts at 23:45 is whole). Both are scaled by the load's
    # max_active_power, and each is turned into forecasts at its own
    # resolution and interval; a model names the resolution it reads.
    t0 = DateTime("2026-01-01T00:00:00")
    day = [sum(load_profile[(4 * h - 3):(4 * h)]) / 4 for h in 1:24]
    hourly = vcat(day, day)
    quarter = vcat(load_profile, fill(load_profile[end], 3))
    for T in (PSY.PowerLoad, PSY.StandardLoad)
        for l in collect(PSY.get_components(T, sys))
            for (step, values) in ((Hour(1), hourly), (Minute(15), quarter))
                data = PSY.TimeSeries.TimeArray(t0 .+ step .* (0:(length(values) - 1)), values)
                PSY.add_time_series!(sys, l, PSY.SingleTimeSeries(;
                    name = "max_active_power",
                    data = data,
                    scaling_factor_multiplier = PSY.get_max_active_power,
                ))
            end
        end
    end
    PSY.transform_single_time_series!(sys, Hour(24), Hour(24); resolution = Hour(1))
    PSY.transform_single_time_series!(
        sys, Hour(1), Minute(15); resolution = Minute(15), delete_existing = false,
    )

    logger = TS._NoteLogger()
    store_name = basename(out_dir)
    results = Logging.with_logger(logger) do
        # The keyword is `network`: the template takes any keyword and keeps
        # the copper plate for one it does not know, so the model is checked.
        template_uc = PSI.template_unit_commitment(; network = PSI.NetworkModel(network))
        PSI.set_device_model!(template_uc, PSY.ThermalStandard, PSI.ThermalStandardUnitCommitment)
        PSI.get_network_model(template_uc) isa PSI.NetworkModel{network} || throw(
            ErrorException("unit commitment was built without the $(network_model) network model"),
        )
        # The template models PowerLoad alone; a case read from PSS/E holds
        # StandardLoad, which would otherwise be left out of the balance.
        PSI.set_device_model!(template_uc, PSY.StandardLoad, PSI.StaticPowerLoad)

        template_rt = PSI.template_economic_dispatch(; network = PSI.NetworkModel(network))
        PSI.get_network_model(template_rt) isa PSI.NetworkModel{network} || throw(
            ErrorException("economic dispatch was built without the $(network_model) network model"),
        )
        PSI.set_device_model!(template_rt, PSY.StandardLoad, PSI.StaticPowerLoad)

        models = PSI.SimulationModels(;
            decision_models = [
                PSI.DecisionModel(
                    template_uc,
                    sys;
                    name = "DA",
                    optimizer = PSI.optimizer_with_attributes(
                        HiGHS.Optimizer,
                        "mip_rel_gap" => 1e-9,
                    ),
                    horizon = Hour(24),
                    interval = Hour(24),
                    resolution = Hour(1),
                    store_variable_names = true,
                ),
                PSI.DecisionModel(
                    template_rt,
                    sys;
                    name = "RT",
                    optimizer = HiGHS.Optimizer,
                    horizon = Hour(1),
                    interval = Minute(15),
                    resolution = Minute(15),
                    store_variable_names = true,
                ),
            ],
        )
        # The real-time stage is held to the day-ahead commitment: a
        # generator the day-ahead stage has off runs at 0 MW.
        feedforwards = Dict(
            "RT" => [PSI.SemiContinuousFeedforward(;
                component_type = PSY.ThermalStandard,
                source = PSI.OnVariable,
                affected_values = [PSI.ActivePowerVariable],
            )],
        )
        sequence = PSI.SimulationSequence(;
            models = models,
            feedforwards = feedforwards,
            ini_cond_chronology = PSI.InterProblemChronology(),
        )
        sim = PSI.Simulation(;
            name = "tensa_sim",
            steps = 1,
            models = models,
            sequence = sequence,
            initial_time = t0,
            simulation_folder = out_dir,
        )
        built = PSI.build!(sim)
        built == PSI.SimulationBuildStatus.BUILT || throw(
            ErrorException("the simulation did not build: $(built)"),
        )
        executed = PSI.execute!(sim; enable_progress_bar = false)
        executed == PSI.RunStatus.SUCCESSFULLY_FINALIZED || throw(
            ErrorException("the simulation did not solve: $(executed)"),
        )
        PSI.SimulationResults(sim)
    end
    notes = [
        Dict{String, Any}("level" => TS._level_name(l), "text" => TS._scrub(t, (s.raw, s.dyr))) for
        (l, t) in logger.records
    ]

    base_load_mw = 0.0
    PSY.with_units_base(sys, PSY.UnitSystem.SYSTEM_BASE) do
        for T in (PSY.PowerLoad, PSY.StandardLoad)
            for l in PSY.get_components(T, sys)
                base_load_mw += PSY.get_max_active_power(l) * base_mva
            end
        end
    end

    # The realized series of one variable of one stage, keyed by component
    # name: a vector of one value per step of the day. `read_realized_variable`
    # answers one long table over every step of the stage.
    function realized(res, variable::AbstractString, steps::Int)
        table = sort(PSI.read_realized_variable(res, variable), :DateTime)
        out = Dict{String, Vector{Float64}}()
        for row in eachrow(table)
            name = String(row[:name])
            series = get!(out, name, Float64[])
            push!(series, Float64(row[:value]))
        end
        for (name, series) in out
            length(series) == steps || throw(ErrorException(
                "the $(variable) results of $(name) hold $(length(series)) " *
                "steps, not $(steps)",
            ))
        end
        return out
    end

    slacks = Any[]
    function read_slacks(res, stage::AbstractString)
        for variable_name in PSI.list_variable_names(res)
            occursin("Slack", String(variable_name)) || continue
            for row in eachrow(PSI.read_realized_variable(res, String(variable_name)))
                value = Float64(row[:value])
                abs(value) > 1e-6 || continue
                push!(slacks, (
                    variable = String(variable_name),
                    element = string(row[:name]),
                    time = string(row[:DateTime]),
                    value = value,
                ))
            end
        end
        return nothing
    end

    results_da = PSI.get_decision_problem_results(results, "DA")
    results_rt = PSI.get_decision_problem_results(results, "RT")

    on_da = realized(results_da, "OnVariable__ThermalStandard", 24)
    p_da = realized(results_da, "ActivePowerVariable__ThermalStandard", 24)
    p_rt = realized(results_rt, "ActivePowerVariable__ThermalStandard", 96)
    read_slacks(results_da, "DA")
    read_slacks(results_rt, "RT")

    # The commitment must be integral; a value not within 1e-3 of an
    # integer means HiGHS solved the relaxation, which is an error.
    for (name, series) in on_da
        for (t, value) in enumerate(series)
            rounded = round(value)
            abs(value - rounded) <= 1e-3 || throw(ErrorException(
                "the commitment is not integral: $(name) in hour $(t) is $(value)",
            ))
            series[t] = rounded
        end
    end

    # The dispatch must meet the load in every step of each stage, unless
    # a slack variable made up the difference (reported in slacks). The
    # day-ahead stage's hourly load is the mean of the four quarter-hours.
    slack_by_time = Dict{String, Float64}()
    for row in slacks
        slack_by_time[row.time] = get(slack_by_time, row.time, 0.0) + abs(row.value)
    end
    names = sort(collect(keys(p_da)))
    for t in 1:24
        load = base_load_mw * sum(load_profile[(4 * t - 3):(4 * t)]) / 4
        dispatched = sum(get(p_da, name, zeros(24))[t] for name in names)
        stamp = string(t0 + Hour(t - 1))
        if abs(dispatched - load) > 1e-6 * max(1.0, load) &&
           get(slack_by_time, stamp, 0.0) == 0.0
            throw(ErrorException(
                "DA did not meet the load at $(stamp): $(dispatched) MW " *
                "dispatched for $(load) MW of load",
            ))
        end
    end
    for t in 1:96
        load = base_load_mw * load_profile[t]
        dispatched = sum(get(p_rt, name, zeros(96))[t] for name in keys(p_rt))
        stamp = string(t0 + Minute(15) * (t - 1))
        if abs(dispatched - load) > 1e-6 * max(1.0, load) &&
           get(slack_by_time, stamp, 0.0) == 0.0
            throw(ErrorException(
                "RT did not meet the load at $(stamp): $(dispatched) MW " *
                "dispatched for $(load) MW of load",
            ))
        end
    end

    commitment = Any[]
    dispatch_da = Any[]
    dispatch_rt = Any[]
    cost_da = 0.0
    cost_rt = 0.0
    for g in PSY.get_components(PSY.ThermalStandard, sys)
        name = PSY.get_name(g)
        bus = PSY.get_number(PSY.get_bus(g))
        id = TS._generator_id(name, bus)
        on = get(on_da, name, zeros(24))
        p_day = get(p_da, name, zeros(24))
        p_quarter = get(p_rt, name, zeros(96))
        coefficients = get(costs, name, nothing)
        cost_da += _stage_cost(g, coefficients, on, p_day, 1.0)
        cost_rt += _stage_cost(g, coefficients, nothing, p_quarter, 0.25)
        push!(commitment, (name = name, bus = bus, id = id, on = on))
        push!(dispatch_da, (name = name, bus = bus, id = id, p_mw = p_day))
        push!(dispatch_rt, (name = name, bus = bus, id = id, p_mw = p_quarter))
    end
    by_key = x -> (x.bus, x.id, x.name)
    sort!(commitment; by = by_key)
    sort!(dispatch_da; by = by_key)
    sort!(dispatch_rt; by = by_key)

    answer = (
        status = "completed",
        network_model = String(network_model),
        base_mva = base_mva,
        interval_minutes = 60,
        stages = [
            (
                name = "DA",
                kind = "uc",
                resolution_minutes = 60,
                steps = 24,
                horizon_hours = 24,
                commitment = commitment,
                dispatch = dispatch_da,
                objective = cost_da,
            ),
            (
                name = "RT",
                kind = "dispatch",
                resolution_minutes = 15,
                steps = 96,
                horizon_hours = 1,
                dispatch = dispatch_rt,
                objective = cost_rt,
            ),
        ],
        slacks = slacks,
        store_dir = store_name,
        notes = notes,
    )
    return TS._to_json(answer)
end

end # module
