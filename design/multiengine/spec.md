# Multi-engine TENSA: specification

Status: draft 1, 2026-11-20. Written from the Phase 1 spike (`reports/phase-1-spike.md`) and the inventories (`reports/andes-gaps.md`, `reports/model_matrix.md`). It replaces the decision "HTTP boundary uses ANDES `idx` + `name` directly" in `AGENTS.md`.

## 1. What this is for

1. Run the same study on more than one engine and compare the results.
2. Offer what each engine can do that the others cannot.
3. Describe a case, a study and its results once, in terms that belong to TENSA, and map them to each engine.

Engines at the start: `andes` (ANDES 2.x, Python) and `sienna` (PowerSystems.jl for data, PowerFlows.jl, PowerSimulationsDynamics.jl for dynamics, PowerSimulations.jl for operations). The design must take a third (pandapower is the likely one, since ANDES already bridges to it).

## 2. Principles

- **One engine per session.** A session is created for an engine and keeps it. Comparison is two sessions on one study, not one session with two engines.
- **Additive.** A request that names no engine gets `andes` and every existing route answers as it does today. Nothing in this document changes an existing response for an ANDES session except by adding fields.
- **TENSA's vocabulary is the one the API already speaks.** The API's kinds (`Bus`, `Line`, `PQ`, `PV`, `Slack`, `Shunt`, `GENROU`, `TGOV1`, ...) are ANDES class names today, plus one kind TENSA derives itself (a transformer is an ANDES `Line` with a tap, a shift, the `trans` flag or two rated voltages). They become TENSA kinds and keep their spelling. For the standard dynamic models that spelling is the PSS/E name, which Sienna's parser uses too; where another engine's name differs, its adapter holds the alias. An adapter must hand the API the same shapes the ANDES one does, which is what lets the UI draw a Sienna case with the code that draws an ANDES one. Concretely the Sienna adapter must: put elements in the same topology buckets; spell kinds the same; classify a transformer by what it is, not by ANDES's rule; and fill the link params the UI groups by (`bus`, `gen`, `syn`, `avr` and the converter chain's `reg`, `ree`, `rego`, `rea`, `rep`, as `web/src/lib/generatingUnits.ts` reads them).
- **Identity does not belong to an engine.** Every element has a `key` built from the case (section 4). `idx` stays, as the engine's own handle.
- **Nothing is dropped silently.** What an engine cannot represent, approximates or models differently is reported per element (section 8).
- **Engine-only features are namespaced, not hidden.** A study or a case may carry an `ext.<engine>` block that only that engine reads; capabilities say what each engine accepts (section 7).
- **The ANDES code is not refactored.** `tensa.core.wrapper.Wrapper` becomes the ANDES engine as it stands. The seam is its public surface (section 9).

## 3. The three documents

| Document | Says | Section |
|---|---|---|
| Case | what the system is | 4, 5 |
| Study | what to do to it | 6 |
| Results | what came back, in which units and frame | 6.4 |

Each has a version field (`tensa_case`, `tensa_study`, `tensa_results`), starting at 1. A reader refuses a newer major version and upgrades an older one, the way `core/layout.py` does for layouts.

## 4. Identity

A `key` is a string, unique in a case, the same in every engine that loads that case.

| Element | Key | Example |
|---|---|---|
| Bus | `bus:<number>` | `bus:7` |
| Line | `line:<from>-<to>-<ckt>` | `line:7-8-1` |
| Two-winding transformer | `xfmr:<from>-<to>-<ckt>` | `xfmr:1-5-1` |
| Generator (static) | `gen:<bus>-<id>` | `gen:1-1` |
| Load | `load:<bus>-<id>` | `load:7-1` |
| Shunt | `shunt:<bus>-<id>` | `shunt:7-1` |
| Dynamic model of a generating unit | `<unit key>/<role>` | `gen:1-1/machine`, `gen:1-1/exciter`, `gen:1-1/governor`, `gen:1-1/pss` |
| Other device on a bus | `<kind lower-case>:<bus>-<id>` | `motor:5-1` |

Rules:

