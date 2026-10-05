"""MCP (Model Context Protocol) server exposing TENSA to LLM agents.

Wraps the HTTP API as MCP tools so agent runtimes (Claude Code, etc.) can drive
power-system simulations natively. Two modes:

- ``tensa mcp --url http://127.0.0.1:8000`` — attach to a running server.
- ``tensa mcp --workspace ~/andes-cases`` — spawn a private ``tensa
  serve`` child on an ephemeral loopback port for the lifetime of the MCP
  process (the usual mode when an MCP client launches this as a stdio server).

Requires the optional ``mcp`` extra: ``pip install 'tensa[mcp]'``.
"""

from __future__ import annotations

import atexit
import json
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

try:
    from mcp.server.fastmcp import FastMCP
except ImportError as exc:  # pragma: no cover - exercised only without the extra
    raise SystemExit(
        "The MCP server needs the optional 'mcp' dependency.\n"
        "Install it with: pip install 'tensa[mcp]'"
    ) from exc

_BASE_URL = "http://127.0.0.1:8000"


def _api(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
    """Call the TENSA HTTP API; raise a readable error on ProblemDetails."""
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
            return json.loads(raw) if raw else {"status": "ok"}
    except urllib.error.HTTPError as e:
        try:
            problem = json.loads(e.read())
        except Exception:
            problem = {"title": e.reason}
        recovery = (problem.get("recovery") or {}).get("kind")
        hint = f" Recovery: {recovery}." if recovery else ""
        raise RuntimeError(
            f"{problem.get('title', 'API error')} ({e.code}): {problem.get('detail', '')}{hint}"
        ) from None


mcp = FastMCP(
    "tensa",
    instructions=(
        "Tools for the ANDES power-system simulator. Typical flow: "
        "list_workspace_files -> create_session -> load_case -> "
        "add_fault/add_toggle/add_alter (optional, pre-setup only) -> run_pflow "
        "-> run_tds -> get_operating_point -> close_session. After the first "
        "run the session is 'setup'; call reload_case before adding more "
        "disturbances or elements."
    ),
)


@mcp.tool()
def list_workspace_files() -> Any:
    """List case files (xlsx/raw/dyr/json/m) available in the server workspace."""
    return _api("GET", "/workspace/files")


@mcp.tool()
def create_session() -> Any:
    """Create a simulation session (an isolated ANDES System). Returns session_id."""
    return _api("POST", "/sessions")


@mcp.tool()
def close_session(session_id: str) -> Any:
    """Close a session and free its worker process."""
    return _api("DELETE", f"/sessions/{session_id}")


@mcp.tool()
def load_case(session_id: str, primary_path: str, addfiles: list[str] | None = None) -> Any:
    """Load a case file (path relative to the server workspace; e.g. 'ieee14_full.xlsx').

    Optional addfiles attach dynamic data (e.g. a .dyr next to a .raw).
    Returns the topology summary (buses, lines, generators, ...).
    """
    body: dict[str, Any] = {"primary_path": primary_path}
    if addfiles:
        body["addfiles"] = addfiles
    return _api("POST", f"/sessions/{session_id}/case", body)


@mcp.tool()
def reload_case(session_id: str) -> Any:
    """Reload the current case to pre-setup state (required before adding more disturbances after a run)."""
    return _api("POST", f"/sessions/{session_id}/reload", {})


@mcp.tool()
def get_topology(session_id: str) -> Any:
    """Get the current system topology: buses, lines, transformers, generators, loads, shunts, controllers."""
    return _api("GET", f"/sessions/{session_id}/topology")


@mcp.tool()
def add_fault(
    session_id: str, bus_idx: str, tf: float, tc: float, xf: float = 0.05, rf: float = 0.0
) -> Any:
    """Register a three-phase bus fault applied from t=tf to t=tc seconds (pre-setup only).

    xf/rf are the fault reactance/resistance in pu.
    """
    spec = {"kind": "fault", "bus_idx": bus_idx, "tf": tf, "tc": tc, "xf": xf, "rf": rf}
    return _api("POST", f"/sessions/{session_id}/disturbances", {"disturbances": [spec]})


@mcp.tool()
def add_toggle(session_id: str, model: str, dev_idx: str, t: float) -> Any:
    """Register a connect/disconnect event for a device (e.g. model='Line', dev_idx='Line_6') at time t (pre-setup only)."""
    spec = {"kind": "toggle", "model": model, "dev_idx": dev_idx, "t": t}
    return _api("POST", f"/sessions/{session_id}/disturbances", {"disturbances": [spec]})


@mcp.tool()
def add_alter(
    session_id: str, model: str, dev_idx: str, src: str, t: float, method: str, amount: float
) -> Any:
    """Register a parameter change at time t (pre-setup only).

    method is one of '+', '-', '*', '/', '=' (e.g. model='PQ', dev_idx='PQ_1',
    src='p0', method='*', amount=1.2 raises that load 20% at t). Use
    get_alterable_params to discover valid src names for a model.
    """
    spec = {
        "kind": "alter", "model": model, "dev_idx": dev_idx,
        "src": src, "t": t, "method": method, "amount": amount,
    }
    return _api("POST", f"/sessions/{session_id}/disturbances", {"disturbances": [spec]})


@mcp.tool()
def get_alterable_params(session_id: str, model: str) -> Any:
    """List parameter names ANDES accepts for Alter disturbances on a model (e.g. 'PQ')."""
    return _api("GET", f"/sessions/{session_id}/topology/models/{model}/alterable_params")


@mcp.tool()
def run_pflow(
    session_id: str,
    tolerance: float | None = None,
    max_iterations: int | None = None,
    flat_start: bool | None = None,
    enforce_q_limits: bool | None = None,
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
    """
    body = {
        key: value
        for key, value in (
            ("tolerance", tolerance),
            ("max_iterations", max_iterations),
            ("flat_start", flat_start),
            ("enforce_q_limits", enforce_q_limits),
        )
        if value is not None
    }
    return _api("POST", f"/sessions/{session_id}/pflow", body)


@mcp.tool()
def run_tds(session_id: str, tf: float, dae_vars: list[str] | None = None) -> Any:
    """Run a time-domain simulation from t=0 to t=tf seconds (batch; registered disturbances apply).

    Synchronous — returns when the simulation finishes (server caps wall time at 300 s).
    dae_vars names ANDES variables to record, as list_dae_variables gives them
    ('omega GENROU 1'); their values at every step come back under "traces".
    """
    body: dict[str, Any] = {"tf": tf}
    if dae_vars:
        body["dae_vars"] = dae_vars
    return _api("POST", f"/sessions/{session_id}/tds", body)


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
    disturbances.
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
    traces themselves are not returned; use run_tds for them.
    """
    run = _api("POST", f"/sessions/{session_id}/tds", {"tf": tf, "dae_vars": dae_vars})
    traces = run["traces"]
    body: dict[str, Any] = {
        "series": [
            {"name": v["name"], "t": traces["t"], "y": v["values"]} for v in traces["variables"]
        ]
    }
    for key, value in (("t_start", t_start), ("t_end", t_end)):
        if value is not None:
            body[key] = value
    metrics = _api("POST", "/response-metrics", body)
    return {
        "converged": run["converged"],
        "final_t": run["final_t"],
        "truncated": traces["truncated"],
        "metrics": metrics["results"],
    }


@mcp.tool()
def get_operating_point(session_id: str) -> Any:
    """Read the current operating point: bus voltages/angles, line flows, generator outputs, load consumption.

    After a TDS this reflects the final simulated state.
    """
    return _api("GET", f"/sessions/{session_id}/operating-point")


@mcp.tool()
def run_eig(session_id: str) -> Any:
    """Run small-signal eigenvalue analysis (requires a converged power flow)."""
    return _api("POST", f"/sessions/{session_id}/eig", {})


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
