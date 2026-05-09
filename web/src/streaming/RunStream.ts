/**
 * `RunStream` — owns the WebSocket lifecycle for a single TDS run.
 *
 * Responsibilities:
 *
 * 1. Open WS to ``/ws/{sessionId}`` (``binaryType = "arraybuffer"``).
 * 2. Send ``{type: "auth", token}`` within the substrate's 2-second deadline.
 * 3. Wait for ``{type: "ready"}``.
 * 4. Send ``{type: "start_tds", tf, h, decimation: "mean", max_rate_hz: 30, vars}``
 *    OR (on resume) ``{type: "resume", run_id, last_seq}``.
 * 5. Wait for ``{type: "stream_start", run_id, metadata}`` — capture
 *    ``run_id`` and ``metadata.var_columns`` from the substrate.
 * 6. For each WS binary message: decode the Arrow batch, append to the
 *    runs store, emit ``onFrame``.
 * 7. On ``{type: "done", ...}``: emit ``onDone``, mark store, close cleanly.
 * 8. On ``{type: "resync", ...}``: emit ``onError({code: "buffer_evicted"})``,
 *    tear down. **Terminal — does NOT auto-reconnect.**
 * 9. On ``WebSocket.onclose`` (code != 1000) mid-stream: schedule a
 *    reconnect attempt with exponential backoff, then send ``resume``.
 *
 * **`last_seq` accounting** (per the v0.2 plan): the WS wire format does
 * NOT expose a per-frame ``seq`` field. The client tracks ``last_seq`` as
 * the count of **rows** decoded since ``stream_start``. The substrate's
 * internal ``frame_seq`` matches this count because TCP guarantees
 * ordering within one WS connection. Future maintainers: do NOT search
 * the wire format for a ``seq`` field — there isn't one.
 *
 * **Run-not-found** (close 4404 after resume): the server may have
 * restarted, or the retention window elapsed. Emits
 * ``onError({code: "run_not_found"})``. **Distinguished from 4401** —
 * which means the auth token is invalid/stale and the UI must clear it.
 *
 * **Resync** (server sends ``{type: "resync", ...}`` then closes): the
 * client's ``last_seq`` fell out of the substrate's ring buffer. Emits
 * ``onError({code: "buffer_evicted"})`` and does **not** auto-reconnect
 * (the reason for resync is "we waited too long"; reconnecting would
 * reopen the same gap).
 *
 * **Frame buffer cap**: lives in the runs slice, not here. ``RunStream``
 * just calls ``appendFrame`` and lets the slice handle cap-eviction.
 */
import { decodeArrowBatch } from './arrow';
import type { DecodedFrame } from './arrow';
import {
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_RECONNECT_DELAYS_MS,
  delayForAttempt,
  shouldGiveUp,
} from './reconnect';
import { useRunsStore } from '@/store/runs';

const log = console;

/** Variable group selector forwarded to ``start_tds``. */
export type VarGroup = 'bus_v' | 'gen_state' | 'line_flow';

/** Args for the ``start_tds`` message; the UI clamps ``max_rate_hz`` to 30. */
export interface TdsArgs {
  /** Final sim time in seconds. Required. */
  tf: number;
  /** Optional fixed step (seconds). Substrate default if omitted. */
  h?: number;
  /** Variable groups to stream. Defaults to ``["bus_v"]``. */
  vars?: readonly VarGroup[];
}

/** Connection-status events surfaced to the UI status badge. */
export interface ConnectionStatusEvent {
  state: 'connected' | 'reconnecting' | 'disconnected' | 'lagged';
  /** Optional human-facing reason. ``"max_retries"`` after backoff exhaustion. */
  reason?: string;
  /** 0-indexed reconnect attempt count when state === "reconnecting". */
  attempt?: number;
}

/** Errors emitted via ``onError``. The codes mirror the v0.2 plan's taxonomy. */
export interface RunStreamError {
  code:
    | 'auth_failed'
    | 'run_not_found'
    | 'buffer_evicted'
    | 'protocol_error'
    | 'worker_error'
    | 'max_retries';
  reason: string;
  /** Server-reported sequence number on ``buffer_evicted``. */
  currentSeq?: number;
}

