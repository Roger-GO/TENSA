"""Phase A R3 acceptance: spawn ``andes-app serve`` in a subprocess and
run the curl-only walkthrough script against it.

This is the load-bearing acceptance test for Phase A. It proves the
substrate is independently usable from a curl client (no UI, no in-process
SDK) end-to-end against ANDES 2.0.0.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest


def _free_port() -> int:
    """Bind to an ephemeral port, close, return the number. Tiny race window
    where the port could be claimed by another process before the server
    binds — acceptable for CI; in practice the test orchestrator gives us
    the only contender."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _wait_for_server(port: int, timeout: float = 60.0) -> None:
    """Block until ``port`` accepts a TCP connection."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.2)
    raise RuntimeError(f"server did not bind on port {port} within {timeout}s")


def _ieee14_paths() -> tuple[Path, Path]:
    pytest.importorskip("andes")
    import andes

    cases = Path(andes.__file__).parent / "cases" / "ieee14"
    return cases / "ieee14.raw", cases / "ieee14.dyr"


@pytest.mark.acceptance
def test_curl_walkthrough_runs_green(tmp_path: Path) -> None:
    """The full Phase A R3 acceptance scenario:

    - Spawn the substrate via ``python -m andes_app serve`` on an ephemeral
      port
    - Wait for the server to bind
    - Run ``walkthrough.sh`` with the port + workspace env vars set
    - Assert exit code 0; on failure surface stdout/stderr from both the
      walkthrough and the server"""
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    raw, dyr = _ieee14_paths()
    shutil.copy2(raw, workspace / "ieee14.raw")
    shutil.copy2(dyr, workspace / "ieee14.dyr")

    port = _free_port()

    server_env = {
        **os.environ,
        # Make sure ANDES doesn't drop output files into the cwd
        "PYTHONUNBUFFERED": "1",
    }
    server = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "andes_app",
            "serve",
            "--bind",
            "127.0.0.1",
            "--port",
            str(port),
            "--workspace",
            str(workspace),
        ],
        env=server_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(tmp_path),
    )

    server_stdout = ""
    server_stderr = ""
    try:
        try:
            _wait_for_server(port)
        except RuntimeError:
            # Capture whatever the server printed before failing
            server.terminate()
            server.wait(timeout=5)
            stdout_b, stderr_b = server.communicate()
            pytest.fail(
                "server did not start.\n"
                f"server stdout:\n{stdout_b.decode(errors='replace')}\n"
                f"server stderr:\n{stderr_b.decode(errors='replace')}"
            )

        script = Path(__file__).parent / "walkthrough.sh"
        result = subprocess.run(
            ["bash", str(script)],
            env={
                **os.environ,
                "ANDES_APP_PORT": str(port),
            },
            cwd=str(workspace),
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode != 0:
            pytest.fail(
                "walkthrough.sh failed.\n"
                f"exit code: {result.returncode}\n"
                f"stdout:\n{result.stdout}\n"
                f"stderr:\n{result.stderr}\n"
            )
    finally:
        server.terminate()
        try:
            stdout_b, stderr_b = server.communicate(timeout=5)
            server_stdout = stdout_b.decode(errors="replace")
            server_stderr = stderr_b.decode(errors="replace")
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()
        # Surface server logs only on test failure (pytest will display them)
        if False:  # pragma: no cover — debug toggle
            print(f"server stdout:\n{server_stdout}")
            print(f"server stderr:\n{server_stderr}")
