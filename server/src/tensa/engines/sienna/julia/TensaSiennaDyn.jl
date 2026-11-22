# TensaSiennaDyn.jl: the dynamics of TENSA's Sienna engine, with
# PowerSimulationsDynamics (PSID) 0.16 and Sundials' IDA.
# Included after TensaSienna.jl, and only when a session first needs dynamics,
# so a session that only solves power flows never loads PSID. It reaches the
# first module as Main.TensaSienna, which is where both files live when the
# tests and the Python worker include them into Main. Every public function
# answers a JSON string and does not throw: a failure is
# {"ok": false, "stage": ..., "error": ..., "notes": [...]}, with `stage` one of
#   "not_ready"    no solved power flow, no dynamic models, or a generator in
#                  service without a dynamic model (PSID 0.16 cannot hold one);
#   "arguments"    a malformed call: tf, step, load_model, matrix_file that is
#                  not a path, disturbances that are not a JSON list of objects;
#   "disturbances" an entry of the list is refused (named by position and kind);
#   "matrix"       matrix_file outside the scratch folder, or not writable;
#   "build"        PSID refused to build or initialise the simulation;
#   "eig"          the small-signal analysis failed;
#   "internal"     an exception this module did not expect (a bug).
# A run that starts always answers ok true with its rows, whatever its status.
# The values handed to on_step are a plain Vector{Float64}.
#
# The session's System is never changed. Each call works on a deepcopy of it
# (a deepcopy of a PowerSystems System shares nothing with the original), on
# which the load model is applied, and PSID's Simulation copies that copy once
# more. Nothing is cached between calls, so a new power flow or a reload is
# always seen.

module TensaSiennaDyn

import Main.TensaSienna as TS
using PowerSimulationsDynamics
using Sundials
using SparseArrays
using LinearAlgebra
using Logging
using JSON3

const PSY = TS.PSY
const PSID = PowerSimulationsDynamics
const PNM = TS.PNM
const SciMLBase = PSID.SciMLBase

export dyn_plan_json, eig_json, tds_init_json, tds_run_json

const LOAD_MODELS = ("impedance", "power", "as-case")
const DEFAULT_STEP = 1.0 / 30.0
# An eigenvalue smaller in magnitude than this times the largest row sum of
# the state matrix is answered as zero (see eig_json).
const ZERO_EIG_TOL = 1e-9

# PSID writes its log here, inside the simulation folder (PSID's
# configure_logging). Its console logger goes to stderr; it is given a level
# no record reaches, and the file is read back for the notes.
const _PSID_LOG = PSID.SIMULATION_LOG_FILENAME
const _QUIET = Logging.AboveMaxLevel

# JSON has no NaN or infinity, and JSON3 refuses to write them: a run that
# diverges, or a matrix PSID could not invert, answers them as null.
_finite(x::AbstractFloat) = isfinite(x) ? x : nothing
_finite(x::AbstractVector{<:AbstractFloat}) = all(isfinite, x) ? x : Any[_finite(v) for v in x]
_finite(x::AbstractVector) = Any[_finite(v) for v in x]
_finite(x::NamedTuple) = map(_finite, x)
_finite(x::AbstractDict) = Dict(k => _finite(v) for (k, v) in x)
_finite(x::Tuple) = map(_finite, x)
_finite(x) = x

_to_json(obj) = TS._to_json(_finite(obj))

# ---------------------------------------------------------------------------
# Answers, notes and paths
# ---------------------------------------------------------------------------

_paths(s::TS.Session) = (s.raw, s.dyr, joinpath(s.scratch, "sim", "x"), joinpath(s.scratch, "x"))

_clean(s::TS.Session, text) = TS._scrub(TS._first_line(string(text)), _paths(s))

_message(err) = err isa AbstractString ? String(err) : sprint(showerror, err)

function _fail(s::TS.Session, stage::AbstractString, err, notes)
    msg = _clean(s, _message(err))
    isempty(msg) && (msg = "failed at $(stage)")
    return _to_json((ok = false, stage = stage, error = msg, notes = notes))
end

_note!(notes, level, text) =
    push!(notes, Dict{String, Any}("level" => level, "text" => String(text)))

function _take_notes!(notes, logger::TS._NoteLogger, s::TS.Session)
    for (l, t) in logger.records
        _note!(notes, TS._level_name(l), TS._scrub(join(split(t), " "), _paths(s)))
    end
    empty!(logger.records)
    return notes
end

# What an "exception = (...)" line of PSID's log says, shortly: the
# exception's type, and the function a MethodError names or the message an
# exception carries. PSID logs the exception object with its backtrace.
function _exception_summary(line::AbstractString)
    m = match(r"exception\s*=\s*\(?\s*([A-Za-z_][\w.]*)\((.*)$", line)
    m === nothing && return nothing
    kind = last(split(String(m.captures[1]), '.'))
    rest = String(m.captures[2])
    if kind == "MethodError"
        f = match(r"^([\w.!#]+)", rest)
        f === nothing && return kind
        return "no method of $(last(split(f.captures[1], '.'))) for these arguments (MethodError)"
    end
    msg = match(r"^\"((?:[^\"\\]|\\.)*)\"", rest)
    msg === nothing && return kind
    return "$(kind): $(first(msg.captures[1], 300))"
end

# The records PSID wrote to its log file at warning level and above, with
# their level: the first line of each, followed for an error by what its
# exception says. The file logger writes a record as "┌ Warning: text" and
# continuation lines starting with "│", or as "[ Warning: text".
function _psid_log_records(sim_dir::AbstractString)
    out = Tuple{String, String}[]
    path = joinpath(sim_dir, _PSID_LOG)
    isfile(path) || return out
    text = try
        read(path, String)
    catch
        return out
    end
    explained = true
    for line in split(text, '\n')
        m = match(r"^[\[┌]\s*(Warning|Error):\s*(.*)$", line)
        if m === nothing
            if !explained && startswith(line, "│") && occursin("exception", line)
                summary = _exception_summary(line)
                if summary !== nothing
                    out[end] = (out[end][1], out[end][2] * " ($(summary))")
                    explained = true
                end
            end
            continue
        end
        explained = lowercase(String(m.captures[1])) != "error"
        # The file logger puts a time stamp and the process before the text.
        body = replace(String(m.captures[2]), r"^\d{4}-\d\d-\d\dT[\d:.]+\s*\[[^\]]*\]:\s*" => "")
        push!(out, (lowercase(String(m.captures[1])), String(strip(body))))
    end
    return out
end

function _take_psid_notes!(notes, s::TS.Session, sim_dir)
    for (level, text) in _psid_log_records(sim_dir)
        isempty(text) && continue
        _note!(notes, level, _clean(s, text))
    end
    return notes
end

# The first error PSID logged, else nothing.
function _psid_error(s::TS.Session, sim_dir)
    for (level, text) in _psid_log_records(sim_dir)
        level == "error" && !isempty(text) && return _clean(s, text)
    end
    return nothing
end

# The folder every simulation of this session writes into, emptied of the log
# of the call before. The removal is best effort: on Windows a handle another
# process holds on the file (a virus scanner reading what PSID just wrote)
# makes `rm` fail with EBUSY even with `force`, and a run must not fail for
# it. The log is then emptied instead where that is allowed; either way PSID's
# build opens it again with mode "w".
function _sim_dir(s::TS.Session)
    d = joinpath(s.scratch, "sim")
    mkpath(d)
    log = joinpath(d, _PSID_LOG)
    try
        isfile(log) && rm(log; force = true)
    catch err
        err isa InterruptException && rethrow()
        try
            write(log, "")
        catch
        end
    end
    return d
