"""The streaming TDS handler decides what it announces, and what it refuses,
from the request instead of from the System's leftover configuration.

``stream_start`` goes out before the run begins, while ``Wrapper.run_tds`` is
what sets ``fixt`` for the requested integrator. Read ahead of that, ``fixt``
is whatever an earlier run (or ANDES's default of 1) left behind, so the
decimation label was wrong for a first QNDF stream and for a trapezoidal stream
that followed a QNDF run. A run the wrapper would refuse (QNDF on a System that
already ran trapezoidally, an unknown override key) must not open a stream
either: the client would see ``stream_start`` and then an error.

Markers: ``integration``. These drive the worker's handler against ANDES's
bundled IEEE 14 case with a recording pipe in place of the data Pipe.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import pytest

from tensa.core import worker
from tensa.core.errors import AndesAppError, SetupFailedError
from tensa.core.wrapper import Wrapper


def _ieee14_paths() -> tuple[Path, Path]:
    pytest.importorskip("andes")
    import andes

    cases = Path(andes.__file__).parent / "cases" / "ieee14"
    raw = cases / "ieee14.raw"
    dyr = cases / "ieee14.dyr"
    if not raw.exists() or not dyr.exists():  # pragma: no cover
        pytest.skip(f"IEEE 14 fixtures not bundled with this ANDES install: {cases}")
    return raw, dyr


class _RecordingPipe:
    """Stands in for the worker's data Pipe; keeps every message sent."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    def send(self, message: dict[str, Any]) -> None:
        self.sent.append(message)

    def stream_start(self) -> dict[str, Any]:
        starts = [m for m in self.sent if m["type"] == "stream_start"]
        assert len(starts) == 1, [m["type"] for m in self.sent]
        decimation: dict[str, Any] = starts[0]["metadata"]["decimation"]
        return decimation


@pytest.fixture
def wrapper() -> Wrapper:
    raw, dyr = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw, addfiles=[dyr])
    return w


def _stream(w: Wrapper, **args: Any) -> _RecordingPipe:
    """Run the streaming handler with mean decimation, so the stream-start
    ``algorithm`` label depends on whether the run is fixed-step."""
    pipe = _RecordingPipe()
    request: dict[str, Any] = {
        "tf": 0.3,
        "stream": True,
        "decimation": "mean",
        "max_rate_hz": 10.0,
        **args,
    }
    worker._handle_run_tds(w, request, threading.Event(), pipe, seq=1)  # type: ignore[arg-type]
    return pipe


def _bridge_threads() -> set[threading.Thread]:
    return {t for t in threading.enumerate() if t.name.endswith("abort-bridge")}


def _config_snapshot(w: Wrapper) -> tuple[object, ...]:
    cfg = w._require_loaded().TDS.config  # noqa: SLF001
    return (cfg.method, int(cfg.fixt), float(cfg.tstep), float(cfg.tf))


# ---- the label follows the requested integrator ----------------------------


@pytest.mark.integration
def test_trapezoidal_stream_is_labelled_fixed_step(wrapper: Wrapper) -> None:
    decimation = _stream(wrapper, h=0.01).stream_start()
    assert decimation["fixed_step"] is True
    assert decimation["algorithm"] == "boxcar-mean"


@pytest.mark.integration
def test_first_qndf_stream_is_labelled_variable_step(wrapper: Wrapper) -> None:
    """ANDES defaults ``fixt`` to 1, so a first QNDF stream read it as fixed-step
    before the wrapper had set ``fixt = 0``."""
    decimation = _stream(wrapper, integrator="qndf").stream_start()
    assert decimation["fixed_step"] is False
    assert decimation["algorithm"] == "boxcar-mean-best-effort"


@pytest.mark.integration
def test_trapezoidal_stream_after_a_qndf_run_is_labelled_fixed_step(
    wrapper: Wrapper,
) -> None:
    """The QNDF run leaves ``fixt = 0`` on the System; the trapezoidal run that
    follows sets it back to 1, but only after the label was read."""
    _stream(wrapper, integrator="qndf")
    assert int(wrapper._require_loaded().TDS.config.fixt) == 0  # noqa: SLF001

    decimation = _stream(wrapper, tf=0.6, h=0.01).stream_start()
    assert decimation["fixed_step"] is True
    assert decimation["algorithm"] == "boxcar-mean"


@pytest.mark.integration
def test_fixt_override_decides_the_label_for_a_trapezoidal_stream(
    wrapper: Wrapper,
) -> None:
    """An explicit ``fixt`` override wins over the wrapper's own setting, and the
    run really is variable-step, so the label says so."""
    decimation = _stream(wrapper, h=0.01, tds_config_overrides={"fixt": 0}).stream_start()
    assert decimation["fixed_step"] is False
    assert decimation["algorithm"] == "boxcar-mean-best-effort"
    assert int(wrapper._require_loaded().TDS.config.fixt) == 0  # noqa: SLF001