- `<number>` is the bus number of the case. A case whose buses are not numbered (an ANDES file with text idx) gets numbers in file order, and the case document records the original name.
- `<from>-<to>` are in the order the case gives them. `<ckt>` and `<id>` are the PSS/E circuit and device ids where the format has them; otherwise the ordinal, from 1, among the elements of that kind on the same bus or bus pair, in file order.
- **Engines lose ids, so TENSA reads them itself.** ANDES's PSS/E reader keeps the machine id (as `subidx`) but discards the circuit id of a branch and the id of a load or shunt; it keeps file order. PowerSystems keeps the ids in component names (`generator-<bus>-<id>`) but not file order. `engines/identity.py` therefore reads the identity columns of a `.raw` or `.m` file itself (bus numbers, ends, ids, in file order), and each adapter matches its elements to that list: ANDES by order, Sienna by id. No adapter invents an id.
- Roles of a generating unit are the ones `web/src/lib/generatingUnits.ts` already has: `generator`, `machine`, `exciter`, `pss`, `governor`, `renewable`, `measurement`, `profile`, `other`. Two models of one role on a unit are told apart by kind: `gen:1-1/renewable:REGCA1`.
- **What an engine adds or renames is outside the comparison until it has a rule.** A three-winding transformer becomes a star bus and three branches in ANDES and in PowerSystems, PowerSystems adds dummy buses for multi-section lines and renames buses whose names collide, and either may mark a bus isolated. First scope: such elements get keys under `engine:<name>:...`, are listed in the fidelity report, and are left out of comparison. A rule for three-winding transformers (`xfmr3:<i>-<j>-<k>-<ckt>` with the star bus as `bus:star:<i>-<j>-<k>-<ckt>`) comes with the first case that needs it.
- An adapter must produce the same keys as the others for the same file. Tests hold that for every example case both engines can open: same set of bus, branch and injector keys. A case where the sets differ opens with a warning and comparison is refused for the elements that have no partner.
- **Where `key` appears.** Every `TopologyEntry` gains `key`. Results that are JSON objects keyed by `idx` (`bus_voltages`, `line_flows`, ...) keep those keys, and the response gains one lookup, `keys: {"<idx>": "<key>"}` per kind, so nothing is re-keyed or doubled. `GET /sessions/{id}/keys` returns the whole map both ways. Routes whose path holds `{model}/{idx}` keep that shape; a client that has a key looks the `idx` up. A key always contains a colon after a lower-case kind, and no route reads a path segment as either an idx or a key.

## 5. The case document

JSON. Quantities carry their unit in the field name or are per unit on a stated base. It is what `GET /sessions/{id}/case/neutral` returns and what a session of any engine can be created from.

```json
{
  "tensa_case": 1,
  "name": "kundur",
  "base_mva": 100.0,
  "freq_hz": 60.0,
  "source": {"format": "psse-raw", "files": ["kundur.raw", "kundur_full.dyr"], "sha256": ["...", "..."]},
  "buses": [
    {"key": "bus:1", "number": 1, "name": "BUS1", "vn_kv": 20.0, "type": "pv", "v_pu": 1.03, "angle_deg": 20.2, "area": 1, "zone": 1}
  ],
  "lines": [
    {"key": "line:7-8-1", "from": 7, "to": 8, "ckt": "1", "r_pu": 0.011, "x_pu": 0.11, "b_pu": 0.1925, "rate_a_mva": 0.0, "in_service": true}
  ],
  "transformers": [
    {"key": "xfmr:1-5-1", "from": 1, "to": 5, "ckt": "1", "r_pu": 0.0, "x_pu": 0.15, "rate_mva": 900.0, "vn_from_kv": 20.0, "vn_to_kv": 230.0, "tap": 1.0, "shift_deg": 0.0, "rate_a_mva": 0.0, "in_service": true}
  ],
  "generators": [
    {"key": "gen:1-1", "bus": 1, "id": "1", "p_mw": 700.0, "q_mvar": 185.0, "v_set_pu": 1.03, "q_min_mvar": -1e4, "q_max_mvar": 1e4, "mbase_mva": 900.0, "in_service": true}
  ],
  "loads": [
    {"key": "load:7-1", "bus": 7, "id": "1", "p_mw": 967.0, "q_mvar": 100.0, "zip": {"p": [0, 0, 1], "q": [0, 0, 1]}, "in_service": true}
  ],
  "shunts": [
    {"key": "shunt:7-1", "bus": 7, "id": "1", "g_mw": 0.0, "b_mvar": 200.0, "in_service": true}
  ],
  "dynamics": [
    {"key": "gen:1-1/machine", "unit": "gen:1-1", "role": "machine", "model": "GENROU",
     "values": [8.0, 0.03, 0.4, 0.05, 6.5, 0.0, 1.8, 1.7, 0.3, 0.55, 0.25, 0.06, 0.0, 0.0],
     "names": ["T'do", "T''do", "T'qo", "T''qo", "H", "D", "Xd", "Xq", "X'd", "X'q", "X''d", "Xl", "S(1.0)", "S(1.2)"]}
  ],
  "events": [
    {"kind": "branch_trip", "target": "line:7-8-1", "t": 2.0, "source": "case"}
  ],
  "ext": {"andes": {}, "sienna": {}}
}
```