end

# Is `path` inside the folder `root` (and not the folder itself)?
function _inside(path::AbstractString, root::AbstractString)
    p = normpath(abspath(path))
    r = normpath(abspath(root))
    if Sys.iswindows()
        p, r = lowercase(replace(p, '/' => '\\')), lowercase(replace(r, '/' => '\\'))
    end
    r = rstrip(r, ['\\', '/'])
    return startswith(p, r * (Sys.iswindows() ? "\\" : "/")) && length(p) > length(r) + 1
end

# Run `f` with every log record of the call collected by `logger`, so that
# nothing reaches the worker's streams.
_quietly(f, logger) = Logging.with_logger(f, logger)

# Every public function runs through this: any exception that escapes the
# function's own checks is answered as JSON with stage "internal".
function _guard(f, s)
    try
        return f()
    catch err
        err isa InterruptException && rethrow()
        msg = try
            # The first lines, joined: a MethodError names its types on the
            # second line.
            text = join(first(split(strip(_message(err)), '\n'), 3), " ")
            TS._scrub(join(split(text), " "), _paths(s))
        catch
            "unexpected error"
        end
        return _to_json((ok = false, stage = "internal", error = msg, notes = Any[]))
    end
end

# ---------------------------------------------------------------------------
# The case: generators, machines, columns
# ---------------------------------------------------------------------------

_bus_number(c) = PSY.get_number(PSY.get_bus(c))
_gen_id(g) = TS._generator_id(PSY.get_name(g), _bus_number(g))

# Every generator in service (a static injector that is not a load or a
# shunt), as (static, dynamic injector or nothing), sorted by bus then id.
function _generators(sys)
    out = Tuple{Any, Any}[]
    for g in PSY.get_components(PSY.StaticInjection, sys)
        TS._is_generator(g) || continue
        PSY.get_available(g) || continue
        push!(out, (g, PSY.get_dynamic_injector(g)))
    end
    sort!(out; by = x -> (_bus_number(x[1]), _gen_id(x[1]), PSY.get_name(x[1])))
    return out
end

# The machines: generators in service with a dynamic injector, same order.
_machines(sys) = [(g, d) for (g, d) in _generators(sys) if d !== nothing]

# The machines that have a rotor speed and angle (states ω and δ), which are
# the ones the column plan carries.
_has_rotor(d) = (:ω in PSY.get_states(d)) && (:δ in PSY.get_states(d))
_rotor_machines(sys) = [(g, d) for (g, d) in _machines(sys) if _has_rotor(d)]

function _components(d)
    comps = Dict{String, String}()
    tname(x) = string(nameof(typeof(x)))
    if d isa PSY.DynamicGenerator
        comps["machine"] = tname(PSY.get_machine(d))
        comps["shaft"] = tname(PSY.get_shaft(d))
        comps["avr"] = tname(PSY.get_avr(d))
        comps["prime_mover"] = tname(PSY.get_prime_mover(d))
        comps["pss"] = tname(PSY.get_pss(d))
    elseif d isa PSY.DynamicInverter
        comps["converter"] = tname(PSY.get_converter(d))
        comps["outer_control"] = tname(PSY.get_outer_control(d))
        comps["inner_control"] = tname(PSY.get_inner_control(d))
        comps["dc_source"] = tname(PSY.get_dc_source(d))
        comps["freq_estimator"] = tname(PSY.get_freq_estimator(d))
        comps["filter"] = tname(PSY.get_filter(d))
    else
        comps["model"] = tname(d)
    end
    return comps
end

function _machine_entry(g, d)
    return (
        name = PSY.get_name(g),
        bus = _bus_number(g),
        id = _gen_id(g),
        model = string(nameof(typeof(d))),
        states = [string(st) for st in PSY.get_states(d)],
        components = _components(d),
    )
end

_sorted_buses(sys) = sort(collect(PSY.get_components(PSY.ACBus, sys)); by = PSY.get_number)

# The column plan of a time-domain run: the voltage magnitude and angle of
# every bus by ascending number, then the rotor speed and the rotor angle of
# every machine that has them, in the order of the plan's machines.
function _column_plan(sys, ext_state = nothing)
    cols = Any[]
    buses = _sorted_buses(sys)
    for b in buses
        push!(cols, (quantity = "voltage", kind = "bus", bus = PSY.get_number(b), unit = "pu"))
    end
    for b in buses
        push!(cols, (quantity = "angle", kind = "bus", bus = PSY.get_number(b), unit = "rad"))
    end
    rotor = _rotor_machines(sys)
    for (quantity, unit) in (("rotor_speed", "pu"), ("rotor_angle", "rad"))
        for (g, _) in rotor
            push!(cols, (quantity = quantity, kind = "generator", bus = _bus_number(g), id = _gen_id(g), unit = unit))
        end
    end
    if ext_state !== nothing
        for branch in ext_state.branches
            for quantity in ("i_from", "i_to")
                push!(cols, (quantity = quantity, kind = "branch", from = branch.from,
                             to = branch.to, ckt = branch.ckt, unit = "pu"))
            end
        end
    end
    return cols
end

# A generator in service without a dynamic model is wrapped by PSID as a
# static injector, which PSID 0.16 can do for a Source (an infinite bus) only:
# for anything else its build fails with a MethodError of StaticWrapper.
_psid_can_hold_static(g) = hasmethod(PSID.StaticWrapper, Tuple{typeof(g), Int})

function _unsimulated_static(sys)
    return [g for (g, d) in _generators(sys) if d === nothing && !_psid_can_hold_static(g)]
end

# What must hold before anything is built: a solved power flow, at least one
# dynamic injector, and no generator in service that PSID cannot simulate.
# `covered` is the set of (bus, id) addresses an ext.sienna document's
# inverters name: those generators get a dynamic model when the ext is
# applied, so they are neither the one dynamic model the run needs nor a
# generator without one. With no ext, `covered` is empty and the check is
# exactly what it was.
function _readiness(s::TS.Session, covered = Set{Tuple{Int, String}}())
    s.pflow_solved || return "solve the power flow first"
    machines = [(g, d) for (g, d) in _machines(s.sys)]
    if isempty(machines) && isempty(covered)
        return "the case has no dynamic models"
    end
    static = [g for g in _unsimulated_static(s.sys) if !((_bus_number(g), _gen_id(g)) in covered)]
    if !isempty(static)
        names = join(["bus $(_bus_number(g)) id $(_gen_id(g))" for g in first(static, 10)], ", ")
        more = length(static) > 10 ? " and $(length(static) - 10) more" : ""
        return "PSID 0.16 cannot simulate a generator in service without a dynamic model: $(names)$(more)"
    end
    return nothing
end

function _check_load_model(load_model)
    load_model isa AbstractString && String(load_model) in LOAD_MODELS && return nothing
    return "unknown load model $(repr(load_model)); one of $(join(LOAD_MODELS, ", "))"
end

# ---------------------------------------------------------------------------
# Load model
# ---------------------------------------------------------------------------

