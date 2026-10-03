"""Unit tests for how ``Wrapper.run_sweep`` uses the snapshot.

A sweep reads the snapshot's recorded disturbance log once, then per value only
reloads the case, re-adds the log with the override, and runs TDS. These tests
stub those three steps, so they check the orchestration (how often the snapshot
is read, what is reloaded and added, how a bad snapshot is reported) without
spending a simulation. The integration counterpart, against real ANDES, is
``tests/integration/test_wrapper_sweep.py``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from tensa.core import snapshot as snapshot_module
from tensa.core.disturbance import DisturbanceSpec, FaultSpec, ToggleSpec
from tensa.core.snapshot import (
    SnapshotMetadata,
    snapshot_dir,
    snapshot_paths,
    write_snapshot_files,
)
from tensa.core.wrapper import TdsBatchResult, Wrapper

pytestmark = pytest.mark.unit

FAULT_TC = "disturbance.fault.tc"


class _Recorder:
    """What the stubbed wrapper was asked to do, in order."""

    def __init__(self) -> None:
        self.reloads = 0
        self.added: list[list[DisturbanceSpec]] = []
        self.tds_calls: list[dict[str, Any]] = []
        self.restores = 0
        self.metadata_reads = 0


def _save_snapshot(
    ws: Path, specs: list[DisturbanceSpec], name: str = "base"
) -> None:
    metadata = SnapshotMetadata(
        andes_version="2.0.0",
        tensa_version="0.0.0",
        case_filename="case.raw",
        case_sha256=None,
        disturbance_log=[spec.model_dump() for spec in specs],
        saved_at="2026-01-01T00:00:00Z",
        has_pflow=True,
        has_tds=False,
    )
    snapshot_dir(ws, "case.raw")
    dill_path, json_path = snapshot_paths(ws, "case.raw", name)
    write_snapshot_files(
        dill_path=dill_path, json_path=json_path, dill_writer=None, metadata=metadata
    )


def _stubbed_wrapper(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> tuple[Wrapper, _Recorder]:
    ws = tmp_path / "ws"
    ws.mkdir(mode=0o700)
    w = Wrapper(workspace=ws)
    w._ss = MagicMock()  # noqa: SLF001
    w._case_path = ws / "case.raw"  # noqa: SLF001
    rec = _Recorder()

    def _reload_case() -> None:
        rec.reloads += 1
        rec.added.append([])
        w._disturbance_log = []  # noqa: SLF001

    def _add_disturbance(spec: DisturbanceSpec) -> int:
        rec.added[-1].append(spec)
        w._disturbance_log.append(spec)  # noqa: SLF001
        return len(rec.added[-1])

    def _run_tds(**kwargs: Any) -> TdsBatchResult:
        rec.tds_calls.append(kwargs)
        return TdsBatchResult(converged=True, final_t=kwargs["tf"], callpert_count=7)

    def _restore_snapshot(*_args: object, **_kwargs: object) -> None:
        rec.restores += 1
        raise AssertionError("a sweep must not restore the snapshot per iteration")

    real_read = snapshot_module.read_snapshot_metadata

    def _read_snapshot_metadata(json_path: Path) -> SnapshotMetadata:
        rec.metadata_reads += 1
        return real_read(json_path)

    monkeypatch.setattr(w, "reload_case", _reload_case)
    monkeypatch.setattr(w, "add_disturbance", _add_disturbance)
    monkeypatch.setattr(w, "run_tds", _run_tds)
    monkeypatch.setattr(w, "restore_snapshot", _restore_snapshot)
    monkeypatch.setattr(snapshot_module, "read_snapshot_metadata", _read_snapshot_metadata)
    return w, rec


def test_sweep_reads_the_snapshot_once_and_reloads_once_per_value(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    w, rec = _stubbed_wrapper(tmp_path, monkeypatch)
    keep = FaultSpec(bus_idx=3, tf=0.5, tc=0.6)
    target = FaultSpec(bus_idx=5, tf=1.0, tc=1.1)
    after = ToggleSpec(model="Line", dev_idx="L1", t=1.5)
    _save_snapshot(tmp_path / "ws", [keep, target, after])

    result = w.run_sweep(
        snapshot_name="base",
        parameter_kind=FAULT_TC,
        parameter_target=1,
        values=[1.05, 1.1, 1.2],
        tf=0.2,
        h=0.01,
    )

    assert rec.metadata_reads == 1
    assert rec.restores == 0
    assert rec.reloads == 3
    assert len(rec.tds_calls) == 3
    assert all(call["tf"] == 0.2 and call["h"] == 0.01 for call in rec.tds_calls)
    # Per value: every recorded disturbance, in order, with only the target's
    # ``tc`` replaced.
    for added, value in zip(rec.added, [1.05, 1.1, 1.2], strict=True):
        assert added == [keep, target.model_copy(update={"tc": value}), after]
    assert [it["parameter_value"] for it in result["iterations"]] == [1.05, 1.1, 1.2]
    assert all(it["error"] is None and it["converged"] for it in result["iterations"])
    assert result["truncated"] is False
    assert result["total_requested"] == 3


def test_sweep_does_not_leave_the_override_in_the_snapshot_log(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Each iteration starts from the recorded value, not the previous
    iteration's override (``model_copy`` must not mutate the shared spec)."""
    w, rec = _stubbed_wrapper(tmp_path, monkeypatch)
    target = FaultSpec(bus_idx=5, tf=1.0, tc=1.1)
    _save_snapshot(tmp_path / "ws", [target])

    w.run_sweep(
        snapshot_name="base",
        parameter_kind="disturbance.fault.tf",
        parameter_target=0,
        values=[0.8, 0.9],
        tf=0.2,
    )

    assert [added[0].tf for added in rec.added] == [0.8, 0.9]
    assert [added[0].tc for added in rec.added] == [1.1, 1.1]


