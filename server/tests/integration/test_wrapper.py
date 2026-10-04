"""Integration tests for the in-process ANDES wrapper.

These tests drive the ``Wrapper`` class directly (no subprocess, no FastAPI)
against ANDES's bundled IEEE 14 case. They prove the load → setup → run
lifecycle and the disturbance-add contract.

Markers: ``integration`` — these tests import ANDES and run real PF/TDS
against IEEE 14, so they take ~1-5 s each.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from tensa.core.disturbance import FaultSpec
from tensa.core.errors import (
    CaseLoadError,
    DisturbanceCommitError,
    NoCaseLoadedError,
)
from tensa.core.wrapper import Wrapper


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
@pytest.mark.parametrize("h", [0.005, 0.02])
def test_run_tds_honors_requested_fixed_step(h: float) -> None:
    """``h`` must reach ANDES's ``TDS.config.tstep``: the trapezoidal
    integrator then steps at exactly ``h`` instead of the 1/30 s default.

    Regression for the wrapper writing ``config.h`` (a field ANDES 2.0.0
    never reads), which silently ignored every requested step size.
    ``tf`` stays below IEEE 14's first event so no step is clipped to a
    switching time."""
    raw, dyr = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw, addfiles=[dyr])

    times: list[float] = []
    result = w.run_tds(tf=0.5, h=h, on_step=lambda t, _ss: times.append(float(t)))

    dt = np.diff(times)
    # ANDES can emit sub-microsecond tail steps at ``tf`` (float residue);
    # they are not integration steps.
    dt = dt[dt > 1e-6]
    assert np.allclose(dt, h, atol=1e-9), f"steps deviate from h={h}: {np.unique(np.round(dt, 9))}"
    assert len(dt) == round(0.5 / h)
    assert result.converged
    assert result.final_t == pytest.approx(0.5)


@pytest.mark.integration
def test_run_tds_qndf_with_h_stays_variable_step() -> None:
    """Supplying ``h`` on the QNDF path must not turn it into a fixed-step
    run: ``fixt`` stays 0 and the step still adapts. (ANDES 2.0.0 takes the
    QNDF initial step from ``min(1/30, tf/100)``, not from ``tstep``.)"""
    raw, dyr = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw, addfiles=[dyr])

    times: list[float] = []
    result = w.run_tds(
        tf=2.0,
        h=0.005,
        integrator="qndf",
        on_step=lambda t, _ss: times.append(float(t)),
    )
    assert result.converged
    assert result.final_t == pytest.approx(2.0)
    assert int(w._require_loaded().TDS.config.fixt) == 0  # noqa: SLF001

    dt = np.diff(times)
    dt = dt[dt > 1e-6]
    assert np.ptp(dt) > 1e-3, "QNDF step sizes should vary across the run"


@pytest.mark.integration
def test_run_tds_trapezoidal_after_qndf_honors_requested_step() -> None:
    """A trapezoidal run that follows QNDF on the same System must still step
    at ``h``. QNDF leaves ``fixt = 0`` on the config and ANDES keeps the QNDF
    integrator object across a resumed run, so before the wrapper reset both
    the second run ignored ``h`` and kept taking QNDF-sized steps."""
    raw, dyr = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw, addfiles=[dyr])

    first = w.run_tds(tf=0.5, integrator="qndf")
    assert first.converged

    h = 0.004
    times: list[float] = []
    second = w.run_tds(
        tf=1.0,
        h=h,
        integrator="trapezoidal",
        on_step=lambda t, _ss: times.append(float(t)),
    )
    assert second.converged
    assert second.final_t == pytest.approx(1.0)

    dt = np.diff(times)
    dt = dt[dt > 1e-6]
    assert dt.max() <= h + 1e-9, f"a step exceeds h={h}: {np.unique(np.round(dt, 9))}"
    # 0.5 s at 0.004 s is 125 steps; ANDES clips a few to switching times.
    assert len(dt) >= 120, f"only {len(dt)} steps for h={h}"
    assert int(w._require_loaded().TDS.config.fixt) == 1  # noqa: SLF001


@pytest.mark.integration
def test_run_sweep_forwards_step_size_to_tds(tmp_path: Path) -> None:
    """A sweep's ``h`` rides through ``run_tds`` to ANDES: every iteration
    integrates with the requested fixed step (0.2 s / 0.01 s = 20 steps)
    instead of the 1/30 s default."""
    raw, dyr = _ieee14_paths()
    ws = tmp_path / "ws"
    ws.mkdir(mode=0o700)
    w = Wrapper(workspace=ws)
    w.load_case(raw, addfiles=[dyr])
    w.add_disturbance(FaultSpec(bus_idx=5, tf=1.0, tc=1.1))
    w.run_pflow()
    w.save_snapshot("sweep-h")

    result = w.run_sweep(
        snapshot_name="sweep-h",
        parameter_kind="disturbance.fault.tc",
        parameter_target=0,
        values=[1.05],
        tf=0.2,
        h=0.01,
    )
    (iteration,) = result["iterations"]
    assert iteration["error"] is None
    assert iteration["converged"]
    # One callpert per step plus the t=0 call; the 1/30 s default gives ~66.
    assert iteration["callpert_count"] == 21


@pytest.mark.integration
def test_pflow_generator_outputs_are_the_static_generators_only() -> None:
    """kundur_full numbers its GENROU machines 1..4, the same idx as its
    PV/Slack generators. The machines carry no p / q before TDS initialises,
    so reading them wrote a zero row under each idx and overwrote the real
    output of every generator in the case."""
    pytest.importorskip("andes")
    import andes

    w = Wrapper()
    topo = w.load_case(andes.get_case("kundur/kundur_full.xlsx"))
    kinds = {g.kind for g in topo.generators}
    assert {"PV", "Slack", "GENROU"} <= kinds, "the case must hold both halves of a machine"
    static_idx = {str(g.idx) for g in topo.generators if g.kind in ("PV", "Slack")}

    pf = w.run_pflow()
    assert pf.converged
    assert set(pf.generator_outputs) == static_idx
    # A PV row carries its dispatched P (p0 in pu on the 100 MVA system base).
    for g in topo.generators:
        if g.kind == "PV":
            p0 = g.params["p0"]
            assert isinstance(p0, int | float)
            assert pf.generator_outputs[str(g.idx)].p == pytest.approx(p0 * 100.0)
    assert all(out.p > 0.0 for out in pf.generator_outputs.values())


@pytest.mark.integration
def test_pflow_generator_outputs_skip_dynamic_machines_with_their_own_idx() -> None:
    """ieee14_full names its machines GENROU_1..5, so their idx never meets a
    static generator's, but a machine still has no PF output of its own and
    must not show up as a row of zeros."""
    pytest.importorskip("andes")
    import andes

    w = Wrapper()
    topo = w.load_case(andes.get_case("ieee14/ieee14_full.xlsx"))
    machines = {str(g.idx) for g in topo.generators if g.kind == "GENROU"}
    assert machines, "the case must carry GENROU machines"

    pf = w.run_pflow()
    assert pf.converged
    assert machines.isdisjoint(pf.generator_outputs)
    assert pf.generator_outputs["1"].p == pytest.approx(81.427, abs=0.01)  # the slack


@pytest.mark.integration
def test_pflow_line_flows_match_andes_at_both_ends() -> None:
    """The terminal-2 injection is the line's own ``a2`` / ``v2`` equation. ANDES
    evaluates all four terms at the solved state, so its ``e`` arrays are the
    ground truth for both ends, taps and phase shifts included (IEEE 14 has
    four transformers)."""
    raw, _ = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw)
    pf = w.run_pflow()
    assert pf.converged
    line = w._require_loaded().Line
    assert np.any(np.asarray(line.tap.v) != 1.0), "the case must hold a tapped branch"

    for i, idx in enumerate(line.idx.v):
        flow = pf.line_flows[str(idx)]
        assert flow.p == pytest.approx(line.a1.e[i] * 100.0, abs=1e-6)
        assert flow.q == pytest.approx(line.v1.e[i] * 100.0, abs=1e-6)
        assert flow.p_to == pytest.approx(line.a2.e[i] * 100.0, abs=1e-6)
        assert flow.q_to == pytest.approx(line.v2.e[i] * 100.0, abs=1e-6)


@pytest.mark.integration
def test_pflow_line_losses_add_up_to_generation_less_load() -> None:
    """Power is conserved: what the generators inject and the loads draw
    differ by exactly the active power the lines dissipate (IEEE 14's only
    shunt is a pure susceptance, so it takes none)."""
    raw, _ = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw)
    pf = w.run_pflow()
    assert pf.converged

    generation = sum(g.p for g in pf.generator_outputs.values())
    load = sum(ld.p for ld in pf.load_consumption.values())
    losses = [f.loss for f in pf.line_flows.values()]
    assert all(loss >= 0.0 for loss in losses)
    assert sum(losses) == pytest.approx(generation - load, abs=1e-4)


@pytest.mark.integration
def test_pflow_line_loading_is_read_against_the_case_rating() -> None:
    """ieee14.raw rates every branch (20 to 100 MVA); ieee14_full.xlsx rates
    none, so its lines carry no loading rather than a division by zero."""
    pytest.importorskip("andes")
    import andes

    raw, _ = _ieee14_paths()
    rated = Wrapper()
    rated.load_case(raw)
    pf = rated.run_pflow()
    assert pf.converged
    line = rated._require_loaded().Line
    ratings = {str(idx): float(r) for idx, r in zip(line.idx.v, line.rate_a.v, strict=True)}
    assert set(ratings.values()) > {100.0}, "the case must rate branches differently"
    assert set(pf.line_flows) == set(ratings)
    for idx, flow in pf.line_flows.items():
        assert flow.rate_a == ratings[idx]
        s_max = max(np.hypot(flow.p, flow.q), np.hypot(flow.p_to, flow.q_to))
        assert flow.loading_pct == pytest.approx(s_max / ratings[idx] * 100.0)

    unrated = Wrapper()
    unrated.load_case(andes.get_case("ieee14/ieee14_full.xlsx"))
    pf = unrated.run_pflow()
    assert pf.converged
    assert pf.line_flows
    for flow in pf.line_flows.values():
        assert flow.rate_a is None
        assert flow.loading_pct is None


@pytest.mark.integration
def test_line_rating_is_editable_and_changes_the_loading() -> None:
    """``rate_a`` is a line parameter the Inspector can set, so a case that
    carries no ratings can still be checked for overloads."""
    pytest.importorskip("andes")
    import andes

    w = Wrapper()
    w.load_case(andes.get_case("ieee14/ieee14_full.xlsx"))
    w.edit_element("Line", "Line_1", {"rate_a": 40.0})
    pf = w.run_pflow()
    assert pf.converged
    flow = pf.line_flows["Line_1"]
    assert flow.rate_a == 40.0
    assert flow.loading_pct == pytest.approx(
        max(np.hypot(flow.p, flow.q), np.hypot(flow.p_to, flow.q_to)) / 40.0 * 100.0
    )
    assert flow.loading_pct > 100.0  # about 50 MW over a 40 MVA rating
    assert all(f.loading_pct is None for idx, f in pf.line_flows.items() if idx != "Line_1")


@pytest.mark.integration
def test_pflow_generator_outputs_carry_the_reactive_limits() -> None:
    """The power flow does not enforce Q limits, so IEEE 14's generators at buses
    2 and 6 solve to more reactive power than their cases allow. The row says
    both, in MVAr, so a client can tell."""
    raw, _ = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw)
    pf = w.run_pflow()
    assert pf.converged

    pv2 = pf.generator_outputs["2"]
    assert (pv2.q_min, pv2.q_max) == (pytest.approx(-40.0), pytest.approx(15.0))
    assert pv2.q > pv2.q_max  # beyond its upper limit
    pv3 = pf.generator_outputs["3"]
    assert pv3.q_min is not None and pv3.q_max is not None
    assert pv3.q_min < pv3.q < pv3.q_max  # within its limits
    slack = pf.generator_outputs["1"]
    assert (slack.q_min, slack.q_max) == (pytest.approx(-50.0), pytest.approx(100.0))


@pytest.mark.integration
def test_pflow_generator_switched_off_has_no_reactive_limits() -> None:
    raw, _ = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw)
    pv = w._require_loaded().PV
    pv.u.v[list(pv.idx.v).index(3)] = 0  # ``u`` is not an editable parameter
    pf = w.run_pflow()
    assert pf.converged
    off = pf.generator_outputs["3"]
    assert (off.q_min, off.q_max) == (None, None)
    assert pf.generator_outputs["2"].q_max is not None


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
    import zipfile

    target = os.path.join(str(tmp_path), "built.xlsx")  # type: ignore[arg-type]
    w.save_case("xlsx", target)
    assert os.path.getsize(target) > 0
    assert zipfile.is_zipfile(target), "saved xlsx must be a valid (non-empty) zip"
    w.save_case("xlsx", target)  # overwrite
    assert os.path.getsize(target) > 0
    assert zipfile.is_zipfile(target)
    # No hidden temp files left behind in the directory.
    leftovers = [p.name for p in Path(str(tmp_path)).iterdir() if p.name.startswith(".")]
    assert leftovers == [], f"atomic save left temp files: {leftovers}"


@pytest.mark.integration
def test_build_genrou_h_to_m_and_attach_controllers() -> None:
    """A from-scratch GENROU's intuitive ``H`` is converted to ANDES's ``M``
    (=2H), and exciters/governors can be attached to it via the ``syn`` link
    (the UI exposes these as new add-element kinds)."""
    w = Wrapper()
    w.create_blank()
    w.add_element("Bus", {"idx": "1", "name": "B1", "Vn": 16.5})
    w.add_element("Bus", {"idx": "2", "name": "B2", "Vn": 16.5})
    w.add_element("Slack", {"idx": "1", "name": "S1", "bus": "1", "Sn": 100, "Vn": 16.5, "v0": 1.04})
    w.add_element("PQ", {"idx": "L", "bus": "2", "Vn": 16.5, "p0": 0.5, "q0": 0.1})
    w.add_element("Line", {"idx": "Ln", "name": "Ln", "bus1": "1", "bus2": "2", "r": 0.01, "x": 0.1})
    # H=5 must land as M=10 (ANDES GENROU has no H param — it was dropped before).
    w.add_element("GENROU", {"idx": "G", "name": "G", "bus": "1", "gen": "1", "Sn": 100, "Vn": 16.5, "H": 5})
    assert w._ss.GENROU.M.v[w._ss.GENROU.idx2uid("G")] == 10.0

    # Exciter + governor attach to the machine via ``syn``.
    w.add_element("EXST1", {"idx": "exc1", "name": "exc1", "syn": "G", "KA": 20})
    w.add_element("TGOV1", {"idx": "gov1", "name": "gov1", "syn": "G", "R": 0.05})
    assert w._ss.EXST1.n == 1 and w._ss.TGOV1.n == 1

    pf = w.run_pflow()
    assert pf.converged


def _blank_session_with_genrou_prereqs() -> Wrapper:
    """A blank session with the Bus + Slack a GENROU needs to attach to."""
    w = Wrapper()
    w.create_blank()
    w.add_element("Bus", {"idx": "1", "name": "B1", "Vn": 16.5})
    w.add_element(
        "Slack",
        {"idx": "1", "name": "S1", "bus": "1", "Sn": 100, "Vn": 16.5, "v0": 1.04},
    )
    return w


@pytest.mark.integration
def test_build_genrou_full_parameter_set_accepted() -> None:
    """The full standard GENROU set (incl. subtransient reactances + OC time
    constants) is whitelisted, ordering-validated, and lands on the device."""
    w = _blank_session_with_genrou_prereqs()
    entry = w.add_element(
        "GENROU",
        {
            "idx": "G", "name": "G", "bus": "1", "gen": "1",
            "Sn": 100, "Vn": 16.5, "H": 5,
            "xl": 0.0336, "xd": 0.146, "xq": 0.0975,
            "xd1": 0.0608, "xq1": 0.0969,
            "xd2": 0.04, "xq2": 0.06,
            "Td10": 8.96, "Td20": 0.075, "Tq10": 0.31, "Tq20": 0.06,
        },
    )
    assert entry.kind == "GENROU"
    g = w._ss.GENROU
    uid = g.idx2uid("G")
    assert g.xd2.v[uid] == 0.04
    assert g.xq2.v[uid] == 0.06
    assert g.Td10.v[uid] == 8.96
    assert g.Tq20.v[uid] == 0.06


@pytest.mark.integration
def test_build_genrou_partial_textbook_set_rejected_actionably() -> None:
    """Textbook transient values WITHOUT the subtransient set violate the
    merged ordering (ANDES default xd2=0.3 > user xd1=0.0608) → 422 with an
    actionable message naming the silent default. This is the exact scenario
    that previously produced a numerically unstable TDS."""
    from tensa.core.errors import ElementValidationError

    w = _blank_session_with_genrou_prereqs()
    with pytest.raises(ElementValidationError) as ei:
        w.add_element(
            "GENROU",
            {
                "idx": "G", "name": "G", "bus": "1", "gen": "1",
                "Sn": 100, "Vn": 16.5, "H": 5,
                "xd": 0.146, "xd1": 0.0608, "xq": 0.0969, "xq1": 0.0969,
            },
        )
    msg = str(ei.value)
    assert "GENROU reactances must satisfy xd > xd1 > xd2 > xl" in msg
    assert "got xd1=0.0608 <= xd2=0.3" in msg
    assert "xd2 is the ANDES default because you did not set it" in msg
    # Nothing was added — the System has no GENROU device.
    assert w._ss.GENROU.n == 0


@pytest.mark.integration
def test_build_genrou_untouched_reactance_defaults_accepted() -> None:
    """Leaving the whole reactance set at ANDES defaults passes validation
    (the defaults are self-consistent)."""
    w = _blank_session_with_genrou_prereqs()
    w.add_element(
        "GENROU",
        {"idx": "G", "name": "G", "bus": "1", "gen": "1",
         "Sn": 100, "Vn": 16.5, "H": 5},
    )
    assert w._ss.GENROU.n == 1


@pytest.mark.integration
def test_controller_schema_syn_link_uses_syn_idx() -> None:
    """An exciter/governor's machine link renders as a machine picker."""
    from tensa.core.wrapper import _PARAMS_BY_MODEL

    for model in ("TGOV1", "IEEEG1", "SEXS", "IEEEX1", "ESDC2A", "EXST1"):
        metas = _PARAMS_BY_MODEL[model]
        syn = [m for m in metas if m.name == "syn"]
        assert syn and syn[0].kind == "syn_idx" and syn[0].required