/** ``stream_start.metadata`` shape (mirrors ``server/core/worker.py``). */
export interface StreamStartMetadata {
  schema_version: string;
  decimation: {
    algorithm: string;
    mode: string;
    source_rate_hz: number | null;
    output_rate_hz: number | null;
    fixed_step: number | null;
  };
  vars: VarGroup[];
  var_columns: string[];
  bus_idx_values?: string[];
  syngen_idx_values?: string[];
  line_idx_values?: string[];
}

/** ``stream_start`` event surfaced to the UI. */
export interface StreamStartEvent {
  runId: string;
  metadata: StreamStartMetadata;
}

/** ``done`` event surfaced to the UI. */
export interface DoneEvent {
  runId: string;
  converged: boolean;
  finalT: number;
  callpertCount: number;
}

export interface RunStreamOptions {
  /** Session id from the substrate (URL-safe). */
  sessionId: string;
  /** Auth token (sent in the first WS text frame). */
  token: string;
  /**
   * Full WS URL prefix (e.g., ``"ws://localhost:43511"``). The session
   * path segment is appended by ``RunStream``. Exposed as a config so
   * tests can point at ``mock-socket``.
   */
  wsUrl: string;
  tdsArgs: TdsArgs;
  onStart?: (event: StreamStartEvent) => void;
  onFrame?: (frame: DecodedFrame) => void;
  onDone?: (event: DoneEvent) => void;
  onError?: (error: RunStreamError) => void;
  /** Resync is a special-case error; surfaced as a separate hook for the UI banner. */
  onResync?: (event: { runId: string; currentSeq: number; reason: string }) => void;
  onConnectionStatus?: (event: ConnectionStatusEvent) => void;
  /** Override reconnect delay schedule (test-only). */
  reconnectDelaysMs?: readonly number[];
  /** Override reconnect max-attempts (test-only). */
  maxReconnectAttempts?: number;
  /**
   * Output-rate clamp forwarded to the substrate. Defaults to 30 Hz per
   * the "Output rate clamp (UI-side contract)" decision in the plan.
   */
  maxRateHz?: number;
  /**
   * Decimation mode forwarded to the substrate. Defaults to ``"mean"``
   * per the same plan rule. Override only for tests.
   */
  decimation?: 'mean' | 'none';
}

/**
 * Phase of the WS state machine. ``"idle"`` before ``start()``;
 * ``"closed"`` after ``dispose()`` or terminal failure.
 */
type Phase =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'awaiting-stream-start'
  | 'streaming'
  | 'reconnecting'
  | 'closed';

/**
 * WebSocket constructor adapter — exposed so ``mock-socket`` can swap in
 * its ``WebSocket`` shim without monkey-patching the global.
 */
