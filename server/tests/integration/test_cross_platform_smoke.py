"""Cross-platform smoke test: the shortest real path through the whole stack.

Starts an actual ``tensa serve`` process, lets it spawn an actual worker, loads
IEEE 14, runs a power flow and a short time-domain simulation over HTTP, runs a
sensitivity sweep on sub-workers, then closes the session. CI runs it
(``pytest -m smoke``) on Linux, macOS and Windows alongside the unit tests; the
full integration suite only runs on Linux. Everything that differs between
operating systems sits on this path: the CLI entry point and socket bind, worker
and sub-worker process creation and shutdown, ANDES code generation on first use,
and the numerical stack under ANDES.

The assertions are deliberately few and loose. They say "the pipeline works
here", not "the numbers match to the last digit"; numerical behaviour is
covered by the rest of the suite.
"""

from __future__ import annotations

import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import httpx
import pytest
from websockets.sync.client import connect

pytestmark = [pytest.mark.integration, pytest.mark.smoke]

# Our own startup line, printed once the socket is bound.
_SERVING = re.compile(r"serving http://127\.0\.0\.1:(\d+)")

# A cold ANDES code-generation pass (no ``~/.andes/pycode`` yet) takes a minute
# or two on a CI runner, and it happens inside the first PF or TDS request.
_STARTUP_TIMEOUT_S = 120.0
_REQUEST_TIMEOUT_S = 600.0


@contextmanager
def _running_server(workspace: Path, cwd: Path, *serve_args: str) -> Iterator[str]:
    """Run ``python -m tensa serve`` on an OS-assigned port; yield its base URL.

    ``serve_args`` are further options for ``tensa serve``.
    """
    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "tensa",
            "serve",
            "--bind",
            "127.0.0.1",
            "--workspace",
            str(workspace),
            *serve_args,
        ],
        # The server logs to stderr. Windows would otherwise decode the pipe
        # with the ANSI code page.
        env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        encoding="utf-8",
        errors="replace",
        cwd=str(cwd),
    )
    lines: queue.Queue[str] = queue.Queue()
    log: list[str] = []

    def _drain() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:  # keeps the pipe from filling; ends at EOF
            log.append(line)
            lines.put(line)

    threading.Thread(target=_drain, daemon=True).start()

    try:
        port: int | None = None
        deadline = time.monotonic() + _STARTUP_TIMEOUT_S
        while port is None:
            try:
                line = lines.get(timeout=max(0.1, deadline - time.monotonic()))
            except queue.Empty:
                pytest.fail("server never printed its address.\n" + "".join(log))
            match = _SERVING.search(line)
            if match:
                port = int(match.group(1))
        base = f"http://127.0.0.1:{port}"

        # The address is printed just before uvicorn starts listening.
        while True:
            try:
                httpx.get(f"{base}/api/sessions", timeout=5.0).raise_for_status()
                break
            except httpx.TransportError:
                if time.monotonic() > deadline or proc.poll() is not None:
                    pytest.fail("server did not accept connections.\n" + "".join(log))
                time.sleep(0.1)
        try:
            yield base
        except BaseException:
            sys.stderr.write("--- tensa serve log ---\n" + "".join(log))
            raise
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


def _ieee14_files() -> tuple[Path, Path]:
    import andes

    cases = Path(andes.__file__).parent / "cases" / "ieee14"
    return cases / "ieee14.raw", cases / "ieee14.dyr"


def _sweep_rows(base: str, sid: str, sweep_id: str) -> list[dict[str, Any]]:
    """The rows of a finished sweep, as its WebSocket replays them."""
    url = base.replace("http://", "ws://", 1) + f"/api/ws/{sid}/sweep/{sweep_id}"
    rows: list[dict[str, Any]] = []
    with connect(url, open_timeout=30) as ws:
        while True:
            event = json.loads(ws.recv(timeout=30))
            assert event["type"] != "error", event
            if event["type"] == "iteration":
                rows.append(event["result"])
            elif event["type"] == "finished":
                assert event["state"] == "completed", event
                return rows


