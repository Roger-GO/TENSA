"""What a streaming run and a sweep keep for a client that attaches late.

A streaming TDS run keeps its frames in a ``_RunBuffer`` and a sweep keeps its
iterations in a ``_SweepBuffer``, both for ``RUN_BUFFER_RETENTION_SECONDS`` after
they finish, so a client that reconnects can replay what it missed. The buffers
hold no reference to the session manager; the runs and sweeps modules of this
package fill and read them.
"""

from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Literal

RunState = Literal["pending", "running", "completed", "error"]


# How many events one attached client may have waiting before it counts as
# unable to keep up (see ``_RunConsumer``).
RUN_CONSUMER_QUEUE_SIZE = 10000


class _RunConsumer:
    """The inbox of one client attached to a streaming run.

    The run never waits for its clients. Frames go to the run buffer and to
    every inbox as the worker produces them, so a client that stops reading (a
    stalled browser tab, a dead connection nobody has noticed yet) must neither
    hold the solver back nor grow the server's memory, and its inbox is
    bounded. When the inbox fills, the client has missed frames that the run
    buffer may no longer hold, so it cannot be caught up. The inbox is emptied
    and left holding one ``lagged`` marker, and nothing more is queued for this
    client: ``attach_to_run`` turns the marker into a ``resync`` event, so the
    client is told it missed frames instead of receiving a stream with a hole
    in it.
    """

    def __init__(self, size: int = RUN_CONSUMER_QUEUE_SIZE) -> None:
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=size)
        self.lagged = False

    def offer(self, event: dict[str, Any]) -> None:
        """Queue ``event`` without waiting; a full inbox marks the client lagged."""
        if self.lagged:
            return
        try:
            self.queue.put_nowait(event)
        except asyncio.QueueFull:
            self.lagged = True
            while not self.queue.empty():
                self.queue.get_nowait()
            self.queue.put_nowait({"type": "lagged"})


@dataclass
class _RunBuffer:
    """Server-side buffer for an active or recently-completed streaming run.

    The run survives WebSocket disconnect: as long as the buffer is retained,
    a client can reconnect with a ``resume`` message and replay any frames
    still in the buffer plus any frames that arrived while disconnected.

    The buffer's deque is bounded so memory is fixed regardless of run length.
    Default size is 30 seconds of frames at the configured output rate, with
    a safety floor of 1000 frames when no rate is configured (``decimation="none"``
    + no ``max_rate_hz``).
    """

    run_id: str
    session_id: str
    metadata: dict[str, Any] | None = None
    frames: deque[tuple[int, bytes]] = field(default_factory=lambda: deque(maxlen=1000))
    state: RunState = "pending"
    result_payload: dict[str, Any] | None = None
    error: tuple[str, str] | None = None  # (category, detail)
    consumers: list[_RunConsumer] = field(default_factory=list)
    finished_at: float | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def publish(self, event: dict[str, Any]) -> None:
        """Hand ``event`` to every attached client without waiting for any."""
        for consumer in self.consumers:
            consumer.offer(event)


# Retention window for completed run buffers. After this many seconds since
# completion, the buffer is eligible for cleanup by the reaper. The window
# matches the plan's 30-second resume horizon.
RUN_BUFFER_RETENTION_SECONDS = 30.0


SweepState = Literal["pending", "running", "completed", "error", "aborted"]


@dataclass
class _SweepBuffer:
    """Server-side buffer for an active or recently-completed sweep — Unit 18.

    Per-iteration progress events flow into ``events`` (an asyncio Queue
    snapshot deque mirror, similar to ``_RunBuffer.frames`` but JSON-shaped
    rather than binary). Consumers attach via
    ``SessionManager.attach_to_sweep`` and replay any buffered events
    older than their last-seen iteration index, then receive live events.

    Sweep iterations are bounded (Unit 18 plan caps at 200) so the deque
    is unbounded — we keep every iteration's event for the sweep
    lifetime + ``RUN_BUFFER_RETENTION_SECONDS`` post-completion.
    """

    sweep_id: str
    session_id: str
    parameter_kind: str = ""
    parameter_target: int = 0
    snapshot_name: str = ""
    total: int = 0
    completed_iterations: int = 0
    iterations: list[dict[str, Any]] = field(default_factory=list)
    state: SweepState = "pending"
    error: tuple[str, str] | None = None  # (category, detail)
    truncated: bool = False
    consumers: list[asyncio.Queue[dict[str, Any]]] = field(default_factory=list)
    finished_at: float | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
