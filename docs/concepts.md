# Concepts

A few ideas explain most of how TENSA behaves: what a session is, where case files live, why a run locks the case, how runs are tracked, and whom the server trusts.

## Sessions

A **session** is one ANDES system in a process of its own. The server starts that process when a session is created and ends it when the session closes, so a simulation never blocks the server and a crash in one cannot take it down.

- The web UI opens a session when you open the page, and holds it while the tab is open. Every tab has its own session, with its own case and results. A reload of the page ends that session and starts a new one, and the page opens the case again in it, with the edits you made since you opened it. What a run had computed is not in the new session: the results the browser kept are in the run history.
- A script creates a session with `POST /api/sessions` and closes it with `DELETE /api/sessions/{id}`.
- The server keeps at most four sessions at once by default (`--max-sessions`). A fifth gets the status 429 until one closes.
- A session with no activity for 180 seconds is closed (`--idle-timeout-seconds`). A browser tab with the UI open checks in every 30 seconds, so its session lasts until the tab closes. Any request to a session counts as activity for a script.

## The workspace

The **workspace** is the directory the server reads case files from and writes saved ones to. It is `--workspace`, or `~/.tensa/cases` when that is left out, and the server creates it, with permissions that keep other users out, if it is missing. An empty workspace is filled with the three example cases the first time the server starts.

Case paths in the API are relative to the workspace. An absolute path or a `..` in one is refused with a 400.

TENSA reads these formats:

| Extension | What it holds |
| --- | --- |
| `.xlsx` | An ANDES case, static and dynamic data in one workbook |
| `.raw` | A PSS/E power flow case. A `.dyr` file next to it, loaded with it, adds the dynamic models |
| `.dyr` | PSS/E dynamic data, loaded together with a `.raw` |
| `.m` | A MATPOWER case |
| `.json` | An ANDES case in JSON |

A case with no dynamic models is `Static-only`. It can run a power flow, a continuation power flow and state estimation. A time-domain simulation or an eigenvalue analysis needs dynamic models, and has nothing to work on without them. The UI's case badge says which kind the loaded case is, and a `.raw` case gets its dynamic models from a `.dyr` file loaded with it.

Beside a case, the server keeps the layout of its diagram (`<case>.layout.json`) and, under `snapshots/`, the snapshots you save. The layout holds where everything on the diagram is placed, which generators have their control chain drawn out, and whether the connectors of devices are drawn straight or with a right angle. It is written when you move something and whenever the system is saved, and it goes where the system goes: a case saved under a new name gets a copy, a snapshot keeps the one it was saved with, and a bundle carries it as `layout.json`.

To add a case, use **Add files** in the UI, drop files on the window, copy them into the directory, or send them with `POST /api/workspace/files?name=<file>`.

## Setup and the reload rule

A case is in one of two states.

- **pre-setup**: ANDES has read the case but not yet built the system to solve. This is the state after a case loads. Here you can add and edit elements, add disturbances, and place PMUs.
- **committed**: the first power flow or time-domain run builds the system, and ANDES does not accept changes to it after that. Adding a disturbance or an element is refused, with the status 409 in the API and a locked table in the UI.

To go back to **pre-setup**, reload the case: **Reset run** in the UI, or `POST /api/sessions/{id}/reload` in the API. A reload reads the case from its file again, which discards the edits you made since opening it (save the system first to keep them). The disturbances in the UI's list are kept by the page, which applies them again the next time you run a time-domain simulation. That is why you can run a power flow, add a fault and run the simulation without resetting anything by hand. The server itself forgets them: after a reload through the API, a script adds its disturbances again.

An eigenvalue run changes the dynamic state in a way a later power flow cannot start from, so after one the case has to be reloaded before a power flow runs again. The UI says so beside the run button.

## Disturbances

A time-domain run applies disturbances. There are three kinds:

- a **fault**: a three-phase fault at a bus, from one time to another, with a reactance and a resistance;
- a **toggle**: a line or other device connects or disconnects at a time;
- an **alter**: a parameter of a device changes at a time, by a sum, difference, product, quotient or a new value.

A case file can carry its own, and the Disturbances list shows them marked as set by the case. A fault with a reactance below 0.01 per unit is nearly bolted. The form warns about it, because a fixed-step integration can diverge on one: raise the reactance, or choose the adaptive QNDF integrator in the TDS tab.

## Runs and jobs

Every analysis is a **job**: it has an identifier, a kind, a status (`pending`, `running`, `done`, `failed` or `cancelled`) and, while it runs, progress. The **Activity** tab lists the jobs of the page, and `GET /api/sessions/{id}/jobs` lists them for a script. A running job can be cancelled.

A time-domain run has two forms:

- **Batch**: `POST /api/sessions/{id}/tds` runs the whole simulation and answers with the result. It is simple, and it has a cap of 300 seconds of wall time.
- **Streaming**: a WebSocket carries the results as the run goes, in Apache Arrow frames, which is what the UI uses. The solver never waits for a client. One that falls too far behind is told to fetch the result again instead of getting a stream with frames missing. The [API guide](api.md#websockets) has the protocol.

The UI keeps its finished runs and the power flows it compares in the browser, so a reload does not lose them.

## Editing a case

There are two ways to change a case in the UI.

- **Before a run**, the element builder adds buses, lines, transformers, generators, exciters, governors, a battery, loads and shunts, and the inspector edits or deletes an element, including the ones the case file brought. **Undo** and **Redo** step back and forward through these edits, and **Save system as** writes the result to a file. The tables also edit values in place.
- **In Edit mode**, the parameters of the dynamic controllers can be changed on a copy of the case. Nothing touches the loaded system until you save the edits as a case, and **Discard all parameter edits** drops them.

## Trust model

TENSA is a local tool, and its security follows from that.

- **The local user is trusted.** A case file can hold Python expressions that ANDES evaluates when it reads the file, so loading a case is running code as you. Load only case files you trust. The same goes for the case files of a third party.
- **Other web pages are not trusted.** The server answers only requests whose `Host` and `Origin` headers name the address it serves (`127.0.0.1` and `localhost` on its port), so a page in another browser tab cannot drive it. Anything else gets a 400.
- **There is no authentication.** The server binds to `127.0.0.1` by default. Binding to another address with `--bind` opens the API to everyone who can reach it, including the ability to read and write the workspace and load case files, and the server warns at startup. Do that only on a network you trust, or put an authenticating proxy or a tunnel in front of it. [Troubleshooting](troubleshooting.md#reaching-the-server-from-another-machine) shows the flags.
- **Windows:** the workspace boundary is best-effort there. ANDES can read files outside the workspace, and the server logs a warning about it at startup.

The [security policy](https://github.com/Roger-GO/TENSA/blob/main/SECURITY.md) on GitHub has the full statement.