# ---- a refused run opens no stream -----------------------------------------


@pytest.mark.integration
def test_qndf_after_a_trapezoidal_run_is_refused_before_stream_start(
    wrapper: Wrapper,
) -> None:
    first = _stream(wrapper, h=0.01)
    assert first.stream_start()["fixed_step"] is True
    before = _config_snapshot(wrapper)
    bridges_before = _bridge_threads()

    pipe = _RecordingPipe()
    with pytest.raises(SetupFailedError, match="cannot replace the trapezoidal integrator"):
        worker._handle_run_tds(
            wrapper,
            {"tf": 0.6, "stream": True, "integrator": "qndf"},
            threading.Event(),
            pipe,  # type: ignore[arg-type]
            seq=2,
        )
    assert pipe.sent == [], "a refused run must not send stream_start or frames"
    assert _config_snapshot(wrapper) == before
    assert _bridge_threads() <= bridges_before


@pytest.mark.integration
def test_unknown_override_key_is_refused_before_stream_start(wrapper: Wrapper) -> None:
    before = _config_snapshot(wrapper)
    bridges_before = _bridge_threads()

    pipe = _RecordingPipe()
    with pytest.raises(SetupFailedError, match="bogus_knob"):
        worker._handle_run_tds(
            wrapper,
            {
                "tf": 0.6,
                "h": 0.01,
                "stream": True,
                "integrator": "qndf",
                "tds_config_overrides": {"bogus_knob": 1.0},
            },
            threading.Event(),
            pipe,  # type: ignore[arg-type]
            seq=1,
        )
    assert pipe.sent == []
    # Nothing was written before the refusal, so the System is as it was.
    assert _config_snapshot(wrapper) == before
    assert _bridge_threads() <= bridges_before


@pytest.mark.integration
@pytest.mark.parametrize("stream", [True, False])
@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"tstep": 0.0}, "step size 'tstep'"),
        ({"tstep": -0.01}, "step size 'tstep'"),
        ({"tstep": float("nan")}, "'tstep' must be a finite number"),
        ({"max_step": -1.0}, "'max_step' must be 0"),
        ({"max_step": float("inf")}, "'max_step' must be a finite number"),
        ({"fixt": 2.0}, "'fixt' must be 0"),
    ],
)
def test_a_bad_step_override_is_refused_before_stream_start(
    wrapper: Wrapper, stream: bool, overrides: dict[str, float], message: str
) -> None:
    """``tstep`` and ``max_step`` reach ``ss.TDS.config`` like ``h`` does, so the
    handler refuses them under the same rule: before any frame, before the
    bridge thread, and with the System's configuration untouched (ANDES would
    otherwise log a warning and leave ``fixt = 0`` on it for good)."""
    before = _config_snapshot(wrapper)
    bridges_before = _bridge_threads()

    pipe = _RecordingPipe()
    with pytest.raises(SetupFailedError, match=message):
        worker._handle_run_tds(
            wrapper,
            {"tf": 0.3, "h": 0.01, "stream": stream, "tds_config_overrides": overrides},
            threading.Event(),
            pipe,  # type: ignore[arg-type]
            seq=1,
        )
    assert pipe.sent == []
    assert _config_snapshot(wrapper) == before
    assert _bridge_threads() <= bridges_before

    # The session still runs, at the fixed step it asked for.
    result = wrapper.run_tds(tf=0.1, h=0.01)
    assert result.final_t == pytest.approx(0.1)
    cfg = wrapper._require_loaded().TDS.config  # noqa: SLF001
    assert int(cfg.fixt) == 1
    assert float(cfg.tstep) == pytest.approx(0.01)


@pytest.mark.integration
@pytest.mark.parametrize(
    ("args", "message"),
    [
        ({"integrator": "rk4"}, "unknown integrator"),
        ({"tds_config_overrides": [1.0]}, "must be a dict"),
        ({"tds_config_overrides": {"rtol": "fast"}}, "float-coercible"),
        ({"tds_config_overrides": {"rtol": 10**400}}, "float-coercible"),
    ],
)
def test_malformed_integrator_or_overrides_are_refused_before_stream_start(
    wrapper: Wrapper, args: dict[str, Any], message: str
) -> None:
    bridges_before = _bridge_threads()
    pipe = _RecordingPipe()
    with pytest.raises(AndesAppError, match=message):
        worker._handle_run_tds(
            wrapper,
            {"tf": 0.3, "stream": True, **args},
            threading.Event(),
            pipe,  # type: ignore[arg-type]
            seq=1,
        )
    assert pipe.sent == []
    assert _bridge_threads() <= bridges_before
