# TensaSiennaNet.jl: the network matrices of TENSA's Sienna engine, with
# PowerNetworkMatrices (PNM), and the DC power flow, with PowerFlows (PF).
# Included after TensaSienna.jl, and only when a session first asks for a
# matrix or a DC power flow, so a session that only solves AC power flows
# never builds one. It reaches the first module as Main.TensaSienna, which is
# where both files live when the tests and the Python worker include them into
# Main. The public functions answer a JSON string.

module TensaSiennaNet

import Main.TensaSienna as TS
import Logging

const PSY = TS.PSY
const PNM = TS.PNM
const PF = TS.PF

export network_matrix_json, dc_pflow_json

const KINDS = ("ptdf", "lodf", "ybus", "incidence")

# The DC methods the engine takes, and the PowerFlows solver of each.
const DC_METHODS = ("dc", "ptdf-dc")

# An arc axis entry as (from, to) bus numbers.
_arc_entry(arc) = Dict{String, Any}("from" => arc[1], "to" => arc[2])

# Write a matrix as raw Float64, column-major, with no header. Every matrix is
# made a dense Float64 matrix first: PowerNetworkMatrices 0.20 keeps the Ybus as
# ComplexF32 (its parts are Float32, 4 bytes each), the PTDF as a transposed view
# of what it stores, and the incidence matrix sparse; the reader on the Python
# side reads 8-byte values in column-major order and nothing else.
function _write_matrix(file::AbstractString, matrix)
    open(file, "w") do io
        write(io, Matrix{Float64}(matrix))
    end
    return nothing
end

# Write the nonzero entries of a complex matrix as raw Float64, an n_entries
# by 4 matrix column-major with no header: the 0-based row, the 0-based
# column, the real part and the imaginary part of each entry, the entries in
# row-major order. An entry whose two parts are both zero is left out. The
# Ybus of a large case is mostly zeros, so it is never made dense: its file
# holds 32 bytes per nonzero, and the Python side refuses an answer with too
# many of them before it reads the file. Answers the entry count.
function _write_triplets(file::AbstractString, matrix)
    cells = sort!(findall(!iszero, matrix); by = c -> (c[1], c[2]))
    out = Matrix{Float64}(undef, length(cells), 4)
    for (k, c) in enumerate(cells)
        value = matrix[c]
        out[k, 1] = c[1] - 1
        out[k, 2] = c[2] - 1
        out[k, 3] = Float64(real(value))
        out[k, 4] = Float64(imag(value))
    end
    open(file, "w") do io
        write(io, out)
    end
    return length(cells)
end

"""
    network_matrix_json(s::TS.Session; kind, file) -> String

Build one network matrix of the loaded case with PowerNetworkMatrices and
write it to `file` as raw Float64, column-major, with no header. `kind` is
"ptdf", "lodf", "ybus" or "incidence". The Ybus, complex and sparse, is
written as its nonzero entries (`_write_triplets`) and never made dense; its
answer carries their count as `n_entries`. The answer is a JSON object with
the kind, the shape, the axes (arc entries `{"from", "to"}` or bus numbers),
the basename of the file written, the reference buses (not for ybus) and
`distributed_slack` false. Throws an `ArgumentError` for a kind it does not
know; a matrix PowerNetworkMatrices cannot build propagates as thrown.
"""
function network_matrix_json(s::TS.Session; kind::AbstractString, file::AbstractString)::String
    kind in KINDS || throw(ArgumentError("unknown network matrix kind: $(kind)"))
    base = basename(String(file))
    n_entries = nothing
    if kind == "ptdf"
        m = PNM.PTDF(s.sys)
        data = PNM.get_ptdf_data(m)
        _write_matrix(String(file), data)
        rows = [_arc_entry(a) for a in PNM.get_arc_axis(m)]
        cols = Any[Int(b) for b in PNM.get_bus_axis(m)]
        ref_buses = Any[Int(b) for b in PNM.get_ref_bus(m)]
        complex = false
        files = Any[base]
    elseif kind == "lodf"
        m = PNM.LODF(s.sys)
        data = PNM.get_lodf_data(m)
        _write_matrix(String(file), data)
        rows = [_arc_entry(a) for a in PNM.get_arc_axis(m)]
        cols = [_arc_entry(a) for a in PNM.get_arc_axis(m)]
        ref_buses = Any[Int(b) for b in PNM.get_ref_bus(m)]
        complex = false
        files = Any[base]
    elseif kind == "ybus"
        m = PNM.Ybus(s.sys)
        data = m.data
        n_entries = _write_triplets(String(file), data)
        rows = Any[Int(b) for b in PNM.get_bus_axis(m)]
        cols = Any[Int(b) for b in PNM.get_bus_axis(m)]
        ref_buses = nothing
        complex = true
        files = Any[base]
    else
        m = PNM.IncidenceMatrix(s.sys)
        data = Float64.(Matrix(m.data))
        _write_matrix(String(file), data)
        rows = [_arc_entry(a) for a in PNM.get_arc_axis(m)]
        cols = Any[Int(b) for b in PNM.get_bus_axis(m)]
        ref_buses = Any[Int(b) for b in PNM.get_ref_bus(m)]
        complex = false
        files = Any[base]
    end
    n_rows, n_cols = size(data)
    answer = Dict{String, Any}(
        "kind" => String(kind),
        "n_rows" => n_rows,
        "n_cols" => n_cols,
        "complex" => complex,
        "file" => first(files),
        "files" => files,
        "rows" => rows,
        "cols" => cols,
        "distributed_slack" => false,
    )
    ref_buses === nothing || (answer["ref_buses"] = ref_buses)
    n_entries === nothing || (answer["n_entries"] = n_entries)
    return TS._to_json(answer)
