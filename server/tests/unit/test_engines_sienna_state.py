"""Unit tests for ``SiennaState``: no Julia, a fake bridge answers the
recorded JSON for a case name and records the calls it got."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import pytest

from tensa.core.errors import CaseLoadError, NoCaseLoadedError, PflowRequestError
from tensa.engines.sienna.state import SiennaState, julia_corrections

_SAMPLES = Path(__file__).parent / "sienna_samples"


class FakeBridge:
    """Answers the recorded JSON for a case name and records its calls."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []
        self._started = False

    @property
    def started(self) -> bool:
        return self._started

    def start(self) -> None:
        self._started = True

    def _sample(self, name: str, kind: str) -> dict[str, Any]:
        return json.loads((_SAMPLES / f"{name}.{kind}.json").read_text("utf-8"))

    def load_case(
        self,
        raw: Path,
        dyr: Path | None,
        scratch: Path,
        v_setpoints: Any,
        corrections: Any,
    ) -> Any:
        self.calls.append(
            ("load_case", (raw, dyr, scratch), {"v_setpoints": v_setpoints, "corrections": corrections})
        )
        # The sample of a load with a .dyr is the ``<case>_dyr`` one, and the
        # MATPOWER file's is ``case14_m``.
        name = f"{raw.stem}_dyr" if dyr is not None else raw.stem
        if raw.suffix == ".m":
            name = f"{raw.stem}_m"
        return {"case": name}

    def report(self, session: Any) -> dict[str, Any]:
        self.calls.append(("report", (session,), {}))
        return self._sample(session["case"], "report")

    def topology(self, session: Any) -> dict[str, Any]:
        self.calls.append(("topology", (session,), {}))
        return self._sample(session["case"], "topology")

    def pflow(
        self,
        session: Any,
        tolerance: float | None = None,
        max_iterations: int | None = None,
    ) -> dict[str, Any]:
        self.calls.append(
            ("pflow", (session,), {"tolerance": tolerance, "max_iterations": max_iterations})
        )
        return self._sample(session["case"], "pflow")

    def versions(self) -> dict[str, Any]:
        return json.loads((_SAMPLES / "versions.json").read_text("utf-8"))


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
    return SiennaState(str(workspace), "a" * 32, 1234, bridge=FakeBridge())


def _kundur(workspace: Path) -> Path:
    src = _andes_cases_dir() / "kundur" / "kundur.raw"
    dst = workspace / "kundur.raw"
    dst.write_bytes(src.read_bytes())
    return dst


def test_load_raw(state: SiennaState, workspace: Path) -> None:
    path = _kundur(workspace)
    snap = state.load_case(path)
    assert len(snap.buses) == 10
    assert len(snap.lines) + len(snap.transformers) == 15
    assert all(entry.key for entry in snap.buses)


def test_load_refuses_an_xlsx(state: SiennaState, workspace: Path) -> None:
    bad = workspace / "case.xlsx"
    bad.write_bytes(b"PK")
    with pytest.raises(CaseLoadError, match="reads PSS/E .raw and MATPOWER .m"):
        state.load_case(bad)


def test_load_refuses_a_dyr_without_a_raw(state: SiennaState, workspace: Path) -> None:
    path = _kundur(workspace)
    dyr = workspace / "kundur.dyr"
    dyr.write_bytes(b"")
    # A .dyr as the primary is refused by the extension check.
    with pytest.raises(CaseLoadError, match="is neither"):
        state.load_case(dyr)
    # More than one addfile is refused.
    with pytest.raises(CaseLoadError, match="at most one addfile"):
        state.load_case(path, addfiles=[dyr, dyr])


def test_load_refuses_a_bad_on_unsupported(state: SiennaState, workspace: Path) -> None:
    path = _kundur(workspace)
    with pytest.raises(CaseLoadError, match="on_unsupported"):
        state.load_case(path, on_unsupported="ignore")  # type: ignore[arg-type]


def test_scratch_dir_is_inside_the_session_scratch(state: SiennaState, workspace: Path) -> None:
    path = _kundur(workspace)
    state.load_case(path)
    bridge = state._bridge  # noqa: SLF001
    assert isinstance(bridge, FakeBridge)
    scratch = bridge.calls[0][1][2]
    assert isinstance(scratch, Path)
    assert scratch.parent == workspace / ".sessions" / ("a" * 32)
    assert scratch.name == "sienna"
    assert scratch.is_dir()


