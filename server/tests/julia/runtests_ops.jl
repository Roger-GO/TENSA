# runtests_ops.jl: tests of TensaSiennaOps' dispatch_json, on MATPOWER cases
# the test writes into a temporary folder. Run as:
#   julia --project=<env> server/tests/julia/runtests_ops.jl
#
# The hand computations are beside each test. The cost unit is the one the
# hand-worked trial of the unit settled: PowerSystems reads a MATPOWER
# gencost model 2 row as QuadraticCurve(a, b, c) with the file's own numbers
# ($/MW^2h, $/MWh, $/h), and dispatch_json labels the curve as natural units
# before it builds the model, so the objective is the true cost in $/h of
# power in MW.

using Test
using JSON3
using Logging
using Dates

Logging.global_logger(Logging.ConsoleLogger(stderr, Logging.Warn))

include(joinpath(@__DIR__, "..", "..", "src", "tensa", "engines", "sienna", "julia", "TensaSienna.jl"))
include(joinpath(@__DIR__, "..", "..", "src", "tensa", "engines", "sienna", "julia", "TensaSiennaOps.jl"))
using .TensaSienna
using .TensaSiennaOps

const PSY = TensaSienna.PSY

# A two-generator one-load MATPOWER case: bus 1 the reference with generator
# A, bus 2 with generator B, bus 3 with a load of 150 MW, three lines of
# x = 0.1 pu on a 100 MVA base, each generator 0 to 200 MW with the ramp
# columns 0 (no data). `gencost_a` and `gencost_b` are the gencost
# rows (model 2, zero startup and shutdown, three coefficients). `mbase_b`
# is generator B's Mbase.
function two_gen_case(dir, gencost_a, gencost_b; mbase_b = 100.0)
    lines = [
        "function mpc = two_gen",
        "mpc.version = '2';",
        "mpc.baseMVA = 100.0;",
        "mpc.bus = [",
        "  1  3  0  0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;",
        "  2  2  0  0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;",
        "  3  1  150.0  30.0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;",
        "];",
        "mpc.gen = [",
        "  1  0  0  9999  -9999  1.0  100.0  1  200.0  0  0  0  0  0  0  0  0  0  0  0  0;",
        "  2  0  0  9999  -9999  1.0  $(mbase_b)  1  200.0  0  0  0  0  0  0  0  0  0  0  0  0;",
        "];",
        "mpc.branch = [",
        "  1  2  0.0  0.1  0.0  0  0  0  0  0  1  -360  360;",
        "  1  3  0.0  0.1  0.0  0  0  0  0  0  1  -360  360;",
        "  2  3  0.0  0.1  0.0  0  0  0  0  0  1  -360  360;",
        "];",
        "mpc.gencost = [",
        "  $(gencost_a);",
        "  $(gencost_b);",
        "];",
    ]
    path = joinpath(dir, "two_gen.m")
    write(path, join(lines, "\n") * "\n")
    return path
end

# The two-bus AC hand case: bus 1 the reference with generator A (10 $/MWh),
# bus 2 with generator B (20 $/MWh) and a load of P = 100 MW, Q = 30 MVAr,
# one line 1-2 of r = 0.02 pu, x = 0.1 pu, b = 0, no rating, on a 100 MVA
# base. The MATPOWER rows have exactly the format's columns: 13 for a bus,
# 21 for a generator (PMAX column 9, MBASE column 7), 13 for a branch.
function two_bus_ac_case(dir)
    lines = [
        "function mpc = two_bus",
        "mpc.version = '2';",
        "mpc.baseMVA = 100.0;",
        "mpc.bus = [",
        "  1  3  0  0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;",
        "  2  1  100.0  30.0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;",
        "];",
        "mpc.gen = [",
        "  1  0  0  9999  -9999  1.0  100.0  1  200.0  0  0  0  0  0  0  0  0  0  0  0  0;",
        "  2  0  0  9999  -9999  1.0  100.0  1  200.0  0  0  0  0  0  0  0  0  0  0  0  0;",
        "];",
        "mpc.branch = [",
        "  1  2  0.02  0.1  0.0  0  0  0  0  0  1  -360  360;",
        "];",
        "mpc.gencost = [",
        "  2  0  0  3  0.0  10.0  0.0;",
        "  2  0  0  3  0.0  20.0  0.0;",
        "];",
    ]
    path = joinpath(dir, "two_bus.m")
    write(path, join(lines, "\n") * "\n")
    return path
end

# The two-bus case with the line taken out: the load cannot be met.
function islanded_ac_case(dir)
    lines = [
        "function mpc = islanded",
        "mpc.version = '2';",
        "mpc.baseMVA = 100.0;",
        "mpc.bus = [",
        "  1  3  0  0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;",
        "  2  1  100.0  30.0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;",
        "];",
        "mpc.gen = [",
        "  1  0  0  9999  -9999  1.0  100.0  1  200.0  0  0  0  0  0  0  0  0  0  0  0  0;",
        "  2  0  0  9999  -9999  1.0  100.0  1  200.0  0  0  0  0  0  0  0  0  0  0  0  0;",
        "];",
        "mpc.branch = [",
        "  1  2  0.02  0.1  0.0  0  0  0  0  0  0  -360  360;",
        "];",
        "mpc.gencost = [",
        "  2  0  0  3  0.0  10.0  0.0;",
        "  2  0  0  3  0.0  20.0  0.0;",
        "];",
    ]
    path = joinpath(dir, "islanded.m")
    write(path, join(lines, "\n") * "\n")
    return path
