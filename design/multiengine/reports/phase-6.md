# Phase 6 report: comparison of results across engines

Two results documents can now be compared per quantity and key through `POST /compare`, one study can be run on several engines through `POST /studies`, a results document can be built from a kept run through `POST /results/convert`, the web client overlays two runs and shows their difference table, the example cases are checked cross-engine, and an ANDES time-domain run can be asked for neutral series names. The specification's section 10 is built.

## What exists now

| Piece | Where | What it does |
|---|---|---|
| Results document | `server/src/tensa/engines/results_doc.py` (commit d36f41cc) | The neutral results document of spec section 6.5 (`tensa_results` 1: engine and versions, the study as run, status, series by quantity and key). |
| `POST /results/convert` | `api/routes/results_doc.py` (commit d36f41cc) | Builds a results document from a run, with the status of how the run ended. Takes a series name that is already neutral as it is, so both forms of a run give the same document. |
| `POST /compare` | `api/routes/compare.py`, `engines/compare.py` (commit b12862a1) | Compares two results documents per quantity and key: the power flow first, the largest and the time-weighted RMS difference on a common grid (decision 36), unmatched keys listed, eigenvalue modes matched one to one. |
| Study document and `POST /studies` | `engines/study_doc.py`, `api/routes/studies.py` (commit ea214b73) | A study document (`tensa_study` 1: routine, neutral options, `load_model`, disturbances by key, record) run on each named engine from the same case: a session per engine, the case's files checked under the workspace before any session is made (400), each engine's results document built as `POST /results/convert` builds it, each compared with the first engine's as `POST /compare` does. An engine that lacks the routine answers its refusal beside the others' results. Every session the route made is closed whatever happens; once 1800 s have passed, the next engine is not started and the route answers 504 (the engine already running is not cut short). The engines run one after the other. |
| Web Compare results view | commit 27437665 | Takes two kept runs or results document files: a run's document is built by the server, and `POST /compare` gives the operating point, the largest and RMS difference per quantity and element against tolerances the user can change, the unmatched keys and the matched eigenvalue modes. A kept run records the engine and the key listing of its session when it starts; a run kept before that is listed and disabled with the reason. A lazy overlay opened from the command palette and the plot's export menu. |
| Sienna dynamics in the web client | commit 9c7c3864 | A Sienna session's TDS panel shows a Load model choice and none of the ANDES-only options; the disturbance dialog offers what the engine lists. A neutral series name (`voltage|bus:7`, `rotor_speed|gen:2-1`) parses to the group and field of the ANDES column of its quantity, so a Sienna run is grouped, titled and drawn on the diagram as an ANDES run is. The eigenvalue result shows its notes and its load model. |
| Cross-engine example checks | `scripts/verify_example_cases.py --engines andes,sienna` (commit 24d791dd) | A reference may carry a `cross_engine` block: the script runs the case under Sienna as well and holds its power flow to the ANDES run at the tolerances of decision 30 (2e-5 pu, 2e-5 rad) and 1e-3 MW on losses and slack power (decision 46), and, for a case with dynamics both engines simulate, the runs' documents to each other through `POST /results/convert` and `POST /compare` (no reference carries a dynamic block yet, so that path has unit tests only). The block says what Sienna is expected to do (pass, differ with a known-difference id, or refuse). The new check kind is `cross-engine`. The default run (ANDES only) is unchanged. |
| Neutral series names for ANDES | commit 58c2260f | The `start_tds` frame and `POST /sessions/{id}/tds` take `"names": "engine"` (the default, the stream and the traces as they were, byte for byte) or `"neutral"`. With `"neutral"` an ANDES stream's columns are `<quantity>\|<key>` (`voltage\|bus:7`, `rotor_speed\|gen:1-1`), a `dae_vars` variable is `state\|<key>#<variable>`, and the relative quantities follow: `angle_rel` of every bus against the first Slack's bus when `bus_v` is streamed, and `rotor_angle_rel` of every machine when `gen_state` is, weighted by H * Sn (M / 2 * Sn) through `engines/frames.py`. A column with no neutral name is refused before the run. A batch run's traces are renamed the same way. A Sienna session's names were already neutral. |

