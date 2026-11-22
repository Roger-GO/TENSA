# runtests.jl: tests of the TensaSienna module against the reference fixtures.
# Run as:
#   julia --project=<env> server/tests/julia/runtests.jl <ANDES cases dir>
# The first argument is the folder that holds kundur/kundur.raw and the other
# cases; the fixtures in server/tests/julia/fixtures name each case's files
# relative to it and hold what the reference engine (ANDES) found. A check
# whose case file is not in that folder is skipped with a printed line.

using Test
using JSON3
using Logging

# Keep info-level chatter down so a failure is readable; never hide warnings.
Logging.global_logger(Logging.ConsoleLogger(stderr, Logging.Warn))

include(joinpath(@__DIR__, "..", "..", "src", "tensa", "engines", "sienna", "julia", "TensaSienna.jl"))
using .TensaSienna

const PSY = TensaSienna.PSY

length(ARGS) >= 1 || error("usage: julia --project=<env> runtests.jl <ANDES cases dir>")
const CASES_DIR = ARGS[1]
const FIXTURES = joinpath(@__DIR__, "fixtures")
const FIXTURE_NAMES = ["kundur", "ieee14", "ieee39", "wscc9", "npcc", "wecc"]

# Agreement with the reference power flow, per bus. With the setpoints and
# corrections applied the largest differences measured are 2.9e-6 pu and
# 8.5e-6 rad (wecc; every other case is under 1.1e-6), which is the size of
# the rounding in PowerNetworkMatrices' admittance matrix (it holds
# ComplexF32). The smallest difference a missing correction makes is 4.7e-3
# pu (ieee39 without its transformer ratios), so 2e-5 leaves room for the
# first and catches the second, and anything a hundred times smaller.
const V_TOL = 2e-5
const A_TOL = 2e-5

load_fixture(name) = JSON3.read(read(joinpath(FIXTURES, name * ".json"), String))

case_path(rel) = rel === nothing ? nothing : joinpath(CASES_DIR, String(rel))

# True when the fixture's files are in the folder; prints which are not.
function present(fx, what = String(fx[:name]))
    for rel in (fx[:raw], fx[:dyr])
        rel === nothing && continue
        if !isfile(case_path(rel))
            println("SKIP $(what): $(rel) is not in $(CASES_DIR)")
            return false
        end
    end
    return true
end

json_arg(x) = x === nothing ? nothing : JSON3.write(x)

function load(fx; setpoints = true, corrections = true, kwargs...)
    return TensaSienna.load_case(
        case_path(fx[:raw]),
        case_path(fx[:dyr]);
        v_setpoints = setpoints ? json_arg(get(fx, :v_setpoints, nothing)) : nothing,
        corrections = corrections ? json_arg(get(fx, :corrections, nothing)) : nothing,
        kwargs...,
    )
end

function wrap_pi(a::Real)
    # Wrap to (-pi, pi].
    b = mod(Float64(a) + pi, 2 * pi)
    b <= 0 && (b += 2 * pi)
    return b - pi
end

# Largest difference of bus voltage magnitude (pu) and of angle relative to
# the fixture's reference bus (rad) between a power flow and the fixture.
function deviation(pf, fx)
    got = Dict(Int(b[:number]) => b for b in pf[:buses])
    ref = got[Int(fx[:pflow][:angle_reference_bus])][:angle_rad]
    dv = 0.0
    da = 0.0
    for (bus, want) in fx[:pflow][:buses]
        b = got[parse(Int, String(bus))]
        dv = max(dv, abs(b[:v_pu] - Float64(want[1])))
        da = max(da, abs(wrap_pi(wrap_pi(b[:angle_rad] - ref) - Float64(want[2]))))
    end
    return dv, da
end

branch_key(b) = (minmax(Int(b[:from]), Int(b[:to]))..., String(b[:ckt]))
entry_key(e) = (minmax(Int(e[1]), Int(e[2]))..., String(e[3]))

# ANDES 2.0.0's power flow of kundur.raw: the active and reactive power
# leaving each end of a branch, in MW and MVAr (Line.a1/a2/v1/v2 equations),
# keyed by the file's circuit id. The parallel circuits differ slightly in
# r and x, so a circuit id carried to the wrong branch shows here.
const KUNDUR_ANDES_FLOWS = Dict(
    (5, 6, "1") => (360.7373, 22.3531, -353.9739, 38.1321),
    (5, 6, "2") => (360.6633, 22.2832, -353.8894, 38.1861),
    (8, 9, "1") => (-678.4984, 47.8441, 688.6682, 51.0808),
    (8, 9, "2") => (-678.1071, 48.1193, 688.3166, 50.7458),
    (9, 10, "1") => (-341.2528, 32.6123, 347.5292, 23.0040),
    (9, 10, "2") => (-341.1720, 32.6652, 347.4582, 22.9363),
    (1, 5, "1") => (726.8029, 109.4634, -721.4006, -44.6364),
)