def test_serve_load_pflow_tds(tmp_path: Path) -> None:
    pytest.importorskip("andes")
    workspace = tmp_path / "ws"
    workspace.mkdir()
    for src in _ieee14_files():
        shutil.copy2(src, workspace / src.name)

    with (
        # Two sweep workers whatever the CPU count: the default is one on a
        # one-CPU machine, which would run the sweep below on the session's worker.
        _running_server(workspace, tmp_path, "--sweep-workers", "2") as base,
        httpx.Client(base_url=f"{base}/api", timeout=_REQUEST_TIMEOUT_S) as client,
    ):
        resp = client.post("/sessions")
        assert resp.status_code == 201, resp.text
        sid = resp.json()["session_id"]

        # The worker subprocess loads the case.
        resp = client.post(
            f"/sessions/{sid}/case",
            json={"primary_path": "ieee14.raw", "addfiles": ["ieee14.dyr"]},
        )
        assert resp.status_code == 200, resp.text
        assert len(resp.json()["buses"]) == 14

        # A three-phase fault at bus 4, cleared 100 ms later. Disturbances go
        # in before ANDES setup, which the power flow below performs.
        resp = client.post(
            f"/sessions/{sid}/disturbances",
            json={"disturbances": [{"kind": "fault", "bus_idx": 4, "tf": 0.1, "tc": 0.2}]},
        )
        assert resp.status_code in (200, 201), resp.text

        resp = client.post(f"/sessions/{sid}/pflow", json={})
        assert resp.status_code == 200, resp.text
        pflow = resp.json()
        assert pflow["converged"] is True
        assert len(pflow["bus_voltages"]) == 14
        assert all(0.9 < v < 1.15 for v in pflow["bus_voltages"].values())

        resp = client.post(f"/sessions/{sid}/tds", json={"tf": 0.5, "h": 0.01})
        assert resp.status_code == 200, resp.text
        tds = resp.json()
        assert tds["converged"] is True
        assert tds["final_t"] == pytest.approx(0.5, abs=0.02)
        assert tds["callpert_count"] > 0

        # A sweep of four values runs on two sub-workers the server spawns, so this
        # is where their start, their pipes and their shutdown meet each operating
        # system. The server falls back to the session's own worker when it cannot
        # start them and records a worker's failure as an error row, so a sweep that
        # ends "done" proves neither. Every row must be clean, and the session's own
        # System untouched: a sweep run on its worker ends on the last value.
        resp = client.post(f"/sessions/{sid}/snapshot", json={"name": "smoke"})
        assert resp.status_code == 200, resp.text
        resp = client.post(
            f"/sessions/{sid}/sweep",
            json={
                "parameter": {
                    "kind": "disturbance.fault.tc",
                    "target": 0,
                    "range": {"start": 0.15, "end": 0.25, "steps": 4},
                },
                "sim": {"tf": 0.3, "h": 0.02, "vars": None},
                "snapshot_name": "smoke",
            },
        )
        assert resp.status_code == 202, resp.text
        assert resp.json()["total"] == 4
        sweep_id = resp.json()["sweep_id"]
        job_url = f"/sessions/{sid}/jobs/{resp.json()['job_id']}"
        deadline = time.monotonic() + _REQUEST_TIMEOUT_S
        while (record := client.get(job_url).json())["status"] in {"pending", "running"}:
            assert time.monotonic() < deadline, f"the sweep never finished: {record}"
            time.sleep(0.25)
        assert record["status"] == "done", record
        rows = _sweep_rows(base, sid, sweep_id)
        assert [row["iteration"] for row in rows] == [0, 1, 2, 3]
        assert rows[-1]["parameter_value"] == pytest.approx(0.25)
        assert [row["error"] for row in rows] == [None] * 4, rows
        assert all(row["converged"] for row in rows), rows
        resp = client.get(f"/sessions/{sid}/disturbances")
        assert resp.status_code == 200, resp.text
        assert [d["tc"] for d in resp.json()["disturbances"]] == [0.2]
        assert client.get(f"/sessions/{sid}/topology").status_code == 200

        # Closing the session stops the worker.
        assert client.delete(f"/sessions/{sid}").status_code == 204
