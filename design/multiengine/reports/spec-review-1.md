# First review of the specification

Draft 1 of `spec.md` was read by ten reviewers (worker-model calls), each against one body of source: TENSA's worker, session registry, API schemas, stream module and web client; ANDES's PSS/E and MATPOWER readers; PowerSystems, PowerFlows, PowerSimulationsDynamics and PowerSimulations documentation and source. Their corrections were checked by the architect before draft 2.

## Verdict on the corrections

Accepted and now in the specification: the disturbance mapping to PSID (two `NetworkSwitch` events for a fault, no `BranchImpedanceChange` for closing, the four setpoint signals, one `LoadChange` per signal); keys cannot come from what ANDES keeps after reading a file, so TENSA reads identity itself; results keyed by idx get a `keys` lookup instead of new keys; angles stay in radians and relative quantities are separate; stream names live in `var_columns`; the engine seam is a handler table because the worker's handlers reach the ANDES System directly; session creation needs an optional `engine` field; fidelity has four states; power flow options are mapped by name per engine; operations routines need their own study and case fields.

Rejected after checking:

- "ANDES does not read event records from a .dyr": it does. `andes/io/psse-dyr.yaml` maps `Toggle` and `Fault`, and `kundur_full.dyr` carries one. The reviewer saw only `psse.py`.
- "Nothing shows a callbacks hook on a PSID Simulation" and "no eigenvalue API is documented": both were run in the spike (`spike/exp_stream.jl`, `small_signal_analysis` in `spike/sienna_run.jl`). The reviewer saw only the docs. The specification now says the callback relies on a field and is pinned by a test.
- "TENSA's dynamic kinds are not PSS/E names": for the standard models they are (`IEEEX1` and `IEEET1` are both PSS/E models and both ANDES classes). The point that some ANDES names are not PSS/E names (`ESD1`, `PVD1`, `EV1`, `EV2`) stands and is covered by the alias rule.

## Merged list of what was missing and what to test first

## Identity and keys

1. The spec must define where keys come from when the engine drops the source id, requiring the ANDES adapter to re-parse the `.raw` file to recover `CKT` and load `ID`, and add a `key_source: "file" | "ordinal"` field per element so ordinal-keyed elements are flagged non-comparable across engines. [review-andes-io: `ckt` dropped in `_parse_line`; load `Id` dropped in `_parse_load_v33`; shunt ids dropped in `_parse_fshunt_v33`/`_parse_swshunt_v33`]

2. The spec must define a `xfmr3:<i>-<j>-<k>-<ckt>` key kind and key the fabricated star bus as `bus:_star_<i>_<j>_<k>` rather than its invented, collision-dependent number, with a `known-difference:xfmr3-star` fidelity entry. [review-andes-io: `_parse_transf_v33` fabricates `new_bus = data[0][2] + 1` else `max_bus + xf_3_count`, `Vn = 1.0`]

3. The spec must add a rule that every field named `*_idx` or `idx` gains a sibling `key` (or `from_key`/`to_key`, `bus_key`), with a checklist keyed to the schema files and a `keys: dict[str, str]` map on dict-keyed results. [review-api: `LineFlow.from_idx`/`to_idx`, `TdsControllerResult.idx`, `CaseEvent.dev_idx`, `EditStep.idx` in `pflow.py`/`tds.py`/`topology.py`]

4. The spec must define key behaviour under editing, undo and delete-cascade: added elements take the next free ordinal for their bus/pair at add time, keys never renumber within a session, and journal replay rebuilds the same keys. [review-api: `EditStep`, `DELETE .../elements/{model}/{idx}?cascade=true`, "Snapshots restore by replay", llms.txt]

5. The spec must state that for ANDES, `gen:<bus>-<id>` uses `PV.subidx`/`Slack.subidx` with the machine's bus from `PV.bus`, and that the swing angle lives on the `Slack` device. [review-andes-io: `_parse_gen_v33` copies `param.update({'a0': sw[data[0]]})`]

6. The spec must define the key (or refusal) for a dynamic record whose DYR-to-static `find` linkage fails. [review-andes-io: `read_add` resolves via `find_idx` with `allow_none`, `default=None`]

7. The spec must add a `name` field on every component distinct from `key`, derived from bus number or the `bus_name_formatter` rule, since PowerSystems.jl's internal handle is `name` and enforces uniqueness. [review-psy-data: `parse_dynamic_data.md` unique bus names; `serialize_data.md` lookup by `.name`]

