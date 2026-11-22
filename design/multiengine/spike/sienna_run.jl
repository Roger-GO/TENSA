#!/usr/bin/env julia
# sienna_run.jl -- Sienna half of the ANDES comparison spike.
# Usage: julia sienna_run.jl <case.raw> <case.dyr or -> <out_dir> <from_bus> <to_bus> <t_trip> <tf>

using PowerSystems
using PowerFlows
using PowerSimulationsDynamics
using Sundials
using JSON3
using Logging
using Pkg

const PSY = PowerSystems

# Keep info-level chatter down, never hide warnings/errors.
Logging.global_logger(Logging.ConsoleLogger(stderr, Logging.Warn))

function pkg_version(name::AbstractString)
    for (uuid, info) in Pkg.dependencies()
        if info.name == name
            v = info.version
            return v === nothing ? "unknown" : string(v)
        end
    end
    return "unknown"
end

function write_json(path, obj)
    open(path, "w") do io
        JSON3.write(io, obj)
    end
    return
end

function report_error(path, err)
    msg = sprint(showerror, err)
    write_json(path, Dict("error" => msg))
    io = stderr
    showerror(io, err)
    println(io)
    for (exc, bt) in Base.catch_stack()
        showerror(io, exc, bt)
        println(io)
    end
    return
end

function count_components(sys)
    counts = Dict{String, Int}()
    for c in PSY.get_components(PSY.Component, sys)
        t = string(typeof(c).name.name)
        counts[t] = get(counts, t, 0) + 1
        if c isa PSY.DynamicGenerator
            for part in (
                PSY.get_machine(c),
                PSY.get_shaft(c),
                PSY.get_avr(c),
                PSY.get_prime_mover(c),
                PSY.get_pss(c),
            )
                pt = string(typeof(part).name.name)
                counts[pt] = get(counts, pt, 0) + 1
            end
        elseif c isa PSY.DynamicInverter
            for part in (
                PSY.get_converter(c),
                PSY.get_filter(c),
                PSY.get_freq_estimator(c),
                PSY.get_outer_control(c),
                PSY.get_inner_control(c),
                PSY.get_dc_source(c),
            )
                pt = string(typeof(part).name.name)
                counts[pt] = get(counts, pt, 0) + 1
            end
        end
    end
    return counts
end

"""
Copy a .dyr file leaving out the records PowerSystems' parser cannot read: a record
is `<bus number> '<MODEL>' <id> values... /`, and ANDES also accepts event records
that start with a model name (`Line 'Toggle' Line_8 2.0 /`). Those are dropped and
returned, so the caller can report them. Nothing else is changed.
"""
function sanitized_dyr(dyr_file::AbstractString, out_dir::AbstractString)
    text = read(dyr_file, String)
    kept = String[]
    dropped = String[]
    for rec in split(text, '/')
        body = strip(rec)
        isempty(body) && continue
        first_token = first(split(body))
        if tryparse(Int, first_token) === nothing
            push!(dropped, join(split(body), " "))
        else
            push!(kept, String(rec) * "/")
        end
    end
    isempty(dropped) && return dyr_file, dropped
    path = joinpath(out_dir, "sanitized_" * basename(dyr_file))
    write(path, join(kept, ""), "\n")
    return path, dropped
end

function find_line(sys, from_bus::Int, to_bus::Int)
    for line in PSY.get_components(PSY.Line, sys)
        arc = PSY.get_arc(line)
        f = PSY.get_number(PSY.get_from(arc))
        t = PSY.get_number(PSY.get_to(arc))
        if (f == from_bus && t == to_bus) || (f == to_bus && t == from_bus)
            return line
        end
    end
    return nothing
end

