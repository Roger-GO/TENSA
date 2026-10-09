"""Real ``tensa serve`` subprocess: it stops when it is asked to.

Everyone who tried the UI against a server they had started ended up sending it
SIGKILL: with a page open, SIGTERM and Ctrl+C left it at "Waiting for background
tasks to complete" for as long as the page's session lived. The page keeps a
WebSocket open for its session's job events, the handler that serves it waited on
a queue only the end of the session wakes, and uvicorn waits for every handler
before it runs the shutdown that ends the sessions.

Each test here opens what a page opens (a session with a case, its scratch
directory, the job-event socket), sends the signal, and holds the server to the
time it has, to its exit status, and to leaving neither a worker nor a scratch
directory behind.
"""

from __future__ import annotations

import json
import os
import queue
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
from websockets.sync.client import connect

import tensa
from tensa.core.session_dirs import SESSIONS_DIRNAME

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        sys.platform == "win32",
        reason="Windows has no SIGTERM or SIGINT to send to another process",
    ),
]

_SERVING = re.compile(r"serving http://127\.0\.0\.1:(\d+)")

# What a terminal and a service manager wait for before they give up on a server.
_STOP_WITHIN = 5.0
# With a run in flight: its worker is given two seconds to answer before it is
# terminated, and a machine busy with the rest of the suite is slow to reap it.
_STOP_WITHIN_BUSY = 8.0


@dataclass
class _Server:
    proc: subprocess.Popen[str]
    port: int
    workspace: Path
    log: list[str] = field(default_factory=list)

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}/api"

    def call(self, method: str, path: str, body: Any = None, timeout: float = 120) -> Any:
        request = urllib.request.Request(
            self.base + path,
            method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read() or b"null")

    def workers(self) -> list[int]:
        """The pids of the server's child processes (its workers, and the resource
        tracker ``multiprocessing`` starts beside them)."""
        listed = subprocess.run(
            ["pgrep", "-P", str(self.proc.pid)], capture_output=True, text=True, check=False
        )
        return [int(pid) for pid in listed.stdout.split()]

    def text(self) -> str:
        return "".join(self.log)


@contextmanager
def _serve(tmp_path: Path) -> Iterator[_Server]:
    """Start ``tensa serve`` on a free port with a seeded workspace, and wait until
    it answers. Whatever the test left of it is killed on the way out."""
    workspace = tmp_path / "ws"
    # The child imports the ``tensa`` this test imported, whatever the working
    # directory and a relative ``PYTHONPATH`` make of it.
    package_root = str(Path(tensa.__file__).resolve().parent.parent)
    path = os.pathsep.join(filter(None, [package_root, os.environ.get("PYTHONPATH")]))
    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "tensa",
            "serve",
            "--workspace",
            str(workspace),
            # The generated code is the one the rest of the suite uses.
            "--no-warm-cache",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        cwd=str(tmp_path),
        env={**os.environ, "PYTHONPATH": path},
    )
    server = _Server(proc=proc, port=0, workspace=workspace)
    lines: queue.Queue[str] = queue.Queue()

    def _drain() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:  # keeps the pipe from filling; ends at EOF
            server.log.append(line)
            lines.put(line)

    threading.Thread(target=_drain, daemon=True).start()
    workers: list[int] = []
    try:
        while server.port == 0:
            try:
                line = lines.get(timeout=60)
            except queue.Empty:
                pytest.fail("server never printed its address.\n" + server.text())
            match = _SERVING.search(line)
            if match:
                server.port = int(match.group(1))
        for _ in range(200):
            try:
                server.call("GET", "/sessions", timeout=10)
                break
            except (urllib.error.URLError, ConnectionError):
                time.sleep(0.1)
        else:
            pytest.fail("server did not accept connections.\n" + server.text())
        yield server
        workers = server.workers()
    finally:
        if proc.poll() is None:
            workers = workers or server.workers()
            proc.kill()
            proc.wait()
        # A worker ends itself when its server is gone; this is for one that did not.
        for pid in workers:
            if _alive(pid):
                os.kill(pid, signal.SIGKILL)


def _alive(pid: int) -> bool:
    """Whether ``pid`` is a process that still runs (a zombie does not)."""
    try:
        stat = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    except OSError:
        # No ``/proc`` (macOS): signal 0 says whether the pid is there.
        try:
            os.kill(pid, 0)
        except OSError:
            return False
        return True
    return stat.rpartition(")")[2].split()[0] != "Z"


@contextmanager
def _what_a_page_opens(server: _Server) -> Iterator[str]:
    """A session with a case, the scratch directory of its copy-on-write edits,
    and the job-event socket, which stays open for the block. Yields the session
    id."""
    sid = str(server.call("POST", "/sessions")["session_id"])
    server.call("POST", f"/sessions/{sid}/case", {"primary_path": "kundur_full.xlsx"})
    server.call("POST", f"/sessions/{sid}/case/clone")
    assert (server.workspace / SESSIONS_DIRNAME / sid).is_dir()
    with connect(f"ws://127.0.0.1:{server.port}/api/ws/{sid}/jobs/events") as events:
        assert json.loads(events.recv(timeout=30))["type"] == "ready"
        assert json.loads(events.recv(timeout=30))["type"] == "snapshot"
        yield sid