# Whether a load can be converted, and if not why. Loads out of service are
# neither converted nor listed.
function _load_action(load)
    PSY.get_dynamic_injector(load) === nothing || return "it has a dynamic model"
    (load isa PSY.StandardLoad || load isa PSY.PowerLoad) && return :convert
    return "a $(nameof(typeof(load))) is not converted"
end

_loads(sys) = sort(
    [l for l in PSY.get_components(PSY.ElectricLoad, sys) if TS._is_load(l) && PSY.get_available(l)];
    by = l -> (_bus_number(l), PSY.get_name(l)),
)

# What the load model does to the loads of `sys`: the count it converts and
# the loads it leaves, with why. Changes nothing.
function _load_plan(sys, load_model)
    left = Any[]
    converted = 0
    load_model == "as-case" && return (converted = 0, left = left)
    for l in _loads(sys)
        a = _load_action(l)
        if a === :convert
            converted += 1
        else
            push!(left, (name = PSY.get_name(l), bus = _bus_number(l), reason = a))
        end
    end
    return (converted = converted, left = left)
end

# Apply the load model to `sys` (a copy), at the voltages the power flow
# stored. "impedance": every load becomes a FixedAdmittance at its solved
# voltage and its own power is set to zero. An admittance means the same to
# PowerFlows and to PSID, while a StandardLoad's impedance part does not
# (PowerFlows 0.16 reads it as power at 1.0 pu, PSID 0.16 as power at the
# solved voltage). "power": every load draws its solved power as constant
# power. "as-case": the loads are left as read.
function _apply_load_model!(sys, load_model)
    plan = _load_plan(sys, load_model)
    load_model == "as-case" && return plan
    PSY.with_units_base(sys, PSY.UnitSystem.SYSTEM_BASE) do
        for l in _loads(sys)
            _load_action(l) === :convert || continue
            bus = PSY.get_bus(l)
            v0 = PSY.get_magnitude(bus)
            p, q = TS._load_pq(l, v0)
            if load_model == "impedance"
                # S = V^2 conj(Y): G = P / V^2, B = -Q / V^2.
                PSY.add_component!(
                    sys,
                    PSY.FixedAdmittance(;
                        name = "tensa-zload-" * PSY.get_name(l),
                        available = true,
                        bus = bus,
                        Y = complex(p / v0^2, -q / v0^2),
                    ),
                )
                _set_load_power!(l, 0.0, 0.0)
            else
                _set_load_power!(l, p, q)
            end
        end
    end
    return plan
end

# Make a load draw (p, q) per unit on the system base as constant power.
function _set_load_power!(l, p, q)
    if l isa PSY.StandardLoad
        PSY.set_constant_active_power!(l, p)
        PSY.set_constant_reactive_power!(l, q)
        PSY.set_current_active_power!(l, 0.0)
        PSY.set_current_reactive_power!(l, 0.0)
        PSY.set_impedance_active_power!(l, 0.0)
        PSY.set_impedance_reactive_power!(l, 0.0)
    else
        PSY.set_active_power!(l, p)
        PSY.set_reactive_power!(l, q)
    end
    return nothing
end

# The copy of the session's System a call works on, with the load model
# applied.
function _prepared_copy(s::TS.Session, load_model)
    sys = deepcopy(s.sys)
    loads = _apply_load_model!(sys, load_model)
    return sys, loads
end

# ---------------------------------------------------------------------------
# ext.sienna: Sienna-native dynamic components
# ---------------------------------------------------------------------------

# The inverter parameter sets, the same ids as the Python table
# INVERTER_PARAMETER_SETS of tensa/engines/sienna/ext.py (a unit test holds
# the two to the same ids). The values are PSID 0.16.2's own test data, in
# test/data_tests of the installed package. "gfl-omib" is inv_gfoll of
# test24.jl (lines 13-24): converter_low_power (dynamic_test_data.jl line
# 287), outer_control_gfoll (354-362), current_mode_inner (388-392),
# dc_source_lv (292), reduced_pll (315-319) and filt_gfoll (297).
# "gfm-omib" is inv_case78 of dynamic_test_data.jl (660-671):
# converter_high_power (289), outer_control (324-332), inner_control
# (375-386), dc_source_lv (292), pll (309-313) and filt (296).
const INVERTER_SETS = Dict{String, Function}(
    # inv_gfoll of PSID 0.16.2's test/data_tests/test24.jl.
    "gfl-omib" => (base_power) -> PSY.DynamicInverter(;
        name = "",
        ω_ref = 1.0,
        converter = PSY.AverageConverter(; rated_voltage = 690.0, rated_current = 2.75),
        outer_control = PSY.OuterControl(
            PSY.ActivePowerPI(; Kp_p = 2.0, Ki_p = 30.0, ωz = 0.132 * 2.0 * pi * 50.0),
            PSY.ReactivePowerPI(; Kp_q = 2.0, Ki_q = 30.0, ωf = 0.132 * 2.0 * pi * 50.0),
        ),
        inner_control = PSY.CurrentModeControl(; kpc = 0.37, kic = 0.7, kffv = 1.0),
        dc_source = PSY.FixedDCSource(; voltage = 600.0),
        freq_estimator = PSY.ReducedOrderPLL(; ω_lp = 1.32 * 2.0 * pi * 50.0, kp_pll = 2.0, ki_pll = 20.0),
        filter = PSY.LCLFilter(; lf = 0.009, rf = 0.016, cf = 2.5, lg = 0.002, rg = 0.003),
        base_power = base_power,
    ),
    # inv_case78 of PSID 0.16.2's test/data_tests/dynamic_test_data.jl.
    "gfm-omib" => (base_power) -> PSY.DynamicInverter(;
        name = "",
        ω_ref = 1.0,
        converter = PSY.AverageConverter(; rated_voltage = 138.0, rated_current = 100.0),
        outer_control = PSY.OuterControl(
            PSY.VirtualInertia(; Ta = 2.0, kd = 400.0, kω = 20.0),
            PSY.ReactivePowerDroop(; kq = 0.2, ωf = 1000.0),
        ),
        inner_control = PSY.VoltageModeControl(;
            kpv = 0.59, kiv = 736.0, kffv = 0.0, rv = 0.0, lv = 0.2,
            kpc = 1.27, kic = 14.3, kffi = 0.0, ωad = 50.0, kad = 0.2,
        ),
        dc_source = PSY.FixedDCSource(; voltage = 600.0),
        freq_estimator = PSY.KauraPLL(; ω_lp = 500.0, kp_pll = 0.084, ki_pll = 4.69),
        filter = PSY.LCLFilter(; lf = 0.08, rf = 0.003, cf = 0.074, lg = 0.2, rg = 0.01),
        base_power = base_power,
    ),
)

# What the ext applied to one run: the dynamic branches with their addresses
# (for the column plan) and their series admittance (for the per-step
# currents).
struct _ExtState
    branches::Vector{NamedTuple{(:from, :to, :ckt, :y), Tuple{Int, Int, String, ComplexF64}}}
end

