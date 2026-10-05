"""What the worker attaches to its replies and to a streamed run's frames.

Runs the worker's own handler and command loop on ANDES's bundled IEEE 14 case
with recording pipes, and reads the messages the parent would have been sent.
The messages of a streamed run must ride on the frames, not wait for the run's
final reply: that is what lets a long run's events show while it goes on.

Markers: ``integration``.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from tensa.core import messages, worker
from tensa.core.disturbance import FaultSpec
from tensa.core.stream import decode_batch
from tensa.core.wrapper import Wrapper

pytestmark = pytest.mark.integration


def _ieee14_paths() -> tuple[Path, Path]:
    pytest.importorskip("andes")
    import andes

    cases = Path(andes.__file__).parent / "cases" / "ieee14"
    return cases / "ieee14.raw", cases / "ieee14.dyr"


class _RecordingPipe:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    def send(self, message: dict[str, Any]) -> None:
        self.sent.append(message)


@pytest.fixture(autouse=True)
def capture() -> Iterator[None]:
    messages.install_capture()
    try:
        yield
    finally:
        messages.uninstall_capture()


def _texts(message: dict[str, Any]) -> list[str]:
    return [entry["text"] for entry in message.get("log", [])]


def test_a_streamed_run_sends_its_events_on_the_frames_that_follow_them() -> None:
    raw, dyr = _ieee14_paths()
    wrapper = Wrapper()
    wrapper.load_case(raw, addfiles=[dyr])
    wrapper.add_disturbance(FaultSpec(bus_idx=4, tf=0.5, tc=0.6))
    pipe = _RecordingPipe()

    messages.begin_command("run_tds")
    worker._handle_run_tds(  # noqa: SLF001
        wrapper,
        {"tf": 1.0, "h": 1 / 120, "stream": True, "decimation": "none"},
        threading.Event(),
        pipe,  # type: ignore[arg-type]
        seq=1,
    )
    final = messages.attach_log({"type": "result"})

    frames = [m for m in pipe.sent if m["type"] == "stream_frame"]
    applying = [
        (frame, text)
        for frame in frames
        for text in _texts(frame)
        if "Applying fault on Bus (idx=4) at t=0.5" in text
    ]
    clearing = [text for frame in frames for text in _texts(frame) if "Clearing fault" in text]
    assert len(applying) == 1 and len(clearing) == 1

    # The frame that carries the fault is the one that closes the step it was
    # applied in, not a later one and not the final reply.
    frame, _text = applying[0]
    times, _values = decode_batch(frame["payload"])
    assert 0.5 <= float(times[-1]) < 0.6
    entry = next(e for e in frame["log"] if "Applying fault" in e["text"])
    assert entry["level"] == "info"
    assert entry["source"] == "run_tds"
    assert entry["logger"] == "andes.models.timer"
    # Nothing is sent twice: the run's closing message is the only one left for
    # the final reply, and the frames after the fault carry nothing of it.
    assert [t for t in _texts(final) if "Applying fault" in t] == []
    assert any(t.startswith("Simulation to t=1.00 sec completed") for t in _texts(final))


def test_the_command_loop_attaches_the_log_to_the_reply_and_names_the_command() -> None:
    raw, _dyr = _ieee14_paths()

    class _Ctrl:
        def __init__(self, commands: list[dict[str, Any]]) -> None:
            self._commands = commands

        def recv(self) -> dict[str, Any]:
            if not self._commands:
                raise EOFError
            return self._commands.pop(0)

    data = _RecordingPipe()
    ctrl = _Ctrl(
        [
            {"op": "load_case", "args": {"path": str(raw)}, "seq": 1},
            {"op": "run_pflow", "args": {"max_iterations": 1}, "seq": 2},
            {"op": "topology", "args": {}, "seq": 3},
            {"op": "no_such_op", "args": {}, "seq": 4},
            {"op": "shutdown", "args": {}, "seq": 5},
        ]
    )

    worker._serve_commands(ctrl, data, threading.Event(), None, None, None)  # type: ignore[arg-type] # noqa: SLF001

    loaded, solved, topology, unknown, goodbye = data.sent
    assert {e["source"] for e in loaded["log"]} == {"load_case"}
    assert any("Parsing input file" in t for t in _texts(loaded))
    # A solve that does not converge: the error rides on the (successful) reply.
    assert solved["type"] == "result"
    assert {e["source"] for e in solved["log"]} == {"run_pflow"}
    assert [e["level"] for e in solved["log"]].count("error") == 1
    # A command that logs nothing sends a bare reply.
    assert "log" not in topology
    # A command that fails still gets an error reply, and the shutdown
    # acknowledgement stays bare.
    assert unknown["type"] == "error"
    assert "log" not in goodbye