8. The spec must account for multi-section lines and dummy buses in the key derivation rule, recording the original multi-section ID in `ext`, since dummy bus numbers differ per engine. [review-psy-data: `parse_matpower_psse.md` "parsed as individual lines and the 'dummy buses' are added"]

9. The spec must state that `TopologyEntry` gains `key: string`, that `SelectedElement` and `UnitMember` carry it, and that compare/fidelity UI selects by `key` while run/edit routes keep `idx`. [review-web: `SelectedElement` carries `idx` + `modelClass`, `generatingUnits.ts` `unitMemberSelection`]

10. The spec must require the adapter to request `FlowReporting.BRANCH_FLOWS` (or aggregate arcs) and define how reduced/aggregated branches map back to keys when `network_reductions` is non-empty. [review-pflow: `FlowReporting.ARC_FLOWS` default in `solve_ac_power_flow.jl`; arc results are per-arc, not per branch `key`]

## Case document

1. The case document must gain an optional `op` block on `generators[]` with limits, ramps, time limits, costs and initial conditions, with a rule that a study whose template needs a missing field fails validation listing the generators. [review-psi-ops: `formulation_library/ThermalGen.md` `get_ramp_limits`, `get_time_limits`, `get_start_time_limits`; `General.md` `LinearFunctionData`/`QuadraticFunctionData`/`PiecewiseLinearData`]

2. The case document must gain a top-level `series` block for time series references, with a rule that `dispatch`/`uc`/`sim` refuse a case with no series on loads. [review-psi-ops: `how_to/read_results.md` `ActivePowerTimeSeriesParameter__PowerLoad`; `formulation_library/Load.md` `max_active_power` timeseries]

3. The case document must make `base_mva`, `freq_hz`, `vn_kv` nullable or carry `defaulted: true`, populated from the same logic that produces `buses_without_vn`, so ANDES defaults are not exported as the case's own values. [review-api: `TopologySummary.freq_hz`/`base_mva` "keeps ANDES's default of 60"/"of 100", `buses_without_vn` "ANDES fills in 110 kV", `topology.py`]

4. The case document must add `base_mva` (device base) to `generators`, `transformers` and any component with a device base, plus a top-level `unit_system` field stating whether values are `NATURAL_UNITS`, `SYSTEM_BASE` or `DEVICE_BASE`. [review-psy-data: `per_unit.md` three unit systems; "Transformers are always stored on device base"]

5. The case document must add `available: bool` to every component including buses, define `type: isolated` for structurally disconnected buses, and map PSS/E in-service flags to `available`, not bus type. [review-psy-data: `buses_type_explanation.md` `ISOLATED` structural vs `available = false` analytical]

6. The case document must gain `"kind": "fixed" | "switched"` on shunts, with the ANDES adapter reporting every switched shunt as `known-difference:swshunt-fixed-binit`. [review-andes-io: `_parse_swshunt_v33` collapses to fixed `Shunt` with `'b': data[9] / mva`; `MODSW`, `VSWHI/VSWLO`, steps dropped]

7. The case document must gain a `reserves` block with direction, requirement series and providers, since neither case nor study can currently express named reserve services. [review-psi-ops: `how_to/problem_templates.md` `set_service_model!(template, VariableReserve{ReserveUp}, RangeReserve)`; `how_to/read_results.md` `RequirementTimeSeriesParameter__VariableReserve`]

8. The case document must add a `"shaft"` role in the `dynamics` section, with `GENROU` params split into `machine` (electrical) and `shaft` (mechanical: `H`, `D`). [review-psy-data: `dynamic_data.md` five sub-components; `psse_dynamic_mapping.yaml` `GENROU` maps to `RoundRotorQuadratic` + `RoundRotorShaft`]

## Study document and options

1. The study schema must gain operations fields: `template`, `network_model`, `horizon_h`, `resolution_min`, `solver`, `device_models`, `services`: rather than burying the whole problem definition under `ext.<engine>`. [review-psi-ops: `how_to/problem_templates.md` `ProblemTemplate`/`NetworkModel(CopperPlatePowerModel)`; `explanation/sequencing.md` "resolution = Hour(1) with interval = Hour(24) and horizon = Hour(48)"; `index.md` "An appropriate optimization solver is required"]

