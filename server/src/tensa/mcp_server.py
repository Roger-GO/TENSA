"""MCP (Model Context Protocol) server exposing TENSA to LLM agents.

Wraps the HTTP API as MCP tools so agent runtimes (Claude Code, etc.) can drive
power-system simulations natively. Two modes:

- ``tensa mcp --url http://127.0.0.1:8000`` — attach to a running server.
- ``tensa mcp --workspace ~/tensa-cases`` — spawn a private ``tensa
  serve`` child on an ephemeral loopback port for the lifetime of the MCP
  process (the usual mode when an MCP client launches this as a stdio server).

Requires the optional ``mcp`` extra: ``pip install 'tensa[mcp]'``. It runs on
version 2 of the ``mcp`` SDK and on 1.x (see :func:`_new_server`).
"""

from __future__ import annotations

import atexit
import http.client
import json
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import TYPE_CHECKING, Any

from tensa import __version__

if TYPE_CHECKING:
    from mcp.server.mcpserver import MCPServer

_BASE_URL = "http://127.0.0.1:8000"


def _api(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
    """Call the TENSA HTTP API; raise a readable error on ProblemDetails, and when the
    server does not answer."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{_BASE_URL}/api{path}",
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=330) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        try:
            problem = json.loads(e.read())
        except Exception:
            problem = {"title": e.reason}
        recovery = (problem.get("recovery") or {}).get("kind")
        hint = f" Recovery: {recovery}." if recovery else ""
        raise _ToolError(
            f"{problem.get('title', 'API error')} ({e.code}): {problem.get('detail', '')}{hint}"
        ) from None
    except OSError as e:
        # Refused, reset, or no answer within the timeout.
        raise _ToolError(
            f"TENSA at {_BASE_URL} did not answer: {getattr(e, 'reason', e)}"
        ) from None
    except http.client.HTTPException as e:
        # An answer cut short (``IncompleteRead``), or one that is not HTTP.
        raise _ToolError(f"TENSA at {_BASE_URL} did not answer in full: {e!r}") from None
    try:
        return json.loads(raw) if raw else {"status": "ok"}
    except ValueError:
        raise _ToolError(
            f"TENSA at {_BASE_URL} answered {method} /api{path} with a body that is not JSON"
        ) from None


_INSTRUCTIONS = (
    "Tools for the TENSA power-system simulators (ANDES and Sienna). Typical flow: "
    "list_workspace_files (list_examples and add_example put a ready-made case "
    "in the workspace first) -> create_session -> load_case -> "
    "add_fault/add_toggle/add_alter (optional, pre-setup only) -> run_pflow "
    "-> run_tds -> get_operating_point -> close_session. After the first "
    "run the session is 'setup'; call reload_case before adding more "
    "disturbances or elements. A session has one engine, chosen at "
    "create_session (default andes); list_engines says what each engine can "
    "do, and each tool's description says which engines have it. An op an "
    "engine lacks answers with the engines that have it."
)


def _new_server() -> tuple[MCPServer, type[Exception]]:
    """The MCP server named ``tensa``, and the exception a tool raises for the agent to
    read, on whichever major of the ``mcp`` SDK is installed.

    2.x calls the class ``MCPServer`` and takes the server's version. It shows the agent
    the text of its ``ToolError`` only; any other exception is answered with the tool's
    name alone. 1.x, which upstream still patches and another tool in the same
    environment may hold, calls it ``FastMCP`` and takes no version, and the server under
    it then answers a client's handshake with the version of the library, which a client
    shows as TENSA's. A module the SDK needs and cannot find is named as itself, not
    reported as a missing extra.
    """
    try:
        from mcp.server.mcpserver import MCPServer
        from mcp.server.mcpserver.exceptions import ToolError
    except ModuleNotFoundError as missing:
        if missing.name in {"mcp", "mcp.server"}:
            raise SystemExit(
                "The MCP server needs the optional 'mcp' dependency.\n"
                "Install it with: pip install 'tensa[mcp]'"
            ) from missing
        if missing.name != "mcp.server.mcpserver":
            raise
    else:
        return MCPServer("tensa", instructions=_INSTRUCTIONS, version=__version__), ToolError
    # mypy reads 2.x, whose ``mcp.server.fastmcp`` only raises an error naming the new class.
    from mcp.server.fastmcp import FastMCP  # type: ignore[attr-defined, unused-ignore]
    from mcp.server.fastmcp.exceptions import ToolError as FastMCPToolError

    server = FastMCP("tensa", instructions=_INSTRUCTIONS)
    server._mcp_server.version = __version__
    return server, FastMCPToolError


mcp, _ToolError = _new_server()


@mcp.tool()
def list_workspace_files() -> Any:
    """List case files (xlsx/raw/dyr/json/m) available in the server workspace."""
    return _api("GET", "/workspace/files")


# What ``list_examples`` shows of each case; the rest (citations, licence terms, the checks)
# comes with ``list_examples(example_id=...)``.
_EXAMPLE_BRIEF = (
    "id", "title", "summary", "category", "size", "analyses", "default", "in_workspace",
    "differs", "available",
)


@mcp.tool()
def list_examples(example_id: str | None = None) -> Any:
    """List the example cases TENSA can add to the workspace with add_example.

    Each has an id, a title, what it is for, its size, the analyses it supports (pf power
    flow, tds time domain, eig eigenvalues), whether it is already in the workspace (and,
    for a bundled case, whether that file differs from the one TENSA ships: add_example
    with overwrite puts the shipped one in its place) and where its file comes from. With example_id, returns that one case in full: its
    citations (give them when the case is used in a result), licence, changes made to the
    data, caveats, and how its results were checked.
    """
    entries = _api("GET", "/examples")["examples"]
    if example_id is not None:
        for entry in entries:
            if entry["id"] == example_id:
                return entry
        known = ", ".join(entry["id"] for entry in entries)
        raise _ToolError(f"no example case {example_id!r}; the cases are: {known}")
    return [
        {
            **{key: entry[key] for key in _EXAMPLE_BRIEF},
            "source": entry["provenance"]["kind"],
            "licence": entry["licence"]["name"],
        }
        for entry in entries
    ]


@mcp.tool()
def add_example(example_id: str, overwrite: bool = False) -> Any:
    """Copy an example case into the workspace, then load it with load_case.

    Returns the files written (the case file first, as 'primary') and any warnings. A file
    that is already in the workspace is left alone and the call fails unless overwrite is
    true. The case's source, citations and licence are recorded in EXAMPLE-SOURCES.md in
    the workspace.
    """
    quoted = urllib.parse.quote(example_id, safe="")
    return _api("POST", f"/examples/{quoted}/add?overwrite={'true' if overwrite else 'false'}")


@mcp.tool()
def create_session(engine: str | None = None) -> Any:
    """Create a simulation session (an isolated engine worker). Returns session_id.

    engine is 'andes' (the default when it is left out) or 'sienna';
    list_engines says what each can do and whether it is available on this
    server. A session keeps its engine for its whole life. An op the
    session's engine lacks is refused with 409, and the message names the
    engines that have it. Engines: andes, sienna.
    """
    if engine is None:
        return _api("POST", "/sessions")
    return _api("POST", "/sessions", {"engine": engine})


@mcp.tool()
def close_session(session_id: str) -> Any:
    """Close a session and free its worker process. Engines: andes, sienna."""
    return _api("DELETE", f"/sessions/{session_id}")


@mcp.tool()
def load_case(
    session_id: str,
    primary_path: str,
    addfiles: list[str] | None = None,
    on_unsupported: str | None = None,
) -> Any:
    """Load a case file (path relative to the server workspace; e.g. 'ieee14_full.xlsx').

    Optional addfiles attach dynamic data (e.g. a .dyr next to a .raw).
    Returns the topology summary (buses, lines, generators, ...).
    A Sienna session reads .raw (+ one .dyr) and .m; a .dyr with records
    PowerSystems does not support is refused 422 unless on_unsupported is
    'drop', which loads without them (an ANDES session ignores it).
    Engines: andes, sienna.
    """
    body: dict[str, Any] = {"primary_path": primary_path}
    if addfiles:
        body["addfiles"] = addfiles
    if on_unsupported is not None:
        body["on_unsupported"] = on_unsupported
    return _api("POST", f"/sessions/{session_id}/case", body)


@mcp.tool()
def reload_case(session_id: str) -> Any:
    """Read the case file again (required under ANDES before adding more disturbances after a run).

    Under ANDES the session's element edits are dropped; under Sienna they are
    applied again, since a Sienna session is always the case file with its
    edits. Pending disturbances are dropped under both. Engines: andes, sienna.
    """
    return _api("POST", f"/sessions/{session_id}/reload", {})


@mcp.tool()
def get_topology(session_id: str) -> Any:
    """Get the current system topology: buses, lines, transformers, generators, loads, shunts, controllers. Engines: andes, sienna."""
    return _api("GET", f"/sessions/{session_id}/topology")


@mcp.tool()
def add_fault(
    session_id: str, bus_idx: str, tf: float, tc: float, xf: float = 0.05, rf: float = 0.0
) -> Any:
    """Register a three-phase bus fault applied from t=tf to t=tc seconds (pre-setup only).

    xf/rf are the fault reactance/resistance in pu.
    Under Sienna a Fault on a bus and a Toggle on a Line or a generator; anything else is 422. Engines: andes, sienna.
    """
    spec = {"kind": "fault", "bus_idx": bus_idx, "tf": tf, "tc": tc, "xf": xf, "rf": rf}
    return _api("POST", f"/sessions/{session_id}/disturbances", {"disturbances": [spec]})


@mcp.tool()
def add_toggle(session_id: str, model: str, dev_idx: str, t: float) -> Any:
    """Register a connect/disconnect event for a device (e.g. model='Line', dev_idx='Line_6') at time t (pre-setup only).

    Under Sienna a Fault on a bus and a Toggle on a Line or a generator; anything else is 422. Engines: andes, sienna.
    """
    spec = {"kind": "toggle", "model": model, "dev_idx": dev_idx, "t": t}
    return _api("POST", f"/sessions/{session_id}/disturbances", {"disturbances": [spec]})


@mcp.tool()
def add_alter(
    session_id: str, model: str, dev_idx: str, src: str, t: float, method: str, amount: float
) -> Any:
    """Register a parameter change at time t (pre-setup only).

    method is one of '+', '-', '*', '/', '=' (e.g. model='PQ', dev_idx='PQ_1',
    src='p0', method='*', amount=1.2 raises that load 20% at t). Use
    get_alterable_params to discover valid src names for a model. Engines: andes.
    """
    spec = {
        "kind": "alter", "model": model, "dev_idx": dev_idx,
        "src": src, "t": t, "method": method, "amount": amount,
    }
    return _api("POST", f"/sessions/{session_id}/disturbances", {"disturbances": [spec]})


@mcp.tool()
def get_alterable_params(session_id: str, model: str) -> Any:
    """List parameter names ANDES accepts for Alter disturbances on a model (e.g. 'PQ'). Engines: andes."""
    return _api("GET", f"/sessions/{session_id}/topology/models/{model}/alterable_params")


@mcp.tool()
def run_pflow(
    session_id: str,
    tolerance: float | None = None,
    max_iterations: int | None = None,
    flat_start: bool | None = None,
    enforce_q_limits: bool | None = None,
    method: str | None = None,
) -> Any:
    """Solve the power flow. Returns convergence flag and solution summary.

    Every setting is optional and applies to this run only. tolerance is the
    mismatch in pu below which the solver stops (1e-12 to 1e-2, default 1e-6);
    max_iterations is the iteration limit (1 to 1000, default 25); flat_start
    starts every bus from 1 pu at angle 0; enforce_q_limits holds a generator
    at its qmin or qmax when its reactive power goes past one. If the solution
    does not converge, retry with a higher max_iterations, flat_start, or a
    looser tolerance. A converged result has a summary of generation, load,
    losses and slack output.
    method is the solver: an ANDES session takes NR (the default), dishonest
    or NK; a Sienna session takes ac (the default), or dc and ptdf-dc for a
    DC power flow, whose reactive power fields are null. Under Sienna the AC
    power flow takes tolerance and max_iterations only, and a DC one neither;
    the others are refused 422. Engines: andes, sienna.
    """
    body = {
        key: value
        for key, value in (
            ("tolerance", tolerance),
            ("max_iterations", max_iterations),
            ("flat_start", flat_start),
            ("enforce_q_limits", enforce_q_limits),
            ("method", method),
        )
        if value is not None
    }
    return _api("POST", f"/sessions/{session_id}/pflow", body)


@mcp.tool()
def run_tds(
    session_id: str,
    tf: float,
    dae_vars: list[str] | None = None,
    controllers: list[dict[str, Any]] | None = None,
    load_model: str | None = None,
) -> Any:
    """Run a time-domain simulation from t=0 to t=tf seconds (batch; registered disturbances apply).

    Synchronous — returns when the simulation finishes (server caps wall time at 300 s).
    dae_vars names ANDES variables to record, as list_dae_variables gives them
    ('omega GENROU 1'); their values at every step come back under "traces".
    controllers closes frequency loops on batteries and other distributed
    generation devices (list_tds_controllers names them). Each is an object:
    {"type": "droop", "model": "ESD1", "idx": 1, "gain": MW per Hz, "deadband": Hz,
    "p_max": MW} or {"type": "ffr", "model": "ESD1", "idx": 1, "power": MW,
    "trigger_deviation": Hz, "trigger_rocof": Hz/s, "hold": s}, both with optional
    "frequency" ("coi" or "bus"), "period" (s between samples, 0.1 by default),
    "t_start" (s) and "ramp" (MW/s). What each did, with its samples (t,
    frequency, command, output, soc), comes back under "controllers". A later
    run with the same controllers and a larger tf keeps their state (an ffr
    that has fired does not fire again); after a reload or a restored snapshot
    they start afresh.
    load_model ('impedance', 'power' or 'as-case') says how the loads behave
    in the run; a Sienna session takes all three (default impedance), an
    ANDES session impedance only. Under Sienna dae_vars and controllers are
    422, and traces are named quantity|key. Engines: andes, sienna.
    """
    body: dict[str, Any] = {"tf": tf}
    if dae_vars:
        body["dae_vars"] = dae_vars
    if controllers:
        body["controllers"] = controllers
    if load_model is not None:
        body["load_model"] = load_model
    return _api("POST", f"/sessions/{session_id}/tds", body)


@mcp.tool()
def list_tds_controllers(session_id: str) -> Any:
    """List the controllers run_tds takes and the devices of the loaded case they can command.

    "types" are the kinds ('droop', 'ffr'); "targets" are the batteries and other
    distributed generation devices (ESD1, PVD1, EV1, EV2), each with its own power
    limit in MW ("p_limit") and the ANDES variables that show a controller at work
    on it ("variables": pass them as dae_vars). "coi_available" says whether the
    case has the synchronous machines the default frequency reading needs.
    Needs no run, and does not close the case to disturbances. Engines: andes.
    """
    return _api("GET", f"/sessions/{session_id}/tds/controllers")


@mcp.tool()
def list_dae_variables(
    session_id: str,
    q: str | None = None,
    kind: str | None = None,
    model: str | None = None,
    limit: int = 100,
) -> Any:
    """List the ANDES variables of the loaded case that run_tds can record.

    Names read '<variable> <Model> <idx>' ('omega GENROU 1', 'vf GENROU 2'); pass
    them as dae_vars. q is words that must all appear in the name, whatever
    their case; kind is 'x' (state) or 'y' (algebraic); model narrows to one
    ANDES model ('GENROU'). Needs no run, and does not close the case to
    disturbances. Engines: andes.
    """
    params = {
        key: value
        for key, value in (("q", q), ("kind", kind), ("model", model), ("limit", limit))
        if value is not None
    }
    query = urllib.parse.urlencode(params)
    return _api("GET", f"/sessions/{session_id}/dae-variables?{query}")


@mcp.tool()
def get_response_metrics(
    session_id: str,
    tf: float,
    dae_vars: list[str],
    t_start: float | None = None,
    t_end: float | None = None,
) -> Any:
    """Run a time-domain simulation and describe how each named ANDES variable responds.

    Per variable: initial and final value, peak and nadir (with times), the
    steepest rate of change over 0.5 s, settling time (2 % band), overshoot and
    the damping ratio and frequency of its oscillation. t_start / t_end narrow
    the window the metrics are read over (a fault applied at t=1 s: t_start=1).
    The values are in ANDES's units (per unit for speed and voltage). The
    traces themselves are not returned; use run_tds for them. Takes 1 to 64
    variables. A run with more samples than the metrics take is read at every
    second or third sample, and the answer says so ("every_nth_sample"). Engines: andes.
    """
    # What POST /response-metrics takes in one request. Read here and not at the
    # top of the module: this is a client of the HTTP API, and the module that
    # holds the limits brings the server with it (the wrapper, numpy, pyarrow).
    from tensa.api.schemas import MAX_METRIC_SAMPLES, MAX_METRIC_SERIES

    # What the metrics would refuse is refused here, before the run is made for it.
    named = len(dict.fromkeys(dae_vars))
    if named == 0:
        raise _ToolError(
            "dae_vars names no variable: give at least one ANDES variable to describe "
            "(list_dae_variables lists them)."
        )
    if named > MAX_METRIC_SERIES:
        raise _ToolError(
            f"dae_vars names {named} variables; the metrics describe at most "
            f"{MAX_METRIC_SERIES} in one call."
        )
    run = _api("POST", f"/sessions/{session_id}/tds", {"tf": tf, "dae_vars": dae_vars})
    traces = run.get("traces")
    if not traces or not traces.get("variables"):
        return {
            "converged": run.get("converged"),
            "final_t": run.get("final_t"),
            "error": "The run recorded none of the variables, so there is no response to describe.",
        }
    # One series may hold ``MAX_METRIC_SAMPLES`` samples, and a long run of one
    # or two variables records more: thin it rather than lose the run to a 422.
    samples = len(traces["t"])
    every = 1 if samples <= MAX_METRIC_SAMPLES else -(-samples // (MAX_METRIC_SAMPLES - 1))
    kept = _thinned(samples, every)
    t = [traces["t"][i] for i in kept]
    body: dict[str, Any] = {
        "series": [
            {"name": v["name"], "t": t, "y": [v["values"][i] for i in kept]}
            for v in traces["variables"]
        ]
    }
    for key, value in (("t_start", t_start), ("t_end", t_end)):
        if value is not None:
            body[key] = value
    metrics = _api("POST", "/response-metrics", body)
    answer = {
        "converged": run["converged"],
        "final_t": run["final_t"],
        "truncated": traces["truncated"],
        "metrics": metrics["results"],
    }
    if every > 1:
        answer["every_nth_sample"] = every
    return answer


def _thinned(samples: int, every: int) -> range | list[int]:
    """The samples to keep of ``samples`` when only every ``every``-th is: the
    first, each ``every``-th after it, and the last, which is where the run ended."""
    if every <= 1:
        return range(samples)
    kept = list(range(0, samples, every))
    if kept[-1] != samples - 1:
        kept.append(samples - 1)
    return kept


@mcp.tool()
def get_operating_point(session_id: str) -> Any:
    """Read the current operating point: bus voltages/angles, line flows, generator outputs, load consumption.

    After a TDS this reflects the final simulated state. Engines: andes, sienna.
    """
    return _api("GET", f"/sessions/{session_id}/operating-point")


@mcp.tool()
def get_messages(session_id: str, level: str = "warning", after: int = 0) -> Any:
    """Read what ANDES said while this session's commands ran.

    A run that converged can still carry a warning (a device whose
    initialisation failed, a limit that was not adjusted), and a run that did
    not converge says why. level is the lowest to return: 'warning' (the default)
    gives warnings and errors, 'info' adds how each run went, 'error' only
    errors. Each message has its level, the command that was running (source),
    the ANDES logger and the text. A message ANDES repeated is listed once, with
    its repeat count; if the count grew after you read it, it comes back under a
    new number with the larger count. Pass next_after back as after to read only
    what came since. Needs no run and does not wait for one in progress. Engines: andes, sienna.
    """
    query = urllib.parse.urlencode({"level": level, "after": after})
    return _api("GET", f"/sessions/{session_id}/messages?{query}")


@mcp.tool()
def run_eig(session_id: str) -> Any:
    """Run small-signal eigenvalue analysis (requires a converged power flow). Engines: andes, sienna."""
    return _api("POST", f"/sessions/{session_id}/eig", {})


@mcp.tool()
def list_engines() -> Any:
    """List the engines this server can start a session for, with what each can do.

    Each entry has name, available (with unavailable_reason when false),
    versions, the formats it reads and writes, its routines with their
    options, its ops, and whether it edits. Needs no session.
    """
    return _api("GET", "/engines")


@mcp.tool()
def get_keys(session_id: str) -> Any:
    """List every element's key in the loaded case, each with bucket, model, idx and source, plus any problems.

    A key names an element the same way in every engine (bus:7,
    branch:7-8-1, gen:1-1, gen:1-1/exciter); use it to match elements
    across engines and to read neutral results. Empty lists when no case
    is loaded. Engines: andes, sienna.
    """
    return _api("GET", f"/sessions/{session_id}/keys")


@mcp.tool()
def network_matrix(session_id: str, kind: str = "ptdf") -> Any:
    """Read a network matrix PowerNetworkMatrices builds from the loaded case (Sienna only).

    kind is ptdf (the default), lodf, ybus or incidence. The answer is per
    unit on the case's base_mva: rows and cols name each axis (an arc
    {from, to, keys} or a bus {bus, key}), values holds a dense matrix row
    by row, entries the nonzeros of a ybus. An ANDES session has no such
    route; its ybus is part of get_topology's sibling routes and this tool
    answers 409 naming sienna. Engines: sienna.
    """
    query = urllib.parse.urlencode({"kind": kind})
    return _api("GET", f"/sessions/{session_id}/network-matrix?{query}")


@mcp.tool()
def run_dispatch(
    session_id: str,
    network_model: str = "copper_plate",
    duals: bool = False,
) -> Any:
    """Run the one-period economic dispatch of the loaded case (Sienna only).

    network_model is copper_plate (the default), dc, ptdf or ac (the full
    AC equations, solved with Ipopt). The answer holds objective_per_h (the
    solver's objective in $/h) and objective_check_per_h (recomputed from
    the dispatch and the file's gencost; the route's description says how
    the two relate), generators keyed by neutral key
    (gen:<bus>-<id>) each with p_mw, bus, id and idx, slacks (every slack
    variable past 1e-6 MW), and duals only when duals is true. The case
    needs generator cost data: a PSS/E .raw carries none (422); a MATPOWER
    .m case does. Engines: sienna.
    """
    body: dict[str, Any] = {"network_model": network_model}
    if duals:
        body["duals"] = True
    return _api("POST", f"/sessions/{session_id}/dispatch", body)


@mcp.tool()
def convert_result(
    kind: str,
    engine: str,
    result: dict[str, Any],
    versions: dict[str, str] | None = None,
    study: dict[str, Any] | None = None,
    keys: list[dict[str, Any]] | None = None,
    status: str = "completed",
) -> Any:
    """Turn one engine result into a neutral results document (tensa_results: 1). Needs no session.

    kind is pflow, tds or eig. result is the engine's own result as its
    API answered it: for pflow the POST /pflow response, for tds the
    "traces" object of a batch run ({t, variables, truncated}), for eig
    the POST /eig response. engine is the engine that produced it. For an
    ANDES tds result, keys is the session's keys lookup as get_keys lists
    it (a Sienna result names its columns neutrally already). The answer
    holds "document" (the neutral document), "skipped" (each column left
    out and why) and "notes". Feed "document" to compare_results.
    """
    body: dict[str, Any] = {"kind": kind, "engine": engine, "result": result, "status": status}
    if versions is not None:
        body["versions"] = versions
    if study is not None:
        body["study"] = study
    if keys is not None:
        body["keys"] = keys
    return _api("POST", "/results/convert", body)


@mcp.tool()
def compare_results(
    reference: dict[str, Any],
    comparison: dict[str, Any],
    tolerances: dict[str, Any] | None = None,
) -> Any:
    """Compare two neutral results documents (as convert_result answers them). Needs no session.

    reference is the document the comparison is read against; differences
    are comparison minus reference, and radian differences are wrapped to
    [-pi, pi). The answer compares the power flow first (rows per key,
    "operating_point_differs" when a row is outside its tolerance), then
    per series the largest and time-weighted RMS difference over the
    overlap of the time ranges with the swing of the reference, then the
    eigenvalues matched as modes. Unmatched keys and modes are listed,
    never ignored; "not_comparable" holds the pairs that cannot be
    compared with the reason. tolerances overrides the defaults per
    quantity plus frequency_hz, damping_ratio and max_mode_distance.
    """
    body: dict[str, Any] = {"reference": reference, "comparison": comparison}
    if tolerances is not None:
        body["tolerances"] = tolerances
    return _api("POST", "/compare", body)


@mcp.tool()
def add_element(session_id: str, model: str, params: dict[str, Any]) -> Any:
    """Add an element to the loaded case (pre-setup only).

    model is a TENSA kind (Bus, Line, PQ, PV, Slack, Shunt, GENROU, ...);
    params are its parameters (a reference to another device, "bus", "gen",
    "syn", may be sent as "5" or 5). Under Sienna the subset is: a PQ or a
    Shunt on a bus. The answer names the element created (model and idx)
    and the job that added it; read the topology for the case after it. Engines:
    andes, sienna.
    """
    return _api("POST", f"/sessions/{session_id}/elements", {"model": model, "params": params})


@mcp.tool()
def edit_element(session_id: str, model: str, idx: str, params: dict[str, Any]) -> Any:
    """Edit parameters of one element (pre-setup only): params maps each name to its new value.

    Under Sienna the editable set is: a load (PQ: p0, q0, u), a generator
    (PV or Slack: p0, v0, u), a line or transformer (Line: u) and a shunt
    (Shunt: g, b, u), one param per edit. Engines: andes, sienna.
    """
    quoted_model = urllib.parse.quote(model, safe="")
    quoted_idx = urllib.parse.quote(idx, safe="")
    return _api(
        "PUT",
        f"/sessions/{session_id}/elements/{quoted_model}/{quoted_idx}",
        {"params": params},
    )


@mcp.tool()
def delete_element(session_id: str, model: str, idx: str, cascade: bool = False) -> Any:
    """Delete an element (pre-setup only).

    422 with "dependents" and "disturbances" when other elements name it
    or disturbances act on it: delete those first, or send cascade=true to
    delete them with it. Under Sienna only a load or a shunt can be
    deleted and cascade is refused. The answer is the topology plus
    "deleted" and "disturbances", what went. Engines: andes, sienna.
    """
    quoted_model = urllib.parse.quote(model, safe="")
    quoted_idx = urllib.parse.quote(idx, safe="")
    query = urllib.parse.urlencode({"cascade": "true" if cascade else "false"})
    return _api("DELETE", f"/sessions/{session_id}/elements/{quoted_model}/{quoted_idx}?{query}")


@mcp.tool()
def undo_last_edit(session_id: str) -> Any:
    """Take back the last add, edit or delete. The topology's "undo" names the edit it acts on, null when there is none. Engines: andes, sienna."""
    return _api("POST", f"/sessions/{session_id}/undo-last-edit", {})


@mcp.tool()
def redo_edit(session_id: str) -> Any:
    """Put back the edit undo_last_edit took back. A delete put back is refused with 422 and the list if anything else has come to depend on the element. Engines: andes, sienna."""
    return _api("POST", f"/sessions/{session_id}/redo-edit", {})


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _spawn_server(workspace: str) -> str:
    """Start a private `tensa serve` child and wait until it answers."""
    port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, "-m", "tensa", "serve",
         "--workspace", workspace, "--port", str(port), "--bind", "127.0.0.1"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    atexit.register(proc.terminate)
    base = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise SystemExit("tensa serve child exited during startup")
        try:
            with urllib.request.urlopen(f"{base}/api/sessions", timeout=2):
                return base
        except (urllib.error.URLError, OSError):
            time.sleep(0.3)
    raise SystemExit("tensa serve child did not become ready within 60 s")


def run(url: str | None, workspace: str | None) -> None:
    """Entry point used by the ``tensa mcp`` CLI subcommand."""
    global _BASE_URL
    if workspace is not None:
        _BASE_URL = _spawn_server(workspace)
    elif url is not None:
        _BASE_URL = url.rstrip("/")
    mcp.run()  # stdio transport
