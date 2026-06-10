/**
 * `JobStream` tests — drive the per-session job-event WS state machine via
 * ``mock-socket`` — v3.1 Unit 6.
 *
 * Coverage:
 *  - ready → snapshot → job-event flow writes into useJobsStore.
 *  - consuming a status event updates the store (upsert by job_id).
 *  - onMutate-before-WS reconciliation: a placeholder added by the mutation
 *    path is reconciled to the canonical id; a subsequent WS event for that
 *    id merges cleanly.
 *  - reconnect re-syncs via the injected GET /jobs hook (full state).
 */
import { Server as MockServer, WebSocket as MockWebSocket } from 'mock-socket';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobStream } from '@/streaming/JobStream';
import { useJobsStore, type JobEventEnvelope } from '@/store/jobs';

const WS_URL = 'ws://localhost:1234';
const SESSION_ID = 'sess-jobs';
const FULL_URL = `${WS_URL}/api/ws/${SESSION_ID}/jobs/events`;

interface ServerSocket {
  send: (data: string) => void;
  close: (opts?: { code?: number; reason?: string; wasClean?: boolean }) => void;
  on: (ev: string, cb: (...args: unknown[]) => void) => void;
}

interface MockServerHandle {
  on: (ev: 'connection', cb: (socket: ServerSocket) => void) => void;
  close: () => void;
  stop: () => void;
}

function freshServer(url: string = FULL_URL): MockServerHandle {
  return new MockServer(url) as unknown as MockServerHandle;
}

function resetStore(): void {
  useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
}

function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('JobStream — happy path', () => {
  let server: MockServerHandle;

  beforeEach(() => {
    resetStore();
    server = freshServer();
  });

  afterEach(() => {
    server.stop();
  });

  it('runs ready → snapshot → job-event and writes into the store', async () => {
    const onSnapshot = vi.fn();
    const onEvent = vi.fn();
    const onError = vi.fn();
    const messages: string[] = [];

    server.on('connection', (socket) => {
      socket.on('message', (raw: unknown) => {
        messages.push(String(raw));
      });
      socket.send(JSON.stringify({ type: 'ready' }));
      // Initial snapshot of one in-flight job.
      socket.send(
        JSON.stringify({
          type: 'snapshot',
          jobs: [{ job_id: 'srv-1', kind: 'pflow', status: 'running' }],
        }),
      );
      // A live transition for that job.
      socket.send(
        JSON.stringify({ type: 'job', job_id: 'srv-1', kind: 'pflow', status: 'done' }),
      );
    });

    const stream = new JobStream(
      {
        sessionId: SESSION_ID,
        wsUrl: WS_URL,
        onSnapshot,
        onEvent,
        onError,
        autoReconnect: false,
      },
      { webSocketCtor: MockWebSocket as unknown as typeof WebSocket },
    );
    stream.start();

    for (let i = 0; i < 10 && onEvent.mock.calls.length === 0; i += 1) await tick();

    expect(onError).not.toHaveBeenCalled();
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
    // The client sends no handshake frame in the no-auth protocol.
    expect(messages).toHaveLength(0);
    // The store reflects the canonical terminal state.
    const rec = useJobsStore.getState().jobs['srv-1']!;
    expect(rec).toBeDefined();
    expect(rec.status).toBe('done');
    expect(rec.ended_at).toBeDefined();

    stream.dispose();
  });

  it('reconciles an onMutate placeholder before the WS event arrives', async () => {
    // Mutation path registers a placeholder, then reconciles to the server id.
    const tempId = useJobsStore.getState().addJob({
      kind: 'eig',
      request_summary: { seed: 7 },
    });
    useJobsStore.getState().reconcileJob(tempId, 'srv-eig', { status: 'running' });

    server.on('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'ready' }));
      socket.send(JSON.stringify({ type: 'snapshot', jobs: [] }));
      // The canonical done event arrives AFTER the placeholder reconciled.
      socket.send(
        JSON.stringify({ type: 'job', job_id: 'srv-eig', kind: 'eig', status: 'done' }),
      );
    });

    const stream = new JobStream(
      { sessionId: SESSION_ID, wsUrl: WS_URL, autoReconnect: false },
      { webSocketCtor: MockWebSocket as unknown as typeof WebSocket },
    );
    stream.start();

    for (let i = 0; i < 10; i += 1) {
      await tick();
      if (useJobsStore.getState().jobs['srv-eig']?.status === 'done') break;
    }

    // The placeholder temp id is gone; the canonical record reached terminal
    // state and kept the placeholder's request_summary.
    expect(useJobsStore.getState().jobs[tempId]).toBeUndefined();
    const rec = useJobsStore.getState().jobs['srv-eig']!;
    expect(rec.status).toBe('done');
    expect(rec.request_summary).toEqual({ seed: 7 });

    stream.dispose();
  });
});

