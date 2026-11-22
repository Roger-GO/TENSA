# runtests_dcpf.jl: tests of TensaSiennaNet's dc_pflow_json on the three-bus
# triangle of runtests_net.jl, with a load of 150 MW at bus 3 and generation
# of 100 MW at bus 1 and 50 MW at bus 2. Run as:
#   julia --project=<env> server/tests/julia/runtests_dcpf.jl

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

# The three-bus triangle with a load of 150 MW at bus 3 and generation of
# 100 MW at bus 1 (the reference) and 50 MW at bus 2. Generator 2 is rated
# 200 MVA and the system reads values on the device base, as a System read
# from a PSS/E file does: its 50 MW is 0.25 pu of its own rating, so a reader
# that takes a value off the device base as if it were on the system base
# reports 25 MW. Generator 1 is scheduled at 80 MW, not the 100 MW the
# balance gives it, so its reported output is the balance and not the
# schedule. The reference bus stores an angle of 0.3 rad, as a case read from
# a file stores its solved one, so the flows cannot depend on it and the
# reported angles are 0.3 rad above the ones solved against 0.
function three_bus_system()
    sys = PSY.System(100.0)
    bus1 = PSY.ACBus(;
        number = 1,
        name = "BUS1",
        available = true,
        bustype = PSY.ACBusTypes.REF,
        angle = 0.3,
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
    PSY.add_component!(
        sys,
        PSY.ThermalStandard(;
            name = "generator-1-1",
            available = true,
            status = true,
            bus = bus1,
            active_power = 0.8,
            reactive_power = 0.0,
            rating = 1.0,
            active_power_limits = (min = 0.0, max = 10.0),
            reactive_power_limits = (min = -10.0, max = 10.0),
            ramp_limits = nothing,
            operation_cost = PSY.ThermalGenerationCost(nothing),
            base_power = 100.0,
        ),
    )
    PSY.add_component!(
        sys,
        PSY.ThermalStandard(;
            name = "generator-2-1",
            available = true,
            status = true,
            bus = bus2,
            active_power = 0.25,
            reactive_power = 0.0,
            rating = 1.0,
            active_power_limits = (min = 0.0, max = 10.0),
            reactive_power_limits = (min = -10.0, max = 10.0),
            ramp_limits = nothing,
            operation_cost = PSY.ThermalGenerationCost(nothing),
            base_power = 200.0,
        ),
    )
    PSY.add_component!(
        sys,
        PSY.PowerLoad(;
            name = "load31",
            available = true,
            bus = bus3,
            active_power = 1.5,
            reactive_power = 0.3,
            base_power = 100.0,
            max_active_power = 1.5,
            max_reactive_power = 0.3,
        ),
    )
    PSY.set_units_base_system!(sys, "DEVICE_BASE")
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

@testset "TensaSiennaNet dc_pflow_json" begin
    s = three_bus_session()

    @testset "dc flows are the PTDF times the injections" begin
        answer = JSON3.read(TensaSiennaNet.dc_pflow_json(s; method = "dc"))
        @test answer[:converged] == true
        @test answer[:method] == "dc"
        @test answer[:tolerance] === nothing
        @test answer[:max_iterations] === nothing
        # Hand computation from the PTDF of runtests_net.jl. The injections
        # are +0.5 pu at bus 2 and -1.5 pu at bus 3 (the reference bus 1
        # balances). With the PTDF columns of the matrices unit's test
        # (line 1-2: bus 2 -2/3, bus 3 -1/3; line 1-3: bus 2 -1/3, bus 3
        # -2/3; line 2-3: bus 2 +1/3, bus 3 -1/3), the flows in per unit are:
        #   line 1-2: (-2/3)(0.5) + (-1/3)(-1.5) = -1/3 + 1/2 = 1/6
        #   line 1-3: (-1/3)(0.5) + (-2/3)(-1.5) = -1/6 + 1 = 5/6
        #   line 2-3: (+1/3)(0.5) + (-1/3)(-1.5) = 1/6 + 1/2 = 2/3
        # in the orientation the PTDF rows carry (from the line's first bus to
        # its second). On the 100 MVA base those are 16.667, 83.333 and
        # 66.667 MW. The sign of a reported flow follows the branch's own arc
        # orientation, read from the answer's from and to.
        flows = Dict{String, Float64}()
        for row in answer[:branches]
            flows[String(row[:name])] = Float64(row[:p_from_mw])
            @test row[:q_from_mvar] === nothing
            @test row[:q_to_mvar] === nothing
            @test Float64(row[:p_to_mw]) == -Float64(row[:p_from_mw])
        end
        @test abs(flows["1-2-i_1"] - 100.0 / 6.0) <= 1e-9
        @test abs(flows["1-3-i_1"] - 500.0 / 6.0) <= 1e-9
        @test abs(flows["2-3-i_1"] - 400.0 / 6.0) <= 1e-9
        # The slack picks up the balance: 150 - 50 = 100 MW at bus 1.
        gens = Dict{String, Float64}()
        for row in answer[:generators]
            gens[String(row[:name])] = Float64(row[:p_mw])
            @test row[:q_mvar] === nothing
        end
        @test abs(gens["generator-1-1"] - 100.0) <= 1e-9
        @test abs(gens["generator-2-1"] - 50.0) <= 1e-9
        for row in answer[:loads]
            @test row[:q_mvar] === nothing
        end
        @test Float64(answer[:loads][1][:p_mw]) == 150.0
        # Angles: solved against the reference at 0 (B' with b = 10 per line:
        # theta2 = -1/60 and theta3 = -1/12 rad, by hand), reported above the
        # reference's stored 0.3 rad.
        angles = Dict(Int(r[:number]) => Float64(r[:angle_rad]) for r in answer[:buses])
        @test abs(angles[1] - 0.3) <= 1e-12
        @test abs(angles[2] - (0.3 - 1 / 60)) <= 1e-9
        @test abs(angles[3] - (0.3 - 1 / 12)) <= 1e-9
        # Voltages: the setpoint at the PV and reference buses, 1.0 at the PQ bus.
        volts = Dict{Int, Float64}()
        for row in answer[:buses]
            volts[Int(row[:number])] = Float64(row[:v_pu])
        end
        @test volts[1] == 1.0
        @test volts[2] == 1.0
        @test volts[3] == 1.0
    end

    @testset "ptdf-dc agrees with dc" begin
        dc = JSON3.read(TensaSiennaNet.dc_pflow_json(s; method = "dc"))
        ptdf = JSON3.read(TensaSiennaNet.dc_pflow_json(s; method = "ptdf-dc"))
        @test ptdf[:method] == "ptdf-dc"
        dc_flows = Dict(String(r[:name]) => Float64(r[:p_from_mw]) for r in dc[:branches])
        for row in ptdf[:branches]
            @test abs(Float64(row[:p_from_mw]) - dc_flows[String(row[:name])]) <= 1e-9
        end
    end

    @testset "the session's system is untouched" begin
        before = [PSY.get_angle(b) for b in PSY.get_components(PSY.ACBus, s.sys)]
        TensaSiennaNet.dc_pflow_json(s; method = "dc")
        after = [PSY.get_angle(b) for b in PSY.get_components(PSY.ACBus, s.sys)]
        @test before == after
    end

    @testset "unknown method" begin
        err = try
            TensaSiennaNet.dc_pflow_json(s; method = "qndf")
            nothing
        catch e
            e
        end
        @test err isa ArgumentError
        @test occursin("unknown DC power flow method: qndf", sprint(showerror, err))
    end
end

println("TENSA SIENNA DCPF TESTS OK")