## Evidence

**`POST /studies` on Kundur** with GENROU only and a bus-8 fault: the two engines' rotor speeds agree to 2e-5 pu through the route, as `tests/integration/test_engines_agree.py` holds them. A dynamic study solves the power flow first (a Sienna session refuses a run without one; ANDES takes the disturbances only before it), a fault's bus is the engine's idx from the session's keys, and an ANDES time-domain study runs as a stream, since its batch run records only named variables.

**Cross-engine check of the example cases** (`scripts/verify_example_cases.py --engines andes,sienna`, run on the example cases Sienna can read; the others are ANDES .xlsx files):

| Case | Result |
|---|---|
| ieee30 | pass; agrees to 1.5e-7 pu |
| ieee57 | pass; agrees to 7.4e-7 pu |
| rts24 | pass after the fixes of commit 40b67c44: 1.0e-7 pu, 9.5e-8 rad, 1.4e-4 MW |
| rts_gmlc | pass after the fixes: 1.8e-7 pu, 3.1e-7 rad, 3.7e-4 MW |
| activsg200 | pass after the fixes: 2.4e-6 pu, 8.9e-7 rad, 6.2e-4 MW |
| ieee118 | pass on voltages and angles at 3.1e-7 pu; held to 2e-3 MW on losses and slack power (gap 1.01e-3 MW) |
| ieee300 | pass on voltages and angles at 1.3e-6 pu; held to 5e-3 MW on losses and slack power (gap 4.12e-3 MW) |
| pegase89 | no cross-engine block: ANDES's MATPOWER reader drops the phase shift of its three ratio-0 rows (0.43 deg at bus 8581); with those shifts zeroed Sienna agrees to 9.7e-6 pu and 1.3e-6 rad, which the reference notes |

The wider losses tolerances on ieee118 and ieee300 are because PowerNetworkMatrices 0.20 holds the admittance matrix in ComplexF32; a mismatch of up to 0.0037 MW at one bus was measured in double precision.

**Neutral names on Kundur through a real worker**: the slack bus's `angle_rel` is 0.0 in every row and the H * Sn weighted sum of `rotor_angle_rel` is 0 within 1e-9; a batch trace keeps its values under its neutral name.

## What went wrong, and what changed because of it

