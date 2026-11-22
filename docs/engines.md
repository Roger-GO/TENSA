# Engines

TENSA runs every study on one of two engines behind the same API: `andes` (ANDES 2.x, Python) and `sienna` (PowerSystems.jl for data, PowerFlows.jl, PowerSimulationsDynamics.jl for dynamics, PowerSimulations.jl for operations, in Julia). The routes, the JSON and the element keys are the same for both. This page says what an engine is, what each one can do, and how to compare them.

## What an engine is

An engine is the simulator a session runs on. A session is created for one engine and keeps it: comparison is two sessions on one study, not one session with two engines. A request that names no engine gets `andes`, and every route answers as it does today for an ANDES session.

`POST /api/sessions` takes one optional field, `engine`:

```bash
curl -s -X POST $BASE/sessions \
  -H 'Content-Type: application/json' \
  -d '{"engine": "sienna"}'
```

No body or `{}` still means ANDES. `GET /api/sessions/{id}` reports the session's `engine`.

`GET /api/engines` lists every engine the server can start, available or not, with what each can do. It needs no session and never loads an engine:

```json
{"engines": [{
  "name": "sienna",
  "available": true,
  "unavailable_reason": null,
  "versions": {"julia": "1.13.4", "PowerSystems": "5.12.5", "PowerFlows": "0.16.4", "PowerSimulationsDynamics": "0.16.2", "PowerSimulations": "0.34.2"},
  "formats": {"read": ["psse-raw", "psse-dyr", "matpower"], "write": []},
  "routines": ["matrices", "pflow", "eig", "tds", "dispatch", "uc", "sim"],
  "ops": ["..."],
  "models": {"GENROU": "exact", "TGOV1": "known-difference:tgov1-torque"},
  "editing": true
}]}
```

`available` is `false` with an `unavailable_reason` when Julia or the Sienna packages are not installed; ANDES is always available. Sienna needs `pip install "tensa[sienna]"`, Julia 1.13 (on `PATH` or `TENSA_JULIA`) and a run of `tensa warm-cache --engine sienna`, again after a TENSA upgrade; `unavailable_reason` says which is missing. `POST /sessions` with an engine that is not available answers 409 with the reason.

In the UI, the engine picker in the top bar chooses the engine and shows each engine's package versions. Switching engine releases the session on the server first; a case opened under one engine is never reopened or replayed into a session of another. The web client gates on capabilities: a routine the engine lacks is shown with its reason ("CPF is not available with Sienna; it is with ANDES").

## What each engine reads and runs

From `capabilities.py` and `ops.py`:

| | `andes` | `sienna` |
|---|---|---|
| Formats read | `xlsx`, `json`, `psse-raw`, `psse-dyr`, `matpower` | `psse-raw`, `psse-dyr`, `matpower` |
| Formats written | `xlsx`, `json`, `psse-raw`, `matpower` | none |
| Routines | `pflow`, `tds`, `eig`, `cpf`, `se` | `matrices`, `pflow`, `eig`, `tds`, `dispatch`, `uc`, `sim` |
| Editing | yes | yes, a subset |

The Sienna editing subset, from `routine_options.edit`: a load (`PQ`: `p0`, `q0`, `u`), a generator (`PV` or `Slack`: `p0`, `v0`, `u`), a line or transformer (`Line`: `u`) and a shunt (`Shunt`: `g`, `b`, `u`), one param per edit; a `PQ` or a `Shunt` can be added on a bus and a load or a shunt deleted. Each edit, undo and redo rebuilds the System from the case file with the edit log applied.

The Sienna-only routes:

