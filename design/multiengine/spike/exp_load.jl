# Experiment: does a constant-impedance load set as P0/V0^2 keep the power flow solution?
using PowerSystems, PowerFlows, Logging
const PSY = PowerSystems
Logging.global_logger(Logging.ConsoleLogger(stderr, Logging.Error))

sys = System(ARGS[1]; runchecks = false)
for b in PSY.get_components(PSY.ACBus, sys)
    PSY.get_bustype(b) == PSY.ACBusTypes.SLACK && PSY.set_bustype!(b, PSY.ACBusTypes.PV)
end
println("units base: ", PSY.get_units_base(sys))
solve_and_store_power_flow!(ACPowerFlow(), sys)
v_before = Dict(PSY.get_number(b) => PSY.get_magnitude(b) for b in PSY.get_components(PSY.ACBus, sys))
for load in PSY.get_components(PSY.StandardLoad, sys)
    v0 = PSY.get_magnitude(PSY.get_bus(load))
    println("load ", PSY.get_name(load), " bus ", PSY.get_number(PSY.get_bus(load)), " v0=", v0,
        " P=", PSY.get_constant_active_power(load), " Q=", PSY.get_constant_reactive_power(load),
        " I=", (PSY.get_current_active_power(load), PSY.get_current_reactive_power(load)),
        " Z=", (PSY.get_impedance_active_power(load), PSY.get_impedance_reactive_power(load)),
        " base_power=", PSY.get_base_power(load))
end
for sh in PSY.get_components(PSY.FixedAdmittance, sys)
    println("shunt ", PSY.get_name(sh), " bus ", PSY.get_number(PSY.get_bus(sh)), " Y=", PSY.get_Y(sh))
end
for mode in ("v0", "one")
    s2 = deepcopy(sys)
    for load in PSY.get_components(PSY.StandardLoad, s2)
        v0 = mode == "v0" ? PSY.get_magnitude(PSY.get_bus(load)) : 1.0
        p, q = PSY.get_constant_active_power(load), PSY.get_constant_reactive_power(load)
        PSY.set_impedance_active_power!(load, p / v0^2)
        PSY.set_impedance_reactive_power!(load, q / v0^2)
        PSY.set_constant_active_power!(load, 0.0)
        PSY.set_constant_reactive_power!(load, 0.0)
    end
    solve_and_store_power_flow!(ACPowerFlow(), s2)
    dv = maximum(abs(PSY.get_magnitude(b) - v_before[PSY.get_number(b)]) for b in PSY.get_components(PSY.ACBus, s2))
    println("mode ", mode, ": largest voltage change after conversion = ", dv)
    for b in PSY.get_components(PSY.ACBus, s2)
        n = PSY.get_number(b)
        n in (5, 7, 9) && println("   bus ", n, ": ", v_before[n], " -> ", PSY.get_magnitude(b))
    end
end
