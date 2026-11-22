"""Unit tests for ``SiennaState``: no Julia, a fake bridge answers the
recorded JSON for a case name and records the calls it got."""

from __future__ import annotations

import json
import logging
import math
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from tensa.core.eig_result import ComplexNumber
from tensa.core.errors import (
    CaseLoadError,
    EigComputationError,
    EigPrerequisiteError,
    ElementNotFoundError,
    NoCaseLoadedError,
    PflowRequestError,
    SiennaError,
)
from tensa.engines.sienna.state import SIENNA_EIG_NOTE, SiennaState, julia_corrections

_SAMPLES = Path(__file__).parent / "sienna_samples"

# The four oscillatory modes the P5-A spike measured for Kundur with its .dyr
# and impedance loads, (frequency Hz, damping ratio).
_SPIKE_MODES = (
    (0.0684, 0.6295),
    (0.6540, 0.0458),
    (1.1077, 0.0921),
    (1.1411, 0.0941),
)

# The states PSID reports for one GENROU + TGOV1 machine, in its order.
_MACHINE_STATES = ("δ", "ω", "eqp", "edp", "pskd", "pskq", "pss", "tg")


def _pole(frequency: float, damping: float) -> complex:
    """The pole of a mode of ``frequency`` Hz damped at ``damping``.

    With wd = 2 * pi * f and wn = wd / sqrt(1 - d^2), z = -d * wn + j * wd has
    |z| = wn, so |Im(z)| / (2 pi) = f and -Re(z) / |z| = d exactly.
    """
    wd = 2 * math.pi * frequency
    wn = wd / math.sqrt(1 - damping**2)
    return complex(-damping * wn, wd)


def _eig_sample() -> dict[str, Any]:
    """The recorded ``eig_json`` answer for Kundur with its .dyr, built in code.

    32 states over the four machines (8 each), the four spike modes plus 28
    real poles, and ``loads`` as the impedance conversion reports it. The
    sample files of the other kinds are recorded JSON; this one is built here
    because the matrix beside it must have exactly these eigenvalues, which a
    constructed block-diagonal matrix guarantees.
    """
    eigenvalues: list[list[float]] = []
    for frequency, damping in _SPIKE_MODES:
        z = _pole(frequency, damping)
        eigenvalues.append([z.real, z.imag])
        eigenvalues.append([z.real, -z.imag])
    for index in range(24):
        eigenvalues.append([-(2.0 + index), 0.0])
    states = [
        {"device": f"generator-{bus}-1", "bus": bus, "id": "1", "state": state}
        for bus in (1, 2, 3, 4)
        for state in _MACHINE_STATES
    ]
    return {
        "ok": True,
        "n_states": 32,
        "stable": True,
        "eigenvalues": eigenvalues,
        "states": states,
        "loads": {"converted": 2, "left": []},
        "notes": [],
    }


def _eig_matrix_bytes() -> bytes:
    """A 32 by 32 matrix whose eigenvalues are the sample's, column-major.

    One 2 by 2 block [[re, -im], [im, re]] per oscillatory mode (its
    eigenvalues are re +/- im*j) and one diagonal entry per real pole, so the
    matrix is block-diagonal and its eigenvalues are exactly the sample's.
    """
    blocks: list[np.ndarray] = []
    for frequency, damping in _SPIKE_MODES:
        z = _pole(frequency, damping)
        blocks.append(np.array([[z.real, -z.imag], [z.imag, z.real]]))
    for index in range(24):
        blocks.append(np.array([[-(2.0 + index)]]))
    matrix = np.zeros((32, 32))
    offset = 0
    for block in blocks:
        size = block.shape[0]
        matrix[offset : offset + size, offset : offset + size] = block
        offset += size
    return matrix.tobytes(order="F")


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
        if kind == "eig":
            return _eig_sample()
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

    def eig(
        self,
        session: Any,
        load_model: str = "impedance",
        matrix_file: Path | None = None,
    ) -> dict[str, Any]:
        self.calls.append(
            ("eig", (session,), {"load_model": load_model, "matrix_file": matrix_file})
        )
        answer = self._sample(session["case"], "eig")
        if answer.get("ok") is False:
            error = SiennaError(str(answer.get("error", "eig failed")))
            error.stage = str(answer.get("stage", "eig"))  # type: ignore[attr-defined]
            raise error
        assert matrix_file is not None
        matrix_file.write_bytes(_eig_matrix_bytes())
        return answer


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


def _kundur_dyr(workspace: Path) -> tuple[Path, Path]:
    raw = _kundur(workspace)
    dyr = workspace / "kundur_full.dyr"
    dyr.write_bytes((_andes_cases_dir() / "kundur" / "kundur_full.dyr").read_bytes())
    return raw, dyr


def _loaded_dyr(state: SiennaState, workspace: Path) -> None:
    raw, dyr = _kundur_dyr(workspace)
    state.load_case(raw, addfiles=[dyr], on_unsupported="drop")
    state.run_pflow()


