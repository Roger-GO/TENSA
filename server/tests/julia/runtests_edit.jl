# runtests_edit.jl: tests of apply_edits! on a case built in code. Run as:
#   julia --project=<env> server/tests/julia/runtests_edit.jl
# Every editable field is set and read back, a load and a shunt are added and
# a load removed.

using Test
using JSON3
using Logging

Logging.global_logger(Logging.ConsoleLogger(stderr, Logging.Warn))

include(joinpath(@__DIR__, "..", "..", "src", "tensa", "engines", "sienna", "julia", "TensaSienna.jl"))
using .TensaSienna

const PSY = TensaSienna.PSY

function edit_test_session()
    sys = PSY.System(100.0)
    bus1 = PSY.ACBus(;
        number = 1, name = "BUS1", available = true, bustype = PSY.ACBusTypes.REF,
        angle = 0.0, magnitude = 1.0, voltage_limits = (0.9, 1.1), base_voltage = 230.0,
    )
    bus7 = PSY.ACBus(;
        number = 7, name = "BUS7", available = true, bustype = PSY.ACBusTypes.PQ,
        angle = 0.0, magnitude = 1.0, voltage_limits = (0.9, 1.1), base_voltage = 230.0,
    )
    PSY.add_component!(sys, bus1)
    PSY.add_component!(sys, bus7)
    PSY.add_component!(
        sys,
        PSY.Line(;
            name = "1-7-i_1", available = true, active_power_flow = 0.0,
            reactive_power_flow = 0.0, arc = PSY.Arc(; from = bus1, to = bus7),
            r = 0.01, x = 0.1, b = (from = 0.0, to = 0.0), rating = 0.0,
            angle_limits = (min = -pi / 2, max = pi / 2),
        ),
    )
    PSY.add_component!(
        sys,
        PSY.ThermalStandard(;
            name = "generator-1-1", available = true, status = true, bus = bus1,
            active_power = 1.0, reactive_power = 0.0, rating = 1.0,
            active_power_limits = (min = 0.0, max = 2.0),
            reactive_power_limits = (min = -1.0, max = 1.0),
            ramp_limits = nothing, time_limits = nothing, base_power = 100.0,
            operation_cost = PSY.ThermalGenerationCost(nothing),
        ),
    )
    PSY.add_component!(
        sys,
        PSY.PowerLoad(;
            name = "load71", available = true, bus = bus7, base_power = 100.0,
            active_power = 0.5, reactive_power = 0.1,
            max_active_power = 0.5, max_reactive_power = 0.1,
        ),
    )
    PSY.add_component!(
        sys,
        PSY.FixedAdmittance(;
            name = "7-1", available = true, bus = bus7, Y = complex(0.0, 0.2),
        ),
    )
    return TensaSienna.Session(
        sys, "built", nothing, Dict{String, Any}[], Dict{String, Any}[],
        String[], Int[], Dict{String, Any}[], Dict{String, Any}[],
        mktempdir(), false,
    )
end

