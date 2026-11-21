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

function _build_system(raw, sanitized, ext)
    if ext == ".m"
        return PSY.System(raw; runchecks = false)
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
  transformer's ratio (`PSY.get_tap`, `PSY.set_tap!`) and the half of a
  branch's charging that PowerSystems leaves out when it makes a transformer
  of a branch record (`PSY.get_primary_shunt`; the rest goes on the arc's `to`
  bus as a `PSY.FixedAdmittance` named `charging-<from>-<to>-<ckt>`).

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
    sys = try
        Logging.with_logger(logger) do
            _build_system(raw, sanitized, ext)
        end
    catch err
        msg = _scrub(_first_line(sprint(showerror, err)), paths)
        throw(ErrorException("PowerSystems could not read $(basename(raw)): $(msg)"))
    end

    Logging.with_logger(logger) do
        _normalise_slack!(sys, normalised_buses, notes)
        v_setpoints === nothing || _apply_setpoints!(sys, v_setpoints, applied, notes)
        corrections === nothing || _apply_corrections!(sys, corrections, applied, notes)
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
    )
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
            # PowerSystems keeps half the charging of a branch record it made
            # a transformer of, as primary_shunt (on the arc's `from` bus);
            # the rest goes on the `to` bus.
            have = imag(PSY.get_primary_shunt(br))
            abs(have - b_total) > 1e-9 || continue
            to_obj = PSY.get_to(PSY.get_arc(br))
            adm = PSY.FixedAdmittance(;
                name = "charging-$(from_bus)-$(to_bus)-$(ckt)",
                available = PSY.get_available(br),
                bus = to_obj,
                Y = complex(0.0, b_total - have),
            )
            PSY.add_component!(sys, adm)
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
                # For a branch record PowerSystems made a transformer of, the
                # half it kept plus the half the adapter put back; for a
                # transformer record, its magnetising susceptance (0 in the
                # test cases).
                b_total = imag(PSY.get_primary_shunt(br)) + get(added, name, 0.0)
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
                    p_mw = PSY.get_active_power(c) * base_mva,
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

"""
    pflow_json(s::Session; tolerance = nothing, max_iterations = nothing) -> String

Solve the AC power flow with PowerFlows' `solve_and_store_power_flow!` (with
`tol` and `maxIterations` passed only when given; the values in effect are
reported, PowerFlows' defaults being `DEFAULT_NR_TOL` and
`DEFAULT_NR_MAX_ITER`) and read the solution back from the System with the
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
    converged = Logging.with_logger(logger) do
        solve_and_store_power_flow!(ACPowerFlow(), sys; kwargs...)
    end
    notes = [
        Dict{String, Any}("level" => _level_name(l), "text" => _scrub(t, (s.raw, s.dyr))) for
        (l, t) in logger.records
    ]

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
                        p_mw = on ? PSY.get_active_power(c) * base_mva : 0.0,
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
