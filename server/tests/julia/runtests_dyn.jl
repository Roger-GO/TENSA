# runtests_dyn.jl: tests of the TensaSiennaDyn module (small-signal analysis
# and time-domain runs with PowerSimulationsDynamics) against the sample cases.
# Run as:
#   julia --project=<env> server/tests/julia/runtests_dyn.jl <ANDES cases dir>
# The first argument is the folder that holds kundur/kundur.raw and the other
# cases; the fixtures in server/tests/julia/fixtures name each case's files
# relative to it. A case whose files are not in that folder is skipped with a
# printed line. Julia compiles on first use and one check starts a second
# Julia process, so this file takes several minutes.

using Test
using JSON3
using Logging
using LinearAlgebra
using SparseArrays

# Keep info-level chatter down so a failure is readable; never hide warnings.
Logging.global_logger(Logging.ConsoleLogger(stderr, Logging.Warn))

const JULIA_DIR = joinpath(@__DIR__, "..", "..", "src", "tensa", "engines", "sienna", "julia")
include(joinpath(JULIA_DIR, "TensaSienna.jl"))
include(joinpath(JULIA_DIR, "TensaSiennaDyn.jl"))

const TS = Main.TensaSienna
const TSD = Main.TensaSiennaDyn
const PSY = TS.PSY
const PSID = TSD.PSID
const PNM = TS.PNM

length(ARGS) >= 1 || error("usage: julia --project=<env> runtests_dyn.jl <ANDES cases dir>")
const CASES_DIR = ARGS[1]
const FIXTURES = joinpath(@__DIR__, "fixtures")

# The oscillatory modes the spike measured for kundur with impedance loads
# (frequency in Hz, damping ratio): the governor mode, the inter-area mode and
# the two local modes. Measured here: (0.06844, 0.62952), (0.65403, 0.04581),
# (1.10768, 0.09211), (1.14113, 0.09415).
const KUNDUR_MODES = [(0.0684, 0.6295), (0.6540, 0.0458), (1.1077, 0.0921), (1.1411, 0.0941)]
const OMEGA_B = 2 * pi * 60.0

load_fixture(name) = JSON3.read(read(joinpath(FIXTURES, name * ".json"), String))
json_arg(x) = x === nothing ? nothing : JSON3.write(x)
J(x) = JSON3.write(x)

function fixture_files(fx)
    raw = joinpath(CASES_DIR, String(fx[:raw]))
    dyr = fx[:dyr] === nothing ? nothing : joinpath(CASES_DIR, String(fx[:dyr]))
    return raw, dyr
end

function fixture_present(fx)
    raw, dyr = fixture_files(fx)
    for f in (raw, dyr)
        f === nothing && continue
        isfile(f) || (println("SKIP $(fx[:name]): $(relpath(f, CASES_DIR)) is not in $(CASES_DIR)"); return false)
    end
    return true
end

# A case loaded the way the engine loads it: the fixture's setpoints and
# corrections applied.
function load_fixture_case(fx; scratch = mktempdir(), dyr = :fixture)
    raw, fdyr = fixture_files(fx)
    return TS.load_case(
        raw,
        dyr === :fixture ? fdyr : dyr;
        scratch = scratch,
        v_setpoints = json_arg(get(fx, :v_setpoints, nothing)),
        corrections = json_arg(get(fx, :corrections, nothing)),
    )
end

const KUNDUR = load_fixture("kundur")

function solved_kundur()
    s = load_fixture_case(KUNDUR)
    pf = JSON3.read(TS.pflow_json(s))
    @test pf[:converged] == true
    return s, pf
end

# Frequency (Hz) and damping ratio of an eigenvalue [re, im] that is not zero.
mode_of(e) = (abs(e[2]) / (2 * pi), -e[1] / hypot(e[1], e[2]))
oscillatory(eigs) = [e for e in eigs if e[2] > 1e-6]

# For each wanted mode, the smallest error of any oscillatory eigenvalue.
function mode_errors(eigs, modes)
    return [
        minimum(max(abs(mode_of(e)[1] - f), abs(mode_of(e)[2] - z)) for e in oscillatory(eigs)) for
        (f, z) in modes
    ]
end

# The index of a column of the plan, by quantity and address.
function col_index(cols, quantity; bus = nothing, id = nothing)
    for (i, c) in enumerate(cols)
        String(c[:quantity]) == quantity || continue
        bus !== nothing && Int(c[:bus]) != bus && continue
        id !== nothing && String(c[:id]) != id && continue
        return i
    end
    error("no column $(quantity) bus $(bus) id $(id)")
end
col_value(cols, row, quantity; kw...) = Float64(row[col_index(cols, quantity; kw...)])

# Number of connected parts of the in-service branches of a system with some
# branches left out: the test's own count, to find trips that split the
# network rather than guessing them.
function network_parts(sys, out_names = ())
    adj = Dict{Int, Vector{Int}}()
    for br in PSY.get_components(PSY.ACBranch, sys)
        PSY.get_available(br) || continue
        PSY.get_name(br) in out_names && continue
        f, t = TS._arc_numbers(br)
        push!(get!(adj, f, Int[]), t)
        push!(get!(adj, t, Int[]), f)
    end
    seen = Set{Int}()
    parts = 0
    for b in PSY.get_components(PSY.ACBus, sys)
        n = PSY.get_number(b)
        n in seen && continue
        parts += 1
        stack = [n]
        push!(seen, n)
        while !isempty(stack)
            u = pop!(stack)
            for v in get(adj, u, Int[])
                v in seen || (push!(seen, v); push!(stack, v))
            end
        end
    end
    return parts
end

branch_entry(br; t = 1.0) = Dict(
    "kind" => "branch_trip",
    "from" => TS._arc_numbers(br)[1],
    "to" => TS._arc_numbers(br)[2],
    "ckt" => TS._branch_ckt(PSY.get_name(br)),
    "t" => t,
)

const TRIP_78 = Dict("kind" => "branch_trip", "from" => 7, "to" => 8, "ckt" => "1", "t" => 0.5)
const FAULT_7 = Dict("kind" => "bus_fault", "bus" => 7, "t_on" => 1.0, "t_clear" => 1.05, "r_pu" => 0.0, "x_pu" => 1e-4)

