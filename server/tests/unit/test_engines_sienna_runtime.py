"""Unit tests for the Sienna runtime: the handler table, the payload shapes,
path refusal, and that the bridge is called on the thread that called
``dispatch``."""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

import pytest

from tensa.core.worker import HANDLERS as ANDES_HANDLERS
from tensa.core.worker import _serialize_dataclass
from tensa.core.wrapper import Wrapper
from tensa.engines.ops import ENGINE_OPS
from tensa.engines.sienna.runtime import _HANDLERS, sienna_runtime
from tensa.engines.sienna.state import SiennaState

_SAMPLES = Path(__file__).parent / "sienna_samples"


class FakeBridge:
    """Answers the recorded JSON for a case name and records the thread each
    call ran on."""

    def __init__(self) -> None:
        self.threads: list[threading.Thread] = []
        self._started = False

    @property
    def started(self) -> bool:
        return self._started

    def start(self) -> None:
        self._started = True

    def _note(self) -> None:
        self.threads.append(threading.current_thread())

    def _sample(self, name: str, kind: str) -> dict[str, Any]:
        return json.loads((_SAMPLES / f"{name}.{kind}.json").read_text("utf-8"))

    def load_case(self, raw: Path, dyr: Any, scratch: Path, v_setpoints: Any, corrections: Any) -> Any:
        self._note()
        name = f"{raw.stem}_dyr" if dyr is not None else raw.stem
        return {"case": name}

    def report(self, session: Any) -> dict[str, Any]:
        self._note()
        return self._sample(session["case"], "report")

    def topology(self, session: Any) -> dict[str, Any]:
        self._note()
        return self._sample(session["case"], "topology")

    def pflow(self, session: Any, tolerance: Any = None, max_iterations: Any = None) -> dict[str, Any]:
        self._note()
        return self._sample(session["case"], "pflow")

    def versions(self) -> dict[str, Any]:
        return {}


def _andes_cases_dir() -> Path:
    andes = pytest.importorskip("andes")
    return Path(andes.__file__).parent / "cases"


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    ws.mkdir()
    return ws


@pytest.fixture
def state(workspace: Path) -> SiennaState:
    return SiennaState(str(workspace), "b" * 32, 1234, bridge=FakeBridge())


@pytest.fixture
def kundur(workspace: Path) -> Path:
    src = _andes_cases_dir() / "kundur" / "kundur.raw"
    dst = workspace / "kundur.raw"
    dst.write_bytes(src.read_bytes())
    return dst


def test_the_handler_table_is_exactly_the_nineteen_ops() -> None:
    assert set(_HANDLERS) == {
        "load_case",
        "reload_case",
        "topology",
        "operating_point",
        "run_pflow",
        "list_keys",
        "network_matrix",
        "case_document",
        "run_eig",
        "eig_participation",
        "add_disturbance",
        "list_disturbances",
        "clear_disturbances",
        "init_tds",
        "add_element",
        "edit_element",
        "delete_element",
        "undo_last_edit",
        "redo_edit",
    }
    assert set(_HANDLERS) | {"run_tds"} == ENGINE_OPS["sienna"]


def test_runtime_shape() -> None:
    runtime = sienna_runtime()
    assert runtime.name == "sienna"
    assert runtime.make_state is not None
    assert runtime.dispatch is not None
    assert runtime.warm_up is not None


def _andes_payload(op: str, wrapper: Wrapper, args: dict[str, Any]) -> Any:
    return ANDES_HANDLERS[op](wrapper, args)


def _sienna_payload(op: str, state: SiennaState, args: dict[str, Any]) -> Any:
    return _HANDLERS[op](state, args)


def _key_types(payload: Any) -> dict[str, type]:
    assert isinstance(payload, dict)
    return {key: type(value) for key, value in payload.items()}