Rules:

- **Bases are stated, never implied.** A line's impedance is per unit on `base_mva` and the bus's `vn_kv`. A transformer's is on its own rating: the record carries `rate_mva` and its two rated voltages beside `r_pu` and `x_pu`, because PowerSystems stores transformer data on the device base and warns that the conversion needs a voltage-ratio correction when rated and bus voltages differ. A machine's parameters are on `mbase_mva`. Each adapter converts to what its engine stores and the round-trip test (below) holds the conversion.
- `zip` gives the fractions at 1.0 pu: constant impedance, current, power, in that order.
- `type` of a bus is `pq`, `pv`, `ref` or `isolated`, with `"in_service"`. A PSS/E area-interchange slack is not a type: it is `"area_slack": true` on a `pv` or `ref` bus, when the reader can tell (PowerSystems marks it; ANDES's reader drops the area's `ISW`, so the identity reader supplies it). No engine is handed a bus type it may not know (spike item 3): the Sienna adapter turns `area_slack` into PowerSystems' `SLACK` only for packages that know it.
- `events` holds what a case file says happens in time: ANDES reads `Toggle` and `Fault` records from a `.dyr` (its `psse-dyr.yaml` maps them) and `Toggle`, `Fault`, `Alter` sheets from an xlsx. An adapter never passes them to a parser that cannot read them (spike item 4).
- `dynamics[].model` is a TENSA dynamic kind (section 2). `values` is the model's parameters in the order of its PSS/E `.dyr` record, which is how ANDES (`psse-dyr.yaml`) and PowerSystems (`psse_dynamic_mapping.yaml`) both read them, by position. `names` is for people and is not read back. A model with no PSS/E record (an ANDES-only or Sienna-only model) carries `"vocabulary": "andes"` or `"sienna"` and a `params` object in that engine's names, and only that engine accepts it.
- `ext.<engine>` carries what only one engine holds, verbatim: for ANDES the sheets of models the document has no place for; for Sienna components built in code (inverter parts, time series references, cost curves until section 5 grows fields for them).
- Fields grow by minor version. First scope: everything above, which covers AC power flow in every engine and dynamics for the models both engines simulate. Next: costs and limits for operations (ramp rates, min up/down, cost curves), time series references, three-winding transformers, DC lines, converter plants.

How a case reaches an engine:

1. **File the engine reads.** The adapter parses it with the engine's own reader, then reports the case document from what the engine holds. Keys come from section 4.
2. **File the engine does not read** (an ANDES xlsx in Sienna, a Sienna JSON in ANDES). TENSA opens it in an engine that reads it, takes the case document, and builds the other engine's system from the document. `core/psse_writer.py` already goes from ANDES to PSS/E; the document generalises that.
3. **Case document.** Built directly into any engine.

Round trip is a test: file → engine A → document → engine B → document must give the same document up to stated tolerances and each engine's `ext`.

## 6. The study document

```json
{
  "tensa_study": 1,
  "routine": "tds",
  "options": {"t_end": 10.0, "step": 0.0083333, "method": "default"},
  "load_model": "impedance",
  "disturbances": [
    {"kind": "branch_trip", "target": "line:7-8-1", "t": 1.0}
  ],
  "record": [
    {"quantity": "rotor_speed", "of": "gen:*"},
    {"quantity": "voltage", "of": "bus:*"}
  ],
  "ext": {"sienna": {"solver": "IDA", "model": "ResidualModel"}}
}
```

### 6.1 Routines

| Routine | Meaning | `andes` | `sienna` |
|---|---|---|---|
| `pflow` | AC power flow | PFlow | PowerFlows |
| `dcpflow` | DC power flow | (through pandapower bridge) | PowerFlows |
| `tds` | time-domain simulation | TDS | PSID |
| `eig` | small-signal analysis | EIG | PSID |
| `cpf` | continuation power flow | CPF | none |
| `se` | state estimation | SE | none |
| `matrices` | Ybus, PTDF, LODF | `build_ybus`, GSF | PowerNetworkMatrices |

A routine an engine lacks is absent from its capabilities and refused with a problem document that names the engines that have it.

