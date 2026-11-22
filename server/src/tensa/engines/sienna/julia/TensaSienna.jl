# TensaSienna.jl: the Julia side of TENSA's Sienna engine.
# Loads a PSS/E case (or a MATPOWER case) into a PowerSystems System, puts back
# the places where PowerSystems' reader departs from the file, describes the
# System in TENSA's terms and solves an AC power flow. Every public result is a
# JSON string, so the Python worker needs no Julia types.

module TensaSienna

using PowerSystems
using PowerFlows
using PowerNetworkMatrices
using JSON3
using Logging

const PSY = PowerSystems
const PF = PowerFlows
const PNM = PowerNetworkMatrices

export Session, load_case, report_json, topology_json, pflow_json, versions_json
export apply_edits_json

"""
    mutable struct Session

One loaded case. `sys` is the PowerSystems.System built from the case file
(and the copy of the `.dyr` without its event records, when one was given).
The other fields record what the load saw and did: what PowerSystems warned
about as `notes`, the `.dyr` device records the System does not hold as
`unsupported`, the `.dyr` records that are not device records as `events`,
the buses whose `SLACK` type was read as `PV` or `REF`, every device record of
the `.dyr`, and the corrections made to what PowerSystems read (`applied`).
"""
mutable struct Session
    sys::PSY.System
    raw::String
    dyr::Union{String, Nothing}
    notes::Vector{Dict{String, Any}}
    unsupported::Vector{Dict{String, Any}}
    events::Vector{String}
    normalised_buses::Vector{Int}
    dyr_records::Vector{Dict{String, Any}}
    applied::Vector{Dict{String, Any}}
    scratch::String
    pflow_solved::Bool
end

# ---------------------------------------------------------------------------
# Log capture
# ---------------------------------------------------------------------------

# A logger that keeps every record at warning level and above as text and
# prints nothing; records below warning level are dropped. Installed around
# load_case's work and around the power flow solve, so the worker's streams
# stay clean.
struct _NoteLogger <: Logging.AbstractLogger
    records::Vector{Tuple{Logging.LogLevel, String}}
end

_NoteLogger() = _NoteLogger(Tuple{Logging.LogLevel, String}[])

Logging.shouldlog(::_NoteLogger, level, _module, group, id) = level >= Logging.Warn
Logging.min_enabled_level(::_NoteLogger) = Logging.Warn
Logging.catch_exceptions(::_NoteLogger) = true

function Logging.handle_message(
    logger::_NoteLogger,
    level,
    message,
    _module,
    group,
    id,
    file,
    line;
    kwargs...,
)
    level >= Logging.Warn || return nothing
    text = string(message)
    for (k, v) in kwargs
        k in (:maxlog, :_id, :_group, :_module, :_file, :_line) && continue
        text *= " $(k)=$(v)"
    end
    push!(logger.records, (level, text))
    return nothing
end

_level_name(level) = level >= Logging.Error ? "error" : "warning"

# Remove the folders of the given files from a text, so that what the module
# writes names a file by its name only.
function _scrub(text::AbstractString, paths)
    out = String(text)
    for p in paths
        p === nothing && continue
        for d in unique([dirname(abspath(p)), dirname(p)])
            isempty(d) && continue
            for v in unique([d, replace(d, '\\' => '/'), replace(d, '/' => '\\')])
                out = replace(out, v * "\\" => "", v * "/" => "", v => "")
            end
        end
    end
    return out
end

_first_line(text::AbstractString) = String(strip(first(split(strip(text), '\n'))))

# ---------------------------------------------------------------------------
# .dyr records
# ---------------------------------------------------------------------------

"""
    _sanitized_dyr(dyr_file, out_dir) -> (path, events, records, unreadable)

Read a `.dyr` file the way PowerSystems' parser does (records end at `/`,
quotes are removed, commas separate like blanks) and write a copy into
`out_dir` that holds only the device records, `<bus number> '<MODEL>' <id>
values... /`. Everything else (ANDES's event records such as `Line 'Toggle'
Line_8 2.0 /`, and text after the last `/`) is left out of the copy and
returned whitespace-collapsed as `events`. A record that starts like a device
record but has a value that is not a number is left out too and returned in
`unreadable`, since PowerSystems' parser would fail on it. `records` holds
`(bus, model, id)` of every device record in the copy. The user's file is
only read.
"""
function _sanitized_dyr(dyr_file::AbstractString, out_dir::AbstractString)
    text = read(dyr_file, String)
    pieces = split(text, '/')
    kept = IOBuffer()
    events = String[]
    records = Tuple{Int, String, String}[]
    unreadable = Tuple{Int, String, String}[]
    for (i, piece) in enumerate(pieces)
        body = strip(piece)
        isempty(body) && continue
        collapsed = join(split(body), " ")
        if i == length(pieces)
            # Text after the last '/' is not a record; PowerSystems ignores it.
            push!(events, collapsed)
            continue
        end
        tokens = split(replace(replace(body, "'" => ""), "," => " "))
        bus = length(tokens) >= 3 ? tryparse(Int, tokens[1]) : nothing
        if bus === nothing
            push!(events, collapsed)
            continue
        end
        model = String(tokens[2])
        id = String(tokens[3])
        if any(tryparse(Float64, t) === nothing for t in tokens[4:end])
            push!(unreadable, (bus, model, id))
            continue
        end
        push!(records, (bus, model, id))
        write(kept, piece, "/")
    end
    mkpath(out_dir)
    path = joinpath(out_dir, "tensa-" * basename(dyr_file))
    write(path, String(take!(kept)), "\n")
    return path, events, records, unreadable
end

# PowerSystems writes "EXDC2 at bus 3, id 1, not supported in PowerSystems.jl.
# Skipping data." for a .dyr model it does not hold.
function _unsupported_from_warning(text::AbstractString)
    m = match(r"^(\S+) at bus (\d+), id (\S+), not supported in PowerSystems", text)
    m === nothing && return nothing
    return Dict{String, Any}(
        "bus" => parse(Int, m.captures[2]),
        "model" => String(m.captures[1]),
        "id" => String(m.captures[3]),
        "handling" => "dropped",
        "reason" => String(text),
    )
end

# The PSS/E model name to the PowerSystems types of a DynamicGenerator, as
# PowerSystems' own .dyr mapping file says. `nothing` if it cannot be read.
function _dyr_mapping()
    try
        m = PSY.YAML.load_file(PSY.PSSE_DYR_MAPPING_FILE)
        gen = Dict{String, Dict{String, String}}()
        for (model, slots) in m["generator_mapping"][1]
            gen[String(model)] = Dict(String(k) => String(v) for (k, v) in slots)
        end
        others = Set{String}()
        for key in ("inverter_mapping", "additional_mapping")
            for model in keys(m[key][1])
                push!(others, String(model))
            end
        end
        return gen, others
    catch
        return nothing
    end
end

const _SLOT_GETTERS = Dict(
    "Machine" => PSY.get_machine,
    "AVR" => PSY.get_avr,
    "TurbineGov" => PSY.get_prime_mover,
    "PSS" => PSY.get_pss,
)