@pytest.mark.parametrize(
    ("parameter_kind", "parameter_target", "message"),
    [
        (FAULT_TC, 4, "target index 4 out of range; snapshot recorded 1 disturbance"),
        ("disturbance.toggle.t", 0, "expects 'toggle' disturbance at target 0, found 'fault'"),
    ],
)
def test_sweep_target_problems_fail_every_iteration_without_touching_the_system(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    parameter_kind: str,
    parameter_target: int,
    message: str,
) -> None:
    w, rec = _stubbed_wrapper(tmp_path, monkeypatch)
    _save_snapshot(tmp_path / "ws", [FaultSpec(bus_idx=5, tf=1.0, tc=1.1)])
    seen: list[int] = []

    result = w.run_sweep(
        snapshot_name="base",
        parameter_kind=parameter_kind,
        parameter_target=parameter_target,
        values=[1.0, 1.1, 1.2],
        tf=0.2,
        on_iteration=lambda idx, _value, _result: seen.append(idx),
    )

    iterations = result["iterations"]
    assert len(iterations) == 3
    assert seen == [0, 1, 2]
    for it in iterations:
        assert it["converged"] is False
        assert it["error"] is not None
        assert it["error"].startswith("SweepValidationError: ")
        assert message in it["error"]
    # Nothing to reload or run, and the snapshot is read once, not three times.
    assert rec.reloads == 0
    assert rec.tds_calls == []
    assert rec.metadata_reads == 1


def test_sweep_with_a_missing_snapshot_reports_it_on_every_iteration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    w, rec = _stubbed_wrapper(tmp_path, monkeypatch)

    result = w.run_sweep(
        snapshot_name="nope",
        parameter_kind=FAULT_TC,
        parameter_target=0,
        values=[1.0, 1.1],
        tf=0.2,
    )

    errors = [it["error"] for it in result["iterations"]]
    assert len(errors) == 2
    assert all(e is not None and e.startswith("SnapshotNotFoundError: ") for e in errors)
    assert rec.metadata_reads == 1
    assert rec.reloads == 0
    assert rec.tds_calls == []