end

# ---------------------------------------------------------------------------
# dc_pflow_json
# ---------------------------------------------------------------------------

# The PowerFlows solver of a DC method name.
function _dc_solver(method::AbstractString)
    method == "dc" && return PF.DCPowerFlow()
    method == "ptdf-dc" && return PF.PTDFDCPowerFlow()
    throw(ArgumentError("unknown DC power flow method: $(method); the methods are dc and ptdf-dc"))
end

"""
    dc_pflow_json(s::TS.Session; method) -> String

Solve the DC power flow of the loaded case with PowerFlows' `solve_power_flow`
(`DCPowerFlow()` for `method` "dc", `PTDFDCPowerFlow()` for "ptdf-dc") on a
deep copy of the session's System, which stays untouched, and answer the
shape `pflow_json` answers with these differences: every reactive power is
`null`, every bus voltage magnitude is the bus's setpoint for a PV or
reference bus and 1.0 for a PQ bus (the DC model holds magnitudes there), and
a field `method` names the method. `tolerance` and `max_iterations` are
`null`: a DC power flow has neither. What PowerFlows logs at warning level
and above comes back as `notes`, not printed. Throws an `ArgumentError` for a
method it does not know.
"""
function dc_pflow_json(s::TS.Session; method::AbstractString)::String
    solver = _dc_solver(method)
    sys = deepcopy(s.sys)
    base_mva = PSY.get_base_power(sys)

    # PowerFlows solves the angles with the reference at 0 but works the branch
    # flows out of the reference bus's stored angle (a case read from a file
    # stores its solved one, 32.7 degrees at Kundur's bus 1), so the flows out
    # of that bus come out wrong. The copy's reference angle is set to 0 for
    # the solve, and the angles are reported shifted back by it.
    ref_angles = Float64[]
    for b in PSY.get_components(PSY.ACBus, sys)
        if PSY.get_bustype(b) == PSY.ACBusTypes.REF
            push!(ref_angles, PSY.get_angle(b))
            PSY.set_angle!(b, 0.0)
        end
    end
    # With one reference the case's angles are kept as stored at it; islands
    # with a reference each are reported against 0.
    shift = length(ref_angles) == 1 ? ref_angles[1] : 0.0

    logger = TS._NoteLogger()
    solved = Logging.with_logger(logger) do
        PF.solve_power_flow(solver, sys, PF.FlowReporting.BRANCH_FLOWS)
    end
    notes = [
        Dict{String, Any}("level" => TS._level_name(l), "text" => TS._scrub(t, (s.raw, s.dyr))) for
        (l, t) in logger.records
    ]

    period = solved["1"]
    flow_results = period["flow_results"]
    bus_results = period["bus_results"]

    # Bus angles and loads from the bus results, keyed by number. The bus
    # results give a reference bus's scheduled generation, not the balance it
    # takes up, which is worked out from the flows leaving it below.
    angle_of = Dict{Int, Float64}()
    p_load_of = Dict{Int, Float64}()
    for row in eachrow(bus_results)
        n = Int(row[:bus_number])
        angle_of[n] = Float64(row[:θ]) + shift
        p_load_of[n] = Float64(row[:P_load])
    end
    # The active power each bus sends into the network, in MW: what its
    # generators make less what its loads draw.
    net_out = Dict{Int, Float64}()
    for row in eachrow(flow_results)
        f = Int(row[:bus_from])
        t = Int(row[:bus_to])
        net_out[f] = get(net_out, f, 0.0) + Float64(row[:P_from_to])
        net_out[t] = get(net_out, t, 0.0) + Float64(row[:P_to_from])
    end
    p_gen_of = Dict{Int, Float64}(
        n => get(net_out, n, 0.0) + get(p_load_of, n, 0.0) for n in keys(p_load_of)
    )

    buses = Any[]
    bus_type_of = Dict{Int, PSY.ACBusTypes}()
    for b in PSY.get_components(PSY.ACBus, sys)
        n = PSY.get_number(b)
        bt = PSY.get_bustype(b)
        bus_type_of[n] = bt
        # The DC model holds magnitudes at the setpoint of a PV or reference
        # bus and at 1.0 for a PQ bus.
        v_pu = (bt == PSY.ACBusTypes.PV || bt == PSY.ACBusTypes.REF) ?
               PSY.get_magnitude(b) : 1.0
        push!(buses, (
            number = n,
            v_pu = v_pu,
            angle_rad = get(angle_of, n, 0.0),
        ))
    end

    # Branch flows from the flow results, matched to the reported branches by
    # name. The flow results are in MW already (write_results scales by the
    # system base); p_to is -p_from for the lossless default.
    flow_by_name = Dict{String, Any}()
    for row in eachrow(flow_results)
        flow_by_name[String(row[:flow_name])] = row
    end
    branches = Any[]
    for br in PSY.get_components(PSY.ACBranch, sys)
        TS._is_reported_branch(br) || continue
        f, t = TS._arc_numbers(br)
        name = PSY.get_name(br)
        row = get(flow_by_name, name, nothing)
        p_from = row === nothing ? 0.0 : Float64(row[:P_from_to])
        push!(branches, (
            name = name,
            from = f,
            to = t,
            ckt = TS._branch_ckt(name),
            p_from_mw = p_from,
            q_from_mvar = nothing,
            p_to_mw = -p_from,
            q_to_mvar = nothing,
        ))
    end

    # Generators: the scheduled active power of every in-service generator, on
    # the system base. A reference bus's generators also take the balance the
    # bus results report (P_gen there is the injection the solver used, in
    # MW): the difference from their schedule is shared equally among them.
    generators = Any[]
    loads = Any[]
    PSY.with_units_base(sys, PSY.UnitSystem.SYSTEM_BASE) do
        scheduled = Dict{Int, Float64}()
        count_on = Dict{Int, Int}()
        for c in PSY.get_components(PSY.StaticInjection, sys)
            TS._is_generator(c) && PSY.get_available(c) || continue
            n = PSY.get_number(PSY.get_bus(c))
            scheduled[n] = get(scheduled, n, 0.0) + TS._active_power(c) * base_mva
            count_on[n] = get(count_on, n, 0) + 1
        end
        for c in PSY.get_components(PSY.StaticInjection, sys)
            TS._is_generator(c) || continue
            n = PSY.get_number(PSY.get_bus(c))
            p_mw = 0.0
            if PSY.get_available(c)
                p_mw = TS._active_power(c) * base_mva
                if bus_type_of[n] == PSY.ACBusTypes.REF
                    p_mw += (get(p_gen_of, n, 0.0) - scheduled[n]) / count_on[n]
                end
            end
            push!(generators, (
                name = PSY.get_name(c),
                bus = n,
                id = TS._generator_id(PSY.get_name(c), n),
                p_mw = p_mw,
                q_mvar = nothing,
            ))
        end
        for c in PSY.get_components(PSY.StaticInjection, sys)
            TS._is_load(c) || continue
            bus = PSY.get_bus(c)
            n = PSY.get_number(bus)
            p, _ = TS._load_pq(c, 1.0)
            push!(loads, (
                name = PSY.get_name(c),
                bus = n,
                id = TS._load_id(PSY.get_name(c), n),
                p_mw = p * base_mva,
                q_mvar = nothing,
            ))
        end
    end

    sort!(buses; by = x -> x.number)
    sort!(branches; by = x -> (minmax(x.from, x.to)..., x.ckt, x.name))
    sort!(generators; by = x -> (x.bus, x.id, x.name))
    sort!(loads; by = x -> (x.bus, x.id, x.name))

    return TS._to_json((
        converged = true,
        method = String(method),
        tolerance = nothing,
        max_iterations = nothing,
        notes = notes,
        buses = buses,
        branches = branches,
        generators = generators,
        loads = loads,
    ))
end

end # module