# PowerSystems' PSS/E reader replaces a generator that has no .dyr record by
# a PSY.Source, a voltage source behind the record's ZSORCE, named as the
# generator was (_add_dyn_injectors! in its parsers/psse_dynamic_data.jl), and
# such a generator is exactly the one an inverter is given to. PSID 0.16.2
# cannot simulate an inverter on a Source: its DynamicWrapper for a Source
# asserts that the dynamic device has the Source's X_th and R_th, which only a
# PeriodicVariableSource has, and the build fails with a MethodError of
# get_X_th (src/base/device_wrapper.jl). So in the run's copy the Source is
# replaced by a ThermalStandard of the same name on the same bus, with the
# Source's dispatch and power base, rated at the apparent power of that
# dispatch, which PSID's generic DynamicWrapper takes as the static device of
# an inverter. The session's System keeps its Source. Answers the new
# ThermalStandard.
function _generator_for_inverter!(sys, src::PSY.Source)
    base = PSY.get_base_power(src)
    p_mw, q_mvar = PSY.with_units_base(sys, PSY.UnitSystem.NATURAL_UNITS) do
        PSY.get_active_power(src), PSY.get_reactive_power(src)
    end
    p, q = p_mw / base, q_mvar / base
    rating = abs(complex(p, q))
    rating > 0 || (rating = 1.0)
    thermal = PSY.ThermalStandard(;
        name = PSY.get_name(src),
        available = true,
        status = true,
        bus = PSY.get_bus(src),
        active_power = p,
        reactive_power = q,
        rating = rating,
        active_power_limits = (min = min(p, 0.0), max = max(p, rating)),
        reactive_power_limits = (min = -rating, max = rating),
        ramp_limits = nothing,
        operation_cost = PSY.ThermalGenerationCost(nothing),
        base_power = base,
    )
    PSY.remove_component!(sys, src)
    PSY.add_component!(sys, thermal)
    return thermal
end

# Apply the validated ext.sienna document to `sys` (the run's own copy).
# `ext` is the parsed JSON object. Answers (ext_state, notes, error or
# nothing). Never throws for a target the System does not hold: the Python
# side has validated the document against the same topology, so a miss here
# means the two disagree, which is answered as an error naming the target.
function _apply_ext!(sys, ext)
    notes = Any[]
    state = _ExtState(NamedTuple{(:from, :to, :ckt, :y), Tuple{Int, Int, String, ComplexF64}}[])
    for raw in get(ext, "dynamic_branches", Any[])
        f, t, ckt = Int(raw["from"]), Int(raw["to"]), String(raw["ckt"])
        br = TS._find_branch(sys, f, t, ckt)
        br === nothing && return nothing, notes, "ext.sienna: there is no branch $(f)-$(t) circuit $(ckt)"
        r, x = PSY.get_r(br), PSY.get_x(br)
        y = 1.0 / complex(r, x)
        # PowerSystems' add_component! of a DynamicBranch takes the static
        # branch it wraps out of the System and puts the dynamic one in its
        # place (PSID's own tests, data_tests/test11.jl and test25.jl). The
        # wrapped branch must stay available: it is the same object, and
        # switching it off takes the line out of the network.
        dyn = PSY.DynamicBranch(br)
        PSY.add_component!(sys, dyn)
        push!(state.branches, (from = f, to = t, ckt = ckt, y = y))
        _note!(notes, "info", "branch $(f)-$(t) circuit $(ckt) is a DynamicBranch")
    end
    for raw in get(ext, "inverters", Any[])
        bus, id = Int(raw["bus"]), String(raw["id"])
        set_id = String(raw["parameter_set"])
        found = nothing
        for (g, d) in _generators(sys)
            _bus_number(g) == bus && _gen_id(g) == id && (found = (g, d); break)
        end
        found === nothing && return nothing, notes, "ext.sienna: there is no generator at bus $(bus) with id $(id)"
        g, d = found
        d === nothing || return nothing, notes, "ext.sienna: the generator at bus $(bus) id $(id) already has a dynamic model"
        build = get(INVERTER_SETS, set_id, nothing)
        build === nothing && return nothing, notes, "ext.sienna: unknown inverter parameter set $(set_id)"
        g isa PSY.Source && (g = _generator_for_inverter!(sys, g))
        inverter = build(PSY.get_base_power(g))
        PSY.set_name!(inverter, PSY.get_name(g))
        # A dynamic injector is attached to the static one it stands on, whose
        # bus and setpoints it takes (PowerSystems' add_component! with the
        # static injector, as PSID's tests attach their inverters).
        PSY.add_component!(sys, inverter, g)
        _note!(notes, "info", "generator at bus $(bus) id $(id) runs as an inverter ($(set_id))")
    end
    return state, notes, nothing
end

# The (bus, id) addresses an ext document's inverters name, for _readiness.
function _ext_coverage(ext)
    covered = Set{Tuple{Int, String}}()
    ext === nothing && return covered
    for raw in get(ext, "inverters", Any[])
        push!(covered, (Int(raw["bus"]), String(raw["id"])))
    end
    return covered
end

# ---------------------------------------------------------------------------
# Building a simulation
# ---------------------------------------------------------------------------

# Build PSID's simulation of `sys` over `tspan` with the given perturbations.
# Answers (sim or nothing, error text or nothing, seconds). Never throws.
function _build(s, sys, sim_dir, tspan, perts)
    sim = nothing
    err = nothing
    t = @elapsed try
        sim = PSID.Simulation(
            PSID.ResidualModel,
            sys,
            sim_dir,
            tspan,
            perts;
            console_level = _QUIET,
            file_level = Logging.Warn,
            disable_timer_outputs = true,
        )
    catch e
        err = _clean(s, _message(e))
    end
    if err === nothing && (sim === nothing || sim.status != PSID.BUILT)
        reason = _psid_error(s, sim_dir)
        status = sim === nothing ? "none" : string(sim.status)
        err = reason === nothing ? "PSID could not build the simulation (status $(status))" :
              "PSID could not build the simulation: $(reason)"
    end
    return err === nothing ? sim : nothing, err, t
end

# The name PSID keys a machine by in its state index.
function _index_name(index, g, d)
    for name in (PSY.get_name(d), PSY.get_name(g))
        haskey(index, name) && return name
    end
    return nothing
end

# (bus number, id) of the generator a PSID device name belongs to.
function _device_address(sys, name)
    g = PSY.get_component(PSY.StaticInjection, sys, name)
    g === nothing && return (0, "")
    return (_bus_number(g), _gen_id(g))
end

# ---------------------------------------------------------------------------
# dyn_plan_json
# ---------------------------------------------------------------------------

"""
    dyn_plan_json(s; load_model = "impedance") -> String

What a dynamic run of this session is made of, without building anything:
whether it can run (and why not), the machines with PSID's state names in
PSID's order (`PSY.get_states`), the generators in service without a dynamic
model, what the load model converts, and the column plan of a run.
"""
function dyn_plan_json(s::TS.Session; load_model = "impedance")::String
    return _guard(s) do
        bad = _check_load_model(load_model)
        bad === nothing || return _fail(s, "arguments", bad, Any[])
        reason = _readiness(s)
        machines = Any[]
        static = Any[]
        for (g, d) in _generators(s.sys)
            if d === nothing
                push!(static, (name = PSY.get_name(g), bus = _bus_number(g), id = _gen_id(g)))
            else
                push!(machines, _machine_entry(g, d))
            end
        end
        return _to_json((
            ok = true,
            ready = reason === nothing,
            reason = reason,
            load_model = String(load_model),
            machines = machines,
            static_generators = static,
            loads = _load_plan(s.sys, String(load_model)),
            columns = _column_plan(s.sys),
        ))
    end
end

