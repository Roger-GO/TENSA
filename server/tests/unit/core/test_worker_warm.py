"""A worker imports ANDES while it is idle, so the first case load does not.

The first ``load_case`` in a fresh worker took about 1.0 s on IEEE 14 against 0.2 s
once ANDES, its model modules and pandas were imported. ``worker_main`` now does
the imports before it reads its first command, unless a command is already
waiting (then the command pulls in what it needs itself and nothing is delayed).
"""

from __future__ import annotations

import importlib
import json
import logging
import subprocess
import sys
import textwrap
import threading
from typing import Any

import pytest

from tensa.core import worker

pytestmark = pytest.mark.unit


# ---- what the warm-up imports -----------------------------------------------


def test_warming_imports_the_modules_a_case_load_needs() -> None:
    """In a fresh interpreter, where nothing has imported ANDES yet."""
    script = textwrap.dedent(
        """
        import json, sys
        from tensa.core import worker

        cold = {name: name in sys.modules for name in ("andes", "pandas")}
        worker._warm_andes()

        from andes.models import file_classes
        from andes.routines import all_routines

        print(json.dumps({
            "cold": cold,
            "models": all(f"andes.models.{f}" in sys.modules for f, _ in file_classes),
            "routines": all(f"andes.routines.{f}" in sys.modules for f in all_routines),
            "libraries": [m in sys.modules for m in ("pandas", "scipy.sparse.linalg", "openpyxl")],
            "pycode": "pycode" in sys.modules,
        }))
        """
    )
    done = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    assert done.returncode == 0, done.stderr
    seen = json.loads(done.stdout.strip().splitlines()[-1])
    # Importing the worker module alone must not import ANDES, or the check below
    # would pass without the warm-up doing anything.
    assert seen["cold"] == {"andes": False, "pandas": False}
    assert seen["models"] is True
    assert seen["routines"] is True
    assert seen["libraries"] == [True, True, True]
    # ANDES reloads its generated code for every System, so importing it is wasted.
    assert seen["pycode"] is False


def test_a_failed_warm_up_is_logged_and_does_not_raise(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    real_import = importlib.import_module

    def broken(name: str, package: str | None = None) -> Any:
        if name.startswith("andes.models."):
            raise ImportError("a model module is broken")
        return real_import(name, package)

    monkeypatch.setattr(importlib, "import_module", broken)
    with caplog.at_level(logging.WARNING, logger="tensa.worker"):
        worker._warm_andes()
    assert "a model module is broken" in caplog.text
    assert "the first case load will import it" in caplog.text


def test_a_missing_optional_library_is_skipped_quietly(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    real_import = importlib.import_module

    def without_openpyxl(name: str, package: str | None = None) -> Any:
        if name == "openpyxl":
            raise ModuleNotFoundError("No module named 'openpyxl'")
        return real_import(name, package)

    monkeypatch.setattr(importlib, "import_module", without_openpyxl)
    with caplog.at_level(logging.WARNING, logger="tensa.worker"):
        worker._warm_andes()
    assert caplog.records == []


# ---- when worker_main warms up ----------------------------------------------


class _FakeConnection:
    """The control pipe: ``poll`` says whether a command is waiting, ``recv``
    hands out the next one. Everything either does goes into ``events``."""

    def __init__(
        self,
        events: list[str],
        commands: list[dict[str, Any]],
        *,
        waiting: bool = False,
        poll_error: type[Exception] | None = None,
    ) -> None:
        self._events = events
        self._commands = commands
        self._waiting = waiting
        self._poll_error = poll_error

    def poll(self, timeout: float = 0.0) -> bool:
        self._events.append("poll")
        if self._poll_error is not None:
            raise self._poll_error
        return self._waiting

    def recv(self) -> dict[str, Any]:
        self._events.append("recv")
        if not self._commands:
            raise EOFError
        return self._commands.pop(0)

    def send(self, message: dict[str, Any]) -> None:
        self._events.append(f"send:{message.get('type')}")


@pytest.fixture
def events(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Run ``worker_main`` in this process without its process-wide side effects
    (the SIGINT handler, the parent-death signal, the macOS orphan thread, the
    audit hook), and record when the warm-up runs and when the hook would go in."""
    recorded: list[str] = []
    monkeypatch.setattr(worker, "_ignore_sigint", lambda: None)
    monkeypatch.setattr(worker, "_set_parent_death_signal", lambda: None)
    monkeypatch.setattr(worker, "_spawn_orphan_detector", lambda: None)
    monkeypatch.setattr(worker, "_warm_andes", lambda: recorded.append("warm"))
    # The real hook does nothing without a workspace, and ``_run`` passes none, so
    # only a recorder can tell where in the start-up it is installed.
    monkeypatch.setattr(
        worker, "_install_strict_fs_audit_hook", lambda _workspace: recorded.append("hook")
    )
    return recorded


def _run(ctrl: _FakeConnection, data: _FakeConnection) -> int:
    return worker.worker_main(ctrl, data, threading.Event())  # type: ignore[arg-type]


def test_the_worker_warms_up_before_it_reads_its_first_command(events: list[str]) -> None:
    shutdown = {"op": "shutdown", "seq": 1}
    ctrl = _FakeConnection(events, [shutdown], waiting=False)
    assert _run(ctrl, _FakeConnection(events, [])) == 0
    assert events.index("warm") < events.index("recv")
    # It looked for a waiting command first, then warmed up, installed the audit
    # hook, then served.
    assert events[:4] == ["poll", "warm", "hook", "recv"]


def test_the_worker_warms_up_before_the_audit_hook_is_installed(events: list[str]) -> None:
    """The hook would log the library files the warm-up reads (the system's
    ``mime.types``, say) as strays, so the imports have to come first."""
    ctrl = _FakeConnection(events, [{"op": "shutdown", "seq": 1}], waiting=False)
    assert _run(ctrl, _FakeConnection(events, [])) == 0
    assert events.index("warm") < events.index("hook")


def test_a_command_that_is_already_waiting_is_not_delayed_by_the_warm_up(
    events: list[str],
) -> None:
    commands = [{"op": "list_disturbances", "seq": 1}, {"op": "shutdown", "seq": 2}]
    ctrl = _FakeConnection(events, commands, waiting=True)
    assert _run(ctrl, _FakeConnection(events, [])) == 0
    assert "warm" not in events
    # The command was still served.
    assert events.count("send:result") == 2


@pytest.mark.parametrize("error", [EOFError, OSError])
def test_a_control_pipe_that_cannot_be_polled_skips_the_warm_up(
    events: list[str], error: type[Exception]
) -> None:
    ctrl = _FakeConnection(events, [], poll_error=error)
    # ``recv`` then finds the pipe closed, and the worker exits cleanly.
    assert _run(ctrl, _FakeConnection(events, [])) == 0
    assert "warm" not in events
