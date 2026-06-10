/**
 * ``JobStream`` — owns ONE WebSocket per session against the substrate's
 * per-session multiplexed job-event channel (``WS /ws/{id}/jobs/events``,
 * v3.1 Unit 5a) and writes every transition into ``useJobsStore`` as the
 * canonical client-side state — v3.1 Unit 6.
 *
 * Generalises the original ``SweepStream`` JSON-WS consumer:
 *
 * 1. Open WS to ``/api/ws/{sessionId}/jobs/events`` with the shared
 *    handshake (server sends ``{type:'ready'}`` unprompted on connect) —
 *    identical to ``SweepStream`` / ``RunStream``.
 * 2. Drain the initial ``snapshot`` envelope (full job list) into the store
 *    via ``syncJobs``.
 * 3. For each subsequent ``job`` envelope, ``upsertJob`` into the store.
 * 4. On disconnect, re-open and re-sync via ``GET /sessions/{id}/jobs``
 *    (full state) — matches ``SweepStream``'s "re-attach replays current
 *    state" behaviour. The WS ``snapshot`` on reconnect ALSO re-syncs, so
 *    the HTTP re-sync is a belt-and-braces fast path for the window between
 *    the close and the reconnect's ``snapshot`` landing.
 *
 * Unlike ``RunStream`` this stream is text-only (no Arrow IPC) and unbounded
 * in lifetime — it lives for the whole session. The store applies the
 * retention cap, so there are no ring-buffer concerns here.
 */
import { andesClient } from '@/api/client';
import { useJobsStore } from '@/store/jobs';
import type { JobEventEnvelope } from '@/store/jobs';

const log = console;

export interface JobStreamError {
  code: 'session_not_found' | 'protocol_error' | 'internal_error';
  reason: string;
}

export interface JobStreamOptions {
  sessionId: string;
  /** Full WS URL prefix. ``buildRunStreamWsUrl()`` returns the right value. */
  wsUrl: string;
  /** Fired on every status event AFTER it is written to the store. */
  onEvent?: (envelope: JobEventEnvelope) => void;
  /** Fired once the initial snapshot has been synced into the store. */
  onSnapshot?: (jobs: readonly JobEventEnvelope[]) => void;
  /** Fired on a terminal/recoverable error. */
  onError?: (error: JobStreamError) => void;
  /** Reconnect backoff in ms. Default 1000. Set 0 in tests for determinism. */
  reconnectDelayMs?: number;
  /**
   * When false, a clean/dirty close is NOT followed by an auto-reconnect.
   * Default true. ``dispose()`` always wins regardless.
   */
  autoReconnect?: boolean;
}

export type WebSocketLike = WebSocket;
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface JobStreamInternalDeps {
  webSocketCtor?: WebSocketCtor;
  /**
   * HTTP re-sync hook (injectable for tests). Defaults to
   * ``GET /sessions/{id}/jobs``. Returns the full job list as event
   * envelopes for ``syncJobs``.
   */
  fetchJobs?: (sessionId: string) => Promise<JobEventEnvelope[]>;
}

// Substrate WS close codes — shared alphabet with TDS / sweep (see
// ``api/routes/jobs.py``).
const WS_CLOSE_NORMAL = 1000;
const WS_CLOSE_SESSION_NOT_FOUND = 4404;
const WS_CLOSE_INTERNAL_ERROR = 4500;

/**
 * Default HTTP re-sync: pull the full job list from the substrate and shape
 * it into the lean event-envelope form the store's ``syncJobs`` consumes.
 * The list endpoint returns ``JobRecordSchema[]`` (full records); we forward
 * the whole object, which is a superset of ``JobEventEnvelope`` once
 * ``id`` is re-keyed to ``job_id``.
 */
async function defaultFetchJobs(sessionId: string): Promise<JobEventEnvelope[]> {
  const records = await andesClient.get<Array<Record<string, unknown>>>(
    `/sessions/${encodeURIComponent(sessionId)}/jobs`,
    { timeoutMs: 10_000 },
  );
  return records.map((r) => recordToEnvelope(r));
}

/**
 * Coerce a substrate ``JobRecordSchema`` (or a WS snapshot entry) into a
 * ``JobEventEnvelope``. The list endpoint keys the id as ``id``; the WS
 * envelope keys it as ``job_id`` — accept either.
 */
function recordToEnvelope(raw: Record<string, unknown>): JobEventEnvelope {
  const jobId = (raw['job_id'] ?? raw['id']) as string;
  const env: JobEventEnvelope = {
    job_id: jobId,
    kind: raw['kind'] as JobEventEnvelope['kind'],
    status: raw['status'] as JobEventEnvelope['status'],
  };
  if (typeof raw['progress'] === 'number') env.progress = raw['progress'];
  if (raw['problem'] !== undefined && raw['problem'] !== null) {
    env.problem = raw['problem'] as JobEventEnvelope['problem'];
  }
  if (typeof raw['started_at'] === 'number') env.started_at = raw['started_at'];
  if (typeof raw['updated_at'] === 'number') env.updated_at = raw['updated_at'];
  if (typeof raw['ended_at'] === 'number') env.ended_at = raw['ended_at'];
  if (typeof raw['can_cancel'] === 'boolean') env.can_cancel = raw['can_cancel'];
  if (raw['request_summary'] !== undefined && raw['request_summary'] !== null) {
    env.request_summary = raw['request_summary'] as Record<string, unknown>;
  }
  if (typeof raw['result_ref'] === 'string') env.result_ref = raw['result_ref'];
  if (typeof raw['repeated_count'] === 'number') env.repeated_count = raw['repeated_count'];
  return env;
}

