"""Unit tests for Wrapper.run_tds integrator + overrides plumbing (Unit 16).

These tests stub ``ss.TDS.run`` so they don't actually integrate; the
goal is to verify that the wrapper sets the right ANDES config fields
(``method`` / ``fixt`` / ``reltol`` / ``abstol`` / ``dtmax``) before
invoking the substrate. The integration-level "QNDF actually completes
on a stiff case" test lives in tests/integration/test_tds_adaptive_api.py.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

pytest.importorskip("andes")

from tensa.core.errors import SetupFailedError
from tensa.core.wrapper import Wrapper


def _ieee14_raw() -> Path:
    import andes

    return Path(andes.__file__).parent / "cases" / "ieee14" / "ieee14.raw"


@pytest.fixture
def loaded_wrapper() -> Wrapper:
    """A wrapper with IEEE 14 loaded + setup committed.

    We intercept ``ss.TDS.run`` with a no-op so the integrator-config
    assertions can run without spending the ~2s of an actual TDS sim.
    The wrapper still calls ``setup()`` + PFlow first so the config
    bindings (``ss.TDS.config``) are real ANDES objects.
    """
    raw = _ieee14_raw()
    if not raw.exists():
        pytest.skip(f"IEEE 14 fixture missing at {raw}")
    w = Wrapper()
    w.load_case(raw)
    w._ensure_setup()  # type: ignore[attr-defined]  # noqa: SLF001
    # Run PF to satisfy the wrapper's PF-converged precondition.
    ss = w._require_loaded()  # type: ignore[attr-defined]  # noqa: SLF001
    ss.PFlow.run()
    # Patch TDS.run to a no-op so we can inspect config without sim cost.
    ss.TDS.run = MagicMock(return_value=None)
    return w


def test_run_tds_default_integrator_is_trapezoidal(loaded_wrapper: Wrapper) -> None:
    """Default integrator preserves v1.0 behaviour (trapezoidal/fixed-step).

    ``ss.TDS.config.method`` should be ``"trapezoid"`` (ANDES wire name)
    and ``fixt`` is left alone (ANDES default).
    """
    w = loaded_wrapper
    ss = w._require_loaded()  # noqa: SLF001
    w.run_tds(tf=0.1, h=1 / 120)
    assert ss.TDS.config.method == "trapezoid"


def test_run_tds_qndf_sets_method_and_fixt_zero(loaded_wrapper: Wrapper) -> None:
    """``integrator='qndf'`` must flip both ``method`` AND ``fixt``.

    QNDF requires ``fixt=0`` so ANDES enables LTE-driven step control
    (verified at andes/routines/tds.py:1278). The wrapper sets it
    explicitly so the caller doesn't have to know that detail.
    """
    w = loaded_wrapper
    ss = w._require_loaded()  # noqa: SLF001
    w.run_tds(tf=0.1, integrator="qndf")
    assert ss.TDS.config.method == "qndf"
    assert int(ss.TDS.config.fixt) == 0


def test_run_tds_overrides_map_to_andes_field_names(loaded_wrapper: Wrapper) -> None:
    """Wrapper-canonical override keys map to ANDES field names.

    rtol → reltol, atol → abstol, max_step → dtmax. The mapping is the
    only place this knowledge lives; the rest of the stack uses the
    wrapper-canonical names.
    """
    w = loaded_wrapper
    ss = w._require_loaded()  # noqa: SLF001
    w.run_tds(
        tf=0.1,
        integrator="qndf",
        tds_config_overrides={
            "rtol": 1e-3,
            "atol": 1e-6,
            "max_step": 0.05,
        },
    )
    assert float(ss.TDS.config.reltol) == pytest.approx(1e-3)
    assert float(ss.TDS.config.abstol) == pytest.approx(1e-6)
    assert float(ss.TDS.config.dtmax) == pytest.approx(0.05)


def test_run_tds_unknown_override_key_raises(loaded_wrapper: Wrapper) -> None:
    """Unknown override keys are caller bugs — surface as SetupFailedError.

    Keeps the wrapper a strict gatekeeper; we don't silently set arbitrary
    ANDES fields from the wire. ``bogus`` is neither a canonical alias nor a
    real ``ss.TDS.config`` field, so it must raise.
    """
    w = loaded_wrapper
    with pytest.raises(SetupFailedError, match="unknown TDS override key"):
        w.run_tds(
            tf=0.1,
            integrator="qndf",
            tds_config_overrides={"bogus": 1.0},
        )


def test_run_tds_freeform_real_andes_config_key_applies(
    loaded_wrapper: Wrapper,
) -> None:
    """A genuine ``ss.TDS.config`` field name (not a canonical alias) is set
    directly — this is the GUI free-form override editor's contract.

    ``tol`` and ``max_iter`` are real ANDES TDS.config fields the GUI
    advertises in its datalist + help text; they must round-trip onto the
    live config rather than being rejected.
    """
    w = loaded_wrapper
    ss = w._require_loaded()  # noqa: SLF001
    w.run_tds(
        tf=0.1,
        integrator="qndf",
        tds_config_overrides={"tol": 1e-5, "max_iter": 25},
    )
    assert float(ss.TDS.config.tol) == pytest.approx(1e-5)
    assert int(ss.TDS.config.max_iter) == 25


def test_run_tds_trapezoidal_does_not_force_fixt(loaded_wrapper: Wrapper) -> None:
    """Trapezoidal selection should NOT alter ``fixt`` from ANDES default.

    Only the QNDF branch flips ``fixt=0``; trapezoidal-fixed-step is the
    ANDES default with ``fixt=1`` and the wrapper preserves that.
    """
    w = loaded_wrapper
    ss = w._require_loaded()  # noqa: SLF001
    fixt_before = int(ss.TDS.config.fixt)
    w.run_tds(tf=0.1, h=1 / 120, integrator="trapezoidal")
    assert int(ss.TDS.config.fixt) == fixt_before


# ---- step size (h -> ss.TDS.config.tstep) --------------------------------
#
# ANDES 2.0.0 reads the integration step from ``TDS.config.tstep``. ``Config``
# accepts any attribute name silently, so the wrapper once wrote ``config.h``
# (never read) and every requested step was ignored. The real-integration
# check lives in tests/integration/test_wrapper.py.


def test_run_tds_h_sets_andes_tstep(loaded_wrapper: Wrapper) -> None:
    """``h`` lands on ``config.tstep`` and no stray ``config.h`` is created."""
    w = loaded_wrapper
    ss = w._require_loaded()  # noqa: SLF001
    w.run_tds(tf=0.1, h=0.005)
    assert float(ss.TDS.config.tstep) == pytest.approx(0.005)
    assert "h" not in ss.TDS.config.as_dict(refresh=True)


def test_run_tds_without_h_keeps_andes_default_step(loaded_wrapper: Wrapper) -> None:
    """``h=None`` must not touch ``tstep`` (ANDES default, 1/30 s)."""
    w = loaded_wrapper
    ss = w._require_loaded()  # noqa: SLF001
    tstep_before = float(ss.TDS.config.tstep)
    w.run_tds(tf=0.1)
    assert float(ss.TDS.config.tstep) == pytest.approx(tstep_before)
    assert tstep_before == pytest.approx(1 / 30)


def test_run_tds_qndf_with_h_sets_tstep_and_keeps_variable_step(
    loaded_wrapper: Wrapper,
) -> None:
    """The QNDF path records ``h`` the same way and still forces ``fixt=0``."""
    w = loaded_wrapper
    ss = w._require_loaded()  # noqa: SLF001
    w.run_tds(tf=0.1, h=0.005, integrator="qndf")
    assert float(ss.TDS.config.tstep) == pytest.approx(0.005)
    assert ss.TDS.config.method == "qndf"
    assert int(ss.TDS.config.fixt) == 0


def test_run_tds_missing_tstep_field_raises(loaded_wrapper: Wrapper) -> None:
    """If a future ANDES drops ``tstep`` the wrapper must fail loudly rather
    than silently writing a field ANDES never reads."""
    w = loaded_wrapper
    ss = w._require_loaded()  # noqa: SLF001
    delattr(ss.TDS.config, "tstep")
    with pytest.raises(SetupFailedError, match="tstep"):
        w.run_tds(tf=0.1, h=0.005)
    assert not hasattr(ss.TDS.config, "tstep")
    # Without ``h`` the field is never consulted, so the run still proceeds.
    w.run_tds(tf=0.1)
