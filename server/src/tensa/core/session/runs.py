"""Streaming runs that outlive the client that started them."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from collections import deque
from collections.abc import AsyncIterator
from typing import Any

from tensa.core.errors import WorkerDiedError
from tensa.core.jobs import JobKind
from tensa.core.session.buffers import (
    RUN_BUFFER_RETENTION_SECONDS,
    RUN_CONSUMER_QUEUE_SIZE,
    RunState,
    _RunBuffer,
    _RunConsumer,
)
from tensa.core.session.errors import WORKER_DIED_CATEGORY, SessionExpiredError, WorkerError
from tensa.core.session.jobs import _stream_error_problem
from tensa.core.session.registry import RegistryMixin

log = logging.getLogger("tensa.session")


class RunsMixin(RegistryMixin):
    """A streaming run is a background task that fills a run buffer, so a client that
    drops can attach again and replay what it missed, and a job record that follows
    the run (its ``job_id`` is the ``run_id``)."""

    async def start_streaming_run(
        self,
        session_id: str,
        op: str,
        args: dict[str, Any],
    ) -> str:
        """Start a streaming run as a background task; return its ``run_id``.

        The run continues even if no client is currently attached. Frames
        flow into a per-run buffer (capacity sized from
        ``args["max_rate_hz"]`` × the retention window, falling back to
        1000 frames when no rate is configured). Clients attach via
        ``attach_to_run`` to replay buffered frames + receive live frames.

        Raises ``SessionExpiredError`` if the session is gone.
        """
        with self._registry_lock:
            sess = self._sessions.get(session_id)
        if sess is None or sess.closed:
            raise self._session_expired_error(session_id, sess)

        run_id = uuid.uuid4().hex
        max_rate_hz = args.get("max_rate_hz")
        if isinstance(max_rate_hz, (int, float)) and max_rate_hz > 0:
            max_frames = max(int(max_rate_hz * RUN_BUFFER_RETENTION_SECONDS), 64)
        else:
            max_frames = 1000

        run_buf = _RunBuffer(
            run_id=run_id,
            session_id=session_id,
            frames=deque(maxlen=max_frames),
        )
        self._runs[run_id] = run_buf

        # v3.1 Unit 5c: register the streaming run as a first-class job whose
        # ``job_id`` EQUALS the ``run_id`` (same value across both fields). The
        # ``_drive_streaming_run`` driver below transitions it running → done /
        # failed; cancellation is cooperative via the abort event so the record
        # is ``can_cancel=True``.
        self.register_streaming_job(
            session_id,
            run_id=run_id,
            kind="tds-stream",
            request_summary=_streaming_request_summary(args),
        )

        task = asyncio.create_task(
            self._drive_streaming_run(run_buf, op, args),
            name=f"tensa-run-{run_id[:8]}",
        )
        self._run_tasks[run_id] = task

        # Cleanup the task ref when it finishes (the buffer outlives the
        # task by RUN_BUFFER_RETENTION_SECONDS for resume).
        def _on_run_done(_task: asyncio.Task[None], rid: str = run_id) -> None:
            self._run_tasks.pop(rid, None)

        task.add_done_callback(_on_run_done)
        return run_id

    async def _drive_streaming_run(
        self,
        run_buf: _RunBuffer,
        op: str,
        args: dict[str, Any],
    ) -> None:
        """Background task: drives ``invoke_streaming`` against the worker
        and routes frames into the run buffer + connected consumers."""
        frame_seq_counter = 0

        async def _on_metadata(meta: dict[str, Any]) -> None:
            async with run_buf.lock:
                run_buf.metadata = meta
                run_buf.state = "running"
                run_buf.publish({"type": "metadata", "data": meta})
            # v3.1 Unit 5c: the worker has begun emitting frames — flip the
            # registry record running so the activity panel shows the spinner.
            self._mark_streaming_job_running(run_buf)

        async def _on_frame(payload: bytes) -> None:
            nonlocal frame_seq_counter
            async with run_buf.lock:
                frame_seq_counter += 1
                seq = frame_seq_counter
                run_buf.frames.append((seq, payload))
                run_buf.publish({"type": "frame", "seq": seq, "payload": payload})

        try:
            result = await self.invoke_streaming(
                run_buf.session_id,
                op,
                args,
                on_metadata=_on_metadata,
                on_frame=_on_frame,
                timeout=300.0,
            )
        except WorkerDiedError as exc:
            # The worker crashed mid-stream; ``invoke_streaming`` already marked
            # the session dead. Finish the buffer as a recoverable error carrying
            # the ``WorkerDied`` category so the WS terminal frame is actionable.
            await self._finish_run_buffer(
                run_buf, "error", error=(WORKER_DIED_CATEGORY, exc.detail)
            )
            return
        except SessionExpiredError as exc:
            await self._finish_run_buffer(
                run_buf, "error", error=("session-expired", str(exc))
            )
            return
        except WorkerError as exc:
            await self._finish_run_buffer(
                run_buf, "error", error=(exc.category, exc.detail)
            )
            return
        except Exception as exc:  # noqa: BLE001 — last-resort
            await self._finish_run_buffer(
                run_buf, "error", error=("internal-error", str(exc))
            )
            return

        await self._finish_run_buffer(run_buf, "completed", result=result)

    async def _finish_run_buffer(
        self,
        run_buf: _RunBuffer,
        state: RunState,
        *,
        result: dict[str, Any] | None = None,
        error: tuple[str, str] | None = None,
    ) -> None:
        async with run_buf.lock:
            run_buf.state = state
            run_buf.result_payload = result
            run_buf.error = error
            run_buf.finished_at = time.monotonic()
            run_buf.publish({"type": "finished"})
        # v3.1 Unit 5c: reconcile the registry record (job_id == run_id) to its
        # terminal status so the activity panel resolves the spinner. Done
        # outside the buffer lock since it touches a different lock (the
        # registry's) and broadcasts.
        self._finish_streaming_job(run_buf, state, error=error)

    async def attach_to_run(
        self,
        session_id: str,
        run_id: str,
        last_seq: int,
    ) -> AsyncIterator[dict[str, Any]]:
        """Attach to a streaming run and yield its events. Replays buffered
        frames after ``last_seq`` (use 0 to receive everything from the
        start), then streams live frames + the final ``done`` or ``error``
        event.

        Yields events shaped:

          {"type": "metadata", "data": {...}}      (always once at start)
          {"type": "frame", "seq": N, "payload": <bytes>}   (one per frame)
          {"type": "done", "result": {...}}        (terminal)
          {"type": "error", "category": "...", "detail": "..."}  (terminal)
          {"type": "resync", "current_seq": N,     (terminal; client must
           "cause": "...", "reason"?: "..."}        re-fetch via batch endpoint)
          {"type": "not_found"}                    (terminal; unknown run_id
                                                    or wrong session)

        ``resync`` is sent when the requested frames have left the run buffer
        (``cause`` ``"buffer_evicted"``), and also when this client falls so
        far behind a live run that its inbox fills (``RUN_CONSUMER_QUEUE_SIZE``
        events; ``cause`` ``"client_lagged"``, with a ``reason``). A client is
        never sent frames with some missing.
        """
        run_buf = self._runs.get(run_id)
        if run_buf is None or run_buf.session_id != session_id:
            yield {"type": "not_found"}
            return

        consumer = _RunConsumer()
        last_yielded_seq = last_seq

        async with run_buf.lock:
            # Validate the resume request against the buffer's current range.
            if last_seq > 0 and run_buf.frames:
                min_seq = run_buf.frames[0][0]
                max_seq = run_buf.frames[-1][0]
                if last_seq + 1 < min_seq:
                    # Frame last_seq+1 has been evicted from the ring buffer.
                    yield {
                        "type": "resync",
                        "current_seq": max_seq,
                        "cause": "buffer_evicted",
                    }
                    return

            # Subscribe FIRST so any new frame goes to the queue, then snapshot.
            run_buf.consumers.append(consumer)
            snapshot_metadata = run_buf.metadata
            snapshot_frames = list(run_buf.frames)
            snapshot_state = run_buf.state
            snapshot_result = run_buf.result_payload
            snapshot_error = run_buf.error

        try:
            # Replay metadata (only if we don't already have it; resume after
            # buffered metadata still re-yields it so the client can rebuild
            # its decoder).
            if snapshot_metadata is not None:
                yield {"type": "metadata", "data": snapshot_metadata}

            # Replay buffered frames after last_seq.
            for seq, payload in snapshot_frames:
                if seq > last_seq:
                    yield {"type": "frame", "seq": seq, "payload": payload}
                    last_yielded_seq = seq

            # If the run already finished by the time we attached, yield the
            # terminal event from the snapshot and exit.
            if snapshot_state == "completed":
                yield {"type": "done", "result": snapshot_result}
                return
            if snapshot_state == "error":
                assert snapshot_error is not None
                yield {
                    "type": "error",
                    "category": snapshot_error[0],
                    "detail": snapshot_error[1],
                }
                return

            # Live phase: drain queue. Skip events whose seq we already
            # yielded from the snapshot (race-window dedup).
            while True:
                event = await consumer.queue.get()
                event_type = event.get("type")

                if event_type == "lagged":
                    log.warning(
                        "run %s: a client fell %d events behind; sending resync",
                        run_buf.run_id[:8],
                        RUN_CONSUMER_QUEUE_SIZE,
                    )
                    yield {
                        "type": "resync",
                        "current_seq": run_buf.frames[-1][0] if run_buf.frames else 0,
                        "cause": "client_lagged",
                        "reason": (
                            "the client fell too far behind the run and missed "
                            "frames; re-run to get the whole stream"
                        ),
                    }
                    return
                if event_type == "frame":
                    seq = int(event["seq"])
                    if seq <= last_yielded_seq:
                        continue
                    last_yielded_seq = seq
                    yield event
                elif event_type == "metadata":
                    if snapshot_metadata is None:
                        yield event
                elif event_type == "finished":
                    # Re-read run state — _finish_run_buffer set it before
                    # delivering this event.
                    if run_buf.state == "completed":
                        yield {"type": "done", "result": run_buf.result_payload}
                    elif run_buf.state == "error":
                        assert run_buf.error is not None
                        yield {
                            "type": "error",
                            "category": run_buf.error[0],
                            "detail": run_buf.error[1],
                        }
                    return
        finally:
            async with run_buf.lock:
                with contextlib.suppress(ValueError):
                    run_buf.consumers.remove(consumer)

    def register_streaming_job(
        self,
        session_id: str,
        *,
        run_id: str,
        kind: JobKind = "tds-stream",
        request_summary: dict[str, Any] | None = None,
    ) -> str:
        """Register a streaming TDS run as a first-class job (Unit 5c).

        The registry ``job_id`` is aliased onto the caller-minted ``run_id`` —
        the same value is reused so the wire shape gains a ``job_id`` field
        equal to the legacy ``run_id`` with nothing removed. The record is
        created ``pending`` + ``can_cancel=True`` (the run has a cooperative
        abort via the session's abort event) and broadcast to ``/jobs/events``
        subscribers. ``_drive_streaming_run`` flips it running → done / failed.

        A no-op-on-duplicate (returns the existing id) so a resume that re-runs
        ``start_streaming_run`` plumbing never clobbers the live record. Returns
        the ``job_id`` ( == ``run_id``). Silently no-ops when the session is
        already gone.
        """
        with self._registry_lock:
            sess = self._sessions.get(session_id)
        if sess is None or sess.closed:
            return run_id
        sess.job_registry.register_job(
            kind=kind,
            can_cancel=True,
            request_summary=request_summary or {},
            job_id=run_id,
        )
        record = sess.job_registry.get_job(run_id)
        if record is not None:
            self.broadcast_job_event(session_id, record)
        return run_id

    def _mark_streaming_job_running(self, run_buf: _RunBuffer) -> None:
        """Flip the streaming run's registry record running + broadcast."""
        with self._registry_lock:
            sess = self._sessions.get(run_buf.session_id)
        if sess is None:
            return
        sess.job_registry.mark_running(run_buf.run_id)
        record = sess.job_registry.get_job(run_buf.run_id)
        if record is not None:
            self.broadcast_job_event(run_buf.session_id, record)

    def _finish_streaming_job(
        self,
        run_buf: _RunBuffer,
        state: RunState,
        *,
        error: tuple[str, str] | None,
    ) -> None:
        """Reconcile the streaming run's registry record to terminal (Unit 5c).

        ``completed`` → ``done``; ``error`` → ``failed`` with a synthesized
        ``ProblemDetails`` built from the ``(category, detail)`` error tuple.
        The ``pending`` / ``running`` states are non-terminal and never reach
        here. Broadcasts the transition. A no-op when the session is gone.
        """
        with self._registry_lock:
            sess = self._sessions.get(run_buf.session_id)
        if sess is None:
            return
        registry = sess.job_registry
        terminal_id = run_buf.run_id
        if state == "completed":
            registry.mark_done(run_buf.run_id)
        elif state == "error":
            # ``mark_failed`` may coalesce into a prior same-signature record
            # (deleting ``run_id``); broadcast the survivor it returns so the
            # terminal transition is not dropped.
            terminal_id = registry.mark_failed(
                run_buf.run_id,
                problem=_stream_error_problem("tds-stream", error),
            )
        record = registry.get_job(terminal_id)
        if record is not None:
            self.broadcast_job_event(run_buf.session_id, record)


def _streaming_request_summary(args: dict[str, Any]) -> dict[str, Any]:
    """User-facing variables captured for a streaming-TDS job's retry (Unit 5c).

    Mirrors the routine routes' ``request.model_dump()`` summaries: the fields a
    Retry button (Unit 11) would replay. Internal plumbing flags (``stream``)
    are dropped; only the user-meaningful run parameters are kept.
    """
    summary: dict[str, Any] = {}
    for key in ("tf", "h", "integrator", "decimation", "max_rate_hz", "vars"):
        if key in args and args[key] is not None:
            summary[key] = args[key]
    if args.get("tds_config_overrides") is not None:
        summary["tds_config_overrides"] = args["tds_config_overrides"]
    return summary