@pytest.mark.integration
def test_save_case_failed_write_is_atomic_and_raises(tmp_path: Path) -> None:
    """A writer failure must leave NO 0-byte artifact (the bug behind the
    corrupt 'File is not a zip file' built-3bus.xlsx) and must not clobber a
    prior valid file; it raises CaseSaveError (→ 422)."""
    import zipfile
    from unittest.mock import patch

    from andes.io import xlsx as andes_xlsx

    from tensa.core.errors import CaseSaveError

    raw, _dyr = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw)
    target = tmp_path / "case.xlsx"

    # First a good save so there's a prior valid file to protect.
    w.save_case("xlsx", str(target))
    good_bytes = target.read_bytes()
    assert zipfile.is_zipfile(str(target))

    # Now force the writer to blow up; the atomic path must raise + clean up.
    with (
        patch.object(andes_xlsx, "write", side_effect=RuntimeError("disk full")),
        pytest.raises(CaseSaveError),
    ):
        w.save_case("xlsx", str(target))

    # Prior valid file is untouched (os.replace never ran), no temp left behind.
    assert target.read_bytes() == good_bytes
    leftovers = [p.name for p in tmp_path.iterdir() if p.name.startswith(".")]
    assert leftovers == [], f"failed save left temp files: {leftovers}"


@pytest.mark.integration
def test_load_case_empty_file_raises_friendly_error(tmp_path: Path) -> None:
    """A 0-byte case file fails with an actionable message, not ANDES's raw
    'File is not a zip file'."""
    from tensa.core.errors import CaseLoadError

    empty = tmp_path / "empty.xlsx"
    empty.touch()  # 0 bytes
    assert empty.stat().st_size == 0
    w = Wrapper()
    with pytest.raises(CaseLoadError) as ei:
        w.load_case(str(empty))
    assert "empty or corrupt" in str(ei.value)


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