# ---------------------------------------------------------------------------
# eig_json
# ---------------------------------------------------------------------------

# The eigenvalues with every one smaller in magnitude than ZERO_EIG_TOL times
# the largest row sum of the state matrix `A` answered as exactly zero; also
# how many were changed and the tolerance.
function _settle_zero(eigenvalues, A)
    eigs = Vector{ComplexF64}(eigenvalues)
    tol = ZERO_EIG_TOL * max(1.0, opnorm(A, Inf))
    settled = count(e -> e != 0 && abs(e) < tol, eigs)
    return [abs(e) < tol ? zero(e) : e for e in eigs], settled, tol
end

# Name the rows (and columns) of the reduced state matrix. PSID reduces the
# Jacobian to the differential states of its DAE vector in their order
# (`_reduce_jacobian`) and records, for each device state, its row as the
# number of differential states up to and including it
# (`_make_reduced_jacobian_index`), which is `sm.index`.
function _reduced_state_names(sys, sm)
    n = size(sm.reduced_jacobian, 1)
    out = Vector{Any}(nothing, n)
    for (name, states) in sm.index
        bus, id = _device_address(sys, name)
        for (state, ix) in states
            (ix isa Integer && 1 <= ix <= n) || continue
            out[ix] = (device = String(name), bus = bus, id = id, state = string(state))
        end
    end
    for k in 1:n
        out[k] === nothing && (out[k] = (device = "", bus = 0, id = "", state = "x$(k)"))
    end
    return out
end

"""
    eig_json(s; load_model = "impedance", matrix_file = nothing) -> String

Small-signal analysis at the solved operating point: PSID's
`Simulation(ResidualModel, copy, sim_dir, (0.0, 1.0))`, then
`small_signal_analysis`. The eigenvalues are in PSID's order; `states` names
the rows of the reduced state matrix. With `matrix_file` (a path inside the
session's scratch folder) that matrix is written there as raw Float64 in
column-major order.
"""
function eig_json(s::TS.Session; load_model = "impedance", matrix_file = nothing)::String
    return _guard(s) do
        notes = Any[]
        bad = _check_load_model(load_model)
        bad === nothing || return _fail(s, "arguments", bad, notes)
        if matrix_file !== nothing
            matrix_file isa AbstractString || return _fail(s, "arguments", "matrix_file must be a path", notes)
            _inside(matrix_file, s.scratch) ||
                return _fail(s, "matrix", "matrix_file must be inside the session's scratch folder", notes)
        end
        reason = _readiness(s)
        reason === nothing || return _fail(s, "not_ready", reason, notes)

        logger = TS._NoteLogger()
        _quietly(logger) do
            sys, loads = _prepared_copy(s, String(load_model))
            sim_dir = _sim_dir(s)
            sim, err, build_s = _build(s, sys, sim_dir, (0.0, 1.0), PSID.Perturbation[])
            _take_notes!(notes, logger, s)
            _take_psid_notes!(notes, s, sim_dir)
            err === nothing || return _fail(s, "build", err, notes)

            sm = nothing
            eig_s = @elapsed try
                sm = PSID.small_signal_analysis(sim)
            catch e
                _take_notes!(notes, logger, s)
                return _fail(s, "eig", e, notes)
            end
            _take_notes!(notes, logger, s)

            A = Matrix{Float64}(sm.reduced_jacobian)
            # A system whose angles have no fixed reference has a zero
            # eigenvalue, which the solver returns as rounding noise of
            # either sign. One under the tolerance is answered as exactly
            # zero, so `stable` (no eigenvalue with a positive real part, as
            # PSID decides it) does not turn on the sign of that noise.
            eigs, settled, tol = _settle_zero(sm.eigenvalues, A)
            settled > 0 &&_note!(notes, "info", "$(settled) eigenvalue(s) under $(tol) in magnitude answered as zero")
            matrix = nothing
            if matrix_file !== nothing
                try
                    open(String(matrix_file), "w") do io
                        write(io, A)
                    end
                catch e
                    why = e isa SystemError ? Libc.strerror(e.errnum) : _message(e)
                    return _fail(s, "matrix", "could not write the matrix file $(basename(String(matrix_file))): $(why)", notes)
                end
                matrix = (file =String(matrix_file), rows = size(A, 1), cols = size(A, 2))
            end
            return _to_json((
                ok = true,
                n_states = size(A, 1),
                stable = all(e -> real(e) <= 0.0, eigs),
                eigenvalues = [[real(e), imag(e)] for e in eigs],
                states = _reduced_state_names(sys, sm),
                matrix = matrix,
                load_model = String(load_model),
                loads = loads,
                notes = notes,
                timings = (build_s = build_s, eig_s = eig_s),
            ))
        end
    end
end

# ---------------------------------------------------------------------------
# tds_init_json
# ---------------------------------------------------------------------------

"""
    tds_init_json(s; load_model = "impedance") -> String

Build the simulation of a run and report its initialisation without stepping
(PSID's `read_initial_conditions`): every device state with its initial value
in the order of PSID's state vector, and every bus voltage. `n_states` is the
length of that vector (bus voltage parts included). `initialized` is false,
with PSID's reason in `notes` and `error`, when PSID found no steady state.
"""
function tds_init_json(s::TS.Session; load_model = "impedance")::String
    return _guard(s) do
        notes = Any[]
        bad = _check_load_model(load_model)
        bad === nothing || return _fail(s, "arguments", bad, notes)
        reason = _readiness(s)
        reason === nothing || return _fail(s, "not_ready", reason, notes)
        logger = TS._NoteLogger()
        _quietly(logger) do
            sys, loads = _prepared_copy(s, String(load_model))
            sim_dir = _sim_dir(s)
            sim, err, build_s = _build(s, sys, sim_dir, (0.0, 1.0), PSID.Perturbation[])
            _take_notes!(notes, logger, s)
            _take_psid_notes!(notes, s, sim_dir)
            if err !== nothing
                return _to_json((
                    ok = true, initialized = false, error = err, n_states = 0,
                    states = Any[], buses = Any[], loads = loads, notes = notes,
                ))
            end
            x0 = PSID.read_initial_conditions(sim)
            index = PSID.make_global_state_map(PSID.get_simulation_inputs(sim))
            states = Any[]
            for (name, st) in index
                haskey(x0, name) || continue
                bus, id = _device_address(sys, name)
                for (state, ix) in st
                    push!(states, (ix = ix, device = String(name), bus = bus, id = id,
                                   state = string(state), value = x0[name][state]))
                end
            end
            sort!(states; by = x -> x.ix)
            buses = [(bus = n, v_pu = x0["Vm"][n], angle_rad = x0["θ"][n]) for n in sort(collect(keys(x0["Vm"])))]
            return _to_json((
                ok = true,
                initialized = true,
                error = nothing,
                n_states = length(PSID.get_initial_conditions(sim)),
                states = [(device = x.device, bus = x.bus, id = x.id, state = x.state, value = x.value) for x in states],
                buses = buses,
                loads = loads,
                notes = notes,
                timings = (build_s = build_s,),
            ))
        end
    end
end

# ---------------------------------------------------------------------------
# Disturbances
# ---------------------------------------------------------------------------

# Marks a refusal of the disturbances' JSON as a whole (stage "arguments")
# rather than of one entry (stage "disturbances").
const _MALFORMED = "\0malformed\0"