- **Network matrices.** `GET /api/sessions/{id}/network-matrix?kind=ptdf|lodf|ybus|incidence` builds the matrix with PowerNetworkMatrices, per unit on `base_mva`, with its axes in TENSA keys. The dense kinds answer `values` row by row; `ybus` answers its nonzero `entries` as `{row, col, re, im}`. An ANDES session answers 409 and keeps `GET /api/sessions/{id}/ybus`.
- **DC power flow.** `POST /api/sessions/{id}/pflow` on a Sienna session takes `method`: `ac` (the default), or `dc` and `ptdf-dc`, PowerFlows' `DCPowerFlow` and `PTDFDCPowerFlow`. A DC result has the AC result's shape with every reactive power null and says its method in `settings`.
- **Economic dispatch.** `POST /api/sessions/{id}/dispatch` solves the one-period economic dispatch of a MATPOWER case with PowerSimulations and HiGHS. The body is `{"network_model": "copper_plate"|"dc"|"ptdf"|"ac", optional "duals": false}`. With `network_model` `ac` the model holds the full AC power flow equations, solved with Ipopt, and the answer also carries the bus voltages and angles, the generator reactive powers, the branch flows at both ends and the losses. The answer carries `objective_check_per_h` (the cost as MATPOWER counts it, recomputed from the dispatch and the file's gencost, every unit's constant term included), `objective_per_h` (the solver's objective, which leaves the constant terms out) and `fixed_per_h` (the sum of the constant terms, the difference between the two), generators keyed by neutral key, and every slack variable past 1e-6 MW. PowerSimulations' AC model leaves bus shunts out, and an AC answer for a case that has them carries a note naming them.
- **Unit commitment.** `POST /api/sessions/{id}/uc` commits and dispatches a MATPOWER case over a horizon at a resolution with PowerSimulations and HiGHS. The body is `{"network_model": "copper_plate"|"dc"|"ptdf", "horizon_h": 1..168, "resolution_min": 15|30|60, "series": one positive load factor per period, optional "overrides": {gen:<bus>-<id>: {"startup_cost", "min_up_h", "min_down_h", "must_run"}}}`. Every generator starts off, so one on in the first period pays its start-up, and each is held to the ramp rate its `op` block publishes. The answer gives each period's on/off and MW per generator, the cost split into energy, start-up and fixed, the solver's objective beside the recomputed cost, and slacks.
- **A day in two stages.** `POST /api/sessions/{id}/sim` runs a PowerSimulations simulation of one day: a day-ahead unit commitment at hourly resolution, then a real-time economic dispatch every 15 minutes held to that commitment (a generator the day-ahead stage left off runs at 0 MW in real time). The body is `{"load_profile": 96 factors of each load, one per 15 minutes, "network_model": "copper_plate"|"dc"|"ptdf"}`; the day-ahead stage sees each hour as the mean of its four quarter-hours. The answer gives, per stage, each generator's MW per step, the day-ahead on/off per hour, the cost of each stage recomputed from its dispatch and the file's gencost, and slacks.
- **Dynamic lines and inverters.** A TDS request of a Sienna session may carry `ext_sienna`: `dynamic_branches` turns branches into PSID `DynamicBranch` and the run reports each one's current at both ends (`i_from|<key>`, `i_to|<key>`); `inverters` gives a generator with no dynamic model one of two PSID inverters, `gfl-omib` (grid following) and `gfm-omib` (grid forming), each a parameter set PSID 0.16.2 itself tests. An ANDES session refuses the block with 422.

```json
{"ext_sienna": {"dynamic_branches": [{"target": "branch:7-8-1"}],
                "inverters": [{"target": "gen:2-1", "parameter_set": "gfl-omib"}]}}
```

### Opening an ANDES case under Sienna

Sienna reads PSS/E `.raw` and `.dyr` files and MATPOWER `.m` files, not ANDES's `.xlsx`. To open an `.xlsx` case under Sienna, open it in an ANDES session and save it as `raw` (`POST /api/sessions/{id}/save` with `"format": "raw"`, or Save system as in the UI): TENSA writes the `.raw` and, when the case has dynamic models, a `.dyr` beside it with the same name. Open the two in a Sienna session. The `.dyr` holds every dynamic model ANDES's PSS/E reader can read, in PSS/E's column order; a model PSS/E has no record for is left out and named in the save's notes.

The five example cases written this way open under Sienna with power flows within 4e-6 pu of the ANDES run of the `.xlsx`. Sienna holds their machines and governors; the EXDC2 (Kundur), ESST3A (IEEE 14) and IEEEX1 (IEEE 39, NPCC) exciters are models PowerSystems has no reader for, and a Sienna session lists them as `unsupported` (load with `"on_unsupported": "drop"`).

## An op an engine lacks

An op the engine's table lacks is answered by the worker's dispatch, not by the engine, so it costs nothing and cannot fail the way the op itself might: a 409 problem document whose `detail` names the op, the session's engine and the engines that have it (`'run_cpf' is not available with the sienna engine; engines that have it: andes`). A routine an engine lacks is absent from its capabilities and refused the same way.

## Element keys

Every element has a `key` built from the case, unique in it and the same in every engine that loads it: `bus:7`, `branch:7-8-1`, `gen:1-1`, `load:7-1`, `shunt:7-1`, and `gen:1-1/machine` for a dynamic model of a unit. `idx` stays, as the engine's own handle.

Keys are the same in both engines because TENSA reads them itself. ANDES's PSS/E reader discards the circuit id of a branch and the id of a load or shunt; PowerSystems keeps the ids in component names but not file order. `engines/identity.py` reads the identity columns of a `.raw` or `.m` file itself (bus numbers, ends, ids, in file order), and each adapter matches its elements to that list: ANDES by order, Sienna by id. No adapter invents an id. The key sets of the two engines are equal for buses, lines, transformers, generators, loads and shunts on the cases both can open.

`GET /api/sessions/{id}/keys` returns the whole map both ways. Every `TopologyEntry` carries `key`, and a power flow result carries `keys`, per kind, mapping the stringified `idx` of each result entry to its key.

## Comparing the engines

Three routes hold no session and work on results documents, the engine-neutral form of a result (`tensa_results: 1`).

- `POST /api/results/convert` turns one engine result into a results document. The body is `{"kind": "pflow"|"tds"|"eig"|"dispatch", "engine", "result", optional "versions", "study", "keys", "status"}`; the answer is `{"document", "skipped", "notes"}`.
- `POST /api/compare` takes two results documents (`{"reference", "comparison", optional "tolerances"}`) and answers the power flow comparison first (a dynamic difference that starts from a different operating point is reported as that, with `operating_point_differs`), then per series the largest and the time-weighted RMS difference over the overlap of the time ranges with the swing of the reference, then the eigenvalues matched as modes. Differences are comparison minus reference, wrapped to [-pi, pi) for radians. Unmatched keys and modes are listed, never ignored.
- `POST /api/studies` runs one study on several engines: `{"case": {"primary_path", "addfiles"}, "engines": ["andes", "sienna"], "study": {"tensa_study": 1, "routine", "options", "load_model", "disturbances", "record"}, optional "tolerances"}`. It creates a session per engine from the same case, runs the study on each, closes every session it made, and answers `{"outcomes", "comparisons"}`: each engine's results document, or its refusal for a routine it lacks, and each engine after the first compared against it as `POST /compare` answers. A study past 1800 s over all engines is 504.

A worked example, Kundur with a bus fault on both engines. Sienna refuses the EXDC2 exciters of `kundur_full.dyr`, so the study uses a copy of it that keeps the four GENROU records only (`kundur_genrou.dyr`, made by hand in the workspace):

```bash
curl -s -X POST $BASE/studies \
  -H 'Content-Type: application/json' \
  -d '{
    "case": {"primary_path": "kundur.raw", "addfiles": ["kundur_genrou.dyr"]},
    "engines": ["andes", "sienna"],
    "study": {
      "tensa_study": 1,
      "routine": "tds",
      "options": {"t_end": 5.0},
      "load_model": "impedance",
      "disturbances": [{"kind": "bus_fault", "bus": "bus:8", "t_on": 1.0, "t_clear": 1.1, "r_pu": 0, "x_pu": 0.05}],
      "record": [{"quantity": "rotor_speed", "of": "gen:*"}]
    }
  }'
```

The UI overlays series from both engines on the existing plots and adds a difference table, in the Compare results view opened from the command palette and the plot's export menu.

## Fidelity

Every dynamic model of a loaded case has a state for its engine:

- `exact`: the engine has the model and a like-for-like run against the reference engine agreed within the comparison tolerances.
- `known-difference:<id>`: the engine has the model and a registered entry says how it differs.
- `unverified`: the engine has the model and nobody has compared it yet. This is where every model starts.
- `unsupported`: the engine cannot hold it; `handling` says what the adapter did (`refused`, `dropped`, or `substituted:<model>`).

`GET /api/sessions/{id}/fidelity` lists the elements that are not `exact`, one entry per dynamic model, keyed by unit and role (`gen:1-1/governor`), sorted by key. ANDES is the reference engine for the models it has, so an ANDES session whose dynamics are all common models answers an empty list. Loading a case with `unsupported` elements fails unless the request passes `on_unsupported: "drop"`, and then the response carries the list.

The models both engines have were audited like for like on PowerSimulationsDynamics' own PSS/E benchmarks (one small case per model, with PSS/E's results), each run in both engines with the same disturbance and compared through `POST /compare` (`server/tests/integration/test_model_audits.py`):