"""
    _check_dyr_records(sys, records, unsupported) -> Vector of new entries

Find the `.dyr` device records the System does not hold although PowerSystems
gave no warning about them. Reads every static injector (`PSY.get_bus`,
`PSY.get_name`, `PSY.get_dynamic_injector`) and, for a generator model, the
parts of its `DynamicGenerator` (`get_machine`, `get_avr`, `get_prime_mover`,
`get_pss`) against PowerSystems' mapping file: a record counts as held only
when the generator it names exists, has a dynamic injector, and the part the
model maps to is of the type the model maps to. PowerSystems skips a record
whose generator is not in the case, replaces a machine of zero inertia by a
voltage source, and keeps only one record per part, all without a warning.
"""
function _check_dyr_records(sys, records, unsupported)
    warned = Set((u["bus"], u["model"], u["id"]) for u in unsupported)
    injectors = Dict{Tuple{Int, String}, Any}()
    for g in PSY.get_components(PSY.StaticInjection, sys)
        _is_generator(g) || continue
        bus = PSY.get_number(PSY.get_bus(g))
        injectors[(bus, _generator_id(PSY.get_name(g), bus))] = g
    end
    mapping = _dyr_mapping()
    out = Dict{String, Any}[]
    for (bus, model, id) in records
        (bus, model, id) in warned && continue
        g = get(injectors, (bus, id), nothing)
        reason = nothing
        if g === nothing
            reason = "no generator at bus $(bus) with id $(id) in the case; PowerSystems skips the record"
        elseif g isa PSY.Source
            # PowerSystems reads a GENCLS record with no inertia (H = 0, PSS/E's
            # infinite bus) as a voltage Source, which is what that record is:
            # it is held, not dropped. Any other model on a Source is lost.
            model == "GENCLS" && continue
            reason = "PowerSystems models generator $(PSY.get_name(g)) as a voltage source, without a dynamic model"
        else
            dyn = PSY.get_dynamic_injector(g)
            if dyn === nothing
                reason = "no dynamic model is attached to generator $(PSY.get_name(g))"
            elseif mapping !== nothing
                gen_map, others = mapping
                if haskey(gen_map, model)
                    if !(dyn isa PSY.DynamicGenerator)
                        reason = "generator $(PSY.get_name(g)) holds a $(nameof(typeof(dyn))), not a machine model"
                    else
                        for (slot, tname) in gen_map[model]
                            getter = get(_SLOT_GETTERS, slot, nothing)
                            getter === nothing && continue
                            held = string(nameof(typeof(getter(dyn))))
                            if held != tname
                                reason = "the $(slot) of generator $(PSY.get_name(g)) is a $(held), not the $(tname) this record maps to"
                                break
                            end
                        end
                    end
                elseif !(model in others)
                    reason = "PowerSystems does not read model $(model)"
                end
            end
        end
        reason === nothing && continue
        push!(
            out,
            Dict{String, Any}(
                "bus" => bus,
                "model" => model,
                "id" => id,
                "handling" => "dropped",
                "reason" => reason,
            ),
        )
    end
    return out
end

# ---------------------------------------------------------------------------
# Elements
# ---------------------------------------------------------------------------

_is_shunt(c) = c isa PSY.FixedAdmittance || c isa PSY.SwitchedAdmittance
_is_load(c) = c isa PSY.ElectricLoad && !_is_shunt(c)
_is_generator(c) = c isa PSY.StaticInjection && !(c isa PSY.ElectricLoad) && !_is_shunt(c)

# The branch types the module describes and reports flows for.
_is_reported_branch(br) =
    br isa PSY.Line || br isa PSY.MonitoredLine || br isa PSY.TwoWindingTransformer

_is_line(br) = br isa PSY.Line || br isa PSY.MonitoredLine

# Active power of a generator, per unit in the units the caller set. A
# `SynchronousCondenser` (a PSS/E machine PowerSystems reads as one, such as
# the condensers of RTS-GMLC) has no active power field and no getter for it:
# it produces none.
_active_power(c) = c isa PSY.SynchronousCondenser ? 0.0 : PSY.get_active_power(c)

_arc_numbers(br) =
    (PSY.get_number(PSY.get_from(PSY.get_arc(br))), PSY.get_number(PSY.get_to(PSY.get_arc(br))))

# Circuit id of a branch: the suffix of its name after the last "-i_". The
# module has PowerSystems name every branch of a PSS/E file by the record's
# own circuit id (see `load_case`), and a MATPOWER branch by its row number.
function _branch_ckt(name::AbstractString)
    m = match(r"^.+-i_(.+)$", name)
    return m === nothing ? "" : String(m.captures[1])
end

_tap(br) = br isa PSY.TapTransformer || br isa PSY.PhaseShiftingTransformer ? PSY.get_tap(br) : 1.0
_shift(br) = br isa PSY.TwoWindingTransformer ? PSY.get_α(br) : 0.0

# Find the reported branch on the unordered bus pair with the circuit id.
function _find_branch(sys, from_bus::Int, to_bus::Int, ckt::AbstractString)
    lo, hi = minmax(from_bus, to_bus)
    for br in PSY.get_components(PSY.ACBranch, sys)
        _is_reported_branch(br) || continue
        f, t = _arc_numbers(br)
        minmax(f, t) == (lo, hi) || continue
        _branch_ckt(PSY.get_name(br)) == ckt && return br
    end
    return nothing
end

function _generator_id(name::AbstractString, bus_number::Int)
    prefix = "generator-$(bus_number)-"
    startswith(name, prefix) && return String(name[(length(prefix) + 1):end])
    # PowerSystems matches a .dyr record to a generator by the last part of
    # its name; a generator named otherwise is reported the same way.
    return String(last(split(name, "-")))
end

function _load_id(name::AbstractString, bus_number::Int)
    prefix = "load$(bus_number)"
    startswith(name, prefix) && return String(name[(length(prefix) + 1):end])
    return String(name)
end

# Power a load draws at voltage v (per unit), in per unit on the system base,
# as PowerFlows 0.16 reads a StandardLoad: constant power, plus constant
# current times v, plus constant impedance times v squared. Must be called
# with the unit system at SYSTEM_BASE.
function _load_pq(load, v::Float64)
    PSY.get_available(load) || return 0.0, 0.0
    if load isa PSY.StandardLoad
        p =
            PSY.get_constant_active_power(load) +
            PSY.get_current_active_power(load) * v +
            PSY.get_impedance_active_power(load) * v^2
        q =
            PSY.get_constant_reactive_power(load) +
            PSY.get_current_reactive_power(load) * v +
            PSY.get_impedance_reactive_power(load) * v^2
        return p, q
    end
    return PSY.get_active_power(load), PSY.get_reactive_power(load)
end

# ---------------------------------------------------------------------------
# load_case
# ---------------------------------------------------------------------------

function _note!(notes, text; level = "warning")
    push!(notes, Dict{String, Any}("level" => level, "text" => String(text)))
    return nothing
end

"""
    _matpower_system(raw, shifted) -> PSY.System

Read a MATPOWER case the way `PSY.System(raw; runchecks = false)` does
(`PSY.PowerModelsData`, then `PSY.System` of it), with one repair between the
two. MATPOWER applies a branch's phase shift whatever its ratio, a ratio of 0
meaning 1 (`makeYbus`), so a row with a ratio of 0 and a shift is a phase
shifter of ratio 1. PowerSystems' parser makes it a `PhaseShiftingTransformer`
but sets the base voltages a transformer needs only for a row with a ratio,
and then fails with `KeyError: key "base_voltage_from" not found`. The repair
gives such a row the base voltages of its two buses, as PowerSystems does for
the transformers it finds itself (`correct_pm_transformer_status!`), so the
shift is read as the file has it. Each repaired row is pushed to `shifted` as
`(from, to, shift_rad)`. Its charging, which PowerSystems keeps on the `from`
end only, is put back by the `line_charging` correction (`_apply_corrections!`).
"""
function _matpower_system(raw, shifted)
    pm = PSY.PowerModelsData(raw)
    data = pm.data
    for key in sort(collect(keys(data["branch"])); by = k -> parse(Int, string(k)))
        branch = data["branch"][key]
        haskey(branch, "base_voltage_from") && continue
        shift = Float64(get(branch, "shift", 0.0))
        shift == 0.0 && continue
        branch["transformer"] = true
        branch["base_voltage_from"] = data["bus"][branch["f_bus"]]["base_kv"]
        branch["base_voltage_to"] = data["bus"][branch["t_bus"]]["base_kv"]
        push!(shifted, (Int(branch["f_bus"]), Int(branch["t_bus"]), shift))
    end
    return PSY.System(pm; runchecks = false)
end

