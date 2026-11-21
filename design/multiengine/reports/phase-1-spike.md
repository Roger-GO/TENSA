# Phase 1 report: spike, ANDES vs Sienna on the same case

Date: 2026-11-20. Code: `spike/` (throwaway, not committed). Outputs: `%LOCALAPPDATA%\tensa-dev\spike\`.

Versions: ANDES 2.0.0 on Python 3.12.10; Julia 1.13.4 with PowerSystems 5.12.5, PowerFlows 0.16.4, PowerSimulationsDynamics (PSID) 0.16.2, PowerSimulations 0.34.2, PowerNetworkMatrices 0.20.0.

Case: Kundur two-area system (`kundur.raw`, 10 buses, 4 machines), one of the two 7-8 lines tripped at 1.0 s, run to 10 s.

## 1. Agreement, like for like

| Check | GENROU only | GENROU + TGOV1 |
|---|---|---|
| Power flow, largest voltage difference | 3.3e-7 pu | same |
| Power flow, largest angle difference | 4.7e-5 deg | same |
| State count | 24 = 24 | 32 = 32 |
| Oscillatory modes, frequency | equal to 4 digits (0.6374, 1.0965, 1.1297 Hz) | equal to 4 digits |
| Oscillatory modes, damping ratio | equal to 4 digits | differs: 0.038 / 0.046, 0.088 / 0.092, 0.090 / 0.094 (ANDES / Sienna) |
| Governor mode | none | 0.0706 Hz, damping 0.567 (ANDES); 0.0684 Hz, 0.630 (Sienna) |
| Rotor speed, largest difference over 10 s | 1.0e-5 pu on a swing of 1.0e-2 (0.1 %) | 2.1e-4 pu on a swing of 2.5e-3 (8 %) |
| Relative rotor angle, largest difference | 1.3e-3 rad on a swing of 0.18 | 6.7e-3 rad on a swing of 0.17 |
| Bus voltage, RMS difference | 5e-5 to 9e-5 pu | 1e-4 to 4e-4 pu |

Reading: the machine and network models are the same in both engines to solver accuracy. The steam governor (`TGOV1`, Sienna's `SteamTurbineGov1`) is not: same structure, measurably different response.

**Cause found and confirmed.** Sienna's governor hands the machine a torque of `P_m / ω` (`inner_vars[τm_var] = P_m / ω[1]` in PSID's `tg_models.jl`); ANDES hands it `P_m` as the torque (`tgov1.py`). Linearised, `P_m / ω` adds a damping torque of `P_m0` per unit speed on every machine. Check: ANDES with `D` raised by `P_m0` (machine base) on each `GENROU` gives Sienna's eigenvalues to four digits:

| Mode | ANDES | ANDES + D = P_m0 | Sienna |
|---|---|---|---|
| governor | 0.0706 Hz, 0.5669 | 0.0684 Hz, 0.6295 | 0.0684 Hz, 0.6295 |
| inter-area | 0.6539 Hz, 0.0382 | 0.6540 Hz, 0.0458 | 0.6540 Hz, 0.0458 |
| local 1 | 1.1076 Hz, 0.0876 | 1.1077 Hz, 0.0921 | 1.1077 Hz, 0.0921 |
| local 2 | 1.1410 Hz, 0.0896 | 1.1411 Hz, 0.0941 | 1.1411 Hz, 0.0941 |

Neither engine is wrong; they make a different modelling choice, and Sienna's is the more damped. This is the template for a "known difference" entry: what differs, the lines that show it, its size, and the experiment that confirms it. How it was found: three Kimi workers read both sources independently; two gave this cause, one gave a different one (a base conversion of the droop), and the ANDES experiment decided between them (`spike/exp_tgov1_check.py`). Each model both engines have needs this audit (Phase 5).

## 2. What had to be aligned before the engines agreed

Each item below made the engines disagree until it was handled. Each becomes a rule of the neutral language or of an engine adapter.

1. **Load model in dynamics.** ANDES turns PQ loads into constant impedance at the solved voltage for time-domain and eigenvalue runs (`PQ.config.p2z = q2z = 1`). PSID keeps what the case says, which for a PSS/E load is constant power. With constant power and no exciters Sienna showed a real eigenvalue of +0.38 and the run collapsed at 3.2 s, while ANDES was stable. The neutral study must state the load model.
2. **Constant-impedance loads in Sienna.** PowerFlows 0.16 reads a `StandardLoad`'s impedance part as power at 1.0 pu; PSID 0.16 reads it as power at the solved voltage. Setting it either way moved the operating point (bus 5 from 0.9834 to 0.9665 pu). Representing the load as a `FixedAdmittance` means the same to both and reproduced ANDES exactly.
3. **Bus type SLACK.** PowerSystems 5.12 marks the PSS/E area-interchange slack bus as `SLACK`; PowerFlows 0.16 and PSID 0.16 predate that type and fail with a `KeyError`. Reading it as PV (or REF when the case has no reference bus) fixes it.
4. **ANDES-only records in a `.dyr`.** ANDES accepts event records such as `Line 'Toggle' Line_8 2.0 /` in a `.dyr`; PowerSystems' parser fails on them. They have to be taken out and carried as a disturbance.
5. **Rotor angle reference.** ANDES reports rotor angles in the synchronous frame (they drift with frequency), Sienna relative to its reference. Only differences between machines compare.
6. **Identity.** ANDES names machines by idx, Sienna by `generator-<bus>-<id>`. Bus number plus id worked as the common key for every series.

## 3. Model coverage: three levels, not one

- **ANDES reads and simulates** 100 models (`andes-gaps.md`).
- **PowerSystems parses** from a `.dyr`: 5 machines, 17 exciters, 9 governors, 2 stabilisers, 3 renewable models, `DERA1` (its `docs/src/reference/psse_models.md`).
- **PSID simulates** fewer than PowerSystems parses. `IEEET1` parsed and then failed at build: PSID 0.16.2 has no model for it. Simulated exciters: `ESAC1A`, `ESST1A`, `EXAC1`, `EXST1`, `SCRX`, `SEXS`, `ST6B`, `ST8C` and Sienna's generic types. Governors: `TGOV1`, `GAST`, `HYGOV`, `DEGOV`, `DEGOV1`, `PIDGOV`, `WPIDHY`. Stabilisers: `IEEEST`, `STAB1`, `PSS2A/B/C`.
- **Both simulate** (candidate list for like-for-like comparison): machines `GENROU`, `GENCLS`; exciters `EXST1`, `SEXS`, `EXAC1`, `ESAC1A`, `ESST1A`; governors `TGOV1`, `GAST`, `HYGOV`; stabiliser `IEEEST`.
- A model PowerSystems does not parse is skipped with a warning and the machine silently gets a fixed exciter (`EXDC2` on Kundur). TENSA must turn that into a visible fidelity report, never a silent change.
- None of ANDES's shipped dynamic cases uses only models both engines simulate (`ieee14` has `ESST3A`, `ST2CUT`, `IEEEG1`; `npcc` has `IEEEX1`; `wecc` has `ESDC2A`, `ST2CUT`). Comparison cases have to be built for the purpose, or a case projected onto the common subset with the left-out models listed.

## 4. Package versions

PSID 0.16.2 and PowerSimulations 0.34.2 both require PowerFlows 0.16 and PowerNetworkMatrices 0.20. The current PowerFlows is 0.25.5 and needs PowerNetworkMatrices 0.24, so it cannot share an environment with them. Items 2 and 3 above are symptoms of that lag. Consequence: at least two Julia environments, one for dynamics and operations and one for current power flow, and the adapter must not assume one package set.

## 5. Streaming and abort

- PSID's `execute!` builds its callback set from `sim.callbacks`. A `DiscreteCallback` pushed there before `execute!` ran on every accepted step (115 calls to 1.15 s; 30 calls to 0.51 s) and saw the full state vector (52 states).
- `terminate!(integrator)` from that callback stopped the run at the requested time (0.512 s for a stop asked at 0.5 s); status `SIMULATION_FINALIZED`; results readable up to the stop.
- So live per-step streaming and cooperative abort are both possible. Mapping the raw state vector to named quantities during the run still has to be written (the results API does it only after the run).

## 6. Time

| Step | ANDES | Sienna |
|---|---|---|
| Process start to first result | about 2 s | 83 to 89 s (Julia start, package load, compile) |
| Load case | 1.9 s | 10 s first time |
| Power flow | 0.004 s | 2.7 s first call |
| Eigenvalues | 0.02 s | 13 s build + 0.12 s |
| 10 s line-trip run | 0.4 to 0.7 s | 2.1 s |

Sienna's numbers are first-call numbers in a fresh process; almost all of it is compilation. A session's worker stays alive, so the cost is per session, not per run, and a precompiled system image is the standard way to cut it. Second-call timings and the embedded-Julia test are in section 7.

## 7. Bridge: embedded Julia (`juliacall`) vs a separate Julia process

Tested: `juliacall` 0.9 in the server's Python environment, pointed at the installed Julia and a copy of the Sienna project (`spike/exp_juliacall.py`).

| Step, embedded Julia | First call | Second call |
|---|---|---|
| `import juliacall` | 4.6 s | |
| `using` the Sienna packages | 14.1 s | |
| Load Kundur `.raw` + `.dyr` | 31.7 s | |
| Power flow | 32.1 s | 0.025 s |
| Build and run a dynamic simulation, stopped at 3 s | 38.4 s | 0.02 s |
| Whole process | 122 s | |

- A Python function passed into Julia was called on every accepted step (151 calls), received the time and the 52-entry state vector, and its return value stopped the run at exactly t = 3.000 s. That is the path TENSA's worker needs for streaming and abort, and it works.
- Once compiled, Sienna is as fast as ANDES on this case (power flow 0.025 s, a short dynamic run 0.02 s). The whole cost is the first call: about two minutes in a fresh process.

**Decision: embed Julia in TENSA's existing Python worker through `juliacall`.** It reuses the worker's pipes, abort flag, message capture and session handling; the Sienna engine is then a Python class beside the ANDES one. A separate Julia process stays as the fallback if embedding misbehaves under `multiprocessing` spawn on Windows or on a crash, which Phase 3 tests first.

**Start-up is the main product risk.** Two minutes before the first Sienna result is too long for an interactive tool. Mitigations, in the order to try: a precompiled system image (PackageCompiler) built by `tensa warm-cache`; a workload file so the image covers load, power flow, build and run; a warm spare worker started with the server. Phase 4 measures each.

## 8. How the Kimi workers did

- First attempt of the Sienna script, written from the installed docs and source: clean and nearly right (one wrong accessor).
- The unattended write-run-fix loop then failed 10 times. Faced with real incompatibilities (items 3 and 4), the worker started changing the input to get past the error: it dropped 25 lines of the `.dyr` (deleting the machines) and removed network elements. One of its changes (SLACK read as PV) was right.
- Rule taken from this: a fix loop may change only the file it owns, never the data or the check, and it stops and reports when the same error class repeats. Incompatibilities between tools go to the architect.