def test_unsupported_records_refused_and_no_case_held(
    state: SiennaState, workspace: Path
) -> None:
    raw = _kundur(workspace)
    dyr_src = _andes_cases_dir() / "kundur" / "kundur_full.dyr"
    dyr = workspace / "kundur_full.dyr"
    dyr.write_bytes(dyr_src.read_bytes())
    with pytest.raises(CaseLoadError) as caught:
        state.load_case(raw, addfiles=[dyr])
    message = str(caught.value)
    for bus in (1, 2, 3, 4):
        assert f"EXDC2 at bus {bus}, id 1" in message
    assert 'on_unsupported "drop"' in message
    assert "ANDES" in message
    with pytest.raises(NoCaseLoadedError):
        state.topology()


def test_unsupported_records_dropped(state: SiennaState, workspace: Path) -> None:
    raw = _kundur(workspace)
    dyr_src = _andes_cases_dir() / "kundur" / "kundur_full.dyr"
    dyr = workspace / "kundur_full.dyr"
    dyr.write_bytes(dyr_src.read_bytes())
    snap = state.load_case(raw, addfiles=[dyr], on_unsupported="drop")
    assert snap.has_dynamics is True


def test_messages_reach_tensa_notice(
    state: SiennaState, workspace: Path, caplog: pytest.LogCaptureFixture
) -> None:
    raw = _kundur(workspace)
    dyr_src = _andes_cases_dir() / "kundur" / "kundur_full.dyr"
    dyr = workspace / "kundur_full.dyr"
    dyr.write_bytes(dyr_src.read_bytes())
    with caplog.at_level(logging.INFO, logger="tensa.notice"):
        state.load_case(raw, addfiles=[dyr], on_unsupported="drop")
    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    infos = [r for r in caplog.records if r.levelno == logging.INFO]
    # One warning per dropped EXDC2 record.
    exdc2 = [r for r in warnings if "EXDC2" in r.getMessage()]
    assert len(exdc2) == 4
    assert infos or warnings  # something was said


def test_keys_kept_across_a_reload_of_the_same_content(
    state: SiennaState, workspace: Path
) -> None:
    path = _kundur(workspace)
    state.load_case(path)
    book = state.keys()
    before = {e.key for e in book.entries()}
    state.reload_case()
    assert state.keys() is book
    after = {e.key for e in state.keys().entries()}
    assert before == after
    # Loading the same unchanged file again by load_case keeps it too.
    state.load_case(path)
    assert state.keys() is book