| Model | Outcome | Largest rotor speed difference (pu) |
|---|---|---|
| GENROU | `exact`; the electromechanical modes are equal | 2.0e-7 |
| GENCLS | `exact`; modes equal | 9.3e-7 |
| SEXS | `exact` | 8.1e-7 |
| IEEEST | `exact` | 1.9e-7 |
| ESST1A | `exact` | 6.0e-6 on a swing of 7.7e-3 |
| ESAC1A | `known-difference:esac1a-rate-feedback` | 5.7e-4 |
| EXAC1 | `known-difference:exac1-transducer` | 1.0e-4 |
| EXST1 | `known-difference:exst1-output-limiter` (modes equal) | 4.5e-4 |
| GAST | `known-difference:gast-torque` | 1.5e-5 |
| HYGOV | `known-difference:hygov-torque` | 1.4e-5 |
| TGOV1 | `known-difference:tgov1-torque` | 1.0e-5 |
| REGCA1, REECB1, REPCA1 | `unverified` | 3.7e-8 |

The converter chain stays `unverified`: its runs agree, but its case has no electromechanical mode, and the converter's own eigenvalues differ between the engines (ANDES -50.0 ± 4.40j, Sienna -45.2 ± 8.70j) for a reason not yet found. The runs were made at a step of 1/480 s in ANDES and 1/240 s in Sienna: at Sienna's default largest step of 1/30 s the step error alone is 3.0e-5 pu of rotor speed on the GENROU case.