_is_number(x) = x isa Real && !(x isa Bool) && isfinite(x)
_is_int(x) = _is_number(x) && isinteger(x)
_text(x) = x isa AbstractString ? String(x) : (_is_int(x) ? string(Int(x)) : nothing)

# Buses connected by the in-service branches, with the branches in `out`
# left out; answers the number of connected parts.
function _network_parts(sys, out)
    adj = Dict{Int, Vector{Int}}()
    for br in PSY.get_components(PSY.ACBranch, sys)
        PSY.get_available(br) || continue
        any(x -> x === br, out) && continue
        f, t = TS._arc_numbers(br)
        push!(get!(adj, f, Int[]), t)
        push!(get!(adj, t, Int[]), f)
    end
    seen = Set{Int}()
    parts = 0
    for b in PSY.get_components(PSY.ACBus, sys)
        n = PSY.get_number(b)
        n in seen && continue
        parts += 1
        stack = [n]
        push!(seen, n)
        while !isempty(stack)
            u = pop!(stack)
            for v in get(adj, u, Int[])
                v in seen || (push!(seen, v); push!(stack, v))
            end
        end
    end
    return parts
end

# PSID trips a branch with `ybus_update!`, which exists for these types only.
_trippable(br) = hasmethod(
    PSID.ybus_update!,
    Tuple{SparseMatrixCSC{Float32, Int}, typeof(br), Dict{Int, Int}, Float64},
)

# Check the disturbance list against `sys` (the copy the run is built from)
# and answer (list of checked entries, nothing) or (nothing, error text). An
# entry is a NamedTuple with the kind, its times and its target.
function _check_disturbances(text, tf::Float64, sys)
    text isa AbstractString || return nothing, _MALFORMED * "disturbances must be a JSON string holding a list"
    entries = try
        JSON3.read(text)
    catch e
        return nothing, _MALFORMED * "disturbances are not valid JSON: $(TS._first_line(_message(e)))"
    end
    entries isa AbstractVector || return nothing, _MALFORMED * "disturbances must be a JSON list"
    checked = Any[]
    base_parts = _network_parts(sys, ())
    tripped = Any[]
    for (i, raw) in enumerate(entries)
        raw isa AbstractDict || return nothing, _MALFORMED * "entry $(i) is not an object"
        e = Dict{String, Any}(String(k) => v for (k, v) in pairs(raw))
        kind = get(e, "kind", nothing)
        kind isa AbstractString || return nothing, "entry $(i) has no kind"
        label = "entry $(i) ($(kind))"
        need(names...) = [n for n in names if !haskey(e, n)]
        within(x) = 0.0 < x < tf
        if kind == "branch_trip"
            miss = need("from", "to", "ckt", "t")
            isempty(miss) || return nothing, "$(label): missing $(join(miss, ", "))"
            (_is_int(e["from"]) && _is_int(e["to"])) || return nothing, "$(label): from and to must be bus numbers"
            ckt = _text(e["ckt"])
            ckt === nothing && return nothing, "$(label): ckt must be a circuit id"
            _is_number(e["t"]) || return nothing, "$(label): t must be a number"
            f, to, t = Int(e["from"]), Int(e["to"]), Float64(e["t"])
            within(t) || return nothing, "$(label): t = $(t) is outside (0, $(tf))"
            br = TS._find_branch(sys, f, to, ckt)
            br === nothing && return nothing, "$(label): there is no branch $(f)-$(to) circuit $(ckt)"
            PSY.get_available(br) || return nothing, "$(label): branch $(f)-$(to) circuit $(ckt) is out of service"
            any(x -> x === br, tripped) && return nothing, "$(label): branch $(f)-$(to) circuit $(ckt) is tripped twice"
            _trippable(br) || return nothing, "$(label): PSID cannot trip a $(nameof(typeof(br))) (branch $(f)-$(to) circuit $(ckt))"
            if _network_parts(sys, vcat(tripped, [br])) > base_parts
                return nothing, "$(label): tripping branch $(f)-$(to) circuit $(ckt) would split the network in two, which PSID cannot simulate"
            end
            push!(tripped, br)
            push!(checked, (kind = :branch_trip, index = i, t = t, branch = br))
        elseif kind == "gen_trip"
            miss = need("bus", "id", "t")
            isempty(miss) || return nothing, "$(label): missing $(join(miss, ", "))"
            _is_int(e["bus"]) || return nothing, "$(label): bus must be a bus number"
            id = _text(e["id"])
            id === nothing && return nothing, "$(label): id must be a generator id"
            _is_number(e["t"]) || return nothing, "$(label): t must be a number"
            bus, t = Int(e["bus"]), Float64(e["t"])
            within(t) || return nothing, "$(label): t = $(t) is outside (0, $(tf))"
            found = nothing
            for (g, d) in _machines(sys)
                _bus_number(g) == bus && _gen_id(g) == id && (found = (g, d); break)
            end
            found === nothing && return nothing, "$(label): there is no generator with a dynamic model at bus $(bus) with id $(id)"
            any(c -> c.kind == :gen_trip && c.gen === found[1], checked) &&
                return nothing, "$(label): generator at bus $(bus) id $(id) is tripped twice"
            push!(checked, (kind = :gen_trip, index = i, t = t, gen = found[1], dyn = found[2], bus = bus, id = id))
        elseif kind == "bus_fault"
            miss = need("bus", "t_on", "t_clear")
            isempty(miss) || return nothing, "$(label): missing $(join(miss, ", "))"
            _is_int(e["bus"]) || return nothing, "$(label): bus must be a bus number"
            r = get(e, "r_pu", 0.0)
            x = get(e, "x_pu", 0.0)
            (_is_number(e["t_on"]) && _is_number(e["t_clear"])) || return nothing, "$(label): t_on and t_clear must be numbers"
            (_is_number(r) && _is_number(x)) || return nothing, "$(label): r_pu and x_pu must be numbers"
            bus, t_on, t_clear = Int(e["bus"]), Float64(e["t_on"]), Float64(e["t_clear"])
            r, x = Float64(r), Float64(x)
            within(t_on) || return nothing, "$(label): t_on = $(t_on) is outside (0, $(tf))"
            within(t_clear) || return nothing, "$(label): t_clear = $(t_clear) is outside (0, $(tf))"
            t_clear > t_on || return nothing, "$(label): t_clear = $(t_clear) is not after t_on = $(t_on)"
            (r == 0.0 && x == 0.0) && return nothing, "$(label): the fault impedance is zero; give r_pu or x_pu"
            r < 0 && return nothing, "$(label): r_pu is negative"
            any(b -> PSY.get_number(b) == bus, PSY.get_components(PSY.ACBus, sys)) ||
                return nothing, "$(label): there is no bus $(bus)"
            for c in checked
                c.kind == :bus_fault || continue
                (t_on < c.t_clear && c.t_on < t_clear) &&
                    return nothing, "$(label): overlaps the fault of entry $(c.index); faults may not overlap"
            end
            push!(checked, (kind = :bus_fault, index = i, t_on = t_on, t_clear = t_clear, bus = bus, y = 1.0 / complex(r, x)))
        else
            return nothing, "$(label): unknown kind $(kind); the kinds are branch_trip, gen_trip and bus_fault"
        end
    end
    return checked, nothing
end