**Operations routines (second scope).** PowerSimulations is not a one-shot solver: a run is a decision model built from a template (a network model, a formulation per device type, service models) over a horizon at a resolution, and a simulation chains such models with an interval. So these are not options of an engine, they are the study:

| Routine | Meaning | Study fields beyond `routine` |
|---|---|---|
| `dispatch` | economic dispatch; one period is the optimal power flow case | `template` (`economic_dispatch` or explicit device formulations), `network_model` (`copper_plate`, `ptdf`, `dc`, or an AC model), `horizon`, `resolution`, `solver` |
| `uc` | unit commitment | the same, with `template: unit_commitment` |
| `sim` | multi-stage simulation | `stages` (each a `dispatch` or `uc`), `interval`, `steps`, feed-forwards |

They need case data the first scope does not hold: active power limits, cost curves, ramp limits, minimum up and down times, start-up and shut-down costs, reserves, and time series for load and renewable output. Those fields, the time series store and the results tables (variables, duals, parameters, expressions) are specified in Phase 7 from the PowerSimulations formulation library, before any of these routines is listed in capabilities. ANDES has none of them; ANDES's own one-period optimal power flow runs through its pandapower bridge and is an ANDES gap item.

### 6.2 Options

A neutral option is one whose meaning does not depend on the engine. The adapter owns the mapping to the engine's own name and default, and applies it explicitly, since a misspelt Julia keyword is ignored without a word.

| Routine | Neutral option | `andes` | `sienna` |
|---|---|---|---|
| `pflow` | `tolerance` | `PFlow.config.tol` | `tol` (default 1e-9) |
| | `max_iterations` | `PFlow.config.max_iter` | `maxIterations` (default 30) |
| | `initialization`: `case`, `flat`, `enhanced` | `flat` is today's `flat_start` (`core/pflow_options.py`); `enhanced` not available | `flat` is `enhanced_flat_start = false`; `enhanced` is the engine's default |
| | `solver`: `newton`, and per engine `dishonest`, `newton_krylov`, `trust_region`, `levenberg_marquardt`, `homotopy`, `gradient_descent` | `PFlow.config.method` | the `ACPowerFlow{...}` type |
| | `enforce_q_limits` | PV and Slack limiters (`core/pflow_options.py`) | to be confirmed against PowerFlows' reactive limit handling |
| `dcpflow` | `model`: `aba`, `ptdf`, `virtual_ptdf`; `lossy` | pandapower bridge | `DCPowerFlow`, `PTDFDCPowerFlow`, `vPTDFDCPowerFlow` |
| `tds` | `t_end`, `step`, `method` (`default`, `fixed`, `adaptive`) | `TDS.config` | `execute!` keywords and solver |

The existing `flat_start` flag of `POST /sessions/{id}/pflow` stays and means `initialization: flat`. Capabilities publish, per engine and routine, which values each option takes. Everything without a neutral meaning is the engine's own and goes under `ext.<engine>`, validated by that engine's adapter against a list it publishes. No pass-through of arbitrary keys.

The Sienna power flow result is read back from the system after `solve_and_store_power_flow!` (per-injector `p` and `q`, branch flows at both ends), not from the data-frame dictionary of `solve_power_flow`.

### 6.3 `load_model`

`impedance`, `power` or `as-case`. It states how loads behave in `tds` and `eig`. Default `impedance`, converted at the solved voltage. That is ANDES's own default (`PQ.config.p2z = q2z = 1`), so an ANDES session behaves as today, and it is what the spike needed for the engines to agree at all (spike items 1, 2). The Sienna adapter represents converted loads as `FixedAdmittance`.

### 6.4 Disturbances