describe('JobStream — reconnect re-sync', () => {
  let server: MockServerHandle;

  beforeEach(() => {
    resetStore();
    server = freshServer();
  });

  afterEach(() => {
    server.stop();
  });

  it('re-syncs via the injected GET /jobs hook on disconnect', async () => {
    // The server closes the socket abnormally after ready to trigger the
    // reconnect + HTTP re-sync path.
    server.on('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'ready' }));
      socket.send(JSON.stringify({ type: 'snapshot', jobs: [] }));
      // Abnormal close (not 1000) → HTTP re-sync fires.
      socket.close({ code: 1006, reason: 'dropped' });
    });

    const resyncJobs: JobEventEnvelope[] = [
      { job_id: 'srv-resync', kind: 'cpf', status: 'done' },
    ];
    const fetchJobs = vi.fn(async () => resyncJobs);

    const stream = new JobStream(
      {
        sessionId: SESSION_ID,
        wsUrl: WS_URL,
        // Disable auto-reconnect so the test only exercises the HTTP re-sync
        // (a reconnect would re-open against the same mock server and re-send
        // an empty snapshot, racing the assertion).
        autoReconnect: false,
      },
      { webSocketCtor: MockWebSocket as unknown as typeof WebSocket, fetchJobs },
    );
    stream.start();

    for (let i = 0; i < 15 && fetchJobs.mock.calls.length === 0; i += 1) await tick();

    expect(fetchJobs).toHaveBeenCalledWith(SESSION_ID);
    // Give the re-sync promise a tick to write into the store.
    for (let i = 0; i < 10 && !useJobsStore.getState().jobs['srv-resync']; i += 1) await tick();
    expect(useJobsStore.getState().jobs['srv-resync']!.status).toBe('done');

    stream.dispose();
  });
});

describe('JobStream — close codes + frame errors', () => {
  let server: MockServerHandle;

  beforeEach(() => {
    resetStore();
    server = freshServer();
  });

  afterEach(() => {
    server.stop();
  });

  async function runWithClose(
    closeCode: number,
  ): Promise<{
    onError: ReturnType<typeof vi.fn>;
    fetchJobs: ReturnType<typeof vi.fn>;
    stream: JobStream;
  }> {
    server.on('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'ready' }));
      socket.close({ code: closeCode, reason: `code-${closeCode}` });
    });
    const onError = vi.fn();
    const fetchJobs = vi.fn(async () => [] as JobEventEnvelope[]);
    const stream = new JobStream(
      { sessionId: SESSION_ID, wsUrl: WS_URL, onError, autoReconnect: true, reconnectDelayMs: 0 },
      { webSocketCtor: MockWebSocket as unknown as typeof WebSocket, fetchJobs },
    );
    stream.start();
    for (let i = 0; i < 15 && onError.mock.calls.length === 0; i += 1) await tick();
    return { onError, fetchJobs, stream };
  }

  it('4404 fires session_not_found and does NOT reconnect or re-sync', async () => {
    const { onError, fetchJobs, stream } = await runWithClose(4404);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'session_not_found' }),
    );
    await tick(10);
    expect(fetchJobs).not.toHaveBeenCalled();
    stream.dispose();
  });

  it('4500 fires internal_error AND still re-syncs', async () => {
    const { onError, fetchJobs, stream } = await runWithClose(4500);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'internal_error' }),
    );
    // 4500 is treated as a transient drop: HTTP re-sync fires.
    for (let i = 0; i < 10 && fetchJobs.mock.calls.length === 0; i += 1) await tick();
    expect(fetchJobs).toHaveBeenCalledWith(SESSION_ID);
    stream.dispose();
  });

  it('a malformed JSON frame fires a protocol_error', async () => {
    server.on('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'ready' }));
      socket.send('this is not json{');
    });
    const onError = vi.fn();
    const stream = new JobStream(
      { sessionId: SESSION_ID, wsUrl: WS_URL, onError, autoReconnect: false },
      { webSocketCtor: MockWebSocket as unknown as typeof WebSocket },
    );
    stream.start();
    for (let i = 0; i < 15 && onError.mock.calls.length === 0; i += 1) await tick();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'protocol_error' }),
    );
    stream.dispose();
  });

  it('a {type:"error"} frame fires an internal_error with the reason', async () => {
    server.on('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'ready' }));
      socket.send(JSON.stringify({ type: 'error', reason: 'boom' }));
    });
    const onError = vi.fn();
    const stream = new JobStream(
      { sessionId: SESSION_ID, wsUrl: WS_URL, onError, autoReconnect: false },
      { webSocketCtor: MockWebSocket as unknown as typeof WebSocket },
    );
    stream.start();
    for (let i = 0; i < 15 && onError.mock.calls.length === 0; i += 1) await tick();
    expect(onError).toHaveBeenCalledWith({ code: 'internal_error', reason: 'boom' });
    stream.dispose();
  });
});
