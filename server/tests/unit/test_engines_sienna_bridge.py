"""Unit tests for the Sienna bridge (unit P4-C3a), with no Julia.

``juliacall`` is replaced by a stand-in that an import hook (a finder first on
``sys.meta_path``) makes when the bridge imports it, so the stand-in sees the
environment at the moment of the import, and a ``juliacall`` that is installed
is never reached. Its ``Main`` has ``seval`` and, after the includes, a
``TensaSienna`` and a ``TensaSiennaDyn`` attribute whose functions are plain
Python callables returning strings. The environment functions the bridge calls
are monkeypatched, so no real Julia or project is needed. ``sys.modules``,
``sys.meta_path`` and every environment variable the bridge sets or removes are
restored after each test.
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import logging
import os
import subprocess
import sys
import types
from pathlib import Path
from typing import Any

import numpy
import pytest

from tensa.core.errors import EngineUnavailableError, SiennaError
from tensa.engines.sienna import environment
from tensa.engines.sienna.bridge import JuliaBridge

# Every variable the bridge sets or removes before the import.
_SET = (
    "PYTHON_JULIAPKG_EXE",
    "PYTHON_JULIAPKG_PROJECT",
    "PYTHON_JULIAPKG_OFFLINE",
    "PYTHON_JULIACALL_THREADS",
    "PYTHON_JULIACALL_HANDLE_SIGNALS",
    "JULIA_LOAD_PATH",
)
_REMOVED = (
    "PYTHON_JULIACALL_EXE",
    "PYTHON_JULIACALL_PROJECT",
    "PYTHON_JULIACALL_BINDIR",
    "PYTHON_JULIACALL_LIB",
    "PYTHON_JULIACALL_INIT",
)


class _Main:
    """The stand-in's ``juliacall.Main``: ``seval`` answers the bridge's two
    kinds of code, the check for a module and the include."""

    def __init__(self, stand_in: _StandIn) -> None:
        self._stand_in = stand_in

    def seval(self, code: str) -> Any:
        stand_in = self._stand_in
        stand_in.sevals += 1
        if code == "isdefined(Main, :TensaSienna)":
            return hasattr(self, "TensaSienna")
        if code == "isdefined(Main, :TensaSiennaDyn)":
            return hasattr(self, "TensaSiennaDyn") or stand_in.dyn_guard_answer
        if stand_in.print_lines:
            print("[juliapkg] including")
            print("[juliapkg] include err", file=sys.stderr)
        if stand_in.raise_on_seval is not None:
            raise stand_in.raise_on_seval
        if "TensaSiennaDyn.jl" in code:
            stand_in.dyn_includes.append(code)
            if stand_in.dyn_include_failure is not None:
                return (stand_in.dyn_include_printed, stand_in.dyn_include_failure)
            self.TensaSiennaDyn = types.SimpleNamespace(
                dyn_plan_json=stand_in.fn("dyn_plan_json"),
                eig_json=stand_in.fn("eig_json"),
                tds_init_json=stand_in.fn("tds_init_json"),
                tds_run_json=stand_in.fn("tds_run_json"),
            )
            return (stand_in.dyn_include_printed, None)
        stand_in.includes.append(code)
        if stand_in.include_failure is not None:
            return (stand_in.include_printed, stand_in.include_failure)
        self.TensaSienna = types.SimpleNamespace(
            load_case=stand_in.fn("load_case", lambda: object()),
            report_json=stand_in.fn("report_json"),
            topology_json=stand_in.fn("topology_json"),
            pflow_json=stand_in.fn("pflow_json"),
            versions_json=stand_in.fn("versions_json"),
        )
        return (stand_in.include_printed, None)


class _StandIn:
    """The fake ``juliacall``, made by an import hook, and what it received."""

    def __init__(self) -> None:
        self.julia_error = type("JuliaError", (Exception,), {})
        self.imports = 0
        self.sevals = 0
        self.env_at_import: dict[str, str | None] | None = None
        self.print_lines = False
        self.raise_on_import: Exception | None = None
        self.raise_on_seval: Exception | None = None
        self.include_printed = ""
        self.include_failure: str | None = None
        self.includes: list[str] = []
        self.dyn_include_printed = ""
        self.dyn_include_failure: str | None = None
        self.dyn_guard_answer = False
        self.dyn_includes: list[str] = []
        self.calls: dict[str, list[tuple[tuple[Any, ...], dict[str, Any]]]] = {}
        self.answers: dict[str, Any] = {
            "report_json": '{"buses": 10}',
            "topology_json": '{"branches": 15}',
            "pflow_json": '{"converged": true}',
            "versions_json": '{"julia": "1.11"}',
            "dyn_plan_json": '{"ok": true, "ready": true}',
            "eig_json": '{"ok": true, "n_states": 32}',
            "tds_init_json": '{"ok": true, "initialized": true}',
            "tds_run_json": '{"ok": true, "status": "completed", "t": [0.0], "rows": [[1.0]]}',
        }
        self.raising: dict[str, Exception] = {}
        self.main = _Main(self)

    # The import hook: a finder and its loader in one.
    def find_spec(
        self, fullname: str, path: Any = None, target: Any = None
    ) -> importlib.machinery.ModuleSpec | None:
        if fullname != "juliacall":
            return None
        return importlib.util.spec_from_loader(fullname, self)

    def create_module(self, spec: importlib.machinery.ModuleSpec) -> None:
        return None

    def exec_module(self, module: types.ModuleType) -> None:
        self.imports += 1
        self.env_at_import = {name: os.environ.get(name) for name in (*_SET, *_REMOVED)}
        if self.print_lines:
            print("[juliapkg] resolving")
            print("[juliapkg] err line", file=sys.stderr)
        if self.raise_on_import is not None:
            raise self.raise_on_import
        module.Main = self.main  # type: ignore[attr-defined]
        module.JuliaError = self.julia_error  # type: ignore[attr-defined]

    def fn(self, name: str, answer: Any = None) -> Any:
        def called(*args: Any, **kwargs: Any) -> Any:
            self.calls.setdefault(name, []).append((args, kwargs))
            if name in self.raising:
                raise self.raising[name]
            if answer is not None:
                return answer()
            return self.answers[name]

        return called


class _FakeJuliaVector:
    """What PythonCall hands a Python callable for a Julia ``Vector{Float64}``:
    a wrapper with ``__len__``, ``__getitem__`` and the numpy ``__array__``
    interface. ``__getitem__`` is counted so a test can hold that the bridge
    never indexes per element."""

    def __init__(self, values: list[float]) -> None:
        self._values = values
        self.getitems = 0

    def __len__(self) -> int:
        return len(self._values)

    def __getitem__(self, index: int) -> float:
        self.getitems += 1
        return self._values[index]

    def __array__(self, dtype: Any = None) -> Any:
        return numpy.asarray(self._values, dtype=dtype)


@pytest.fixture
def stand_in(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> _StandIn:
    """Install the fake ``juliacall`` and patch the environment functions."""
    fake = _StandIn()
    # setitem first records what sys.modules held (a real juliacall, or none),
    # so that is what the undo puts back; then the entry goes, so the bridge's
    # import reaches the finder.
    monkeypatch.setitem(sys.modules, "juliacall", types.ModuleType("juliacall"))
    monkeypatch.delitem(sys.modules, "juliacall")
    monkeypatch.setattr(sys, "meta_path", [fake, *sys.meta_path])
    julia = tmp_path / "julia"
    julia.touch()
    project = tmp_path / "dyn"
    project.mkdir()
    monkeypatch.setattr(environment, "sienna_unavailable_reason", lambda: None)
    monkeypatch.setattr(environment, "julia_executable", lambda: julia)
    monkeypatch.setattr(environment, "sienna_project", lambda: project)
    monkeypatch.setattr(environment, "module_path", lambda: tmp_path / "TensaSienna.jl")
    monkeypatch.setattr(environment, "dynamics_module_path", lambda: tmp_path / "TensaSiennaDyn.jl")
    # Registered so monkeypatch restores them; the bridge sets os.environ directly.
    for name in (*_SET, *_REMOVED):
        monkeypatch.delenv(name, raising=False)
    return fake


def _started_bridge(**kwargs: Any) -> JuliaBridge:
    bridge = JuliaBridge(**kwargs)
    bridge.start()
    return bridge


def test_start_sets_the_environment_before_the_import(stand_in: _StandIn, tmp_path: Path) -> None:
    JuliaBridge().start()
    assert stand_in.imports == 1
    assert stand_in.env_at_import == {
        "PYTHON_JULIAPKG_EXE": str(tmp_path / "julia"),
        "PYTHON_JULIAPKG_PROJECT": str(tmp_path / "dyn"),
        "PYTHON_JULIAPKG_OFFLINE": "yes",
        "PYTHON_JULIACALL_THREADS": "1",
        "PYTHON_JULIACALL_HANDLE_SIGNALS": "no",
        "JULIA_LOAD_PATH": os.pathsep.join(("@", "@stdlib")),
        **dict.fromkeys(_REMOVED),
    }


def test_start_removes_what_would_start_another_julia(
    stand_in: _StandIn, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name in _REMOVED:
        monkeypatch.setenv(name, "elsewhere")
    monkeypatch.setenv("JULIA_NUM_THREADS", "auto")
    JuliaBridge().start()
    assert stand_in.env_at_import is not None
    assert all(stand_in.env_at_import[name] is None for name in _REMOVED)
    assert stand_in.env_at_import["PYTHON_JULIACALL_THREADS"] == "1"


def test_start_prints_nothing_and_logs_what_was_printed(
    stand_in: _StandIn,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    stand_in.print_lines = True
    stand_in.include_printed = "Precompiling PowerSystems\n"
    with caplog.at_level(logging.DEBUG, logger="tensa.sienna"):
        JuliaBridge().start()
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == ""
    logged = "\n".join(r.getMessage() for r in caplog.records if r.name == "tensa.sienna")
    for line in ("[juliapkg] resolving", "[juliapkg] err line", "[juliapkg] including"):
        assert line in logged
    assert "Precompiling PowerSystems" in logged
    assert all(r.levelno == logging.DEBUG for r in caplog.records if r.name == "tensa.sienna")


def test_start_includes_the_module_once(stand_in: _StandIn, tmp_path: Path) -> None:
    bridge = JuliaBridge()
    assert bridge.started is False
    bridge.start()
    assert bridge.started is True
    sevals = stand_in.sevals
    bridge.start()
    # A started bridge does nothing at all the second time, not even ask Julia.
    assert stand_in.sevals == sevals
    assert len(stand_in.includes) == 1
    assert f'include(raw"{tmp_path / "TensaSienna.jl"}")' in stand_in.includes[0]


def test_a_second_bridge_shares_the_module(stand_in: _StandIn) -> None:
    first = _started_bridge()
    second = _started_bridge()
    assert second.started is True
    assert len(stand_in.includes) == 1
    assert second.versions() == first.versions() == {"julia": "1.11"}


def test_start_with_unavailable_reason_raises_and_never_imports(
    stand_in: _StandIn, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(environment, "sienna_unavailable_reason", lambda: "Julia was not found")
    with pytest.raises(EngineUnavailableError) as caught:
        JuliaBridge().start()
    assert caught.value.reason == "Julia was not found"
    assert stand_in.imports == 0
    assert "PYTHON_JULIAPKG_EXE" not in os.environ


def test_start_import_failure_is_unavailable_with_first_line(stand_in: _StandIn) -> None:
    stand_in.raise_on_import = RuntimeError("libjulia missing\nmore detail")
    with pytest.raises(EngineUnavailableError) as caught:
        JuliaBridge().start()
    assert caught.value.reason == "Julia could not start: libjulia missing"


def test_start_include_failure_is_unavailable_with_first_line(
    stand_in: _StandIn, caplog: pytest.LogCaptureFixture
) -> None:
    stand_in.include_printed = "printed before the failure\n"
    stand_in.include_failure = "LoadError: could not open file\nin expression starting at"
    bridge = JuliaBridge()
    with (
        caplog.at_level(logging.DEBUG, logger="tensa.sienna"),
        pytest.raises(EngineUnavailableError) as caught,
    ):
        bridge.start()
    assert caught.value.reason == "Julia could not start: LoadError: could not open file"
    assert bridge.started is False
    logged = "\n".join(r.getMessage() for r in caplog.records if r.name == "tensa.sienna")
    assert "printed before the failure" in logged
    assert "in expression starting at" in logged


def test_start_seval_raising_is_unavailable_with_first_line(stand_in: _StandIn) -> None:
    stand_in.raise_on_seval = OSError("could not open file\nstacktrace here")
    with pytest.raises(EngineUnavailableError) as caught:
        JuliaBridge().start()
    assert caught.value.reason == "Julia could not start: could not open file"


def test_start_in_a_project_that_cannot_be_written_says_so(stand_in: _StandIn) -> None:
    stand_in.raise_on_import = PermissionError(
        13, "Access is denied", "C:\\ProgramData\\tensa\\dyn\\lock.pid"
    )
    with pytest.raises(EngineUnavailableError) as caught:
        JuliaBridge().start()
    reason = caught.value.reason
    assert reason.startswith(
        "Julia could not start: the Sienna Julia environment at dyn cannot be written to"
    )
    assert "ProgramData" not in reason


def test_start_failure_holds_no_path(stand_in: _StandIn) -> None:
    stand_in.raise_on_import = RuntimeError(
        "Permission denied: 'C:\\ProgramData\\tensa\\julia\\dyn\\lock.pid'"
    )
    with pytest.raises(EngineUnavailableError) as caught:
        JuliaBridge().start()
    assert caught.value.reason.startswith("Julia could not start: Permission denied: ")
    assert "ProgramData" not in caught.value.reason


def test_a_call_before_start_is_refused(stand_in: _StandIn) -> None:
    with pytest.raises(EngineUnavailableError):
        JuliaBridge().versions()


def test_load_case_passes_paths_keywords_and_json(stand_in: _StandIn, tmp_path: Path) -> None:
    bridge = _started_bridge()
    scratch = tmp_path / "scratch"
    bridge.load_case(
        Path("cases/kundur.raw"),
        Path("cases/kundur.dyr"),
        scratch,
        {"1": 1.05},
        {"transformers": [[1, 2, "1", 1.0, 0.0]]},
    )
    args, kwargs = stand_in.calls["load_case"][-1]
    assert args == (str(Path("cases/kundur.raw")), str(Path("cases/kundur.dyr")))
    assert set(kwargs) == {"scratch", "v_setpoints", "corrections"}
    assert kwargs["scratch"] == str(scratch)
    assert isinstance(kwargs["v_setpoints"], str)
    assert json.loads(kwargs["v_setpoints"]) == {"1": 1.05}
    assert isinstance(kwargs["corrections"], str)
    assert json.loads(kwargs["corrections"]) == {"transformers": [[1, 2, "1", 1.0, 0.0]]}


def test_load_case_without_dyr_or_mappings_passes_none(stand_in: _StandIn, tmp_path: Path) -> None:
    bridge = _started_bridge()
    bridge.load_case(Path("kundur.raw"), None, tmp_path, None, None)
    args, kwargs = stand_in.calls["load_case"][-1]
    assert args == ("kundur.raw", None)
    assert kwargs["v_setpoints"] is None
    assert kwargs["corrections"] is None


def test_pflow_passes_only_the_keywords_given(stand_in: _StandIn) -> None:
    bridge = _started_bridge()
    session = object()
    bridge.pflow(session)
    bridge.pflow(session, tolerance=1e-10)
    bridge.pflow(session, tolerance=1e-10, max_iterations=20)
    received = [kwargs for _, kwargs in stand_in.calls["pflow_json"]]
    assert received == [{}, {"tolerance": 1e-10}, {"tolerance": 1e-10, "max_iterations": 20}]


def test_json_methods_parse_the_answered_string(stand_in: _StandIn) -> None:
    bridge = _started_bridge()
    session = object()
    assert bridge.report(session) == {"buses": 10}
    assert bridge.topology(session) == {"branches": 15}
    assert bridge.pflow(session) == {"converged": True}
    assert bridge.versions() == {"julia": "1.11"}


def test_json_methods_parse_an_object_whose_str_is_json(stand_in: _StandIn) -> None:
    class _JuliaString:
        def __str__(self) -> str:
            return '{"buses": 4}'

    stand_in.answers["report_json"] = _JuliaString()
    bridge = _started_bridge()
    assert bridge.report(object()) == {"buses": 4}


@pytest.mark.parametrize(
    ("julia_text", "message"),
    [
        (
            "ArgumentError: case file not found: nope.raw\nStacktrace:\n [1] load_case",
            "case file not found: nope.raw",
        ),
        (
            "ErrorException: PowerSystems could not read junk.raw: bad\nStacktrace:\n [1] x",
            "PowerSystems could not read junk.raw: bad",
        ),
        ("KeyError: key 5 not found\nStacktrace:\n [1] y", "KeyError: key 5 not found"),
    ],
    ids=["argument", "errorexception", "other-keeps-prefix"],
)
@pytest.mark.parametrize("call", ["load_case", "report", "topology", "pflow", "versions"])
def test_julia_error_becomes_sienna_error(
    stand_in: _StandIn,
    caplog: pytest.LogCaptureFixture,
    julia_text: str,
    message: str,
    call: str,
) -> None:
    function = call if call == "load_case" else f"{call}_json"
    stand_in.raising[function] = stand_in.julia_error(julia_text)
    bridge = _started_bridge()
    args: dict[str, tuple[Any, ...]] = {
        "load_case": (Path("nope.raw"), None, Path("s"), None, None),
        "versions": (),
    }
    with (
        caplog.at_level(logging.DEBUG, logger="tensa.sienna"),
        pytest.raises(SiennaError) as caught,
    ):
        getattr(bridge, call)(*args.get(call, (object(),)))
    assert str(caught.value) == message
    assert isinstance(caught.value.__cause__, stand_in.julia_error)
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]
    debug = [r.getMessage() for r in caplog.records if r.name == "tensa.sienna"]
    assert any("Stacktrace" in line for line in debug)


def test_scrub_is_applied_to_the_message_and_the_log(
    stand_in: _StandIn, caplog: pytest.LogCaptureFixture
) -> None:
    stand_in.raising["report_json"] = stand_in.julia_error(
        "ArgumentError: case file not found: /secret/folder/nope.raw\n"
        "Stacktrace:\n [1] load_case at /secret/folder/TensaSienna.jl:404"
    )
    bridge = _started_bridge(scrub=lambda text: text.replace("/secret/folder/", ""))
    with (
        caplog.at_level(logging.DEBUG, logger="tensa.sienna"),
        pytest.raises(SiennaError) as caught,
    ):
        bridge.report(object())
    assert str(caught.value) == "case file not found: nope.raw"
    logged = "\n".join(r.getMessage() for r in caplog.records if r.name == "tensa.sienna")
    assert "TensaSienna.jl:404" in logged
    assert "/secret/folder" not in logged


def test_without_a_scrub_no_absolute_path_is_left(stand_in: _StandIn) -> None:
    stand_in.raising["report_json"] = stand_in.julia_error(
        "ErrorException: PowerSystems could not read C:\\Users\\someone\\case.raw: bad"
    )
    bridge = _started_bridge()
    with pytest.raises(SiennaError) as caught:
        bridge.report(object())
    assert "someone" not in str(caught.value)
    assert str(caught.value).startswith("PowerSystems could not read ")


def test_arguments_julia_has_no_method_for_stay_a_type_error(stand_in: _StandIn) -> None:
    stand_in.raising["report_json"] = TypeError(
        "Julia: MethodError: no method matching report_json(::Nothing)\n"
        "Closest candidates are:\n"
        "  report_json(!Matched::Main.TensaSienna.Session)\n"
        "   @ Main.TensaSienna C:\\Users\\someone\\TensaSienna.jl:626"
    )
    bridge = _started_bridge()
    with pytest.raises(TypeError) as caught:
        bridge.report(None)
    assert not isinstance(caught.value, SiennaError)
    assert (
        str(caught.value) == "report_json: MethodError: no method matching report_json(::Nothing)"
    )


def test_a_python_type_error_passes_through(stand_in: _StandIn) -> None:
    stand_in.raising["report_json"] = TypeError("unhashable type: 'dict'")
    bridge = _started_bridge()
    with pytest.raises(TypeError, match="^unhashable type: 'dict'$"):
        bridge.report(object())


def test_importing_the_bridge_imports_no_julia() -> None:
    out = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys, tensa.engines.sienna.bridge as b; "
            "b.JuliaBridge.tds_run; "
            "print('juliacall' in sys.modules)",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert out.stdout.strip() == "False"


# The dynamics module (unit P5-B).


def _dyn_bridge(**kwargs: Any) -> JuliaBridge:
    bridge = JuliaBridge(**kwargs)
    bridge.start_dynamics()
    return bridge


def test_start_dynamics_includes_the_second_module_after_the_first(
    stand_in: _StandIn, tmp_path: Path
) -> None:
    bridge = _started_bridge()
    bridge.start_dynamics()
    assert bridge.dynamics_started is True
    assert len(stand_in.includes) == 1
    assert len(stand_in.dyn_includes) == 1
    assert f'include(raw"{tmp_path / "TensaSienna.jl"}")' in stand_in.includes[0]
    assert f'include(raw"{tmp_path / "TensaSiennaDyn.jl"}")' in stand_in.dyn_includes[0]


def test_start_dynamics_starts_julia_when_not_started(stand_in: _StandIn) -> None:
    bridge = JuliaBridge()
    bridge.start_dynamics()
    assert stand_in.imports == 1
    assert len(stand_in.includes) == 1
    assert len(stand_in.dyn_includes) == 1
    assert bridge.started is True
    assert bridge.dynamics_started is True


def test_start_dynamics_is_idempotent_and_asks_nothing_the_second_time(
    stand_in: _StandIn,
) -> None:
    bridge = _dyn_bridge()
    sevals = stand_in.sevals
    bridge.start_dynamics()
    assert stand_in.sevals == sevals
    assert len(stand_in.dyn_includes) == 1


def test_a_second_bridge_shares_the_dynamics_module(stand_in: _StandIn) -> None:
    first = _dyn_bridge()
    second = JuliaBridge()
    second.start_dynamics()
    assert second.dynamics_started is True
    assert len(stand_in.dyn_includes) == 1
    assert second.dyn_plan(object()) == {"ok": True, "ready": True}
    assert first.dyn_plan(object()) == {"ok": True, "ready": True}


def test_start_dynamics_prints_nothing_and_logs_what_was_printed(
    stand_in: _StandIn,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    stand_in.dyn_include_printed = "Precompiling PowerSimulationsDynamics\n"
    with caplog.at_level(logging.DEBUG, logger="tensa.sienna"):
        _dyn_bridge()
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == ""
    logged = "\n".join(r.getMessage() for r in caplog.records if r.name == "tensa.sienna")
    assert "Precompiling PowerSimulationsDynamics" in logged
    assert all(r.levelno == logging.DEBUG for r in caplog.records if r.name == "tensa.sienna")


def test_start_dynamics_include_failure_is_unavailable_with_first_line(
    stand_in: _StandIn, caplog: pytest.LogCaptureFixture
) -> None:
    stand_in.dyn_include_failure = "LoadError: PSID not found\nin expression starting at"
    bridge = JuliaBridge()
    with (
        caplog.at_level(logging.DEBUG, logger="tensa.sienna"),
        pytest.raises(EngineUnavailableError) as caught,
    ):
        bridge.start_dynamics()
    assert caught.value.reason == "Julia could not load the dynamics module: LoadError: PSID not found"
    assert bridge.dynamics_started is False
    logged = "\n".join(r.getMessage() for r in caplog.records if r.name == "tensa.sienna")
    assert "in expression starting at" in logged


def test_start_dynamics_when_julia_cannot_start_propagates(
    stand_in: _StandIn, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(environment, "sienna_unavailable_reason", lambda: "Julia was not found")
    with pytest.raises(EngineUnavailableError) as caught:
        JuliaBridge().start_dynamics()
    assert caught.value.reason == "Julia was not found"
    assert stand_in.imports == 0


def test_dyn_plan_passes_load_model_and_parses(stand_in: _StandIn) -> None:
    bridge = _dyn_bridge()
    session = object()
    assert bridge.dyn_plan(session) == {"ok": True, "ready": True}
    bridge.dyn_plan(session, "power")
    received = [kwargs for _, kwargs in stand_in.calls["dyn_plan_json"]]
    assert received == [{"load_model": "impedance"}, {"load_model": "power"}]


def test_dyn_plan_not_ready_is_returned_not_raised(stand_in: _StandIn) -> None:
    stand_in.answers["dyn_plan_json"] = (
        '{"ok": true, "ready": false, "reason": "solve the power flow first"}'
    )
    bridge = _dyn_bridge()
    answer = bridge.dyn_plan(object())
    assert answer["ready"] is False
    assert answer["reason"] == "solve the power flow first"


def test_eig_passes_matrix_file_only_when_given(stand_in: _StandIn, tmp_path: Path) -> None:
    bridge = _dyn_bridge()
    session = object()
    bridge.eig(session)
    bridge.eig(session, matrix_file=tmp_path / "m.bin")
    received = [kwargs for _, kwargs in stand_in.calls["eig_json"]]
    assert received == [
        {"load_model": "impedance"},
        {"load_model": "impedance", "matrix_file": str(tmp_path / "m.bin")},
    ]


def test_tds_init_passes_load_model(stand_in: _StandIn) -> None:
    bridge = _dyn_bridge()
    assert bridge.tds_init(object(), load_model="as-case") == {"ok": True, "initialized": True}
    received = [kwargs for _, kwargs in stand_in.calls["tds_init_json"]]
    assert received == [{"load_model": "as-case"}]


def test_tds_run_passes_tf_step_disturbances_as_json(stand_in: _StandIn) -> None:
    bridge = _dyn_bridge()
    disturbance = {"kind": "branch_trip", "from": 7, "to": 8, "ckt": "1", "t": 1.0}
    bridge.tds_run(object(), 5.0, step=0.05, disturbances=[disturbance])
    _, kwargs = stand_in.calls["tds_run_json"][-1]
    assert kwargs["tf"] == 5.0
    assert kwargs["step"] == 0.05
    assert kwargs["load_model"] == "impedance"
    assert isinstance(kwargs["disturbances"], str)
    assert json.loads(kwargs["disturbances"]) == [disturbance]
    assert "on_step" not in kwargs


def test_tds_run_omits_step_and_disturbances_when_none(stand_in: _StandIn) -> None:
    bridge = _dyn_bridge()
    bridge.tds_run(object(), 2.0)
    _, kwargs = stand_in.calls["tds_run_json"][-1]
    assert set(kwargs) == {"tf", "load_model"}


def test_tds_run_failed_status_is_returned_not_raised(stand_in: _StandIn) -> None:
    stand_in.answers["tds_run_json"] = (
        '{"ok": true, "status": "failed", "error": "IDA stopped at t = 3.1",'
        ' "t": [0.0], "rows": [[1.0]]}'
    )
    bridge = _dyn_bridge()
    answer = bridge.tds_run(object(), 5.0)
    assert answer["status"] == "failed"
    assert answer["error"] == "IDA stopped at t = 3.1"


@pytest.mark.parametrize(
    "function", ["dyn_plan_json", "eig_json", "tds_init_json", "tds_run_json"]
)
def test_ok_false_is_one_sienna_error_with_the_stage(stand_in: _StandIn, function: str) -> None:
    stand_in.answers[function] = (
        '{"ok": false, "stage": "disturbances",'
        ' "error": "disturbance 1 (branch_trip): branch 7-8-1 does not exist", "notes": []}'
    )
    bridge = _dyn_bridge()
    call = {
        "dyn_plan_json": lambda: bridge.dyn_plan(object()),
        "eig_json": lambda: bridge.eig(object()),
        "tds_init_json": lambda: bridge.tds_init(object()),
        "tds_run_json": lambda: bridge.tds_run(object(), 1.0),
    }[function]
    with pytest.raises(SiennaError) as caught:
        call()
    assert str(caught.value) == "disturbance 1 (branch_trip): branch 7-8-1 does not exist"
    assert caught.value.stage == "disturbances"  # type: ignore[attr-defined]


@pytest.mark.parametrize("stage", ["build", "eig", "matrix", "something-new"])
def test_ok_false_stage_is_carried_as_julia_gave_it(stand_in: _StandIn, stage: str) -> None:
    # The bridge does not classify stages: one it has never seen is carried the
    # same way as one it has.
    stand_in.answers["eig_json"] = (
        f'{{"ok": false, "stage": "{stage}", "error": "PSID has no model for EXDC2", "notes": []}}'
    )
    bridge = _dyn_bridge()
    with pytest.raises(SiennaError) as caught:
        bridge.eig(object())
    assert str(caught.value) == "PSID has no model for EXDC2"
    assert caught.value.stage == stage  # type: ignore[attr-defined]


def test_ok_false_message_is_scrubbed(stand_in: _StandIn) -> None:
    stand_in.answers["tds_run_json"] = (
        '{"ok": false, "stage": "disturbances",'
        ' "error": "disturbance 1: /secret/case.raw is bad", "notes": []}'
    )
    bridge = _dyn_bridge(scrub=lambda text: text.replace("/secret/", ""))
    with pytest.raises(SiennaError) as caught:
        bridge.tds_run(object(), 1.0)
    assert str(caught.value) == "disturbance 1: case.raw is bad"
    assert "/secret/" not in str(caught.value)


def _run_with_hook(stand_in: _StandIn, on_step: Any, calls: int = 1) -> tuple[Any, list[bool]]:
    """A fake ``tds_run_json`` that calls the hook ``calls`` times and answers."""
    hook_returns: list[bool] = []

    def run(*args: Any, **kwargs: Any) -> Any:
        stand_in.calls.setdefault("tds_run_json", []).append((args, kwargs))
        hook = kwargs["on_step"]
        for index in range(calls):
            hook_returns.append(hook(float(index) * 0.5, _FakeJuliaVector([1.0, 2.0, 3.0])))
        return stand_in.answers["tds_run_json"]

    bridge = _dyn_bridge()
    # The include made the module attribute; its function is replaced now.
    stand_in.main.TensaSiennaDyn.tds_run_json = run  # type: ignore[attr-defined]
    return bridge.tds_run(object(), 5.0, on_step=on_step), hook_returns


def test_on_step_receives_t_and_an_array_of_floats(stand_in: _StandIn) -> None:
    received: list[tuple[float, Any]] = []
    _run_with_hook(stand_in, lambda t, values: received.append((t, values)) or True)
    (t, values), = received
    assert t == 0.0
    assert isinstance(values, numpy.ndarray)
    assert values.dtype == numpy.float64
    assert values.shape == (3,)
    assert list(values) == [1.0, 2.0, 3.0]


def test_on_step_values_cross_once(stand_in: _StandIn) -> None:
    vector = _FakeJuliaVector([1.0, 2.0, 3.0])
    seen: list[Any] = []

    def run(*args: Any, **kwargs: Any) -> Any:
        kwargs["on_step"](0.0, vector)
        return stand_in.answers["tds_run_json"]

    bridge = _dyn_bridge()
    stand_in.main.TensaSiennaDyn.tds_run_json = run  # type: ignore[attr-defined]
    bridge.tds_run(object(), 5.0, on_step=lambda t, values: seen.append(values) or True)
    assert len(seen) == 1
    # The numpy buffer path: not one per-element index.
    assert vector.getitems == 0


def test_on_step_returning_false_stops_and_answer_is_returned(stand_in: _StandIn) -> None:
    stand_in.answers["tds_run_json"] = (
        '{"ok": true, "status": "aborted", "t": [0.0, 0.5], "rows": [[1.0], [1.0]]}'
    )
    answer, hook_returns = _run_with_hook(stand_in, lambda t, values: t < 0.5, calls=2)
    # The second call (t = 0.5) returned False to Julia, and the aborted
    # document is the answer, not an error.
    assert hook_returns == [True, False]
    assert answer["status"] == "aborted"


def test_on_step_returning_none_continues(stand_in: _StandIn) -> None:
    _, hook_returns = _run_with_hook(stand_in, lambda t, values: None)
    assert hook_returns == [True]


def test_on_step_exception_is_reraised_after_julia_returns(stand_in: _StandIn) -> None:
    stand_in.answers["tds_run_json"] = (
        '{"ok": true, "status": "failed", "error": "boom", "t": [0.0], "rows": [[1.0]]}'
    )
    boom = ValueError("boom")
    calls = 0

    def on_step(t: float, values: Any) -> bool:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise boom
        return True

    with pytest.raises(ValueError) as caught:
        _run_with_hook(stand_in, on_step, calls=3)
    assert caught.value is boom
    assert caught.value.__cause__ is None
    assert not isinstance(caught.value.__context__, SiennaError)


def test_on_step_exception_during_a_julia_error_is_still_reraised(stand_in: _StandIn) -> None:
    boom = ValueError("boom")

    def run(*args: Any, **kwargs: Any) -> Any:
        kwargs["on_step"](0.0, _FakeJuliaVector([1.0]))
        raise stand_in.julia_error("ErrorException: PSID broke\nStacktrace:\n [1] x")

    bridge = _dyn_bridge()
    stand_in.main.TensaSiennaDyn.tds_run_json = run  # type: ignore[attr-defined]

    def on_step(t: float, values: Any) -> bool:
        raise boom

    with pytest.raises(ValueError) as caught:
        bridge.tds_run(object(), 5.0, on_step=on_step)
    assert caught.value is boom


def test_on_step_is_not_called_again_after_an_exception(stand_in: _StandIn) -> None:
    calls = 0

    def on_step(t: float, values: Any) -> bool:
        nonlocal calls
        calls += 1
        raise ValueError("boom")

    with pytest.raises(ValueError):
        _run_with_hook(stand_in, on_step, calls=3)
    assert calls == 1


def test_keyboard_interrupt_in_on_step_is_stored_not_raised_into_julia(stand_in: _StandIn) -> None:
    def on_step(t: float, values: Any) -> bool:
        raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        _run_with_hook(stand_in, on_step)


def test_dynamics_calls_go_through_call_error_mapping(stand_in: _StandIn) -> None:
    stand_in.raising["eig_json"] = stand_in.julia_error(
        "ErrorException: PSID broke\nStacktrace:\n [1] x"
    )
    stand_in.raising["dyn_plan_json"] = TypeError(
        "Julia: MethodError: no method matching dyn_plan_json(::Nothing)\nClosest candidates"
    )
    bridge = _dyn_bridge()
    with pytest.raises(SiennaError) as caught:
        bridge.eig(object())
    assert str(caught.value) == "PSID broke"
    with pytest.raises(TypeError) as type_error:
        bridge.dyn_plan(None)
    assert not isinstance(type_error.value, SiennaError)
    assert str(type_error.value).startswith(
        "dyn_plan_json: MethodError: no method matching dyn_plan_json(::Nothing)"
    )


def test_dynamics_call_before_start_starts_julia(stand_in: _StandIn) -> None:
    bridge = JuliaBridge()
    assert bridge.eig(object()) == {"ok": True, "n_states": 32}
    assert stand_in.imports == 1
    assert len(stand_in.includes) == 1
    assert len(stand_in.dyn_includes) == 1