# A four-bus MATPOWER case written by a test: bus 1 the reference, bus 2 a
# generator bus, buses 3 and 4 loads. `branch34` is the row of the branch
# from 3 to 4 (r x b rateA rateB rateC ratio angle), `bus4` the bus row's type,
# and `gens` the generator rows (bus Pg Qg Qmax Qmin Vg mBase status Pmax Pmin).
function four_bus_case(dir, name; branch34 = "0.005 0.04 0.10 0 0 0 0 0",
                       bus4 = 1, gens = nothing)
    gens === nothing && (gens = [
        "1 0 0 300 -300 1.02 100 1 300 0",
        "2 80 0 100 -100 1.01 100 1 200 0",
    ])
    path = joinpath(dir, name)
    text = """
    function mpc = $(splitext(name)[1])
    mpc.version = '2';
    mpc.baseMVA = 100;
    mpc.bus = [
        1 3 0 0 0 0 1 1.02 0 230 1 1.1 0.9;
        2 2 50 20 0 0 1 1.01 0 230 1 1.1 0.9;
        3 1 100 40 0 0 1 1.0 0 230 1 1.1 0.9;
        4 $(bus4) 60 25 0 0 1 1.0 0 230 1 1.1 0.9;
    ];
    mpc.gen = [
    $(join(["    " * g * ";" for g in gens], "\n"))
    ];
    mpc.branch = [
        1 2 0.01 0.05 0.04 0 0 0 0 0 1 -360 360;
        1 3 0.01 0.06 0.05 0 0 0 0 0 1 -360 360;
        2 3 0.012 0.07 0.06 0 0 0 0 0 1 -360 360;
        3 4 $(branch34) 1 -360 360;
    ];
    """
    write(path, text)
    return path
end

# The corrections the Python side sends for `four_bus_case`: each branch row
# by its row number, a row with a ratio as a transformer, and every row's
# charging in `line_charging` (a transformer's as its `transformer_charging`).
function four_bus_corrections(branch34)
    f = parse.(Float64, split(branch34))
    b, ratio, angle = f[3], f[7], f[8]
    charging = Any[[1, 2, "1", 0.04], [1, 3, "2", 0.05], [2, 3, "3", 0.06]]
    transformers = Any[]
    if ratio != 0.0
        push!(transformers, [3, 4, "4", ratio, deg2rad(angle)])
        b != 0.0 && push!(charging, [3, 4, "4", b])
    else
        push!(charging, [3, 4, "4", b])
    end
    return JSON3.write(Dict("transformers" => transformers, "line_charging" => charging))
end

function solved_buses(s)
    pf = JSON3.read(TensaSienna.pflow_json(s))
    @test pf[:converged] == true
    return Dict(Int(b[:number]) => (Float64(b[:v_pu]), Float64(b[:angle_rad])) for b in pf[:buses]), pf
end

function largest_gap(a, b)
    dv = maximum(abs(a[k][1] - b[k][1]) for k in keys(a))
    da = maximum(abs(wrap_pi(a[k][2] - b[k][2])) for k in keys(a))
    return max(dv, da)
end

