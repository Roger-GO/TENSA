# Phase 7 report: Sienna-only capabilities

A Sienna session can now build the network matrices of its case, solve a DC power flow, run a one-period economic dispatch on four network models including AC, commit units over a horizon, simulate a day in two stages, and put dynamic lines and PSID inverters on a time-domain run through `ext.sienna`. All of it goes through the routes an ANDES session knows or new ones of the same shape; an ANDES session answers 409 on the new routes and keeps its own `GET /ybus`.

## What exists now

| Piece | Where | What it does |
|---|---|---|
| Network matrices | `GET /sessions/{id}/network-matrix?kind=ptdf\|lodf\|ybus\|incidence`, `TensaSiennaNet.jl` | Builds the matrix with PowerNetworkMatrices and answers it with its axes in TENSA keys: branches by bus pair with every circuit's key, buses by key, the reference buses of a PTDF. A dense matrix is refused by its size before its file is read; the Ybus is listed as its nonzero entries. The scratch files are removed once read. |
| DC power flow | `POST /sessions/{id}/pflow` with `method: dc` or `ptdf-dc` | PowerFlows' `DCPowerFlow` and `PTDFDCPowerFlow`, solved on a copy of the session's System. A DC result has the AC result's shape with every reactive power null and says its method in `settings`. `GET /engines` lists each engine's power flow methods. |
| Web for matrices and DC | power flow options, Network matrices command and dialog | The options offer `dc` and `ptdf-dc` where the engine lists them and leave out the AC-only settings; the summary shows a DC power flow's reactive power as a dash. The dialog shows a matrix as a table labelled by element key, searchable and downloadable as CSV. |
| One-period economic dispatch | `POST /sessions/{id}/dispatch`, `TensaSiennaOps.jl` | PowerSimulations 0.34.2 with HiGHS 1.27.0 on a copper plate, a DC network or PTDF flows (`network_model` is required), and with `network_model: "ac"` PowerSimulations' `ACPPowerModel` solved with Ipopt 1.16.0. The answer carries the solver's objective and the cost recomputed from the dispatch and the file's coefficients, generators by neutral key, slack variables past 1e-6 MW and, on request, duals. The AC answer adds each bus's voltage and angle, each generator's reactive power, each branch's flows at both ends and its losses, and the total losses. A PSS/E `.raw` case is refused with 422 before Julia runs: it has no cost data. |
| Operations data | `engines/op_series.py`, `op` block on case-document generators, `optimization` table in results | A generator's `op` block comes from the MATPOWER file (PMIN, PMAX, the RAMP_10 column in MW per minute or null where the file gives 0, the gencost model and coefficients in $/h of MW, start-up and shut-down costs); a PSS/E file has none of these, so its `op` block is null. A load profile is factors over steps at a resolution, for every load or per load key; `apply_series!` writes it as each load's `max_active_power` series on a copy of the System and makes one forecast window over the whole profile. `POST /results/convert` takes `kind: dispatch` to build a results document from a dispatch answer. |
| Unit commitment | `POST /sessions/{id}/uc` | PowerSimulations and HiGHS (a mixed-integer model, relative gap 1e-9) over a horizon at a resolution, the load following the request's profile. Thermal units take `ThermalStandardUnitCommitment`, which holds a generator's minimum up and down times. The answer gives each period's on/off and MW per generator, the cost split into energy, start-up and fixed, the solver's objective beside the cost recomputed from the dispatch, and slacks. |
| Two-stage day | `POST /sessions/{id}/sim` | A day-ahead unit commitment at hourly resolution, then a real-time economic dispatch every 15 minutes held to that commitment by a `SemiContinuousFeedforward` on `OnVariable`. The answer gives per stage each generator's MW per step, the day-ahead on/off per hour, each stage's cost recomputed from its dispatch and the file's gencost, and slacks, keyed by neutral key. |
| Dynamic lines and inverters | `ext_sienna` on a TDS request | `dynamic_branches` turns branches into PSID `DynamicBranch` and the run reports each one's current at both ends (`i_from\|<key>`, `i_to\|<key>`); `inverters` gives a generator with no dynamic model one of two PSID inverters (`inv_gfoll` of test24.jl, grid following, and `inv_case78`, grid forming), validated in Python against the list `GET /engines` publishes. An ANDES session refuses the block with 422, as does the streamed run. |
| Julia environment | `envs/dyn` | PowerSimulations 0.34.2, HiGHS 1.27.0 and Ipopt 1.16.0 added with every package already there held at its version (`Pkg.PRESERVE_ALL`): Julia stays 1.13.4, no package changed or was removed, 28 were added for PowerSimulations (JuMP, MathOptInterface, PowerModels and their dependencies), then Ipopt with Ipopt_jll, ASL_jll, METIS_jll, MUMPS_seq_jll and SPRAL_jll. One embedded Julia per worker cannot switch projects after it starts, so a second environment could not serve the same session. |

## Evidence