| Kind | Fields | `andes` | `sienna` (PSID) |
|---|---|---|---|
| `branch_trip` | `target`, `t` | `Toggle` on the line | `BranchTrip` |
| `branch_close` | `target`, `t` | `Toggle` | one `NetworkSwitch` with the Ybus that has the branch back (`BranchImpedanceChange` needs the branch in service and cannot restore it) |
| `bus_fault` | `bus`, `t_on`, `t_clear`, `r_pu`, `x_pu` | `Fault` (`tf`, `tc`, `rf`, `xf`) | two `NetworkSwitch` events; the adapter builds the faulted Ybus (fault admittance on the bus's diagonal) and the cleared one |
| `gen_trip` | `target`, `t` | `Toggle` on the machine | `GeneratorTrip` |
| `load_step` | `target`, `t`, `p_mw`, `q_mvar` | `Alter` on the load | one `LoadChange` per signal, on the component `load_model` left the load with, value on the load's own base |
| `setpoint` | `target` (a generating unit), `signal` (`p_ref`, `v_ref`, `q_ref`, `omega_ref`), `value`, `t` | `Alter` | `ControlReferenceChange` on the unit's dynamic injector |
| `set` | `target`, `param`, `value`, `t` | `Alter` | engine-specific, `ext` only |

- The existing disturbance route and its `FaultSpec` (`bus_idx`, `tf`, `tc`, `xf`, `rf`), `ToggleSpec` and `AlterSpec` stay as they are for ANDES sessions. The study document's names map to them as the table shows (`t_on` is `tf`, `t_clear` is `tc`).
- A `NetworkSwitch` takes a whole admittance matrix and PSID refuses one that splits the network. The Sienna adapter therefore owns a Ybus builder (PowerNetworkMatrices) and reports a disturbance that would island the system as unsupported for that engine, before the run.
- All disturbances of a study are known before the run is built, which is already TENSA's rule ("disturbances require pre-setup state") and is how PSID works.

### 6.5 Results

A result names what each number is.

```json
{
  "tensa_results": 1,
  "engine": {"name": "sienna", "versions": {"PowerSystems": "5.12.5", "PowerSimulationsDynamics": "0.16.2"}},
  "study": {"...": "the study as run"},
  "status": "completed",
  "series": [
    {"quantity": "rotor_speed", "of": "gen:1-1", "unit": "pu", "t": [...], "y": [...]}
  ],
  "tables": {}
}
```

Quantity catalogue, first scope:

| Quantity | Of | Unit | Frame or convention |
|---|---|---|---|
| `voltage` | bus | pu | magnitude |
| `angle` | bus | rad | as the engine reports it: its network frame |
| `angle_rel` | bus | rad | minus the reference bus's angle at the same instant |
| `rotor_speed` | generating unit | pu | 1.0 is nominal |
| `rotor_angle` | generating unit | rad | as the engine reports it |
| `rotor_angle_rel` | generating unit | rad | minus the inertia-weighted mean angle of the machines in service at the same instant |
| `p`, `q` | generating unit, load | MW, MVAr | electrical power injected by a unit, absorbed by a load |
| `p_from`, `q_from` | branch | MW, MVAr | into the branch at its `from` end |
| `state` | `<key>` + state name | engine's own | the engine's raw state, for one-engine use only |
| `eigenvalue` | case | 1/s | with `frequency_hz` and `damping_ratio`; a zero eigenvalue is reported as zero (`core/wrapper/eig.py`) |

- Units follow what the API serves today (angles in radians, power in MW and MVAr), so a neutral series and the existing one are the same number.
- No engine gives the two relative quantities; they are arithmetic on the engine's values, done once in a shared module (`engines/frames.py`) for both engines, so the definition cannot drift. These are the quantities comparison uses for angles (spike item 5).
- Second scope, each needing a producer in both engines first: `p_to` and `q_to` of a branch (the ANDES collector computes one end), `p` and `q` of a shunt, and bus `frequency` (ANDES has `BusFreq` devices; PSID has no bus frequency series).

Streaming keeps Arrow IPC over the WebSocket, and keeps its shape: each frame is `t` plus one list column, and the names travel once in `stream_start.metadata.var_columns`. For an ANDES session those names stay as they are (`Bus_<idx>_v`, `Gen_<idx>_omega`, ...). A client asks for neutral names with `"names": "neutral"` in the `start_tds` frame or the batch request, and then each entry is `<quantity>|<key>`, with the relative quantities available. A Sienna session always uses neutral names.

## 7. Capabilities

`GET /engines` lists every engine the server can start:

```json
{"engines": [{
  "name": "sienna",
  "available": true,
  "unavailable_reason": null,
  "versions": {"julia": "1.13.4", "PowerSystems": "5.12.5", "PowerFlows": "0.16.4", "PowerSimulationsDynamics": "0.16.2", "PowerSimulations": "0.34.2"},
  "formats": {"read": ["psse-raw", "psse-dyr", "matpower", "sienna-json", "tensa-case"], "write": ["sienna-json", "psse-raw", "tensa-case"]},
  "routines": {
    "pflow": {"options": {"tolerance": "number", "max_iterations": "integer", "initialization": ["flat", "enhanced"], "solver": ["newton", "trust_region", "levenberg_marquardt", "homotopy", "gradient_descent"]}, "ext": []},
    "tds": {"streaming": true, "abort": true, "disturbances": ["branch_trip", "branch_close", "bus_fault", "gen_trip", "load_step", "setpoint"], "ext": ["solver", "model"]}
  },
  "models": {"GENROU": "exact", "TGOV1": "known-difference:tgov1-torque", "SEXS": "unverified", "IEEET1": "unsupported"},
  "editing": false
}]}
```

- `GET /sessions/{id}` gains `engine`; the capability block is fetched from `GET /engines`, once, not repeated per session.
- The web client gates on capabilities. This is new work, not reuse: `useRunReadiness` takes the session's engine capabilities as an input and returns a reason for a routine the engine lacks ("CPF is not available with Sienna; it is with ANDES"), its routine list grows for routines only Sienna has, and the command registry's `unavailableReason` shows the same reason in the menus and the palette.
- `available: false` with a reason when Julia or the Sienna packages are not installed; ANDES is always available.

## 8. Fidelity

Four states for an element of a loaded case in a given engine:

- `exact`: the engine has the model and a like-for-like run against the reference engine agreed within the comparison tolerances.
- `known-difference:<id>`: the engine has the model and a registered entry says how it differs.
- `unverified`: the engine has the model and nobody has compared it yet. This is where every model starts.
- `unsupported`: the engine cannot hold it. `handling` says what the adapter did: `refused` (the load fails), `dropped`, or `substituted:<model>`.

`GET /sessions/{id}/fidelity` lists the elements that are not `exact`. Loading a case with `unsupported` elements fails unless the request passes `on_unsupported: "drop"`, and then the response carries the list. (PowerSystems alone would drop an unknown exciter with a log line; spike section 3.)

Known differences live in `server/src/tensa/engines/known_differences.json`, one entry each:

```json
{"id": "tgov1-torque", "model": "TGOV1", "engines": ["andes", "sienna"],
 "summary": "Sienna hands the machine a torque of P_m / omega; ANDES hands it P_m.",
 "effect": "Sienna is more damped: equivalent to D raised by P_m0 (machine base) on the unit in ANDES.",
 "small_signal": true,
 "evidence": "Kundur, GENROU + TGOV1: ANDES with D = P_m0 reproduces Sienna's eigenvalues to four digits.",
 "check": "server/tests/engines/test_known_differences.py::test_tgov1_torque"}
```

An entry needs a test that reproduces its evidence. ANDES is the reference engine for the models it has, since TENSA's own verification (`docs/examples-verification.md`) is against it; a model only Sienna has stays `unverified` until it is checked against a published result.

## 9. The engine interface

```
tensa/engines/
  __init__.py        registry: engine name -> factory; capabilities()
  base.py            Engine protocol, EngineCapabilities, EngineUnsupported
  keys.py            section 4
  case_doc.py        section 5 (pydantic), upgrade, validation
  study_doc.py       section 6
  results_doc.py     section 6.5
  known_differences.json
  andes/             adapter over tensa.core.wrapper.Wrapper (keys, case document, fidelity)
  sienna/            the Sienna engine
    engine.py        Python side, same method names as Wrapper for the ops it has
    julia/           Julia source loaded through juliacall, one module (TensaSienna)
    envs/            one Project.toml + Manifest.toml per Julia environment
```

- **The unit of an engine is a handler table, not a class.** The worker's handlers do not stay on the Wrapper's public methods: `run_tds`, `run_pflow`, `generate_report`, `save_case` and `export_bundle` reach its private state and the ANDES `System` itself. So an engine is `EngineRuntime`: a factory for its per-session state, a table `op -> handler` with the wire shapes the worker already uses, the names of its streaming ops, and a warm-up function. The existing handlers become the ANDES table without being rewritten; `tensa.core.wrapper.Wrapper` is its state. The Sienna runtime brings its own handlers for the ops it has. Result records (`core/wrapper/results.py`) are shared.
- **An op the engine's table lacks** is answered by the worker's dispatch, not by the engine: an error reply with category `engine_unsupported` and the op's name, which the API turns into a 409 problem document whose `recovery` names the engines that have the op. (Today an unknown op is `AndesAppError("unknown op")`.)
- **How the engine reaches the worker.** `POST /sessions` accepts one optional field, `engine` (default `andes`); the request model keeps `extra="forbid"`, and no body or `{}` still means ANDES. `create_session(engine)` passes the name in `worker_main`'s arguments, stores it on the session record, names the process `<engine>-worker-<id>`, and `GET /sessions/{id}` reports it. The worker warms up only its own engine (`_warm_andes` today runs unconditionally).
- The worker module imports ANDES-linked modules at import time, so a Sienna worker still loads ANDES. That is accepted at first (ANDES is a hard dependency and costs about two seconds); moving those imports into the ANDES runtime is a later clean-up.
- Snapshots, bundles and the edit journal record the engine; restoring into another engine is refused with a pointer to the case document route.
- The Sienna engine holds Julia in the worker process through `juliacall` (decision 8). Julia is loaded on first use of a Sienna session, never in the server process and never for an ANDES session. If embedding fails under `multiprocessing` spawn or on a crash, the fallback is a Julia child process speaking JSON and Arrow over pipes, behind the same runtime. That child is owned by the worker, which ends it on every exit path and puts it in the worker's Windows Job Object, because the session registry tracks one process per session and would not see it.
- Per-step streaming: `execute!` builds its callback set from the `Simulation`'s `callbacks` vector, so a `DiscreteCallback` pushed there before `execute!` runs on every accepted step and can call `terminate!` (verified in the spike, section 5; it relies on a field, not on documented API, so a test pins it per PSID version). It calls the worker's `on_step`, which checks the abort flag. The adapter maps the state vector to quantities with PSID's own indices.
- Small-signal: `small_signal_analysis(sim)` (used in the spike) gives the eigenvalues and the reduced Jacobian; damping, frequency and participation factors are computed by the code ANDES sessions already use (`core/wrapper/eig.py`), from the same matrices.
- Julia environments: `dyn-ops` (PSID, PowerSimulations and the PowerFlows they pin) and `pf` (current PowerFlows) at least. The adapter records the versions it ran with in every result.
- `tensa warm-cache --engine sienna` instantiates the environments and builds the system image; `tensa serve` starts it in the background like the ANDES code cache, and a Sienna session waits for it with a progress message.
- Messages: Julia log records at warn and above go through the worker's `PathScrubber` into the session's message log.

## 10. Comparison

- `POST /compare` holds no session. It takes two results documents (or their ids in the browser's archive) and returns, per quantity and key: largest and RMS difference on a common time grid, the swing of the reference series, and for eigenvalues the matched modes with frequency and damping side by side. Unmatched keys are listed, never ignored.
- `POST /studies` (later phase) runs one study on several engines: it creates a session per engine from the same case, runs the study, and returns the results with their comparison.
- Tolerances are part of the request, with defaults, and the response says which rows are inside them. A row that involves an element with a known difference links to it.
- The UI overlays series from both engines on the existing plots and adds a difference table. A power flow comparison is always shown first: a dynamic difference that starts from a different operating point is reported as that.

## 11. What changes in `AGENTS.md`

- "Substrate is Python-API-direct" becomes: each engine is called in-process from the session's worker; ANDES through its Python API, Sienna through `juliacall`.
- "HTTP boundary uses ANDES `idx` + `name` directly" becomes: kinds are TENSA kinds (section 2), every element has a `key` (section 4), `idx` is the engine's handle.
- "Out of scope: contingency screening, OPF, market simulation" loses OPF and market simulation, which the Sienna operations routines bring. CIM/CGMES and user-defined models stay out.
- New rule: nothing an engine cannot represent is dropped without a fidelity entry.

## 12. Security

- The trust model does not change: the local user is trusted, case files are not.
- Julia packages are fetched only by `tensa warm-cache` or an explicit install, never by a session. The environments are pinned by committed manifests.
- The worker's `sys.audit` hook sees Python opens only. File reads made by Julia are outside it; the Sienna adapter passes Julia only paths that passed TENSA's workspace validation, and writes simulation files only under the session's scratch directory.
- `ext` blocks are validated against the adapter's published list; no engine receives code or arbitrary keys from a client.

## 13. Rules the first review added

Draft 1 was reviewed by ten readers, each against one body of source (`reports/spec-review-1.md` has the merged list with evidence). The corrections are in the sections above. These further rules are accepted and belong to the phase named; each phase's unit plan takes its items from the review list.

Seam (Phase 3):
- Keys under editing: an added element takes the next free ordinal for its bus or bus pair; a key never changes within a session; replaying the edit journal rebuilds the same keys.
- Every field that holds an `idx` today (`from_idx`, `to_idx`, `dev_idx`, a controller's `idx`, an edit step's `idx`) is covered by the response's `keys` lookup; a checklist per schema file holds it.
- `POST /sessions` with an engine that is not available answers 409 with category `engine_unavailable` and the reason, distinct from the 429 of the session cap.
- Creating a session stays cheap for every engine. Heavy start-up (Julia) happens on the first op that needs it, runs through the streaming path so the client sees progress, and a recovered session keeps its engine. The web session store holds `engine` and the capabilities.
- The topology response gains `has_dynamics`, so the client stops inferring it from `GENROU` and `GENCLS`.
- A table in `engines/` lists every existing worker op against the engines that have it (clone, snapshots, bundles, PMU, time series and sweeps are ANDES-only at first).
- Run and sweep buffers, the abort event and `signal_abort` are engine-agnostic and are the abort channel for Sienna too.

Static (Phase 4):
- The identity reader also counts the blocks of a file against what the engine loaded, because a reader's silent drops leave no trace in the system: ANDES skips DC lines and zones, turns a switched shunt into a fixed one and logs an unknown `.dyr` model without failing. Each becomes a fidelity entry.
- A PSS/E version the reader has no table for is refused, not parsed with another version's columns.
- `base_mva`, `freq_hz` and a bus's `vn_kv` are null when the case does not give them; an engine's default is never exported as the case's value (`buses_without_vn` is the precedent).
- A power flow result always says `converged`; a run that did not converge carries no tables. It lists the buses whose type the reactive limits changed. A neutral option `slack_distribution` (`ref_bus`, `participation`) is added when both engines have it.
- The adapter passes Julia only keywords from an allow-list, and a test holds that `max_iterations: 3` stops a diverging case at three.
- A consistency test on the returned numbers: power balance at each bus and `p_from + p_to` equal to the losses.

Dynamic (Phase 5):
- Disturbance values are on the system base; each adapter converts. Every target is checked at build to exist and be of the right type. A disturbance that islands the network is refused or warned about by the study's `checks.islanding`.
- A table maps the existing `CaseEvent` kinds to neutral kinds; events a restore replayed are not part of the case document.
- `load_model` is a run option reported in the message log, never an edit. A `FixedAdmittance` cannot be the target of a `LoadChange`, so a study with a `load_step` keeps that load as a ZIP load, and the difference between how PowerFlows and PSID read its impedance part is handled there; the like-for-like `load_step` test decides the rule.
- The stream's column plan moves behind the engine (`tds_stream_plan`: names, keys, a per-step `collect`), and the worker only encodes and sends. Names are fixed when the run starts and a resumed stream keeps them. `dae_vars` keep their engine names in every mode.
- TENSA's `droop` and `ffr` controllers are ANDES-only until written for Sienna; capabilities say so.
- `step` maps to the output grid (`saveat`) and the largest step (`dtmax`); capabilities publish which solver goes with which model (`ResidualModel` with `IDA`, `MassMatrixModel` with a mass-matrix solver).
- PSID's own docs call the validation of its small-signal results work in progress; every cross-engine `eig` comparison shows that note.

Operations (Phase 7): an `op` block on generators (limits, ramps, up and down times, cost functions, initial state), a `series` block, a `reserves` block, an `optimization` block in results (variables, parameters, expressions, duals), the template recorded in the result, slack variables always read back and reported when non-zero, and comparison on the realised series only.

## 14. Build order

| Phase | Units (each: tests first, then implementation, then review) |
|---|---|
| 3. Seam | `engines/base.py` + registry; `engine` on session create and in the worker; `GET /engines`; `key` on topology and results for ANDES; problem document for unsupported ops; web: engine in the session store, capability-driven readiness |
| 4. Sienna, static | Julia environments and `warm-cache`; `TensaSienna` module: load, keys, topology, case document; power flow with result records; fidelity on load; message capture; UI opens a case under Sienna |
| 5. Sienna, dynamic | load model conversion; disturbances; `tds` with streaming and abort; quantities and frames; `eig` with participation; like-for-like audits of the 14 common models, each ending in `exact` or a known-difference entry |
| 6. Comparison | results document for both engines; `POST /compare`; `POST /studies`; UI overlay and difference table; cross-engine checks in the example references |
| 7. Sienna-only | `matrices`, `dcpflow`, then operations: case document fields for costs and time series, `opf`, `dispatch`, `uc`, `sim`; Sienna-native dynamic components (inverters, dynamic lines) through `ext.sienna` |
| 7A. ANDES gaps | the list in `reports/andes-gaps.md`, in its priority order |
| 8. Release | editing under Sienna through the case document; `sienna` install extra; CI job with Julia; docs, `llms.txt`, MCP tools; pull request |