function _build_system(raw, sanitized, ext, shifted)
    if ext == ".m"
        return _matpower_system(raw, shifted)
    end
    # PowerSystems names a PSS/E branch "<from>-<to>-i_<n>" with n a running
    # count of the branches on that bus pair, taken in the order of a Dict,
    # not the record's circuit id: in kundur.raw the branch it calls
    # 13-112-i_1 is circuit 2. Its own formatter for every other source
    # (`_get_pm_branch_name`) uses the circuit id, so it is passed here.
    kw = (runchecks = false, branch_name_formatter = PSY._get_pm_branch_name)
    if sanitized === nothing
        # try_reimport = false: no `<name>_export_metadata.json` beside the
        # file may rename or renumber what the file holds.
        return PSY.System(raw; try_reimport = false, kw...)
    end
    return PSY.System(raw, sanitized; kw...)
end

"""
    load_case(raw, dyr = nothing; scratch = mktempdir(), v_setpoints = nothing,
              corrections = nothing) -> Session

Build a PowerSystems System from a PSS/E `.raw` file (with a `.dyr` when one is
given) or a MATPOWER `.m` file, with `PSY.System(...; runchecks = false)`, and
put back what PowerSystems read differently from the file:

- the `.dyr` is read into a copy in `scratch` without its event records;
- bus type `SLACK` is read as `PV`, or `REF` when the System has no `REF` bus
  (`PSY.get_bustype`, `PSY.set_bustype!`);
- `v_setpoints` (JSON object, bus number to per unit) sets the magnitude of
  each `PV` or `REF` bus it names (`PSY.set_magnitude!`);
- `corrections` (JSON object with `transformers` `[from, to, ckt, tap,
  shift_rad]` and `line_charging` `[from, to, ckt, b_total]`) puts back a
  transformer's ratio (`PSY.get_tap`, `PSY.set_tap!`) and the charging of a
  branch PowerSystems holds as a transformer, which it keeps on the `from` end
  only: the `from` half in the primary shunt (`_set_primary_shunt!`), the
  `to` half on the arc's `to` bus as a `PSY.FixedAdmittance` named
  `charging-<from>-<to>-<ckt>`;
- a MATPOWER row with a ratio of 0 and a phase shift is read as the phase
  shifter of ratio 1 it is (`_matpower_system`);
- a PV bus with no generator in service is made a PQ bus
  (`_retype_sourceless_pv!`).

Each change is an entry of the session's `applied` list. What PowerSystems
warns about becomes a note; nothing is printed. Throws an `ArgumentError`
for a file that is missing or of another kind, and an `ErrorException`
whose first line names the file when PowerSystems cannot read it.
"""
function load_case(
    raw::AbstractString,
    dyr::Union{AbstractString, Nothing} = nothing;
    scratch::AbstractString = mktempdir(),
    v_setpoints::Union{AbstractString, Nothing} = nothing,
    corrections::Union{AbstractString, Nothing} = nothing,
)
    isfile(raw) || throw(ArgumentError("case file not found: $(basename(raw))"))
    ext = lowercase(splitext(raw)[2])
    ext in (".raw", ".m") || throw(
        ArgumentError("$(basename(raw)) is not a PSS/E .raw or MATPOWER .m case file"),
    )
    if dyr !== nothing
        ext == ".raw" || throw(
            ArgumentError(
                "a .dyr file goes with a PSS/E .raw case, not with $(basename(raw))",
            ),
        )
        isfile(dyr) || throw(ArgumentError("dynamic data file not found: $(basename(dyr))"))
    end
    paths = (raw, dyr, scratch)

    notes = Dict{String, Any}[]
    unsupported = Dict{String, Any}[]
    events = String[]
    dyr_records = Dict{String, Any}[]
    applied = Dict{String, Any}[]
    normalised_buses = Int[]

    records = Tuple{Int, String, String}[]
    sanitized = nothing
    if dyr !== nothing
        sanitized, events, records, unreadable = _sanitized_dyr(dyr, scratch)
        for (bus, model, id) in records
            push!(dyr_records, Dict{String, Any}("bus" => bus, "model" => model, "id" => id))
        end
        for (bus, model, id) in unreadable
            push!(
                unsupported,
                Dict{String, Any}(
                    "bus" => bus,
                    "model" => model,
                    "id" => id,
                    "handling" => "dropped",
                    "reason" => "the record has a value that is not a number; PowerSystems cannot read it",
                ),
            )
        end
    end

    logger = _NoteLogger()
    shifted = Tuple{Int, Int, Float64}[]
    sys = try
        Logging.with_logger(logger) do
            _build_system(raw, sanitized, ext, shifted)
        end
    catch err
        # The PSS/E parser logs why it stopped and throws `nothing`, which
        # prints as "nothing": the reason is then the first error it logged.
        reason = err === nothing ? "" : _first_line(sprint(showerror, err))
        if isempty(reason) || reason == "nothing"
            i = findfirst(r -> r[1] >= Logging.Error, logger.records)
            reason = i === nothing ? "" : _first_line(logger.records[i][2])
        end
        if isempty(reason) || reason == "nothing"
            reason = string(
                "it is not a ",
                ext == ".m" ? "MATPOWER" : "PSS/E RAW",
                " file this version understands",
            )
        end
        msg = _scrub(reason, paths)
        throw(ErrorException("PowerSystems could not read $(basename(raw)): $(msg)"))
    end

    Logging.with_logger(logger) do
        _normalise_slack!(sys, normalised_buses, notes)
        v_setpoints === nothing || _apply_setpoints!(sys, v_setpoints, applied, notes)
        corrections === nothing || _apply_corrections!(sys, corrections, applied, notes)
    end
    for (f, t, shift) in shifted
        push!(applied, Dict{String, Any}("kind" => "phase_shift", "from_bus" => f, "to_bus" => t, "shift_rad" => shift))
    end
    for n in _retype_sourceless_pv!(sys)
        push!(applied, Dict{String, Any}("kind" => "bustype", "bus" => n, "from" => "PV", "to" => "PQ"))
    end

    for (level, text) in logger.records
        text = _scrub(text, paths)
        _note!(notes, text; level = _level_name(level))
        entry = _unsupported_from_warning(text)
        entry !== nothing && push!(unsupported, entry)
    end
    if !isempty(normalised_buses)
        _note!(
            notes,
            "bus type SLACK (area interchange slack) read as PV, or REF where the case has no REF bus, at buses $(normalised_buses)",
        )
    end
    others = sort(
        unique(
            string(nameof(typeof(br))) for
            br in PSY.get_components(PSY.ACBranch, sys) if !_is_reported_branch(br)
        ),
    )
    isempty(others) || _note!(
        notes,
        "branches of type $(join(others, ", ")) are in the System but not reported in the topology or the branch flows",
    )
    if dyr !== nothing
        append!(unsupported, _check_dyr_records(sys, records, unsupported))
    end
    sort!(unsupported; by = u -> (u["bus"], u["model"], u["id"]))

    return Session(
        sys,
        String(raw),
        dyr === nothing ? nothing : String(dyr),
        notes,
        unsupported,
        events,
        normalised_buses,
        dyr_records,
        applied,
        String(scratch),
        false,
    )
end

# True when the bus has a generator in service.
_has_source(sys, bus) = any(
    c -> _is_generator(c) && PSY.get_available(c) && PSY.get_bus(c) === bus,
    PSY.get_components(PSY.StaticInjection, sys),
)

"""
    _retype_sourceless_pv!(sys) -> Vector{Int}

Make every PV bus that has no generator in service a PQ bus, and answer their
numbers, lowest first. A case file may give such a bus type PV with its
generators out of service (case_ACTIVSg200.m, buses 168, 169, 196 and 197);
MATPOWER and ANDES then hold the bus at no voltage, as a PQ bus, while
PowerFlows refuses the case ("No available sources at bus ..."). A reference
bus is left as it is: without a source the case has no slack, and the power
flow says so.
"""
function _retype_sourceless_pv!(sys)
    retyped = Int[]
    for bus in PSY.get_components(PSY.ACBus, sys)
        PSY.get_bustype(bus) == PSY.ACBusTypes.PV || continue
        _has_source(sys, bus) && continue
        PSY.set_bustype!(bus, PSY.ACBusTypes.PQ)
        push!(retyped, PSY.get_number(bus))
    end
    return sort!(retyped)