**DC power flow.** The Julia tests (`runtests_dcpf.jl`, in the sienna workflow's loop) hold the three-bus triangle to its hand-computed flows with a slack scheduled off the balance and a nonzero reference angle. The route tests hold Kundur's DC flows to its AC ones within the AC losses and its slack to the lossless balance of 634 MW.

**Economic dispatch**, hand-worked cases held by `server/tests/julia/runtests_ops.jl`:

| Case | Result |
|---|---|
| Linear costs 10 and 20 $/MWh for 150 MW | 150/0 MW, 1500 $/h |
| Quadratic 0.1P^2+10P and 0.1P^2+20P | 100/50 MW, 3250 $/h, also with one generator on a 200 MVA base |
| A line rated 80 MW that binds under dc and ptdf | 90/60 MW, 2100 $/h |
| AC two-bus case, solved outside PowerSimulations by a direct search over the two voltages with the angle that delivers the load | V1 = 1.1, V2 = 1.0855 pu at -4.887 degrees, losses 1.7099 MW, 1017.099 $/h |
| MATPOWER case14 DC OPF | the published 7642.59 $/h |

**AC optimal power flow on MATPOWER case14**: 8088.22 $/h against MATPOWER's published 8081.53. The whole gap is the bus shunt at bus 9: PowerSimulations hands PowerModels an empty shunt table and has no model of a fixed admittance, and PowerModels' own `solve_ac_opf` with Ipopt gives 8081.5247 $/h on the file and 8088.22385 $/h, with bus 9 at the same 1.0178795 pu, with its shunt table emptied. An AC answer now names the shunts it leaves out.

**Operations data.** Checked against MATPOWER case14: the five generators' limits and costs equal the file's. The Julia test holds a four-period profile to the factors it was given, scaled by the load's 150 MW, in one four-hour forecast.

**Unit commitment**, hand-worked: A at 10 $/MWh with a 50 MW minimum and a 500 $ start-up, B at 30 $/MWh, a load of 40, 120, 150, 40 MW: A on in hours 2 and 3, 5600 $ (enumerated over the 16 patterns); with a 3 hour minimum up time A cannot start at all and B serves the day at 10500 $.

**Two-stage day** (`runtests_ops.jl`, `test_sienna_sim.py`): A committed in hours 2 and 3 only, A at 0 MW in every real-time period of hours 1 and 4 to 24, day-ahead cost 29600 $ (energy 29100, one start-up 500), real-time 29100 $. Removing the feed-forward makes the real-time stage infeasible and the test fail.

**Dynamic lines and inverters.** On Kundur with circuit 7-8-2 tripped at 0.1 s and 7-8-1 dynamic, bus 8's voltage agrees with the static run to 1.2e-7 before the trip, differs by up to 2.8e-3 in the milliseconds after it and agrees to 4.7e-5 from 0.5 s on; an inverter on bus 2's generator holds its 700 MW through a 1 s run.

## What went wrong, and what changed because of it

- **PowerFlows' DC report is wrong for a case read from a file in two places.** It solves the angles with the reference at 0 but works the flows out of the reference bus's stored angle, and it reports a reference generator's schedule rather than the balance it takes up. The solve now runs with the reference angle at 0, the angles are reported shifted back, and the reference generators' output comes from the flows leaving their bus. Generators and loads are read on the system base. A dynamic analysis refuses to start after a DC power flow, which leaves no operating point.
- **PowerSystems reads MATPOWER gencost with the file's own $/MW numbers but labels them per unit** (`DEVICE_BASE`, relabelled `NATURAL_UNITS`), which PowerSimulations then prices on per-unit power, so a quadratic term weighed 100 times too little. Each cost curve is now labelled as natural units on the copy.
- **Ramp limits.** PowerSystems takes a MATPOWER generator's RAMP_AGC whenever the column exists (so 0 becomes a limit of 0, which pins a unit under unit commitment) and otherwise RAMP_10 undivided (MW per 10 minutes read as MW per minute). The `op` block now publishes RAMP_AGC when it is nonzero, else RAMP_10 / 10, else none, and unit commitment and the two-stage day enforce exactly that rate on their copy; the one-period dispatch has no ramp constraint (`ThermalBasicDispatch`).
- **The template's keyword is `network=` and an unknown keyword is silently ignored.** The template is given its network by the keyword it reads and the network model is checked after the template is built; the template keeps the copper plate for any other keyword.
- **`StandardLoad` is left out of the balance** unless given `StaticPowerLoad`; it now joins the balance, and an answer whose dispatch does not meet the load is an error.
- **Unit commitment needs `ThermalStandardUnitCommitment` for minimum up and down times**; the template's own `ThermalBasicUnitCommitment` ignores them.
- **Start-up costs.** PowerSystems does carry gencost STARTUP; the module had also set it from the case facts, matched by row order on each bus, which a non-thermal row before a thermal one shifted. The case facts' setting is gone (a request's override stays, matched by the generator's row).
- **A single forecast window is stored with an interval of zero, which no model can name.** The two-stage day gives its hourly series two days.
- **`build!` of a whole Simulation takes no `output_dir`.** PowerSimulations' build files go to a folder inside the session's scratch folder (spec section 12) for the simulation and for the dispatch and unit commitment routes, which used the system's temporary directory.
- **The AC dispatch added `DispatchBusSchema` and `DispatchBranchSchema` to `api/schemas/dispatch.py` and left them out of the package's exports**, which `tests/unit/test_schemas_package.py` holds every model to. Fixed in 482f057d.
- **The TDS route used Starlette's renamed 422 constant**, which the status-name test refuses; server CI on 9318197e failed on it and 85376209 fixed it.
- **PowerSystems' PSS/E reader turns a generator with no `.dyr` record into a voltage Source, on which PSID cannot hold an inverter.** The run's copy of the System gives the generator back as a `ThermalStandard` with the Source's dispatch first. The inverter's base power is 100 MVA, because MBASE is lost when PowerSystems builds the Source it replaces. Removing Julia's temporary files is best effort, since on Windows another handle can hold one.

## Open points

- **The AC dispatch leaves bus shunts out**, because PowerSimulations' AC model has none: on case14 that is the whole 0.08 percent gap to MATPOWER. Including them would mean editing the built model's reactive balance constraints. The answer names the shunts it leaves out.
- **A PSS/E case has no operations data.** Its `op` block is null, and the dispatch, unit commitment and two-stage day routes refuse it with 422 before Julia runs, because PowerSystems gives its generators a placeholder cost. Costs and limits for PSS/E cases are not in the case document yet.
- **The inverter's base power is fixed at 100 MVA**, since MBASE is lost when PowerSystems builds the Source the inverter replaces.
- **The dispatch answers thermal units only.** A case with an in-service renewable unit (a MATPOWER file with `gentype`) has it take load in the optimisation, and the answer's balance check then refuses the result.
- **A must-run unit's constant cost** is left out of PowerSimulations' unit commitment objective; the recomputed cost includes it.
- **The operations routines are Sienna-only.** ANDES has none of them; ANDES's own one-period optimal power flow runs through its pandapower bridge and is an ANDES gap item, deferred with the rest of the bridge.

## Review

A review of the phase by a second model (Fable), read-only on 58c2260f, read the code against the installed package sources and redid the hand-worked numbers (all right). What it found, and what was done (a subagent fixed them in 8ac8d38e, each with a test that fails on the old code, and every Julia suite and the integration tests with Julia were run on the branch with the other fixes in it):

| Finding | Disposition |
|---|---|
| The gencost constant term c0 was in no recomputed cost (PowerSystems puts it in `fixed`); a dispatch sat below MATPOWER's cost by the sum of c0 (case9: 1085 $/h), and unit commitment's check differed from its objective by c0 per committed period | Fixed: the dispatch's check is MATPOWER's cost with a `fixed_per_h` beside the solver's objective; unit commitment charges c0 times the step length |
| Unit commitment at 15 or 30 minutes threw (`Hour(0.25)`), and its energy was not multiplied by the step length | Fixed, with a hand-worked 15-minute case (1795 $) |
| The AC dispatch leaves bus shunts out | Confirmed to be the whole case14 gap; documented, and the answer names the shunts |
| The AC answer read `Line` and `TapTransformer` only, missing a `Transformer2W` (TAP 1.0) | Fixed |
| The ramp the `op` block published was not the one unit commitment enforced | Fixed (see above) |
| A start-up cost could attach to the wrong unit | Fixed (matched by row) |
| Run folders stayed until Julia exited; a Ybus was written and read dense before any size check | Fixed: every run folder is removed in a `finally`; the Ybus is written sparse and its size is checked first |
| Report claims: "PowerSystems does not carry STARTUP" is false; a zero ramp pins only unit commitment; the template keyword and `ThermalBasicUnitCommitment` are documented behaviour, not defects | Corrected above |
| Spec departures: DC power flow as a `pflow` method, operations as fixed shapes, no reserves, renewable series or template field | Decisions 44 and 45 |

## Findings for upstream

Offered to the maintainers only if the project's owner wants to; none is filed.

- PowerFlows' DC power flow solves the angles with the reference at 0 but works the flows out of the reference bus's stored angle, and reports a reference generator's schedule rather than the balance it takes up.
- PowerSystems reads MATPOWER gencost with the file's $/MW numbers but labels them per unit (`DEVICE_BASE`, relabelled `NATURAL_UNITS`), so PowerSimulations prices a quadratic term 100 times too low.
- PowerSystems reads MATPOWER's RAMP_10 (MW in 10 minutes) as a rate per minute when RAMP_AGC is absent.
- PowerSimulations' AC network model leaves a case's fixed shunts out of the optimisation (the translator hands PowerModels an empty shunt table).
- PowerSimulations leaves a must-run unit's constant cost term out of a unit commitment's objective.
- PowerNetworkMatrices 0.20 keeps the admittance matrix in ComplexF32, which leaves a power mismatch of up to 0.0037 MW at one bus of ieee118 measured in double precision (Phase 6).