# The network matrix PSID's run holds at a switching time, in PSID's own
# rectangular form and arithmetic: the matrix PSID builds for this System
# (`_get_ybus`: `PNM.Ybus(sys; include_constant_impedance_loads = false)`,
# which holds the FixedAdmittance loads, made rectangular by
# `transform_ybus_to_rectangular`), with every branch tripped before that time
# taken out by PSID's own `ybus_update!(..., -1.0)`, exactly as a BranchTrip
# does, and the fault's admittance added on the bus's diagonal entry.
function _switch_matrix(base_rect, lookup, trips_before, fault_bus, y)
    rect = copy(base_rect)
    for br in trips_before
        PSID.ybus_update!(rect, br, lookup, -1.0)
    end
    if fault_bus !== nothing
        n = length(lookup)
        i = lookup[fault_bus]
        g, b = real(y), imag(y)
        rect[i, i] += g
        rect[i, i + n] += b
        rect[i + n, i] -= b
        rect[i + n, i + n] += g
    end
    return rect
end

# A NetworkSwitch that installs `rect` as it is. Its constructor takes the
# complex matrix and checks that the network is connected; the faulted
# matrix's pattern is the base one, so the base matrix is given to it and the
# rectangular matrix is put in its place.
function _network_switch(t, ycomplex, rect)
    sw = PSID.NetworkSwitch(t, ycomplex)
    sw.ybus_rectangular = rect
    return sw
end

# PSID perturbations for the checked entries, in time order. At one instant
# a network switch is applied before a trip, and a trip at the instant of a
# switch is therefore not in the switch's matrix.
function _perturbations(checked, sys)
    ybus = PNM.Ybus(sys; include_constant_impedance_loads = false)
    ycomplex = SparseMatrixCSC{ComplexF32, Int}(ybus[:, :])
    lookup = ybus.lookup[1]
    base_rect = PSID.transform_ybus_to_rectangular(ycomplex)
    trips = [c for c in checked if c.kind == :branch_trip]
    out = Tuple{Float64, Int, Int, PSID.Perturbation}[]
    for c in checked
        if c.kind == :branch_trip
            push!(out, (c.t, 1, c.index, PSID.BranchTrip(c.t, typeof(c.branch), PSY.get_name(c.branch))))
        elseif c.kind == :gen_trip
            push!(out, (c.t, 1, c.index, PSID.GeneratorTrip(c.t, c.dyn)))
        else
            on = _switch_matrix(base_rect, lookup, [x.branch for x in trips if x.t < c.t_on], c.bus, c.y)
            off = _switch_matrix(base_rect, lookup, [x.branch for x in trips if x.t < c.t_clear], nothing, 0.0)
            push!(out, (c.t_on, 0, c.index, _network_switch(c.t_on, ycomplex, on)))
            push!(out, (c.t_clear, 0, c.index, _network_switch(c.t_clear, ycomplex, off)))
        end
    end
    sort!(out; by = x -> (x[1], x[2], x[3]))
    return PSID.Perturbation[x[4] for x in out]
end

# ---------------------------------------------------------------------------
# tds_run_json
# ---------------------------------------------------------------------------

# Sundials prints its errors and warnings from C, past Julia's streams; this
# removes the error handlers of the run's SUNDIALS context, so a failed step
# prints nothing (the failure still reaches the solver's return code).
function _silence_sundials!(integrator)
    try
        h = getfield(integrator, :ctx_handle)
        ccall((:SUNContext_ClearErrHandlers, Sundials.libsundials_core), Cint, (Ptr{Cvoid},), h.ctx)
    catch
    end
    return nothing
end

# Whether the hook asked to stop: exactly `false`. A hook written in Python
# and called through PythonCall returns a `Py`, which is not a Julia Bool; a
# Python False is recognised by its type's name and its text, so this module
# needs no PythonCall. Anything else, a Python True or None included, goes on.
function _is_false(r)
    r === false && return true
    r isa Bool && return false
    nameof(typeof(r)) === :Py || return false
    return try
        string(r) == "False"
    catch
        false
    end
end

# The values of the column plan at the state vector `u`, with PSID's indices:
# bus i's voltage is (u[i], u[i + n]) for i = lookup[bus number] (PSID keeps
# the real parts of every bus first, then the imaginary parts), and a
# machine's ω and δ are at its global index.
function _plan_values!(vals, u, bus_ix, n_buses, machine_ix, ext_state = nothing, ext_bus_ix = nothing)
    k = 0
    for i in bus_ix
        k += 1
        vals[k] = hypot(u[i], u[i + n_buses])
    end
    for i in bus_ix
        k += 1
        vals[k] = atan(u[i + n_buses], u[i])
    end
    for (w, _) in machine_ix
        k += 1
        vals[k] = u[w]
    end
    for (_, d) in machine_ix
        k += 1
        vals[k] = u[d]
    end
    if ext_state !== nothing
        # The current magnitude at each end of a dynamic branch, from the bus
        # voltages and the branch's own series admittance (the pi model's
        # charging is shunt and stays with the buses): the same arithmetic
        # PSID's get_branch_current_series performs in post-processing.
        for branch in ext_state.branches
            i_f = ext_bus_ix[branch.from]
            i_t = ext_bus_ix[branch.to]
            v_f = complex(u[i_f], u[i_f + n_buses])
            v_t = complex(u[i_t], u[i_t + n_buses])
            k += 1
            vals[k] = abs(branch.y * (v_f - v_t))
            k += 1
            vals[k] = abs(branch.y * (v_t - v_f))
        end
    end
    return vals
end

