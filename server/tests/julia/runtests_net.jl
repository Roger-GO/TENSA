# runtests_net.jl: tests of the TensaSiennaNet module on a three-bus case built
# in code. Run as:
#   julia --project=<env> server/tests/julia/runtests_net.jl
# The case is a triangle of buses 1, 2 and 3 with a line on each side, every
# line r = 0 and x = 0.1 pu, bus 1 the reference. The PTDF is worked by hand
# in the comment of the testset below.

using Test
using JSON3
using Logging

Logging.global_logger(Logging.ConsoleLogger(stderr, Logging.Warn))

include(joinpath(@__DIR__, "..", "..", "src", "tensa", "engines", "sienna", "julia", "TensaSienna.jl"))
include(joinpath(@__DIR__, "..", "..", "src", "tensa", "engines", "sienna", "julia", "TensaSiennaNet.jl"))
using .TensaSienna
using .TensaSiennaNet

const PSY = TensaSienna.PSY
const PNM = TensaSienna.PNM

# The three-bus triangle as a PowerSystems System built in code.
function three_bus_system()
    sys = PSY.System(100.0)
    bus1 = PSY.ACBus(;
        number = 1,
        name = "BUS1",
        available = true,
        bustype = PSY.ACBusTypes.REF,
        angle = 0.0,
        magnitude = 1.0,
        voltage_limits = (0.9, 1.1),
        base_voltage = 230.0,
    )
    bus2 = PSY.ACBus(;
        number = 2,
        name = "BUS2",
        available = true,
        bustype = PSY.ACBusTypes.PV,
        angle = 0.0,
        magnitude = 1.0,
        voltage_limits = (0.9, 1.1),
        base_voltage = 230.0,
    )
    bus3 = PSY.ACBus(;
        number = 3,
        name = "BUS3",
        available = true,
        bustype = PSY.ACBusTypes.PQ,
        angle = 0.0,
        magnitude = 1.0,
        voltage_limits = (0.9, 1.1),
        base_voltage = 230.0,
    )
    for bus in (bus1, bus2, bus3)
        PSY.add_component!(sys, bus)
    end
    for (name, from_bus, to_bus) in (
        ("1-2-i_1", bus1, bus2),
        ("1-3-i_1", bus1, bus3),
        ("2-3-i_1", bus2, bus3),
    )
        PSY.add_component!(
            sys,
            PSY.Line(;
                name = name,
                available = true,
                active_power_flow = 0.0,
                reactive_power_flow = 0.0,
                arc = PSY.Arc(; from = from_bus, to = to_bus),
                r = 0.0,
                x = 0.1,
                b = (from = 0.0, to = 0.0),
                rating = 0.0,
                angle_limits = (min = -pi / 2, max = pi / 2),
            ),
        )
    end
    return sys
end

function three_bus_session()
    sys = three_bus_system()
    return TensaSienna.Session(
        sys, "built", nothing, Dict{String, Any}[], Dict{String, Any}[],
        String[], Int[], Dict{String, Any}[], Dict{String, Any}[],
        mktempdir(), false,
    )
end

function read_matrix(file, rows, cols)
    values = reinterpret(Float64, read(file))
    @test length(values) == rows * cols
    return reshape(values, rows, cols)
end

