"""Unit tests for the Sienna warm-up: it runs at most once per worker, runs a
small case through load, topology and power flow on a throwaway state, never
fails the worker, and leaves an ANDES session untouched."""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Any

import pytest

from tensa.engines.sienna import runtime as sienna_runtime_module
from tensa.engines.sienna.state import SiennaState


class FakeBridge:
    """Records the calls the warm-up makes, in order."""

    def __init__(self, calls: list[str]) -> None:
        self.calls = calls
        self._started = False

    @property
    def started(self) -> bool:
        return self._started

    def start(self) -> None:
        self.calls.append("start")
        self._started = True

    def load_case(self, raw: Path, dyr: Any, scratch: Path, v_setpoints: Any, corrections: Any) -> Any:
        self.calls.append(f"load_case:{raw.name}")
        return {"case": raw.stem}

    def report(self, session: Any) -> dict[str, Any]:
        self.calls.append("report")
        return {"unsupported": [], "notes": []}

    def topology(self, session: Any) -> dict[str, Any]:
        self.calls.append("topology")
        return {"buses": [], "lines": [], "transformers": [], "generators": [], "loads": [], "shunts": []}

    def pflow(self, session: Any, tolerance: Any = None, max_iterations: Any = None) -> dict[str, Any]:
        self.calls.append("pflow")
        return {"converged": True, "notes": [], "buses": [], "branches": [], "injectors": []}

    def versions(self) -> dict[str, Any]:
        self.calls.append("versions")
        return {"julia": "1.13.4"}


