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

from tensa.core.errors import NoCaseLoadedError, SetupFailedError
from tensa.core.wrapper import (
    Wrapper,
    tds_fixed_step,
    validate_step_size,
    validate_tds_overrides,
)


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


def test_run_tds_trapezoidal_sets_fixed_step(loaded_wrapper: Wrapper) -> None:
    """Trapezoidal selection sets ``fixt = 1`` on every run, not just on the
    first one, so ``h`` is a fixed step whatever the System ran before."""
    w = loaded_wrapper
    ss = w._require_loaded()  # noqa: SLF001
    w.run_tds(tf=0.1, h=1 / 120, integrator="trapezoidal")
    assert int(ss.TDS.config.fixt) == 1


def test_run_tds_trapezoidal_restores_fixt_after_qndf(
    loaded_wrapper: Wrapper,
) -> None:
    """QNDF leaves ``fixt = 0`` on the System's config. A later trapezoidal
    run must put it back, or ANDES ignores ``h`` (``_calc_h_first`` only
    reads ``tstep`` when ``fixt`` is set)."""
    w = loaded_wrapper
    ss = w._require_loaded()  # noqa: SLF001
    w.run_tds(tf=0.1, integrator="qndf")
    assert int(ss.TDS.config.fixt) == 0
    w.run_tds(tf=0.1, h=0.005, integrator="trapezoidal")
    assert int(ss.TDS.config.fixt) == 1
    assert float(ss.TDS.config.tstep) == pytest.approx(0.005)
    assert ss.TDS.config.method == "trapezoid"


def test_run_tds_fixt_override_still_wins(loaded_wrapper: Wrapper) -> None:
    """Overrides are applied after the integrator, so an explicit ``fixt``
    from the free-form editor is not clobbered by the per-run default."""
    w = loaded_wrapper
    ss = w._require_loaded()  # noqa: SLF001
    w.run_tds(
        tf=0.1,
        integrator="trapezoidal",
        tds_config_overrides={"fixt": 0},
    )
    assert int(ss.TDS.config.fixt) == 0


def test_run_tds_trapezoidal_replaces_a_live_qndf_method(
    loaded_wrapper: Wrapper,
) -> None:
    """ANDES builds its integrator object in ``TDS.init()`` only, so on a
    System that has already run, ``config.method`` alone changes nothing and
    a trapezoidal run after QNDF would keep stepping with QNDF. The wrapper
    swaps the object itself."""
    w = loaded_wrapper
    ss = w._require_loaded()  # noqa: SLF001
    ss.TDS.set_method("qndf")
    ss.TDS.initialized = True  # as after a completed run
    w.run_tds(tf=0.1, h=0.005, integrator="trapezoidal")
    assert type(ss.TDS.method).__name__ == "Trapezoid"
    assert bool(ss.TDS.method.requires_variable_step) is False


def test_run_tds_leaves_the_method_object_to_init_before_the_first_run(
    loaded_wrapper: Wrapper,
) -> None:
    """Before ``TDS.init()`` ANDES builds the integrator from
    ``config.method``; the wrapper must not pre-empt that."""
    w = loaded_wrapper
    ss = w._require_loaded()  # noqa: SLF001
    ss.TDS.set_method("qndf")
    assert not bool(ss.TDS.initialized)
    w.run_tds(tf=0.1, integrator="trapezoidal")
    assert type(ss.TDS.method).__name__ == "QNDF"
    assert ss.TDS.config.method == "trapezoid"


def test_run_tds_qndf_refuses_a_system_that_already_ran_trapezoidally(
    loaded_wrapper: Wrapper,
) -> None:
    """QNDF needs the history cache ``TDS.init()`` builds, and a System that has
    already run skips ``init()``. Carrying the request out would step with the
    trapezoidal object under a QNDF config, so the wrapper refuses, before any
    config write."""
    w = loaded_wrapper
    ss = w._require_loaded()  # noqa: SLF001
    ss.TDS.initialized = True  # as after a completed run; the object is Trapezoid
    assert type(ss.TDS.method).__name__ == "Trapezoid"

    def _config() -> tuple[object, ...]:
        cfg = ss.TDS.config
        return (cfg.method, int(cfg.fixt), float(cfg.tstep), float(cfg.tf))

    before = _config()
    with pytest.raises(SetupFailedError, match="cannot replace the trapezoidal integrator"):
        w.run_tds(tf=0.3, h=0.005, integrator="qndf")
    assert _config() == before
    assert type(ss.TDS.method).__name__ == "Trapezoid"
    ss.TDS.run.assert_not_called()  # type: ignore[attr-defined]