def _stop(server: _Server, sig: signal.Signals, within: float) -> tuple[int, float]:
    """Send ``sig`` and wait for the server to exit. Returns its exit status and
    how long it took; fails when it is still running after ``within`` seconds."""
    started = time.monotonic()
    server.proc.send_signal(sig)
    try:
        code = server.proc.wait(timeout=within)
    except subprocess.TimeoutExpired:
        pytest.fail(
            f"the server was still running {within:.0f} s after {sig.name}.\n" + server.text()
        )
    return code, time.monotonic() - started


def _assert_nothing_left(server: _Server, workers: list[int], sid: str) -> None:
    deadline = time.monotonic() + 5
    while any(_alive(pid) for pid in workers) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert [pid for pid in workers if _alive(pid)] == [], server.text()
    assert not (server.workspace / SESSIONS_DIRNAME / sid).exists()
    assert "Traceback" not in server.text(), server.text()


@pytest.mark.parametrize(
    ("sig", "status"),
    [
        # uvicorn shuts down and then lets the signal take its course: the process
        # dies of SIGTERM, which is what a shell and a service manager expect.
        (signal.SIGTERM, -signal.SIGTERM),
        # Ctrl+C unwinds as ``KeyboardInterrupt``, which ``serve`` ends on quietly.
        (signal.SIGINT, 0),
    ],
    ids=["SIGTERM", "SIGINT"],
)
def test_serve_stops_on_a_signal_with_a_page_open(
    tmp_path: Path, sig: signal.Signals, status: int
) -> None:
    with _serve(tmp_path) as server:
        with _what_a_page_opens(server) as sid:
            workers = server.workers()
            assert workers
            code, took = _stop(server, sig, _STOP_WITHIN)
        assert code == status, server.text()
        _assert_nothing_left(server, workers, sid)
        # It shut down; it was not cut off while it waited.
        assert "Application shutdown complete" in server.text()
        assert "timeout graceful shutdown exceeded" not in server.text()
        assert took < _STOP_WITHIN


def test_serve_stops_on_sigterm_with_a_run_in_flight(tmp_path: Path) -> None:
    """A request that waits for a worker in the middle of a long run does not hold
    the server up: the session is ended, its worker with it, and the request is
    answered as one to a session that is gone."""
    answers: list[int] = []
    with _serve(tmp_path) as server, _what_a_page_opens(server) as sid:
        workers = server.workers()

        def _long_run() -> None:
            try:
                server.call("POST", f"/sessions/{sid}/tds", {"tf": 5000.0}, timeout=60)
                answers.append(200)
            except urllib.error.HTTPError as exc:
                answers.append(exc.code)
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                answers.append(0)

        run = threading.Thread(target=_long_run, daemon=True)
        run.start()
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if server.call("GET", f"/sessions/{sid}/jobs?status=running"):
                break
            time.sleep(0.1)
        else:
            pytest.fail("the run never started.\n" + server.text())
        # Past its set-up and into the integration, where it answers nothing.
        time.sleep(1.0)
        code, _ = _stop(server, signal.SIGTERM, _STOP_WITHIN_BUSY)
        run.join(10)
        assert code == -signal.SIGTERM, server.text()
        _assert_nothing_left(server, workers, sid)
        # The run did not finish: the request was answered when its session ended.
        assert answers and answers[0] != 200, answers
        assert "[WARNING]" not in server.text(), server.text()


def test_serve_stops_on_sigterm_while_a_run_streams_to_the_page(tmp_path: Path) -> None:
    """The UI runs a time-domain simulation over a WebSocket. The handler of that
    socket waits for the next event of the run, and a run that the shutdown
    cancelled sent none: uvicorn waited its whole timeout for the handler and
    then cancelled it, with a traceback in the log."""
    with _serve(tmp_path) as server, _what_a_page_opens(server) as sid:
        workers = server.workers()
        with connect(f"ws://127.0.0.1:{server.port}/api/ws/{sid}", max_size=None) as run:
            assert json.loads(run.recv(timeout=30))["type"] == "ready"
            run.send(json.dumps({"type": "start_tds", "tf": 5000.0}))
            assert json.loads(run.recv(timeout=60))["type"] == "stream_start"
            # Frames are coming: the run is in its integration.
            for _ in range(20):
                run.recv(timeout=30)
            code, _ = _stop(server, signal.SIGTERM, _STOP_WITHIN_BUSY)
        assert code == -signal.SIGTERM, server.text()
        _assert_nothing_left(server, workers, sid)
        assert "timeout graceful shutdown exceeded" not in server.text(), server.text()
        assert "[ERROR]" not in server.text(), server.text()

