"""The two things a power flow does that ANDES does not log, read from the limiter
flags and worded for the Messages tab.

The System is a stand-in with numpy arrays where ANDES keeps them, so every case
(an out-of-service device, a flag on a slack bus, a long list) can be set up
directly. ``tests/integration/test_pflow_notices.py`` checks the same reading
against real ANDES.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

from tensa.core import messages, pflow_notices
from tensa.core.pflow_notices import (
    MAX_NAMED,
    ImpedanceLoad,
    QLimitHit,
    impedance_loads,
    impedance_message,
    log_pflow_notices,
    q_limit_hits,
    q_limit_message,
)

pytestmark = pytest.mark.unit


def _generators(idx: list[Any], zl: list[float], zu: list[float], u: list[float] | None = None) -> Any:
    return SimpleNamespace(
        idx=SimpleNamespace(v=idx),
        u=SimpleNamespace(v=np.array(u if u is not None else [1.0] * len(idx))),
        qlim=SimpleNamespace(zl=np.array(zl), zu=np.array(zu)),
    )


def _loads(
    idx: list[Any],
    voltage: list[float],
    zl: list[float],
    zu: list[float],
    u: list[float] | None = None,
) -> Any:
    return SimpleNamespace(
        idx=SimpleNamespace(v=idx),
        u=SimpleNamespace(v=np.array(u if u is not None else [1.0] * len(idx))),
        v=SimpleNamespace(v=np.array(voltage)),
        vmin=SimpleNamespace(v=np.array([0.8] * len(idx))),
        vmax=SimpleNamespace(v=np.array([1.2] * len(idx))),
        vcmp=SimpleNamespace(zl=np.array(zl), zu=np.array(zu)),
    )


# ---- generators held at a reactive limit --------------------------------------


def test_generators_at_a_limit_are_found_with_which_limit() -> None:
    ss = SimpleNamespace(
        PV=_generators([2, 3, 4], zl=[0, 1, 0], zu=[1, 0, 0]),
        Slack=_generators([1], zl=[0], zu=[0]),
    )
    assert q_limit_hits(ss) == [QLimitHit("PV", 2, "qmax"), QLimitHit("PV", 3, "qmin")]


def test_a_slack_generator_at_a_limit_is_named_as_a_slack() -> None:
    ss = SimpleNamespace(PV=_generators([2], [0], [0]), Slack=_generators([1], [0], [1]))
    assert q_limit_hits(ss) == [QLimitHit("Slack", 1, "qmax")]


def test_a_generator_that_is_out_of_service_is_not_reported() -> None:
    ss = SimpleNamespace(PV=_generators([2, 3], zl=[0, 0], zu=[1, 1], u=[0, 1]))
    assert q_limit_hits(ss) == [QLimitHit("PV", 3, "qmax")]


def test_a_system_without_generators_or_limiters_has_no_hits() -> None:
    assert q_limit_hits(SimpleNamespace()) == []
    assert q_limit_hits(SimpleNamespace(PV=SimpleNamespace(idx=SimpleNamespace(v=[1])))) == []


def test_the_generator_sentence_counts_and_names_them() -> None:
    one = q_limit_message([QLimitHit("PV", 2, "qmax")])
    assert one == (
        "Reactive limits: 1 generator was switched from PV to PQ and held at a limit, "
        "so the voltage there is no longer held (PV 2 at qmax)."
    )
    two = q_limit_message([QLimitHit("PV", 2, "qmax"), QLimitHit("Slack", 1, "qmin")])
    assert two is not None
    assert two.startswith("Reactive limits: 2 generators were switched from PV to PQ")
    assert two.endswith("(PV 2 at qmax, Slack 1 at qmin).")


def test_nothing_is_said_when_no_generator_is_held() -> None:
    assert q_limit_message([]) is None


def test_a_long_list_of_generators_is_cut_and_counted() -> None:
    hits = [QLimitHit("PV", i, "qmax") for i in range(MAX_NAMED + 3)]
    text = q_limit_message(hits)
    assert text is not None
    assert f"{MAX_NAMED + 3} generators were" in text
    assert f"PV {MAX_NAMED - 1} at qmax and 3 more)." in text
    assert f"PV {MAX_NAMED} at" not in text


# ---- loads turned into impedances ---------------------------------------------


def test_loads_past_their_voltage_limits_are_found_with_the_side() -> None:
    ss = SimpleNamespace(
        PQ=_loads(
            ["PQ_1", "PQ_2", "PQ_3"],
            voltage=[0.75, 1.0, 1.25],
            zl=[1, 0, 0],
            zu=[0, 0, 1],
        )
    )
    assert impedance_loads(ss) == [
        ImpedanceLoad("PQ_1", 0.75, "below", 0.8),
        ImpedanceLoad("PQ_3", 1.25, "above", 1.2),
    ]


def test_a_load_that_is_out_of_service_is_not_reported() -> None:
    ss = SimpleNamespace(PQ=_loads(["PQ_1", "PQ_2"], [0.7, 0.7], [1, 1], [0, 0], u=[0, 1]))
    assert [x.idx for x in impedance_loads(ss)] == ["PQ_2"]


def test_a_system_without_loads_has_no_impedance_loads() -> None:
    assert impedance_loads(SimpleNamespace()) == []


def test_the_load_sentence_counts_names_and_says_why() -> None:
    one = impedance_message([ImpedanceLoad("PQ_5", 0.7216, "below", 0.8)])
    assert one == (
        "1 load is treated as constant impedance, not constant power, because the voltage at "
        "its bus is outside the load's vmin and vmax, so it draws less than the set-point "
        "(ANDES's pq2z setting): PQ_5 at 0.722 pu, below 0.8."
    )
    two = impedance_message(
        [ImpedanceLoad("PQ_5", 0.7, "below", 0.8), ImpedanceLoad("PQ_9", 1.3, "above", 1.2)]
    )
    assert two is not None
    assert two.startswith("2 loads are treated as constant impedance")
    assert "their bus" in two and "they draw" in two
    assert two.endswith("PQ_5 at 0.700 pu, below 0.8, PQ_9 at 1.300 pu, above 1.2.")


def test_nothing_is_said_when_no_load_was_turned() -> None:
    assert impedance_message([]) is None


# ---- saying it ----------------------------------------------------------------


def test_both_effects_are_logged_as_warnings_on_the_notice_logger(
    caplog: pytest.LogCaptureFixture,
) -> None:
    ss = SimpleNamespace(
        PV=_generators([2], [0], [1]),
        PQ=_loads(["PQ_1"], [0.7], [1], [0]),
    )
    with caplog.at_level(logging.INFO, logger=messages.NOTICE_LOGGER):
        log_pflow_notices(ss)

    assert [(r.name, r.levelname) for r in caplog.records] == [
        ("tensa.notice", "WARNING"),
        ("tensa.notice", "WARNING"),
    ]
    assert caplog.records[0].getMessage().startswith("Reactive limits: 1 generator was")
    assert caplog.records[1].getMessage().startswith("1 load is treated as constant impedance")


def test_a_power_flow_that_did_neither_logs_nothing(caplog: pytest.LogCaptureFixture) -> None:
    ss = SimpleNamespace(PV=_generators([2], [0], [0]), PQ=_loads(["PQ_1"], [1.0], [0], [0]))
    with caplog.at_level(logging.DEBUG, logger=messages.NOTICE_LOGGER):
        log_pflow_notices(ss)
    assert caplog.records == []


def test_a_system_that_cannot_be_read_logs_nothing_and_does_not_raise(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def broken(_ss: Any) -> list[Any]:
        raise RuntimeError("an ANDES that changed its arrays")

    monkeypatch.setattr(pflow_notices, "q_limit_hits", broken)
    with caplog.at_level(logging.WARNING, logger=messages.NOTICE_LOGGER):
        log_pflow_notices(SimpleNamespace())
    assert [r for r in caplog.records if r.name == "tensa.notice"] == []


def test_the_capture_listens_to_the_notice_logger_too() -> None:
    cap = messages.WorkerLogCapture()
    cap.install()
    try:
        cap.begin("run_pflow")
        log_pflow_notices(SimpleNamespace(PV=_generators([2], [0], [1])))
        reply = cap.attach({"type": "result"})
    finally:
        cap.uninstall()

    (entry,) = reply["log"]
    assert (entry["level"], entry["logger"], entry["source"]) == (
        "warning",
        "tensa.notice",
        "run_pflow",
    )
    assert "switched from PV to PQ" in entry["text"]
