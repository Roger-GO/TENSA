/**
 * `SweepStream` — owns the WebSocket lifecycle for one sensitivity sweep
 * — Unit 18.
 *
 * As of v3.1 Unit 6 ``SweepStream`` is the ``'sweep'``-kind view over the
 * generalised job model (``JobStream`` / ``useJobsStore``). The two operate
 * on DIFFERENT WS channels by design — ``JobStream`` consumes the
 * per-session multiplexed ``/jobs/events`` feed (one socket per session,
 * lean ``{job_id, kind, status, ...}`` envelopes), while ``SweepStream``
 * consumes the dedicated per-sweep ``/sweep/{sweepId}`` feed that carries
 * the full per-iteration payloads the sweep store needs. ``JobStream`` is
 * the canonical lifecycle source (a sweep's ``pending → running → done``
 * transitions flow through it and into ``useJobsStore`` keyed by the
 * ``sweep_id`` job id); ``SweepStream`` remains the fine-grained iteration
 * source. The ``SweepStreamView`` typed alias below documents that
 * relationship so consumers reason about both through one job-kind lens
 * without any runtime change — existing ``SweepStream`` consumers are
 * UNAFFECTED.
 *
 * Responsibilities:
 *
 * 1. Open WS to ``/ws/{sessionId}/sweep/{sweepId}`` with the auth handshake.
 * 2. Drain the snapshot envelope (initial buffer state).
 * 3. Forward each iteration event to the sweep store via ``onIteration``.
 * 4. Close cleanly on the terminal ``finished`` event.
 *
 * Unlike ``RunStream``, this stream is intentionally simple:
 * - Text-only frames (no Arrow IPC binary).
 * - No per-frame auto-reconnect — sweeps are bounded (50 iterations
 *   max) and the WS lifetime is short. If the connection drops the
 *   user can re-open the sweep panel which re-attaches via
 *   ``last_iteration`` query param.
 * - No ring-buffer eviction concerns — every iteration is small
 *   (a JSON object), the substrate keeps them all.
 */
import type { JobKind } from '@/store/jobs';

const log = console;

export interface SweepIteration {
  iteration: number;
  parameter_value: number;
  converged: boolean;
  final_t: number;
  callpert_count: number;
  error: string | null;
}

export interface SweepSnapshotEvent {
  sweepId: string;
  total: number;
  state: string;
  iterationsSoFar: SweepIteration[];
}

export interface SweepFinishedEvent {
  state: 'completed' | 'error' | 'aborted';
  error?: { category: string; detail: string };
}

export interface SweepStreamError {
  code: 'auth_failed' | 'sweep_not_found' | 'protocol_error' | 'worker_error';
  reason: string;
}

export interface SweepStreamOptions {
  sessionId: string;
  sweepId: string;
  token: string;
  /** Full WS URL prefix. ``buildRunStreamWsUrl()`` returns the right value. */
  wsUrl: string;
  /** Optional resume cursor. Default ``-1`` replays everything from index 0. */
  lastIteration?: number;
  onSnapshot?: (event: SweepSnapshotEvent) => void;
  onIteration?: (iter: SweepIteration) => void;
  onFinished?: (event: SweepFinishedEvent) => void;
  onError?: (error: SweepStreamError) => void;
}

export type WebSocketLike = WebSocket;
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface SweepStreamInternalDeps {
  webSocketCtor?: WebSocketCtor;
}

export class SweepStream {
  private readonly opts: SweepStreamOptions;
  private readonly wsCtor: WebSocketCtor;
  private ws: WebSocketLike | null = null;
  private phase: 'idle' | 'connecting' | 'authenticating' | 'streaming' | 'closed' = 'idle';

  constructor(opts: SweepStreamOptions, deps: SweepStreamInternalDeps = {}) {
    this.opts = opts;
    // ``WebSocket`` is the global default; tests inject a ``mock-socket``
    // ctor via ``deps.webSocketCtor``.
    this.wsCtor =
      deps.webSocketCtor ??
      (typeof WebSocket !== 'undefined' ? WebSocket : (null as unknown as WebSocketCtor));
  }