2. The spec must define `sim` studies with `stages` (per-stage template, resolution, interval, horizon) plus `feedforwards` naming the chronology links. [review-psi-ops: `explanation/psi_structure.md` "sequencing one or more models"; `explanation/chronologies.md` inter/intra-stage chronologies; `explanation/sequencing.md` UC→ED pattern]

3. The spec must add a neutral `pflow` option `slack_distribution: "ref_bus" | "participation"` with `participation_factors` keyed by generator `key`, mapped to `generator_slack_participation_factors`, default `"ref_bus"`. [review-pflow: `power_flow_types.jl` `generator_slack_participation_factors`, `skip_redistribution`, `distribute_slack_proportional_to_headroom`]

4. The spec must state that `load_model` is a run option only, implemented as conversion at run build, reported via the existing `tensa.notice` message path, never an `EditStep`. [review-api: `tensa.notice` "a load turned into an impedance", llms.txt "Messages"; `PflowRunRequest` "The settings apply to this run only", `pflow.py`]

5. The spec must give the correspondence between neutral `record` quantities and the five `vars` groups, and state that `dae_vars`/`dae-variables` is the ANDES realisation of the `state` quantity with a Sienna equivalent using PSID names. [review-api: `TdsRunRequest.vars` "The batch path ignores `vars`... it returns the values of `dae_vars` instead", `tds.py`]

6. The spec must map neutral `step` to `saveat` (output grid) and `dtmax` for adaptive solves, require `method: fixed` to name an explicit solver+`dt` in `ext.sienna`, and have capabilities publish allowed solver/model pairs. [review-psid: `docs/src/execute.md` `ResidualModel` → `IDA()`, `MassMatrixModel` → `Rodas4()`; `dtmax`/`abstol`/`reltol`/`saveat` kwargs]

7. The spec must add a study-document rule that disturbance values are on the system base (`base_mva`) with each adapter converting to device base, adding `base: "system" | "device"` defaulting to `system`. [review-psid: `perturbations.jl` `LoadChange` scales `ref_value` by `PSY.get_base_power(ld) / sys_base_power`]

8. The spec must add a `checks: {"islanding": "refuse" | "warn"}` field on the study, default `warn`, with the adapter running a connectivity check on the post-event topology at build time. [review-psid: `perturbations.md` note and `BranchTrip` docstring "Islanding is currently not supported ... the system may diverge"]

9. The spec must state that controllers are refused for Sienna in phase 5 with the 409 problem document, and capabilities gain `routines.tds.controllers: ["droop","ffr"] | []`. [review-api: `tds.py` `TdsRunRequest.controllers`, `TdsControllerCatalogue` `droop`, `ffr` on `ESD1`/`PVD1`/`EV1`/`EV2`]

## Disturbances

1. The spec must define a Sienna Ybus builder: `bus_fault` fields become base Ybus plus shunt `1/(r_f + jx_f)` at the faulted bus, one `bus_fault` compiles to two `NetworkSwitch`es, `branch_close` to one, with validation rejecting any switch failing the `find_subnetworks` connectivity check. [review-psid: `NetworkSwitch(time, ybus)`; constructor throws `IS.DataFormatError("Network not connected")`]

2. The spec must provide a table mapping `CaseEvent.kind` to neutral kinds (`fault`→`bus_fault`, `toggle`→`branch_trip`/`branch_close`/`gen_trip` by `model`, `alter`→`load_step`/`setpoint`/`set` by `src`) and a rule that `restored` events are excluded from the case document. [review-api: `CaseEvent`: `kind: fault|toggle|alter`, `source: case|restored`, `topology.py`]

3. The spec must move `_disturbance_from_dict` into the ANDES adapter: the neutral disturbance dict crosses the pipe and each engine's `add_disturbance` translates (ANDES to Toggle/Fault/Alter; Sienna to BranchTrip/NetworkSwitch/…). [review-worker: `_disturbance_from_dict` accepts only `kind in {"fault", "toggle", "alter"}`, `FaultSpec`/`ToggleSpec`/`AlterSpec`]

4. The spec's §6.3 load-model mapping must match PSID's actual load handling: `impedance` → `StandardLoad` with impedance components (or `FixedAdmittance` only when no load-targeted disturbance exists), and the disturbance table must note `LoadChange` signals must match the chosen components. [review-psid: `perturbations.jl` "A FixedAdmittance ybus_update! method intentionally does not exist"; `get_affect` errors on signal mismatch]