@testset "apply_edits!" begin
    s = edit_test_session()
    sys = s.sys

    edits = JSON3.write([
        Dict("op" => "set", "key" => "load:7-1", "name" => "load71", "field" => "p_mw", "value" => 80.0),
        Dict("op" => "set", "key" => "load:7-1", "name" => "load71", "field" => "q_mvar", "value" => 20.0),
        Dict("op" => "set", "key" => "load:7-1", "name" => "load71", "field" => "in_service", "value" => false),
        Dict("op" => "set", "key" => "gen:1-1", "name" => "generator-1-1", "field" => "p_mw", "value" => 120.0),
        Dict("op" => "set", "key" => "gen:1-1", "name" => "generator-1-1", "field" => "v_set_pu", "value" => 1.02),
        Dict("op" => "set", "key" => "gen:1-1", "name" => "generator-1-1", "field" => "in_service", "value" => false),
        Dict("op" => "set", "key" => "branch:1-7-1", "name" => "1-7-i_1", "field" => "in_service", "value" => false),
        Dict("op" => "set", "key" => "shunt:7-1", "name" => "7-1", "field" => "g_mw", "value" => 5.0),
        Dict("op" => "set", "key" => "shunt:7-1", "name" => "7-1", "field" => "b_mvar", "value" => 30.0),
        Dict("op" => "set", "key" => "shunt:7-1", "name" => "7-1", "field" => "in_service", "value" => false),
        Dict("op" => "add", "key" => "load:7-2", "fields" => Dict("bus" => 7, "p_mw" => 10.0, "q_mvar" => 2.0)),
        Dict("op" => "add", "key" => "shunt:7-2", "fields" => Dict("bus" => 7, "g_mw" => 1.0, "b_mvar" => 4.0)),
        Dict("op" => "remove", "key" => "load:7-2", "name" => "load7-2"),
    ])
    answer = JSON3.read(TensaSienna.apply_edits_json(s, edits))
    @test length(answer[:applied]) == 13
    @test length(answer[:refused]) == 0

    PSY.with_units_base(sys, PSY.UnitSystem.SYSTEM_BASE) do
        load = PSY.get_component(PSY.PowerLoad, sys, "load71")
        @test PSY.get_active_power(load) * 100.0 == 80.0
        @test PSY.get_reactive_power(load) * 100.0 == 20.0
        @test PSY.get_available(load) == false
        gen = PSY.get_component(PSY.ThermalStandard, sys, "generator-1-1")
        @test PSY.get_active_power(gen) * 100.0 == 120.0
        @test PSY.get_available(gen) == false
        bus1 = PSY.get_component(PSY.ACBus, sys, "BUS1")
        @test PSY.get_magnitude(bus1) == 1.02
        branch = PSY.get_component(PSY.Line, sys, "1-7-i_1")
        @test PSY.get_available(branch) == false
        shunt = PSY.get_component(PSY.FixedAdmittance, sys, "7-1")
        @test real(PSY.get_Y(shunt)) * 100.0 == 5.0
        @test imag(PSY.get_Y(shunt)) * 100.0 == 30.0
        @test PSY.get_available(shunt) == false
        added = PSY.get_component(PSY.FixedAdmittance, sys, "7-2")
        @test added !== nothing
        @test real(PSY.get_Y(added)) * 100.0 == 1.0
        @test imag(PSY.get_Y(added)) * 100.0 == 4.0
        # The added load was removed again.
        @test PSY.get_component(PSY.PowerLoad, sys, "load7-2") === nothing
    end

    # A refusal does not stop the log.
    s2 = edit_test_session()
    bad = JSON3.write([
        Dict("op" => "set", "key" => "load:9-1", "name" => "load91", "field" => "p_mw", "value" => 1.0),
        Dict("op" => "set", "key" => "load:7-1", "name" => "load71", "field" => "p_mw", "value" => 60.0),
    ])
    answer2 = JSON3.read(TensaSienna.apply_edits_json(s2, bad))
    @test length(answer2[:refused]) == 1
    @test length(answer2[:applied]) == 1
    PSY.with_units_base(s2.sys, PSY.UnitSystem.SYSTEM_BASE) do
        load = PSY.get_component(PSY.PowerLoad, s2.sys, "load71")
        @test PSY.get_active_power(load) * 100.0 == 60.0
    end
end


@testset "a PV bus whose generators are all out of service becomes PQ" begin
    s = edit_test_session()
    sys = s.sys
    bus2 = PSY.ACBus(;
        number = 2, name = "BUS2", available = true, bustype = PSY.ACBusTypes.PV,
        angle = 0.0, magnitude = 1.0, voltage_limits = (0.9, 1.1), base_voltage = 230.0,
    )
    PSY.add_component!(sys, bus2)
    PSY.add_component!(
        sys,
        PSY.ThermalStandard(;
            name = "generator-2-1", available = true, status = true, bus = bus2,
            active_power = 0.5, reactive_power = 0.0, rating = 1.0,
            active_power_limits = (min = 0.0, max = 2.0),
            reactive_power_limits = (min = -1.0, max = 1.0),
            ramp_limits = nothing, time_limits = nothing, base_power = 100.0,
            operation_cost = PSY.ThermalGenerationCost(nothing),
        ),
    )
    edits = JSON3.write([
        Dict("op" => "set", "key" => "gen:2-1", "name" => "generator-2-1", "field" => "in_service", "value" => false),
    ])
    answer = JSON3.read(TensaSienna.apply_edits_json(s, edits))
    @test length(answer[:refused]) == 0
    @test [Int(r[:bus]) for r in answer[:retyped]] == [2]
    @test PSY.get_bustype(bus2) == PSY.ACBusTypes.PQ
    # The reference bus keeps its type whatever its generator does.
    @test PSY.get_bustype(first(b for b in PSY.get_components(PSY.ACBus, sys) if PSY.get_number(b) == 1)) == PSY.ACBusTypes.REF
end

println("TENSA SIENNA EDIT TESTS OK")