def test_sweep_with_a_corrupt_snapshot_reports_it_on_every_iteration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    w, rec = _stubbed_wrapper(tmp_path, monkeypatch)
    ws = tmp_path / "ws"
    _save_snapshot(ws, [FaultSpec(bus_idx=5, tf=1.0, tc=1.1)])
    _, json_path = snapshot_paths(ws, "case.raw", "base")
    meta = json.loads(json_path.read_text(encoding="utf-8"))
    meta["disturbance_log"].append({"kind": "bogus"})
    json_path.write_text(json.dumps(meta), encoding="utf-8")

    result = w.run_sweep(
        snapshot_name="base",
        parameter_kind=FAULT_TC,
        parameter_target=0,
        values=[1.0, 1.1],
        tf=0.2,
    )

    errors = [it["error"] for it in result["iterations"]]
    assert len(errors) == 2
    assert all(e is not None and "unknown kind" in e for e in errors)
    assert rec.reloads == 0
    assert rec.tds_calls == []


def test_sweep_aborted_before_the_first_value_runs_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from threading import Event

    w, rec = _stubbed_wrapper(tmp_path, monkeypatch)
    _save_snapshot(tmp_path / "ws", [FaultSpec(bus_idx=5, tf=1.0, tc=1.1)])
    abort = Event()
    abort.set()

    result = w.run_sweep(
        snapshot_name="base",
        parameter_kind=FAULT_TC,
        parameter_target=0,
        values=[1.0, 1.1],
        tf=0.2,
        abort_flag=abort,
    )

    assert result["iterations"] == []
    assert result["truncated"] is True
    assert rec.reloads == 0
    assert rec.tds_calls == []