export class JobStream {
  private readonly opts: JobStreamOptions;
  private readonly wsCtor: WebSocketCtor;
  private readonly fetchJobs: (sessionId: string) => Promise<JobEventEnvelope[]>;
  private ws: WebSocketLike | null = null;
  private phase: 'idle' | 'connecting' | 'awaiting-ready' | 'streaming' | 'closed' = 'idle';
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: JobStreamOptions, deps: JobStreamInternalDeps = {}) {
    this.opts = opts;
    this.wsCtor =
      deps.webSocketCtor ??
      (typeof WebSocket !== 'undefined' ? WebSocket : (null as unknown as WebSocketCtor));
    this.fetchJobs = deps.fetchJobs ?? defaultFetchJobs;
  }

  /** Open the WS connection. Idempotent — re-calling start() while live is a no-op. */
  start(): void {
    if (this.disposed) return;
    if (this.phase !== 'idle' && this.phase !== 'closed') return;
    this.openSocket();
  }

  private openSocket(): void {
    if (!this.wsCtor) {
      this.opts.onError?.({
        code: 'protocol_error',
        reason: 'WebSocket ctor unavailable in this environment',
      });
      this.phase = 'closed';
      return;
    }

    const url = `${this.opts.wsUrl.replace(/\/+$/, '')}/api/ws/${encodeURIComponent(
      this.opts.sessionId,
    )}/jobs/events`;

    this.phase = 'connecting';
    let ws: WebSocketLike;
    try {
      ws = new this.wsCtor(url);
    } catch (err) {
      this.opts.onError?.({
        code: 'protocol_error',
        reason: `WebSocket construction failed: ${(err as Error).message}`,
      });
      this.phase = 'closed';
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.disposed) return;
      // No client-side handshake frame — the server sends
      // ``{type:'ready'}`` unprompted once the connection is accepted.
      this.phase = 'awaiting-ready';
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (this.disposed) return;
      if (typeof ev.data !== 'string') {
        log.warn('JobStream: ignored non-text frame');
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        this.opts.onError?.({ code: 'protocol_error', reason: 'failed to parse JSON frame' });
        return;
      }
      this.handleMessage(msg);
    };

    ws.onerror = (ev: Event) => {
      log.warn('JobStream: WS error', ev);
    };

    ws.onclose = (ev: CloseEvent) => {
      this.handleClose(ev);
    };
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const type = msg['type'];
    if (type === 'ready') {
      this.phase = 'streaming';
      return;
    }
    if (type === 'snapshot') {
      const rawJobs = Array.isArray(msg['jobs']) ? (msg['jobs'] as Record<string, unknown>[]) : [];
      const envelopes = rawJobs.map((r) => recordToEnvelope(r));
      useJobsStore.getState().syncJobs(envelopes);
      this.opts.onSnapshot?.(envelopes);
      return;
    }
    if (type === 'job') {
      const envelope = recordToEnvelope(msg);
      useJobsStore.getState().upsertJob(envelope);
      this.opts.onEvent?.(envelope);
      return;
    }
    if (type === 'error') {
      this.opts.onError?.({
        code: 'internal_error',
        reason: String(msg['reason'] ?? 'unknown error'),
      });
      return;
    }
    log.warn('JobStream: unknown frame type', type);
  }

  private handleClose(ev: CloseEvent): void {
    if (this.disposed) {
      this.phase = 'closed';
      return;
    }
    const code = ev.code;
    if (code === WS_CLOSE_SESSION_NOT_FOUND) {
      this.opts.onError?.({ code: 'session_not_found', reason: ev.reason });
      this.phase = 'closed';
      // The session is gone; reconnecting would just 4404 again.
      return;
    }
    if (code === WS_CLOSE_INTERNAL_ERROR) {
      this.opts.onError?.({ code: 'internal_error', reason: ev.reason });
    }
    // Normal (1000) or transient drop: re-sync via HTTP then reconnect so the
    // store doesn't go stale during the gap before the next ``snapshot``.
    this.phase = 'closed';
    if (code !== WS_CLOSE_NORMAL) {
      log.warn(`JobStream: WS closed with code ${code}: ${ev.reason}`);
    }
    this.resyncViaHttp();
    this.scheduleReconnect();
  }

  /** Pull the full job list over HTTP and write it into the store. */
  private resyncViaHttp(): void {
    if (this.disposed) return;
    this.fetchJobs(this.opts.sessionId)
      .then((envelopes) => {
        if (this.disposed) return;
        useJobsStore.getState().syncJobs(envelopes);
      })
      .catch((err: unknown) => {
        log.warn('JobStream: HTTP re-sync failed', err);
      });
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.opts.autoReconnect === false) return;
    if (this.reconnectTimer !== null) return;
    const delay = this.opts.reconnectDelayMs ?? 1000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed) return;
      this.phase = 'idle';
      this.openSocket();
    }, delay);
  }

  /** True once the ready handshake has completed and events are flowing. */
  get isStreaming(): boolean {
    return this.phase === 'streaming';
  }

  /** Manually trigger the HTTP re-sync (exposed for callers / tests). */
  resync(): void {
    this.resyncViaHttp();
  }

  /** Close the WS + cancel any pending reconnect. Safe to call multiple times. */
  dispose(): void {
    this.disposed = true;
    this.phase = 'closed';
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      try {
        this.ws.close(WS_CLOSE_NORMAL, 'client disposed');
      } catch {
        // already closed
      }
      this.ws = null;
    }
  }
}

// Test-only: expose the record→envelope coercion for shape assertions.
export const __internal = { recordToEnvelope };