def test_run_tds_qndf_continues_a_system_that_already_runs_qndf(
    loaded_wrapper: Wrapper,
) -> None:
    """The refusal is about the integrator object, not about a second run."""
    w = loaded_wrapper
    ss = w._require_loaded()  # noqa: SLF001
    ss.TDS.set_method("qndf")
    ss.TDS.initialized = True
    w.run_tds(tf=0.3, integrator="qndf")
    assert type(ss.TDS.method).__name__ == "QNDF"
    ss.TDS.run.assert_called_once()  # type: ignore[attr-defined]


def _tds_config(w: Wrapper) -> tuple[object, ...]:
    cfg = w._require_loaded().TDS.config  # noqa: SLF001
    return (cfg.method, int(cfg.fixt), float(cfg.tstep), float(cfg.tf))


# ---- check_tds_request: the refusals a caller can ask for up front -----------
#
# The streaming handler sends its stream-start frame before ``run_tds`` runs, so
# it asks the wrapper whether the run would be refused first.


def test_check_tds_request_refuses_qndf_on_a_system_that_ran_trapezoidally(
    loaded_wrapper: Wrapper,
) -> None:
    w = loaded_wrapper
    ss = w._require_loaded()  # noqa: SLF001
    ss.TDS.initialized = True  # as after a completed run; the object is Trapezoid
    before = _tds_config(w)
    with pytest.raises(SetupFailedError, match="cannot replace the trapezoidal integrator"):
        w.check_tds_request("qndf")
    assert _tds_config(w) == before


def test_check_tds_request_refuses_an_unknown_override_key(
    loaded_wrapper: Wrapper,
) -> None:
    w = loaded_wrapper
    before = _tds_config(w)
    with pytest.raises(SetupFailedError, match="unknown TDS override key 'bogus'"):
        w.check_tds_request("trapezoidal", {"rtol": 1e-3, "bogus": 1.0})
    assert _tds_config(w) == before


def test_check_tds_request_accepts_every_runnable_request(
    loaded_wrapper: Wrapper,
) -> None:
    """Nothing the wrapper would carry out is refused, and checking writes
    nothing: the same request still runs afterwards."""
    w = loaded_wrapper
    ss = w._require_loaded()  # noqa: SLF001
    overrides = {"rtol": 1e-3, "atol": 1e-6, "max_step": 0.05, "fixt": 0, "tol": 1e-5}
    before = _tds_config(w)

    # A System that has not run yet takes either integrator.
    w.check_tds_request("trapezoidal")
    w.check_tds_request("qndf", overrides)
    assert _tds_config(w) == before

    # One that already runs QNDF keeps it, and can go back to trapezoidal.
    ss.TDS.set_method("qndf")
    ss.TDS.initialized = True
    w.check_tds_request("qndf")
    w.check_tds_request("trapezoidal", overrides)

    # So does one that ran trapezoidally and stays on it.
    ss.TDS.set_method("trapezoid")
    w.check_tds_request("trapezoidal")


def test_check_tds_request_needs_a_loaded_case() -> None:
    with pytest.raises(NoCaseLoadedError):
        Wrapper().check_tds_request("trapezoidal")


def test_run_tds_unknown_override_key_leaves_the_system_untouched(
    loaded_wrapper: Wrapper,
) -> None:
    """The refusal comes before the step size, integrator, and ``tf`` are
    written, so a rejected request cannot change the next run's configuration."""
    w = loaded_wrapper
    before = _tds_config(w)
    with pytest.raises(SetupFailedError, match="unknown TDS override key"):
        w.run_tds(
            tf=0.7,
            h=0.005,
            integrator="qndf",
            tds_config_overrides={"bogus": 1.0},
        )
    assert _tds_config(w) == before


# ---- override values: the step rule holds for ``tstep`` and ``max_step`` too ---
#
# ``h`` is checked on every way in, but an override is written to the same
# ``ss.TDS.config`` field. ANDES logs "Fixed time step must be positive" for a
# ``tstep`` of 0 or less and then leaves ``fixt = 0`` on the System, so a bad
# override has to be refused before any config write, like a bad ``h``.