"""
    tds_run_json(s; tf, step = nothing, disturbances = nothing,
                 load_model = "impedance", ext = nothing, on_step = nothing) -> String

A time-domain run from 0 to `tf` seconds with IDA on PSID's ResidualModel,
with `step` as the largest step (default 1/30 s). The rows are the solver's
accepted steps, recorded by a DiscreteCallback added to the simulation's
callbacks, which also calls `on_step(t, values)` once at t = 0 before the run
and after every accepted step; `false` from it (exactly) stops the run, and an
exception from it fails the run without leaving this function. Disturbances
(a JSON list) are checked before anything is built. After every disturbance
the algebraic variables are made consistent again (IDA's initial condition
solver, `BrownFullBasicInit`), without which IDA cannot get past a fault's
clearing.

`results_hook` (for tests) is called with PSID's `SimulationResults` of the
run, so the rows can be held to PSID's own post-processing.
"""
function tds_run_json(
    s::TS.Session;
    tf = nothing,
    step = nothing,
    disturbances = nothing,
    load_model = "impedance",
    ext = nothing,
    on_step = nothing,
    results_hook = nothing,
)::String
    return _guard(s) do
        notes = Any[]
        bad = _check_load_model(load_model)
        bad === nothing || return _fail(s, "arguments", bad, notes)
        _is_number(tf) && tf > 0 || return _fail(s, "arguments", "tf must be a positive number of seconds", notes)
        step === nothing || (_is_number(step) && step > 0) ||
            return _fail(s, "arguments", "step must be a positive number of seconds", notes)
        ext === nothing || ext isa AbstractString ||
            return _fail(s, "arguments", "ext must be a JSON string", notes)
        ext_doc = nothing
        if ext !== nothing
            ext_doc = try
                JSON3.read(ext)
            catch e
                return _fail(s, "arguments", "ext is not valid JSON: $(TS._first_line(_message(e)))", notes)
            end
        end
        tf = Float64(tf)
        dtmax = step === nothing ? min(DEFAULT_STEP, tf) : Float64(step)
        reason = _readiness(s, _ext_coverage(ext_doc))
        reason === nothing || return _fail(s, "not_ready", reason, notes)

        logger = TS._NoteLogger()
        _quietly(logger) do
            sys, loads = _prepared_copy(s, String(load_model))
            ext_state = nothing
            if ext_doc !== nothing
                ext_state, ext_notes, ext_err = _apply_ext!(sys, ext_doc)
                append!(notes, ext_notes)
                ext_err === nothing || return _fail(s, "arguments", ext_err, notes)
            end
            checked = Any[]
            if disturbances !== nothing
                checked, derr = _check_disturbances(disturbances, tf, sys)
                if derr !== nothing
                    malformed = startswith(derr, _MALFORMED)
                    return _fail(s, malformed ? "arguments" : "disturbances", replace(derr, _MALFORMED => ""), notes)
                end
            end
            perts = _perturbations(checked, sys)
            sim_dir = _sim_dir(s)
            sim, err, build_s = _build(s, sys, sim_dir, (0.0, tf), perts)
            _take_notes!(notes, logger, s)
            if err !== nothing
                _take_psid_notes!(notes, s, sim_dir)
                return _fail(s, "build", err, notes)
            end

            inputs = PSID.get_simulation_inputs(sim)
            index = PSID.make_global_state_map(inputs)
            lookup = PSID.get_lookup(inputs)
            n_buses = PSID.get_bus_count(inputs)
            bus_ix = [lookup[PSY.get_number(b)] for b in _sorted_buses(sys)]
            machine_ix = Tuple{Int, Int}[]
            for (g, d) in _rotor_machines(sys)
                name = _index_name(index, g, d)
                name === nothing && return _fail(s, "build", "machine $(PSY.get_name(g)) is not in PSID's state index", notes)
                push!(machine_ix, (index[name][:ω], index[name][:δ]))
            end
            # A trip of the machine PSID takes the network frequency from
            # leaves the run without a frequency reference.
            ref = get(PSID.get_global_vars_update_pointers(inputs), PSID.GLOBAL_VAR_SYS_FREQ_INDEX, 0)
            for c in checked
                c.kind == :gen_trip || continue
                name = _index_name(index, c.gen, c.dyn)
                if name !== nothing && get(index[name], :ω, -1) == ref
                    return _fail(s, "disturbances", "entry $(c.index) (gen_trip): the generator at bus $(c.bus) id $(c.id) is the frequency reference of the run and cannot be tripped", notes)
                end
            end

            # Every perturbation is followed by a consistent re-initialisation
            # of the algebraic variables.
            sim.callbacks = SciMLBase.DiscreteCallback[
                SciMLBase.DiscreteCallback(
                    cb.condition,
                    cb.affect!;
                    save_positions = cb.save_positions,
                    initializealg = Sundials.BrownFullBasicInit(),
                ) for cb in sim.callbacks
            ]

            ext_bus_ix = nothing
            if ext_state !== nothing && !isempty(ext_state.branches)
                ext_bus_ix = Dict{Int, Int}(PSY.get_number(b) => lookup[PSY.get_number(b)] for b in _sorted_buses(sys))
            end
            width = 2 * length(bus_ix) + 2 * length(machine_ix) +
                    (ext_state === nothing ? 0 : 2 * length(ext_state.branches))
            ts = Float64[]
            rows = Vector{Vector{Float64}}()
            stop = Ref(false)
            hook_error = Ref{Any}(nothing)
            function record(t, u)
                vals = _plan_values!(Vector{Float64}(undef, width), u, bus_ix, n_buses, machine_ix, ext_state, ext_bus_ix)
                push!(ts, Float64(t))
                push!(rows, vals)
                on_step === nothing && return false
                try
                    _is_false(on_step(Float64(t), copy(vals))) && (stop[] = true)
                catch e
                    hook_error[] = e
                    stop[] = true
                end
                return stop[]
            end
            function affect!(integrator)
                SciMLBase.u_modified!(integrator, false)
                record(integrator.t, integrator.u) && SciMLBase.terminate!(integrator)
                return nothing
            end
            push!(
                sim.callbacks,
                SciMLBase.DiscreteCallback(
                    (u, t, integrator) -> true,
                    affect!;
                    save_positions = (false, false),
                    initialize = (c, u, t, integrator) -> _silence_sundials!(integrator),
                ),
            )

            run_s = 0.0
            status = "completed"
            error_text = nothing
            if record(0.0, PSID.get_initial_conditions(sim))
                status = hook_error[] === nothing ? "aborted" : "failed"
            else
                run_s = @elapsed PSID.execute!(
                    sim,
                    Sundials.IDA();
                    dtmax = dtmax,
                    enable_progress_bar = false,
                    console_level = _QUIET,
                    file_level = Logging.Warn,
                )
                if hook_error[] !== nothing
                    status = "failed"
                elseif stop[]
                    status = "aborted"
                elseif sim.status == PSID.SIMULATION_FINALIZED && !isempty(ts) && ts[end] == tf
                    status = "completed"
                else
                    status = "failed"
                    error_text = _psid_error(s, sim_dir)
                    error_text === nothing && (error_text = "the solver stopped at t = $(isempty(ts) ? 0.0 : ts[end]) (status $(sim.status))")
                end
            end
            hook_error[] === nothing || (error_text = "on_step failed: " * _clean(s, _message(hook_error[])))
            _take_notes!(notes, logger, s)
            _take_psid_notes!(notes, s, sim_dir)

            # Each machine's electrical power from PSID's results, in MW and
            # MVAr on the system base, on the results' own time vector (a
            # disturbance's instant appears twice).
            post = nothing
            res = sim.results
            if res === nothing
                _note!(notes, "warning", "no results were stored, so post is empty")
            else
                try
                    base = PSY.get_base_power(sys)
                    series = Any[]
                    t_post = Float64[]
                    for (g, d) in _machines(sys)
                        name = PSY.get_name(g)
                        tp, p = PSID.get_activepower_series(res, name; unique_timestamps = false)
                        _, q = PSID.get_reactivepower_series(res, name; unique_timestamps = false)
                        t_post = collect(Float64, tp)
                        for (quantity, unit, y) in (("p", "MW", p), ("q", "MVAr", q))
                            push!(series, (quantity = quantity, kind = "generator", bus = _bus_number(g),
                                           id = _gen_id(g), unit = unit, y = collect(Float64, y) .* base))
                        end
                    end
                    post = (t = t_post, series = series)
                catch e
                    _note!(notes, "warning", "the results could not be read after the run: $(_clean(s, _message(e)))")
                end
                if results_hook !== nothing
                    try
                        results_hook(res)
                    catch e
                        _note!(notes, "warning", "results_hook failed: $(_clean(s, _message(e)))")
                    end
                end
            end

            return _to_json((
                ok = true,
                status = status,
                error = error_text,
                t = ts,
                columns = _column_plan(sys, ext_state),
                rows = rows,
                post = post,
                steps = max(length(ts) - 1, 0),
                t_end = isempty(ts) ? 0.0 : ts[end],
                load_model = String(load_model),
                loads = loads,
                notes = notes,
                timings = (build_s = build_s, run_s = run_s),
            ))
        end
    end
end

end # module
