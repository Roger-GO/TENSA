"""The audit table of ``test_model_audits.py``, checked without Julia.

The AUDITS rows cover exactly ``fidelity.COMMON_MODELS``; each row names its
benchmark folder and files, its disturbance is one the API takes, its run
length is the PSID test's at most 20 s, each ``expect`` has a valid form,
every ``differ:`` id is in ``known_differences.json``, and every ``agree``
model recorded in ``model_audits.json`` points at an audit node id that
exists in the table.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any, Final

import pytest

from tensa.engines import fidelity

_INTEGRATION_DIR: Final = Path(__file__).resolve().parent.parent / "integration"
_MODULE_PATH: Final = _INTEGRATION_DIR / "test_model_audits.py"


def _load_audits_module() -> Any:
    """Import ``test_model_audits.py`` from the integration folder by path, so
    this unit test reads the one table the audits run from."""
    spec = importlib.util.spec_from_file_location("tensa_test_model_audits", _MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # The dataclass decorator looks its class's module up in sys.modules, so
    # the module must be registered under its name before it is executed.
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(spec.name, None)
        raise
    return module


@pytest.fixture(scope="module")
def audits() -> Any:
    return _load_audits_module()


# The rows whose audit has not ended in agreement or a known difference yet,
# each with what was established. They stay ``agree`` (what the audit is to
# show) and are not recorded in ``model_audits.json``, so their models stay
# ``unverified``.
_UNRESOLVED: dict[str, str] = {
    "renewable": (
        "The time-domain runs agree (rotor speed 3.7e-8 pu, voltage after the "
        "trip 8.8e-6 pu), but the case has no electromechanical mode to hold "
        "(its one machine is the infinite bus's stand-in) and the converter "
        "chain's eigenvalues do not match: ANDES has 20 states and the pair "
        "-50.0 +/- 4.40j, Sienna 11 states and -45.2 +/- 8.70j."
    ),
}


def test_unresolved_rows_are_rows(audits: Any) -> None:
    by_id = {audit.audit_id: audit for audit in audits.AUDITS}
    for audit_id, what in _UNRESOLVED.items():
        assert audit_id in by_id and what, audit_id
        assert by_id[audit_id].expect == "agree", audit_id


def _register_ids() -> set[str]:
    path = Path(fidelity.__file__).with_name("known_differences.json")
    return {entry["id"] for entry in json.loads(path.read_text(encoding="utf-8"))}


def test_table_covers_exactly_the_common_models(audits: Any) -> None:
    covered = {model for audit in audits.AUDITS for model in audit.models}
    assert covered == set(fidelity.COMMON_MODELS)
    assert len(audits.AUDITS) == 12
    # The renewable chain is the one audit of three models; every other row
    # audits exactly one.
    for audit in audits.AUDITS:
        expected = 3 if audit.audit_id == "renewable" else 1
        assert len(audit.models) == expected, audit.audit_id


def test_audit_ids_are_unique(audits: Any) -> None:
    ids = [audit.audit_id for audit in audits.AUDITS]
    assert len(ids) == len(set(ids))


def test_every_row_names_its_files(audits: Any) -> None:
    for audit in audits.AUDITS:
        assert audit.folder and audit.folder == audit.folder.upper(), audit.audit_id
        assert audit.raw.endswith(".raw"), audit.audit_id
        assert audit.dyr.endswith(".dyr"), audit.audit_id
        assert audit.note, audit.audit_id


def test_every_disturbance_is_one_the_api_takes(audits: Any) -> None:
    for audit in audits.AUDITS:
        disturbance = audit.disturbance
        kind = disturbance["kind"]
        assert kind in ("fault", "toggle"), audit.audit_id
        if kind == "toggle":
            assert disturbance["target"].startswith("branch:"), audit.audit_id
        else:
            assert isinstance(disturbance["bus_idx"], int), audit.audit_id
        t_event = disturbance.get("t", disturbance.get("tf"))
        assert 0.0 < float(t_event) < audit.t_end, audit.audit_id


def test_run_lengths_are_the_psid_tests_at_most_20_s(audits: Any) -> None:
    for audit in audits.AUDITS:
        assert 0.0 < audit.t_end <= 20.0, audit.audit_id
    # The RENA test runs 5 s; the others run 20 s (their PSID tests' tspans).
    by_id = {audit.audit_id: audit.t_end for audit in audits.AUDITS}
    assert by_id["renewable"] == 5.0
    assert all(t == 20.0 for audit_id, t in by_id.items() if audit_id != "renewable")


def test_expect_forms_are_valid(audits: Any) -> None:
    ids = _register_ids()
    for audit in audits.AUDITS:
        kind, _, detail = audit.expect.partition(":")
        assert kind in ("agree", "differ", "refused"), audit.expect
        if kind == "agree":
            assert not detail, audit.expect
        else:
            assert detail, audit.expect
        if kind == "differ":
            assert detail in ids, audit.expect


def test_the_differ_rows(audits: Any) -> None:
    """The rows the audits found to differ, each naming its register entry:
    the governors' torque, ESAC1A's missing rate feedback and EXST1's output
    limiter."""
    differs = {audit.audit_id: audit.expect for audit in audits.AUDITS if audit.expect != "agree"}
    assert differs == {
        "tgov1": "differ:tgov1-torque",
        "gast": "differ:gast-torque",
        "hygov": "differ:hygov-torque",
        "esac1a": "differ:esac1a-rate-feedback",
        "exac1": "differ:exac1-transducer",
        "exst1": "differ:exst1-output-limiter",
    }


def test_every_register_entry_has_its_audit_row(audits: Any) -> None:
    expects = {audit.expect for audit in audits.AUDITS}
    for entry_id in _register_ids():
        assert f"differ:{entry_id}" in expects, entry_id


def test_small_signal_differences_leave_the_damping_unbounded(audits: Any) -> None:
    """A wrong implementation that holds a small-signal difference's damping
    to the exact bound fails its audit; the None bound is the mechanism that
    prevents it. A difference that is not small-signal (EXST1's limiter) is
    held to the bounds of an agreement in the modes."""
    from tensa.engines.fidelity import KNOWN_DIFFERENCES

    small_signal = {entry.id: entry.small_signal for entry in KNOWN_DIFFERENCES}
    for audit in audits.AUDITS:
        kind, _, entry_id = audit.expect.partition(":")
        if kind != "differ":
            continue
        if small_signal[entry_id]:
            assert audit.bounds[5] is None, audit.audit_id
        else:
            assert audit.bounds[4] is not None and audit.bounds[5] is not None, audit.audit_id
    tgov1 = next(a for a in audits.AUDITS if a.audit_id == "tgov1")
    assert tgov1.bounds[4] == 1e-3


def test_agreement_bounds_are_tight(audits: Any) -> None:
    """An audit that agrees is held to a stated margin over what it measured,
    so that a real model difference fails it: its bounds are the ones
    ``agree_bounds`` works out from its row of ``_MEASURED``, the margin is
    five to ten, no mode is allowed more than 1e-5 Hz or 1e-5 in damping (the
    exact audits measure at most 1.1e-7 Hz), and no bound is under what the
    runs and the power flow resolve."""
    assert 5.0 <= audits._MARGIN <= 10.0
    step, mode_floor = audits._STEP_ERROR_PU, audits._MODE_FLOOR
    agreeing = [a for a in audits.AUDITS if a.expect == "agree"]
    assert {a.audit_id for a in agreeing} == set(audits._MEASURED)
    for audit in agreeing:
        measured = audits._MEASURED[audit.audit_id]
        bounds = audit.bounds
        assert bounds == audits.agree_bounds(measured), audit.audit_id
        assert bounds[4] <= 1e-5 and bounds[5] <= 1e-5, audit.audit_id
        assert bounds[0] >= step and bounds[1] * measured.swing >= step, audit.audit_id
        assert bounds[4] >= mode_floor and bounds[5] >= mode_floor, audit.audit_id
        figures = (
            measured.rotor_speed, measured.share, measured.voltage_max, measured.voltage_rms,
        )
        for bound, figure in zip(bounds, figures, strict=False):
            assert bound >= 5.0 * figure, (audit.audit_id, bound, figure)


def test_audit_register_points_at_existing_audits(audits: Any) -> None:
    """Every model recorded in ``model_audits.json`` names a pytest node id of
    the integration module, ``<test>[<audit id>]``, whose audit row covers
    that model and expects agreement, and every row that expects agreement
    has its models recorded."""
    path = Path(fidelity.__file__).with_name("model_audits.json")
    recorded = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(recorded, list)
    node_prefix = "server/tests/integration/test_model_audits.py::"
    by_id = {audit.audit_id: audit for audit in audits.AUDITS}
    for entry in recorded:
        assert entry["engine"] == "sienna", entry
        test = entry["test"]
        assert test.startswith(node_prefix), test
        name, _, param = test[len(node_prefix) :].partition("[")
        assert name in {
            "test_audit_rotor_speeds",
            "test_audit_voltages",
            "test_audit_modes",
            "test_audit_bus_count",
        }, test
        assert param.endswith("]"), test
        audit = by_id.get(param[:-1])
        assert audit is not None, f"{test} names no audit row"
        model = entry["model"]
        assert model in audit.models, f"{test} does not audit {model}"
        assert audit.expect == "agree", (
            f"{model} is recorded as audited but row {audit.audit_id} expects {audit.expect}"
        )
    recorded_models = {entry["model"] for entry in recorded}
    for audit in audits.AUDITS:
        if audit.expect != "agree":
            continue
        if audit.audit_id in _UNRESOLVED:
            assert not set(audit.models) & recorded_models, audit.audit_id
        else:
            assert set(audit.models) <= recorded_models, (
                f"row {audit.audit_id} expects agreement but {audit.models} are not recorded"
            )


def test_register_loads_with_the_table(audits: Any) -> None:
    """``fidelity.load_audited_models`` accepts the register the table checks
    (a malformed register fails at import time, never at request time)."""
    assert isinstance(fidelity.AUDITED_MODELS, frozenset)
    for engine, model in fidelity.AUDITED_MODELS:
        assert engine in ("andes", "sienna")
        assert model in fidelity.COMMON_MODELS
