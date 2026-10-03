"""Snapshot save and restore default to the cheap path; dill is opt-in.

The dill blob (``andes.utils.snapshot.save_ss``) costs a couple of seconds and
2-3 MB per save, it only loads on the ANDES version that wrote it, and ANDES 2.0
cannot load one saved between the power flow and the TDS initialisation on a case
with dynamic models. Restoring from the sidecar JSON (reload, replay the recorded
disturbances, setup, PF) is as fast on the cases we ship and works everywhere, so:

- a save writes only the JSON unless ``include_dill`` is set;
- a restore replays unless ``use_dill_optimization`` is set;
- the opt-in dill path does not reload and replay first (that work was thrown
  away as soon as ``load_ss`` swapped the System in), and a failure on it falls
  back to the replay with the live System untouched.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

import pytest

from tensa.core.disturbance import FaultSpec
from tensa.core.snapshot import SnapshotMetadataError, snapshot_paths
from tensa.core.wrapper import Wrapper

pytestmark = pytest.mark.integration


def _bundled_cases_dir() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases"


def _make_wrapper(tmp_path: Path, *, with_dyr: bool = False) -> tuple[Wrapper, Path]:
    cases = _bundled_cases_dir() / "ieee14"
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    case = workspace / "ieee14.raw"
    shutil.copy2(cases / "ieee14.raw", case)
    addfiles: list[str | Path] | None = None
    if with_dyr:
        shutil.copy2(cases / "ieee14.dyr", workspace / "ieee14.dyr")
        addfiles = [workspace / "ieee14.dyr"]
    w = Wrapper(workspace=workspace, session_id="snapshot-default")
    w.load_case(case, addfiles=addfiles)
    return w, workspace


def _fault(bus_idx: int) -> FaultSpec:
    return FaultSpec(kind="fault", bus_idx=bus_idx, tf=1.0, tc=1.1, xf=0.0001, rf=0.0)


@pytest.fixture
def static_wrapper(tmp_path: Path) -> tuple[Wrapper, Path]:
    """Static-only IEEE 14, where ``load_ss`` round-trips cleanly."""
    return _make_wrapper(tmp_path)


def _forbid(what: str) -> Any:
    def _raise(*_args: object, **_kwargs: object) -> None:
        raise AssertionError(f"{what} must not run on this path")

    return _raise


def test_default_save_writes_only_the_json_and_never_calls_save_ss(
    static_wrapper: tuple[Wrapper, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    w, workspace = static_wrapper
    w.run_pflow()
    monkeypatch.setattr("andes.utils.snapshot.save_ss", _forbid("save_ss"))

    saved = w.save_snapshot("snap")

    assert saved["dill_bytes"] == 0
    assert saved["metadata_bytes"] > 0
    dill_path, json_path = snapshot_paths(workspace, "ieee14.raw", "snap")
    assert json_path.exists()
    assert not dill_path.exists()
    assert [e["has_dill"] for e in w.list_snapshots()] == [False]


def test_default_restore_replays_and_never_calls_load_ss(
    static_wrapper: tuple[Wrapper, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    w, _ = static_wrapper
    w.add_disturbance(_fault(5))
    w.run_pflow()
    w.save_snapshot("snap")
    ss_before = w._ss
    monkeypatch.setattr("andes.utils.snapshot.load_ss", _forbid("load_ss"))

    result = w.restore_snapshot("snap")

    assert result["used_dill"] is False
    assert result["fallback_reason"] is None
    assert result["disturbances_replayed"] == 1
    assert w._ss is not ss_before
    assert w._ss is not None and w._ss.is_setup
    assert w._ss.PFlow.converged
    assert [d.bus_idx for d in w.list_disturbances() if isinstance(d, FaultSpec)] == [5]


def test_opt_in_dill_restore_skips_the_reload_and_the_replay(
    static_wrapper: tuple[Wrapper, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The dill path used to reload the case and re-add every disturbance before
    ``load_ss`` replaced that System, so the opt-in saved nothing."""
    w, _ = static_wrapper
    w.add_disturbance(_fault(5))
    w.run_pflow()
    w.save_snapshot("snap", include_dill=True)
    # State the restore must reset, as a load of a new System does.
    w._se_measurements = object()
    w._setup_failed = True
    ss_before = w._ss

    monkeypatch.setattr(Wrapper, "reload_case", _forbid("reload_case"))
    monkeypatch.setattr(Wrapper, "load_case", _forbid("load_case"))
    monkeypatch.setattr(Wrapper, "add_disturbance", _forbid("add_disturbance"))

    result = w.restore_snapshot("snap", use_dill_optimization=True)

    assert result["used_dill"] is True
    assert result["fallback_reason"] is None
    assert result["disturbances_replayed"] == 1
    assert w._ss is not None and w._ss is not ss_before
    assert w._ss.is_setup
    assert w._ss.PFlow.converged
    assert [d.bus_idx for d in w.list_disturbances() if isinstance(d, FaultSpec)] == [5]
    assert w._se_measurements is None
    assert w._setup_failed is False
    assert w._replay_buffer == []


