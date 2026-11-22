# Phase 5 report: Sienna dynamics, streaming, small-signal and the model audits

A Sienna session now runs time-domain simulations (batch and streamed over the WebSocket, with faults, trips and abort), runs small-signal analysis with the eigenvalue math both engines share, reports the fidelity of every dynamic model of a loaded case, and takes the load model a study names. The 14 dynamic models both engines simulate have been audited like for like, in 12 audits, against PSID's own PSS/E benchmarks: five are recorded exact, six have registered known differences with evidence tests, and the three models of the converter chain stay unverified.

## What exists now

| Piece | Where | What it does |
|---|---|---|
| Dynamics in Julia | `server/src/tensa/engines/sienna/julia/TensaSiennaDyn.jl` (commit 10195500) | Small-signal analysis, time-domain runs with faults and trips, and a per-step hook, over PowerSimulationsDynamics 0.16.2. |
| Bridge to the dynamics module | `engines/sienna/bridge.py` (commit 38ea85d9) | Reaches the plan, eigenvalues, initialisation and runs with the per-step hook. |
| Batch time-domain runs | `POST /tds`, `POST /tds/init`, the disturbance routes (commit e5a0aacb) | Faults and line toggles are kept by neutral key and translated to bus numbers when a run starts. The run answers in the ANDES engine's shape, with the device p/q series PSID records on their own time base in a new `post` field and `integrator` "ida". `init_tds` counts device states and bus-voltage parts apart. The engine descriptor gains `routine_options`. |
| Streamed time-domain runs | `core/stream.py` (`run_tds_stream`), per-engine `TdsStreamPlan` (commit 0ba73d76) | The worker's streaming path is split in two: one engine-neutral driver sends `stream_start`, encodes and numbers the frames, applies the decimation, watches the abort event and flushes the tail; each engine gives it a column plan (names fixed when the run starts, a per-step `collect`). The ANDES plan reads the System under `stored_step`; the Sienna plan takes the row PSID's callback hands over, under neutral names (`voltage\|bus:7`, `rotor_speed\|gen:1-1`). A Sienna `start_tds` takes `tf`, `step` (or `h`), `load_model`, `decimation` and `max_rate_hz`, and refuses an ANDES-only option by name before the stream opens. |
| Small-signal analysis | `POST /sessions/{id}/eig` on a Sienna session (commit cdc458cf) | Eigenvalues with damping, frequency and participation computed by the code ANDES sessions already use (`core/eig_math.py`, decisions 37 and 38). Every Sienna result carries the note that PSID's own documentation calls the validation of its small-signal results work in progress. |
| Relative angles and neutral series names | shared module (commit 825a8385, decisions 34 and 35) | `angle_rel` and `rotor_angle_rel` computed once for every engine; series named `<quantity>\|<key>`, an engine's raw state `state\|<key>#<state name>`. |
| Load model on a run | `POST /tds` and the WebSocket `start_tds` (commit 0fa49553) | Both take `load_model`; the ANDES engine refuses any but `impedance`, which is what it does. |
| Fidelity and the known-difference register | `GET /sessions/{id}/fidelity`, `engines/known_differences.json`, `engines/model_audits.json` (commit 982cff6a) | Every dynamic model of a loaded case has a state for its engine: exact, known-difference:<id>, unverified or unsupported. The fidelity route lists the models that are not exact, keyed by unit and role (`gen:1-1/governor`); `GET /engines` carries a models map of the 14 per engine. |
| Model audits | `server/tests/integration/test_model_audits.py` | The two engines against each other on PSID 0.16.2's PSS/E benchmark cases (one small case per model), with the inputs changed where one engine cannot take the file as it is (decision 47), run in both engines with the benchmark's disturbance, compared through `POST /compare`. |
| Cross-engine agreement | `tests/integration/test_engines_agree.py` (commit 0fa49553) | Kundur with its machines alone and a bus fault, run in both engines through the API, turned into results documents with `POST /results/convert` and compared with `POST /compare`. |
| Versions and warm-up | `GET /engines`, Sienna worker warm-up (commit fa4ba205) | `GET /engines` reports Sienna's package versions; a Sienna worker warms Julia on a small case and says so on the first reply. |

## Evidence

