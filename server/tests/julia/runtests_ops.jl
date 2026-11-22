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
            TensaSiennaOps.dispatch_json(s; network_model = "ac")
            nothing
        catch e
            e
        end
        @test err isa ArgumentError
        @test occursin("network_model must be copper_plate, dc or ptdf, got ac", sprint(showerror, err))
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
end

println("TENSA SIENNA OPS TESTS OK")
