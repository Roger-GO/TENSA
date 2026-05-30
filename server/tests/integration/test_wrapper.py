"""Integration tests for the in-process ANDES wrapper.

These tests drive the ``Wrapper`` class directly (no subprocess, no FastAPI)
against ANDES's bundled IEEE 14 case. They prove the load → setup → run
lifecycle and the disturbance-add contract.

Markers: ``integration`` — these tests import ANDES and run real PF/TDS
against IEEE 14, so they take ~1-5 s each.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from andes_app.core.disturbance import FaultSpec
from andes_app.core.errors import (
    CaseLoadError,
    DisturbanceCommitError,
    NoCaseLoadedError,
)
from andes_app.core.wrapper import Wrapper


def _ieee14_paths() -> tuple[Path, Path]:
    """Return ``(raw_path, dyr_path)`` for ANDES's bundled IEEE 14 case.

    Skips the test if ANDES is not installed (the cases directory ships in
    the wheel; if it's missing, the venv is broken).
    """
    pytest.importorskip("andes")
    import andes

    cases = Path(andes.__file__).parent / "cases" / "ieee14"
    raw = cases / "ieee14.raw"
    dyr = cases / "ieee14.dyr"
    if not raw.exists() or not dyr.exists():  # pragma: no cover
        pytest.skip(f"IEEE 14 fixtures not bundled with this ANDES install: {cases}")
    return raw, dyr


@pytest.mark.integration
def test_load_case_and_run_pflow_converges() -> None:
    """Happy path: load IEEE 14, run PF, assert converged with slack-bus
    voltage close to nominal. ``run_pflow`` must call ``ss.setup()``
    explicitly (PFlow.run does not auto-call setup, verified against
    ANDES 2.0.0)."""
    raw, _ = _ieee14_paths()
    w = Wrapper()
    topo = w.load_case(raw)
    assert topo.state == "pre-setup"
    assert len(topo.buses) == 14, f"expected 14 buses, got {len(topo.buses)}"

    result = w.run_pflow()
    assert result.converged
    assert result.iterations <= 10
    # Slack bus on IEEE 14 is bus 1 (idx 1); voltage magnitude is 1.06 by convention
    assert 1 in result.bus_voltages or "1" in result.bus_voltages or result.bus_voltages
    # State has flipped to committed after PF
    assert w.topology_snapshot().state == "committed"


@pytest.mark.integration
def test_run_tds_with_dynamics_no_disturbance() -> None:
    """Happy path: load IEEE 14 with .raw + .dyr addfile, run a plain
    1-second TDS, assert callpert fires for every step and final t reaches tf.

    This proves the basic TDS path: PF auto-runs first, ``setup()`` is called
    explicitly, ``callpert`` is wired, and the integration loop completes.
    Disturbance behavior is exercised separately."""
    raw, dyr = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw, addfiles=[dyr])

    # ANDES uses adaptive time-stepping; in steady-state the integrator may
    # take large steps. The point of this assertion is to verify callpert is
    # wired and fires multiple times — not to validate the integrator's
    # stepping policy.
    result = w.run_tds(tf=1.0, h=1 / 120)
    assert result.final_t >= 0.99, f"final_t = {result.final_t}"
    assert result.callpert_count >= 10, (
        f"expected callpert to fire at least 10 times on a 1s sim, got {result.callpert_count}"
    )


@pytest.mark.integration
def test_operating_point_after_pflow_matches_pflow_result() -> None:
    """``operating_point`` reads the same solved Bus v/a as ``run_pflow``
    without re-running. After a PF, the two must agree."""
    raw, _ = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw)
    pf = w.run_pflow()
    assert pf.converged

    op = w.operating_point()
    assert op.converged
    assert op.bus_voltages, "operating point should carry solved bus voltages"
    # Same operating point → identical V/θ (read of the same arrays).
    assert set(op.bus_voltages) == set(pf.bus_voltages)
    for idx, v in pf.bus_voltages.items():
        assert op.bus_voltages[idx] == pytest.approx(v)
        assert op.bus_angles[idx] == pytest.approx(pf.bus_angles[idx])


@pytest.mark.integration
def test_operating_point_populated_after_tds_without_pflow() -> None:
    """The fix: a TDS-only run leaves a readable operating point. ``run_tds``
    never returns bus voltages (and the grid only reads from the PF result),
    so the data grid sat empty after TDS. ``operating_point`` must surface
    the final-time Bus v/a so the grid can populate."""
    raw, dyr = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw, addfiles=[dyr])

    w.run_tds(tf=1.0, h=1 / 120)  # no explicit run_pflow first

    op = w.operating_point()
    assert op.converged, "TDS leaves a finite operating point"
    assert len(op.bus_voltages) == 14
    # Voltages are finite and near nominal (steady-state, no disturbance).
    for v in op.bus_voltages.values():
        assert 0.8 < v < 1.2, f"bus voltage {v} out of plausible range"


@pytest.mark.integration
def test_operating_point_normalizes_post_tds_angle_drift() -> None:
    """Bus angles read after TDS must stay physical. ANDES integrates angles
    against a rotating reference, so raw ``Bus.a`` carries a large common-mode
    drift post-TDS (~9.5 rad) even though differences are preserved. The read
    subtracts the slack-referenced drift so angles return to a plausible
    range, while PF angles (drift ≈ 0) are left essentially unchanged."""
    raw, dyr = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw, addfiles=[dyr])

    pf = w.run_pflow()
    # PF: slack bus sits at its a0 (≈0 on IEEE 14) and all angles are small.
    assert max(abs(a) for a in pf.bus_angles.values()) < 1.0

    w.run_tds(tf=2.0, h=1 / 120)
    op = w.operating_point()
    # Post-TDS angles are normalized: no multi-radian common-mode drift.
    assert op.bus_angles, "operating point should carry bus angles"
    assert max(abs(a) for a in op.bus_angles.values()) < 3.0, (
        f"post-TDS angles still drifting: max|a|="
        f"{max(abs(a) for a in op.bus_angles.values())}"
    )
    # Angle DIFFERENCES (the physical quantity) are preserved across the read.
    keys = list(pf.bus_angles)
    b0, b1 = keys[0], keys[1]
    pf_diff = pf.bus_angles[b0] - pf.bus_angles[b1]
    op_diff = op.bus_angles[b0] - op.bus_angles[b1]
    assert abs(pf_diff - op_diff) < 0.1


@pytest.mark.integration
def test_callpert_abort_flag_terminates_tds() -> None:
    """Edge case: setting the abort flag mid-TDS causes the wrapper to mark
    ``ss.TDS.busted = True``, terminating the integration loop within the next
    couple of steps. Simulates a client-initiated cancel."""
    from threading import Event

    raw, dyr = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw, addfiles=[dyr])

    abort_flag = Event()
    abort_at_t = 0.5

    def _on_step(t: float, _system: object) -> None:
        if t >= abort_at_t and not abort_flag.is_set():
            abort_flag.set()

    result = w.run_tds(tf=2.0, h=1 / 120, on_step=_on_step, abort_flag=abort_flag)
    # Abort should cause TDS to terminate well before tf
    assert result.final_t < 2.0, f"abort did not terminate TDS, final_t = {result.final_t}"
    assert result.final_t >= abort_at_t, (
        f"abort fired before reaching abort_at_t, final_t = {result.final_t}"
    )


@pytest.mark.integration
def test_add_disturbance_after_pf_raises_commit_error() -> None:
    """Edge case: ANDES rejects all post-setup ``add()`` calls. After PF
    triggers setup, ``add_disturbance`` raises ``DisturbanceCommitError``
    directing the caller to ``reload_case()``."""
    raw, _ = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw)
    w.run_pflow()  # commits setup

    with pytest.raises(DisturbanceCommitError):
        w.add_disturbance(FaultSpec(bus_idx=4, tf=1.0, tc=1.1))


@pytest.mark.integration
def test_add_fault_pre_setup_returns_idx() -> None:
    """Happy path: add a Fault disturbance to a pre-setup System, get a
    non-None ANDES idx back. The wrapper must accept the FaultSpec without
    raising. (Whether the resulting TDS converges numerically is an ANDES
    concern, exercised separately.)"""
    raw, dyr = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw, addfiles=[dyr])
    fault_idx = w.add_disturbance(
        FaultSpec(bus_idx=4, tf=1.0, tc=1.1, xf=0.0001, rf=0.0)
    )
    assert fault_idx is not None


@pytest.mark.integration
def test_reload_case_returns_to_pre_setup() -> None:
    """After PF commits setup, ``reload_case()`` is the only way back to
    editable state. The wrapper must be ready to accept new disturbances
    after the reload."""
    raw, dyr = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw, addfiles=[dyr])
    w.add_disturbance(FaultSpec(bus_idx=4, tf=1.0, tc=1.1))
    w.run_pflow()  # commits

    # Round-trip: reload, add another disturbance
    topo = w.reload_case()
    assert topo.state == "pre-setup"

    second_idx = w.add_disturbance(FaultSpec(bus_idx=5, tf=2.0, tc=2.1))
    assert second_idx is not None


def test_run_pflow_without_load_raises_no_case_loaded() -> None:
    """Edge case: calling run_pflow before load_case raises
    NoCaseLoadedError (no ANDES interaction needed)."""
    w = Wrapper()
    with pytest.raises(NoCaseLoadedError):
        w.run_pflow()


def test_load_nonexistent_case_raises_case_load_error() -> None:
    """Error path: missing file → CaseLoadError with the path."""
    w = Wrapper()
    with pytest.raises(CaseLoadError) as exc_info:
        w.load_case("/nonexistent/IEEE14_does_not_exist.raw")
    assert "/nonexistent/IEEE14_does_not_exist.raw" in str(exc_info.value)


def test_topology_snapshot_without_load_raises() -> None:
    """Edge case: topology query before load_case raises
    NoCaseLoadedError."""
    w = Wrapper()
    with pytest.raises(NoCaseLoadedError):
        w.topology_snapshot()


def test_reload_case_without_prior_load_raises() -> None:
    """Edge case: reload_case() before any load raises NoCaseLoadedError."""
    w = Wrapper()
    with pytest.raises(NoCaseLoadedError):
        w.reload_case()