@pytest.fixture
def kundur_present(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Point ``_andes_cases_dir`` at a folder holding a ``kundur/kundur.raw``."""
    cases = tmp_path / "cases"
    folder = cases / "kundur"
    folder.mkdir(parents=True)
    raw = folder / "kundur.raw"
    raw.write_bytes(b"fake raw")
    monkeypatch.setattr(
        "tensa.core.examples._andes_cases_dir", lambda: cases
    )
    return raw


def test_warm_up_loads_topologises_and_solves(
    monkeypatch: pytest.MonkeyPatch, kundur_present: Path
) -> None:
    calls: list[str] = []
    monkeypatch.setattr(
        sienna_runtime_module, "JuliaBridge", lambda: FakeBridge(calls)
    )
    sienna_runtime_module._warm_up()  # noqa: SLF001
    assert calls[0] == "start"
    assert "load_case:kundur.raw" in calls
    assert "topology" in calls
    assert "pflow" in calls
    # The order a user's first requests make: load, topology, power flow.
    assert calls.index("load_case:kundur.raw") < calls.index("topology") < calls.index("pflow")


def test_warm_up_says_nothing_of_its_case_to_the_user(
    monkeypatch: pytest.MonkeyPatch,
    kundur_present: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The notice logger is what the worker's capture hands to the first reply,
    so nothing the warm-up case logs there may reach it; and the logger is on
    again afterwards for the user's own case."""
    from tensa.core.messages import NOTICE_LOGGER

    calls: list[str] = []

    class NotingBridge(FakeBridge):
        def report(self, session: Any) -> dict[str, Any]:
            self.calls.append("report")
            return {
                "unsupported": [],
                "notes": [{"level": "warning", "text": "a note about the warm-up case"}],
            }

    monkeypatch.setattr(sienna_runtime_module, "JuliaBridge", lambda: NotingBridge(calls))
    with caplog.at_level(logging.DEBUG, logger=NOTICE_LOGGER):
        sienna_runtime_module._warm_up()  # noqa: SLF001
        assert "load_case:kundur.raw" in calls
        assert [r for r in caplog.records if r.name == NOTICE_LOGGER] == []
        assert logging.getLogger(NOTICE_LOGGER).disabled is False
        logging.getLogger(NOTICE_LOGGER).warning("the user's own case")
    assert [r.getMessage() for r in caplog.records if r.name == NOTICE_LOGGER] == [
        "the user's own case"
    ]


def test_the_warm_up_line_goes_to_the_logger_the_capture_hands_on() -> None:
    """The line that says Julia was warmed is written where the worker's capture
    listens, or it never reaches the session's messages."""
    import inspect

    from tensa.core import worker
    from tensa.core.messages import CAPTURED_LOGGERS, NOTICE_LOGGER

    assert NOTICE_LOGGER in CAPTURED_LOGGERS
    source = inspect.getsource(worker.worker_main)
    assert "The Sienna engine was started and warmed up in" in source
    assert "logging.getLogger(NOTICE_LOGGER).info(" in source
    assert 'logging.getLogger("tensa.worker").info(' not in source


def test_warm_up_without_the_case_only_starts_julia(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []
    monkeypatch.setattr(sienna_runtime_module, "JuliaBridge", lambda: FakeBridge(calls))
    monkeypatch.setattr("tensa.core.examples._andes_cases_dir", lambda: None)
    sienna_runtime_module._warm_up()  # noqa: SLF001
    assert calls == ["start"]


def test_warm_up_failure_is_swallowed(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    class Boom:
        def start(self) -> None:
            raise RuntimeError("boom")

    monkeypatch.setattr(sienna_runtime_module, "JuliaBridge", lambda: Boom())
    with caplog.at_level(logging.WARNING, logger="tensa.sienna"):
        sienna_runtime_module._warm_up()  # noqa: SLF001
    assert any(
        "could not warm Julia ahead of the first op" in r.getMessage()
        for r in caplog.records
    )


def test_warmup_failure_after_start_is_swallowed(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    kundur_present: Path,
) -> None:
    calls: list[str] = []

    class BadPflow(FakeBridge):
        def pflow(self, session: Any, tolerance: Any = None, max_iterations: Any = None) -> dict[str, Any]:
            raise RuntimeError("no solve")

    monkeypatch.setattr(sienna_runtime_module, "JuliaBridge", lambda: BadPflow(calls))
    with caplog.at_level(logging.WARNING, logger="tensa.sienna"):
        sienna_runtime_module._warm_up()  # noqa: SLF001
    assert calls[0] == "start"
    assert any(
        "could not warm Julia ahead of the first op" in r.getMessage()
        for r in caplog.records
    )


def test_warm_up_releases_the_session(
    monkeypatch: pytest.MonkeyPatch, kundur_present: Path
) -> None:
    """The Julia session the warm-up opened is gone with its directory: the
    state the warm-up used holds no case once it returns."""
    states: list[SiennaState] = []
    real_state = sienna_runtime_module.SiennaState

    class NotingState(real_state):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            states.append(self)  # before super().__init__ may raise is fine here
            super().__init__(*args, **kwargs)

    calls: list[str] = []
    monkeypatch.setattr(sienna_runtime_module, "JuliaBridge", lambda: FakeBridge(calls))
    monkeypatch.setattr(sienna_runtime_module, "SiennaState", NotingState)
    sienna_runtime_module._warm_up()  # noqa: SLF001
    assert len(states) == 1
    # The temporary workspace is gone, so the session object cannot be reached
    # again; the state itself is dropped by the warm-up (only the test holds it).
    assert states[0]._workspace is not None  # noqa: SLF001
    assert not Path(states[0]._workspace).exists()  # noqa: SLF001


def test_andes_session_imports_no_julia() -> None:
    """Creating an ANDES runtime and warming it up imports neither juliacall
    nor the Sienna bridge."""
    from tensa.core.worker import andes_runtime

    sys.modules.pop("juliacall", None)
    sys.modules.pop("tensa.engines.sienna.bridge", None)
    runtime = andes_runtime()
    runtime.warm_up()
    assert "juliacall" not in sys.modules
    assert "tensa.engines.sienna.bridge" not in sys.modules


def test_state_versions_are_cached() -> None:
    calls: list[str] = []
    bridge = FakeBridge(calls)
    state = SiennaState(None, None, None, bridge=bridge)
    first = state.versions()
    second = state.versions()
    assert calls.count("versions") == 1
    assert first == {"julia": "1.13.4"}
    assert second == first
    # A copy, not the cached dict itself.
    first["julia"] = "changed"
    assert state.versions()["julia"] == "1.13.4"


def test_state_versions_survive_a_bridge_failure(
    caplog: pytest.LogCaptureFixture,
) -> None:
    class NoVersions(FakeBridge):
        def versions(self) -> dict[str, Any]:
            raise RuntimeError("x")

    state = SiennaState(None, None, None, bridge=NoVersions([]))
    with caplog.at_level(logging.WARNING, logger="tensa.sienna"):
        assert state.versions() == {}
    assert any("could not read the Sienna versions" in r.getMessage() for r in caplog.records)