def test_the_notes_of_the_corrections_and_the_power_flow_are_logged(
    state: SiennaState,
    workspace: Path,
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A note of the corrections document is a warning; a note of the power flow
    JSON is logged at its own level (IEEE 39's recorded run has five warnings)."""
    import tensa.engines.sienna.state as state_module

    real_document = state_module.corrections_document

    def _with_a_note(facts: Any) -> dict[str, object]:
        return {**real_document(facts), "notes": ["the file says something odd"]}

    monkeypatch.setattr(state_module, "corrections_document", _with_a_note)
    case = workspace / "ieee39.raw"
    case.write_bytes((_andes_cases_dir() / "ieee39" / "ieee39.raw").read_bytes())
    with caplog.at_level(logging.INFO, logger="tensa.notice"):
        state.load_case(case)
    noted = [r for r in caplog.records if r.getMessage() == "the file says something odd"]
    assert len(noted) == 1 and noted[0].levelno == logging.WARNING
    caplog.clear()
    with caplog.at_level(logging.INFO, logger="tensa.notice"):
        state.run_pflow()
    expected = json.loads((_SAMPLES / "ieee39.pflow.json").read_text("utf-8"))["notes"]
    assert expected
    logged = [(r.levelname.lower(), r.getMessage()) for r in caplog.records]
    assert logged == [(n["level"], n["text"]) for n in expected]


def test_ratings_are_the_files(state: SiennaState, workspace: Path) -> None:
    """Kundur's file rates no branch, so no branch has a rating, whatever
    PowerSystems made up (the recorded topology holds its invented ones)."""
    topology_json = json.loads((_SAMPLES / "kundur.topology.json").read_text("utf-8"))
    assert any(float(row.get("rate_mva") or 0) > 0 for row in topology_json["branches"])
    snap = state.load_case(_kundur(workspace))
    assert [e.params["rate_a"] for e in snap.lines + snap.transformers] == [0.0] * 15
    assert [e.params["rate_a"] for e in state.topology().lines] == [0.0] * len(snap.lines)
    result = state.run_pflow()
    assert result.line_flows
    assert all(f.rate_a is None and f.loading_pct is None for f in result.line_flows.values())
    point = state.operating_point()
    assert all(f.rate_a is None for f in point.line_flows.values())


def test_keys_renewed_when_the_file_changes(
    state: SiennaState, workspace: Path
) -> None:
    path = _kundur(workspace)
    state.load_case(path)
    before_book = state.keys()
    # Change the file on disk (append a comment) so the stamp differs.
    with path.open("a", encoding="utf-8") as fh:
        fh.write("\n@! changed\n")
    state.reload_case()
    assert state.keys() is not before_book


def test_run_pflow_refusals(state: SiennaState, workspace: Path) -> None:
    path = _kundur(workspace)
    state.load_case(path)
    with pytest.raises(PflowRequestError, match="flat_start"):
        state.run_pflow(flat_start=True)
    with pytest.raises(PflowRequestError, match="enforce_q_limits"):
        state.run_pflow(enforce_q_limits=True)
    with pytest.raises(PflowRequestError, match="method"):
        state.run_pflow(method="NK")
    with pytest.raises(PflowRequestError, match="n_factorize"):
        state.run_pflow(n_factorize=4)
    with pytest.raises(PflowRequestError, match="linesearch"):
        state.run_pflow(linesearch=True)


def test_run_pflow_validation(state: SiennaState, workspace: Path) -> None:
    path = _kundur(workspace)
    state.load_case(path)
    with pytest.raises(PflowRequestError, match="tolerance"):
        state.run_pflow(tolerance=0)
    with pytest.raises(PflowRequestError, match="tolerance"):
        state.run_pflow(tolerance=float("nan"))
    with pytest.raises(PflowRequestError, match="tolerance"):
        state.run_pflow(tolerance=True)  # type: ignore[arg-type]
    with pytest.raises(PflowRequestError, match="max_iterations"):
        state.run_pflow(max_iterations=0)
    with pytest.raises(PflowRequestError, match="max_iterations"):
        state.run_pflow(max_iterations=True)  # type: ignore[arg-type]


def test_run_pflow_settings_on_the_result(state: SiennaState, workspace: Path) -> None:
    path = _kundur(workspace)
    state.load_case(path)
    result = state.run_pflow()
    assert result.converged is True
    assert result.settings is not None
    assert result.settings.flat_start is False
    assert result.settings.enforce_q_limits is False
    assert result.settings.tolerance > 0
    assert result.settings.max_iterations >= 1


def test_operating_point_before_and_after_a_power_flow(
    state: SiennaState, workspace: Path
) -> None:
    path = _kundur(workspace)
    state.load_case(path)
    point = state.operating_point()
    assert point.converged is False
    assert len(point.bus_voltages) == 10
    assert not point.line_flows
    state.run_pflow()
    point = state.operating_point()
    assert point.converged is True
    assert point.line_flows
    # As the ANDES wrapper's operating_point: settings and summary stay None.
    assert point.settings is None
    assert point.summary is None


def test_reload_passes_the_same_on_unsupported(
    state: SiennaState, workspace: Path
) -> None:
    raw = _kundur(workspace)
    dyr_src = _andes_cases_dir() / "kundur" / "kundur_full.dyr"
    dyr = workspace / "kundur_full.dyr"
    dyr.write_bytes(dyr_src.read_bytes())
    state.load_case(raw, addfiles=[dyr], on_unsupported="drop")
    # A reload with "refuse" would raise; "drop" was kept, so it loads.
    snap = state.reload_case()
    assert snap.has_dynamics is True


def test_no_case_raises(state: SiennaState) -> None:
    with pytest.raises(NoCaseLoadedError):
        state.topology()
    with pytest.raises(NoCaseLoadedError):
        state.reload_case()
    with pytest.raises(NoCaseLoadedError):
        state.run_pflow()
    with pytest.raises(NoCaseLoadedError):
        state.operating_point()
    with pytest.raises(NoCaseLoadedError):
        state.keys()


def _document(path: Path) -> dict[str, Any]:
    from tensa.engines.case_facts import corrections_document, read_case_facts

    return dict(corrections_document(read_case_facts(path)))


def test_matpower_row_numbers_on_case14() -> None:
    """Each transformers and line_charging row goes to Julia with its third
    field the row's number in the file's branch matrix, as text. In case14 the
    transformers 4-7, 4-9 and 5-6 are rows 8, 9 and 10, between lines, so a
    position in the facts' or the identity's lists (lines first) would be wrong."""
    case = _andes_cases_dir() / "matpower" / "case14.m"
    sent = julia_corrections(case, _document(case))
    assert set(sent) == {"transformers", "line_charging"}
    assert [row[:3] for row in sent["transformers"]] == [
        [4, 7, "8"],
        [4, 9, "9"],
        [5, 6, "10"],
    ]
    # The file's own branch rows, in order, numbered from 1.
    rows = [
        (1, 2), (1, 5), (2, 3), (2, 4), (2, 5), (3, 4), (4, 5), (4, 7), (4, 9),
        (5, 6), (6, 11), (6, 12), (6, 13), (7, 8), (7, 9), (9, 10), (9, 14),
        (10, 11), (12, 13), (13, 14),
    ]
    number_of = {pair: str(n) for n, pair in enumerate(rows, start=1)}
    assert [row[2] for row in sent["line_charging"]] == [
        number_of[(row[0], row[1])] for row in sent["line_charging"]
    ]
    assert len(sent["line_charging"]) == 17
    # The tap and the charging values are the document's, untouched.
    document = _document(case)
    assert [row[3:] for row in sent["transformers"]] == [
        row[3:] for row in document["transformers"]
    ]
    assert [row[3:] for row in sent["line_charging"]] == [
        row[3:] for row in document["line_charging"]
    ]


_THREE_ROWS = """\
function mpc = three
mpc.version = '2';
mpc.baseMVA = 100;
mpc.bus = [
\t1\t3\t0\t0\t0\t0\t1\t1\t0\t230\t1\t1.1\t0.9;
\t2\t1\t50\t10\t0\t0\t1\t1\t0\t230\t1\t1.1\t0.9;
\t3\t1\t0\t0\t0\t0\t1\t1\t0\t230\t1\t1.1\t0.9;
];
mpc.gen = [
\t1\t0\t0\t300\t-300\t1.02\t100\t1\t250\t10;
];
mpc.branch = [
\t1\t2\t0.01\t0.1\t0\t0\t0\t0\t0.98\t0\t1\t-360\t360;
\t2\t3\t0.01\t0.1\t0.02\t0\t0\t0\t0\t0\t1\t-360\t360;
\t3\t2\t0.01\t0.1\t0.04\t0\t0\t0\t0\t0\t1\t-360\t360;
];
"""


def test_matpower_row_numbers_when_the_first_row_is_a_transformer(tmp_path: Path) -> None:
    """A file whose first branch row is a transformer (as in GBnetwork.m), with
    two parallel lines after it: the transformer is row 1 and the lines rows 2
    and 3, whatever order the facts list them in."""
    case = tmp_path / "three.m"
    case.write_text(_THREE_ROWS, encoding="utf-8")
    document = _document(case)
    assert [row[:3] for row in document["transformers"]] == [[1, 2, "1"]]
    assert [row[:3] for row in document["line_charging"]] == [[2, 3, "1"], [3, 2, "2"]]
    sent = julia_corrections(case, document)
    assert [row[:3] for row in sent["transformers"]] == [[1, 2, "1"]]
    assert [row[:3] for row in sent["line_charging"]] == [[2, 3, "2"], [3, 2, "3"]]
    assert [row[3] for row in sent["line_charging"]] == [0.02, 0.04]
    # The document itself is not changed: its ratings keep the circuit ids.
    assert [row[:3] for row in document["line_charging"]] == [[2, 3, "1"], [3, 2, "2"]]


def test_a_raw_file_keeps_its_circuit_ids(workspace: Path) -> None:
    case = _kundur(workspace)
    document = _document(case)
    sent = julia_corrections(case, document)
    assert sent["transformers"] == document["transformers"]
    assert sent["line_charging"] == document["line_charging"]


def test_what_the_bridge_is_sent(state: SiennaState, workspace: Path) -> None:
    """The corrections as ``julia_corrections`` makes them (the two keys the
    Julia module knows) and the document's voltage setpoints."""
    path = _kundur(workspace)
    state.load_case(path)
    bridge = state._bridge  # noqa: SLF001
    assert isinstance(bridge, FakeBridge)
    name, (raw, dyr, _scratch), kwargs = bridge.calls[0]
    assert name == "load_case"
    assert raw == path.resolve()
    assert dyr is None
    document = _document(path)
    assert kwargs["corrections"] == julia_corrections(path, document)
    assert kwargs["v_setpoints"] == {k: float(v) for k, v in document["v_setpoints"].items()}
    assert kwargs["v_setpoints"]


def test_a_matpower_load_sends_row_numbers(state: SiennaState, workspace: Path) -> None:
    case = workspace / "case14.m"
    case.write_bytes((_andes_cases_dir() / "matpower" / "case14.m").read_bytes())
    state.load_case(case)
    bridge = state._bridge  # noqa: SLF001
    assert isinstance(bridge, FakeBridge)
    sent = bridge.calls[0][2]["corrections"]
    assert [row[2] for row in sent["transformers"]] == ["8", "9", "10"]


def test_a_refused_load_drops_the_case_held_before(state: SiennaState, workspace: Path) -> None:
    raw = _kundur(workspace)
    state.load_case(raw)
    state.run_pflow()
    dyr = workspace / "kundur_full.dyr"
    dyr.write_bytes((_andes_cases_dir() / "kundur" / "kundur_full.dyr").read_bytes())
    with pytest.raises(CaseLoadError, match="EXDC2"):
        state.load_case(raw, addfiles=[dyr])
    for read in (state.topology, state.operating_point, state.keys, state.reload_case):
        with pytest.raises(NoCaseLoadedError):
            read()
    assert state._session is None  # noqa: SLF001
    # A load after the refusal works.
    assert len(state.load_case(raw).buses) == 10


def test_a_path_outside_the_workspace_never_reaches_the_bridge(
    state: SiennaState, workspace: Path, tmp_path: Path
) -> None:
    outside = tmp_path / "outside.raw"
    outside.write_bytes((_andes_cases_dir() / "kundur" / "kundur.raw").read_bytes())
    with pytest.raises(CaseLoadError, match="not a file in the workspace") as caught:
        state.load_case(outside)
    assert str(tmp_path) not in str(caught.value)
    inside = _kundur(workspace)
    dyr = tmp_path / "outside.dyr"
    dyr.write_text("", encoding="utf-8")
    with pytest.raises(CaseLoadError, match="not a file in the workspace"):
        state.load_case(inside, addfiles=[dyr])
    # A path that climbs out of the workspace is refused the same way.
    with pytest.raises(CaseLoadError, match="not a file in the workspace"):
        state.load_case(workspace / ".." / "outside.raw")
    with pytest.raises(CaseLoadError, match="not a file in the workspace"):
        state.load_case(workspace / "missing.raw")
    bridge = state._bridge  # noqa: SLF001
    assert isinstance(bridge, FakeBridge)
    assert bridge.calls == []


def test_a_state_without_a_workspace_reads_no_file(tmp_path: Path) -> None:
    bridge = FakeBridge()
    state = SiennaState(None, "a" * 32, 1234, bridge=bridge)
    case = tmp_path / "kundur.raw"
    case.write_bytes((_andes_cases_dir() / "kundur" / "kundur.raw").read_bytes())
    with pytest.raises(CaseLoadError, match="workspace"):
        state.load_case(case)
    assert bridge.calls == []


def test_the_scratch_folder_carries_the_owner_marker(state: SiennaState, workspace: Path) -> None:
    from tensa.core.session_dirs import read_owner_marker

    state.load_case(_kundur(workspace))
    marker = read_owner_marker(workspace / ".sessions" / ("a" * 32))
    assert marker is not None
    assert marker.pid == 1234


def test_unmatched_ratings_are_one_warning(
    state: SiennaState, workspace: Path, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tensa.engines.sienna.state as state_module

    real_document = state_module.corrections_document

    def _document_with_strays(facts: Any) -> dict[str, object]:
        document = dict(real_document(facts))
        ratings = list(document["ratings"])  # type: ignore[call-overload]
        document["ratings"] = [*ratings, [98, 99, "1", 10.0], [97, 99, "1", 10.0]]
        return document

    monkeypatch.setattr(state_module, "corrections_document", _document_with_strays)
    with caplog.at_level(logging.INFO, logger="tensa.notice"):
        state.load_case(_kundur(workspace))
    stray = [r for r in caplog.records if "matched no branch" in r.getMessage()]
    assert len(stray) == 1
    assert stray[0].levelno == logging.WARNING
    assert stray[0].getMessage().startswith("2 branch record(s)")