# The rows of a run's answer as a matrix of Float64, one row per time.
rows_of(ans) = [Float64.(r) for r in ans[:rows]]

# Every row of a flat run sits at the power flow's operating point.
function check_flat(ans, pf; tol = 1e-6)
    cols = ans[:columns]
    worst_w = 0.0
    worst_v = 0.0
    for row in rows_of(ans)
        for (i, c) in enumerate(cols)
            q = String(c[:quantity])
            q == "rotor_speed" && (worst_w = max(worst_w, abs(row[i] - 1.0)))
        end
        for b in pf[:buses]
            worst_v = max(worst_v, abs(col_value(cols, row, "voltage"; bus = Int(b[:number])) - Float64(b[:v_pu])))
        end
    end
    @test worst_w <= tol
    @test worst_v <= tol
    return worst_w, worst_v
end

@testset "TensaSiennaDyn" begin
    if !fixture_present(KUNDUR)
        println("SKIP kundur: its files are not in $(CASES_DIR)")
    else
        @testset "timings" begin
            # First calls compile; second calls are what a session pays.
            s, _ = solved_kundur()
            fault = J([FAULT_7])
            calls = [
                ("dyn_plan_json", () -> TSD.dyn_plan_json(s)),
                ("eig_json", () -> TSD.eig_json(s)),
                ("tds_init_json", () -> TSD.tds_init_json(s)),
                ("tds_run_json (5 s, fault)", () -> TSD.tds_run_json(s; tf = 5.0, disturbances = fault)),
            ]
            for (name, f) in calls
                t1 = @elapsed a = JSON3.read(f())
                t2 = @elapsed b = JSON3.read(f())
                @test a[:ok] == true
                @test b[:ok] == true
                println("timing $(name): first call $(round(t1, digits = 2)) s, second call $(round(t2, digits = 3)) s")
            end
        end

        @testset "plan" begin
            s = load_fixture_case(KUNDUR)
            plan = JSON3.read(TSD.dyn_plan_json(s))
            @test plan[:ok] == true
            @test plan[:ready] == false
            @test plan[:reason] == "solve the power flow first"

            s, pf = solved_kundur()
            plan = JSON3.read(TSD.dyn_plan_json(s))
            @test plan[:ok] == true
            @test plan[:ready] == true
            @test plan[:reason] === nothing
            @test String(plan[:load_model]) == "impedance"
            @test isempty(plan[:static_generators])
            @test length(plan[:machines]) == 4
            @test [(Int(m[:bus]), String(m[:id])) for m in plan[:machines]] == [(1, "1"), (2, "1"), (3, "1"), (4, "1")]
            for m in plan[:machines]
                states = String.(m[:states])
                @test "δ" in states
                @test "ω" in states
                @test length(states) == 8
                @test String(m[:components][:machine]) == "RoundRotorQuadratic"
                @test String(m[:components][:prime_mover]) == "SteamTurbineGov1"
                # PowerSystems leaves EXDC2 out: a fixed exciter.
                @test String(m[:components][:avr]) == "AVRFixed"
            end
            n_buses = length(pf[:buses])
            cols = plan[:columns]
            @test length(cols) == 2 * n_buses + 2 * 4
            q(r) = [String(c[:quantity]) for c in cols[r]]
            @test q(1:n_buses) == fill("voltage", n_buses)
            @test q((n_buses + 1):(2 * n_buses)) == fill("angle", n_buses)
            @test q((2 * n_buses + 1):(2 * n_buses + 4)) == fill("rotor_speed", 4)
            @test q((2 * n_buses + 5):(2 * n_buses + 8)) == fill("rotor_angle", 4)
            @test [Int(c[:bus]) for c in cols[1:n_buses]] == sort([Int(b[:number]) for b in pf[:buses]])
            @test [Int(c[:bus]) for c in cols[(n_buses + 1):(2 * n_buses)]] == [Int(c[:bus]) for c in cols[1:n_buses]]
            @test [Int(c[:bus]) for c in cols[(2 * n_buses + 1):end]] == [1, 2, 3, 4, 1, 2, 3, 4]
            @test all(c -> String(c[:kind]) == "generator" && String(c[:id]) == "1", cols[(2 * n_buses + 1):end])
            @test [String(c[:unit]) for c in cols[[1, n_buses + 1, 2 * n_buses + 1, 2 * n_buses + 5]]] == ["pu", "rad", "pu", "rad"]
            @test plan[:loads][:converted] == length(pf[:loads])
            @test isempty(plan[:loads][:left])
            @test JSON3.read(TSD.dyn_plan_json(s; load_model = "as-case"))[:loads][:converted] == 0
        end

        @testset "eigenvalues" begin
            s, pf = solved_kundur()
            ans = JSON3.read(TSD.eig_json(s))
            @test ans[:ok] == true
            @test ans[:n_states] == 32
            @test length(ans[:eigenvalues]) == 32
            @test ans[:stable] == true
            errs = mode_errors(ans[:eigenvalues], KUNDUR_MODES)
            println("kundur modes, largest error: ", maximum(errs))
            @test maximum(errs) <= 5e-4
            # The angles have no fixed reference: one eigenvalue is zero,
            # answered as exactly zero.
            @test count(e -> e[1] == 0.0 && e[2] == 0.0, ans[:eigenvalues]) == 1
            states = ans[:states]
            @test length(states) == 32
            plan = JSON3.read(TSD.dyn_plan_json(s))
            for m in plan[:machines]
                mine = [String(st[:state]) for st in states if String(st[:device]) == String(m[:name])]
                @test sort(mine) == sort(String.(m[:states]))
                @test all(st -> Int(st[:bus]) == Int(m[:bus]) && String(st[:id]) == "1",
                          [st for st in states if String(st[:device]) == String(m[:name])])
            end

            # The reduced state matrix, written column-major inside the scratch.
            mfile = joinpath(s.scratch, "matrix.bin")
            ans = JSON3.read(TSD.eig_json(s; matrix_file = mfile))
            @test ans[:ok] == true
            @test ans[:matrix][:rows] == 32
            @test ans[:matrix][:cols] == 32
            @test String(ans[:matrix][:file]) == mfile
            @test filesize(mfile) == 32 * 32 * 8
            A = Matrix{Float64}(undef, 32, 32)
            read!(mfile, A)
            got = eigvals(A)
            for e in ans[:eigenvalues]
                @test minimum(abs.(got .- complex(e[1], e[2]))) <= 1e-6
            end
            # `states` names the rows: the swing equation puts, in the row of
            # a machine's δ, ω_b at its own ω and -ω_b at the ω of the machine
            # the network frequency is taken from (PSID's ReferenceBus: the
            # machine on the REF bus, bus 1), and nothing else. The reference
            # machine's δ row is zero. A transposed (row-major) file or a
            # wrong order of the names breaks this.
            row(bus, st) = findfirst(x -> Int(x[:bus]) == bus && String(x[:state]) == st, states)
            w_ref = row(1, "ω")
            for bus in 1:4
                d = row(bus, "δ")
                expected = zeros(32)
                if bus != 1
                    expected[row(bus, "ω")] = OMEGA_B
                    expected[w_ref] = -OMEGA_B
                end
                @test maximum(abs.(A[d, :] .- expected)) <= 1e-6
            end

            # A matrix_file outside the scratch folder is refused.
            outside = joinpath(mktempdir(), "matrix.bin")
            for bad in (outside, joinpath(s.scratch, "..", "matrix.bin"), s.scratch)
                ans = JSON3.read(TSD.eig_json(s; matrix_file = bad))
                @test ans[:ok] == false
                @test ans[:stage] == "matrix"
                @test occursin("scratch", String(ans[:error]))
            end
            @test !isfile(outside)
            # A path in a folder that does not exist answers, naming only the file.
            ans = JSON3.read(TSD.eig_json(s; matrix_file = joinpath(s.scratch, "nowhere", "m.bin")))
            @test ans[:ok] == false
            @test ans[:stage] == "matrix"
            @test !occursin(s.scratch, String(ans[:error]))
        end

        @testset "load model" begin
            s, pf = solved_kundur()
            zi = JSON3.read(TSD.eig_json(s; load_model = "impedance"))
            zp = JSON3.read(TSD.eig_json(s; load_model = "power"))
            za = JSON3.read(TSD.eig_json(s; load_model = "as-case"))
            @test zi[:ok] == zp[:ok] == za[:ok] == true
            @test zi[:loads][:converted] == length(pf[:loads])
            @test zp[:loads][:converted] == length(pf[:loads])
            @test za[:loads][:converted] == 0
            # The constant-power spectrum differs from the impedance one.
            ce(a) = [complex(e[1], e[2]) for e in a[:eigenvalues]]
            moved = maximum(minimum(abs.(ce(zp) .- e)) for e in ce(zi))
            @test moved > 1e-3
            least(a) = sort([mode_of(e) for e in oscillatory(a[:eigenvalues])]; by = x -> x[2])[1:min(4, end)]
            println("impedance least damped (Hz, ratio): ", [round.(x, digits = 4) for x in least(zi)])
            println("power least damped (Hz, ratio): ", [round.(x, digits = 4) for x in least(zp)])
            bad = JSON3.read(TSD.eig_json(s; load_model = "zip"))
            @test bad[:ok] == false
            @test bad[:stage] == "arguments"
            @test occursin("load model", String(bad[:error]))
        end

        @testset "initialisation" begin
            s, pf = solved_kundur()
            ans = JSON3.read(TSD.tds_init_json(s))
            @test ans[:ok] == true
            @test ans[:initialized] == true
            @test ans[:n_states] == 2 * length(pf[:buses]) + 32
            @test length(ans[:states]) == 32
            @test all(st -> abs(Float64(st[:value]) - 1.0) <= 1e-9, [st for st in ans[:states] if String(st[:state]) == "ω"])
            for b in ans[:buses]
                want = only(x for x in pf[:buses] if Int(x[:number]) == Int(b[:bus]))
                @test abs(Float64(b[:v_pu]) - Float64(want[:v_pu])) <= 1e-6
            end
            early = JSON3.read(TSD.tds_init_json(load_fixture_case(KUNDUR)))
            @test early[:ok] == false
            @test early[:stage] == "not_ready"
        end

        @testset "a run with nothing acting" begin
            s, pf = solved_kundur()
            ans = JSON3.read(TSD.tds_run_json(s; tf = 2.0))
            @test ans[:ok] == true
            @test ans[:status] == "completed"
            @test ans[:error] === nothing
            ts = Float64.(ans[:t])
            @test ts[1] == 0.0
            @test ts[end] == 2.0
            @test Float64(ans[:t_end]) == 2.0
            @test length(ts) > 10
            @test ans[:steps] == length(ts) - 1
            @test issorted(ts)
            @test length(ans[:rows]) == length(ts)
            @test all(r -> length(r) == length(ans[:columns]), ans[:rows])
            @test ans[:columns] == JSON3.read(TSD.dyn_plan_json(s))[:columns]
            check_flat(ans, pf)
            post = ans[:post]
            @test post !== nothing
            @test length(post[:series]) == 8
            dispatch = Dict((Int(g[:bus]), String(g[:id])) => g for g in pf[:generators])
            for x in post[:series]
                g = dispatch[(Int(x[:bus]), String(x[:id]))]
                y = Float64.(x[:y])
                @test length(y) == length(post[:t])
                if String(x[:quantity]) == "p"
                    @test String(x[:unit]) == "MW"
                    @test abs(y[1] - Float64(g[:p_mw])) <= 1e-3
                else
                    @test String(x[:unit]) == "MVAr"
                    @test abs(y[1] - Float64(g[:q_mvar])) <= 1e-3
                end
            end
            @test Set((String(x[:quantity]), Int(x[:bus])) for x in post[:series]) ==
                  Set((q, b) for q in ("p", "q") for b in 1:4)
        end

        @testset "rows are PSID's own values" begin
            # The values the hook sees are computed from the integrator's
            # state vector with PSID's indices; they must be what PSID's own
            # post-processing reads from the solution at the same instants.
            s, _ = solved_kundur()
            store = Ref{Any}(nothing)
            ans = JSON3.read(TSD.tds_run_json(s; tf = 3.0, disturbances = J([TRIP_78, FAULT_7]),
                                              results_hook = r -> (store[] = r)))
            @test ans[:status] == "completed"
            res = store[]
            @test res !== nothing
            sol = PSID.get_solution(res)
            cols = ans[:columns]
            series = Dict{Int, Vector{Float64}}()
            for (i, c) in enumerate(cols)
                q = String(c[:quantity])
                if q == "voltage"
                    series[i] = PSID.get_voltage_magnitude_series(res, Int(c[:bus]); unique_timestamps = false)[2]
                elseif q == "angle"
                    series[i] = PSID.get_voltage_angle_series(res, Int(c[:bus]); unique_timestamps = false)[2]
                else
                    name = "generator-$(Int(c[:bus]))-$(String(c[:id]))"
                    st = q == "rotor_speed" ? :ω : :δ
                    series[i] = PSID.get_state_series(res, (name, st); unique_timestamps = false)[2]
                end
            end
            worst = 0.0
            missing_t = 0
            for (k, t) in enumerate(Float64.(ans[:t]))
                js = findall(==(t), sol.t)
                isempty(js) && (missing_t += 1; continue)
                j = last(js) # at a disturbance, the value after it
                for i in eachindex(cols)
                    worst = max(worst, abs(series[i][j] - Float64(ans[:rows][k][i])))
                end
            end
            println("rows against PSID's post-processing: largest difference $(worst) over $(length(ans[:t])) rows")
            @test missing_t == 0
            @test worst <= 1e-9
            @test length(ans[:t]) > 50
        end

        @testset "a branch trip" begin
            s, pf = solved_kundur()
            dist = J([Dict("kind" => "branch_trip", "from" => 7, "to" => 8, "ckt" => "1", "t" => 1.0)])
            ans = JSON3.read(TSD.tds_run_json(s; tf = 5.0, disturbances = dist))
            @test ans[:ok] == true
            @test ans[:status] == "completed"
            ts = Float64.(ans[:t])
            @test ts[end] == 5.0
            cols = ans[:columns]
            w = [[col_value(cols, r, "rotor_speed"; bus = b) for b in 1:4] for r in ans[:rows]]
            before = findall(<(1.0), ts)
            @test !isempty(before)
            @test maximum(maximum(abs.(w[k] .- 1.0)) for k in before) <= 1e-6
            after = findall(>(1.0), ts)
            dev = maximum(maximum(abs.(w[k] .- 1.0)) for k in after)
            @test dev > 1e-4
            @test dev < 0.02
            # Reported as a branch in either direction.
            rev = J([Dict("kind" => "branch_trip", "from" => 8, "to" => 7, "ckt" => "1", "t" => 1.0)])
            @test JSON3.read(TSD.tds_run_json(s; tf = 1.5, disturbances = rev))[:status] == "completed"
        end

        @testset "the fault's matrices" begin
            # The matrices a fault switches in are PSID's own network matrix
            # for this System: the one PSID's simulation holds, with the
            # fault's admittance on the bus's diagonal, and with any branch
            # tripped before the switch taken out.
            s, _ = solved_kundur()
            sys, _ = TSD._prepared_copy(s, "impedance")
            sim = PSID.Simulation(PSID.ResidualModel, sys, mktempdir(), (0.0, 1.0);
                                  console_level = Logging.AboveMaxLevel, file_level = Logging.Error)
            inputs = PSID.get_simulation_inputs(sim)
            live = PSID.get_ybus(inputs)
            lookup = PSID.get_lookup(inputs)
            n = length(lookup)
            ybus = PNM.Ybus(sys; include_constant_impedance_loads = false)
            base = PSID.transform_ybus_to_rectangular(SparseMatrixCSC{ComplexF32, Int}(ybus[:, :]))
            @test base == live
            @test ybus.lookup[1] == lookup

            # A fault alone: on at t_on, back to the base at t_clear.
            checked, err = TSD._check_disturbances(J([FAULT_7]), 5.0, sys)
            @test err === nothing
            perts = TSD._perturbations(checked, sys)
            @test [p.time for p in perts] == [1.0, 1.05]
            on, off = perts[1].ybus_rectangular, perts[2].ybus_rectangular
            @test off == live
            i = lookup[7]
            d = on - live
            y = 1 / complex(0.0, 1e-4)
            @test d[i, i] ≈ Float32(real(y))
            @test d[i, i + n] ≈ Float32(imag(y))
            @test d[i + n, i] ≈ -Float32(imag(y))
            @test count(!iszero, d) == 2 || count(!iszero, d) == 4
            @test all(iszero, d[setdiff(1:(2n), [i, i + n]), :])

            # After a trip: both matrices leave the tripped branch out, as
            # PSID's BranchTrip leaves its own matrix, which is the network
            # without that branch.
            checked, err = TSD._check_disturbances(J([FAULT_7, TRIP_78]), 5.0, sys)
            perts = TSD._perturbations(checked, sys)
            @test [p.time for p in perts] == [0.5, 1.0, 1.05]
            @test perts[1] isa PSID.BranchTrip
            br = TS._find_branch(sys, 7, 8, "1")
            tripped = copy(live)
            PSID.ybus_update!(tripped, br, lookup, -1.0)
            @test perts[3].ybus_rectangular == tripped
            @test perts[2].ybus_rectangular - tripped == d
            other = deepcopy(sys)
            PSY.set_available!(TS._find_branch(other, 7, 8, "1"), false)
            without = PSID.transform_ybus_to_rectangular(
                SparseMatrixCSC{ComplexF32, Int}(PNM.Ybus(other; include_constant_impedance_loads = false)[:, :]))
            @test maximum(abs.(Matrix(perts[3].ybus_rectangular - without))) <= 1e-3
            @test maximum(abs.(Matrix(live - without))) > 1.0
            # A trip at the instant of the clearing is applied after it.
            later = Dict("kind" => "branch_trip", "from" => 7, "to" => 8, "ckt" => "1", "t" => 1.05)
            checked, err = TSD._check_disturbances(J([later, FAULT_7]), 5.0, sys)
            perts = TSD._perturbations(checked, sys)
            @test [typeof(p) for p in perts] == [PSID.NetworkSwitch, PSID.NetworkSwitch, PSID.BranchTrip]
            @test perts[2].ybus_rectangular == live
        end

        @testset "a bus fault" begin
            s, pf = solved_kundur()
            ans = JSON3.read(TSD.tds_run_json(s; tf = 5.0, disturbances = J([FAULT_7])))
            @test ans[:ok] == true
            @test ans[:status] == "completed"
            ts = Float64.(ans[:t])
            cols = ans[:columns]
            v7 = [col_value(cols, r, "voltage"; bus = 7) for r in ans[:rows]]
            during = findall(t -> 1.0 < t < 1.05, ts)
            @test !isempty(during)
            @test maximum(v7[during]) < 0.05
            println("bus fault: largest bus 7 voltage during the fault $(maximum(v7[during])), at the end $(v7[end])")
            @test v7[end] > 0.7
            @test ts[end] == 5.0
            # PSID's results hold the instant of a disturbance more than once
            # (measured: three times at t_on).
            @test count(==(1.0), Float64.(ans[:post][:t])) >= 2

            # A fault whose admittance is zero to the matrix's precision
            # (r = 1e12 pu) leaves the run at its operating point.
            zero_fault = Dict("kind" => "bus_fault", "bus" => 7, "t_on" => 1.0, "t_clear" => 1.05, "r_pu" => 1e12)
            flat = JSON3.read(TSD.tds_run_json(s; tf = 2.0, disturbances = J([zero_fault])))
            @test flat[:status] == "completed"
            check_flat(flat, pf)
            first_row = rows_of(flat)[1]
            drift = maximum(maximum(abs.(r .- first_row)) for r in rows_of(flat))
            println("zero-admittance fault: largest change of any value from the first row $(drift)")
            @test drift <= 1e-9

            # A fault after a branch trip in the same run leaves the tripped
            # branch out: the last row's voltages differ from those of the
            # fault-only run.
            both = JSON3.read(TSD.tds_run_json(s; tf = 5.0, disturbances = J([TRIP_78, FAULT_7])))
            @test both[:status] == "completed"
            n_buses = length(pf[:buses])
            dv = maximum(abs.(rows_of(ans)[end][1:n_buses] .- rows_of(both)[end][1:n_buses]))
            println("fault after a trip against the fault alone, last row: $(dv)")
            @test dv > 1e-4
        end

        @testset "a generator trip" begin
            s, _ = solved_kundur()
            dist = J([Dict("kind" => "gen_trip", "bus" => 2, "id" => "1", "t" => 1.0)])
            ans = JSON3.read(TSD.tds_run_json(s; tf = 5.0, disturbances = dist))
            @test ans[:ok] == true
            @test ans[:status] == "completed"
            cols = ans[:columns]
            ts = Float64.(ans[:t])
            rest = [sum(col_value(cols, r, "rotor_speed"; bus = b) for b in (1, 3, 4)) / 3 for r in ans[:rows]]
            # PSID sets the tripped machine's states to zero.
            @test all(col_value(cols, ans[:rows][k], "rotor_speed"; bus = 2) == 0.0 for k in findall(>(1.0), ts))
            # The remaining machines slow down after losing 700 MW. With the
            # fixed exciters of this case (EXDC2 is left out) and impedance
            # loads the voltages then sag and the load with them, and the
            # speeds rise above 1 by the end (measured: lowest mean 0.9987
            # near 1.5 s, 1.0098 at 5 s), so the dip is what is held.
            window = findall(t -> 1.0 < t <= 2.0, ts)
            println("generator trip: lowest mean speed of the others $(minimum(rest[window])), at the end $(rest[end])")
            @test minimum(rest[window]) < 0.999
            p2 = only(x for x in ans[:post][:series] if String(x[:quantity]) == "p" && Int(x[:bus]) == 2)
            tp = Float64.(ans[:post][:t])
            @test all(abs(Float64(p2[:y][k])) <= 1e-6 for k in findall(>(1.0), tp))
            @test Float64(p2[:y][1]) > 600.0
            # The machine the network frequency is taken from cannot be tripped.
            ref = JSON3.read(TSD.tds_run_json(s; tf = 2.0, disturbances = J([Dict("kind" => "gen_trip", "bus" => 1, "id" => "1", "t" => 1.0)])))
            @test ref[:ok] == false
            @test ref[:stage] == "disturbances"
            @test occursin("frequency reference", String(ref[:error]))
        end

        @testset "the hook" begin
            s, _ = solved_kundur()
            seen_t = Float64[]
            seen = Vector{Vector{Float64}}()
            hook = (t, vals) -> (push!(seen_t, t); push!(seen, copy(vals)); nothing)
            ans = JSON3.read(TSD.tds_run_json(s; tf = 1.0, disturbances = J([TRIP_78]), on_step = hook))
            @test ans[:status] == "completed"
            @test seen_t[1] == 0.0
            @test seen_t == Float64.(ans[:t])
            @test seen == rows_of(ans)

            # Exactly false stops the run.
            stopper = (t, vals) -> t >= 0.5 ? false : true
            ans = JSON3.read(TSD.tds_run_json(s; tf = 5.0, on_step = stopper))
            @test ans[:ok] == true
            @test ans[:status] == "aborted"
            @test ans[:error] === nothing
            @test 0.5 <= Float64(ans[:t][end]) < 1.0
            @test count(t -> t >= 0.5, Float64.(ans[:t])) == 1
            @test length(ans[:t]) == length(ans[:rows])
            @test Float64(ans[:t][1]) == 0.0
            @test ans[:post] !== nothing
            # False at t = 0: nothing runs.
            ans = JSON3.read(TSD.tds_run_json(s; tf = 5.0, on_step = (t, v) -> false))
            @test ans[:status] == "aborted"
            @test Float64.(ans[:t]) == [0.0]

            # An exception fails the run and is reported, never propagated.
            thrower = (t, vals) -> t >= 0.5 ? error("hook blew up") : nothing
            ans = nothing
            @test (ans = JSON3.read(TSD.tds_run_json(s; tf = 5.0, on_step = thrower)); true)
            @test ans[:ok] == true
            @test ans[:status] == "failed"
            @test occursin("hook blew up", String(ans[:error]))
            @test Float64(ans[:t][end]) < 1.0
            ans = JSON3.read(TSD.tds_run_json(s; tf = 5.0, on_step = (t, v) -> error("at once")))
            @test ans[:status] == "failed"
            @test Float64.(ans[:t]) == [0.0]
            ans = JSON3.read(TSD.tds_run_json(s; tf = 1.0, on_step = 5))
            @test ans[:status] == "failed"

            # Anything but false continues to the end.
            for r in (nothing, 0, "false", missing)
                ans = JSON3.read(TSD.tds_run_json(s; tf = 1.0, on_step = (t, v) -> r))
                @test ans[:status] == "completed"
                @test Float64(ans[:t][end]) == 1.0
            end
            kinds = Set{Type}()
            JSON3.read(TSD.tds_run_json(s; tf = 0.2, on_step = (t, v) -> (push!(kinds, typeof(v)); nothing)))
            @test kinds == Set{Type}([Vector{Float64}])

            # A hook written in Python returns a `Py`: Python's False stops the
            # run, True and None do not. Loading PythonCall needs a Python;
            # without JULIA_PYTHONCALL_EXE it would make a conda environment,
            # so then this check is skipped with a printed line.
            if haskey(ENV, "JULIA_PYTHONCALL_EXE") && Base.find_package("PythonCall") !== nothing
                @eval Main using PythonCall
                pc = Main.PythonCall
                stop_py = Base.invokelatest(pc.pyeval, "lambda t, v: False if t >= 0.5 else None", Main)
                ans = JSON3.read(TSD.tds_run_json(s; tf = 5.0, on_step = (t, v) -> Base.invokelatest(stop_py, t, v)))
                @test ans[:status] == "aborted"
                @test 0.5 <= Float64(ans[:t][end]) < 1.0
                for name in ("True", "None")
                    r = Base.invokelatest(getproperty, pc.pybuiltins, Symbol(name))
                    ans = JSON3.read(TSD.tds_run_json(s; tf = 1.0, on_step = (t, v) -> r))
                    @test ans[:status] == "completed"
                end
                @test TSD._is_false(Base.invokelatest(getproperty, pc.pybuiltins, :False))
            else
                println("SKIP the Python hook: set JULIA_PYTHONCALL_EXE to a Python to check that a Py False stops a run")
            end
        end

        @testset "refusals" begin
            s = load_fixture_case(KUNDUR)
            for ans in (JSON3.read(TSD.tds_run_json(s; tf = 1.0)), JSON3.read(TSD.eig_json(s)))
                @test ans[:ok] == false
                @test ans[:stage] == "not_ready"
                @test occursin("power flow", String(ans[:error]))
            end

            s, _ = solved_kundur()
            refuse(d; tf = 2.0) = JSON3.read(TSD.tds_run_json(s; tf = tf, disturbances = d isa AbstractString ? d : J(d)))
            function refused(d, words...; tf = 2.0, stage = "disturbances")
                ans = refuse(d; tf = tf)
                @test ans[:ok] == false
                @test ans[:stage] == stage
                for w in words
                    @test occursin(w, String(ans[:error]))
                end
                return ans
            end
            refused([Dict("kind" => "meteor", "t" => 1.0)], "entry 1", "meteor")
            refused([TRIP_78, Dict("kind" => "branch_trip", "from" => 1, "to" => 2, "ckt" => "1", "t" => 1.0)], "entry 2", "branch_trip", "1-2")
            refused([Dict("kind" => "branch_trip", "from" => 7, "to" => 8, "ckt" => "1", "t" => 3.0)], "entry 1", "outside")
            refused([Dict("kind" => "branch_trip", "from" => 7, "to" => 8, "ckt" => "1", "t" => 0.0)], "outside")
            refused([Dict("kind" => "bus_fault", "bus" => 7, "t_on" => 1.0, "t_clear" => 0.5, "x_pu" => 0.01)], "entry 1", "t_clear")
            refused([Dict("kind" => "bus_fault", "bus" => 7, "t_on" => 1.0, "t_clear" => 2.0, "x_pu" => 0.01)], "t_clear", "outside")
            refused([Dict("kind" => "bus_fault", "bus" => 7, "t_on" => 1.0, "t_clear" => 1.1, "r_pu" => 0.0, "x_pu" => 0.0)], "entry 1", "impedance")
            refused([Dict("kind" => "bus_fault", "bus" => 7, "t_on" => 1.0, "t_clear" => 1.1)], "impedance")
            refused([Dict("kind" => "bus_fault", "bus" => 99, "t_on" => 1.0, "t_clear" => 1.1, "x_pu" => 0.01)], "bus 99")
            refused([Dict("kind" => "gen_trip", "bus" => 5, "id" => "1", "t" => 1.0)], "bus 5")
            refused([Dict("kind" => "branch_trip", "to" => 8, "ckt" => "1", "t" => 1.0)], "missing from")
            refused([Dict("kind" => "branch_trip", "from" => "7", "to" => 8, "ckt" => "1", "t" => 1.0)], "bus numbers")
            refused([Dict("kind" => "branch_trip", "from" => 7.5, "to" => 8, "ckt" => "1", "t" => 1.0)], "bus numbers")
            refused([Dict("kind" => "branch_trip", "from" => 7, "to" => 8, "ckt" => "1", "t" => true)], "t must be a number")
            refused([Dict("kind" => "bus_fault", "bus" => 7, "t_on" => 1.0, "t_clear" => 1.1, "x_pu" => "big")], "numbers")
            refused([TRIP_78, TRIP_78], "entry 2", "twice")
            refused([FAULT_7, Dict("kind" => "bus_fault", "bus" => 8, "t_on" => 1.02, "t_clear" => 1.2, "x_pu" => 0.01)], "entry 2", "overlap")
            refused("not json", "JSON"; stage = "arguments")
            refused("{}", "list"; stage = "arguments")
            refused("[1]", "entry 1"; stage = "arguments")
            # The circuit id may come as a number.
            ok = refuse([Dict("kind" => "branch_trip", "from" => 7, "to" => 8, "ckt" => 1, "t" => 1.0)])
            @test ok[:ok] == true

            # Trips that split the network, found by the test's own count:
            # a branch that is the only connection of a generator's bus, and
            # two branches that only split it together.
            base = network_parts(s.sys)
            brs = [br for br in PSY.get_components(PSY.ACBranch, s.sys) if PSY.get_available(br)]
            single = [br for br in brs if network_parts(s.sys, (PSY.get_name(br),)) > base]
            @test !isempty(single)
            gen_buses = Set(Int(g[:bus]) for g in JSON3.read(TS.topology_json(s))[:generators])
            lone = first(br for br in single if !isempty(intersect(Set(TS._arc_numbers(br)), gen_buses)))
            f, t = TS._arc_numbers(lone)
            refused([branch_entry(lone)], "entry 1", "split", "$(f)-$(t)")
            pair = first((a, b) for a in brs for b in brs
                         if PSY.get_name(a) < PSY.get_name(b) && !(a in single) && !(b in single) &&
                            network_parts(s.sys, (PSY.get_name(a), PSY.get_name(b))) > base)
            @test refuse([branch_entry(pair[1])])[:ok] == true
            refused([branch_entry(pair[1]), branch_entry(pair[2]; t = 1.5)], "entry 2", "split")

            # Arguments a caller can get wrong.
            for kw in ((tf = -1.0,), (tf = 0.0,), (tf = "2",), (tf = NaN,), (tf = Inf,), (;),
                       (tf = 2.0, step = 0.0), (tf = 2.0, step = -0.01), (tf = 2.0, step = "x"),
                       (tf = 2.0, load_model = "zip"), (tf = 2.0, load_model = 3), (tf = 2.0, disturbances = 5))
                ans = JSON3.read(TSD.tds_run_json(s; kw...))
                @test ans[:ok] == false
                @test ans[:stage] == "arguments"
                @test !isempty(String(ans[:error]))
            end
            for ans in (JSON3.read(TSD.eig_json(s; matrix_file = 5)), JSON3.read(TSD.dyn_plan_json(s; load_model = nothing)),
                        JSON3.read(TSD.tds_init_json(s; load_model = "zip")))
                @test ans[:ok] == false
                @test ans[:stage] == "arguments"
            end
        end

        @testset "a generator without a dynamic model" begin
            # PSID 0.16 wraps a generator without a dynamic model only when it
            # is a Source; anything else fails its build with a MethodError.
            # The plan names such generators and nothing is built.
            s = load_fixture_case(KUNDUR)
            g = PSY.get_component(PSY.StaticInjection, s.sys, "generator-4-1")
            PSY.remove_component!(s.sys, PSY.get_dynamic_injector(g))
            @test JSON3.read(TS.pflow_json(s))[:converged] == true
            plan = JSON3.read(TSD.dyn_plan_json(s))
            @test plan[:ready] == false
            @test occursin("bus 4 id 1", String(plan[:reason]))
            @test [(Int(x[:bus]), String(x[:id])) for x in plan[:static_generators]] == [(4, "1")]
            @test length(plan[:machines]) == 3
            @test length(plan[:columns]) == 2 * 10 + 2 * 3
            for ans in (JSON3.read(TSD.eig_json(s)), JSON3.read(TSD.tds_run_json(s; tf = 1.0)), JSON3.read(TSD.tds_init_json(s)))
                @test ans[:ok] == false
                @test ans[:stage] == "not_ready"
                @test occursin("without a dynamic model", String(ans[:error]))
            end
        end

        @testset "the session is untouched" begin
            # pflow_json solves again on every call, so it is compared with a
            # twin session that had the same calls except the dynamics.
            s, _ = solved_kundur()
            twin, _ = solved_kundur()
            topo_before = TS.topology_json(s)
            report_before = TS.report_json(s)
            units_before = PSY.get_units_base(s.sys)
            n_before = length(collect(PSY.get_components(PSY.Component, s.sys)))
            @test JSON3.read(TSD.dyn_plan_json(s))[:ok] == true
            @test JSON3.read(TSD.eig_json(s; matrix_file = joinpath(s.scratch, "m.bin")))[:ok] == true
            @test JSON3.read(TSD.tds_init_json(s))[:ok] == true
            for lm in ("impedance", "power", "as-case")
                @test JSON3.read(TSD.tds_run_json(s; tf = 2.0, load_model = lm, disturbances = J([TRIP_78, FAULT_7])))[:ok] == true
            end
            @test JSON3.read(TSD.tds_run_json(s; tf = 2.0, disturbances = J([Dict("kind" => "gen_trip", "bus" => 3, "id" => "1", "t" => 1.0)])))[:ok] == true
            @test TS.topology_json(s) == topo_before
            @test TS.report_json(s) == report_before
            @test PSY.get_units_base(s.sys) == units_before
            @test length(collect(PSY.get_components(PSY.Component, s.sys))) == n_before
            @test all(PSY.get_available(br) for br in PSY.get_components(PSY.ACBranch, s.sys))
            @test TS.pflow_json(s) == TS.pflow_json(twin)
            @test TS.topology_json(s) == TS.topology_json(twin)
            # Only the sim folder (and the matrix file asked for) is written.
            @test sort(readdir(s.scratch)) == sort(vcat(readdir(twin.scratch), ["m.bin", "sim"]))
            @test readdir(joinpath(s.scratch, "sim")) == [PSID.SIMULATION_LOG_FILENAME]
        end

        @testset "clean streams" begin
            s, _ = solved_kundur()
            out = tempname()
            err = tempname()
            open(out, "w") do o
                open(err, "w") do e
                    redirect_stdio(stdout = o, stderr = e) do
                        TSD.dyn_plan_json(s)
                        TSD.eig_json(s)
                        TSD.tds_init_json(s)
                        TSD.tds_run_json(s; tf = 2.0, disturbances = J([TRIP_78, FAULT_7]))
                        # A run IDA cannot finish.
                        TSD.tds_run_json(s; tf = 3.0, load_model = "power", disturbances = J([Dict("kind" => "gen_trip", "bus" => 2, "id" => "1", "t" => 1.0)]))
                        TSD.tds_run_json(s; tf = 1.0, on_step = (t, v) -> error("x"))
                    end
                end
            end
            @test read(out, String) == ""
            @test read(err, String) == ""

            # Sundials writes from C, which redirect_stdio does not see on
            # every platform and which C buffers until the process ends: a
            # second Julia process runs the same calls, a failed run among
            # them, and its own streams must be empty.
            script = """
                using JSON3
                include($(repr(joinpath(JULIA_DIR, "TensaSienna.jl"))))
                include($(repr(joinpath(JULIA_DIR, "TensaSiennaDyn.jl"))))
                fx = JSON3.read(read($(repr(joinpath(FIXTURES, "kundur.json"))), String))
                s = TensaSienna.load_case(joinpath($(repr(CASES_DIR)), String(fx[:raw])), joinpath($(repr(CASES_DIR)), String(fx[:dyr])); scratch = mktempdir())
                TensaSienna.pflow_json(s)
                a = JSON3.read(TensaSiennaDyn.eig_json(s))[:ok]
                b = JSON3.read(TensaSiennaDyn.tds_run_json(s; tf = 3.0, load_model = "power", disturbances = JSON3.write([Dict("kind" => "gen_trip", "bus" => 2, "id" => "1", "t" => 1.0)])))[:status]
                c = JSON3.read(TensaSiennaDyn.tds_run_json(s; tf = 2.0, disturbances = JSON3.write([Dict("kind" => "bus_fault", "bus" => 7, "t_on" => 1.0, "t_clear" => 1.05, "x_pu" => 1e-4)])))[:status]
                write(ARGS[1], string(a, " ", b, " ", c))
                """
            dir = mktempdir()
            write(joinpath(dir, "child.jl"), script)
            marker = joinpath(dir, "marker.txt")
            cout = joinpath(dir, "stdout.txt")
            cerr = joinpath(dir, "stderr.txt")
            project = dirname(Base.active_project())
            cmd = `$(Base.julia_cmd()) --startup-file=no --project=$(project) $(joinpath(dir, "child.jl")) $(marker)`
            t = @elapsed proc = run(pipeline(ignorestatus(cmd); stdout = cout, stderr = cerr))
            println("clean streams: the second process took $(round(t, digits = 1)) s")
            @test success(proc)
            @test isfile(marker) && read(marker, String) == "true failed completed"
            @test read(cout, String) == ""
            @test read(cerr, String) == ""
            isempty(read(cerr, String)) || println("child stderr: ", first(read(cerr, String), 2000))
        end
    end

    @testset "the zero eigenvalue" begin
        # Rounding noise of either sign around the zero eigenvalue is answered
        # as zero, relative to the size of the matrix; a small real mode is not.
        A = [0.0 1000.0; -1.0 0.0]
        eigs, settled, tol = TSD._settle_zero([3e-13 + 0im, -3e-13 + 0im, -1e-4 + 0im, 0.0 + 0im], A)
        @test eigs == [0.0, 0.0, -1e-4, 0.0]
        @test settled == 2
        @test tol == 1e-9 * 1000.0
    end

    @testset "numbers JSON cannot hold" begin
        # A run that diverges can hold NaN, which JSON3 refuses to write.
        x = (rows = [[1.0, NaN], [Inf, 2.0]], post = (t = [0.0], series = Any[(y = [-Inf],)]), n = 3)
        @test TSD._to_json(x) == """{"rows":[[1.0,null],[null,2.0]],"post":{"t":[0.0],"series":[{"y":[null]}]},"n":3}"""
    end

    @testset "a case with no .dyr" begin
        raw, _ = fixture_files(KUNDUR)
        if !isfile(raw)
            println("SKIP no-dyr: $(KUNDUR[:raw]) is not in $(CASES_DIR)")
        else
            s = load_fixture_case(KUNDUR; dyr = nothing)
            @test JSON3.read(TS.pflow_json(s))[:converged] == true
            plan = JSON3.read(TSD.dyn_plan_json(s))
            @test plan[:ok] == true
            @test plan[:ready] == false
            @test plan[:reason] == "the case has no dynamic models"
            @test isempty(plan[:machines])
            for ans in (JSON3.read(TSD.eig_json(s)), JSON3.read(TSD.tds_run_json(s; tf = 1.0)), JSON3.read(TSD.tds_init_json(s)))
                @test ans[:ok] == false
                @test ans[:stage] == "not_ready"
                @test String(ans[:error]) == "the case has no dynamic models"
            end
        end
    end

    @testset "every sample case with a .dyr" begin
        # The cases runtests.jl lists (its fixtures), taken with their .dyr,
        # loaded as the engine loads them; then the other .dyr files beside
        # them in the cases folder. What PSID builds is printed, one line per
        # case.
        cases = Any[]
        for name in ("kundur", "ieee14", "ieee39", "wscc9", "npcc", "wecc")
            fx = load_fixture(name)
            fx[:dyr] === nothing && (println("$(name): no .dyr in its fixture"); continue)
            fixture_present(fx) || continue
            push!(cases, (name, () -> load_fixture_case(fx)))
        end
        for (name, raw, dyr) in (
            ("kundur_gencls", "kundur/kundur.raw", "kundur/kundur_gencls.dyr"),
            ("ieee14_ieeevc", "ieee14/ieee14_ieeevc.raw", "ieee14/ieee14_ieeevc.dyr"),
            ("wecc_gencls", "wecc/wecc.raw", "wecc/wecc_gencls.dyr"),
            ("nordic44", "nordic44/N44_BC.raw", "nordic44/N44_BC.dyr"),
        )
            r, d = joinpath(CASES_DIR, raw), joinpath(CASES_DIR, dyr)
            (isfile(r) && isfile(d)) || (println("SKIP $(name): $(raw) or $(dyr) is not in $(CASES_DIR)"); continue)
            push!(cases, (name, () -> TS.load_case(r, d; scratch = mktempdir())))
        end
        for (name, load) in cases
            s = load()
            if JSON3.read(TS.pflow_json(s))[:converged] != true
                println("$(name): power flow did not converge, skipped")
                continue
            end
            ans = nothing
            @test (ans = JSON3.read(TSD.eig_json(s)); true)
            ans === nothing && continue
            if ans[:ok] == true
                @test length(ans[:eigenvalues]) == ans[:n_states]
                @test length(ans[:states]) == ans[:n_states]
                println("$(name): ok, $(ans[:n_states]) states, $(ans[:stable] ? "stable" : "unstable")")
            else
                @test !isempty(String(ans[:error]))
                println("$(name): $(ans[:stage]) refused: $(ans[:error])")
            end
        end
    end
end

println("TENSA SIENNA DYN TESTS OK")