@testset "TensaSienna" begin
    for name in FIXTURE_NAMES
        fx = load_fixture(name)
        present(fx) || continue
        @testset "$name" begin
            s = load(fx)
            report = JSON3.read(TensaSienna.report_json(s))
            topo = JSON3.read(TensaSienna.topology_json(s))
            pf = JSON3.read(TensaSienna.pflow_json(s))
            branches = Dict(branch_key(b) => b for b in topo[:branches])

            @testset "identity" begin
                @test Set(Int(b[:number]) for b in topo[:buses]) == Set(Int.(fx[:buses]))
                @test Set(keys(branches)) == Set(entry_key(b) for b in fx[:branches])
                @test length(branches) == length(topo[:branches])
                @test Set((Int(g[:bus]), String(g[:id])) for g in topo[:generators]) ==
                      Set((Int(g[1]), String(g[2])) for g in fx[:generators])
                @test Set((Int(l[:bus]), String(l[:id])) for l in topo[:loads]) ==
                      Set((Int(l[1]), String(l[2])) for l in fx[:loads])
                @test length(topo[:shunts]) == length(fx[:shunts])
                @test sort([Int(sh[:bus]) for sh in topo[:shunts]]) ==
                      sort([Int(sh[1]) for sh in fx[:shunts]])
            end

            # Every branch holds what the file gives for its circuit: the
            # ratio and phase shift of each transformer record seen from the
            # record's `from` end, and the total charging of every other
            # branch record. Fails when a circuit id is carried to another
            # branch of the same bus pair.
            @testset "branches as the file has them" begin
                for e in fx[:corrections][:transformers]
                    b = branches[entry_key(e)]
                    @test (Int(b[:from]), Int(b[:to])) == (Int(e[1]), Int(e[2]))
                    @test abs(Float64(b[:tap]) - Float64(e[4])) <= 1e-9
                    @test abs(Float64(b[:shift_rad]) - Float64(e[5])) <= 1e-9
                end
                for e in fx[:corrections][:line_charging]
                    @test abs(Float64(branches[entry_key(e)][:b_pu]) - Float64(e[4])) <= 1e-9
                end
            end

            @testset "power flow agrees with the reference" begin
                @test pf[:converged] == true
                dv, da = deviation(pf, fx)
                @test dv <= V_TOL
                @test da <= A_TOL
            end

            @testset "power balance" begin
                volts = Dict(Int(b[:number]) => Float64(b[:v_pu]) for b in pf[:buses])
                p_gen = sum((Float64(g[:p_mw]) for g in pf[:generators]); init = 0.0)
                p_load = sum((Float64(l[:p_mw]) for l in pf[:loads]); init = 0.0)
                p_loss = sum(
                    (Float64(b[:p_from_mw]) + Float64(b[:p_to_mw]) for b in pf[:branches]);
                    init = 0.0,
                )
                p_shunt = sum(
                    (Float64(sh[:g_mw]) * volts[Int(sh[:bus])]^2 for sh in topo[:shunts]);
                    init = 0.0,
                )
                @test abs(p_gen - p_load - p_loss - p_shunt) <= 0.5
                # At every bus, in MW and MVAr: what the generators give, less
                # what the loads and shunts take and what leaves by branches.
                p = Dict(n => 0.0 for n in keys(volts))
                q = Dict(n => 0.0 for n in keys(volts))
                for g in pf[:generators]
                    p[Int(g[:bus])] += g[:p_mw]
                    q[Int(g[:bus])] += g[:q_mvar]
                end
                for l in pf[:loads]
                    p[Int(l[:bus])] -= l[:p_mw]
                    q[Int(l[:bus])] -= l[:q_mvar]
                end
                for sh in topo[:shunts]
                    v2 = volts[Int(sh[:bus])]^2
                    p[Int(sh[:bus])] -= sh[:g_mw] * v2
                    q[Int(sh[:bus])] += sh[:b_mvar] * v2
                end
                for b in pf[:branches]
                    p[Int(b[:from])] -= b[:p_from_mw]
                    q[Int(b[:from])] -= b[:q_from_mvar]
                    p[Int(b[:to])] -= b[:p_to_mw]
                    q[Int(b[:to])] -= b[:q_to_mvar]
                end
                @test maximum(abs, values(p)) <= 0.1
                @test maximum(abs, values(q)) <= 0.1
            end

            @testset "nothing dropped silently" begin
                @test report[:dyr_records] == length(fx[:dyr_models])
                dyn = [(Int(d[:bus]), String(d[:model]), String(d[:id])) for d in topo[:dynamics]]
                uns = [(Int(u[:bus]), String(u[:model]), String(u[:id])) for u in report[:unsupported]]
                want = [(Int(r[1]), String(r[2]), String(r[3])) for r in fx[:dyr_models]]
                for key in want
                    @test count(==(key), dyn) + count(==(key), uns) == 1
                end
                @test isempty(setdiff(Set(dyn), Set(want)))
                @test isempty(setdiff(Set(uns), Set(want)))
                @test all(u -> u[:handling] == "dropped" && !isempty(u[:reason]), report[:unsupported])
                # A model PowerSystems' own .dyr mapping does not name cannot
                # be among what the System holds (ST2CUT, ESST3A, IEEEX1 and
                # EXDC2 in these cases), however the module finds that out.
                gen_map, others = TensaSienna._dyr_mapping()
                @test all(d -> haskey(gen_map, d[2]) || d[2] in others, dyn)
                if name == "kundur"
                    @test Set(uns) == Set((b, "EXDC2", "1") for b in 1:4)
                    @test Set(dyn) == Set(
                        Iterators.flatten(((b, "GENROU", "1"), (b, "TGOV1", "1")) for b in 1:4),
                    )
                    @test report[:dynamic_injectors] == 4
                end
            end

            @testset "deterministic" begin
                @test TensaSienna.topology_json(s) == TensaSienna.topology_json(s)
                s2 = load(fx)
                @test TensaSienna.topology_json(s2) == TensaSienna.topology_json(load(fx))
                @test TensaSienna.pflow_json(s2) == TensaSienna.pflow_json(load(fx))
                @test issorted([Int(b[:number]) for b in topo[:buses]])
                @test issorted([branch_key(b) for b in topo[:branches]])
                @test issorted([(Int(g[:bus]), String(g[:id])) for g in topo[:generators]])
                @test issorted([(Int(l[:bus]), String(l[:id])) for l in topo[:loads]])
                @test issorted([Int(sh[:order]) for sh in topo[:shunts]])
            end

            @testset "corrections" begin
                applied = report[:applied]
                taps = [a for a in applied if a[:kind] == "tap"]
                chargings = [a for a in applied if a[:kind] == "charging"]
                setpoints = [a for a in applied if a[:kind] == "setpoint"]
                if name == "ieee39"
                    b = branches[(6, 31, "1")]
                    @test b[:tap] == 0.9
                    @test length(taps) == 1
                    @test taps[1][:branch] == b[:name]
                    @test taps[1][:to] == 0.9
                    @test abs(taps[1][:from] - 0.9142857142857143) <= 1e-12
                elseif name == "npcc"
                    @test length(chargings) == 20
                    # The admittance added for each is half the file's total,
                    # on the `to` bus of the branch's arc; a Line gets none.
                    lc = Dict(entry_key(e) => Float64(e[4]) for e in fx[:corrections][:line_charging])
                    adms = [
                        c for c in PSY.get_components(PSY.FixedAdmittance, s.sys) if
                        startswith(PSY.get_name(c), "charging-")
                    ]
                    @test length(adms) == 20
                    PSY.with_units_base(s.sys, PSY.UnitSystem.SYSTEM_BASE) do
                        for c in adms
                            m = match(r"^charging-(\d+)-(\d+)-(.+)$", PSY.get_name(c))
                            f, t, ckt = parse(Int, m[1]), parse(Int, m[2]), String(m[3])
                            br = TensaSienna._find_branch(s.sys, f, t, ckt)
                            @test !(br isa PSY.Line)
                            b_total = lc[(minmax(f, t)..., ckt)]
                            @test abs(imag(PSY.get_Y(c)) - b_total / 2) <= 1e-9
                            @test abs(imag(PSY.get_primary_shunt(br)) - b_total / 2) <= 1e-9
                            @test real(PSY.get_Y(c)) == 0.0
                            @test PSY.get_bus(c) == PSY.get_to(PSY.get_arc(br))
                        end
                    end
                elseif name == "ieee14"
                    @test any(sp -> sp[:bus] == 6 && sp[:to] == 1.03, setpoints)
                elseif name == "kundur" || name == "wscc9"
                    @test isempty(taps)
                    @test isempty(chargings)
                end
                if name == "ieee14"
                    @test report[:normalised_buses] == [2]
                elseif name == "kundur"
                    @test report[:normalised_buses] == [3]
                end
            end

            if name == "kundur"
                @testset "branch flows against the reference" begin
                    flows = Dict(branch_key(b) => b for b in pf[:branches])
                    for (key, want) in KUNDUR_ANDES_FLOWS
                        b = flows[key]
                        # The fixture's file order is the arc's order here.
                        @test (Int(b[:from]), Int(b[:to])) == (key[1], key[2])
                        got = (b[:p_from_mw], b[:q_from_mvar], b[:p_to_mw], b[:q_to_mvar])
                        @test maximum(abs.(got .- want)) <= 0.01
                    end
                end
            end
        end
    end

    @testset "corrections make the difference" begin
        # ieee14 needs its setpoints, npcc its charging, ieee39 its ratios:
        # without them the power flow is far outside the agreement above.
        for (name, kw, least) in (
            ("ieee14", (setpoints = false,), 0.01),
            ("npcc", (corrections = false,), 0.005),
            ("ieee39", (corrections = false,), 1e-3),
        )
            fx = load_fixture(name)
            present(fx, "$(name) without corrections") || continue
            pf = JSON3.read(TensaSienna.pflow_json(load(fx; kw...)))
            @test pf[:converged] == true
            dv, _ = deviation(pf, fx)
            @test dv > least
            @test dv > 100 * V_TOL
        end
    end

    @testset "a ratio is not applied to a branch held the other way round" begin
        fx = load_fixture("ieee39")
        if present(fx, "reversed arc")
            corr = JSON3.read(JSON3.write(fx[:corrections]), Dict{String, Any})
            corr["transformers"] = [
                (Int(e[1]), Int(e[2])) == (31, 6) ? Any[6, 31, e[3], e[4], e[5]] : e for
                e in corr["transformers"]
            ]
            s = TensaSienna.load_case(
                case_path(fx[:raw]);
                v_setpoints = json_arg(fx[:v_setpoints]),
                corrections = JSON3.write(corr),
            )
            report = JSON3.read(TensaSienna.report_json(s))
            topo = JSON3.read(TensaSienna.topology_json(s))
            b = first(x for x in topo[:branches] if branch_key(x) == (6, 31, "1"))
            @test (b[:from], b[:to]) == (31, 6)
            @test abs(b[:tap] - 0.9142857142857143) <= 1e-12
            @test !any(a -> a[:kind] == "tap", report[:applied])
            @test any(n -> occursin(String(b[:name]), String(n[:text])) && occursin("left as read", String(n[:text])), report[:notes])
        end
    end

    @testset "dyr event records" begin
        fx = load_fixture("kundur")
        dyr = joinpath(CASES_DIR, "kundur", "kundur_full.dyr")
        if present(fx, "dyr event records") && isfile(dyr)
            before = read(dyr)
            scratch = mktempdir()
            s = TensaSienna.load_case(case_path(fx[:raw]), dyr; scratch = scratch)
            report = JSON3.read(TensaSienna.report_json(s))
            @test length(report[:events]) == 1
            @test occursin("Toggle", String(report[:events][1]))
            @test !occursin("/", String(report[:events][1]))
            # The copy PowerSystems read is in the folder given; the user's
            # file is unchanged.
            copies = readdir(scratch)
            @test length(copies) == 1
            @test !occursin("Toggle", read(joinpath(scratch, copies[1]), String))
            @test read(dyr) == before
        end
    end

    @testset "power flow options and non-convergence" begin
        fx = load_fixture("ieee14")
        if present(fx, "non-convergence")
            pf = JSON3.read(TensaSienna.pflow_json(load(fx)))
            @test pf[:tolerance] == TensaSienna.PF.DEFAULT_NR_TOL
            @test pf[:max_iterations] == TensaSienna.PF.DEFAULT_NR_MAX_ITER
            pf = JSON3.read(TensaSienna.pflow_json(load(fx); tolerance = 1e-6, max_iterations = 7))
            @test pf[:converged] == true
            @test pf[:tolerance] == 1e-6
            @test pf[:max_iterations] == 7

            # maxIterations reaches the solver: one iteration does not solve
            # the case.
            pf = JSON3.read(TensaSienna.pflow_json(load(fx); max_iterations = 1))
            @test pf[:converged] == false
            @test pf[:max_iterations] == 1
            @test isempty(pf[:buses]) && isempty(pf[:branches])
            @test isempty(pf[:generators]) && isempty(pf[:loads])

            # Ten times the load has no solution.
            s = load(fx)
            for l in PSY.get_components(PSY.StandardLoad, s.sys)
                PSY.set_constant_active_power!(l, 10 * PSY.get_constant_active_power(l))
                PSY.set_constant_reactive_power!(l, 10 * PSY.get_constant_reactive_power(l))
            end
            pf = JSON3.read(TensaSienna.pflow_json(s))
            @test pf[:converged] == false
            @test isempty(pf[:buses]) && isempty(pf[:branches])
            @test isempty(pf[:generators]) && isempty(pf[:loads])
            @test !isempty(pf[:notes])
        end
    end

    @testset "errors name the file and nothing else" begin
        dir = mktempdir()
        missing_raw = joinpath(dir, "nowhere.raw")
        err = try
            TensaSienna.load_case(missing_raw)
            nothing
        catch e
            e
        end
        @test err isa ArgumentError
        @test occursin("nowhere.raw", sprint(showerror, err))
        @test !occursin(dir, sprint(showerror, err))

        junk = joinpath(dir, "junk.raw")
        write(junk, "this is not a case file\n")
        err = try
            TensaSienna.load_case(junk)
            nothing
        catch e
            e
        end
        @test err isa Exception
        msg = sprint(showerror, err)
        @test occursin("junk.raw", msg)
        @test !occursin(dir, msg)
        @test !occursin(replace(dir, '\\' => '/'), msg)

        # A file PowerSystems cannot read: the message names the file by its
        # name, gives the reason PowerSystems gave (or says what the file is
        # not), and never ends in the "nothing" the PSS/E parser throws.
        for (name, body) in (
            ("junk.raw", "this is not a case file\n"),
            ("empty.raw", ""),
            ("junk.m", "this is not a case file\n"),
        )
            path = joinpath(dir, name)
            write(path, body)
            err = try
                TensaSienna.load_case(path)
                nothing
            catch e
                e
            end
            @test err isa ErrorException
            msg = sprint(showerror, err)
            @test startswith(msg, "PowerSystems could not read $(name): ")
            @test !occursin('/', msg) && !occursin('\\', msg)
            @test !endswith(strip(msg), "nothing")
            @test length(msg) > length("PowerSystems could not read $(name): ")
        end

        txt = joinpath(dir, "case.txt")
        write(txt, "x")
        @test_throws ArgumentError TensaSienna.load_case(txt)
        m = joinpath(dir, "case.m")
        write(m, "x")
        @test_throws ArgumentError TensaSienna.load_case(m, joinpath(dir, "case.dyr"))
    end

    @testset "quiet" begin
        # Nothing reaches stdout, stderr or the caller's logger while a case
        # with dynamic data loads and solves.
        for name in ("kundur", "npcc")
            fx = load_fixture(name)
            present(fx, "quiet $(name)") || continue
            logger = Test.TestLogger(; min_level = Logging.Info)
            out = tempname()
            open(out, "w") do io
                redirect_stdout(io) do
                    redirect_stderr(io) do
                        Logging.with_logger(logger) do
                            s = load(fx)
                            TensaSienna.pflow_json(s)
                            TensaSienna.topology_json(s)
                            TensaSienna.report_json(s)
                        end
                    end
                end
            end
            @test isempty(logger.logs)
            @test read(out, String) == ""
        end
    end

    @testset "MATPOWER case" begin
        m = joinpath(CASES_DIR, "matpower", "case14.m")
        if isfile(m)
            s = TensaSienna.load_case(m)
            topo = JSON3.read(TensaSienna.topology_json(s))
            pf = JSON3.read(TensaSienna.pflow_json(s))
            @test length(topo[:buses]) == 14
            @test length(topo[:branches]) == 20
            @test pf[:converged] == true
            @test length(pf[:buses]) == 14
        else
            println("SKIP MATPOWER case: matpower/case14.m is not in $(CASES_DIR)")
        end
    end

    @testset "a MATPOWER transformer row keeps its charging at both ends" begin
        # MATPOWER defines a ratio of 0 as 1, so a row of ratio 1 is the same
        # branch as the line: PowerSystems makes a transformer of it and
        # moves its whole charging onto the from end (case118.m rows 86-87
        # and 68-116, 1.7e-3 pu at bus 86), and the correction puts half back
        # on each end.
        dir = mktempdir()
        line = "0.005 0.04 0.10 0 0 0 0 0"
        unit = "0.005 0.04 0.10 0 0 0 1 0"
        s_line = TensaSienna.load_case(four_bus_case(dir, "line.m"; branch34 = line);
                                       corrections = four_bus_corrections(line))
        s_unit = TensaSienna.load_case(four_bus_case(dir, "unit.m"; branch34 = unit);
                                       corrections = four_bus_corrections(unit))
        @test any(a -> a["kind"] == "charging", s_unit.applied)
        v_line, _ = solved_buses(s_line)
        v_unit, _ = solved_buses(s_unit)
        # The two are the same network up to the rounding of the admittance
        # matrix, which PowerNetworkMatrices holds in single precision and
        # builds for a line and a transformer by different sums (1.4e-7).
        @test largest_gap(v_line, v_unit) < 1e-6
        topo = JSON3.read(TensaSienna.topology_json(s_unit))
        br = only(b for b in topo[:branches] if (b[:from], b[:to]) == (3, 4))
        @test br[:kind] == "transformer"
        @test br[:b_pu] ≈ 0.10 atol = 1e-12
        # Without the correction the two differ, by more than the tolerance
        # the engines are held to.
        s_bare = TensaSienna.load_case(joinpath(dir, "unit.m"))
        v_bare, _ = solved_buses(s_bare)
        @test largest_gap(v_line, v_bare) > 1e-4

        # With a ratio other than 1, the from end is (y + j b/2) / tap^2 and
        # the to end y + j b/2, as MATPOWER's makeYbus has them.
        ratio = "0.005 0.04 0.10 0 0 0 0.95 0"
        s_tap = TensaSienna.load_case(four_bus_case(dir, "tap.m"; branch34 = ratio);
                                      corrections = four_bus_corrections(ratio))
        sys = s_tap.sys
        PSY.with_units_base(sys, PSY.UnitSystem.SYSTEM_BASE) do
            br = only(b for b in PSY.get_components(PSY.ACBranch, sys) if
                      TensaSienna._arc_numbers(b) == (3, 4))
            y11, _, _, y22 = TensaSienna.PNM.ybus_branch_entries(br)
            added = TensaSienna._added_charging(sys)[PSY.get_name(br)]
            ys = 1 / complex(0.005, 0.04)
            @test y11 ≈ (ys + 0.05im) / 0.95^2 atol = 1e-6
            @test y22 + added * im ≈ ys + 0.05im atol = 1e-6
        end
        topo = JSON3.read(TensaSienna.topology_json(s_tap))
        br = only(b for b in topo[:branches] if (b[:from], b[:to]) == (3, 4))
        @test br[:b_pu] ≈ 0.10 atol = 1e-9
        @test br[:tap] ≈ 0.95
    end

    @testset "a MATPOWER row with a ratio of 0 and a phase shift" begin
        # PowerSystems' parser fails on it ("base_voltage_from" not found,
        # case89pegase.m); MATPOWER applies the shift with a ratio of 1.
        dir = mktempdir()
        ratio0 = "0.005 0.04 0.10 0 0 0 0 3"
        ratio1 = "0.005 0.04 0.10 0 0 0 1 3"
        s_zero = TensaSienna.load_case(four_bus_case(dir, "zero.m"; branch34 = ratio0);
                                       corrections = four_bus_corrections(ratio0))
        shifts = [a for a in s_zero.applied if a["kind"] == "phase_shift"]
        @test length(shifts) == 1
        @test (shifts[1]["from_bus"], shifts[1]["to_bus"]) == (3, 4)
        @test shifts[1]["shift_rad"] ≈ deg2rad(3)
        s_one = TensaSienna.load_case(four_bus_case(dir, "one.m"; branch34 = ratio1);
                                      corrections = four_bus_corrections(ratio1))
        @test !any(a -> a["kind"] == "phase_shift", s_one.applied)
        v_zero, _ = solved_buses(s_zero)
        v_one, _ = solved_buses(s_one)
        @test largest_gap(v_zero, v_one) < 1e-9
        # The shift is applied: bus 4 hangs off bus 3 by this branch alone,
        # so its angle moves by the shift.
        line = "0.005 0.04 0.10 0 0 0 0 0"
        s_line = TensaSienna.load_case(four_bus_case(dir, "noshift.m"; branch34 = line);
                                       corrections = four_bus_corrections(line))
        v_line, _ = solved_buses(s_line)
        @test abs(wrap_pi(v_zero[4][2] - v_line[4][2])) ≈ deg2rad(3) atol = 1e-6
        topo = JSON3.read(TensaSienna.topology_json(s_zero))
        br = only(b for b in topo[:branches] if (b[:from], b[:to]) == (3, 4))
        @test br[:shift_rad] ≈ deg2rad(3)
        @test br[:b_pu] ≈ 0.10 atol = 1e-12
    end

    @testset "a PV bus with no generator in service is solved as PQ" begin
        # case_ACTIVSg200.m gives buses 168, 169, 196 and 197 type PV with
        # their units out of service; PowerFlows refuses such a bus.
        dir = mktempdir()
        gens = [
            "1 0 0 300 -300 1.02 100 1 300 0",
            "2 80 0 100 -100 1.01 100 1 200 0",
            "4 20 0 50 -50 1.03 100 0 100 0",
        ]
        s = TensaSienna.load_case(four_bus_case(dir, "off.m"; bus4 = 2, gens = gens);
                                  corrections = four_bus_corrections("0.005 0.04 0.10 0 0 0 0 0"))
        @test any(a -> a["kind"] == "bustype" && a["bus"] == 4 && a["to"] == "PQ", s.applied)
        topo = JSON3.read(TensaSienna.topology_json(s))
        @test only(b for b in topo[:buses] if b[:number] == 4)[:type] == "PQ"
        v_off, _ = solved_buses(s)
        s_pq = TensaSienna.load_case(four_bus_case(dir, "pq.m");
                                     corrections = four_bus_corrections("0.005 0.04 0.10 0 0 0 0 0"))
        v_pq, _ = solved_buses(s_pq)
        @test largest_gap(v_off, v_pq) < 1e-9
        # An edit that puts the unit in service makes the bus PV again.
        name = only(g[:name] for g in topo[:generators] if g[:bus] == 4)
        answer = JSON3.read(TensaSienna.apply_edits_json(s, JSON3.write([Dict(
            "op" => "set", "key" => "gen:4-$(TensaSienna._generator_id(name, 4))",
            "name" => name, "field" => "in_service", "value" => true,
        )])))
        @test isempty(answer[:refused])
        @test any(r -> r[:bus] == 4 && r[:type] == "PV", answer[:retyped])
        topo = JSON3.read(TensaSienna.topology_json(s))
        @test only(b for b in topo[:buses] if b[:number] == 4)[:type] == "PV"
        solved_buses(s)
    end

    @testset "a bus that needs more than its units' limits" begin
        # PowerFlows shares a bus's power among its units clamped to their
        # limits, and fails with "AssertionError: Int64[]" when the bus needs
        # more (pglib_opf_case24_ieee_rts.m: bus 13 and bus 15). The units are
        # then shared past their limits, and the bus totals are the solved
        # ones: those of the same case with one unit per bus.
        dir = mktempdir()
        units_split = [
            "1 0 0 300 -300 1.02 100 1 40 0",
            "1 0 0 300 -300 1.02 100 1 40 0",
            "2 40 0 5 -5 1.01 100 1 100 0",
            "2 40 0 5 -5 1.01 100 1 100 0",
        ]
        units_merged = [
            "1 0 0 600 -600 1.02 100 1 600 0",
            "2 80 0 200 -200 1.01 100 1 200 0",
        ]
        line = "0.005 0.04 0.10 0 0 0 0 0"
        s_split = TensaSienna.load_case(four_bus_case(dir, "split.m"; gens = units_split);
                                        corrections = four_bus_corrections(line))
        s_merged = TensaSienna.load_case(four_bus_case(dir, "merged.m"; gens = units_merged);
                                         corrections = four_bus_corrections(line))
        v_split, pf_split = solved_buses(s_split)
        v_merged, pf_merged = solved_buses(s_merged)
        @test largest_gap(v_split, v_merged) < 1e-9
        total(pf, bus, field) = sum(Float64(g[field]) for g in pf[:generators] if g[:bus] == bus)
        @test total(pf_merged, 1, :p_mw) > 80.0  # more than the two 40 MW units
        @test total(pf_merged, 2, :q_mvar) > 10.0  # more than the two 5 MVAr units
        for (bus, field) in ((1, :p_mw), (1, :q_mvar), (2, :p_mw), (2, :q_mvar))
            @test total(pf_split, bus, field) ≈ total(pf_merged, bus, field) atol = 1e-6
        end
        # Equal ratings and ranges: equal shares.
        for bus in (1, 2)
            units = [g for g in pf_split[:generators] if g[:bus] == bus]
            @test units[1][:p_mw] ≈ units[2][:p_mw] atol = 1e-9
            @test units[1][:q_mvar] ≈ units[2][:q_mvar] atol = 1e-9
        end
        texts = [String(n[:text]) for n in pf_split[:notes]]
        @test any(t -> occursin("PowerFlows could not share the active and reactive power of bus 1", t), texts)
        @test any(t -> occursin("PowerFlows could not share the reactive power of bus 2", t), texts)
        # A bus inside its units' limits is shared by PowerFlows as before.
        @test !any(t -> occursin("could not share", t), [String(n[:text]) for n in pf_merged[:notes]])
    end

    @testset "a synchronous condenser" begin
        # PowerSystems reads a PSS/E machine with no active power and no
        # active limits as a SynchronousCondenser (RTS-GMLC has three), which
        # has no active power getter.
        raw = joinpath(CASES_DIR, "ieee14", "ieee14.raw")
        if isfile(raw)
            dir = mktempdir()
            text = read(raw, String)
            old = "     8,'1 ',    35.000,    10.000,    10.000,    -6.000,1.03000,     0,   100.000, 0.00000E+0, 1.20000E-1, 0.00000E+0, 0.00000E+0,1.00000,1,  100.0,    50.000,    10.000,"
            new = "     8,'1 ',     0.000,    10.000,    10.000,    -6.000,1.03000,     0,   100.000, 0.00000E+0, 1.20000E-1, 0.00000E+0, 0.00000E+0,1.00000,1,  100.0,     0.000,     0.000,"
            @test occursin(old, text)
            path = joinpath(dir, "condenser.raw")
            write(path, replace(text, old => new))
            s = TensaSienna.load_case(path)
            topo = JSON3.read(TensaSienna.topology_json(s))
            g8 = only(g for g in topo[:generators] if g[:bus] == 8)
            @test g8[:sienna_type] == "SynchronousCondenser"
            @test g8[:p_mw] == 0.0
            pf = JSON3.read(TensaSienna.pflow_json(s))
            @test pf[:converged] == true
            @test only(g for g in pf[:generators] if g[:bus] == 8)[:p_mw] == 0.0
        else
            println("SKIP synchronous condenser: ieee14/ieee14.raw is not in $(CASES_DIR)")
        end
    end

    @testset "versions" begin
        v = JSON3.read(TensaSienna.versions_json())
        @test v[:julia] == string(VERSION)
        @test v[:PowerSystems] == string(pkgversion(TensaSienna.PowerSystems))
        @test v[:PowerFlows] == string(pkgversion(TensaSienna.PowerFlows))
        @test v[:PowerNetworkMatrices] == string(pkgversion(TensaSienna.PowerNetworkMatrices))
        @test v[:PowerSimulationsDynamics] isa String
        @test VersionNumber(v[:PowerSimulationsDynamics]) isa VersionNumber
    end
end

println("TENSA SIENNA TESTS OK")
