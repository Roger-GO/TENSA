"""Cross-platform smoke test: the shortest real path through the whole stack.

Starts an actual ``tensa serve`` process, lets it spawn an actual worker, loads
IEEE 14, runs a power flow and a short time-domain simulation over HTTP, then
closes the session. CI runs it (``pytest -m smoke``) on Linux, macOS and
Windows alongside the unit tests; the full integration suite only runs on
Linux. Everything that differs between operating systems sits on this path:
the CLI entry point and socket bind, worker process creation and shutdown,
ANDES code generation on first use, and the numerical stack under ANDES.

The assertions are deliberately few and loose. They say "the pipeline works
here", not "the numbers match to the last digit"; numerical behaviour is
covered by the rest of the suite.
"""

from __future__ import annotations

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

import httpx
import pytest

pytestmark = [pytest.mark.integration, pytest.mark.smoke]

# Our own startup line, printed once the socket is bound.
_SERVING = re.compile(r"serving http://127\.0\.0\.1:(\d+)")

# A cold ANDES code-generation pass (no ``~/.andes/pycode`` yet) takes a minute
# or two on a CI runner, and it happens inside the first PF or TDS request.
_STARTUP_TIMEOUT_S = 120.0
_REQUEST_TIMEOUT_S = 600.0


@contextmanager
def _running_server(workspace: Path, cwd: Path) -> Iterator[str]:
    """Run ``python -m tensa serve`` on an OS-assigned port; yield its base URL."""
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


def test_serve_load_pflow_tds(tmp_path: Path) -> None:
    pytest.importorskip("andes")
    workspace = tmp_path / "ws"
    workspace.mkdir()
    for src in _ieee14_files():
        shutil.copy2(src, workspace / src.name)

    with (
        _running_server(workspace, cwd=tmp_path) as base,
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

        # Closing the session stops the worker.
        assert client.delete(f"/sessions/{sid}").status_code == 204
