"""A run that follows ``Wrapper.init_tds`` with an integrator of its own choosing.

``init_tds`` initialises with the integrator the System's config names at that
moment (the case's own, the trapezoidal method), and ANDES builds that object in
``TDS.init()``. A run that follows and names another integrator has it swapped
in by the wrapper, and a QNDF run has the history ``init()`` would have built
for it made as well, since nothing has stepped. The tests hold each of the three
other integrators after ``init_tds`` to the same run from scratch on ANDES's
bundled IEEE 14 case with a fault: the fixed-step backward Euler solves the
same steps and values but the row at 0 s; the two variable-step integrators
take steps of their own before the first event (the run from scratch solves
the point at 0 s as its first step, and the steps grow from it) and the same
steps from the fault on, with the same values. They also hold that a failed
initialisation is still reported through a swap, that an ``init_tds`` after a
run with another integrator is refused, and that a streamed run after
``init_tds`` records the rows ANDES stored.

Markers: ``integration``.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from tensa.core import worker
from tensa.core.disturbance import FaultSpec
from tensa.core.errors import SetupFailedError
from tensa.core.stream import decode_batch
from tensa.core.wrapper import Wrapper

pytestmark = pytest.mark.integration

TF = 0.6
FAULT_AT = 0.2
H = 1 / 120
AUTO = {"rtol": 1e-3, "atol": 1e-6, "max_step": 0.05}
RECORDED = ["omega GENROU 1", "v Bus 4", "delta GENROU 2"]
ANDES_CLASS = {"backeuler": "BackEuler", "trap_adapt": "TrapezoidAdaptive", "qndf": "QNDF"}


def _cases() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases"


def _ieee14() -> Wrapper:
    cases = _cases() / "ieee14"
    w = Wrapper()
    w.load_case(cases / "ieee14.raw", addfiles=[cases / "ieee14.dyr"])
    w.add_disturbance(FaultSpec(bus_idx=4, tf=FAULT_AT, tc=FAULT_AT + 0.1))
    return w


def _kundur(*, vmin: float | None = None) -> Wrapper:
    w = Wrapper()
    w.load_case(_cases() / "kundur" / "kundur_full.xlsx")
    if vmin is not None:
        w.edit_element("TGOV1", "1", {"VMIN": vmin})
    return w


def _request(integrator: str) -> dict[str, Any]:
    if integrator in ("trap_adapt", "qndf"):
        return {"integrator": integrator, "tds_config_overrides": AUTO}
    return {"integrator": integrator, "h": H}


def _batch(w: Wrapper, integrator: str) -> tuple[dict[str, Any], np.ndarray, np.ndarray]:
    args = {"tf": TF, "dae_vars": RECORDED, **_request(integrator)}
    result = worker._handle_run_tds(w, args, threading.Event())  # noqa: SLF001
    traces = result["traces"]
    values = np.column_stack([np.array(v["values"], dtype=float) for v in traces["variables"]])
    return result, np.array(traces["t"], dtype=float), values


@pytest.mark.parametrize("integrator", ["backeuler", "trap_adapt", "qndf"])
def test_a_run_after_init_steps_with_the_integrator_it_names(integrator: str) -> None:
    fresh_result, fresh_t, fresh_values = _batch(_ieee14(), integrator)

    w = _ieee14()
    w.init_tds()
    ss = w._require_loaded()  # noqa: SLF001
    # ``init_tds`` initialised with the case's own integrator.
    assert type(ss.TDS.method).__name__ == "Trapezoid"
    result, t, values = _batch(w, integrator)

    assert type(ss.TDS.method).__name__ == ANDES_CLASS[integrator]
    assert (ss.TDS.qndf_cache is not None) is (integrator == "qndf")
    assert fresh_result["converged"] is True
    assert result["converged"] is True
    assert result["integrator"] == integrator
    assert result["final_t"] == fresh_result["final_t"] == TF
    assert fresh_t[0] == 0.0
    assert t[0] > 0.0
    if integrator == "backeuler":
        # A fixed step: the same steps, without the row at 0 s.
        assert t.tolist() == fresh_t[1:].tolist()
        np.testing.assert_allclose(values, fresh_values[1:], rtol=0, atol=1e-9)
    else:
        # The same steps from the fault on, and the same values wherever both
        # runs stored a step.
        assert t[t >= FAULT_AT].tolist() == fresh_t[fresh_t >= FAULT_AT].tolist()
        common, mine, theirs = np.intersect1d(t, fresh_t, return_indices=True)
        assert common.size > 0.8 * t.size
        np.testing.assert_allclose(values[mine], fresh_values[theirs], rtol=0, atol=1e-9)
    # The fault is in the run.
    assert np.ptp(values[:, 0]) > 1e-3


@pytest.mark.parametrize("integrator", ["backeuler", "qndf"])
def test_a_failed_initialisation_is_reported_through_an_integrator_swap(integrator: str) -> None:
    fresh = _kundur(vmin=0.99).run_tds(tf=0.5, **_request(integrator))
    w = _kundur(vmin=0.99)
    assert w.init_tds().test_ok is False
    after = w.run_tds(tf=0.5, **_request(integrator))

    assert type(w._require_loaded().TDS.method).__name__ == ANDES_CLASS[integrator]  # noqa: SLF001
    assert fresh.converged is False
    assert after.converged is False
    assert after.final_t == pytest.approx(fresh.final_t)


@pytest.mark.parametrize("integrator", ["backeuler", "trap_adapt", "qndf"])
def test_init_after_a_run_with_another_integrator_is_refused(integrator: str) -> None:
    w = _kundur()
    w.run_tds(tf=0.1, **_request(integrator))
    with pytest.raises(SetupFailedError, match="already initialised"):
        w.init_tds()


class _RecordingPipe:
    """Stands in for the worker's data Pipe; keeps every message sent."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    def send(self, message: dict[str, Any]) -> None:
        self.sent.append(message)

    def rows(self) -> tuple[np.ndarray, np.ndarray]:
        decoded = [decode_batch(m["payload"]) for m in self.sent if m["type"] == "stream_frame"]
        return (
            np.concatenate([t for t, _ in decoded]),
            np.concatenate([values for _, values in decoded]),
        )


def _streamed(w: Wrapper, integrator: str) -> tuple[dict[str, Any], np.ndarray, np.ndarray]:
    pipe = _RecordingPipe()
    request = {
        "tf": TF, "stream": True, "decimation": "none", "vars": [], "dae_vars": RECORDED,
        **_request(integrator),
    }
    result = worker._handle_run_tds(w, request, threading.Event(), pipe, seq=1)  # type: ignore[arg-type]  # noqa: SLF001
    t, values = pipe.rows()
    return result, t, values


@pytest.mark.parametrize("integrator", ["trapezoidal", "backeuler"])
def test_a_streamed_run_after_init_records_the_rows_andes_stored(integrator: str) -> None:
    _, fresh_t, fresh_values = _streamed(_ieee14(), integrator)
    w = _ieee14()
    w.init_tds()
    result, t, values = _streamed(w, integrator)

    ss = w._require_loaded()  # noqa: SLF001
    assert result["converged"] is True
    assert t.tolist() == np.asarray(ss.dae.ts.t, dtype=float).tolist()
    assert t[-1] == TF == result["final_t"]
    # No row at 0 s: the run starts at its first step, which a run from scratch
    # records after its row at 0 s.
    assert fresh_t[0] == 0.0
    assert t.tolist() == fresh_t[1:].tolist()
    np.testing.assert_allclose(values, fresh_values[1:], rtol=0, atol=1e-9)