export type WebSocketLike = WebSocket;
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface RunStreamInternalDeps {
  webSocketCtor?: WebSocketCtor;
  /**
   * Scheduler used for reconnect delays — defaults to ``setTimeout``.
   * Tests inject a fake timer that returns synchronously.
   */
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** WS protocol close codes (mirrors ``server/api/routes/ws.py``). */
const WS_CLOSE_AUTH_FAILED = 4401;
const WS_CLOSE_RUN_NOT_FOUND = 4404;
const WS_CLOSE_WORKER_ERROR = 4500;
const WS_CLOSE_NORMAL = 1000;

export class RunStream {
  private readonly opts: RunStreamOptions;
  private readonly deps: Required<RunStreamInternalDeps>;
  private ws: WebSocketLike | null = null;
  private phase: Phase = 'idle';
  /** Server-assigned run id (captured from ``stream_start``). */
  private runId: string | null = null;
  /** Logical row count appended since ``stream_start``. Used as ``last_seq``. */
  private rowCount = 0;
  /** Reconnect attempt counter (0-indexed). Reset on each successful frame. */
  private reconnectAttempt = 0;
  /** Pending reconnect timer handle. */
  private reconnectTimer: unknown = null;
  /** Once true, no more events will fire (dispose called). */
  private disposed = false;

  constructor(opts: RunStreamOptions, deps: RunStreamInternalDeps = {}) {
    this.opts = opts;
    this.deps = {
      webSocketCtor: deps.webSocketCtor ?? (globalThis.WebSocket as unknown as WebSocketCtor),
      setTimeout:
        deps.setTimeout ??
        (globalThis.setTimeout.bind(globalThis) as RunStreamInternalDeps['setTimeout'])!,
      clearTimeout:
        deps.clearTimeout ?? ((handle: unknown) => globalThis.clearTimeout(handle as number)),
    };
  }

  /** True once a terminal event has fired (success or failure). */
  get isClosed(): boolean {
    return this.phase === 'closed';
  }

  /** Server-assigned run id, or null until ``stream_start`` arrives. */
  get currentRunId(): string | null {
    return this.runId;
  }

  /**
   * Open the WebSocket and run the auth + start_tds handshake. Idempotent
   * within a single ``RunStream`` instance — repeated calls after the
   * first are no-ops.
   */
  start(): void {
    if (this.phase !== 'idle') return;
    this.phase = 'connecting';
    this.openSocket(/*resume=*/ false);
  }

  /**
   * Tear down the WebSocket and cancel any pending reconnect. Safe to
   * call from any phase — including before ``start()`` opens the socket
   * (the race the v0.2 plan calls out: ``start()`` then immediate
   * ``dispose()``).
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.phase = 'closed';
    if (this.reconnectTimer !== null) {
      this.deps.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws !== null) {
      const ws = this.ws;
      // Strip handlers FIRST — close events fired during ``ws.close()`` would
      // otherwise re-enter the state machine and (in the pre-open race) try
      // to reconnect.
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close(WS_CLOSE_NORMAL, 'client disposed');
      } catch {
        // close() can throw if the socket is already closed; not actionable.
      }
      this.ws = null;
    }
  }

  // ---- internal: socket lifecycle -----------------------------------------

  private openSocket(resume: boolean): void {
    const url = `${this.opts.wsUrl.replace(/\/+$/, '')}/ws/${this.opts.sessionId}`;
    let ws: WebSocketLike;
    try {
      ws = new this.deps.webSocketCtor(url);
    } catch (err) {
      this.emitError({
        code: 'protocol_error',
        reason: `failed to open WebSocket: ${(err as Error).message}`,
      });
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.phase = 'authenticating';

    ws.onopen = (): void => {
      if (this.disposed) return;
      this.send({ type: 'auth', token: this.opts.token });
    };

    ws.onmessage = (ev: MessageEvent): void => {
      if (this.disposed) return;
      this.handleMessage(ev, resume);
    };

    ws.onclose = (ev: CloseEvent): void => {
      if (this.disposed) return;
      this.handleClose(ev);
    };

    ws.onerror = (): void => {
      // Don't emit here — onclose fires immediately after onerror with
      // the close code that determines the right error path. Logging
      // only so the maintainer sees something in the console.
      log.warn('[RunStream] WebSocket error event');
    };
  }

  private send(obj: unknown): void {
    if (this.ws === null) return;
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(obj));
  }

  private handleMessage(ev: MessageEvent, isResume: boolean): void {
    const data = ev.data;
    if (typeof data === 'string') {
      this.handleTextMessage(data, isResume);
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.handleBinaryMessage(data);
      return;
    }
    // jsdom + mock-socket can hand back a Blob; coerce. Real browsers
    // honor ``binaryType = 'arraybuffer'`` set in ``openSocket``.
    if (data instanceof Blob) {
      data
        .arrayBuffer()
        .then((buf) => {
          if (!this.disposed) this.handleBinaryMessage(buf);
        })
        .catch((err: Error) => {
          this.emitError({
            code: 'protocol_error',
            reason: `failed to read binary frame: ${err.message}`,
          });
        });
      return;
    }
    log.warn('[RunStream] unexpected WS message type', typeof data);
  }

  private handleTextMessage(text: string, isResume: boolean): void {
    let msg: { type?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(text);
    } catch (err) {
      this.emitError({
        code: 'protocol_error',
        reason: `bad JSON from server: ${(err as Error).message}`,
      });
      return;
    }

    switch (msg.type) {
      case 'ready':
        this.handleReady(isResume);
        return;
      case 'stream_start':
        this.handleStreamStart(
          msg as { type: 'stream_start'; run_id?: string; metadata?: unknown },
        );
        return;
      case 'done':
        this.handleDone(
          msg as {
            type: 'done';
            run_id?: string;
            converged?: boolean;
            final_t?: number;
            callpert_count?: number;
          },
        );
        return;
      case 'resync':
        this.handleResync(
          msg as {
            type: 'resync';
            run_id?: string;
            current_seq?: number;
            reason?: string;
          },
        );
        return;
      case 'error':
        // Server emitted a structured error frame just before close. The
        // close handler will fire next with the right code; we record the
        // reason for the close handler to propagate.
        log.warn('[RunStream] server error frame', msg);
        return;
      default:
        log.warn('[RunStream] unknown message type', msg.type);
    }
  }

  private handleReady(isResume: boolean): void {
    if (isResume) {
      if (this.runId === null) {
        this.emitError({
          code: 'protocol_error',
          reason: 'cannot resume without a run_id',
        });
        return;
      }
      this.send({ type: 'resume', run_id: this.runId, last_seq: this.rowCount });
    } else {
      const { tf, h, vars } = this.opts.tdsArgs;
      const payload: Record<string, unknown> = {
        type: 'start_tds',
        tf,
        decimation: this.opts.decimation ?? 'mean',
        max_rate_hz: this.opts.maxRateHz ?? 30,
      };
      if (h !== undefined) payload.h = h;
      if (vars !== undefined) payload.vars = vars;
      this.send(payload);
    }
    this.phase = 'awaiting-stream-start';
  }

  private handleStreamStart(msg: {
    type: 'stream_start';
    run_id?: string;
    metadata?: unknown;
  }): void {
    const runId = typeof msg.run_id === 'string' ? msg.run_id : null;
    if (runId === null) {
      this.emitError({
        code: 'protocol_error',
        reason: 'stream_start missing run_id',
      });
      return;
    }
    const metadata = msg.metadata as StreamStartMetadata;

    const isResume = this.runId !== null;
    if (!isResume) {
      // First-run path: register the run in the runs store with the
      // metadata's column list. Resume path: store already has the run;
      // re-emitted stream_start is just so the JS Arrow decoder rebuilds
      // its schema (which it does per-batch anyway, so no work here).
      this.runId = runId;
      this.rowCount = 0;
      const columnNames = Array.isArray(metadata?.var_columns) ? metadata.var_columns : [];
      useRunsStore.getState().startRun({
        runId,
        tf: this.opts.tdsArgs.tf,
        columnNames,
      });
      this.opts.onStart?.({ runId, metadata });
    } else {
      // Resume: clear "reconnecting" status now that we have a fresh
      // stream_start; the next binary frame will be the first replayed
      // one.
      useRunsStore.getState().setRunConnection(this.runId!, 'connected');
      this.opts.onConnectionStatus?.({ state: 'connected' });
    }
    this.phase = 'streaming';
    // Successful handshake resets the reconnect counter — a future
    // disconnect starts the backoff fresh.
    this.reconnectAttempt = 0;
  }

  private handleBinaryMessage(buffer: ArrayBuffer): void {
    if (this.phase !== 'streaming') {
      // Per the v0.2 plan: a binary frame before stream_start is a
      // protocol violation; drop + warn rather than crash.
      log.warn('[RunStream] dropping binary frame received before stream_start');
      return;
    }
    if (this.runId === null) return;
    let decoded: DecodedFrame;
    try {
      decoded = decodeArrowBatch(buffer);
    } catch (err) {
      this.emitError({
        code: 'protocol_error',
        reason: `arrow decode failed: ${(err as Error).message}`,
      });
      return;
    }
    if (decoded.numRows === 0) return;

    this.rowCount += decoded.numRows;
    useRunsStore.getState().appendFrame(this.runId, {
      t: decoded.t,
      columns: decoded.columns,
    });
    this.opts.onFrame?.(decoded);
  }

  private handleDone(msg: {
    type: 'done';
    run_id?: string;
    converged?: boolean;
    final_t?: number;
    callpert_count?: number;
  }): void {
    if (this.runId === null) return;
    const event: DoneEvent = {
      runId: this.runId,
      converged: Boolean(msg.converged),
      finalT: typeof msg.final_t === 'number' ? msg.final_t : 0,
      callpertCount: typeof msg.callpert_count === 'number' ? msg.callpert_count : 0,
    };
    useRunsStore.getState().markRunDone(this.runId, event.finalT);
    this.opts.onDone?.(event);
    // The server closes the socket cleanly after ``done``; we mark phase
    // here so a subsequent close with code 1000 doesn't try to reconnect.
    this.phase = 'closed';
    this.disposed = true;
  }

  private handleResync(msg: {
    type: 'resync';
    run_id?: string;
    current_seq?: number;
    reason?: string;
  }): void {
    const currentSeq = typeof msg.current_seq === 'number' ? msg.current_seq : 0;
    const reason = typeof msg.reason === 'string' ? msg.reason : 'frame fell out of resume buffer';
    if (this.runId !== null) {
      this.opts.onResync?.({ runId: this.runId, currentSeq, reason });
      useRunsStore.getState().markRunError(this.runId, `buffer evicted: ${reason}`);
    }
    this.emitError({ code: 'buffer_evicted', reason, currentSeq });
    // Resync is terminal — do NOT auto-reconnect (per v0.2 plan).
    this.phase = 'closed';
    this.disposed = true;
    this.tearDownSocket();
  }

  private handleClose(ev: CloseEvent): void {
    if (this.phase === 'closed') return;
    const code = ev.code;

    if (code === WS_CLOSE_AUTH_FAILED) {
      this.emitError({ code: 'auth_failed', reason: ev.reason || 'invalid token' });
      this.phase = 'closed';
      this.disposed = true;
      return;
    }
    if (code === WS_CLOSE_RUN_NOT_FOUND) {
      // 4404 BEFORE stream_start = unknown session; AFTER stream_start (so
      // we have a runId and were resuming) = run no longer exists on the
      // server. Both surface as ``run_not_found``; the UI message is
      // identical ("Reset and re-run").
      this.emitError({ code: 'run_not_found', reason: ev.reason || 'session/run not found' });
      this.phase = 'closed';
      this.disposed = true;
      return;
    }
    if (code === WS_CLOSE_WORKER_ERROR) {
      this.emitError({ code: 'worker_error', reason: ev.reason || 'worker error' });
      this.phase = 'closed';
      this.disposed = true;
      return;
    }
    if (code === WS_CLOSE_NORMAL) {
      // Clean close mid-stream is a no-op; server emits ``done`` and then
      // closes 1000, and ``handleDone`` already moved us to ``closed``.
      this.phase = 'closed';
      this.disposed = true;
      return;
    }

    // All other close codes (1006 abnormal, 1011 server error, ...) are
    // candidates for reconnect-with-resume IF we have a runId. Without
    // a runId (still in handshake), reconnect would just rerun start_tds
    // and the substrate would assign a NEW run_id — that's a fresh run,
    // not a resume. Surface as protocol error instead.
    if (this.runId === null) {
      this.emitError({
        code: 'protocol_error',
        reason: `WebSocket closed (${code}) before stream_start`,
      });
      this.phase = 'closed';
      this.disposed = true;
      return;
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (
      shouldGiveUp(this.reconnectAttempt, {
        delays: this.opts.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS,
        maxAttempts: this.opts.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS,
      })
    ) {
      this.opts.onConnectionStatus?.({ state: 'disconnected', reason: 'max_retries' });
      if (this.runId !== null) {
        useRunsStore.getState().setRunConnection(this.runId, 'disconnected');
      }
      this.emitError({ code: 'max_retries', reason: 'max reconnect attempts exhausted' });
      this.phase = 'closed';
      this.disposed = true;
      return;
    }
    const delay = delayForAttempt(this.reconnectAttempt, {
      delays: this.opts.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS,
      maxAttempts: this.opts.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS,
    });
    if (delay === null) return; // shouldGiveUp should have caught this; defensive.
    this.opts.onConnectionStatus?.({
      state: 'reconnecting',
      attempt: this.reconnectAttempt,
    });
    if (this.runId !== null) {
      useRunsStore.getState().setRunConnection(this.runId, 'reconnecting');
    }
    this.phase = 'reconnecting';
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.deps.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed) return;
      this.openSocket(/*resume=*/ true);
    }, delay);
  }

  private emitError(err: RunStreamError): void {
    this.opts.onError?.(err);
    if (this.runId !== null && err.code !== 'auth_failed') {
      useRunsStore.getState().markRunError(this.runId, err.reason);
    }
  }

  private tearDownSocket(): void {
    if (this.ws !== null) {
      const ws = this.ws;
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close(WS_CLOSE_NORMAL);
      } catch {
        // Already closed; ignore.
      }
      this.ws = null;
    }
  }
}
