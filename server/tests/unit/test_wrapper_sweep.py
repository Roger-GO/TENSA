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
