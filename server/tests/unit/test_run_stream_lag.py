"""A client that falls behind a streaming run is told so, not left with a gap.

The run does not wait for its clients: the worker's frames go to the run buffer
and to each attached client's inbox as they arrive. An inbox is bounded, and
when one fills (a stalled tab, a dead connection nobody has noticed) the client
has missed frames it cannot be caught up on. The inbox used to drop the frames
that did not fit and say nothing, so the client received a stream with a hole
in it, and, when the run's end marker was among the dropped, never learned the
run had finished.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import pytest
from starlette.websockets import WebSocketState

from tensa.api.routes.ws import _stream_run_to_websocket
from tensa.core.session import (
    RUN_CONSUMER_QUEUE_SIZE,
    SessionManager,
    _RunBuffer,
    _RunConsumer,
)

pytestmark = pytest.mark.unit


def _mgr_with_run(state: str = "running") -> tuple[SessionManager, _RunBuffer]:
    mgr = SessionManager()
    run_buf = _RunBuffer(run_id="run-1", session_id="s1", state=state)  # type: ignore[arg-type]
    mgr._runs["run-1"] = run_buf
    return mgr, run_buf


async def _attach(
    mgr: SessionManager, run_buf: _RunBuffer
) -> tuple[AsyncIterator[dict[str, Any]], asyncio.Future[dict[str, Any]]]:
    """Attach a client and wait until it is subscribed and parked on its inbox."""
    events = mgr.attach_to_run("s1", "run-1", 0)
    first = asyncio.ensure_future(anext(events))
    while not run_buf.consumers:
        await asyncio.sleep(0)
    return events, first


def _publish_frame(run_buf: _RunBuffer, seq: int) -> None:
    """What the driver does for a frame from the worker."""
    run_buf.frames.append((seq, b"x"))
    run_buf.publish({"type": "frame", "seq": seq, "payload": b"x"})


# ---- the inbox ----------------------------------------------------------------


def test_an_inbox_that_fills_is_left_with_one_lagged_marker_and_takes_no_more() -> None:
    consumer = _RunConsumer(size=3)
    for seq in range(3):
        consumer.offer({"type": "frame", "seq": seq})
    assert not consumer.lagged

    consumer.offer({"type": "frame", "seq": 3})

    assert consumer.lagged
    assert consumer.queue.qsize() == 1
    assert consumer.queue.get_nowait() == {"type": "lagged"}
    consumer.offer({"type": "frame", "seq": 4})
    consumer.offer({"type": "finished"})
    assert consumer.queue.empty()


def test_one_stalled_client_does_not_change_what_another_receives() -> None:
    run_buf = _RunBuffer(run_id="r", session_id="s")
    stalled, keeping_up = _RunConsumer(size=2), _RunConsumer(size=2)
    run_buf.consumers.extend([stalled, keeping_up])

    for seq in range(1, 5):
        run_buf.publish({"type": "frame", "seq": seq})
        assert keeping_up.queue.get_nowait()["seq"] == seq  # reads as each arrives

    assert stalled.lagged
    assert not keeping_up.lagged


# ---- attach_to_run ------------------------------------------------------------


async def test_a_client_that_falls_behind_is_sent_resync_instead_of_a_gap() -> None:
    mgr, run_buf = _mgr_with_run()
    events, first = await _attach(mgr, run_buf)

    # The client reads nothing while the run produces more than its inbox holds.
    for seq in range(1, RUN_CONSUMER_QUEUE_SIZE + 2):
        _publish_frame(run_buf, seq)

    event = await asyncio.wait_for(first, 1)
    assert event["type"] == "resync"
    assert event["cause"] == "client_lagged"
    assert "behind" in event["reason"]
    assert event["current_seq"] == RUN_CONSUMER_QUEUE_SIZE + 1
    with pytest.raises(StopAsyncIteration):
        await anext(events)
    assert run_buf.consumers == []


async def test_a_resume_past_the_run_buffer_is_sent_resync_with_its_own_cause() -> None:
    """The other resync: the frames a reconnecting client asks for have left the
    run buffer. It names that cause, so the client can tell it from a lag."""
    mgr, run_buf = _mgr_with_run()
    for seq in range(10, 14):
        run_buf.frames.append((seq, b"x"))

    events = mgr.attach_to_run("s1", "run-1", 3)

    event = await asyncio.wait_for(anext(events), 1)
    assert event == {"type": "resync", "current_seq": 13, "cause": "buffer_evicted"}
    with pytest.raises(StopAsyncIteration):
        await anext(events)
    assert run_buf.consumers == []


async def test_a_client_whose_inbox_is_full_when_the_run_ends_is_not_left_waiting() -> None:
    """The end-of-run marker is queued like a frame. When the inbox was full it
    was dropped, and the client, after the frames it did get, waited for a
    ``done`` that never came."""
    mgr, run_buf = _mgr_with_run()
    events, first = await _attach(mgr, run_buf)
    for seq in range(1, RUN_CONSUMER_QUEUE_SIZE + 1):
        _publish_frame(run_buf, seq)

    await mgr._finish_run_buffer(run_buf, "completed", result={"converged": True})

    event = await asyncio.wait_for(first, 1)
    assert event["type"] == "resync"
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(anext(events), 1)


async def test_a_client_that_keeps_up_gets_every_frame_in_order_and_the_result() -> None:
    """Reading as the run goes, a client sees more frames than an inbox holds
    without any being dropped."""
    mgr, run_buf = _mgr_with_run()
    received: list[dict[str, Any]] = []

    async def read() -> None:
        async for event in mgr.attach_to_run("s1", "run-1", 0):
            received.append(event)

    reader = asyncio.ensure_future(read())
    while not run_buf.consumers:
        await asyncio.sleep(0)
    total = RUN_CONSUMER_QUEUE_SIZE + 50
    for seq in range(1, total + 1):
        _publish_frame(run_buf, seq)
        await asyncio.sleep(0)
    await mgr._finish_run_buffer(run_buf, "completed", result={"converged": True})
    await asyncio.wait_for(reader, 1)

    assert [e["seq"] for e in received if e["type"] == "frame"] == list(range(1, total + 1))
    assert received[-1] == {"type": "done", "result": {"converged": True}}


async def test_the_driver_does_not_wait_for_a_client_that_reads_nothing() -> None:
    """Frames from the worker are handed on without waiting for any client: the
    run finishes while the client has read nothing, and the client's next event
    is the resync."""
    mgr, run_buf = _mgr_with_run(state="pending")

    async def worker_stream(
        _session_id: str,
        _op: str,
        _args: dict[str, Any],
        *,
        on_metadata: Any,
        on_frame: Any,
        timeout: float,
    ) -> dict[str, Any]:
        await on_metadata({"var_columns": ["Bus_1_v"]})
        for _ in range(RUN_CONSUMER_QUEUE_SIZE + 10):
            await on_frame(b"x")
        return {"converged": True, "final_t": 1.0, "callpert_count": 1}

    mgr.invoke_streaming = worker_stream  # type: ignore[method-assign]
    events, first = await _attach(mgr, run_buf)

    await asyncio.wait_for(mgr._drive_streaming_run(run_buf, "run_tds", {}), 5)

    assert run_buf.state == "completed"
    event = await asyncio.wait_for(first, 1)
    assert event["type"] == "resync"
    assert run_buf.frames[-1][0] == RUN_CONSUMER_QUEUE_SIZE + 10
    with pytest.raises(StopAsyncIteration):
        await anext(events)


# ---- the WebSocket route ------------------------------------------------------


class _FakeSocket:
    client_state = WebSocketState.CONNECTED

    def __init__(self) -> None:
        self.text: list[dict[str, Any]] = []
        self.close_code: int | None = None

    async def send_text(self, data: str) -> None:
        self.text.append(json.loads(data))

    async def send_bytes(self, data: bytes) -> None:  # pragma: no cover - unused
        raise AssertionError("no frame expected")

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        self.close_code = code
        self.client_state = WebSocketState.DISCONNECTED


class _FakeManager:
    def __init__(self, *events: dict[str, Any]) -> None:
        self._events = events

    async def attach_to_run(
        self, _session_id: str, _run_id: str, _last_seq: int
    ) -> AsyncIterator[dict[str, Any]]:
        for event in self._events:
            yield event


async def _resync_message(*events: dict[str, Any]) -> tuple[dict[str, Any], _FakeSocket]:
    socket = _FakeSocket()
    await _stream_run_to_websocket(
        socket,  # type: ignore[arg-type]
        _FakeManager(*events),  # type: ignore[arg-type]
        "s1",
        "run-1",
        last_seq=0,
        include_run_id_in_metadata=True,
    )
    (message,) = socket.text
    return message, socket


async def test_the_resync_for_a_lagging_client_reaches_it_with_the_cause_and_reason() -> None:
    message, socket = await _resync_message(
        {
            "type": "resync",
            "current_seq": 42,
            "cause": "client_lagged",
            "reason": "the client fell behind",
        }
    )

    assert message == {
        "type": "resync",
        "run_id": "run-1",
        "current_seq": 42,
        "cause": "client_lagged",
        "reason": "the client fell behind",
    }
    assert socket.close_code == 1000


async def test_a_resync_without_a_reason_keeps_the_resume_buffer_wording() -> None:
    message, _socket = await _resync_message(
        {"type": "resync", "current_seq": 7, "cause": "buffer_evicted"}
    )

    assert message["cause"] == "buffer_evicted"
    assert message["reason"] == (
        "frame fell out of the resume buffer; re-fetch via the batch endpoint"
    )


async def test_a_resync_event_with_no_cause_is_sent_as_a_buffer_eviction() -> None:
    """``resync`` was only ever the resume-buffer case before the cause existed,
    so an event that names none is that case."""
    message, _socket = await _resync_message({"type": "resync", "current_seq": 7})

    assert message["cause"] == "buffer_evicted"