end

# A three-bus case with a line limit that binds: generator A (bus 1,
# 10 $/MWh) and generator B (bus 2, 20 $/MWh), 100 MW each, meet a 150 MW load
# at bus 3 over a triangle of equal reactances, and the line 1-3 is rated
# 80 MVA.
function limited_case(dir)
    lines = [
        "function mpc = limited",
        "mpc.version = '2';",
        "mpc.baseMVA = 100.0;",
        "mpc.bus = [",
        "  1  3  0  0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;",
        "  2  2  0  0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;",
        "  3  1  150.0  30.0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;",
        "];",
        "mpc.gen = [",
        "  1  0  0  9999  -9999  1.0  100.0  1  100.0  0  0  0  0  0  0  0  0  0  0  0  0;",
        "  2  0  0  9999  -9999  1.0  100.0  1  100.0  0  0  0  0  0  0  0  0  0  0  0  0;",
        "];",
        "mpc.branch = [",
        "  1  2  0.0  0.1  0.0  0  0  0  0  0  1  -360  360;",
        "  1  3  0.0  0.1  0.0  80.0  0  0  0  0  1  -360  360;",
        "  2  3  0.0  0.1  0.0  0  0  0  0  0  1  -360  360;",
        "];",
        "mpc.gencost = [",
        "  2  0  0  3  0.0  10.0  0.0;",
        "  2  0  0  3  0.0  20.0  0.0;",
        "];",
    ]
    path = joinpath(dir, "limited.m")
    write(path, join(lines, "\n") * "\n")
    return path
end

# The same two-generator case without gencost.
function no_cost_case(dir)
    lines = [
        "function mpc = no_cost",
        "mpc.version = '2';",
        "mpc.baseMVA = 100.0;",
        "mpc.bus = [",
        "  1  3  0  0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;",
        "  2  2  0  0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;",
        "  3  1  150.0  30.0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;",
        "];",
        "mpc.gen = [",
        "  1  0  0  9999  -9999  1.0  100.0  1  100.0  0  0  0  0  0  0  0  0  0  0  0  0;",
        "  2  0  0  9999  -9999  1.0  100.0  1  100.0  0  0  0  0  0  0  0  0  0  0  0  0;",
        "];",
        "mpc.branch = [",
        "  1  2  0.0  0.1  0.0  0  0  0  0  0  1  -360  360;",
        "  1  3  0.0  0.1  0.0  0  0  0  0  0  1  -360  360;",
        "  2  3  0.0  0.1  0.0  0  0  0  0  0  1  -360  360;",
        "];",
    ]
    path = joinpath(dir, "no_cost.m")
    write(path, join(lines, "\n") * "\n")
    return path
end

function load_session(path)
    return TensaSienna.load_case(path; scratch = mktempdir())
end

# The dispatch in MW by component name: PowerSystems names a MATPOWER
# generator gen-<row of mpc.gen>, so A is gen-1 and B gen-2 (the route turns
# the names into keys through the session's key book).
function dispatch_of(answer)
    return Dict(String(row[:name]) => Float64(row[:p_mw]) for row in answer[:generators])
end