The known differences live in `server/src/tensa/engines/known_differences.json`, one entry each, and `server/tests/integration/test_known_differences.py` reproduces each one's evidence. Three are in the models of ANDES 2.0.0 (the ESAC1A rate feedback is computed and never subtracted and its regulator output is never limited, the EXAC1 voltage transducer is bypassed, the EXST1 limiter tests the wrong signal) and three are the torque a turbine model hands the machine (Sienna P_m / ω, ANDES P_m; ANDES's HYGOV also integrates with a gain that does not depend on its Tr). The first entry, as the register holds it:

```json
{"id": "tgov1-torque", "model": "TGOV1", "engines": ["andes", "sienna"],
 "summary": "Sienna hands the machine a torque of P_m / omega; ANDES hands it P_m.",
 "effect": "Sienna is more damped: equivalent to D raised by P_m0 (machine base) on the unit in ANDES.",
 "small_signal": true,
 "evidence": "Kundur, GENROU + TGOV1: ANDES with D = P_m0 reproduces Sienna's eigenvalues to four digits.",
 "check": "server/tests/integration/test_known_differences.py::test_tgov1_torque"}
```

ANDES 2.0.0 reads the columns of an `ESAC1A` or `ESST1A` record of a `.dyr` file in an order other than PSS/E's. TENSA puts the file's values back when it loads the case and says so in the Messages log, so an ANDES session runs those exciters as PSS/E and Sienna do.

An eigenvalue analysis in an ANDES session linearises the System as it stands: after a time-domain run, that is the state the run ended in, with its line trips. A Sienna session linearises at the power flow point every time. Compare the eigenvalues of the two engines from an analysis run before any time-domain run, as `POST /studies` does (each study runs in a session of its own).

An entry needs a test that reproduces its evidence. A model only Sienna has stays `unverified` until it is checked against a published result.

## How the engines agree

Measured agreement, with the case each number belongs to.

Power flow, through the real API (Phase 4 report):

| Case | V (pu) | Angle (rad) | Branch P / Q (MW / MVAr) | Generator P / Q |
|---|---|---|---|---|
| kundur | 3.4e-7 | 1.1e-6 | 6.6e-4 / 8.2e-4 | 6.5e-4 / 8.2e-4 |
| ieee39 | 2.5e-7 | 1.7e-7 | 3.3e-4 / 4.1e-3 | 1.8e-4 / 3.9e-3 |
| case14.m | 6.0e-8 | 1.2e-7 | 6.3e-5 / 6.5e-5 | 7.9e-5 / 1.2e-4 |