def test_failed_dill_load_leaves_the_live_system_for_the_replay_to_replace(
    static_wrapper: tuple[Wrapper, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Nothing is touched before ``load_ss`` succeeds, so a failure there costs
    only the replay the default path would have run anyway."""
    w, _ = static_wrapper
    w.add_disturbance(_fault(5))
    w.run_pflow()
    w.save_snapshot("snap", include_dill=True)
    seen: list[object] = []

    def _boom(_path: str) -> object:
        seen.append(w._ss)
        raise IndexError("index 0 is out of bounds for axis 0 with size 0")

    monkeypatch.setattr("andes.utils.snapshot.load_ss", _boom)
    ss_before = w._ss

    result = w.restore_snapshot("snap", use_dill_optimization=True)

    assert seen == [ss_before]  # still the live System when load_ss ran
    assert result["used_dill"] is False
    assert "dill load failed (IndexError)" in result["fallback_reason"]
    assert result["disturbances_replayed"] == 1
    assert w._ss is not ss_before
    assert w._ss is not None and w._ss.PFlow.converged
    assert [d.bus_idx for d in w.list_disturbances() if isinstance(d, FaultSpec)] == [5]


def test_dill_saved_after_pf_on_a_dynamic_case_restores_either_way(
    tmp_path: Path,
) -> None:
    """The real ANDES 2.0 failure behind the fallback: a blob saved after the PF
    but before the TDS init on a case with a ``.dyr`` raises IndexError in
    ``load_ss``. The restore must come back usable whether or not ANDES loads it."""
    w, _ = _make_wrapper(tmp_path, with_dyr=True)
    w.add_disturbance(_fault(5))
    w.run_pflow()
    w.save_snapshot("snap", include_dill=True)

    result = w.restore_snapshot("snap", use_dill_optimization=True)

    if result["used_dill"]:
        assert result["fallback_reason"] is None
    else:
        assert "dill load failed" in result["fallback_reason"]
    assert result["disturbances_replayed"] == 1
    assert w._ss is not None and w._ss.PFlow.converged
    assert len(w.list_disturbances()) == 1


def test_forced_overwrite_without_a_blob_drops_the_old_blob(
    static_wrapper: tuple[Wrapper, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A stale ``.dill`` must not stay beside the new JSON: ``has_dill`` would
    be true and an opted-in restore would load the OLD System state."""
    w, workspace = static_wrapper
    w.run_pflow()
    # A small stand-in blob keeps the test fast; only its presence matters here.
    monkeypatch.setattr(
        "andes.utils.snapshot.save_ss",
        lambda path, _ss: Path(path).write_bytes(b"stale"),
    )
    first = w.save_snapshot("snap", include_dill=True)
    assert first["dill_bytes"] == len(b"stale")
    dill_path, _ = snapshot_paths(workspace, "ieee14.raw", "snap")
    assert dill_path.exists()

    second = w.save_snapshot("snap", force=True)

    assert second["dill_bytes"] == 0
    assert not dill_path.exists()
    assert [e["has_dill"] for e in w.list_snapshots()] == [False]
    result = w.restore_snapshot("snap", use_dill_optimization=True)
    assert result["used_dill"] is False
    assert "not found" in result["fallback_reason"]


def test_malformed_disturbance_log_is_refused_before_the_system_is_touched(
    static_wrapper: tuple[Wrapper, Path],
) -> None:
    """The recorded specs are parsed first, so a bad entry leaves the live
    System and its state alone instead of stranding a half-reloaded one."""
    w, workspace = static_wrapper
    w.add_disturbance(_fault(5))
    w.run_pflow()
    w.save_snapshot("snap")
    _, json_path = snapshot_paths(workspace, "ieee14.raw", "snap")
    meta = json.loads(json_path.read_text(encoding="utf-8"))
    meta["disturbance_log"].append({"kind": "bogus"})
    json_path.write_text(json.dumps(meta), encoding="utf-8")
    ss_before = w._ss

    with pytest.raises(SnapshotMetadataError, match="unknown kind"):
        w.restore_snapshot("snap")

    assert w._ss is ss_before
    assert ss_before is not None and ss_before.PFlow.converged