end

# PowerSystems 5.12 marks the PSS/E area-interchange slack bus as SLACK, which
# PowerFlows 0.16 and PowerSimulationsDynamics 0.16 do not know. Read it as
# PV, or as REF (the lowest bus number first) when the System has no REF bus.
function _normalise_slack!(sys, normalised_buses, notes)
    buses = sort(collect(PSY.get_components(PSY.ACBus, sys)); by = PSY.get_number)
    has_ref = any(PSY.get_bustype(b) == PSY.ACBusTypes.REF for b in buses)
    for b in buses
        PSY.get_bustype(b) == PSY.ACBusTypes.SLACK || continue
        PSY.set_bustype!(b, has_ref ? PSY.ACBusTypes.PV : PSY.ACBusTypes.REF)
        has_ref = true
        push!(normalised_buses, PSY.get_number(b))
    end
    return nothing
end

# Generator setpoints: PowerSystems has no field for a generator's regulated
# voltage (PSS/E VS) and uses the bus record's stored magnitude for a PV or
# REF bus.
function _apply_setpoints!(sys, v_setpoints, applied, notes)
    obj = JSON3.read(v_setpoints)
    by_number = Dict(PSY.get_number(b) => b for b in PSY.get_components(PSY.ACBus, sys))
    for (key, value) in obj
        n = parse(Int, String(key))
        target = Float64(value)
        b = get(by_number, n, nothing)
        if b === nothing
            _note!(notes, "voltage setpoint names bus $(n), which the System does not hold")
            continue
        end
        bt = PSY.get_bustype(b)
        (bt == PSY.ACBusTypes.PV || bt == PSY.ACBusTypes.REF) || continue
        old = PSY.get_magnitude(b)
        abs(old - target) > 1e-9 || continue
        PSY.set_magnitude!(b, target)
        push!(applied, Dict{String, Any}("kind" => "setpoint", "bus" => n, "from" => old, "to" => target))
    end
    sort!(applied; by = a -> a["bus"])
    return nothing
end

# Set a transformer's primary shunt to `y_system`, per unit on the system base.
# PowerSystems 5.12 converts a complex value it reads from a branch to the
# unit system in effect, but has no conversion for one written to it
# (`set_primary_shunt!` warns "conversion not implemented for ComplexF64" and
# stores the value as given), so the value is converted to the device base,
# the base the field is stored on, and written to the field.
function _set_primary_shunt!(sys, br, y_system::ComplexF64)
    br.primary_shunt = y_system * PSY.get_base_power(sys) / PSY.get_base_power(br)
    return nothing
end

# The file's ratios and line charging put back (decision 25).
function _apply_corrections!(sys, corrections, applied, notes)
    obj = JSON3.read(corrections)
    PSY.with_units_base(sys, PSY.UnitSystem.SYSTEM_BASE) do
        for entry in get(obj, :transformers, [])
            from_bus, to_bus, ckt = Int(entry[1]), Int(entry[2]), String(string(entry[3]))
            tap, shift = Float64(entry[4]), Float64(entry[5])
            br = _find_branch(sys, from_bus, to_bus, ckt)
            if br === nothing
                _note!(notes, "ratio correction names branch $(from_bus)-$(to_bus) circuit $(ckt), which the System does not hold")
                continue
            end
            f, t = _arc_numbers(br)
            if (f, t) != (from_bus, to_bus)
                # The ratio is seen from the file's `from` end; PowerSystems
                # holds this branch the other way round, so it is left alone.
                _note!(notes, "branch $(PSY.get_name(br)) runs $(f) to $(t) in the System and $(from_bus) to $(to_bus) in the file; its ratio $(_tap(br)) is left as read, the file's is $(tap)")
                continue
            end
            if abs(_shift(br) - shift) > 1e-9
                _note!(notes, "branch $(PSY.get_name(br)) has phase shift $(_shift(br)) rad in the System and $(shift) rad in the file; left as read")
            end
            if br isa PSY.TapTransformer || br isa PSY.PhaseShiftingTransformer
                old = PSY.get_tap(br)
                abs(old - tap) > 1e-9 || continue
                PSY.set_tap!(br, tap)
                push!(applied, Dict{String, Any}("kind" => "tap", "branch" => PSY.get_name(br), "from" => old, "to" => tap))
            elseif abs(tap - 1.0) > 1e-9
                _note!(notes, "branch $(PSY.get_name(br)) is a $(nameof(typeof(br))), which has no ratio; the file's ratio $(tap) is not applied")
            end
        end
        for entry in get(obj, :line_charging, [])
            from_bus, to_bus, ckt = Int(entry[1]), Int(entry[2]), String(string(entry[3]))
            b_total = Float64(entry[4])
            br = _find_branch(sys, from_bus, to_bus, ckt)
            if br === nothing
                _note!(notes, "charging correction names branch $(from_bus)-$(to_bus) circuit $(ckt), which the System does not hold")
                continue
            end
            if _is_line(br)
                bb = PSY.get_b(br)
                have = bb.from + bb.to
                abs(have - b_total) > 1e-9 && _note!(notes, "line $(PSY.get_name(br)) has charging $(have) in the System and $(b_total) in the file; left as read")
                continue
            end
            # A branch PowerSystems holds as a transformer has one shunt, its
            # primary_shunt, which PowerNetworkMatrices adds to the `from`
            # end's self admittance after the series part is divided by the
            # squared ratio. The file's branch is a pi with half its charging
            # at each end inside the ratio, as MATPOWER and PSS/E define it
            # (the `from` self admittance is (y + j b/2) / tap^2). PowerSystems
            # keeps half the charging of a PSS/E branch record it made a
            # transformer of, and the whole of a MATPOWER transformer row's
            # charging divided by the squared ratio ("Reflecting transformer
            # shunts to primary"). The primary shunt is set to the `from` half,
            # j b/2 / tap^2 (the ratio as corrected above), and the `to` half
            # goes on the arc's `to` bus as a FixedAdmittance.
            shunt = PSY.get_primary_shunt(br)
            have = imag(shunt)
            tap = _tap(br)
            from_half = b_total / (2 * tap^2)
            to_half = b_total / 2
            abs(have - from_half) > 1e-9 || abs(to_half) > 1e-12 || continue
            _set_primary_shunt!(sys, br, complex(real(shunt), from_half))
            if abs(to_half) > 1e-12
                to_obj = PSY.get_to(PSY.get_arc(br))
                adm = PSY.FixedAdmittance(;
                    name = "charging-$(from_bus)-$(to_bus)-$(ckt)",
                    available = PSY.get_available(br),
                    bus = to_obj,
                    Y = complex(0.0, to_half),
                )
                PSY.add_component!(sys, adm)
            end
            push!(applied, Dict{String, Any}("kind" => "charging", "branch" => PSY.get_name(br), "from" => have, "to" => b_total))
        end
    end
    return nothing
end

# ---------------------------------------------------------------------------
# report_json
# ---------------------------------------------------------------------------

function _to_json(obj)
    return sprint() do io
        JSON3.write(io, obj)
    end
end

"""
    report_json(s::Session) -> String

What the load found and did: the number of buses (`PSY.ACBus` components),
the notes, the `.dyr` records the System does not hold, the `.dyr` event
records, the buses whose SLACK type was normalised, the number of `.dyr`
device records, the number of static injectors that carry a dynamic injector
(`PSY.get_dynamic_injector`), and the corrections applied.
"""
function report_json(s::Session)::String
    sys = s.sys
    n_dynamic = count(
        st -> PSY.get_dynamic_injector(st) !== nothing,
        PSY.get_components(PSY.StaticInjection, sys),
    )
    return _to_json((
        buses = length(collect(PSY.get_components(PSY.ACBus, sys))),
        notes = s.notes,
        unsupported = s.unsupported,
        events = s.events,
        normalised_buses = s.normalised_buses,
        dyr_records = length(s.dyr_records),
        dynamic_injectors = n_dynamic,
        applied = s.applied,
    ))
