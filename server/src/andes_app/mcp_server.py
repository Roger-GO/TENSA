"""MCP (Model Context Protocol) server exposing ANDES App to LLM agents.

Wraps the HTTP API as MCP tools so agent runtimes (Claude Code, etc.) can drive
power-system simulations natively. Two modes:

- ``andes-app mcp --url http://127.0.0.1:8000`` — attach to a running server.
- ``andes-app mcp --workspace ~/andes-cases`` — spawn a private ``andes-app
  serve`` child on an ephemeral loopback port for the lifetime of the MCP
  process (the usual mode when an MCP client launches this as a stdio server).

Requires the optional ``mcp`` extra: ``pip install 'andes-app[mcp]'``.
"""

from __future__ import annotations

import atexit
import json
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Any

try:
    from mcp.server.fastmcp import FastMCP
except ImportError as exc:  # pragma: no cover - exercised only without the extra
    raise SystemExit(
        "The MCP server needs the optional 'mcp' dependency.\n"
        "Install it with: pip install 'andes-app[mcp]'"
    ) from exc

_BASE_URL = "http://127.0.0.1:8000"


def _api(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
    """Call the ANDES App HTTP API; raise a readable error on ProblemDetails."""
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
    "andes-app",
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
def run_pflow(session_id: str) -> Any:
    """Solve the power flow. Returns convergence flag and solution summary."""
    return _api("POST", f"/sessions/{session_id}/pflow", {})


@mcp.tool()
def run_tds(session_id: str, tf: float) -> Any:
    """Run a time-domain simulation from t=0 to t=tf seconds (batch; registered disturbances apply).

    Synchronous — returns when the simulation finishes (server caps wall time at 300 s).
    """
    return _api("POST", f"/sessions/{session_id}/tds", {"tf": tf})


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
    """Start a private `andes-app serve` child and wait until it answers."""
    port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, "-m", "andes_app", "serve",
         "--workspace", workspace, "--port", str(port), "--bind", "127.0.0.1"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    atexit.register(proc.terminate)
    base = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise SystemExit("andes-app serve child exited during startup")
        try:
            with urllib.request.urlopen(f"{base}/api/sessions", timeout=2):
                return base
        except (urllib.error.URLError, OSError):
            time.sleep(0.3)
    raise SystemExit("andes-app serve child did not become ready within 60 s")


def run(url: str | None, workspace: str | None) -> None:
    """Entry point used by the ``andes-app mcp`` CLI subcommand."""
    global _BASE_URL
    if workspace is not None:
        _BASE_URL = _spawn_server(workspace)
    elif url is not None:
        _BASE_URL = url.rstrip("/")
    mcp.run()  # stdio transport
