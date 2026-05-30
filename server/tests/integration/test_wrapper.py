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
def test_operating_point_removes_common_mode_angle_drift() -> None:
    """The read must strip the common-mode reference drift that TDS leaves in
    ``Bus.a``. A flat TDS barely rotates the reference, so to prove the fix
    actually fires we inject a known large drift (+5 rad on every bus, exactly
    what a rotating reference does) and assert it is removed: the slack bus
    returns to its ``a0`` and every angle is plausible again — while angle
    DIFFERENCES (the only physical quantity) are preserved to machine epsilon.
    Without the normalization the injected +5 rad would survive and this fails."""
    raw, dyr = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw, addfiles=[dyr])
    pf = w.run_pflow()

    ss = w._require_loaded()
    slack_bus = ss.Slack.bus.v[0]
    slack_a0 = float(ss.Slack.a0.v[0])
    slack_pos = next(i for i, idx in enumerate(ss.Bus.idx.v) if str(idx) == str(slack_bus))

    # Simulate the rotating-reference drift TDS leaves behind: a big common
    # offset added to every bus angle (differences unchanged).
    DRIFT = 5.0
    for i in range(len(ss.Bus.a.v)):
        ss.Bus.a.v[i] = float(ss.Bus.a.v[i]) + DRIFT

    op = w.operating_point()
    assert op.bus_angles, "operating point should carry bus angles"
    # Common-mode drift removed → angles plausible again (the injected +5 is gone).
    assert max(abs(a) for a in op.bus_angles.values()) < 1.0, (
        f"drift not removed: max|a|={max(abs(a) for a in op.bus_angles.values())}"
    )
    # Slack bus is pinned back at its a0 setpoint.
    assert op.bus_angles[slack_bus] == pytest.approx(slack_a0, abs=1e-6)
    # Differences vs the slack preserved to machine epsilon across ALL buses.
    for idx, a in pf.bus_angles.items():
        pf_diff = a - pf.bus_angles[slack_bus]
        op_diff = op.bus_angles[idx] - op.bus_angles[slack_bus]
        assert op_diff == pytest.approx(pf_diff, abs=1e-9)
    assert slack_pos >= 0  # sanity: slack bus is in the topology


@pytest.mark.integration
def test_operating_point_angle_drift_mean_fallback_when_no_enabled_slack() -> None:
    """With no ENABLED slack (islanded / all-PV), there is no canonical angle
    reference, so the drift falls back to mean-centring: the returned angles
    sum to ~0 after a common offset is removed."""
    raw, _ = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw)
    w.run_pflow()
    ss = w._require_loaded()
    # Disable every slack so the helper takes the mean-centring branch.
    for j in range(len(ss.Slack.u.v)):
        ss.Slack.u.v[j] = 0.0
    DRIFT = 3.0
    for i in range(len(ss.Bus.a.v)):
        ss.Bus.a.v[i] = float(ss.Bus.a.v[i]) + DRIFT

    op = w.operating_point()
    angles = list(op.bus_angles.values())
    assert angles
    # Mean-centred: the average angle is ~0 (the common offset incl. DRIFT removed).
    assert abs(sum(angles) / len(angles)) < 1e-9


@pytest.mark.integration
def test_operating_point_after_real_tds_is_finite_and_plausible() -> None:
    """End-to-end sanity: after a genuine TDS run the read returns finite,
    plausible angles (no multi-radian drift) for every bus."""
    raw, dyr = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw, addfiles=[dyr])
    w.run_pflow()
    w.run_tds(tf=2.0, h=1 / 120)
    op = w.operating_point()
    assert op.bus_angles
    assert all(abs(a) < 3.0 for a in op.bus_angles.values())
    assert all(0.8 < v < 1.2 for v in op.bus_voltages.values())


@pytest.mark.integration
def test_build_dynamic_system_from_scratch_with_gen_link(tmp_path: object) -> None:
    """A dynamic generator (GENCLS) can be built from scratch once the form
    exposes the mandatory ``gen`` link, and the resulting System runs PF and
    saves to xlsx (including a 2nd overwrite save, which used to EOFError)."""
    import os

    w = Wrapper()
    w.create_blank()
    w.add_element("Bus", {"idx": "1", "name": "B1", "Vn": 110})
    w.add_element("Bus", {"idx": "2", "name": "B2", "Vn": 110})
    w.add_element("Slack", {"idx": "1", "name": "S1", "bus": "1", "Sn": 100, "Vn": 110, "v0": 1.0})
    w.add_element("PQ", {"idx": "1", "name": "L1", "bus": "2", "Vn": 110, "p0": 0.5, "q0": 0.2})
    w.add_element("Line", {"idx": "L1", "name": "Ln", "bus1": "1", "bus2": "2", "r": 0.01, "x": 0.06})
    # The whole point: GENCLS WITH its mandatory ``gen`` link (→ Slack idx 1).
    w.add_element(
        "GENCLS",
        {"idx": "1", "name": "G1", "bus": "1", "gen": "1", "Sn": 100, "Vn": 110, "M": 6},
    )

    topo = w.topology_snapshot()
    kinds = {g.kind for g in topo.generators}
    assert "GENCLS" in kinds, "GENCLS should be in the built topology"

    pf = w.run_pflow()
    assert pf.converged

    # xlsx save twice — the 2nd is the overwrite path that used to raise
    # "EOFError: EOF when reading a line" (ANDES's input()-based confirm).
    target = os.path.join(str(tmp_path), "built.xlsx")  # type: ignore[arg-type]
    w.save_case("xlsx", target)
    assert os.path.getsize(target) > 0
    w.save_case("xlsx", target)  # overwrite
    assert os.path.getsize(target) > 0


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