end

# ---------------------------------------------------------------------------
# topology_json
# ---------------------------------------------------------------------------

# The charging the adapter added for each branch, keyed by branch name.
function _added_charging(sys)
    added = Dict{String, Float64}()
    for c in PSY.get_components(PSY.FixedAdmittance, sys)
        m = match(r"^charging-(\d+)-(\d+)-(.+)$", PSY.get_name(c))
        m === nothing && continue
        br = _find_branch(sys, parse(Int, m.captures[1]), parse(Int, m.captures[2]), String(m.captures[3]))
        br === nothing && continue
        added[PSY.get_name(br)] = get(added, PSY.get_name(br), 0.0) + imag(PSY.get_Y(c))
    end
    return added
end

_adapter_shunt(c) = c isa PSY.FixedAdmittance && startswith(PSY.get_name(c), "charging-")

"""
    topology_json(s::Session) -> String

Describe the System in TENSA's terms, read with the unit system at
SYSTEM_BASE and converted with the system base (`PSY.get_base_power`):
`PSY.ACBus` (number, name, base voltage, type, magnitude, angle in rad), every
`Line`, `MonitoredLine` and two-winding transformer (arc, r, x, charging, tap,
shift in rad, rating), every static injector that is not a load or a shunt as
a generator (powers, reactive limits, base power, dynamic injector), the
loads (`PSY.ElectricLoad` that are not shunts), the file's
`FixedAdmittance`/`SwitchedAdmittance` shunts (the adapter's `charging-...`
admittances are left out; the branch they belong to reports the file's total
charging as `b_pu` instead), and the `.dyr` records the System holds.
"""
function topology_json(s::Session)::String
    sys = s.sys
    base_mva = PSY.get_base_power(sys)
    added = _added_charging(sys)
    buses = Any[]
    branches = Any[]
    generators = Any[]
    loads = Any[]
    shunts = Any[]
    gen_names = Dict{Tuple{Int, String}, String}()

    PSY.with_units_base(sys, PSY.UnitSystem.SYSTEM_BASE) do
        for b in PSY.get_components(PSY.ACBus, sys)
            push!(buses, (
                number = PSY.get_number(b),
                name = PSY.get_name(b),
                vn_kv = PSY.get_base_voltage(b),
                type = string(PSY.get_bustype(b)),
                v_pu = PSY.get_magnitude(b),
                angle_rad = PSY.get_angle(b),
                available = PSY.get_available(b),
            ))
        end
        for br in PSY.get_components(PSY.ACBranch, sys)
            _is_reported_branch(br) || continue
            f, t = _arc_numbers(br)
            name = PSY.get_name(br)
            if _is_line(br)
                bb = PSY.get_b(br)
                b_total = bb.from + bb.to
            else
                # For a branch whose charging the adapter put back, the two
                # halves of the file's pi: the `from` half, which the primary
                # shunt holds divided by the squared ratio, and the `to` half
                # the adapter added. For any other transformer, its magnetising
                # susceptance (0 in the test cases).
                b_total = if haskey(added, name)
                    imag(PSY.get_primary_shunt(br)) * _tap(br)^2 + added[name]
                else
                    imag(PSY.get_primary_shunt(br))
                end
            end
            rating = PSY.get_rating(br)
            push!(branches, (
                name = name,
                from = f,
                to = t,
                ckt = _branch_ckt(name),
                kind = _is_line(br) ? "line" : "transformer",
                sienna_type = string(nameof(typeof(br))),
                r_pu = PSY.get_r(br),
                x_pu = PSY.get_x(br),
                b_pu = b_total,
                tap = _tap(br),
                shift_rad = _shift(br),
                rate_mva = rating === nothing ? nothing : rating * base_mva,
                available = PSY.get_available(br),
            ))
        end
        for c in PSY.get_components(PSY.StaticInjection, sys)
            bus = PSY.get_bus(c)
            n = PSY.get_number(bus)
            name = PSY.get_name(c)
            if _is_generator(c)
                q = hasproperty(c, :reactive_power_limits) ?
                    PSY.get_reactive_power_limits(c) : nothing
                id = _generator_id(name, n)
                gen_names[(n, id)] = name
                push!(generators, (
                    name = name,
                    bus = n,
                    id = id,
                    kind = PSY.get_bustype(bus) == PSY.ACBusTypes.REF ? "Slack" : "PV",
                    sienna_type = string(nameof(typeof(c))),
                    p_mw = _active_power(c) * base_mva,
                    q_mvar = PSY.get_reactive_power(c) * base_mva,
                    v_set_pu = PSY.get_magnitude(bus),
                    q_min_mvar = q === nothing ? nothing : q.min * base_mva,
                    q_max_mvar = q === nothing ? nothing : q.max * base_mva,
                    mbase_mva = hasproperty(c, :base_power) ?
                                PSY.get_base_power(c) : nothing,
                    available = PSY.get_available(c),
                    has_dynamics = PSY.get_dynamic_injector(c) !== nothing,
                ))
            elseif _is_load(c)
                p, q = _load_pq(c, 1.0)
                push!(loads, (
                    name = name,
                    bus = n,
                    id = _load_id(name, n),
                    sienna_type = string(nameof(typeof(c))),
                    p_mw = p * base_mva,
                    q_mvar = q * base_mva,
                    available = PSY.get_available(c),
                ))
            elseif _is_shunt(c) && !_adapter_shunt(c)
                m = match(r"^-?\d+-(\d+)$", name)
                y = PSY.get_Y(c)
                push!(shunts, (
                    name = name,
                    bus = n,
                    order = m === nothing ? 0 : parse(Int, m.captures[1]),
                    kind = c isa PSY.SwitchedAdmittance ? "switched" : "fixed",
                    sienna_type = string(nameof(typeof(c))),
                    g_mw = real(y) * base_mva,
                    b_mvar = imag(y) * base_mva,
                    available = PSY.get_available(c),
                ))
            end
        end
    end

    unsupported = Set((u["bus"], u["model"], u["id"]) for u in s.unsupported)
    dynamics = Any[]
    for rec in s.dyr_records
        (rec["bus"], rec["model"], rec["id"]) in unsupported && continue
        gname = get(gen_names, (rec["bus"], rec["id"]), nothing)
        gname === nothing && continue
        push!(dynamics, (bus = rec["bus"], id = rec["id"], model = rec["model"], generator = gname))
    end

    sort!(buses; by = x -> x.number)
    sort!(branches; by = x -> (minmax(x.from, x.to)..., x.ckt, x.name))
    sort!(generators; by = x -> (x.bus, x.id, x.name))
    sort!(loads; by = x -> (x.bus, x.id, x.name))
    sort!(shunts; by = x -> (x.order, x.bus, x.name))
    sort!(dynamics; by = x -> (x.bus, x.id, x.model))

    return _to_json((
        base_mva = base_mva,
        freq_hz = PSY.get_frequency(sys),
        buses = buses,
        branches = branches,
        generators = generators,
        loads = loads,
        shunts = shunts,
        dynamics = dynamics,
    ))
end

# ---------------------------------------------------------------------------
# pflow_json
# ---------------------------------------------------------------------------

"""
    _branch_flows(br, v_from, v_to, added_b) -> (s_from, s_to)

Power leaving each end of a branch into it, in per unit on the system base,
from the solved complex bus voltages at the arc's `from` and `to` buses. The
System keeps only one end of a branch's flow after
`solve_and_store_power_flow!`, so both ends are computed here with the
branch's own two-port admittances, `PNM.ybus_branch_entries`, which is what
PowerNetworkMatrices builds the power flow's admittance matrix from (series
impedance, charging or shunt on each end, tap and phase shift). `added_b` is
the charging the adapter put on the `to` bus for this branch; it belongs to
the branch, so its reactive power is counted in the `to` end. Must be called
with the unit system at SYSTEM_BASE.
"""
function _branch_flows(br, v_from::ComplexF64, v_to::ComplexF64, added_b::Float64)
    PSY.get_available(br) || return 0.0im, 0.0im
    y11, y12, y21, y22 = PNM.ybus_branch_entries(br)
    s_from = v_from * conj(y11 * v_from + y12 * v_to)
    s_to = v_to * conj(y21 * v_from + y22 * v_to) + abs2(v_to) * conj(complex(0.0, added_b))
    return ComplexF64(s_from), ComplexF64(s_to)