def test_sweep_resets_the_log_a_blank_session_reload_leaves_behind(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``reload_case`` clears the disturbance log for a case file but not when it
    rebuilds a blank session, so the sweep clears it itself and each iteration
    adds the recorded disturbances exactly once."""
    w, rec = _stubbed_wrapper(tmp_path, monkeypatch)
    _save_snapshot(tmp_path / "ws", [FaultSpec(bus_idx=5, tf=1.0, tc=1.1)])
    stale = ToggleSpec(model="Line", dev_idx="L9", t=9.0)

    def _blank_reload() -> None:
        rec.reloads += 1
        rec.added.append([])
        # A blank-session reload keeps whatever the log held.
        w._disturbance_log = [stale]  # noqa: SLF001

    monkeypatch.setattr(w, "reload_case", _blank_reload)

    w.run_sweep(
        snapshot_name="base",
        parameter_kind=FAULT_TC,
        parameter_target=0,
        values=[1.05, 1.15],
        tf=0.2,
    )

    assert w.list_disturbances() == [FaultSpec(bus_idx=5, tf=1.0, tc=1.15)]
    assert [len(added) for added in rec.added] == [1, 1]


# ---- the pieces a parallel sweep runs on --------------------------------------


def test_the_plan_is_the_checked_snapshot_log_and_the_case_to_reload(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    w, rec = _stubbed_wrapper(tmp_path, monkeypatch)
    ws = tmp_path / "ws"
    w._addfiles = [ws / "case.dyr"]  # noqa: SLF001
    keep = FaultSpec(bus_idx=3, tf=0.5, tc=0.6)
    target = FaultSpec(bus_idx=5, tf=1.0, tc=1.1)
    _save_snapshot(ws, [keep, target])

    plan = w.sweep_plan(snapshot_name="base", parameter_kind=FAULT_TC, parameter_target=1)

    assert plan == {
        "source": {
            "case_path": str(ws / "case.raw"),
            "addfiles": [str(ws / "case.dyr")],
            "replay": [],
        },
        "specs": [keep.model_dump(), target.model_dump()],
    }
    # Planning only reads: nothing is reloaded, added or run.
    assert rec.reloads == 0
    assert rec.tds_calls == []
    assert rec.metadata_reads == 1


@pytest.mark.parametrize(
    ("snapshot", "parameter_kind", "parameter_target", "error", "message"),
    [
        ("base", FAULT_TC, 4, "SweepValidationError", "target index 4 out of range"),
        ("base", "disturbance.toggle.t", 0, "SweepValidationError", "expects 'toggle'"),
        ("nope", FAULT_TC, 0, "SnapshotNotFoundError", ""),
        ("base", "disturbance.fault.bogus", 0, "SweepValidationError", "unknown sweep parameter"),
    ],
)
def test_the_plan_refuses_what_a_sweep_would_record_against_every_iteration(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    snapshot: str,
    parameter_kind: str,
    parameter_target: int,
    error: str,
    message: str,
) -> None:
    """The server runs such a sweep on the session's worker instead, so that the
    error shows up on every iteration exactly as it always has."""
    w, _ = _stubbed_wrapper(tmp_path, monkeypatch)
    _save_snapshot(tmp_path / "ws", [FaultSpec(bus_idx=5, tf=1.0, tc=1.1)])

    with pytest.raises(Exception, match=message or None) as caught:
        w.sweep_plan(
            snapshot_name=snapshot,
            parameter_kind=parameter_kind,
            parameter_target=parameter_target,
        )

    assert type(caught.value).__name__ == error


def test_the_plan_needs_a_workspace() -> None:
    from tensa.core.errors import NoCaseLoadedError

    with pytest.raises(NoCaseLoadedError, match="requires a workspace"):
        Wrapper().sweep_plan(snapshot_name="base", parameter_kind=FAULT_TC, parameter_target=0)


def test_a_case_file_session_is_its_path_and_add_on_files(tmp_path: Path) -> None:
    w = Wrapper(workspace=tmp_path)
    w._case_path = tmp_path / "case.raw"  # noqa: SLF001
    w._addfiles = [tmp_path / "a.dyr", tmp_path / "b.dyr"]  # noqa: SLF001

    assert w.sweep_source() == {
        "case_path": str(tmp_path / "case.raw"),
        "addfiles": [str(tmp_path / "a.dyr"), str(tmp_path / "b.dyr")],
        "replay": [],
    }


def test_a_blank_session_is_the_additions_that_rebuild_it(tmp_path: Path) -> None:
    w = Wrapper(workspace=tmp_path)
    w._replay_buffer = [("Bus", {"idx": "1", "Vn": 110}), ("PQ", {"bus": "1", "p0": 0.5})]  # noqa: SLF001

    source = w.sweep_source()

    assert source == {
        "case_path": None,
        "addfiles": None,
        "replay": [("Bus", {"idx": "1", "Vn": 110}), ("PQ", {"bus": "1", "p0": 0.5})],
    }
    # A copy: editing the session afterwards cannot reach a source already handed out.
    w._replay_buffer[0][1]["Vn"] = 220  # noqa: SLF001
    assert source["replay"][0][1]["Vn"] == 110


def test_a_session_with_no_case_has_no_source(tmp_path: Path) -> None:
    from tensa.core.errors import NoCaseLoadedError

    with pytest.raises(NoCaseLoadedError, match="no case has been loaded"):
        Wrapper(workspace=tmp_path).sweep_source()


def test_adopting_a_case_file_source_makes_reload_load_that_case(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    loads: list[tuple[Path, list[str] | None]] = []

    def _load_case(self: Wrapper, path: Any, addfiles: Any = None) -> None:
        loads.append((Path(path), addfiles))

    monkeypatch.setattr(Wrapper, "load_case", _load_case)
    original = Wrapper(workspace=tmp_path)
    original._case_path = tmp_path / "case.raw"  # noqa: SLF001
    original._addfiles = [tmp_path / "case.dyr"]  # noqa: SLF001
    original.reload_case()

    sub = Wrapper(workspace=tmp_path)
    sub.adopt_sweep_source(original.sweep_source())
    sub.reload_case()

    assert len(loads) == 2
    assert loads[0] == loads[1] == (tmp_path / "case.raw", [str(tmp_path / "case.dyr")])


def test_adopting_a_source_forgets_the_wrapper_s_previous_system(tmp_path: Path) -> None:
    sub = Wrapper(workspace=tmp_path)
    sub._ss = MagicMock()  # noqa: SLF001
    sub._setup_failed = True  # noqa: SLF001
    sub._disturbance_log = [FaultSpec(bus_idx=1, tf=1.0, tc=1.1)]  # noqa: SLF001

    sub.adopt_sweep_source({"case_path": str(tmp_path / "case.raw"), "addfiles": None, "replay": []})

    assert sub._ss is None  # noqa: SLF001
    assert sub._setup_failed is False  # noqa: SLF001
    assert sub.list_disturbances() == []
    assert sub._case_path == tmp_path / "case.raw"  # noqa: SLF001
    assert sub._addfiles is None  # noqa: SLF001


def test_a_sub_worker_iteration_records_what_the_sweep_records_for_that_value(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``run_sweep_iteration`` is the unit of work a sub-worker is handed. For the
    same value it must produce the dict ``run_sweep`` records, built from specs
    that arrived over a pipe as plain dicts."""
    w, rec = _stubbed_wrapper(tmp_path, monkeypatch)
    keep = FaultSpec(bus_idx=3, tf=0.5, tc=0.6)
    target = FaultSpec(bus_idx=5, tf=1.0, tc=1.1)
    _save_snapshot(tmp_path / "ws", [keep, target])
    values = [1.05, 1.1, 1.2]
    whole = w.run_sweep(
        snapshot_name="base",
        parameter_kind=FAULT_TC,
        parameter_target=1,
        values=values,
        tf=0.2,
        h=0.01,
    )
    rec.added.clear()
    rec.tds_calls.clear()
    reads = rec.metadata_reads

    plan = w.sweep_plan(snapshot_name="base", parameter_kind=FAULT_TC, parameter_target=1)
    specs = [FaultSpec(**d) for d in plan["specs"]]
    pieces = [
        w.run_sweep_iteration(
            index=i,
            value=v,
            specs=specs,
            parameter_kind=FAULT_TC,
            parameter_target=1,
            tf=0.2,
            h=0.01,
        )
        for i, v in enumerate(values)
    ]

    assert pieces == whole["iterations"]
    # The snapshot was read by the plan, once, and by no iteration.
    assert rec.metadata_reads == reads + 1
    for added, value in zip(rec.added, values, strict=True):
        assert added == [keep, target.model_copy(update={"tc": value})]


def test_a_sub_worker_iteration_that_fails_is_recorded_not_raised(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    w, _ = _stubbed_wrapper(tmp_path, monkeypatch)

    def _diverge(**_kwargs: Any) -> TdsBatchResult:
        raise RuntimeError("did not converge")

    monkeypatch.setattr(w, "run_tds", _diverge)

    result = w.run_sweep_iteration(
        index=4,
        value=1.2,
        specs=[FaultSpec(bus_idx=5, tf=1.0, tc=1.1)],
        parameter_kind=FAULT_TC,
        parameter_target=0,
        tf=0.2,
    )

    assert result["iteration"] == 4
    assert result["parameter_value"] == 1.2
    assert result["converged"] is False
    assert result["error"] == "RuntimeError: did not converge"


@pytest.mark.parametrize("bad", [0, -1.0, float("nan"), float("inf")])
def test_a_sub_worker_iteration_refuses_a_bad_step_instead_of_recording_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, bad: float
) -> None:
    from tensa.core.errors import SetupFailedError

    w, rec = _stubbed_wrapper(tmp_path, monkeypatch)

    with pytest.raises(SetupFailedError, match="step size 'h'"):
        w.run_sweep_iteration(
            index=0,
            value=1.0,
            specs=[FaultSpec(bus_idx=5, tf=1.0, tc=1.1)],
            parameter_kind=FAULT_TC,
            parameter_target=0,
            tf=0.2,
            h=bad,
        )

    assert rec.reloads == 0