def test_run_eig_before_a_power_flow_is_refused(state: SiennaState, workspace: Path) -> None:
    raw, dyr = _kundur_dyr(workspace)
    state.load_case(raw, addfiles=[dyr], on_unsupported="drop")
    with pytest.raises(EigPrerequisiteError, match="Run PFlow first"):
        state.run_eig()


def test_run_eig_result_shape(state: SiennaState, workspace: Path) -> None:
    _loaded_dyr(state, workspace)
    result = state.run_eig()
    assert result.mode_count == 32
    assert result.state_count == 32
    assert len(result.eigenvalues) == 32
    assert len(result.damping_ratios) == 32
    assert len(result.frequencies_hz) == 32
    assert len(result.state_names) == 32
    assert result.tds_initialized is True


def test_run_eig_keeps_the_recorded_modes(state: SiennaState, workspace: Path) -> None:
    """The four oscillatory modes of the P5-A table appear; the Python cleaning
    does not move them. The expected values are the spike's measurements."""
    _loaded_dyr(state, workspace)
    result = state.run_eig()
    for frequency, damping in (
        (0.0684, 0.6295),
        (0.6540, 0.0458),
        (1.1077, 0.0921),
        (1.1411, 0.0941),
    ):
        assert any(
            abs(result.frequencies_hz[i] - frequency) <= 5e-4
            and abs(result.damping_ratios[i] - damping) <= 5e-4
            for i in range(result.mode_count)
        ), (frequency, damping)


def test_run_eig_state_names_carry_the_unit_key(state: SiennaState, workspace: Path) -> None:
    _loaded_dyr(state, workspace)
    result = state.run_eig()
    assert len(result.state_names) == 32
    for unit in ("gen:1-1", "gen:2-1", "gen:3-1", "gen:4-1"):
        prefixed = [n for n in result.state_names if n.startswith(unit + " ")]
        assert any("δ" in n for n in prefixed), (unit, prefixed)
        assert any("ω" in n for n in prefixed), (unit, prefixed)
    # The raw Julia device string is not shown.
    assert not [n for n in result.state_names if n.startswith("generator-")]