- **Worker candidates of `POST /studies` invented the disturbance body and the compare answer's fields.** The landed route reuses the routes' own payload builders (`routes.pflow._result_from_payload`, `invoke_streaming` and `decode_batch` for an ANDES stream).
- **The specification promised neutral series names for an ANDES run and nothing built them** until commit 58c2260f (`"names": "neutral"`).
- **The first run of the cross-engine check found five cases the Sienna engine refused or solved differently from ANDES** (commit 24d791dd named them; commit 40b67c44 fixed each where the adapter departed from the file or from a type it should handle, decision 25):
  - A bus whose generators need more than their limits (rts24's reference bus, rts_gmlc): PowerFlows asserts while it splits the solved bus power among its units. The power flow is stored without PowerFlows' split and the units are given their share by PowerFlows' own rule where it holds, and otherwise by schedule and MATPOWER's reactive rule, with a note.
  - A SynchronousCondenser (rts_gmlc) has no active power getter: read as 0.
  - A MATPOWER row with a ratio of 0 and a phase shift (pegase89): PowerSystems' reader failed on the base voltages it leaves unset for such a row; they are set and the shift applied as MATPOWER applies it.
  - A PV bus with no generator in service (activsg200) is solved as PQ, as MATPOWER and ANDES solve it, and is made PV again by an edit that puts one back.
  - A MATPOWER transformer row's charging (ieee118 and ieee300): PowerSystems puts all of it on the from end, the file b/2 at each; the charging is put back at both ends (ieee118 1.72e-3 to 3.1e-7 pu, ieee300 1.80e-3 to 1.3e-6 pu).

## Open points

- pegase89 has no cross-engine block: Sienna applies the file's three phase shifts and ANDES's MATPOWER reader drops them. The reference notes it; nothing aligns the two.
- ieee118 and ieee300 pass with wider losses and slack tolerances (2e-3 and 5e-3 MW) than the 1e-3 MW default of decision 46, because PowerNetworkMatrices holds the admittance matrix in single precision.
- A comparison does not link a difference to the known-difference register (spec section 10); only the example check reads the register.
- `POST /studies` does not pass a study's `ext` block, ignores unknown time-domain options, and takes the routines `pflow`, `tds`, `eig`, `matrices` and `dispatch` only (decision 45); a Sienna run gives no `rotor_angle_rel`, since its dynamics plan reports no inertia.
- A Sienna bus `angle_rel` can jump by 2 pi where a bus angle and the reference wrap at different instants; the audit follow-up unwraps the series first.

## Review

A review of the phase by a second model (Fable), read-only on 58c2260f, ran the phase's unit tests and reproduced its findings with scripts and ANDES. What it found, and what was done:

| Finding | Disposition |
|---|---|
| `angle_rel` of an ANDES run with `"names": "neutral"` was taken against the bus whose idx is the Slack device's idx, not the Slack's bus (IEEE 39: device 10 on bus 39) | Fixed in bc25afa8; a test on IEEE 39 fails on the old code |
| `rotor_angle_rel` was weighted by `M` after `setup()` had put it on the system base, H * Sn^2 / Sb instead of H * Sn | Fixed in bc25afa8 (`M.vin`); the IEEE 39 test, whose machines differ in rating, fails on the old weights by 1.1e-2 |
| `POST /compare` matched the power flow table by quantity and unit only, so loads were compared with generators and never with loads | Fixed in 11fd01dc, with the review's reproduction as a test |
| The mode matching ran the assignment on uncapped distances, so a pair within the cap was lost when each side had an extra mode | Fixed in 11fd01dc (each cost capped before the assignment) |
| `POST /studies` toggled the static generator for a `gen_trip` (nothing trips in ANDES), sent a `load_step` in MW as per unit and dropped its MVAr, sent a set-point to the static generator, and labelled every time-domain study `completed` | Fixed in 8abd0621: a trip toggles the unit's machine (measured: Kundur's other machines swing by about 1e-2 pu); a load step and a set-point are refused for ANDES, whose time-domain run holds loads as constant impedance from the start (an Alter of the load's power changes nothing, measured) and has no checked megawatt set-point; the document carries the run's own status |
| The web Compare view showed tolerances 10 to 100 times looser than the server applied to a field left at its default, and rewrote a loaded document's engine and status | Fixed in 2c9e1842 |
| The report said "ten example cases", quoted decision 30 for the 1e-3 MW losses tolerance, said a study past 1800 s is 504, and implied the dynamic cross-engine path was exercised | Corrected above; decision 46 records the losses tolerance |
| Spec departures without a decision: no known-difference link in a comparison, `study.ext` not passed, routines other than five refused by the schema, `initialization` limited | Open points; decisions 44 and 45 record the routine and operations shapes |

## Findings for upstream

Offered to the maintainers only if the project's owner wants to; none is filed.

- PowerFlows asserts when a bus's solved power needs more than its units' limits (rts24 bus 13, rts_gmlc bus 115).
- PowerSystems' MATPOWER reader fails on a ratio-0 phase-shifter row, leaving its base voltages unset (pegase89), and puts a MATPOWER transformer's charging all on the from end where the file has b/2 at each (ieee118, ieee300).
- PowerNetworkMatrices 0.20 holds the admittance matrix in ComplexF32; a power mismatch of up to 0.0037 MW at one bus was measured in double precision.
- ANDES's MATPOWER reader drops the phase shift of a ratio-0 row (pegase89's three rows, 0.43 deg at bus 8581).