At the level of the Julia module the comparison also covers ieee14, wscc9, npcc and wecc: at most 3e-6 pu and 9e-6 rad. The engines are held to each other at 2e-5 pu and 2e-5 rad on the power flow.

Time-domain, Kundur with its machines alone (the GENROU records of `kundur_full.dyr`) and the same bus fault in both engines: rotor speeds agree within 5e-6 pu on a 9e-3 swing over the whole run; once the fault is cleared, bus voltages within 2.3e-4 pu and bus angles relative to the reference within 4.5e-4 rad. Absolute angles are not compared: each engine lets them drift with frequency in its own frame. Through `POST /studies` on Kundur with GENROU only and a bus-8 fault, the two engines' rotor speeds agree to 2e-5 pu.

Example cases under the cross-engine check: IEEE 30 and IEEE 57 agree to 1.5e-7 and 7.4e-7 pu; RTS 24, RTS-GMLC and ACTIVSg200 pass at the decision-30 tolerances; IEEE 118 and 300 agree to 3.1e-7 and 1.3e-6 pu and pass with a losses tolerance of 2e-3 and 5e-3 MW, as PowerNetworkMatrices holds the admittance matrix in single precision. PEGASE 89 is not recorded: Sienna applies the file's three phase shifts and ANDES's reader drops them (0.43 deg at bus 8581); with the shifts zeroed the two agree to 1e-5 pu.

Operations, MATPOWER case14: the DC OPF at the published 7642.59 $/h, and the AC OPF at 8088.22 $/h against MATPOWER's published 8081.53 (0.08 percent, 0.17 MW more losses). The network is not the cause: a Sienna session's admittance matrix equals ANDES's to 1.5e-6, the generator, voltage and shunt data equal the file's, the DC optimum is MATPOWER's, and unlimited ratings do not move it.

Dynamic lines and inverters, on Kundur with circuit 7-8-2 tripped at 0.1 s and 7-8-1 dynamic: bus 8's voltage agrees with the static run to 1.2e-7 before the trip, differs by up to 2.8e-3 in the milliseconds after it and agrees to 4.7e-5 from 0.5 s on; an inverter on bus 2's generator holds its 700 MW through a 1 s run.

## Limits a user meets

- **First-use delay.** Julia is loaded on first use of a Sienna session, never in the server process and never for an ANDES session. On a Windows laptop with Julia 1.13.4: create a session to its first reply, 2 to 5 s; first case load, Julia's start included, 56 to 84 s; first power flow, 40 to 47 s; later loads and power flows under 1 s. The first use of each Julia function compiles it. `tensa warm-cache --engine sienna` installs and precompiles the environment once; `tensa serve` never starts it on its own, and until it has run the engine is reported as not available, with the command to run.
- **Dispatch, unit commitment and the two-stage day need a MATPOWER case.** A PSS/E `.raw` case carries no generator cost data and is refused with 422 before Julia runs.
- **A generator with no dynamic model is a voltage source in a Sienna run.** PowerSystems' PSS/E reader turns a generator with no `.dyr` record into a voltage `Source` (a stiff voltage behind an impedance), and PSID simulates it as that: the run completes, with that unit holding its bus voltage rather than swinging. A case meant to compare dynamics gives every generator a model. The `ext_sienna` inverter block gives such a generator a PSID inverter instead.
- **The AC OPF of case14 is 0.08 percent above MATPOWER**, 8088.22 $/h against 8081.53, with 0.17 MW more losses. The test holds the measured value and says so.
- **`flat_start: false` is refused** under Sienna, as every power flow option it does not have; the UI sends it only when the user sets it.
- **A DC power flow leaves no operating point.** A dynamic analysis refuses to start after one.
- **A disturbance that would island the system** is reported as unsupported for Sienna before the run: a `NetworkSwitch` takes a whole admittance matrix and PSID refuses one that splits the network.
- **A `.dyr` with records Sienna's parser does not take** is refused, naming them, or loaded without them with `on_unsupported: "drop"` and a warning for each.
- **Snapshots and bundles record the engine** that wrote them; another engine's session refuses to restore or import one.
- **The worker-died message** still says "ANDES operation" for a Sienna worker.
- **PSID's own docs call the validation of its small-signal results work in progress**; every cross-engine `eig` comparison shows that note.