5. The spec must add adapter validation at study-build that every disturbance target resolves to a component of the required type, with a problem document otherwise, since `gen_trip`/`setpoint` on a unit without dynamics errors at build. [review-psid: `BranchTrip(1.0, Line, "Circuit2")` needs type and name; `_find_device_index` errors if device not among wrapped injectors]

## Results, quantities and streaming

1. The spec must add `status: "failed" | "partial"` with a `converged: Bool` (and per-time-step `converged` vector) and a rule that a non-converged `pflow` result carries no tables or NaN-tagged rows, never silently empty ones. [review-pflow: `solve_ac_power_flow.jl` "df_results = missing; @error(...)"; `solve_and_store_power_flow!` returns only a `Bool`]

2. The neutral `pflow` result must carry `bus_type_changes: [{key, from: "pv", to: "pq", q_clamped_mvar}]`, populated from the adapter diffing `data.bus_type` before/after the Q-limit outer loop. [review-pflow: `check_reactive_power_limits` triggers `_ac_power_flow` outer loop flipping PV→PQ, `_check_q_limit_bounds!`, `MAX_REACTIVE_POWER_ITERATIONS`]

3. The spec must state the Sienna adapter reads results under `SYSTEM_BASE` units and converts to MW/MVAr using the case `base_mva`, with `voltage` in pu and `angle` converted rad→deg, plus a test matching ANDES MW values within tolerance. [review-pflow: `with_units_base(system, PSY.UnitSystem.SYSTEM_BASE)` in `solve_ac_power_flow.jl`/`solve_dc_power_flow.jl`]

4. The results document must gain an `optimization` block (`variables`, `parameters`, `expressions`, `duals`, `aux`) with per-entry name/component/of/unit/t/y, and for `sim` a `steps` axis plus a `realized: true` view, since duals are the prices. [review-psi-ops: `how_to/read_results.md` `read_variable`/`read_parameter`/`read_expression`/`read_dual`/`read_aux_variable`; `read_realized_variable` concatenates interval]

5. The spec must state that a `dcpflow` result holds `angle` (deg), `p_from`/`p_to` (MW), optionally `losses_mw` per branch, and that `voltage`, `q*` are absent, so comparison knows to compare only shared quantities. [review-pflow: `solve_dc_power_flow.jl` writes `bus_angles`, `arc_active_power_flow_from_to/to_from`, `arc_active_power_losses`]

6. The spec must state that frame conversions (reference-relative `angle`, COI-relative `rotor_angle`) are applied in the adapter's collector before `push`, and add a per-step `collect() -> row` hook to the engine interface. [review-stream: collector currently does no per-step arithmetic for these; §6.5 "An adapter converts to these" has no seam]

7. The spec must pin that `?names=neutral` is applied when the run's `var_columns` list is built at `start_tds`, a run cannot change naming mid-stream, and `resume` inherits it. [review-stream: "A run names its columns once, in `stream_start.metadata.var_columns`"; review-api: `{"type":"resume","run_id":"...","last_seq":N}`]

8. The spec must state that `dae_vars` columns keep their engine names under `?names=neutral` since they are the `state` quantity, otherwise a neutral rename would falsely imply cross-engine meaning. [review-stream: `dae_vars` names appended verbatim, "the engine's raw state, for one-engine use only"]

