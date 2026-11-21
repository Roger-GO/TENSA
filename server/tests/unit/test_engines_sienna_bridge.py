"""Unit tests for the Sienna bridge (unit P4-C3a), with no Julia.

``juliacall`` is replaced by a stand-in that an import hook (a finder first on
``sys.meta_path``) makes when the bridge imports it, so the stand-in sees the
environment at the moment of the import, and a ``juliacall`` that is installed
is never reached. Its ``Main`` has ``seval`` and, after the include, a
``TensaSienna`` attribute whose five functions are plain Python callables
returning strings. The environment functions the bridge calls are
monkeypatched, so no real Julia or project is needed. ``sys.modules``,
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
    kinds of code, the check for the module and the include."""

    def __init__(self, stand_in: _StandIn) -> None:
        self._stand_in = stand_in

    def seval(self, code: str) -> Any:
        stand_in = self._stand_in
        stand_in.sevals += 1
        if code == "isdefined(Main, :TensaSienna)":
            return hasattr(self, "TensaSienna")
        if stand_in.print_lines:
            print("[juliapkg] including")
            print("[juliapkg] include err", file=sys.stderr)
        if stand_in.raise_on_seval is not None:
            raise stand_in.raise_on_seval
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
        self.calls: dict[str, list[tuple[tuple[Any, ...], dict[str, Any]]]] = {}
        self.answers: dict[str, Any] = {
            "report_json": '{"buses": 10}',
            "topology_json": '{"branches": 15}',
            "pflow_json": '{"converged": true}',
            "versions_json": '{"julia": "1.11"}',
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
            "import sys, tensa.engines.sienna.bridge; print('juliacall' in sys.modules)",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert out.stdout.strip() == "False"
