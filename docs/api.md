# API guide

Everything the UI does goes through an HTTP and WebSocket API, so a script or an agent can do all of it. This page says how the routes fit together. The [route reference](reference/api.md) lists every route with its parameters and bodies, and the [models](reference/models.md) describe the JSON each one takes and returns.

The server also publishes the API itself: `GET /openapi.json` is the OpenAPI schema, `/docs` is an interactive Swagger UI, and `/redoc` is a reference page. [`llms.txt`](https://github.com/Roger-GO/TENSA/blob/main/llms.txt) is a condensed map written for language models, and the [`examples/`](https://github.com/Roger-GO/TENSA/tree/main/examples) folder has a curl walkthrough and a Python client.

## Basics

- **Base URL.** Every route is under `/api`: `http://127.0.0.1:8000/api/...` for a server started with `--port 8000`.
- **JSON bodies need a content type.** A request with a JSON body must send `Content-Type: application/json`. The `json=` argument of `httpx` and `requests` does, but `curl -d` and the `data=` argument of `requests` do not, and without the header the body is not read and the route answers 422.
- **No authentication.** The server trusts the local user and accepts only requests that name its own address in the `Host` and `Origin` headers. See [Concepts](concepts.md#trust-model).
- **Case paths are relative to the workspace.** `"ieee14_full.xlsx"` names a file in the directory given to `--workspace`. An absolute path, or one with `..`, is refused with a 400. Put a file there with `POST /api/workspace/files?name=<file>`, whose body is the file's bytes (not a multipart form, which answers 415).
- **Identifiers are strings.** A bus, line or generator is named by the `idx` ANDES gives it, as in `"7"` or `"Line_6"`. A reference from one device to another (`bus`, `gen`, `syn`) can be sent as `"5"` or `5`.
- **Health check.** `GET /api/health` needs no session and answers `{"status": "ok", ...}` with the TENSA and ANDES versions, the open sessions against the `--max-sessions` limit, and whether the code ANDES generates is ready. It never waits for a worker, so it answers while a run holds every session: it is the call for a script that waits for the server to come up, a process supervisor or a container health check.

## The workflow

The order matters, because of the [rule about when a case can be changed](concepts.md#setup-and-the-reload-rule).

1. `POST /api/sessions` creates a session and answers with its `session_id`.
2. `POST /api/sessions/{id}/case` loads a case: `{"primary_path": "ieee14_full.xlsx"}`, with an optional `"addfiles": ["ieee14.dyr"]` for the dynamic data of a `.raw` case. The answer is the topology: buses, lines, transformers, generators, loads, shunts and controllers.
3. While the case is `pre-setup`, change it: `POST /api/sessions/{id}/disturbances` adds faults, toggles and alters, `POST /api/sessions/{id}/elements` adds an element, `PUT` and `DELETE` on `/api/sessions/{id}/elements/{model}/{idx}` edit and delete one, and `POST /api/sessions/{id}/undo-last-edit` takes the last edit back.
4. `POST /api/sessions/{id}/pflow` solves the power flow and `POST /api/sessions/{id}/tds` runs a time-domain simulation. The first of either commits the case.
5. `GET /api/sessions/{id}/operating-point` reads the result: bus voltages and angles, line flows, generator outputs and load consumption. After a time-domain run it is the final state of the run.
6. `POST /api/sessions/{id}/reload` reads the case from its file again and returns it to `pre-setup`, so that more can be added. The disturbances and the edits made before the reload are gone, and a script adds the ones it still wants again.
7. `DELETE /api/sessions/{id}` closes the session.

A disturbance has a `kind` that picks its fields:

```json
{"kind": "fault", "bus_idx": "7", "tf": 1.0, "tc": 1.1, "xf": 0.05, "rf": 0}
{"kind": "toggle", "model": "Line", "dev_idx": "Line_6", "t": 1.0}
{"kind": "alter", "model": "PQ", "dev_idx": "PQ_1", "src": "p0", "t": 1.0, "method": "*", "amount": 1.2}
```

The first is a three-phase fault at bus 7 from 1.0 s to 1.1 s. The second trips a line at 1.0 s. The third raises the active power of a load by 20 percent at 1.0 s: `method` is one of `+`, `-`, `*`, `/` or `=`, and `GET /api/sessions/{id}/topology/models/{model}/alterable_params` lists the `src` names a model accepts.

### Power flow

The body of `POST .../pflow` is optional, and each setting in it applies to that run only: `tolerance`, `max_iterations`, `flat_start` and `enforce_q_limits`. A setting left out keeps the case's own. The result has `converged`, `iterations`, the voltages and angles, the flow at both ends of every line with its loss and loading, each generator's reactive limits, a `summary` of generation, load, shunts, losses and the slack output, and the `settings` the run used. A power flow that does not converge answers 200 with `converged: false`: retry with a higher `max_iterations`, `flat_start` set to true, or a looser `tolerance`.

### Time-domain simulation

`POST .../tds` takes `tf`, the final time in seconds, and optionally `h` (the step of the trapezoidal integrator), `integrator` (`trapezoidal` or `qndf`), `dae_vars`, `controllers` and `tds_config_overrides`. It runs the whole simulation and answers when it is done. A batch run is capped at 300 seconds of wall time.

`dae_vars` names ANDES variables to record, written as ANDES writes them (`omega GENROU 1`, `vf GENROU 2`). Their values at every step come back under `traces`. `GET .../dae-variables` lists the names a case offers, and takes `q`, `kind` and `model` to narrow the list. `controllers` closes a frequency loop on a battery or another distributed generation device: parameters of a `droop` or an `ffr`, never code. `GET .../tds/controllers` lists the devices a controller can command.

Two routes work on what a run produced and hold no session. `POST /api/response-metrics` takes series (name, `t`, `y`) and answers with each one's nadir, rate of change, settling time, overshoot and damping, and `POST /api/comtrade` writes them as an IEEE C37.111 COMTRADE record in a `.zip`. Feed either the `traces` of a batch run as they are.

### Other analyses

| Route | What it does |
| --- | --- |
| `POST .../eig` | Eigenvalue analysis. Needs a converged power flow, and leaves the case needing a reload before a power flow runs again |
| `POST .../cpf`, `POST .../cpf/qv` | Continuation power flow: the nose curve and the QV curve of a bus |
| `POST .../se/measurements/generate`, `POST .../se` | State estimation from generated measurements |
| `POST .../sweep` | A parameter sweep over disturbance or simulation values, one time-domain run per value |
| `POST .../snapshot`, `POST .../snapshot/restore` | Save and restore a snapshot |
| `POST .../bundle/export`, `POST .../bundle/import` | A reproducibility bundle as a `.zip` |
| `GET .../report` | The text of an ANDES report |
| `GET .../jobs`, `DELETE .../jobs/{job_id}` | List the session's jobs, cancel one |
| `GET .../messages` | What ANDES logged while commands ran |

## Errors

Every error the server raises itself is an RFC 7807 problem document:

```json
{
  "type": "about:blank",
  "title": "Not Found",
  "status": 404,
  "detail": "session 'nope' is not active",
  "instance": null,
  "recovery": null
}
```

`recovery`, when it is set, says what to do about it in a form a program can follow: `{"kind": "reload-case", "label": "..."}`. The kinds are `load-case`, `reload-case`, `run-pflow`, `retry`, `add-measurements`, `wait-for-job`, `wait-for-sweep` and `none`. The usual statuses are:

| Status | Meaning |
| --- | --- |
| 400 | A path outside the workspace, an unsafe file name, or a bad `Host` or `Origin` header |
| 404 | The session or the thing asked for does not exist (a session that was closed or went idle is gone) |
| 409 | The call is out of order: no case loaded, or the case is `committed` and needs a reload first |
| 413, 415 | A body that is too large, or of the wrong media type |
| 422 | The request does not match its schema, or ANDES refused it. A JSON body sent without its content type is one |
| 429 | The session cap is reached. Close a session and try again |

A request that fails validation answers 422 with FastAPI's own `detail` list of the fields at fault.

## WebSockets

The WebSocket routes are not part of an OpenAPI schema, so this is where they are described. Each starts the same way: connect, the server sends `{"type": "ready"}`, and the client sends its first command frame. A close code of 4404 means the session is unknown, and 4500 means the worker failed (a JSON `{"type": "error", ...}` frame comes just before the close).

| Route | What it carries |
| --- | --- |
| `/api/ws/{session_id}` | A live time-domain run |
| `/api/ws/{session_id}/jobs/events` | A `snapshot` of the jobs, then a `job` frame for each change of state |
| `/api/ws/{session_id}/sweep/{sweep_id}` | Progress of a sweep, one frame per iteration |

### Streaming a time-domain run

Send `{"type": "start_tds", "tf": 5.0}`. It takes the same `h`, `dae_vars` and `controllers` as the batch route, and `vars` to choose the groups of variables streamed (`bus_v`, `gen_state`, `gen_power`, `line_flow`, `load_pq`). The server answers with:

1. A text frame `{"type": "stream_start", "run_id": "...", "metadata": {...}}`. `metadata.var_columns` names the columns once.
2. Binary frames, one Apache Arrow IPC stream each. A frame has a `t` column and a `v` list column that holds the row's values in the order of `var_columns`.
3. A text frame `{"type": "done", "converged": true, "final_t": 5.0, ...}`.

```python
import asyncio
import json

import pyarrow as pa
import websockets  # pip install websockets pyarrow


async def stream(session_id: str) -> None:
    async with websockets.connect(f"ws://127.0.0.1:8000/api/ws/{session_id}") as ws:
        assert json.loads(await ws.recv())["type"] == "ready"
        await ws.send(json.dumps({"type": "start_tds", "tf": 5.0}))
        async for message in ws:
            if isinstance(message, bytes):
                table = pa.ipc.open_stream(message).read_all()
                print(table.column("t")[0].as_py(), table.column("v")[0].as_py()[:3])
            elif json.loads(message)["type"] in ("done", "resync", "error"):
                break
```

The run never waits for a client. A client that falls too far behind, or that comes back after the server's buffer of about 30 seconds of frames has moved on, receives `{"type": "resync", "cause": "client_lagged" | "buffer_evicted", ...}` and the socket closes: fetch the result again with the batch route. A client that lost its connection can resume with `{"type": "resume", "run_id": "...", "last_seq": N}` while its frames are still buffered.

Prefer the batch route unless you need the data while the run goes: it returns the complete result in one response and needs no Arrow decoding.
