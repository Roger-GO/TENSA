"""What a converged power flow says about generators held at a limit and loads
turned into impedances, against real ANDES.

IEEE 14 (``ieee14.raw``) solves two generators past their reactive limits, so
enforcing the limits holds them there. Its loads, scaled up until the voltage
falls under 0.8 pu, are turned into impedances by ANDES's ``pq2z``. Neither is
logged by ANDES; the worker's power-flow handler reads the limiter flags and says
so through the notice logger, which the message capture picks up.

Markers: ``integration``.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from tensa.core import messages, worker
from tensa.core.wrapper import Wrapper

pytestmark = pytest.mark.integration


def _case(name: str) -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.get_case(name))


@pytest.fixture(autouse=True)
def capture() -> Iterator[None]:
    messages.install_capture()
    try:
        yield
    finally:
        messages.uninstall_capture()


def _run(wrapper: Wrapper, **options: Any) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Run the worker's power-flow handler: its reply, and the notices it logged."""
    messages.begin_command("run_pflow")
    reply: dict[str, Any] = worker._handle_run_pflow(wrapper, options)  # noqa: SLF001
    log = messages.attach_log({"type": "result"}).get("log", [])
    return reply, [entry for entry in log if entry["logger"] == "tensa.notice"]


def _notices(wrapper: Wrapper, **options: Any) -> list[dict[str, Any]]:
    reply, notices = _run(wrapper, **options)
    assert reply["converged"] is True
    return notices


def _loaded(name: str) -> Wrapper:
    wrapper = Wrapper()
    wrapper.load_case(_case(name))
    return wrapper


def _scale_loads(wrapper: Wrapper, factor: float) -> None:
    ss = wrapper._require_loaded()  # noqa: SLF001
    for i, idx in enumerate(list(ss.PQ.idx.v)):
        wrapper.edit_element(
            "PQ",
            idx,
            {"p0": float(ss.PQ.p0.v[i]) * factor, "q0": float(ss.PQ.q0.v[i]) * factor},
        )


def test_enforcing_the_limits_says_which_generators_were_switched() -> None:
    reply, notices = _run(_loaded("ieee14/ieee14.raw"), enforce_q_limits=True)

    # The generators the solution leaves on their upper limit, from the result itself.
    held = {
        idx for idx, gen in reply["generator_outputs"].items() if gen["q"] == pytest.approx(gen["q_max"])
    }
    assert held, "the case should hold at least one generator at a limit"
    (notice,) = notices
    assert notice["level"] == "warning"
    assert notice["source"] == "run_pflow"
    n = len(held)
    assert notice["text"].startswith(
        f"Reactive limits: {n} generator{'s were' if n != 1 else ' was'} switched from PV to PQ"
    )
    for idx in held:
        assert f"PV {idx} at qmax" in notice["text"]


def test_without_enforcement_nothing_is_said_about_the_limits() -> None:
    assert _notices(_loaded("ieee14/ieee14.raw")) == []


def test_the_next_run_does_not_carry_the_last_one_s_generators_over() -> None:
    wrapper = _loaded("ieee14/ieee14.raw")
    assert len(_notices(wrapper, enforce_q_limits=True)) == 1
    assert _notices(wrapper, enforce_q_limits=False) == []


def test_loads_pushed_under_their_voltage_limit_are_reported_as_impedances() -> None:
    wrapper = _loaded("ieee14/ieee14_full.xlsx")
    _scale_loads(wrapper, 4.0)

    (notice,) = _notices(wrapper)

    assert notice["level"] == "warning"
    assert notice["text"].startswith("3 loads are treated as constant impedance")
    assert "below 0.8" in notice["text"]
    # The voltages it quotes are the solved ones: all under the limit.
    ss = wrapper._require_loaded()  # noqa: SLF001
    assert float(ss.Bus.v.v.min()) < 0.8


def test_a_case_whose_loads_hold_their_voltage_is_not_reported() -> None:
    assert _notices(_loaded("ieee14/ieee14_full.xlsx")) == []


def test_a_power_flow_that_did_not_converge_says_nothing() -> None:
    wrapper = _loaded("ieee14/ieee14.raw")
    messages.begin_command("run_pflow")
    reply = worker._handle_run_pflow(  # noqa: SLF001
        wrapper, {"max_iterations": 1, "enforce_q_limits": True}
    )
    assert reply["converged"] is False
    log = messages.attach_log({"type": "result"}).get("log", [])
    assert [e for e in log if e["logger"] == "tensa.notice"] == []
    # ANDES's own error is there, which is what explains the failure.
    assert any(e["level"] == "error" for e in log)
