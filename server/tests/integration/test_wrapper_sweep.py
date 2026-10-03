"""Integration tests for the work ``Wrapper.run_sweep`` does per iteration.

Each iteration needs one fresh System with the snapshot's disturbances (and the
override) added, then a TDS run, and TDS commits setup and solves the power flow
itself. Restoring the snapshot first (load, replay, setup, PF) and reloading again
doubled the parse and the power flow for nothing. The tests count the real ANDES
loads and power-flow solves to pin that.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from tensa.core.disturbance import FaultSpec
from tensa.core.wrapper import Wrapper

pytestmark = pytest.mark.integration


def _ieee14_paths() -> tuple[Path, Path]:
    pytest.importorskip("andes")
    import andes

    cases = Path(andes.__file__).parent / "cases" / "ieee14"
    return cases / "ieee14.raw", cases / "ieee14.dyr"


def _wrapper_with_snapshot(tmp_path: Path, specs: list[FaultSpec], name: str) -> Wrapper:
    raw, dyr = _ieee14_paths()
    ws = tmp_path / "ws"
    ws.mkdir(mode=0o700)
    w = Wrapper(workspace=ws)
    w.load_case(raw, addfiles=[dyr])
    for spec in specs:
        w.add_disturbance(spec)
    w.run_pflow()
    w.save_snapshot(name)
    return w


def _count_andes_work(monkeypatch: pytest.MonkeyPatch) -> dict[str, int]:
    """Count ``andes.load`` calls and ``PFlow.run`` solves from here on."""
    import andes
    from andes.routines.pflow import PFlow

    counts = {"loads": 0, "pflow_runs": 0}
    real_load = andes.load
    real_run = PFlow.run

    def _load(*args: Any, **kwargs: Any) -> Any:
        counts["loads"] += 1
        return real_load(*args, **kwargs)

    def _run(self: Any, *args: Any, **kwargs: Any) -> Any:
        counts["pflow_runs"] += 1
        return real_run(self, *args, **kwargs)

    monkeypatch.setattr(andes, "load", _load)
    monkeypatch.setattr(PFlow, "run", _run)
    return counts


def test_sweep_loads_and_solves_once_per_value_and_adds_each_disturbance_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    w = _wrapper_with_snapshot(
        tmp_path,
        [FaultSpec(bus_idx=3, tf=0.5, tc=0.6), FaultSpec(bus_idx=5, tf=1.0, tc=1.1)],
        "sweep-once",
    )
    counts = _count_andes_work(monkeypatch)

    # What the System holds when each iteration's TDS starts.
    at_tds: list[tuple[list[float], list[float]]] = []
    real_run_tds = Wrapper.run_tds

    def _spy_run_tds(self: Wrapper, *args: Any, **kwargs: Any) -> Any:
        ss = self._require_loaded()
        at_tds.append(
            ([float(v) for v in ss.Fault.tf.v], [float(v) for v in ss.Fault.tc.v])
        )
        return real_run_tds(self, *args, **kwargs)

    monkeypatch.setattr(Wrapper, "run_tds", _spy_run_tds)

    values = [1.05, 1.1, 1.15]
    result = w.run_sweep(
        snapshot_name="sweep-once",
        parameter_kind="disturbance.fault.tc",
        parameter_target=1,
        values=values,
        tf=0.2,
        h=0.01,
    )

    assert [it["parameter_value"] for it in result["iterations"]] == values
    assert [it["error"] for it in result["iterations"]] == [None] * 3
    assert all(it["converged"] for it in result["iterations"])
    assert result["truncated"] is False
    # One parse and one power flow per value (the TDS run's own); the snapshot
    # restore that used to precede each iteration added a second of each.
    assert counts == {"loads": 3, "pflow_runs": 3}
    # Two faults on every iteration (never doubled, never fewer), the first as
    # recorded and the second with the swept ``tc``.
    assert at_tds == [([0.5, 1.0], [0.6, value]) for value in values]


def test_sweep_with_a_target_past_the_snapshot_log_loads_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    w = _wrapper_with_snapshot(
        tmp_path, [FaultSpec(bus_idx=5, tf=1.0, tc=1.1)], "sweep-bad-target"
    )
    counts = _count_andes_work(monkeypatch)

    result = w.run_sweep(
        snapshot_name="sweep-bad-target",
        parameter_kind="disturbance.fault.tc",
        parameter_target=3,
        values=[1.05, 1.1],
        tf=0.2,
        h=0.01,
    )

    errors = [it["error"] for it in result["iterations"]]
    assert len(errors) == 2
    assert all(
        e is not None and e.startswith("SweepValidationError: ") for e in errors
    )
    assert counts == {"loads": 0, "pflow_runs": 0}