function main()
    length(ARGS) == 7 || error(
        "usage: julia sienna_run.jl <case.raw> <case.dyr or -> <out_dir> <from_bus> <to_bus> <t_trip> <tf>",
    )
    raw_file, dyr_file, out_dir = ARGS[1], ARGS[2], ARGS[3]
    from_bus = parse(Int, ARGS[4])
    to_bus = parse(Int, ARGS[5])
    t_trip = parse(Float64, ARGS[6])
    tf = parse(Float64, ARGS[7])

    mkpath(out_dir)
    sim_dir = joinpath(out_dir, "sim")
    mkpath(sim_dir)

    has_dyn = dyr_file != "-"
    timings = Dict{String, Float64}()
    failed = false

    # ---- Step 1: load system -------------------------------------------------
    t0 = time()
    dropped_records = String[]
    if has_dyn
        dyr_file, dropped_records = sanitized_dyr(dyr_file, out_dir)
        for rec in dropped_records
            @warn "dyr record not readable by PowerSystems, left out: $rec"
        end
    end
    sys = if has_dyn
        System(raw_file, dyr_file; runchecks = false)
    else
        System(raw_file; runchecks = false)
    end
    timings["load_s"] = time() - t0

    # PowerSystems 5.12 marks the PSS/E area-interchange slack bus (ISW of an AREA record)
    # as SLACK. PowerFlows 0.16 and PowerSimulationsDynamics 0.16 predate that type. With
    # no area interchange control the bus regulates its voltage like any generator bus, so
    # it is read as PV, or as REF when the case would otherwise have no reference bus.
    normalised_buses = Int[]
    has_ref = any(
        PSY.get_bustype(b) == PSY.ACBusTypes.REF for b in PSY.get_components(PSY.ACBus, sys)
    )
    for b in PSY.get_components(PSY.ACBus, sys)
        if PSY.get_bustype(b) == PSY.ACBusTypes.SLACK
            PSY.set_bustype!(b, has_ref ? PSY.ACBusTypes.PV : PSY.ACBusTypes.REF)
            has_ref = true
            push!(normalised_buses, PSY.get_number(b))
        end
    end
    isempty(normalised_buses) ||
        @warn "bus type SLACK (area interchange slack) read as PV or REF at buses $(normalised_buses)"

    case_name = splitext(basename(raw_file))[1]
    n_buses = length(collect(PSY.get_components(PSY.Bus, sys)))

    # ---- Step 2: AC power flow ----------------------------------------------
    t0 = time()
    converged = solve_and_store_power_flow!(ACPowerFlow(), sys)
    timings["pflow_s"] = time() - t0

    buses_out = Dict{String, Any}()
    for b in PSY.get_components(PSY.Bus, sys)
        buses_out[string(PSY.get_number(b))] = Dict(
            "v" => PSY.get_magnitude(b),
            "a_deg" => rad2deg(PSY.get_angle(b)),
        )
    end
    write_json(
        joinpath(out_dir, "pflow.json"),
        Dict(
            "engine" => "sienna",
            "versions" => Dict(
                "PowerSystems" => pkg_version("PowerSystems"),
                "PowerFlows" => pkg_version("PowerFlows"),
                "PowerSimulationsDynamics" => pkg_version("PowerSimulationsDynamics"),
            ),
            "converged" => converged,
            "dropped_dyr_records" => dropped_records,
            "buses" => buses_out,
            "components" => count_components(sys),
        ),
    )

    # ---- Load model for dynamics ------------------------------------------------
    # ANDES turns PQ loads into constant impedance at the solved voltage for time-domain
    # and eigenvalue runs (PQ.config.p2z = q2z = 1). PowerSimulationsDynamics keeps what
    # the case says, which for a PSS/E load is constant power. `load_model` "z" does here
    # what ANDES does, at the solved voltage so the operating point is unchanged.
    #
    # The load becomes a FixedAdmittance and its own power is set to zero, because the two
    # packages read a StandardLoad's impedance part differently: PowerFlows 0.16 takes it
    # as the power at 1.0 pu (P_Z * V^2), PowerSimulationsDynamics 0.16 as the power at the
    # solved voltage (P_Z * (V / V0)^2). An admittance means the same to both.
    load_model = get(ENV, "SPIKE_LOAD_MODEL", "z")
    converted_loads = 0
    if has_dyn && load_model == "z"
        PSY.set_units_base_system!(sys, "SYSTEM_BASE")
        for load in collect(PSY.get_components(PSY.StandardLoad, sys))
            bus = PSY.get_bus(load)
            v0 = PSY.get_magnitude(bus)
            p =
                PSY.get_constant_active_power(load) +
                PSY.get_current_active_power(load) * v0 +
                PSY.get_impedance_active_power(load) * v0^2
            q =
                PSY.get_constant_reactive_power(load) +
                PSY.get_current_reactive_power(load) * v0 +
                PSY.get_impedance_reactive_power(load) * v0^2
            # S = V^2 * conj(Y): P = G V^2, Q = -B V^2
            shunt = PSY.FixedAdmittance(;
                name = "zload_" * PSY.get_name(load),
                available = true,
                bus = bus,
                Y = complex(p / v0^2, -q / v0^2),
            )
            PSY.add_component!(sys, shunt)
            PSY.set_impedance_active_power!(load, 0.0)
            PSY.set_impedance_reactive_power!(load, 0.0)
            PSY.set_constant_active_power!(load, 0.0)
            PSY.set_constant_reactive_power!(load, 0.0)
            PSY.set_current_active_power!(load, 0.0)
            PSY.set_current_reactive_power!(load, 0.0)
            converted_loads += 1
        end
        n_other = length(collect(PSY.get_components(PSY.PowerLoad, sys)))
        n_other > 0 && @warn "$n_other PowerLoad components left as constant power"
    end
    write_json(
        joinpath(out_dir, "load_model.json"),
        Dict("load_model" => load_model, "converted_loads" => converted_loads),
    )

    if has_dyn
        # ---- Step 3: small-signal analysis -----------------------------------
        try
            t0 = time()
            sim_eig = Simulation(ResidualModel, sys, sim_dir, (0.0, 1.0))
            timings["eig_build_s"] = time() - t0
            t0 = time()
            sm = small_signal_analysis(sim_eig)
            timings["eig_s"] = time() - t0
            eigs = sort(collect(sm.eigenvalues); by = real, rev = true)
            write_json(
                joinpath(out_dir, "eig.json"),
                Dict(
                    "n_states" => length(eigs),
                    "stable" => sm.stable,
                    "eigenvalues" => [[real(e), imag(e)] for e in eigs],
                ),
            )
        catch err
            timings["eig_build_s"] = get(timings, "eig_build_s", 0.0)
            timings["eig_s"] = get(timings, "eig_s", 0.0)
            report_error(joinpath(out_dir, "eig.json"), err)
            failed = true
        end

        # ---- Step 4: line-trip time-domain simulation ------------------------
        try
            t0 = time()
            line = find_line(sys, from_bus, to_bus)
            line === nothing &&
                error("no AC Line found between buses $from_bus and $to_bus")
            line_name = PSY.get_name(line)
            trip = BranchTrip(t_trip, Line, line_name)
            sim_tds = Simulation(ResidualModel, sys, sim_dir, (0.0, tf), trip)
            timings["tds_build_s"] = time() - t0

            t0 = time()
            status = execute!(
                sim_tds,
                IDA();
                saveat = 0.01,
                dtmax = 0.01,
                enable_progress_bar = false,
            )
            timings["tds_s"] = time() - t0

            results = read_results(sim_tds)
            series = Dict{String, Any}()
            # A dynamic generator hangs on a static injector, which is what sits on a bus.
            for st in PSY.get_components(PSY.StaticInjection, sys)
                g = PSY.get_dynamic_injector(st)
                g isa PSY.DynamicGenerator || continue
                gname = PSY.get_name(g)
                bus_n = PSY.get_number(PSY.get_bus(st))
                tw, w = get_state_series(results, (gname, :ω))
                series["omega@bus$(bus_n):$(gname)"] =
                    Dict("t" => collect(tw), "y" => collect(w))
                td, d = get_state_series(results, (gname, :δ))
                series["delta@bus$(bus_n):$(gname)"] =
                    Dict("t" => collect(td), "y" => collect(d))
            end
            for b in PSY.get_components(PSY.Bus, sys)
                bus_n = PSY.get_number(b)
                tv, v = get_voltage_magnitude_series(results, bus_n)
                series["v@bus$(bus_n)"] = Dict("t" => collect(tv), "y" => collect(v))
            end
            write_json(
                joinpath(out_dir, "tds.json"),
                Dict(
                    "tripped_line" => [from_bus, to_bus],
                    "tripped_name" => line_name,
                    "t_trip" => t_trip,
                    "status" => string(status),
                    "series" => series,
                ),
            )
        catch err
            timings["tds_build_s"] = get(timings, "tds_build_s", 0.0)
            timings["tds_s"] = get(timings, "tds_s", 0.0)
            report_error(joinpath(out_dir, "tds.json"), err)
            failed = true
        end
    end

    # ---- Step 5: timings ------------------------------------------------------
    write_json(joinpath(out_dir, "timings.json"), timings)

    # ---- Step 6: summary line -------------------------------------------------
    summary = Dict{String, Any}("case" => case_name, "n_buses" => n_buses)
    merge!(summary, timings)
    io = stdout
    JSON3.write(io, summary)
    println(io)
    if !failed
        println("SPIKE OK")
    end
    return failed ? 1 : 0
end

exit(main())
