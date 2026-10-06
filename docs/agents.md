# Agents and MCP

TENSA is built so that an AI agent can do everything a person can. The whole application is an HTTP API, and an optional MCP server wraps the main workflow as tools that an assistant such as Claude can call directly.

## Ways to connect an agent

| You have | Use |
| --- | --- |
| An assistant that speaks the Model Context Protocol (Claude Code, Claude Desktop and others) | The [MCP server](#the-mcp-server): `tensa mcp` |
| An agent that calls HTTP | The [API](api.md). Give it [`llms.txt`](https://github.com/Roger-GO/TENSA/blob/main/llms.txt), a condensed API map written for language models: the endpoints, the order they are used in, the enums, and the mistakes worth avoiding |
| A script | The Python client, [`examples/tensa_client.py`](https://github.com/Roger-GO/TENSA/blob/main/examples/tensa_client.py), which uses only the standard library, or `curl` as in [`examples/walkthrough.sh`](https://github.com/Roger-GO/TENSA/blob/main/examples/walkthrough.sh) |

The full contract is the OpenAPI schema at `GET /openapi.json` on a running server, and the [route reference](reference/api.md) renders it.

## The MCP server

Install the extra and start it:

```bash
pip install "tensa[mcp]"
tensa mcp --workspace ~/tensa-cases
```

`tensa mcp` talks MCP over standard input and output, so you do not run it by hand: you tell your MCP client to launch it. It has two modes.

- **`--workspace DIR`** starts a private TENSA server on a free loopback port, serving that workspace, for as long as the MCP process lives. This is the usual setup when a client launches it.
- **`--url http://127.0.0.1:8000`** attaches to a server that is already running, for example one you also have open in the browser, so that you and the assistant share a workspace and can both see the cases.

Give exactly one of the two.

### Claude Code

```bash
claude mcp add tensa -- tensa mcp --workspace ~/tensa-cases
```

If `tensa` lives in a virtual environment that is not active when Claude Code starts, give the full path to the program, such as `/home/you/.venv/bin/tensa`.

### Claude Desktop and other clients

Add a server to the client's MCP configuration file (`claude_desktop_config.json` for Claude Desktop):

```json
{
  "mcpServers": {
    "tensa": {
      "command": "/home/you/.venv/bin/tensa",
      "args": ["mcp", "--workspace", "/home/you/tensa-cases"]
    }
  }
}
```

On Windows the command is the `tensa.exe` in the environment's `Scripts` folder, such as `C:\\Users\\you\\.venv\\Scripts\\tensa.exe` (backslashes are doubled in JSON). Restart the client after you change its configuration.

### The tools

| Tool | What it does |
| --- | --- |
| `list_workspace_files` | Lists the case files in the workspace |
| `create_session` | Creates a session, an isolated ANDES system, and returns its id |
| `close_session` | Closes a session and frees its worker process |
| `load_case` | Loads a case file by its path in the workspace, with optional additional files such as a `.dyr` |
| `reload_case` | Returns the case to its pre-setup state, which adding more disturbances after a run needs |
| `get_topology` | Lists the buses, lines, transformers, generators, loads, shunts and controllers |
| `add_fault` | Registers a three-phase bus fault between two times |
| `add_toggle` | Registers a connect or disconnect of a device at a time |
| `add_alter` | Registers a parameter change of a device at a time |
| `get_alterable_params` | Lists the parameters ANDES accepts for an alter on a model |
| `run_pflow` | Solves the power flow, with optional tolerance, iteration limit, flat start and Q-limit enforcement |
| `run_tds` | Runs a time-domain simulation, recording named ANDES variables and closing frequency loops on batteries if asked |
| `list_dae_variables` | Lists the ANDES variables a run can record |
| `list_tds_controllers` | Lists the controllers a run takes and the devices they can command |
| `get_response_metrics` | Runs a simulation and describes how each named variable responds: peak, nadir, settling time, overshoot, damping |
| `get_operating_point` | Reads bus voltages and angles, line flows, generator outputs and load consumption |
| `get_messages` | Reads what ANDES said while the commands ran: warnings and errors by default |
| `run_eig` | Runs the small-signal eigenvalue analysis, after a converged power flow |

### How an assistant uses them

The server tells the client the usual order itself:

1. `list_workspace_files`, then `create_session`, then `load_case`.
2. Optionally `add_fault`, `add_toggle` or `add_alter`. These work only before the first run.
3. `run_pflow`, then `run_tds`, then `get_operating_point`.
4. `close_session` when done.

After the first run the session is committed, so `reload_case` comes before any further disturbance. A run that converged can still carry a warning, so after an odd result an assistant should call `get_messages`. The private server that `--workspace` starts keeps the default limit of four sessions, so close the ones you no longer need.

A prompt only needs to name the case and the question, for example: "Load `ieee14_full.xlsx`, put a three-phase fault on bus 7 from 1 s to 1.1 s, run 5 seconds, and tell me the lowest generator speed and when it happens."

## Writing your own agent against the API

[`llms.txt`](https://github.com/Roger-GO/TENSA/blob/main/llms.txt) has the complete list. The points that most often decide whether a call works:

- Send `Content-Type: application/json` with every JSON body, or the answer is a 422.
- Case paths are relative to the workspace, and an absolute path is refused.
- Follow `recovery` in an error document. It says in a machine-readable form what to do: reload the case, run a power flow first, retry.
- Prefer the batch `POST .../tds` to the WebSocket stream unless you need the data while the run goes. It returns everything in one response.
- A converged run can carry warnings. `GET .../messages?level=warning` shows them.
- Disturbances and element edits are refused once a run has committed the case. Reload first.

## What an agent can do to your machine

The server has no authentication and trusts whoever can reach it. A case file can hold Python expressions that ANDES evaluates when it reads the file, so an agent that can load a case, or add a file to the workspace and load it, can run code as the user who started the server. Keep the server on loopback, give the agent a workspace that holds only what it needs, and read [Concepts](concepts.md#trust-model).
