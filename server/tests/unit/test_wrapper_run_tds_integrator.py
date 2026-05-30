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

from andes_app.core.errors import SetupFailedError
from andes_app.core.wrapper import Wrapper


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