def test_payload_shapes_match_the_andes_ones(
    state: SiennaState, workspace: Path, kundur: Path
) -> None:
    """Each handler's payload has the same top-level keys as the ANDES
    handler's payload for the same op, with the same value types."""
    wrapper = Wrapper(workspace=str(workspace), session_id="c" * 32, owner_pid=1234)
    andes_case = _andes_cases_dir() / "kundur" / "kundur.raw"

    # load_case
    andes_load = _andes_payload(
        "load_case", wrapper, {"path": str(andes_case), "addfiles": None}
    )
    sienna_load = _sienna_payload(
        "load_case", state, {"path": str(kundur), "addfiles": None}
    )
    assert _key_types(sienna_load) == _key_types(andes_load)

    # topology
    andes_topo = _andes_payload("topology", wrapper, {})
    sienna_topo = _sienna_payload("topology", state, {})
    assert _key_types(sienna_topo) == _key_types(andes_topo)

    # run_pflow
    andes_pf = _andes_payload("run_pflow", wrapper, {})
    sienna_pf = _sienna_payload("run_pflow", state, {})
    assert _key_types(sienna_pf) == _key_types(andes_pf)

    # operating_point, after a power flow on both (settings and summary are
    # None only before one).
    andes_op = _andes_payload("operating_point", wrapper, {})
    sienna_op = _sienna_payload("operating_point", state, {})
    assert _key_types(sienna_op) == _key_types(andes_op)

    # list_keys
    andes_keys = _andes_payload("list_keys", wrapper, {})
    sienna_keys = _sienna_payload("list_keys", state, {})
    assert _key_types(sienna_keys) == _key_types(andes_keys)

    # reload_case
    andes_reload = _andes_payload("reload_case", wrapper, {})
    sienna_reload = _sienna_payload("reload_case", state, {})
    assert _key_types(sienna_reload) == _key_types(andes_reload)


def test_a_path_outside_the_workspace_is_refused_as_the_andes_one(
    state: SiennaState, workspace: Path, kundur: Path, tmp_path: Path
) -> None:
    """The route checks a path against the workspace before the worker sees it
    (``open_workspace_file_for_andes``), for both engines. The Sienna handler
    checks it again with the same function, since Julia's reads are invisible
    to the audit hook: a path the route's check refuses is refused, and Julia is
    never called."""
    from tensa.core.errors import CaseLoadError
    from tensa.security.paths import WorkspacePathError, open_workspace_file_for_andes

    outside = tmp_path / "outside.raw"
    outside.write_bytes(kundur.read_bytes())
    for client_path in ("../outside.raw", str(outside)):
        with (
            pytest.raises(WorkspacePathError),
            open_workspace_file_for_andes(workspace, client_path),
        ):
            pass
    with pytest.raises(CaseLoadError, match="not a file in the workspace"):
        _HANDLERS["load_case"](state, {"path": str(outside), "addfiles": None})
    with pytest.raises(CaseLoadError, match="not a file in the workspace"):
        _HANDLERS["load_case"](
            state, {"path": str(workspace / ".." / "outside.raw"), "addfiles": None}
        )
    bridge = state._bridge  # noqa: SLF001
    assert isinstance(bridge, FakeBridge)
    assert bridge.threads == []


def test_the_bridge_is_called_on_the_thread_that_called_dispatch(
    state: SiennaState, kundur: Path
) -> None:
    runtime = sienna_runtime()
    caller = threading.current_thread()
    runtime.dispatch(
        state, "load_case", {"path": str(kundur), "addfiles": None}, None, None, None
    )
    runtime.dispatch(state, "topology", {}, None, None, None)
    runtime.dispatch(state, "run_pflow", {}, None, None, None)
    bridge = state._bridge  # noqa: SLF001
    assert isinstance(bridge, FakeBridge)
    assert bridge.threads
    assert all(thread is caller for thread in bridge.threads)


def test_load_case_passes_on_unsupported(state: SiennaState, workspace: Path, kundur: Path) -> None:
    from tensa.core.errors import CaseLoadError

    dyr = workspace / "kundur_full.dyr"
    dyr.write_bytes((_andes_cases_dir() / "kundur" / "kundur_full.dyr").read_bytes())
    args: dict[str, Any] = {"path": str(kundur), "addfiles": [str(dyr)]}
    with pytest.raises(CaseLoadError, match="EXDC2"):
        _HANDLERS["load_case"](state, args)
    payload = _HANDLERS["load_case"](state, {**args, "on_unsupported": "drop"})
    assert payload["has_dynamics"] is True