end

# The units of a bus whose powers the power flow sets: the generators in
# service that PowerFlows counts as sources (`_is_available_source`: no load,
# no shunt, no FACTS device).
_bus_units(sys, bus) = [
    c for c in PSY.get_components(PSY.StaticInjection, sys) if
    _is_generator(c) && PSY.get_available(c) && PSY.get_bus(c) === bus &&
    !(c isa PSY.FACTSControlDevice)
]

# A unit's reactive limits as (min, max), or nothing when it has none or one
# is not finite.
function _q_range(c)
    hasproperty(c, :reactive_power_limits) || return nothing
    q = PSY.get_reactive_power_limits(c)
    q === nothing && return nothing
    (isfinite(q.min) && isfinite(q.max)) || return nothing
    return (q.min, q.max)
end

"""
    _share_q!(units, q_total)

Share a bus's reactive power among its units as MATPOWER does (`pfsoln`):
each unit takes its minimum plus a share of what the bus gives above their
minimums, in proportion to its reactive range, so every unit is inside its
limits whenever the bus is inside theirs, and each is past its limits by its
share of the excess otherwise. Equal shares where a unit has no finite limits
or the ranges add up to 0. Must be called with the unit system at SYSTEM_BASE.
"""
function _share_q!(units, q_total::Float64)
    ranges = [_q_range(c) for c in units]
    if any(r -> r === nothing, ranges) || sum(r[2] - r[1] for r in ranges) <= 0.0
        for c in units
            PSY.set_reactive_power!(c, q_total / length(units))
        end
        return nothing
    end
    q_min = sum(r[1] for r in ranges)
    span = sum(r[2] - r[1] for r in ranges)
    for (c, r) in zip(units, ranges)
        PSY.set_reactive_power!(c, r[1] + (q_total - q_min) * (r[2] - r[1]) / span)
    end
    return nothing
end

"""
    _share_p!(units, p_total)

Share a reference bus's active power among its units: each keeps its
scheduled power and takes a share of the difference in proportion to its
maximum active power (`get_active_power_limits_for_power_flow`), or an equal
share where none has one. A condenser takes none. Must be called with the unit
system at SYSTEM_BASE.
"""
function _share_p!(units, p_total::Float64)
    movers = [c for c in units if !(c isa PSY.SynchronousCondenser)]
    isempty(movers) && return nothing
    scheduled = sum(_active_power(c) for c in movers)
    ratings = [max(PF.get_active_power_limits_for_power_flow(c).max, 0.0) for c in movers]
    total = sum(ratings)
    for (c, rating) in zip(movers, ratings)
        share = total > 0.0 && isfinite(total) ? rating / total : 1.0 / length(movers)
        PSY.set_active_power!(c, _active_power(c) + (p_total - scheduled) * share)
    end
    return nothing
end

"""
    _store_unit_powers!(sys, pf, data, max_iterations, notes)

Set the powers of the units of every PV and reference bus from the solved
bus injections, which `write_power_flow_solution!` with `skip_redistribution`
leaves to the caller. Each bus is shared first by PowerFlows' own rule
(`_power_redistribution_ref`, `_reactive_power_redistribution_pv`): active
power at a reference bus in proportion to the units' maximum active power,
reactive power in proportion to their active power, each unit clamped to its
limits. That rule fails when the bus needs more than its units' limits add up
to (an `AssertionError` it notes as its issue #231), which a power flow does
not constrain: the reference bus of `pglib_opf_case24_ieee_rts.m` must give
more than the 591 MW of its three units, and bus 15 more reactive power than
its six. Such a bus is shared by `_share_p!` and `_share_q!` instead, and a
note says so. The bus voltages and each bus's total are the solved ones
either way. Must be called with the unit system at SYSTEM_BASE.
"""
function _store_unit_powers!(sys, pf, data, max_iterations::Int, notes)
    nrd = PNM.get_network_reduction_data(PF.get_power_network_matrix(data))
    bus_lookup = PF.get_bus_lookup(data)
    by_number = Dict(PSY.get_number(b) => b for b in PSY.get_components(PSY.ACBus, sys))
    for (number, reduced) in PNM.get_bus_reduction_map(nrd)
        isempty(reduced) || continue
        ix = bus_lookup[number]
        bustype = data.bus_type[ix, 1]
        (bustype == PSY.ACBusTypes.REF || bustype == PSY.ACBusTypes.PV) || continue
        bus = by_number[number]
        p_total = Float64(data.bus_active_power_injections[ix, 1])
        q_total = Float64(data.bus_reactive_power_injections[ix, 1])
        units = _bus_units(sys, bus)
        isempty(units) && continue
        failure = try
            if bustype == PSY.ACBusTypes.REF
                PF._power_redistribution_ref(sys, p_total, q_total, bus, max_iterations, nothing)
            else
                PF._reactive_power_redistribution_pv(sys, q_total, bus, max_iterations)
            end
            nothing
        catch err
            err isa InterruptException && rethrow()
            _first_line(sprint(showerror, err))
        end
        failure === nothing && continue
        bustype == PSY.ACBusTypes.REF && _share_p!(units, p_total)
        _share_q!(units, q_total)
        what = bustype == PSY.ACBusTypes.REF ? "active and reactive power" : "reactive power"
        _note!(
            notes,
            "PowerFlows could not share the $(what) of bus $(number) among its $(length(units)) units ($(failure)); they are shared in proportion to their ratings and reactive ranges instead, past their limits where the bus needs more",
        )
    end
    return nothing
end