**Model audits** (`test_model_audits.py`; PSID 0.16.2's PSS/E benchmarks in both engines, compared through `POST /compare`):

- Recorded exact in `engines/model_audits.json`: GENROU (rotor speed 2.0e-7 pu, modes equal to five digits), GENCLS (9.3e-7 pu), SEXS (8.1e-7 pu), IEEEST (1.9e-7 pu), ESST1A (6.0e-6 pu on a swing of 7.7e-3; post-trip voltage 3.9e-5 pu).
- Known differences, each with an evidence test in `test_known_differences.py`: `esac1a-rate-feedback` (Sienna with KF = 0 gives ANDES's modes to four digits; 5.7e-4 pu), `exac1-transducer` (Sienna with TR = 0 matches to four digits; 1.0e-4 pu), `exst1-output-limiter` (not small-signal, modes equal; 4.5e-4 pu), `gast-torque` and `hygov-torque` (ANDES with D raised by P_m0 reproduces Sienna to four digits, except one HYGOV mode on Kundur at 0.637 Hz whose real part stays 1.37e-3 apart relative, held to 2e-3), `tgov1-torque` (1.0e-5 pu).
- Unresolved: the converter chain REGCA1/REECB1/REPCA1 stays `unverified`. Its runs agree (rotor 3.7e-8 pu, post-trip voltage 8.8e-6 pu), its case has no electromechanical mode, and the converter's own poles differ: ANDES 20 states and -50.0 +/- 4.40j, Sienna 11 states and -45.2 +/- 8.70j.

**The two engines held to each other on a time-domain run** (`test_engines_agree.py`, Kundur with the GENROU records of `kundur_full.dyr` and a bus fault): rotor speeds 5.0e-6 pu on a swing of 9.2e-3, held at 2e-5 and a quarter percent of the swing; bus voltages once the fault is cleared at most 2.3e-4 pu; relative bus angles at most 4.5e-4 rad on swings of 0.4 rad. Absolute angles are not compared: each engine lets them drift with frequency in its own frame. The bounds are about three times those figures and are tied to the Phase 1 spike's.

**The ANDES stream is unchanged**: a recording of every envelope of three runs (a fault, mean decimation, a dae_var) through the old and the new worker is identical, metadata key order included. A stopped run still streams every step it solved, and the step the run ended on goes out after it.

**Abort**: an abort sent while nothing runs stops the next run at its first step and is spent by it, as on the ANDES engine; an abort lands mid-run on a Sienna stream and is spent by it.

**Step error measured**: Sienna's default largest step of 1/30 s against 1/240 s differs by 2.98e-5 pu on rotor speed; Sienna at 1/240 s against ANDES at 1/960 s by 1.9e-7. GENCLS's 1.44 Hz mode with damping 0.0002 rings for 20 s, so ANDES's trapezoidal phase error at 1/120 s grows to 1.15e-5. The audits run ANDES at 1/480 s and Sienna at 1/240 s.

## What went wrong, and what changed because of it

- **The eigenvalue gap on GENROU was the harness, not the models.** ANDES's EIG linearises the System it holds, which after a time-domain run is the end state with the line trip in effect: ANDES showed 1.1323 Hz where Sienna showed 1.3725 Hz. At the power-flow point ANDES gives 1.3725 Hz, damping 0.0799, Sienna's answer. Both analyses now run before the runs. `POST /studies` runs each routine in a session of its own and is not affected; an interactive ANDES session is, and `docs/engines.md` says so.
- **A defect of ANDES 2.0.0 that changes TENSA's results.** Its PSS/E reader names the columns of ESAC1A and ESST1A records in an order that is not PSS/E's. On the ESAC1A benchmark ANDES held KA 7 instead of 200, TA -7 (its range check then set 0.04) instead of 0.05, TE 0.8 instead of 1.333, KE 0 instead of 1. `server/src/tensa/core/dyr_columns.py` puts the file's values back on every load and says so on the Messages log (decision 25: the case file is the reference); contract 15 of `server/ANDES_VERSIONS.md`. No case ANDES ships holds either model.
- **The TVC benchmark's WINDV2 of 1.04**, which ANDES ignores (decision 27), made the networks differ by 3.7e-2 pu RMS at two buses; the harness writes the ratio on winding 1. ANDES runs a GENSAL record as GENROU, so both engines get that GENROU.
- **A time-domain request could not name its load model**: `POST /tds` refused `load_model` and the WebSocket's `start_tds` dropped it, so a Sienna run always took constant impedance. Both now take it.
- **The Sienna run did not clear the abort event however the run ended**, so one idle abort stopped every later run of the session. It now clears it however the run ends.
- **PSID 0.16.2's `execute!` hard-codes `NoInit()`**; after a network switch IDA is handed inconsistent algebraic variables and fails at the clearing instant, with PSID's own matrices as with ours. Every PSID perturbation callback of a Sienna run is rebuilt with `initializealg = Sundials.BrownFullBasicInit()` (decision 37). With the re-initialisation a 50 ms fault at bus 7 of Kundur runs to the end.
- **Decision 38's premise is stale.** It said a generator with no dynamic model makes PSID's build fail with a `MethodError`. In Sienna a generator with no dynamic model is a voltage Source (PowerSystems' PSS/E reader), and PSID simulates it as one. A PSID inverter cannot be put on a Source, so the ext.sienna inverter gives the generator back as a ThermalStandard on the run's copy. The infinite bus's stand-in in the audits has H = 1000 s.
- **Sienna's dyr check reported a GENCLS record on an infinite-bus Source as lost.** PowerSystems reads a GENCLS with H = 0 as a Source, which is what the record is, so it is now held, not reported.
- **The audits had no candidate a worker model could finish**: the eigenvalue gap, the step error and the ANDES column order were each found by running both engines on the benchmark and probing one parameter at a time, which a subagent of the architect's model did; the worker candidates had stopped at the first disagreement.

## Open points

- **The converter chain** REGCA1/REECB1/REPCA1 stays `unverified`: the runs agree but the converter's own poles differ and the case has no electromechanical mode to compare.
- **One HYGOV mode on Kundur at 0.637 Hz** keeps its real part 1.43e-3 apart relative (1.37e-3 with the benchmark's Tr). ANDES's HYGOV ignores its integral time constant Tr (the gate position has no time constant), but setting Tr = 1/r in both engines, where the two forms agree, leaves the gap, so that is not its cause; `test_hygov_integral_gain` holds both facts. Both engines also have a growing slow governor pole on Kundur with this HYGOV (ANDES +0.197 /s, Sienna +0.091 +/- 0.114j), which nothing holds.
- **An interactive ANDES session's EIG** after a time-domain run linearises the end state, not the power-flow point; `docs/engines.md` says so, and nothing in the session prevents it.
- **A disturbance that islands the network** was accepted by a Sienna session and failed inside PSID; the specification (section 4) asks for it to be refused before the run. Unit p5-j adds the check.

- **The IEEEST audit's electromechanical mode** (1.37252 Hz) is the SEXS audit's in both engines to 1e-8, so the stabiliser may not reach either engine's linearisation; not looked into.

## Review

A review of the phase by a second model (Fable), read-only on cf6f8b0e, checked the column table against PowerSystems' PSS/E map and ANDES's reader (right), probed ANDES, and read the audits. A subagent fixed what it found (ea9e5376), ran every audit and every known-difference test, and checked each new unit test against the old code; all 60 audit tests and the 8 known-difference tests were run again on the branch with every other fix in it.

| Finding | Disposition |
|---|---|
| A `.dyr` with a byte-order mark, or in an encoding UTF-8 does not read, was left uncorrected by `put_back_dyr_columns`; a NaN token could be written into a parameter; two records on one machine corrected the first device twice | Fixed: the file is read as ANDES reads it, a value that is not a finite number is skipped and named, and the k-th record of a model on a machine goes to the k-th device |
| ANDES's HYGOV ignores its integral time constant | Confirmed in source; it is not the cause of the remaining HYGOV gap (see Open points); recorded in `hygov-torque` |
| ANDES's ESAC1A never applies VRMAX and VRMIN | Confirmed; added to `esac1a-rate-feedback` with an ANDES test (with VRMAX below the operating regulator output the run is unchanged) |
| The EXST1 evidence test passed on any initialisation failure | It now reads ANDES's own variables: with VRMIN 0 the field voltage stays at 0 while the regulator output is 1.92 pu inside both limits |
| The bounds of the `exact` audits were 15 to 500 times the measured differences | Each is now ten times its measured figure, and never below the step error; `test_model_audits_table.py` holds them to the measurements |
| A Sienna bus `angle_rel` could jump by 2 pi; a NaN on an out-of-service machine made a row of `rotor_angle_rel` NaN | Fixed in `engines/frames.py` (`unwrap_angle`; out-of-service terms left out) |
| The report called the audits a check against PSS/E's benchmarks and said "five digits" where the evidence holds four | Corrected above; decision 47 |
| The IEEEST audit's mode is identical to the SEXS audit's in both engines: the stabiliser may not reach either linearisation | Open point |

## Findings for upstream

Offered to the maintainers only if the project's owner wants to; none is filed.

- ANDES 2.0.0: the PSS/E reader names the columns of ESAC1A and ESST1A records in an order that is not PSS/E's (KA, TA, TE, KE land in the wrong fields; measured on the ESAC1A benchmark), and ignores a two-winding record's WINDV2 (decision 27).
- ANDES 2.0.0: ESAC1A computes its rate feedback and never subtracts it; EXAC1 bypasses its voltage transducer; EXST1's limiter tests the washout output instead of the regulator output, and its limits omit VT (the three known-difference entries).
- ANDES 2.0.0: ESAC1A never applies its regulator limits VRMAX and VRMIN; HYGOV never uses its integral time constant Tr.
- PowerSimulationsDynamics 0.16.2: `execute!` hard-codes `NoInit()`, so IDA fails at the clearing instant of a network switch with inconsistent algebraic variables, with PSID's own matrices as with TENSA's; every perturbation callback has to be rebuilt with `initializealg = Sundials.BrownFullBasicInit()`.