_BAD_OVERRIDES: list[tuple[dict[str, float], str]] = [
    ({"tstep": 0.0}, "step size 'tstep'"),
    ({"tstep": -0.01}, "step size 'tstep'"),
    ({"tstep": float("nan")}, "'tstep' must be a finite number"),
    ({"tstep": float("inf")}, "'tstep' must be a finite number"),
    ({"max_step": -0.05}, "'max_step' must be 0"),
    ({"dtmax": -1.0}, "'dtmax' must be 0"),
    ({"max_step": float("nan")}, "'max_step' must be a finite number"),
    ({"max_step": float("inf")}, "'max_step' must be a finite number"),
    ({"fixt": 2.0}, "'fixt' must be 0"),
    ({"fixt": -1.0}, "'fixt' must be 0"),
    ({"fixt": float("nan")}, "'fixt' must be a finite number"),
    ({"rtol": float("nan")}, "'rtol' must be a finite number"),
    ({"tol": float("inf")}, "'tol' must be a finite number"),
]


@pytest.mark.parametrize(("overrides", "message"), _BAD_OVERRIDES)
def test_validate_tds_overrides_refuses_a_bad_value(
    overrides: dict[str, float], message: str
) -> None:
    with pytest.raises(SetupFailedError, match=message):
        validate_tds_overrides(overrides)


@pytest.mark.parametrize(
    "overrides",
    [
        None,
        {},
        {"tstep": 0.002},
        {"tstep": 1},
        # Zero is ANDES's "choose the largest step from the frequency and time span".
        {"max_step": 0.0},
        {"max_step": 0.05, "dtmax": 0.1},
        {"fixt": 0},
        {"fixt": 1.0},
        {"fixt": True},
        {"rtol": 1e-3, "atol": 1e-6, "tol": 1e-5, "max_iter": 25},
    ],
)
def test_validate_tds_overrides_accepts_a_sound_value(
    overrides: dict[str, float] | None,
) -> None:
    validate_tds_overrides(overrides)


@pytest.mark.parametrize("bad", ["0.01", True, [0.01], None, 10**400])
def test_validate_tds_overrides_refuses_a_value_that_is_not_a_number(bad: object) -> None:
    """A Python caller can hand over anything; a string in ``tstep`` would be
    written to ``ss.TDS.config`` as a string."""
    with pytest.raises(SetupFailedError):
        validate_tds_overrides({"tstep": bad})  # type: ignore[dict-item]


def test_validate_tds_overrides_quotes_a_long_value_in_short() -> None:
    with pytest.raises(SetupFailedError) as refused:
        validate_tds_overrides({"tstep": "x" * 5000})  # type: ignore[dict-item]
    assert len(str(refused.value)) < 200


@pytest.mark.parametrize(("overrides", "message"), _BAD_OVERRIDES)
def test_check_tds_request_refuses_a_bad_override_value(
    loaded_wrapper: Wrapper, overrides: dict[str, float], message: str
) -> None:
    w = loaded_wrapper
    before = _tds_config(w)
    with pytest.raises(SetupFailedError, match=message):
        w.check_tds_request("trapezoidal", overrides)
    assert _tds_config(w) == before


def test_check_tds_request_names_an_unknown_key_before_judging_a_value(
    loaded_wrapper: Wrapper,
) -> None:
    with pytest.raises(SetupFailedError, match="unknown TDS override key 'bogus'"):
        loaded_wrapper.check_tds_request("trapezoidal", {"bogus": float("nan")})


@pytest.mark.parametrize(("overrides", "message"), _BAD_OVERRIDES)
def test_run_tds_refuses_a_bad_override_value_before_any_write(
    loaded_wrapper: Wrapper, overrides: dict[str, float], message: str
) -> None:
    """The check comes before ``h``, the integrator, and ``tf`` are written, so
    a refused request cannot leave ``fixt = 0`` or a zero ``tstep`` behind."""
    w = loaded_wrapper
    ss = w._require_loaded()  # noqa: SLF001
    before = _tds_config(w)
    with pytest.raises(SetupFailedError, match=message):
        w.run_tds(tf=0.7, h=0.005, integrator="qndf", tds_config_overrides=overrides)
    assert _tds_config(w) == before
    ss.TDS.run.assert_not_called()  # type: ignore[attr-defined]