"""
    pflow_json(s::Session; tolerance = nothing, max_iterations = nothing) -> String

Solve the AC power flow as PowerFlows' `solve_and_store_power_flow!` does
(`PowerFlowData`, `solve_power_flow!` with `tol` and `maxIterations` passed
only when given, `write_power_flow_solution!`; the values in effect are
reported, PowerFlows' defaults being `DEFAULT_NR_TOL` and
`DEFAULT_NR_MAX_ITER`), with the units' powers set by `_store_unit_powers!`,
and read the solution back from the System with the
unit system at SYSTEM_BASE: bus magnitudes and angles (rad), generator
powers, the power each load draws at its solved voltage, and both ends of
every branch's flow (MW and MVAr leaving that end into the branch). What
PowerFlows logs at warning level and above is returned as `notes`, not
printed. When the solve does not converge the lists are empty.
"""
function pflow_json(s::Session; tolerance = nothing, max_iterations = nothing)::String
    sys = s.sys
    base_mva = PSY.get_base_power(sys)
    tol = tolerance === nothing ? Float64(PF.DEFAULT_NR_TOL) : Float64(tolerance)
    maxiter = max_iterations === nothing ? Int(PF.DEFAULT_NR_MAX_ITER) : Int(max_iterations)
    kwargs = Dict{Symbol, Any}()
    tolerance === nothing || (kwargs[:tol] = tol)
    max_iterations === nothing || (kwargs[:maxIterations] = maxiter)

    logger = _NoteLogger()
    shared = Dict{String, Any}[]
    # What `solve_and_store_power_flow!` does, with the sharing of each bus's
    # power among its units left to `_store_unit_powers!`.
    pf = ACPowerFlow(; skip_redistribution = true)
    converged = Logging.with_logger(logger) do
        solved = false
        PSY.with_units_base(sys, PSY.UnitSystem.SYSTEM_BASE) do
            data = PF.PowerFlowData(pf, sys)
            solved = PF.solve_power_flow!(data; kwargs...)
            if solved
                PF.write_power_flow_solution!(sys, pf, data, maxiter)
                _store_unit_powers!(sys, pf, data, maxiter, shared)
            end
        end
        solved
    end
    s.pflow_solved = converged
    notes = [
        Dict{String, Any}("level" => _level_name(l), "text" => _scrub(t, (s.raw, s.dyr))) for
        (l, t) in logger.records
    ]
    append!(notes, shared)

    buses = Any[]
    branches = Any[]
    generators = Any[]
    loads = Any[]
    if converged
        added = _added_charging(sys)
        PSY.with_units_base(sys, PSY.UnitSystem.SYSTEM_BASE) do
            volts = Dict{Int, ComplexF64}()
            for b in PSY.get_components(PSY.ACBus, sys)
                n = PSY.get_number(b)
                volts[n] = PSY.get_magnitude(b) * cis(PSY.get_angle(b))
                push!(buses, (number = n, v_pu = PSY.get_magnitude(b), angle_rad = PSY.get_angle(b)))
            end
            for br in PSY.get_components(PSY.ACBranch, sys)
                _is_reported_branch(br) || continue
                f, t = _arc_numbers(br)
                name = PSY.get_name(br)
                s_from, s_to = _branch_flows(br, volts[f], volts[t], get(added, name, 0.0))
                push!(branches, (
                    name = name,
                    from = f,
                    to = t,
                    ckt = _branch_ckt(name),
                    p_from_mw = real(s_from) * base_mva,
                    q_from_mvar = imag(s_from) * base_mva,
                    p_to_mw = real(s_to) * base_mva,
                    q_to_mvar = imag(s_to) * base_mva,
                ))
            end
            for c in PSY.get_components(PSY.StaticInjection, sys)
                bus = PSY.get_bus(c)
                n = PSY.get_number(bus)
                if _is_generator(c)
                    on = PSY.get_available(c)
                    push!(generators, (
                        name = PSY.get_name(c),
                        bus = n,
                        id = _generator_id(PSY.get_name(c), n),
                        p_mw = on ? _active_power(c) * base_mva : 0.0,
                        q_mvar = on ? PSY.get_reactive_power(c) * base_mva : 0.0,
                    ))
                elseif _is_load(c)
                    p, q = _load_pq(c, PSY.get_magnitude(bus))
                    push!(loads, (
                        name = PSY.get_name(c),
                        bus = n,
                        id = _load_id(PSY.get_name(c), n),
                        p_mw = p * base_mva,
                        q_mvar = q * base_mva,
                    ))
                end
            end
        end
        sort!(buses; by = x -> x.number)
        sort!(branches; by = x -> (minmax(x.from, x.to)..., x.ckt, x.name))
        sort!(generators; by = x -> (x.bus, x.id, x.name))
        sort!(loads; by = x -> (x.bus, x.id, x.name))
    end

    return _to_json((
        converged = converged,
        tolerance = tol,
        max_iterations = maxiter,
        notes = notes,
        buses = buses,
        branches = branches,
        generators = generators,
        loads = loads,
    ))
end

# ---------------------------------------------------------------------------
# apply_edits_json
# ---------------------------------------------------------------------------

# The neutral edit fields and the PowerSystems setter of each, by component
# group. Verified against PowerSystems 5.12: a load is a StandardLoad or
# PowerLoad (set_active_power!, set_reactive_power! in per unit on the system
# base, under with_units_base SYSTEM_BASE), a generator a StaticInjection
# that is not a load or shunt (set_active_power!; the voltage setpoint is the
# bus magnitude of a PV or REF bus, set_magnitude!), a branch an ACBranch
# (set_available!), a shunt a FixedAdmittance or SwitchedAdmittance (set_Y!
# with the new admittance). in_service is set_available! on the component.
const _FIELD_SETTERS = Dict(
    "load" => Dict(
        "p_mw" => :load_p,
        "q_mvar" => :load_q,
        "in_service" => :available,
    ),
    "generator" => Dict(
        "p_mw" => :gen_p,
        "v_set_pu" => :gen_v,
        "in_service" => :available,
    ),
    "branch" => Dict("in_service" => :available),
    "shunt" => Dict(
        "g_mw" => :shunt_g,
        "b_mvar" => :shunt_b,
        "in_service" => :available,
    ),
)

# Parse "load:7-1" -> ("load", 7, "1"); "branch:7-8-1" -> ("branch", 7, 8, "1");
# "bus:7" -> ("bus", 7); "gen:1-1" -> ("gen", 1, "1"); "shunt:7-1" -> ("shunt", 7, "1").
function _parse_key(key::AbstractString)
    kind, rest = split(key, ":"; limit = 2)
    parts = split(rest, "-")
    if kind == "bus"
        return (kind, parse(Int, parts[1]))
    end
    if kind == "branch"
        return (kind, parse(Int, parts[1]), parse(Int, parts[2]), String(parts[3]))
    end
    return (kind, parse(Int, parts[1]), String(join(parts[2:end], "-")))
end

# Find the component a set or remove entry names, by its topology name within
# the group the key's kind names. PowerSystems names are unique per type.
function _find_by_name(sys, kind::AbstractString, name::AbstractString)
    if kind == "load"
        for c in PSY.get_components(PSY.ElectricLoad, sys)
            _is_load(c) && PSY.get_name(c) == name && return c
        end
    elseif kind == "gen"
        for c in PSY.get_components(PSY.StaticInjection, sys)
            _is_generator(c) && PSY.get_name(c) == name && return c
        end
    elseif kind == "branch"
        for c in PSY.get_components(PSY.ACBranch, sys)
            _is_reported_branch(c) && PSY.get_name(c) == name && return c
        end
    elseif kind == "shunt"
        for c in PSY.get_components(PSY.StaticInjection, sys)
            _is_shunt(c) && !_adapter_shunt(c) && PSY.get_name(c) == name && return c
        end
    end
    return nothing
end

function _apply_set!(sys, entry, base_mva, applied, refused)
    key = String(entry["key"])
    name = String(entry["name"])
    field = String(entry["field"])
    value = entry["value"]
    parsed = try
        _parse_key(key)
    catch
        push!(refused, Dict{String, Any}("key" => key, "reason" => "the key does not parse"))
        return
    end
    kind = parsed[1]
    group = kind == "gen" ? "generator" : kind
    setters = get(_FIELD_SETTERS, group, nothing)
    if setters === nothing || !haskey(setters, field)
        push!(refused, Dict{String, Any}("key" => key, "reason" => "a $(group) does not take $(field)"))
        return
    end
    component = _find_by_name(sys, kind, name)
    if component === nothing
        push!(refused, Dict{String, Any}("key" => key, "reason" => "no $(group) named $(name) in the System"))
        return
    end
    setter = setters[field]
    note = nothing
    PSY.with_units_base(sys, PSY.UnitSystem.SYSTEM_BASE) do
        if setter == :available
            value isa Bool ||
                throw(ArgumentError("in_service of $(key) must be true or false"))
            PSY.set_available!(component, value)
        elseif setter == :load_p
            number = Float64(value)
            if component isa PSY.StandardLoad
                PSY.set_constant_active_power!(component, number / base_mva)
                if PSY.get_current_active_power(component) != 0.0 ||
                   PSY.get_impedance_active_power(component) != 0.0
                    note = "the load's current and impedance parts are unchanged"
                end
            else
                PSY.set_active_power!(component, number / base_mva)
            end
        elseif setter == :load_q
            number = Float64(value)
            if component isa PSY.StandardLoad
                PSY.set_constant_reactive_power!(component, number / base_mva)
                if PSY.get_current_reactive_power(component) != 0.0 ||
                   PSY.get_impedance_reactive_power(component) != 0.0
                    note = "the load's current and impedance parts are unchanged"
                end
            else
                PSY.set_reactive_power!(component, number / base_mva)
            end
        elseif setter == :gen_p
            PSY.set_active_power!(component, Float64(value) / base_mva)
        elseif setter == :gen_v
            bus = PSY.get_bus(component)
            bt = PSY.get_bustype(bus)
            if bt != PSY.ACBusTypes.PV && bt != PSY.ACBusTypes.REF
                push!(refused, Dict{String, Any}(
                    "key" => key,
                    "reason" => "the voltage setpoint of $(key) names a bus that is not PV or REF",
                ))
                return
            end
            PSY.set_magnitude!(bus, Float64(value))
        elseif setter == :shunt_g || setter == :shunt_b
            y = PSY.get_Y(component)
            number = Float64(value) / base_mva
            new_y = setter == :shunt_g ? complex(number, imag(y)) : complex(real(y), number)
            PSY.set_Y!(component, new_y)
        end
    end
    done = Dict{String, Any}("op" => "set", "key" => key, "field" => field, "value" => value)
    note === nothing || (done["note"] = note)
    push!(applied, done)
    return