@testset "TensaSiennaOps dispatch_json" begin
    dir = mktempdir()

    @testset "linear costs: the cheaper generator takes the whole load" begin
        # Costs 10 and 20 $/MWh, load 150 MW, copper plate. By hand: the
        # cheaper generator A takes all 150 MW, B takes 0, the cost is
        # 150 * 10 = 1500 $/h.
        path = two_gen_case(dir, "2  0  0  3  0.0  10.0  0.0", "2  0  0  3  0.0  20.0  0.0")
        s = load_session(path)
        answer = JSON3.read(TensaSiennaOps.dispatch_json(s; network_model = "copper_plate"))
        @test answer[:status] == "completed"
        dispatch = dispatch_of(answer)
        @test abs(dispatch["gen-1"] - 150.0) <= 1e-6
        @test abs(dispatch["gen-2"] - 0.0) <= 1e-6
        @test abs(answer[:objective_per_h] - 1500.0) <= 1e-6 * 1500.0
        @test abs(answer[:objective_check_per_h] - 1500.0) <= 1e-6 * 1500.0
        @test abs(answer[:objective_per_h] - answer[:objective_check_per_h]) <= 1e-6 * 1500.0
        @test Float64(answer[:total_load_mw]) == 150.0
        @test abs(Float64(answer[:total_dispatch_mw]) - 150.0) <= 1e-6
        @test isempty(answer[:slacks])
        @test isempty(answer[:duals])
    end

    @testset "quadratic costs: equal marginal cost split" begin
        # A: 0.1 P^2 + 10 P, B: 0.1 P^2 + 20 P, load 150 MW. By hand: equal
        # marginal cost 0.2 PA + 10 = 0.2 PB + 20 with PA + PB = 150 gives
        # PA = 100 MW and PB = 50 MW; the cost is
        # 0.1*100^2 + 10*100 + 0.1*50^2 + 20*50 = 1000 + 1000 + 250 + 1000
        # = 3250 $/h. A wrong cost unit (the quadratic term weighed 100 times
        # too lightly) gives a different split, so the dispatch itself is the
        # check.
        path = two_gen_case(dir, "2  0  0  3  0.1  10.0  0.0", "2  0  0  3  0.1  20.0  0.0")
        s = load_session(path)
        answer = JSON3.read(TensaSiennaOps.dispatch_json(s; network_model = "copper_plate"))
        dispatch = dispatch_of(answer)
        @test abs(dispatch["gen-1"] - 100.0) <= 1e-4
        @test abs(dispatch["gen-2"] - 50.0) <= 1e-4
        @test abs(answer[:objective_per_h] - 3250.0) <= 1e-6 * 3250.0
        @test abs(answer[:objective_check_per_h] - 3250.0) <= 1e-6 * 3250.0
    end

    @testset "quadratic costs with a generator base that differs from the system's" begin
        # The same case with generator B's Mbase 200 MVA: the same answer.
        # Labelled DEVICE_BASE, as PowerSystems reads it, this case gives
        # 30 MW and 120 MW; in natural units the base does not enter.
        path = two_gen_case(
            dir, "2  0  0  3  0.1  10.0  0.0", "2  0  0  3  0.1  20.0  0.0"; mbase_b = 200.0
        )
        s = load_session(path)
        answer = JSON3.read(TensaSiennaOps.dispatch_json(s; network_model = "copper_plate"))
        dispatch = dispatch_of(answer)
        @test abs(dispatch["gen-1"] - 100.0) <= 1e-4
        @test abs(dispatch["gen-2"] - 50.0) <= 1e-4
        @test abs(answer[:objective_per_h] - 3250.0) <= 1e-6 * 3250.0
        @test abs(answer[:objective_check_per_h] - 3250.0) <= 1e-6 * 3250.0
    end

    @testset "dc and ptdf with a line limit that binds" begin
        # By hand: on a triangle of equal reactances, a megawatt from bus 1 to
        # bus 3 takes two thirds of its way over the direct line, and one from
        # bus 2 one third, so the flow on 1-3 is (2 PA + PB) / 3. With
        # PA + PB = 150 that is 50 + PA / 3. Without the limit A, the cheaper,
        # runs at its 100 MW (83.3 MW on 1-3); the 80 MW rating holds it to
        # PA = 90 MW, PB = 60 MW, at 10 * 90 + 20 * 60 = 2100 $/h, with the
        # line at its limit. The copper plate ignores the line: 100 and 50 MW.
        path = limited_case(dir)
        for model in ("dc", "ptdf")
            s = load_session(path)
            answer = JSON3.read(TensaSiennaOps.dispatch_json(s; network_model = model))
            @test answer[:status] == "completed"
            @test answer[:network_model] == model
            dispatch = dispatch_of(answer)
            pa = dispatch["gen-1"]
            pb = dispatch["gen-2"]
            @test abs(pa - 90.0) <= 1e-4
            @test abs(pb - 60.0) <= 1e-4
            @test abs((2 * pa + pb) / 3 - 80.0) <= 1e-4
            @test abs(answer[:objective_per_h] - 2100.0) <= 1e-6 * 2100.0
            @test abs(answer[:objective_check_per_h] - 2100.0) <= 1e-6 * 2100.0
            @test isempty(answer[:slacks])
        end
        s = load_session(path)
        answer = JSON3.read(TensaSiennaOps.dispatch_json(s; network_model = "copper_plate"))
        dispatch = dispatch_of(answer)
        @test abs(dispatch["gen-1"] - 100.0) <= 1e-4
        @test abs(dispatch["gen-2"] - 50.0) <= 1e-4
    end

    @testset "a StandardLoad is part of the balance" begin
        # A case read from PSS/E holds StandardLoad, which the economic
        # dispatch template does not model by itself: the two-generator case
        # with its PowerLoad replaced by a StandardLoad of the same 150 MW
        # must dispatch the same 150 MW on the cheaper generator.
        path = two_gen_case(dir, "2  0  0  3  0.0  10.0  0.0", "2  0  0  3  0.0  20.0  0.0")
        s = load_session(path)
        old = only(collect(PSY.get_components(PSY.PowerLoad, s.sys)))
        bus = PSY.get_bus(old)
        PSY.remove_component!(s.sys, old)
        PSY.add_component!(
            s.sys,
            PSY.StandardLoad(;
                name = "standard-3", available = true, bus = bus, base_power = 100.0,
                constant_active_power = 1.5, constant_reactive_power = 0.3,
                max_constant_active_power = 1.5, max_constant_reactive_power = 0.3,
            ),
        )
        answer = JSON3.read(TensaSiennaOps.dispatch_json(s; network_model = "copper_plate"))
        @test Float64(answer[:total_load_mw]) == 150.0
        @test abs(Float64(answer[:total_dispatch_mw]) - 150.0) <= 1e-6
        dispatch = dispatch_of(answer)
        @test abs(dispatch["gen-1"] - 150.0) <= 1e-6
        @test abs(answer[:objective_per_h] - 1500.0) <= 1e-6 * 1500.0
    end

    @testset "a case with no cost data is refused" begin
        path = no_cost_case(dir)
        s = load_session(path)
        err = try
            TensaSiennaOps.dispatch_json(s; network_model = "copper_plate")
            nothing
        catch e
            e
        end
        @test err isa ErrorException
        @test occursin(
            "the case has no generator cost data; economic dispatch needs gencost records",
            sprint(showerror, err),
        )
    end

    @testset "an unknown network model is refused" begin
        path = two_gen_case(dir, "2  0  0  3  0.0  10.0  0.0", "2  0  0  3  0.0  20.0  0.0")
        s = load_session(path)
        err = try
            TensaSiennaOps.dispatch_json(s; network_model = "sdp")
            nothing
        catch e
            e
        end
        @test err isa ArgumentError
        @test occursin("network_model must be copper_plate, dc, ptdf or ac, got sdp", sprint(showerror, err))
    end

    @testset "the session's system is unchanged" begin
        path = two_gen_case(dir, "2  0  0  3  0.0  10.0  0.0", "2  0  0  3  0.0  20.0  0.0")
        s = load_session(path)
        before = TensaSienna.topology_json(s)
        TensaSiennaOps.dispatch_json(s; network_model = "copper_plate")
        @test TensaSienna.topology_json(s) == before
        # No time series was added to the session's system.
        @test !PSY.has_time_series(first(collect(PSY.get_components(PSY.PowerLoad, s.sys))))
    end

    @testset "duals are read back when asked" begin
        path = limited_case(dir)
        s = load_session(path)
        answer = JSON3.read(TensaSiennaOps.dispatch_json(s; network_model = "dc", duals = true))
        @test answer[:status] == "completed"
        @test answer[:duals] isa AbstractVector
    end

    @testset "ac: the two-bus case" begin
        # Bus 1: generator A (10 $/MWh); bus 2: a load of 100 MW + 30 MVAr and
        # generator B (20 $/MWh); one line z = 0.02 + 0.1i pu on 100 MVA; both
        # voltages in [0.9, 1.1] pu and reactive power free. B's reactive power
        # costs nothing, so the optimum carries the active power alone over the
        # line, at the voltages that make its losses smallest. Worked outside
        # PowerSimulations, by a direct search over V1 and V2 with the angle
        # that delivers exactly 1.0 pu at bus 2 (the equations
        # S = V conj(I), I = (V1 - V2) / z): V1 = 1.1, V2 = 1.0855 pu at
        # -4.887 degrees, losses 1.7099 MW, A at 101.7099 MW for 1017.099 $/h,
        # B at 0 MW. The line's reactive losses are x / r times the active
        # ones: 8.5495 MVAr.
        path = two_bus_ac_case(dir)
        s = load_session(path)
        answer = JSON3.read(TensaSiennaOps.dispatch_json(s; network_model = "ac"))
        @test answer[:status] == "completed"
        @test answer[:network_model] == "ac"
        dispatch = dispatch_of(answer)
        @test abs(dispatch["gen-1"] - 101.7099) <= 1e-3
        @test abs(dispatch["gen-2"] - 0.0) <= 1e-4
        @test abs(answer[:objective_per_h] - 1017.099) <= 1e-2
        @test abs(answer[:objective_check_per_h] - answer[:objective_per_h]) <= 1e-6 * 1017.099
        bus1 = only([row for row in answer[:buses] if Int(row[:bus]) == 1])
        bus2 = only([row for row in answer[:buses] if Int(row[:bus]) == 2])
        @test abs(Float64(bus1[:v_pu]) - 1.1) <= 1e-4
        @test abs(Float64(bus2[:v_pu]) - 1.0855) <= 1e-4
        @test abs(Float64(bus2[:angle_rad]) - (-4.887 * pi / 180)) <= 1e-3 * pi / 180
        branch = only(answer[:branches])
        @test abs(Float64(branch[:losses_mw]) - 1.7099) <= 1e-3
        @test abs(Float64(branch[:p_from_mw]) + Float64(branch[:p_to_mw]) - Float64(branch[:losses_mw])) <= 1e-9
        @test abs(Float64(answer[:total_losses_mw]) - 1.7099) <= 1e-3
        @test abs(
            Float64(answer[:total_dispatch_mw]) - Float64(answer[:total_load_mw]) -
            Float64(answer[:total_losses_mw])
        ) <= 1e-3
        @test isempty(answer[:slacks])
        q_of = Dict(String(row[:name]) => Float64(row[:q_mvar]) for row in answer[:generators])
        @test abs(Float64(branch[:losses_mvar]) - 8.5495) <= 1e-2
        @test abs(q_of["gen-1"] + q_of["gen-2"] - (30.0 + Float64(branch[:losses_mvar]))) <= 1e-3
    end

    @testset "ac: the session's system is unchanged" begin
        path = two_bus_ac_case(dir)
        s = load_session(path)
        before = TensaSienna.topology_json(s)
        TensaSiennaOps.dispatch_json(s; network_model = "ac")
        @test TensaSienna.topology_json(s) == before
        @test !PSY.has_time_series(first(collect(PSY.get_components(PSY.PowerLoad, s.sys))))
    end

    @testset "ac: a load the model cannot meet is an error" begin
        # The two-bus case with the line out of service: the load at bus 2
        # cannot be reached, so the balance cannot hold and the error names
        # the losses.
        path = islanded_ac_case(dir)
        s = load_session(path)
        err = try
            TensaSiennaOps.dispatch_json(s; network_model = "ac")
            nothing
        catch e
            e
        end
        @test err isa ErrorException
        message = sprint(showerror, err)
        @test startswith(message, "economic dispatch did not meet the load:") ||
              occursin("economic dispatch did not", message)
    end

    # ---- uc_json ---------------------------------------------------------------

    # The hand-worked unit commitment case: generator A (bus 1), 10 $/MWh,
    # PMIN 50 MW, PMAX 200 MW, start-up 500 $ (the gencost row's second
    # number), no fixed term; generator B (bus 2), 30 $/MWh, PMIN 0,
    # PMAX 200 MW, no start-up cost; a load of 100 MW at bus 3 whose profile
    # is 40, 120, 150, 40 MW over four hours (factors 0.4, 1.2, 1.5, 0.4).
    # Every generator starts off, so one on in period 1 pays a start-up.
    #
    # A cannot run in an hour of 40 MW: its minimum is 50 and nothing can
    # absorb the surplus (copper plate, no sink), so every pattern with A on
    # in period 1 or 4 is infeasible: {1}, {4}, {1,2}, {1,3}, {1,4}, {2,4},
    # {3,4}, {1,2,3}, {1,2,4}, {1,3,4}, {2,3,4}, {1,2,3,4}. Of the rest, B
    # serves hours 1 and 4 at 30 $/MWh: 30 * (40 + 40) = 2400 $.
    #   {}:      B alone: 30 * (40+120+150+40) = 10500 $
    #   {2}:     one start; A at 120, B at 40+150+40:
    #            500 + 10*120 + 30*230 = 500 + 1200 + 6900 = 8600 $
    #   {3}:     one start; A at 150, B at 40+120+40:
    #            500 + 10*150 + 30*200 = 500 + 1500 + 6000 = 8000 $
    #   {2,3}:   one start; A at 120 and 150, B at 40+40:
    #            500 + 10*(120+150) + 30*80 = 500 + 2700 + 2400 = 5600 $
    # The optimum is A on in hours 2 and 3 with one start-up: 5600 $, split
    # energy 10*270 + 30*80 = 5100 $, start-up 500 $, fixed 0 $.
    function uc_case(dir; startup_a = 500.0)
        lines = [
            "function mpc = uc_case",
            "mpc.version = '2';",
            "mpc.baseMVA = 100.0;",
            "mpc.bus = [",
            "  1  3  0  0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;",
            "  2  2  0  0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;",
            "  3  1  100.0  30.0  0  0  1  1.0  0.0  230.0  1  1.1  0.9;",
            "];",
            "mpc.gen = [",
            "  1  0  0  9999  -9999  1.0  100.0  1  200.0  50.0  0  0  0  0  0  0  0  0  0  0  0;",
            "  2  0  0  9999  -9999  1.0  100.0  1  200.0  0  0  0  0  0  0  0  0  0  0  0  0;",
            "];",
            "mpc.branch = [",
            "  1  2  0.0  0.1  0.0  0  0  0  0  0  1  -360  360;",
            "  1  3  0.0  0.1  0.0  0  0  0  0  0  1  -360  360;",
            "  2  3  0.0  0.1  0.0  0  0  0  0  0  1  -360  360;",
            "];",
            "mpc.gencost = [",
            "  2  $(startup_a)  0  3  0.0  10.0  0.0;",
            "  2  0  0  3  0.0  30.0  0.0;",
            "];",
        ]
        path = joinpath(dir, "uc_case.m")
        write(path, join(lines, "\n") * "\n")
        return path
    end

    # The case facts' generator_ops rows for the case: the start-up cost the
    # Python side reads from the gencost row's second number and sends
    # because PowerSystems does not carry it into ThermalGenerationCost.
    function uc_ops(startup_a)
        return JSON3.write([
            Dict("bus" => 1, "gen_id" => "1", "startup_usd" => startup_a),
            Dict("bus" => 2, "gen_id" => "1", "startup_usd" => 0.0),
        ])
    end

    function uc_of(answer)
        return Dict(String(row[:name]) => row for row in answer[:generators])
    end

    @testset "uc: the hand-worked optimum" begin
        path = uc_case(dir)
        s = load_session(path)
        answer = JSON3.read(TensaSiennaOps.uc_json(
            s;
            network_model = "copper_plate",
            horizon_h = 4,
            resolution_min = 60,
            series_json = "[0.4, 1.2, 1.5, 0.4]",
            overrides_json = "{}",
            ops_json = uc_ops(500.0),
        ))
        @test answer[:status] == "completed"
        @test answer[:horizon_h] == 4
        @test answer[:resolution_min] == 60
        @test length(answer[:periods]) == 4
        gens = uc_of(answer)
        @test [Bool(v) for v in gens["gen-1"][:on]] == [false, true, true, false]
        # B (no minimum, no start-up, no fixed cost) on at 0 MW costs nothing,
        # so its on/off pattern in hours 2 and 3 is not unique: only its MW is.
        @test all(abs.(Float64.(gens["gen-1"][:p_mw]) .- [0.0, 120.0, 150.0, 0.0]) .<= 1e-4)
        @test all(abs.(Float64.(gens["gen-2"][:p_mw]) .- [40.0, 0.0, 0.0, 40.0]) .<= 1e-4)
        @test abs(Float64(answer[:cost][:energy]) - 5100.0) <= 1e-6 * 5100.0
        @test abs(Float64(answer[:cost][:startup]) - 500.0) <= 1e-6 * 500.0
        @test abs(Float64(answer[:cost][:fixed]) - 0.0) <= 1e-6
        @test abs(Float64(answer[:cost][:total]) - 5600.0) <= 1e-6 * 5600.0
        @test abs(Float64(answer[:objective]) - 5600.0) <= 1e-6 * 5600.0
        @test abs(Float64(answer[:objective_check]) - 5600.0) <= 1e-6 * 5600.0
        @test isempty(answer[:slacks])
        @test Float64.(answer[:total_load_mw]) == [40.0, 120.0, 150.0, 40.0]
        # The per-generator split: A's energy 10 * 270 = 2700 $, one start
        # 500 $; B's energy 30 * 80 = 2400 $.
        @test abs(Float64(gens["gen-1"][:energy]) - 2700.0) <= 1e-6 * 2700.0
        @test abs(Float64(gens["gen-1"][:startup]) - 500.0) <= 1e-6 * 500.0
        @test abs(Float64(gens["gen-2"][:energy]) - 2400.0) <= 1e-6 * 2400.0
        @test abs(Float64(gens["gen-2"][:startup]) - 0.0) <= 1e-6
    end

    @testset "uc: start-up from an override when the gencost row has none" begin
        # The same case with A's STARTUP column 0: the request's override
        # adds what the column would have given, and the answer is the same
        # 5600 $ optimum. A wrong implementation that drops the override
        # answers a different cost.
        path = uc_case(dir; startup_a = 0.0)
        s = load_session(path)
        answer = JSON3.read(TensaSiennaOps.uc_json(
            s;
            network_model = "copper_plate",
            horizon_h = 4,
            resolution_min = 60,
            series_json = "[0.4, 1.2, 1.5, 0.4]",
            overrides_json = "{\"gen-1\": {\"startup_cost\": 500.0}}",
            ops_json = uc_ops(0.0),
        ))
        gens = uc_of(answer)
        @test [Bool(v) for v in gens["gen-1"][:on]] == [false, true, true, false]
        @test abs(Float64(answer[:cost][:total]) - 5600.0) <= 1e-6 * 5600.0
        @test abs(Float64(answer[:cost][:startup]) - 500.0) <= 1e-6 * 500.0
    end

    @testset "uc: a must-run override that cannot be met is an error" begin
        # A must run in every period, but hour 1's load is 40 MW and A's
        # minimum is 50: infeasible.
        path = uc_case(dir)
        s = load_session(path)
        err = try
            TensaSiennaOps.uc_json(
                s;
                network_model = "copper_plate",
                horizon_h = 4,
                resolution_min = 60,
                series_json = "[0.4, 1.2, 1.5, 0.4]",
                overrides_json = "{\"gen-1\": {\"must_run\": true}}",
                ops_json = uc_ops(500.0),
            )
            nothing
        catch e
            e
        end
        @test err isa ErrorException
        @test occursin("unit commitment did not", sprint(showerror, err))
    end

    @testset "uc: a minimum up time keeps A off" begin
        # With a minimum up time of 3 hours, A started in hour 2 (its only
        # useful start) would have to run hours 2 to 4, all inside the
        # horizon, and in hour 4 it cannot run (40 MW < PMIN 50); started in
        # hour 1 it cannot run either. So A stays off and B serves the whole
        # 350 MWh at 30 $/MWh: 10500 $, against the 5600 $ optimum an
        # implementation that drops the override answers.
        path = uc_case(dir)
        s = load_session(path)
        answer = JSON3.read(TensaSiennaOps.uc_json(
            s;
            network_model = "copper_plate",
            horizon_h = 4,
            resolution_min = 60,
            series_json = "[0.4, 1.2, 1.5, 0.4]",
            overrides_json = "{\"gen-1\": {\"min_up_h\": 3.0}}",
            ops_json = uc_ops(500.0),
        ))
        gens = uc_of(answer)
        @test [Bool(v) for v in gens["gen-1"][:on]] == [false, false, false, false]
        @test all(abs.(Float64.(gens["gen-2"][:p_mw]) .- [40.0, 120.0, 150.0, 40.0]) .<= 1e-4)
        @test abs(Float64(answer[:cost][:total]) - 10500.0) <= 1e-6 * 10500.0
    end

    @testset "uc: a series of the wrong length is refused" begin
        path = uc_case(dir)
        s = load_session(path)
        err = try
            TensaSiennaOps.uc_json(
                s;
                network_model = "copper_plate",
                horizon_h = 4,
                resolution_min = 60,
                series_json = "[1.0, 1.0]",
                overrides_json = "{}",
                ops_json = uc_ops(500.0),
            )
            nothing
        catch e
            e
        end
        @test err isa ArgumentError
        @test occursin(
            "the series block must give one positive finite factor per period",
            sprint(showerror, err),
        )
    end

    @testset "uc: an override of a generator the case lacks is refused" begin
        path = uc_case(dir)
        s = load_session(path)
        err = try
            TensaSiennaOps.uc_json(
                s;
                network_model = "copper_plate",
                horizon_h = 4,
                resolution_min = 60,
                series_json = "[0.4, 1.2, 1.5, 0.4]",
                overrides_json = "{\"gen-9\": {\"must_run\": true}}",
                ops_json = uc_ops(500.0),
            )
            nothing
        catch e
            e
        end
        @test err isa ArgumentError
        @test occursin("no generator named gen-9", sprint(showerror, err))
    end

    @testset "uc: the session's system is unchanged" begin
        path = uc_case(dir)
        s = load_session(path)
        before = TensaSienna.topology_json(s)
        TensaSiennaOps.uc_json(
            s;
            network_model = "copper_plate",
            horizon_h = 4,
            resolution_min = 60,
            series_json = "[0.4, 1.2, 1.5, 0.4]",
            overrides_json = "{}",
            ops_json = uc_ops(500.0),
        )
        @test TensaSienna.topology_json(s) == before
        @test !PSY.has_time_series(first(collect(PSY.get_components(PSY.PowerLoad, s.sys))))
    end

    @testset "uc: a case with no cost data is refused" begin
        path = no_cost_case(dir)
        s = load_session(path)
        err = try
            TensaSiennaOps.uc_json(
                s;
                network_model = "copper_plate",
                horizon_h = 4,
                resolution_min = 60,
                series_json = "[1.0, 1.0, 1.0, 1.0]",
                overrides_json = "{}",
                ops_json = "null",
            )
            nothing
        catch e
            e
        end
        @test err isa ErrorException
        @test occursin(
            "the case has no generator cost data; economic dispatch needs gencost records",
            sprint(showerror, err),
        )
    end

    @testset "a four-period profile becomes the load's series and one four-period forecast" begin
        # A four-period profile on the two-generator case's load (PowerSystems
        # names a MATPOWER load after its bus: bus3): factors 1.0, 1.1, 0.9,
        # 1.2 an hour apart. The series holds the factors, scaled by the
        # load's max_active_power (150 MW), and the forecast made of it spans
        # the four hours in one window.
        path = two_gen_case(dir, "2  0  0  3  0.0  10.0  0.0", "2  0  0  3  0.0  20.0  0.0")
        s = load_session(path)
        sys = deepcopy(s.sys)
        payload = JSON3.write(Dict(
            "start" => "2026-01-01T00:00:00",
            "resolution_s" => 3600,
            "steps" => 4,
            "loads" => [Dict("name" => "bus3", "factors" => [1.0, 1.1, 0.9, 1.2])],
        ))
        TensaSiennaOps.apply_series!(sys, payload)
        load = PSY.get_component(PSY.PowerLoad, sys, "bus3")
        @test load !== nothing
        ts = PSY.get_time_series(PSY.SingleTimeSeries, load, "max_active_power")
        @test collect(values(PSY.get_data(ts))) == [1.0, 1.1, 0.9, 1.2]
        @test PSY.IS.get_scaling_factor_multiplier(ts) === PSY.get_max_active_power
        @test PSY.get_max_active_power(load) * PSY.get_base_power(sys) == 150.0
        forecast = PSY.get_time_series(PSY.DeterministicSingleTimeSeries, load, "max_active_power")
        @test PSY.get_horizon(forecast) == Hour(4)
        # One window over the whole profile: PowerSystems records its interval as 0.
        @test PSY.IS.get_interval(forecast) == Second(0)
        # The session's own system is untouched.
        @test !PSY.has_time_series(PSY.get_component(PSY.PowerLoad, s.sys, "bus3"))
    end

    # ---- sim_json ---------------------------------------------------------------

    # The hand-worked simulation case is the uc case above: generator A
    # (bus 1), 10 $/MWh, PMIN 50 MW, PMAX 200 MW, start-up 500 $; generator B
    # (bus 2), 30 $/MWh, PMIN 0, PMAX 200 MW, no start-up cost; a load of
    # 100 MW at bus 3 whose profile is 40, 120, 150, 40 MW over the first
    # four hours and 40 MW for the rest of the day (the 96-step profile holds
    # each hour's factor for its four quarter-hours). The day-ahead
    # enumeration of the first four hours is beside uc_case: A on in hours 2
    # and 3 with one start-up, A at 120 and 150 MW, B at 40 MW in hours 1 and
    # 4. Hours 5 to 24 are 40 MW each, which A's 50 MW minimum cannot serve,
    # so B serves them at 30 $/MWh. The day-ahead cost is energy
    # 10 * (120 + 150) + 30 * 40 * 22 = 2700 + 26400 = 29100 $ plus one
    # start-up of 500 $: 29600 $. The real-time stage, held to that
    # commitment, dispatches each 15-minute period of an hour at that hour's
    # day-ahead MW (A 0, 120, 150, 0; B 40, 0, 0, 40, then B at 40 MW), and
    # its cost is the energy alone: 29100 $.
    function sim_profile()
        return vcat(fill(0.4, 4), fill(1.2, 4), fill(1.5, 4), fill(0.4, 84))
    end

    function sim_of(answer, stage_name, field)
        stage = only([st for st in answer[:stages] if String(st[:name]) == stage_name])
        return Dict(String(row[:name]) => Float64.(row[field]) for row in stage[field == :on ? :commitment : :dispatch])
    end

    @testset "sim: the hand-worked two-stage day" begin
        path = uc_case(dir)
        s = load_session(path)
        scratch_before = Set(readdir(s.scratch))
        answer = JSON3.read(TensaSiennaOps.sim_json(
            s;
            load_profile = sim_profile(),
            network_model = "copper_plate",
            ops_json = uc_ops(500.0),
        ))
        @test answer[:status] == "completed"
        @test answer[:interval_minutes] == 60
        @test length(answer[:stages]) == 2
        da = only([st for st in answer[:stages] if String(st[:name]) == "DA"])
        rt = only([st for st in answer[:stages] if String(st[:name]) == "RT"])
        @test da[:kind] == "uc"
        @test da[:resolution_minutes] == 60
        @test da[:steps] == 24
        @test rt[:kind] == "dispatch"
        @test rt[:resolution_minutes] == 15
        @test rt[:steps] == 96
        on = sim_of(answer, "DA", :on)
        p_da = sim_of(answer, "DA", :p_mw)
        p_rt = sim_of(answer, "RT", :p_mw)
        # The day-ahead commitment: A on in hours 2 and 3 only.
        @test on["gen-1"] == vcat([0.0, 1.0, 1.0], fill(0.0, 21))
        # The day-ahead dispatch: A 0, 120, 150, 0; B 40, 0, 0, 40, then B at
        # 40 MW for the rest of the day.
        @test all(abs.(p_da["gen-1"][1:4] .- [0.0, 120.0, 150.0, 0.0]) .<= 1e-4)
        @test all(abs.(p_da["gen-1"][5:24]) .<= 1e-6)
        @test all(abs.(p_da["gen-2"][1:4] .- [40.0, 0.0, 0.0, 40.0]) .<= 1e-4)
        @test all(abs.(p_da["gen-2"][5:24] .- 40.0) .<= 1e-4)
        # The feed-forward: every 15-minute period of hours 1 and 4 to 24 has
        # A at 0 MW (without it the real-time stage is free to run A whenever
        # it is locally cheaper), and each period of hours 2 and 3 is at the
        # hour's day-ahead MW.
        for t in vcat(1:4, 13:96)
            @test abs(p_rt["gen-1"][t]) <= 1e-6
        end
        @test all(abs.(p_rt["gen-1"][5:8] .- 120.0) .<= 1e-4)
        @test all(abs.(p_rt["gen-1"][9:12] .- 150.0) .<= 1e-4)
        @test all(abs.(p_rt["gen-2"][1:4] .- 40.0) .<= 1e-4)
        @test all(abs.(p_rt["gen-2"][13:96] .- 40.0) .<= 1e-4)
        # The costs, recomputed from each stage's dispatch: DA 29600 $ (energy
        # 29100, one start-up 500, fixed 0), RT the energy alone, 29100 $.
        @test abs(Float64(da[:objective]) - 29600.0) <= 1e-6 * 29600.0
        @test abs(Float64(rt[:objective]) - 29100.0) <= 1e-6 * 29100.0
        @test isempty(answer[:slacks])
        # The store went under the session's scratch and is removed.
        @test startswith(String(answer[:store_dir]), "sim-")
        @test Set(readdir(s.scratch)) == scratch_before
    end

    @testset "sim: a bad profile is refused" begin
        path = uc_case(dir)
        s = load_session(path)
        err = try
            TensaSiennaOps.sim_json(s; load_profile = fill(1.0, 95))
            nothing
        catch e
            e
        end
        @test err isa ArgumentError
        @test occursin(
            "load_profile must hold 96 numbers, one per 15-minute step of the day",
            sprint(showerror, err),
        )
        err = try
            TensaSiennaOps.sim_json(s; load_profile = vcat(fill(1.0, 95), [-0.5]))
            nothing
        catch e
            e
        end
        @test err isa ArgumentError
        @test occursin("load_profile entries must be finite numbers >= 0", sprint(showerror, err))
    end

    @testset "sim: an unknown network model is refused" begin
        path = uc_case(dir)
        s = load_session(path)
        err = try
            TensaSiennaOps.sim_json(s; load_profile = sim_profile(), network_model = "sdp")
            nothing
        catch e
            e
        end
        @test err isa ArgumentError
        @test occursin("network_model must be copper_plate, dc, ptdf or ac, got sdp", sprint(showerror, err))
    end

    @testset "sim: a case with no cost data is refused" begin
        path = no_cost_case(dir)
        s = load_session(path)
        err = try
            TensaSiennaOps.sim_json(s; load_profile = sim_profile())
            nothing
        catch e
            e
        end
        @test err isa ErrorException
        @test occursin(
            "the case has no generator cost data; economic dispatch needs gencost records",
            sprint(showerror, err),
        )
    end

    @testset "sim: the session's system is unchanged" begin
        path = uc_case(dir)
        s = load_session(path)
        before = TensaSienna.topology_json(s)
        TensaSiennaOps.sim_json(
            s;
            load_profile = sim_profile(),
            network_model = "copper_plate",
            ops_json = uc_ops(500.0),
        )
        @test TensaSienna.topology_json(s) == before
        @test !PSY.has_time_series(first(collect(PSY.get_components(PSY.PowerLoad, s.sys))))
    end
end

println("TENSA SIENNA OPS TESTS OK")