  /** Open the WS connection. Idempotent — re-calling start() is a no-op. */
  start(): void {
    if (this.phase !== 'idle') return;
    if (!this.wsCtor) {
      this.opts.onError?.({
        code: 'protocol_error',
        reason: 'WebSocket ctor unavailable in this environment',
      });
      this.phase = 'closed';
      return;
    }

    const last = this.opts.lastIteration ?? -1;
    const url = `${this.opts.wsUrl}/api/ws/${encodeURIComponent(
      this.opts.sessionId,
    )}/sweep/${encodeURIComponent(this.opts.sweepId)}?last_iteration=${last}`;

    this.phase = 'connecting';
    try {
      this.ws = new this.wsCtor(url);
    } catch (err) {
      this.opts.onError?.({
        code: 'protocol_error',
        reason: `WebSocket construction failed: ${(err as Error).message}`,
      });
      this.phase = 'closed';
      return;
    }

    this.ws.onopen = () => {
      this.phase = 'authenticating';
      try {
        this.ws?.send(JSON.stringify({ type: 'auth', token: this.opts.token }));
      } catch (err) {
        log.warn('SweepStream: auth send failed', err);
      }
    };

    this.ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') {
        // The sweep WS is text-only.
        log.warn('SweepStream: ignored non-text frame');
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        this.opts.onError?.({
          code: 'protocol_error',
          reason: 'failed to parse JSON frame',
        });
        return;
      }
      const type = msg['type'];
      if (type === 'ready') {
        this.phase = 'streaming';
        return;
      }
      if (type === 'snapshot') {
        const iters = Array.isArray(msg['iterations_so_far'])
          ? (msg['iterations_so_far'] as SweepIteration[])
          : [];
        this.opts.onSnapshot?.({
          sweepId: String(msg['sweep_id'] ?? this.opts.sweepId),
          total: Number(msg['total'] ?? 0),
          state: String(msg['state'] ?? 'pending'),
          iterationsSoFar: iters,
        });
        // Replay any iterations included in the snapshot too — the
        // server includes them when the client attaches mid-sweep.
        for (const iter of iters) {
          this.opts.onIteration?.(iter);
        }
        return;
      }
      if (type === 'iteration') {
        const result = msg['result'];
        if (result && typeof result === 'object') {
          this.opts.onIteration?.(result as SweepIteration);
        }
        return;
      }
      if (type === 'finished') {
        const errorRaw = msg['error'];
        const event: SweepFinishedEvent = {
          state: (msg['state'] as 'completed' | 'error' | 'aborted') ?? 'completed',
        };
        if (errorRaw && typeof errorRaw === 'object') {
          const eo = errorRaw as Record<string, unknown>;
          event.error = {
            category: String(eo['category'] ?? 'unknown'),
            detail: String(eo['detail'] ?? ''),
          };
        }
        this.opts.onFinished?.(event);
        this.phase = 'closed';
        return;
      }
      if (type === 'error') {
        this.opts.onError?.({
          code: 'worker_error',
          reason: String(msg['reason'] ?? 'unknown error'),
        });
        this.phase = 'closed';
        return;
      }
      log.warn('SweepStream: unknown frame type', type);
    };

    this.ws.onerror = (ev: Event) => {
      log.warn('SweepStream: WS error', ev);
    };

    this.ws.onclose = (ev: CloseEvent) => {
      if (this.phase === 'closed') return;
      const code = ev.code;
      // Substrate WS close codes from ``api/routes/sweep.py``.
      if (code === 4401) {
        this.opts.onError?.({ code: 'auth_failed', reason: ev.reason });
      } else if (code === 4404) {
        this.opts.onError?.({ code: 'sweep_not_found', reason: ev.reason });
      } else if (code === 1000) {
        // Normal close after ``finished`` — already handled above.
      } else {
        this.opts.onError?.({
          code: 'protocol_error',
          reason: `WS closed with code ${code}: ${ev.reason}`,
        });
      }
      this.phase = 'closed';
    };
  }

  /** Close the WS. Safe to call multiple times. */
  dispose(): void {
    this.phase = 'closed';
    try {
      this.ws?.close(1000, 'client closing');
    } catch {
      // already closed
    }
    this.ws = null;
  }
}

/**
 * The job kind this stream is a view of. Pins the relationship between
 * ``SweepStream`` and the generalised job model at the type level: a sweep
 * surfaces in ``useJobsStore`` under a ``JobRecord`` whose ``kind`` is
 * exactly this value, keyed by the ``sweep_id`` (which the substrate aliases
 * onto the registry ``job_id``).
 */
export const SWEEP_JOB_KIND: Extract<JobKind, 'sweep'> = 'sweep';

/**
 * Typed view alias — ``SweepStream`` IS the ``'sweep'``-kind window onto the
 * job model. Declared as a distinct exported type so call sites and future
 * units can name "the sweep view of a job stream" without re-deriving the
 * class shape, and so a hypothetical generic ``JobStreamView<K>`` can slot
 * ``SweepStream`` in for ``K extends 'sweep'`` without a cast. Runtime
 * identity: ``SweepStreamView === SweepStream``.
 */
export type SweepStreamView = SweepStream;
export const SweepStreamView = SweepStream;