def test_run_eig_settles_the_zero_eigenvalue(
    state: SiennaState, workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A system with no fixed angle reference has an eigenvalue at zero, which a
    decomposition returns as rounding noise of either sign; it is reported as
    exactly zero with a damping ratio of 1, and no eigenvalue is left within
    the zero tolerance and not settled. The last real pole of the recorded
    matrix is replaced by such noise."""
    noisy = np.frombuffer(_eig_matrix_bytes(), dtype=np.float64).reshape((32, 32), order="F").copy()
    noisy[31, 31] = 3e-14
    monkeypatch.setattr(
        f"{__name__}._eig_matrix_bytes", lambda: noisy.tobytes(order="F")
    )
    _loaded_dyr(state, workspace)
    result = state.run_eig()
    zeros = [i for i, z in enumerate(result.eigenvalues) if z == ComplexNumber(0.0, 0.0)]
    assert zeros, "no eigenvalue was settled to zero"
    for i in zeros:
        assert result.damping_ratios[i] == 1.0
        assert result.frequencies_hz[i] == 0.0
    unsettled = [
        z for z in result.eigenvalues if 0.0 < math.hypot(z.real, z.imag) <= 1e-6
    ]
    assert unsettled == []


def test_run_eig_a_matrix_that_disagrees_with_the_count_is_refused(
    state: SiennaState, workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The matrix file and the answer that named it must describe one analysis:
    PSID reports 32 eigenvalues, so a matrix whose decomposition gives another
    count is a failed analysis, not a result."""
    _loaded_dyr(state, workspace)
    bridge = state._bridge  # noqa: SLF001
    assert isinstance(bridge, FakeBridge)
    original = FakeBridge._sample

    def _one_short(self: FakeBridge, name: str, kind: str) -> dict[str, Any]:
        answer = original(self, name, kind)
        if kind == "eig":
            answer["eigenvalues"] = answer["eigenvalues"][:-1]
        return answer

    monkeypatch.setattr(FakeBridge, "_sample", _one_short)
    with pytest.raises(EigComputationError, match="32 eigenvalues and the analysis reported 31"):
        state.run_eig()


def test_run_eig_participation_is_gone_after_a_new_power_flow(
    state: SiennaState, workspace: Path
) -> None:
    """A new operating point is not the one the analysis linearised at, so the
    participation of the old analysis is no longer served."""
    _loaded_dyr(state, workspace)
    state.run_eig()
    assert state.eig_participation(0)["mode_idx"] == 0
    state.run_pflow()
    with pytest.raises(EigPrerequisiteError, match="EIG has not been run"):
        state.eig_participation(0)


def test_run_eig_load_model(state: SiennaState, workspace: Path) -> None:
    _loaded_dyr(state, workspace)
    state.run_eig(load_model="power")
    bridge = state._bridge  # noqa: SLF001
    assert isinstance(bridge, FakeBridge)
    eig_calls = [c for c in bridge.calls if c[0] == "eig"]
    assert eig_calls[-1][2]["load_model"] == "power"
    with pytest.raises(EigComputationError, match="impedance"):
        state.run_eig(load_model="bad")
    state.run_eig()
    eig_calls = [c for c in bridge.calls if c[0] == "eig"]
    assert eig_calls[-1][2]["load_model"] == "impedance"


def test_run_eig_matrix_file_under_the_scratch(state: SiennaState, workspace: Path) -> None:
    _loaded_dyr(state, workspace)
    state.run_eig()
    bridge = state._bridge  # noqa: SLF001
    assert isinstance(bridge, FakeBridge)
    matrix_file = [c for c in bridge.calls if c[0] == "eig"][-1][2]["matrix_file"]
    assert isinstance(matrix_file, Path)
    assert matrix_file.parent == workspace / ".sessions" / ("a" * 32) / "sienna" / "sim"
    # The file is removed once it is read.
    assert not matrix_file.exists()


def test_run_eig_a_julia_refusal_names_the_stage(
    state: SiennaState, workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _loaded_dyr(state, workspace)
    bridge = state._bridge  # noqa: SLF001
    assert isinstance(bridge, FakeBridge)

    def _refuse(session: Any, load_model: str = "impedance", matrix_file: Any = None) -> Any:
        error = SiennaError("no dynamic injector found")
        error.stage = "build"  # type: ignore[attr-defined]
        raise error

    monkeypatch.setattr(bridge, "eig", _refuse)
    with pytest.raises(EigComputationError, match="build"):
        state.run_eig()


def test_eig_participation(state: SiennaState, workspace: Path) -> None:
    _loaded_dyr(state, workspace)
    with pytest.raises(EigPrerequisiteError, match="run /eig first"):
        state.eig_participation(0)
    result = state.run_eig()
    answer = state.eig_participation(0)
    assert answer["mode_idx"] == 0
    rows = answer["participation"]
    assert isinstance(rows, list)
    assert len(rows) == 32
    assert [row["state_name"] for row in rows] == result.state_names  # type: ignore[index]
    total = sum(float(row["factor"]) for row in rows)  # type: ignore[index]
    assert abs(total - 1.0) <= 1e-4  # each factor is rounded to 5 decimals
    with pytest.raises(ElementNotFoundError, match=r"out of range \[0, 31\]"):
        state.eig_participation(32)
    with pytest.raises(ElementNotFoundError, match=r"out of range \[0, 31\]"):
        state.eig_participation(-1)


def test_a_new_load_and_a_new_power_flow_drop_the_analysis(
    state: SiennaState, workspace: Path
) -> None:
    raw, dyr = _kundur_dyr(workspace)
    state.load_case(raw, addfiles=[dyr], on_unsupported="drop")
    state.run_pflow()
    state.run_eig()
    state.load_case(raw, addfiles=[dyr], on_unsupported="drop")
    with pytest.raises(EigPrerequisiteError, match="run /eig first"):
        state.eig_participation(0)
    state.run_pflow()
    state.run_eig()
    state.run_pflow()
    with pytest.raises(EigPrerequisiteError, match="run /eig first"):
        state.eig_participation(0)


def test_the_standing_note_is_logged(
    state: SiennaState, workspace: Path, caplog: pytest.LogCaptureFixture
) -> None:
    _loaded_dyr(state, workspace)
    with caplog.at_level(logging.INFO, logger="tensa.notice"):
        state.run_eig()
    noted = [r for r in caplog.records if "work in progress in validation" in r.getMessage()]
    assert len(noted) == 1
    assert noted[0].getMessage() == SIENNA_EIG_NOTE


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
    with pytest.raises(NoCaseLoadedError):
        state.run_eig()
    with pytest.raises(NoCaseLoadedError):
        state.eig_participation(0)
    with pytest.raises(NoCaseLoadedError):
        state.list_disturbances()
    with pytest.raises(NoCaseLoadedError):
        state.run_tds(tf=1.0)
    with pytest.raises(NoCaseLoadedError):
        state.init_tds()


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


def test_transformer_charging_goes_with_the_line_charging(tmp_path: Path) -> None:
    """A MATPOWER transformer row with a b (rows 86-87 and 68-116 of case118.m,
    ratio 1) is sent in ``line_charging``, numbered by its row like every
    other, so the Julia module puts back the half of its charging that
    PowerSystems moves onto the from end."""
    case = tmp_path / "three.m"
    case.write_text(
        _THREE_ROWS.replace(
            "\t1\t2\t0.01\t0.1\t0\t0\t0\t0\t0.98\t0\t1\t-360\t360;",
            "\t1\t2\t0.01\t0.1\t0.05\t0\t0\t0\t0.98\t0\t1\t-360\t360;",
        ),
        encoding="utf-8",
    )
    document = _document(case)
    assert document["transformer_charging"] == [[1, 2, "1", 0.05]]
    sent = julia_corrections(case, document)
    assert set(sent) == {"transformers", "line_charging"}
    assert sent["line_charging"] == [[2, 3, "2", 0.02], [3, 2, "3", 0.04], [1, 2, "1", 0.05]]


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