end

function _apply_add!(sys, entry, base_mva, applied, refused)
    key = String(entry["key"])
    fields = entry["fields"]
    parsed = try
        _parse_key(key)
    catch
        push!(refused, Dict{String, Any}("key" => key, "reason" => "the key does not parse"))
        return
    end
    kind, bus_number, id = parsed[1], parsed[2], parsed[3]
    buses = [b for b in PSY.get_components(PSY.ACBus, sys) if PSY.get_number(b) == bus_number]
    if isempty(buses)
        push!(refused, Dict{String, Any}("key" => key, "reason" => "no bus $(bus_number) in the System"))
        return
    end
    bus = buses[1]
    available = Bool(get(fields, "in_service", true))
    PSY.with_units_base(sys, PSY.UnitSystem.SYSTEM_BASE) do
        if kind == "load"
            component = PSY.PowerLoad(;
                name = "load$(bus_number)-$(id)",
                available = available,
                bus = bus,
                base_power = base_mva,
                active_power = Float64(fields["p_mw"]) / base_mva,
                reactive_power = Float64(fields["q_mvar"]) / base_mva,
                max_active_power = Float64(fields["p_mw"]) / base_mva,
                max_reactive_power = Float64(fields["q_mvar"]) / base_mva,
            )
            PSY.add_component!(sys, component)
        elseif kind == "shunt"
            component = PSY.FixedAdmittance(;
                name = "$(bus_number)-$(id)",
                available = available,
                bus = bus,
                Y = complex(Float64(fields["g_mw"]), Float64(fields["b_mvar"])) / base_mva,
            )
            PSY.add_component!(sys, component)
        else
            push!(refused, Dict{String, Any}("key" => key, "reason" => "only a load or a shunt can be added"))
            return
        end
    end
    push!(applied, Dict{String, Any}("op" => "add", "key" => key))
    return
end

function _apply_remove!(sys, entry, applied, refused)
    key = String(entry["key"])
    name = String(entry["name"])
    parsed = try
        _parse_key(key)
    catch
        push!(refused, Dict{String, Any}("key" => key, "reason" => "the key does not parse"))
        return
    end
    kind = parsed[1]
    if kind != "load" && kind != "shunt"
        push!(refused, Dict{String, Any}("key" => key, "reason" => "only a load or a shunt can be removed"))
        return
    end
    component = _find_by_name(sys, kind, name)
    if component === nothing
        push!(refused, Dict{String, Any}("key" => key, "reason" => "no $(kind) named $(name) in the System"))
        return
    end
    PSY.remove_component!(sys, component)
    push!(applied, Dict{String, Any}("op" => "remove", "key" => key))
    return
end

"""
    apply_edits!(s::Session, edits_json::AbstractString) -> String

Apply the session's whole neutral edit log to the System, in order. Each
entry is `{"op": "set", "key", "name", "field", "value"}`,
`{"op": "add", "key", "fields"}` or `{"op": "remove", "key", "name"}`. The
component is found by its topology name within the group the key's kind
names. MW and MVAr are converted with the system base under
`with_units_base(sys, PSY.UnitSystem.SYSTEM_BASE)`.

Answers a JSON object `{"applied": [...], "refused": [...]}`: one `applied`
entry per edit done, one `refused` entry per edit not done with `"reason"`.
A refused edit does not stop the log: the Python side validates before it
sends, so a refusal means the System and the log disagree, which the answer
must say.
"""
function apply_edits!(s::Session, edits_json::AbstractString)::String
    sys = s.sys
    base_mva = PSY.get_base_power(sys)
    entries = JSON3.read(edits_json)
    applied = Dict{String, Any}[]
    refused = Dict{String, Any}[]
    for entry in entries
        op = String(entry["op"])
        try
            if op == "set"
                _apply_set!(sys, entry, base_mva, applied, refused)
            elseif op == "add"
                _apply_add!(sys, entry, base_mva, applied, refused)
            elseif op == "remove"
                _apply_remove!(sys, entry, applied, refused)
            else
                push!(refused, Dict{String, Any}("key" => get(entry, "key", ""), "reason" => "unknown op $(op)"))
            end
        catch err
            key = try
                String(entry["key"])
            catch
                ""
            end
            push!(refused, Dict{String, Any}("key" => key, "reason" => _first_line(sprint(showerror, err))))
        end
    end
    # A PV bus whose generators are all out of service has no source to hold
    # its voltage, which the power flow refuses ("No available sources at
    # bus ..."): it becomes a PQ bus while the edits stand
    # (`_retype_sourceless_pv!`). The log is applied to a System read afresh,
    # so a bus an edit retyped is PV again once the generator is back; a bus
    # the load retyped (the file's generators there are all out of service)
    # is made PV again here when an edit puts one of them in service. A
    # reference bus is left as it is: without a source the case has no
    # slack, and the power flow says so.
    retyped = Dict{String, Any}[]
    by_number = Dict(PSY.get_number(b) => b for b in PSY.get_components(PSY.ACBus, sys))
    for entry in s.applied
        get(entry, "kind", "") == "bustype" || continue
        bus = get(by_number, entry["bus"], nothing)
        bus === nothing && continue
        PSY.get_bustype(bus) == PSY.ACBusTypes.PQ && _has_source(sys, bus) || continue
        PSY.set_bustype!(bus, PSY.ACBusTypes.PV)
        push!(retyped, Dict{String, Any}("bus" => entry["bus"], "type" => "PV"))
    end
    for n in _retype_sourceless_pv!(sys)
        push!(retyped, Dict{String, Any}("bus" => n, "type" => "PQ"))
    end
    s.pflow_solved = false
    return _to_json((applied = applied, refused = refused, retyped = retyped))
end

apply_edits_json(s::Session, edits_json::AbstractString) = apply_edits!(s, edits_json)

# ---------------------------------------------------------------------------
# versions_json
# ---------------------------------------------------------------------------

# Version of a package of the active environment, read from the Project.toml
# of the package Julia would load, without loading it.
function _package_version(name::AbstractString)
    id = Base.identify_package(name)
    id === nothing && return nothing
    loaded = get(Base.loaded_modules, id, nothing)
    loaded === nothing || return string(pkgversion(loaded))
    src = Base.locate_package(id)
    src === nothing && return nothing
    for file in ("Project.toml", "JuliaProject.toml")
        proj = joinpath(dirname(dirname(src)), file)
        isfile(proj) || continue
        for line in eachline(proj)
            m = match(r"^\s*version\s*=\s*\"([^\"]+)\"", line)
            m === nothing || return String(m.captures[1])
        end
    end
    return nothing
end

"""
    versions_json() -> String

The Julia version and the versions of the Sienna packages in the environment,
read at run time: `pkgversion` of each loaded package, and for
PowerSimulationsDynamics, which this module does not load, the version in the
Project.toml of the copy the environment would load.
"""
function versions_json()::String
    return _to_json((
        julia = string(VERSION),
        PowerSystems = string(pkgversion(PowerSystems)),
        PowerFlows = string(pkgversion(PowerFlows)),
        PowerNetworkMatrices = string(pkgversion(PowerNetworkMatrices)),
        PowerSimulationsDynamics = _package_version("PowerSimulationsDynamics"),
    ))
end

end # module