9. The spec must either define bus `frequency` as a derived quantity with the algorithm stated, or drop it from first scope. [review-stream: nothing in the module produces it; the docstring's "frequency proxy" is machine speed]

10. The spec must either add receiving-end pi-equivalent expressions to `_LineFlowReader` widening `line_flow` to four columns per line, or change the catalogue to from-end only. [review-stream: `line_flow` currently 2 columns/line; review-api: `tds.py` `vars` "active and reactive power at each line's bus1 terminal" only]

11. The spec must add a `shunt_pq` group with a `_ShuntReader`, or remove shunt from the `p`, `q` row. [review-stream: `_LoadReader` reads `PQ.Ppf`/`Qpf` × mva base shows the pattern]

12. The spec must add a results `tables` entry `"eigenvalues": [{"lambda": [re, im], "frequency_hz": ..., "damping_ratio": ...}]` computed adapter-side from the Jacobian functor, with participation factors from eigenvectors. [review-psid: `docs/src/small.md` reduced Jacobian `J_red`; eigenvalues/eigenvectors "reported" without an API]

## Capabilities and fidelity

1. The ANDES adapter must emit `unsupported` fidelity entries with `handling: "dropped"` for `twotermdc`/`vscdc`/`mtdc` blocks, which requires file-level inspection since they never reach the loaded system. [review-andes-io: `_VERSION_CONFIGS` lists `twotermdc`, `vscdc`, `mtdc`; `read()` never calls a `_parse_dc*`]

2. The spec must require the ANDES adapter to intercept the unsupported-DYR-model log paths and turn them into fidelity entries, since they are currently logger calls and `read_add` returns `True` regardless. [review-andes-io: `read_add` collects `not_supported`, logs `'Models not yet supported: %s'`, continues; `if psse_model not in dyr_yaml: logger.error(...); continue`]

3. The capabilities route must list the supported PSS/E dynamic models from `psse_dynamic_mapping.yaml`, and the adapter must refuse or substitute unsupported models with a fidelity entry. [review-psy-data: `parse_dynamic_data.md` "For a complete list of supported models in PowerSystems.jl version 5.0 ... see the Supported PSS/e Models reference page"]

4. The spec must record the full template in the results document and add a comparison check that refuses to diff two operations results whose templates differ without a warning. [review-psi-ops: `formulation_library/ThermalGen.md` `ThermalDispatchNoMin` lower bound 0 vs `ThermalBasicDispatch` `P^th,min`; only `ThermalStandardDispatch`/`ThermalCompactDispatch` add ramp constraints]

5. The spec must require the adapter to always read back slack variables and surface nonzero slack as a warning in the results document. [review-psi-ops: `formulation_library/Network.md` `SystemBalanceSlackUp/Down` at cost 1e6; `ThermalStandardDispatch` ramp slacks at 2e5, `use_slacks = true`]

6. The spec must add capability-style validation cross-checking requested result quantities against `network_model`, since reactive power variables are not created under active-power-only network models. [review-psi-ops: `formulation_library/ThermalGen.md` note "If the network model is purely active power-based, reactive power variables and related constraints are not created"]

7. The fidelity/known-difference machinery must carry a standing entry that PSID small-signal validation is WIP, surfaced on every cross-engine `eig` comparison. [review-psid: `docs/src/small.md` "The validation of small signal results is still work in progress due to the differences in the way that different software packages perform the calculations"]

8. The spec must resolve the `unverified` fidelity state falling out of the contract, since the §8 state list, §7 `models` map and `/fidelity` route are written for three states. [review-web: schema test on `GET /sessions/{id}/fidelity` and §7 `models` value enum "fails today against the spec's own last paragraph"]

9. The spec must require the adapter to assert the detected PSS/E version is in `_VERSION_CONFIGS` at load and refuse otherwise, since the fallback path silently mis-parses future versions. [review-andes-io: `_VERSION_CONFIGS.get(version, _VERSION_CONFIGS[33])`; v34 `branch_cols` differ, name at 6, ratings shifted]

## Engine interface, worker and sessions

1. The spec must add a dispatch rule for ops the engine does not implement: each engine declares `ops: frozenset[str]`, `_serve_commands` checks membership before dispatch and replies with an `EngineUnsupported` error carrying `op` and `engines_with_op`. [review-worker: `HANDLERS` in `worker.py` is a single flat dict of ~50 ops, all ANDES-backed; `_serve_commands` special-cases `run_tds`, `run_sweep`]

2. The spec must move stream metadata construction behind the engine via `engine.tds_stream_plan(args) -> StreamPlan` returning column names, idx/key lists and a `collect(t)` callable, so `_handle_run_tds` only encodes and sends. [review-worker: `_handle_run_tds` builds from `VAR_GROUPS`, `bus_idx_values_from_system(ss)`, `StreamCollector(ss, ...)`, `var_column_names(...)`: all ANDES-specific]

3. The spec must add `engine: str = "andes"` to `worker_main` and `_serve_commands`, with `engine_instance = registry[engine](...)`, skipping `_warm_andes` unless `engine == "andes"`. [review-worker: `worker_main`'s signature `(ctrl, data, abort_event, workspace, session_id, owner_pid)` has no engine slot]

4. The spec must state that spawn stays cheap for every engine, engine-specific heavy init happens on first op that needs it, and `GET /sessions/{id}` gains a `ready: bool` or the capability block's `available` flag reflects warm-up state. [review-session: `sess.last_active = time.monotonic()` before `ctrl.send`; no in-op heartbeat; Julia warm-up inside an op vs at spawn]

5. The spec must state explicitly that run/sweep buffers and the abort event are engine-agnostic, and that `signal_abort` is the abort channel for Sienna `tds` too. [review-session: `signal_abort` sets `sess.abort_event`, "Cooperatively terminates an active ``run_tds``"; `invoke` gates on `sess.sweep_in_progress`]

6. The spec must define what `POST /sessions {"engine": "sienna"}` returns when Julia is missing: a 409 or 422 problem document with `unavailable_reason`, distinct from the 429 cap. [review-session: `create_session` raises `RuntimeError` at `max_sessions` mapped to 429; no unavailable branch exists]

7. The spec must make `log_pflow_notices` and report generation engine methods (`engine.pflow_notices()`, `engine.generate_report(routine)`), with the ANDES adapter keeping today's behavior. [review-worker: `_handle_run_pflow` calls `log_pflow_notices(wrapper._require_loaded())`; `_handle_generate_report` calls `generate_report(ss, routine)` on the raw System]

8. The spec must add `engine: str` to `SessionDescriptor` and carry it on `_Session` from creation, so the session list can show or filter by engine. [review-session: `list_sessions` returns ids only; `_descriptor` rebuilds descriptors from `(request, sid)`]

9. The spec must require the worker's exit path to record whether juliacall initialised, with `death_reason` distinguishing "julia init failed" so the next `create_session(engine="sienna")` can fall back to the child-process engine. [review-session: `_raise_worker_died` maps torn-pipe errors to `WorkerDiedError`; nothing records a cause beyond `err.detail`]

10. The spec must define the abort mechanism for Sienna: the callback must raise/return the DiffEq termination signal (`terminate!` on the integrator), with a result `status: "aborted"` mapping. [review-psid: only execution control documented is `enable_progress_bar = false` and solver kwargs; nothing shows how to terminate `execute!` early]

11. The spec must enumerate a per-engine op table mapping each existing op (clone, snapshots, bundles, PMU, timeseries, sweeps) to `andes`, `sienna`, or both, with the refusal category for the rest. [review-worker: §7 capability example has `"editing": false` for Sienna but never enumerates which worker ops correspond]

12. The spec must specify the exact Julia function or constructor the Sienna adapter uses to build a `System` from the case document, scoping the `add_component!` natural-units workaround if none exists. [review-psy-data: `add_component_natural_units.md` multi-step process per component; no documented constructor takes a JSON case document]

## Web client

1. The spec must add `engine: string | null` and `capabilities: EngineCapabilities | null` to `SessionState`, set from the session response, passed into `useCreateSession` on recovery, and cleared in `clearSession`/`resetSession`. [review-web: `web/src/store/session.ts` holds only `sessionId`, `workspaceId`; `resetSession` → `useCreateSession.mutate()` recreates with no engine parameter]

2. The spec must extend `ReadinessInputs` with `capabilities`, check `capabilities.routines[routine]` before routine-specific gates, return a disabled reason naming the missing routine, and add Sienna-only routines to `RunRoutine`. [review-web: `useRunReadiness` is the single gating point for every Run button and currently cannot see capabilities]

3. The spec must define a fidelity surface: a `fidelity` field on `TopologyEntry` or a client query for `GET /sessions/{id}/fidelity` keyed by `key`, a badge rule on diagram symbol and Inspector, and surfacing the `on_unsupported: "drop"` list in the `SessionMessage` log. [review-web: `TopologyEntry` has no fidelity field; no store slice or hook input for it; `types.ts` `SessionMessage`]

4. The spec must make the dynamic-presence readiness rule ask the session's capabilities or a `has_dynamics` flag on `TopologySummary` rather than pattern-matching ANDES kinds, with engine-neutral disabled-reason wording. [review-web: `hasDynamicModels` recognises dynamics only by `GENROU`/`GENCLS` kinds and the `controllers` bucket; "Load a .dyr addfile" message]

5. The spec must require a contract test listing every kind string the Sienna adapter can emit for `topology.generators`/`controllers`, diffed against the sets the web code special-cases. [review-web: UI parses converter stage and wind chain from class string `startsWith('REG'/'REE'/'WTD'/'WTAR'/'WTP')`, `/^RE([GEP])C/`]

## Operations (OPF, dispatch, unit commitment)

1. The spec must decide in the phase 7 spike which view `POST /compare` consumes (realized is the only like-for-like one) and test with a two-stage UC/ED run. [review-psi-ops: `how_to/read_results.md` `read_variable` returns per-step DataFrames of horizon length (72 rows) while realized series is interval-concatenated (192 rows from 8×24)]

2. The spec must flag for the phase 7 spike a round-trip test of each `FunctionData` kind, since ANDES/pandapower-side OPF cost models may not cover the same set and the neutral `cost` block risks lowest-common-denominator definition. [review-psi-ops: `General.md` linear, quadratic/polynomial, two piecewise representations plus no-load, startup/shutdown, fixed terms; "The material does not say what pandapower accepts"]

## Risks to test first

1. Run the spec's own round-trip key test on a case with parallel lines before Phase 3's "`key` on topology and results for ANDES" is considered done, since cross-engine key mismatch on branches is the default, not the exception. [review-andes-io: ANDES discards `CKT` in `_parse_line`; "opens with a warning and comparison is refused" would fire on ordinary PSS/E cases]

2. Compare block counts from a raw-file scan against element counts in the loaded system for every example case, since silent drops leave no trace in the loaded system. [review-andes-io: no `_parse_dc*` call in `read`; `system.add('Zone', param)` commented out in `_parse_area_v33`; area `ISW/PDES/PTOL` commented out]

3. The phase-4 key-set equality test must include cases with tap-changing transformers and phase shifters, and separately `kundur_full.xlsx`/`ieee39_full.xlsx` for xlsx text idxs. [review-api: `TopologySummary.transformers` defined by ANDES heuristics tap ≠ 1, phi ≠ 0, `trans` flag, Vn1 ≠ Vn2; `kundur_full.xlsx` trips `Line_8`]

4. For each neutral quantity, spike naming the ANDES variable(s) it maps from per routine; gaps show up as quantities only available via `state`. [review-api: TDS `line_flow` group is bus1-terminal only; `frequency` exists only as `fHz` controller-device measurement, `TdsControllerVariables`]

5. Phase-5 audit must define COI recomputation per step from streamed `delta`/`omega` and machine in-service status, tested against a case with a machine trip. [review-api: ANDES streams raw `delta` (`gen_state` group); `coi_available` false when no synchronous machine, `TdsControllerCatalogue`]

6. Adapter-side allow-list rejecting unknown kwargs before the Julia call, plus a test asserting `max_iterations: 3` actually stops a non-converging case at 3 iterations. [review-pflow: `merge(get_solver_kwargs(pf), kwargs)` and `get(kwargs, :maxIterations, ...)` in `solve_ac_power_flow.jl`; misspelled option is not an error]

7. A consistency test on one case checking `p_from + p_to ≈ losses` and power balance at each bus from the returned numbers, fixing one source path. [review-pflow: NOTE in `solve_power_flow!`: `power_network_matrix` uses `ComplexF32` while system objects store `Float64`, ~1e-4 difference]

8. Feed an islanded case to `dcpflow` in the adapter test suite and define whether the worker turns the exception into `status: "failed"` or a 409/500 problem document. [review-pflow: all three DC `solve_power_flow!` methods set `data.converged .= true` with no residual check; singular network fails inside `KLULinSolveCache`/`full_factor!` as exception]

9. A like-for-like test of the same `load_step` study on ANDES (`Alter`) and Sienna on a ZIP load, comparing `p` of the load and a nearby bus voltage in the first 100 ms. [review-psid: `LoadChange` with `:P_ref` on a `StandardLoad` changes the impedance part, `perturbations.jl` `get_affect` plus deprecation warning]

10. Spike a `ResidualModel`+IDA run with a discrete callback that records every step and terminates at t=1; confirm the recorded grid matches `saveat` and termination leaves `read_results` usable. [review-psid: no `sim.callbacks` surface documented; DAE callbacks more delicate than ODE ones]

11. Time a cold `pflow` on Sienna behind the real registry and watch the UI's behaviour; decide whether engine init must go through the streaming path before Phase 4 is declared done. [review-session: `invoke` does `sess.lock.acquire(blocking=False)` raising `SessionBusyError` → 409; no progress mechanism inside `invoke`]

12. Kill the worker mid-Sienna-session in a phase-3/4 integration test, assert the recreated session's `engine`, and measure Sienna session-create latency cold vs. the 10s budget. [review-web: recovery machine has no engine input; `RECOVERY_STUCK_TIMEOUT_MS` calibrated to "session-create settles in <500ms"]