def test_run_tds_applies_a_sound_step_override(loaded_wrapper: Wrapper) -> None:
    """The validated overrides still reach the config, and an explicit ``tstep``
    still wins over ``h``."""
    w = loaded_wrapper
    ss = w._require_loaded()  # noqa: SLF001
    w.run_tds(
        tf=0.1,
        h=0.005,
        tds_config_overrides={"tstep": 0.002, "max_step": 0.0},
    )
    assert float(ss.TDS.config.tstep) == pytest.approx(0.002)
    assert float(ss.TDS.config.dtmax) == 0.0
    ss.TDS.run.assert_called_once()  # type: ignore[attr-defined]


# ---- tds_fixed_step: what a request will do, read from the request ----------


@pytest.mark.parametrize(
    ("integrator", "overrides", "expected"),
    [
        ("trapezoidal", None, True),
        ("trapezoidal", {}, True),
        ("trapezoidal", {"rtol": 1e-3, "max_step": 0.05}, True),
        ("trapezoidal", {"fixt": 1}, True),
        ("trapezoidal", {"tstep": 0.002}, True),
        # An explicit ``fixt`` override is applied after the wrapper's own.
        ("trapezoidal", {"fixt": 0}, False),
        ("trapezoidal", {"fixt": 0.0}, False),
        # QNDF needs variable step: ANDES sets ``fixt = 0`` for it.
        ("qndf", None, False),
        ("qndf", {"fixt": 1}, False),
        ("qndf", {"max_step": 0.05}, False),
    ],
)
def test_tds_fixed_step_follows_the_request(
    integrator: str, overrides: dict[str, float] | None, expected: bool
) -> None:
    assert tds_fixed_step(integrator, overrides) is expected  # type: ignore[arg-type]


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


# ---- step size validation --------------------------------------------------
#
# ANDES does not reject a bad step. ``_calc_h_first`` logs a warning for
# ``tstep <= 0`` and flips ``config.fixt`` to variable-step on the live System,
# and NaN or infinity reach the integrator unchecked. The wrapper refuses them
# before touching the System.


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(None, None), (0.005, 0.005), (1, 1.0), ("0.01", 0.01), (1e-9, 1e-9)],
)
def test_validate_step_size_accepts_positive_finite_numbers(
    raw: object, expected: float | None
) -> None:
    assert validate_step_size(raw) == expected


@pytest.mark.parametrize(
    "bad",
    [
        0,
        0.0,
        -0.01,
        float("nan"),
        float("inf"),
        float("-inf"),
        True,
        "abc",
        "",
        "nan",
        [],
        {},
        pytest.param(10**400, id="int-too-large-for-float"),  # OverflowError, not ValueError
    ],
)
def test_validate_step_size_rejects_everything_else(bad: object) -> None:
    with pytest.raises(SetupFailedError, match="step size 'h'"):
        validate_step_size(bad)


@pytest.mark.parametrize("bad", [0.0, -0.005, float("nan"), float("inf")])
def test_run_tds_rejects_a_bad_step_without_touching_the_system(
    loaded_wrapper: Wrapper, bad: float
) -> None:
    """The refusal comes before any config write, so a rejected request cannot
    leave ``fixt`` or ``tstep`` altered for the next run."""
    w = loaded_wrapper
    ss = w._require_loaded()  # noqa: SLF001
    before = (float(ss.TDS.config.tstep), int(ss.TDS.config.fixt), float(ss.TDS.config.tf))
    with pytest.raises(SetupFailedError, match="step size 'h'"):
        w.run_tds(tf=0.3, h=bad, integrator="qndf")
    after = (float(ss.TDS.config.tstep), int(ss.TDS.config.fixt), float(ss.TDS.config.tf))
    assert after == before
    ss.TDS.run.assert_not_called()  # type: ignore[attr-defined]


def test_run_sweep_rejects_a_bad_step_before_the_first_iteration(tmp_path: Path) -> None:
    """Without the up-front check every iteration would fail on its own and be
    recorded as an iteration error."""
    ws = tmp_path / "ws"
    ws.mkdir(mode=0o700)
    w = Wrapper(workspace=ws)
    seen: list[int] = []
    with pytest.raises(SetupFailedError, match="step size 'h'"):
        w.run_sweep(
            snapshot_name="whatever",
            parameter_kind="disturbance.fault.tc",
            parameter_target=0,
            values=[1.0, 1.1],
            tf=0.2,
            h=-0.01,
            on_iteration=lambda idx, _value, _result: seen.append(idx),
        )
    assert seen == []