@testset "TensaSiennaNet" begin
    s = three_bus_session()
    dir = mktempdir()

    @testset "ptdf" begin
        file = joinpath(dir, "ptdf.bin")
        answer = JSON3.read(TensaSiennaNet.network_matrix_json(s; kind = "ptdf", file = file))
        @test answer[:kind] == "ptdf"
        @test answer[:n_rows] == 3
        @test answer[:n_cols] == 3
        @test answer[:complex] == false
        @test answer[:file] == "ptdf.bin"
        @test answer[:files] == ["ptdf.bin"]
        @test answer[:distributed_slack] == false
        @test answer[:ref_buses] == [1]
        @test Set(Int.(answer[:cols])) == Set([1, 2, 3])
        arcs = [(Int(a[:from]), Int(a[:to])) for a in answer[:rows]]
        @test Set([minmax(a...) for a in arcs]) == Set([(1, 2), (1, 3), (2, 3)])
        data = read_matrix(file, 3, 3)
        # Hand computation. With an injection at a bus withdrawn at the
        # reference (bus 1), the reduced susceptance matrix over buses 2 and 3
        # is [[20, -10], [-10, 20]] (each line adds 1/x = 10 to the two
        # diagonals and -10 to the off-diagonal), whose inverse is
        # [[1/15, 1/30], [1/30, 1/15]]. The flow on line i-j is
        # (theta_i - theta_j) / x. For an injection at bus 2
        # (theta_2 = 1/15, theta_3 = 1/30): line 1-2 carries -2/3, line 1-3
        # -1/3, line 2-3 +1/3. For bus 3 (theta_2 = 1/30, theta_3 = 1/15):
        # line 1-2 carries -1/3, line 1-3 -2/3, line 2-3 -1/3. The reference
        # bus's column is zero. Signs are for flow from the line's first bus
        # to its second; the orientation is read from the axes.
        want = Dict(
            (1, 2) => Dict(2 => -2 / 3, 3 => -1 / 3),
            (1, 3) => Dict(2 => -1 / 3, 3 => -2 / 3),
            (2, 3) => Dict(2 => 1 / 3, 3 => -1 / 3),
        )
        bus_col = Dict(Int(b) => i for (i, b) in enumerate(answer[:cols]))
        for (row, arc) in enumerate(arcs)
            pair = minmax(arc...)
            sign = arc == pair ? 1.0 : -1.0
            for bus in (1, 2, 3)
                expected = bus == 1 ? 0.0 : sign * want[pair][bus]
                @test abs(data[row, bus_col[bus]] - expected) <= 1e-9
            end
        end
    end

    @testset "lodf" begin
        file = joinpath(dir, "lodf.bin")
        answer = JSON3.read(TensaSiennaNet.network_matrix_json(s; kind = "lodf", file = file))
        @test answer[:kind] == "lodf"
        @test answer[:n_rows] == 3
        @test answer[:n_cols] == 3
        @test answer[:rows] == answer[:cols]
        data = read_matrix(file, 3, 3)
        # PowerNetworkMatrices' convention: every diagonal entry is -1 (the
        # outaged line loses its whole flow). The outage of line 1-2 moves its
        # whole pre-outage flow onto the path 1-3-2: LODF(1-3, out 1-2) = 1
        # and LODF(2-3, out 1-2) = -1 in the 1-to-3 and 2-to-3 orientations.
        arcs = [(Int(a[:from]), Int(a[:to])) for a in answer[:rows]]
        for i in 1:3
            @test abs(data[i, i] + 1.0) <= 1e-9
        end
        out = findfirst(a -> minmax(a...) == (1, 2), arcs)
        for (i, arc) in enumerate(arcs)
            i == out && continue
            pair = minmax(arc...)
            sign = arc == pair ? 1.0 : -1.0
            expected = sign * (pair == (1, 3) ? 1.0 : -1.0)
            @test abs(data[i, out] - expected) <= 1e-9
        end
    end

    @testset "ybus" begin
        file = joinpath(dir, "ybus.bin")
        answer = JSON3.read(TensaSiennaNet.network_matrix_json(s; kind = "ybus", file = file))
        @test answer[:kind] == "ybus"
        @test answer[:complex] == true
        @test answer[:files] == ["ybus.bin.re", "ybus.bin.im"]
        @test !haskey(answer, :ref_buses)
        @test Set(Int.(answer[:rows])) == Set([1, 2, 3])
        re = read_matrix(file * ".re", 3, 3)
        im = read_matrix(file * ".im", 3, 3)
        # Each line is -1j / 0.1 = -10j siemens per unit: the diagonal of a
        # bus with two lines is -20j, the off-diagonal of a line +10j.
        @test re == zeros(3, 3)
        @test im == [-20.0 10.0 10.0; 10.0 -20.0 10.0; 10.0 10.0 -20.0]
    end

    @testset "incidence" begin
        file = joinpath(dir, "incidence.bin")
        answer = JSON3.read(TensaSiennaNet.network_matrix_json(s; kind = "incidence", file = file))
        @test answer[:kind] == "incidence"
        @test answer[:n_rows] == 3
        @test answer[:n_cols] == 3
        data = read_matrix(file, 3, 3)
        bus_col = Dict(Int(b) => i for (i, b) in enumerate(answer[:cols]))
        for (row, a) in enumerate(answer[:rows])
            @test sum(data[row, :]) == 0.0
            @test sort(data[row, :]) == [-1.0, 0.0, 1.0]
            @test data[row, bus_col[Int(a[:from])]] == 1.0
            @test data[row, bus_col[Int(a[:to])]] == -1.0
        end
    end

    @testset "unknown kind" begin
        err = try
            TensaSiennaNet.network_matrix_json(s; kind = "modf", file = joinpath(dir, "x.bin"))
            nothing
        catch e
            e
        end
        @test err isa ArgumentError
        @test occursin("unknown network matrix kind: modf", sprint(showerror, err))
    end
end

println("TENSA SIENNA NET TESTS OK")
