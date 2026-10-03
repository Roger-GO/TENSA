"""Real ``tensa serve --port 0`` subprocess: the SPA's Origin is accepted.

With the default OS-assigned port the browser sends
``Origin: http://127.0.0.1:<real port>``. The server used to build its
Host/Origin allow-list from port 0 and answer that with ``400 bad-origin``.
This drives the actual CLI, parses the real port from the startup line, and
makes the request a browser tab on that port would.
"""

from __future__ import annotations

import queue
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

# Our own startup line, or uvicorn's when it prints the address itself.
_SERVING = re.compile(r"(?:serving|running on) http://127\.0\.0\.1:(\d+)")


def _get(url: str, origin: str | None) -> tuple[int, str]:
    request = urllib.request.Request(url)
    if origin is not None:
        request.add_header("Origin", origin)
    try:
        with urllib.request.urlopen(request, timeout=10) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode()


@pytest.mark.integration
def test_default_port_zero_accepts_the_real_origin(tmp_path: Path) -> None:
    workspace = tmp_path / "ws"
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
            # No ANDES here, so no need to check its generated code.
            "--no-warm-cache",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        cwd=str(tmp_path),
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
        while port is None:
            try:
                line = lines.get(timeout=60)
            except queue.Empty:
                pytest.fail("server never printed its address.\n" + "".join(log))
            match = _SERVING.search(line)
            if match:
                port = int(match.group(1))
        assert port > 0

        base = f"http://127.0.0.1:{port}"
        # Wait for uvicorn to accept connections (the URL is printed just
        # before it starts listening). ``/api/sessions`` needs no case.
        for _ in range(200):
            try:
                status, _ = _get(f"{base}/api/sessions", origin=None)
                break
            except (urllib.error.URLError, ConnectionError):
                time.sleep(0.1)
        else:
            pytest.fail("server did not accept connections.\n" + "".join(log))
        assert status == 200

        status, body = _get(f"{base}/api/sessions", origin=base)
        assert status == 200, body
        status, body = _get(
            f"{base}/api/sessions", origin=f"http://localhost:{port}"
        )
        assert status == 200, body
        # Cross-site and wrong-port origins remain rejected.
        status, body = _get(f"{base}/api/sessions", origin="http://evil.example")
        assert status == 400 and "bad-origin" in body
        status, body = _get(
            f"{base}/api/sessions", origin=f"http://127.0.0.1:{port + 1}"
        )
        assert status == 400 and "bad-origin" in body
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