def test_run_eig_handler_echoes_load_model_and_notes(state: SiennaState) -> None:
    """The payload is the dataclass's fields plus ``load_model`` and the
    standing note; the state's ``run_eig`` saw the load model it was given."""
    from tensa.core.eig_result import ComplexNumber, EigResult
    from tensa.engines.sienna.state import SIENNA_EIG_NOTE

    seen: list[str] = []
    result = EigResult(
        eigenvalues=[ComplexNumber(-1.0, 2.0)],
        damping_ratios=[0.4472],
        frequencies_hz=[0.3183],
        mode_count=1,
        state_count=1,
        state_names=["gen:1-1 δ"],
        tds_initialized=True,
    )

    class _Double:
        def run_eig(self, load_model: str = "impedance") -> EigResult:
            seen.append(load_model)
            return result

    double = _Double()
    payload = _HANDLERS["run_eig"](double, {})
    assert seen == ["impedance"]
    assert payload["load_model"] == "impedance"
    assert payload["notes"] == [SIENNA_EIG_NOTE]
    assert payload["mode_count"] == 1
    assert payload["eigenvalues"] == [{"real": -1.0, "imag": 2.0}]
    payload = _HANDLERS["run_eig"](double, {"load_model": "power"})
    assert seen == ["impedance", "power"]
    assert payload["load_model"] == "power"


def test_eig_participation_handler_passes_an_int(state: SiennaState) -> None:
    seen: list[int] = []
    answer = {"mode_idx": 2, "participation": [{"state_name": "s", "factor": 1.0}]}

    class _Double:
        def eig_participation(self, mode_idx: int) -> dict[str, object]:
            assert isinstance(mode_idx, int)
            seen.append(mode_idx)
            return answer

    assert _HANDLERS["eig_participation"](_Double(), {"mode_idx": "2"}) == answer
    assert seen == [2]


def test_dispatch_of_an_op_outside_the_table_is_a_key_error(state: SiennaState) -> None:
    runtime = sienna_runtime()
    with pytest.raises(KeyError):
        runtime.dispatch(state, "run_cpf", {}, None, None, None)


def test_dispatch_passes_the_abort_event_to_run_tds(state: SiennaState) -> None:
    """``run_tds`` is dispatched directly with the abort event, as the ANDES
    table special-cases it."""
    seen: list[Any] = []

    class _Double:
        def run_tds(self, **kwargs: Any) -> dict[str, Any]:
            seen.append(kwargs.get("abort_event"))
            return {"converged": True}

    event = object()
    runtime = sienna_runtime()
    payload = runtime.dispatch(_Double(), "run_tds", {"tf": 1.0}, event, None, None)
    assert seen == [event]
    assert payload == {"converged": True}


def test_add_disturbance_handler_validates_the_spec(state: SiennaState) -> None:
    """A fault spec dict round-trips through the handler; an unknown kind is a
    pydantic validation error."""
    from pydantic import ValidationError

    class _Double:
        def __init__(self) -> None:
            self.specs: list[Any] = []

        def add_disturbance(self, spec: Any) -> str:
            self.specs.append(spec)
            return "0"

    double = _Double()
    spec = {"kind": "fault", "bus_idx": 7, "tf": 1.0, "tc": 1.1, "xf": 0.05, "rf": 0.0}
    assert _HANDLERS["add_disturbance"](double, {"spec": spec}) == "0"
    assert double.specs[0].model_dump() == spec
    with pytest.raises(ValidationError):
        _HANDLERS["add_disturbance"](double, {"spec": {"kind": "nope"}})


def test_list_disturbances_with_no_case_is_empty(state: SiennaState) -> None:
    assert _HANDLERS["list_disturbances"](state, {}) == []


def test_list_keys_with_no_case_is_empty(state: SiennaState) -> None:
    assert _HANDLERS["list_keys"](state, {}) == {"keys": [], "problems": []}


def test_warm_up_never_raises(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    """A Julia that cannot start is logged, and the first op reports it."""
    from tensa.engines.sienna import environment

    monkeypatch.setattr(environment, "sienna_unavailable_reason", lambda: "no Julia here")
    with caplog.at_level("WARNING", logger="tensa.sienna"):
        sienna_runtime().warm_up()
    assert any("no Julia here" in r.getMessage() for r in caplog.records)


def test_serialize_dataclass_round_trip(state: SiennaState, kundur: Path) -> None:
    """The payloads cross the Pipe as plain dicts."""
    _HANDLERS["load_case"](state, {"path": str(kundur), "addfiles": None})
    payload = _HANDLERS["topology"](state, {})
    assert isinstance(payload, dict)
    # It is already serialised; serialising again changes nothing.
    assert _serialize_dataclass(payload) == payload
