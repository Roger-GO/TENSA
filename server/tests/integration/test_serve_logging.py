"""Real ``tensa serve --log-level debug --log-file ...`` subprocess: what the file holds.

The options were first tried by starting a server this way, making a few requests and
opening the file: it held the startup lines and nothing about the requests, and no
line was at ``DEBUG``, so there was no telling whether the level had taken effect.
"""

from __future__ import annotations

import json
import os
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

import tensa

pytestmark = pytest.mark.integration

_SERVING = re.compile(r"serving http://127\.0\.0\.1:(\d+)")


def _request(url: str) -> int:
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            response.read()
            return int(response.status)
    except urllib.error.HTTPError as exc:
        return exc.code


def _serve(tmp_path: Path, *options: str) -> tuple[subprocess.Popen[str], int, list[str]]:
    """Start ``tensa serve`` with ``options``, its home directory under ``tmp_path``,
    and wait until it prints its address and accepts connections."""
    home = tmp_path / "home"
    # The child imports the ``tensa`` this test imported, whatever the working
    # directory and a relative ``PYTHONPATH`` make of it.
    package_root = str(Path(tensa.__file__).resolve().parent.parent)
    path = os.pathsep.join(filter(None, [package_root, os.environ.get("PYTHONPATH")]))
    env = {**os.environ, "HOME": str(home), "USERPROFILE": str(home), "PYTHONPATH": path}
    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "tensa",
            "serve",
            "--workspace",
            str(tmp_path / "ws"),
            "--no-warm-cache",
            *options,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        cwd=str(tmp_path),
        env=env,
    )
    lines: queue.Queue[str] = queue.Queue()
    log: list[str] = []

    def _drain() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            log.append(line)
            lines.put(line)

    threading.Thread(target=_drain, daemon=True).start()
    port: int | None = None
    while port is None:
        try:
            line = lines.get(timeout=60)
        except queue.Empty:
            proc.kill()
            pytest.fail("server never printed its address.\n" + "".join(log))
        match = _SERVING.search(line)
        if match:
            port = int(match.group(1))
    for _ in range(200):
        try:
            _request(f"http://127.0.0.1:{port}/api/version")
            break
        except (urllib.error.URLError, ConnectionError):
            time.sleep(0.1)
    else:
        proc.kill()
        pytest.fail("server did not accept connections.\n" + "".join(log))
    return proc, port, log


def _stop(proc: subprocess.Popen[str]) -> None:
    proc.terminate()
    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def test_debug_log_file_holds_the_startup_the_requests_and_debug_lines(tmp_path: Path) -> None:
    # The level in capitals and the file as a bare name: the way a first try goes.
    proc, port, _ = _serve(tmp_path, "--log-level", "DEBUG", "--log-file", "tensa.log")
    base = f"http://127.0.0.1:{port}"
    try:
        assert _request(f"{base}/api/health") == 200
        assert _request(f"{base}/api/sessions") == 200
        assert _request(f"{base}/api/sessions/no-such-session") == 404
    finally:
        _stop(proc)

    text = (tmp_path / "home" / ".tensa" / "logs" / "tensa.log").read_text(encoding="utf-8")
    assert "[INFO] tensa.serve: writing the log to" in text
    assert f"[INFO] tensa.serve: serving http://127.0.0.1:{port}/" in text
    assert "[DEBUG] tensa.serve: debug logging is on" in text
    assert re.search(r"\[DEBUG\] tensa\.request: GET /api/health -> 200 \(\d+ ms\)", text)
    assert re.search(r"\[DEBUG\] tensa\.request: GET /api/sessions -> 200 \(\d+ ms\)", text)
    assert re.search(
        r"\[DEBUG\] tensa\.request: GET /api/sessions/no-such-session -> 404 \(\d+ ms\)", text
    )


def test_default_log_file_has_the_startup_and_no_request_lines(tmp_path: Path) -> None:
    """At ``info`` the UI's polling does not fill the file."""
    proc, port, _ = _serve(tmp_path, "--log-file", "tensa.log", "--log-json")
    try:
        assert _request(f"http://127.0.0.1:{port}/api/sessions") == 200
    finally:
        _stop(proc)

    path = tmp_path / "home" / ".tensa" / "logs" / "tensa.log"
    entries = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    assert {e["level"] for e in entries} == {"INFO"}
    assert not [e for e in entries if e["logger"] == "tensa.request"]
    assert any(e["message"].startswith("serving http://") for e in entries)
