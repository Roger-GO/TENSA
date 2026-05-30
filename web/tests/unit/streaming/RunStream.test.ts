/**
 * `RunStream` tests — drive the WS state machine end-to-end via
 * ``mock-socket``. We never inject a fake WebSocket constructor at the
 * Node global level (other tests would see the change); instead, the
 * production ``WebSocket`` ctor is swapped into ``RunStream.deps`` per
 * test.
 */
// mock-socket doesn't ship type declarations; ``allowJs`` resolution
// gives the imports an ``any`` shape that we narrow at the use sites.
import { Server as MockServer, WebSocket as MockWebSocket } from 'mock-socket';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tableFromArrays, tableToIPC } from 'apache-arrow';
import { RunStream } from '@/streaming/RunStream';
import { useRunsStore, DEFAULT_MEMORY_BUDGET_BYTES } from '@/store/runs';

const WS_URL = 'ws://localhost:1234';
const SESSION_ID = 'sess-abc';
const FULL_URL = `${WS_URL}/api/ws/${SESSION_ID}`;

/** Build one Arrow IPC stream chunk (= one WS binary message). */
function batch(t: number[], cols: Record<string, number[]>): ArrayBuffer {
  const arrays: Record<string, Float64Array> = {
    t: new Float64Array(t),
  };
  for (const name of Object.keys(cols)) {
    arrays[name] = new Float64Array(cols[name]!);
  }
  const table = tableFromArrays(arrays);
  const bytes = tableToIPC(table, 'stream');
  // Copy into a fresh ``ArrayBuffer`` so the wire frame is the concrete
  // ``ArrayBuffer`` shape ``mock-socket`` and the decoder both expect.
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

interface ServerSocket {
  send: (data: string | ArrayBuffer | ArrayBufferView) => void;
  close: (opts?: { code?: number; reason?: string; wasClean?: boolean }) => void;
  on: (ev: string, cb: (...args: unknown[]) => void) => void;
}

interface MockServerHandle {
  on: (ev: 'connection', cb: (socket: ServerSocket) => void) => void;
  close: () => void;
  stop: () => void;
}

function freshServer(url: string = FULL_URL): MockServerHandle {
  // ``mock-socket``'s ``Server`` records every URL globally; clean
  // shutdown via ``stop()`` between tests prevents bleed.
  const server = new MockServer(url) as unknown as MockServerHandle;
  return server;
}

function resetStore(): void {
  useRunsStore.setState({
    runs: {},
    activeRunId: null,
    memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
  });
}

/** Wait for a macrotask + ``mock-socket``'s 4 ms internal delay. */
function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('RunStream — happy path', () => {
  let server: MockServerHandle;

  beforeEach(() => {
    resetStore();
    server = freshServer();
  });

  afterEach(() => {
    server.stop();
  });

  it('runs the auth → ready → start_tds → stream_start → frames → done flow', async () => {
    const onStart = vi.fn();
    const onFrame = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();

    const messages: string[] = [];
    let serverSocket: ServerSocket | null = null;

    server.on('connection', (socket) => {
      serverSocket = socket;
      socket.on('message', (raw: unknown) => {
        const text = String(raw);
        messages.push(text);
        const msg = JSON.parse(text);
        if (msg.type === 'auth') {
          socket.send(JSON.stringify({ type: 'ready' }));
        } else if (msg.type === 'start_tds') {
          socket.send(
            JSON.stringify({
              type: 'stream_start',
              run_id: 'run-xyz',
              metadata: {
                schema_version: '1.0',
                decimation: {
                  algorithm: 'mean',
                  mode: 'mean',
                  source_rate_hz: null,
                  output_rate_hz: 30,
                  fixed_step: null,
                },
                vars: ['bus_v'],
                var_columns: ['Bus_1_v'],
              },
            }),
          );
          // 3 binary frames, 2 rows each = 6 rows total.
          socket.send(batch([0.0, 0.01], { Bus_1_v: [1.0, 0.999] }));
          socket.send(batch([0.02, 0.03], { Bus_1_v: [0.998, 0.997] }));
          socket.send(batch([0.04, 0.05], { Bus_1_v: [0.996, 0.995] }));
          socket.send(
            JSON.stringify({
              type: 'done',
              run_id: 'run-xyz',
              converged: true,
              final_t: 0.05,
              callpert_count: 0,
            }),
          );
          socket.close({ code: 1000 });
        }
      });
    });

    const stream = new RunStream(
      {
        sessionId: SESSION_ID,
        token: 'tok',
        wsUrl: WS_URL,
        tdsArgs: { tf: 0.05, vars: ['bus_v'] },
        onStart,
        onFrame,
        onDone,
        onError,
      },
      { webSocketCtor: MockWebSocket as unknown as typeof WebSocket },
    );
    stream.start();

    // Wait for the full exchange. mock-socket runs in microtasks; a few
    // ticks suffice.
    for (let i = 0; i < 10 && onDone.mock.calls.length === 0; i += 1) await tick();

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart.mock.calls[0]![0]).toMatchObject({ runId: 'run-xyz' });
    expect(onFrame).toHaveBeenCalledTimes(3);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0]![0]).toMatchObject({
      runId: 'run-xyz',
      converged: true,
      finalT: 0.05,
    });
    expect(onError).not.toHaveBeenCalled();

    // Runs store: 6 rows of t + Bus_1_v in arrival order.
    const r = useRunsStore.getState().runs['run-xyz']!;
    expect(r.seqCount).toBe(6);
    expect(r.state).toBe('done');
    expect(Array.from(r.t.subarray(0, 6))).toEqual([0.0, 0.01, 0.02, 0.03, 0.04, 0.05]);
    expect(Array.from(r.columns.Bus_1_v!.subarray(0, 6))).toEqual([
      1.0, 0.999, 0.998, 0.997, 0.996, 0.995,
    ]);

    // First two messages are ``auth`` then ``start_tds`` per the protocol.
    expect(JSON.parse(messages[0]!).type).toBe('auth');
    expect(JSON.parse(messages[1]!).type).toBe('start_tds');
    expect(JSON.parse(messages[1]!)).toMatchObject({
      tf: 0.05,
      decimation: 'mean',
      max_rate_hz: 30,
      vars: ['bus_v'],
    });

    // Reference serverSocket so ESLint doesn't flag the unused
    // assignment from the connection handler.
    expect(serverSocket).not.toBeNull();
  });
});

describe('RunStream — edge cases', () => {
  let server: MockServerHandle;

  beforeEach(() => {
    resetStore();
    server = freshServer();
  });

  afterEach(() => {
    server.stop();
  });

  it('drops binary frames received before stream_start (defensive)', async () => {
    const onFrame = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    server.on('connection', (socket) => {
      socket.on('message', (raw: unknown) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'auth') {
          socket.send(JSON.stringify({ type: 'ready' }));
        } else if (msg.type === 'start_tds') {
          // Send a binary frame BEFORE stream_start.
          socket.send(batch([0.0], { Bus_1_v: [1.0] }));
          socket.send(
            JSON.stringify({
              type: 'stream_start',
              run_id: 'r1',
              metadata: { schema_version: '1.0', vars: ['bus_v'], var_columns: ['Bus_1_v'] },
            }),
          );
          socket.send(batch([0.01], { Bus_1_v: [0.999] }));
          socket.send(JSON.stringify({ type: 'done', converged: true, final_t: 0.01 }));
          socket.close({ code: 1000 });
        }
      });
    });

    const stream = new RunStream(
      {
        sessionId: SESSION_ID,
        token: 'tok',
        wsUrl: WS_URL,
        tdsArgs: { tf: 0.01 },
        onFrame,
      },
      { webSocketCtor: MockWebSocket as unknown as typeof WebSocket },
    );
    stream.start();

    for (let i = 0; i < 10 && onFrame.mock.calls.length < 1; i += 1) await tick();
    await tick();

    // Only the post-stream_start frame counted.
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('dropping binary frame received before stream_start'),
    );
    warn.mockRestore();
  });

  it('treats {type:"resync"} as terminal — no auto-reconnect', async () => {
    const onError = vi.fn();
    const onResync = vi.fn();
    const onConn = vi.fn();

    server.on('connection', (socket) => {
      socket.on('message', (raw: unknown) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'auth') socket.send(JSON.stringify({ type: 'ready' }));
        else if (msg.type === 'start_tds') {
          socket.send(
            JSON.stringify({
              type: 'stream_start',
              run_id: 'r1',
              metadata: { schema_version: '1.0', vars: ['bus_v'], var_columns: [] },
            }),
          );
          socket.send(
            JSON.stringify({
              type: 'resync',
              run_id: 'r1',
              current_seq: 200,
              reason: 'frame fell out of resume buffer',
            }),
          );
          socket.close({ code: 1000 });
        }
      });
    });

    const stream = new RunStream(
      {
        sessionId: SESSION_ID,
        token: 'tok',
        wsUrl: WS_URL,
        tdsArgs: { tf: 1 },
        onError,
        onResync,
        onConnectionStatus: onConn,
      },
      { webSocketCtor: MockWebSocket as unknown as typeof WebSocket },
    );
    stream.start();

    for (let i = 0; i < 10 && onError.mock.calls.length === 0; i += 1) await tick();

    expect(onResync).toHaveBeenCalledWith({
      runId: 'r1',
      currentSeq: 200,
      reason: 'frame fell out of resume buffer',
    });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'buffer_evicted', currentSeq: 200 }),
    );
    // No reconnect-status events.
    const reconnects = onConn.mock.calls.filter(
      (c) => (c[0] as { state: string }).state === 'reconnecting',
    );
    expect(reconnects).toHaveLength(0);
    expect(stream.isClosed).toBe(true);
  });

  it('emits onError({code:"auth_failed"}) on close 4401', async () => {
    const onError = vi.fn();
    server.on('connection', (socket) => {
      socket.on('message', (raw: unknown) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'auth') {
          socket.close({ code: 4401, reason: 'invalid token' });
        }
      });
    });

    const stream = new RunStream(
      {
        sessionId: SESSION_ID,
        token: 'tok',
        wsUrl: WS_URL,
        tdsArgs: { tf: 1 },
        onError,
      },
      { webSocketCtor: MockWebSocket as unknown as typeof WebSocket },
    );
    stream.start();
    for (let i = 0; i < 10 && onError.mock.calls.length === 0; i += 1) await tick();

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'auth_failed' }));
  });

  it('emits onError({code:"run_not_found"}) on close 4404 after resume', async () => {
    // Two sequential connections to the same URL: the first completes
    // stream_start (so RunStream has a runId) then closes abnormally; the
    // second is a resume attempt that gets rejected with 4404.
    const onError = vi.fn();
    let connectionCount = 0;

    server.on('connection', (socket) => {
      connectionCount += 1;
      socket.on('message', (raw: unknown) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'auth') socket.send(JSON.stringify({ type: 'ready' }));
        else if (msg.type === 'start_tds' && connectionCount === 1) {
          socket.send(
            JSON.stringify({
              type: 'stream_start',
              run_id: 'r1',
              metadata: { schema_version: '1.0', vars: ['bus_v'], var_columns: [] },
            }),
          );
          // Abnormal close to trigger reconnect.
          socket.close({ code: 1006, reason: 'abnormal' });
        } else if (msg.type === 'resume') {
          socket.close({ code: 4404, reason: 'run not found' });
        }
      });
    });

    const stream = new RunStream(
      {
        sessionId: SESSION_ID,
        token: 'tok',
        wsUrl: WS_URL,
        tdsArgs: { tf: 1 },
        onError,
        // Use immediate-fire fake setTimeout to skip the backoff delay.
        reconnectDelaysMs: [0],
        maxReconnectAttempts: 5,
      },
      {
        webSocketCtor: MockWebSocket as unknown as typeof WebSocket,
        setTimeout: ((cb: () => void) => {
          // Fire on the next macrotask so mock-socket has a chance to
          // settle the close event before we re-open.
          return globalThis.setTimeout(cb, 0);
        }) as typeof globalThis.setTimeout,
        clearTimeout: (h: unknown) => globalThis.clearTimeout(h as number),
      },
    );
    stream.start();

    for (let i = 0; i < 30 && onError.mock.calls.length === 0; i += 1) await tick();

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'run_not_found' }));
  });

  it('reconnects with resume on abnormal close mid-stream and continues frame numbering', async () => {
    // First connection: stream_start + 2 frames (seq 1, 2), then 1006.
    // Second connection: resume with last_seq=2, stream_start (re-emit),
    // 2 more frames + done.
    const onFrame = vi.fn();
    const onDone = vi.fn();
    let connectionCount = 0;
    let resumeMsg: { last_seq?: number } | null = null;

    server.on('connection', (socket) => {
      connectionCount += 1;
      const myConnId = connectionCount;
      socket.on('message', (raw: unknown) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'auth') socket.send(JSON.stringify({ type: 'ready' }));
        else if (msg.type === 'start_tds') {
          socket.send(
            JSON.stringify({
              type: 'stream_start',
              run_id: 'r1',
              metadata: {
                schema_version: '1.0',
                vars: ['bus_v'],
                var_columns: ['Bus_1_v'],
              },
            }),
          );
          socket.send(batch([0.0], { Bus_1_v: [1.0] }));
          socket.send(batch([0.01], { Bus_1_v: [0.999] }));
          socket.close({ code: 1006, reason: 'abnormal' });
        } else if (msg.type === 'resume') {
          resumeMsg = msg as { last_seq?: number };
          // Re-emit stream_start so the JS Arrow decoder can rebuild.
          socket.send(
            JSON.stringify({
              type: 'stream_start',
              run_id: 'r1',
              metadata: {
                schema_version: '1.0',
                vars: ['bus_v'],
                var_columns: ['Bus_1_v'],
              },
            }),
          );
          // Replay frames 3 and 4 (post-last_seq=2).
          socket.send(batch([0.02], { Bus_1_v: [0.998] }));
          socket.send(batch([0.03], { Bus_1_v: [0.997] }));
          socket.send(JSON.stringify({ type: 'done', converged: true, final_t: 0.03 }));
          socket.close({ code: 1000 });
        }
        // Touch myConnId to satisfy lint that doesn't see the closure use.
        void myConnId;
      });
    });

    const stream = new RunStream(
      {
        sessionId: SESSION_ID,
        token: 'tok',
        wsUrl: WS_URL,
        tdsArgs: { tf: 0.03 },
        onFrame,
        onDone,
        reconnectDelaysMs: [0],
      },
      {
        webSocketCtor: MockWebSocket as unknown as typeof WebSocket,
        setTimeout: ((cb: () => void) =>
          globalThis.setTimeout(cb, 0)) as typeof globalThis.setTimeout,
        clearTimeout: (h: unknown) => globalThis.clearTimeout(h as number),
      },
    );
    stream.start();

    for (let i = 0; i < 30 && onDone.mock.calls.length === 0; i += 1) await tick();

    expect(resumeMsg).not.toBeNull();
    expect(resumeMsg!.last_seq).toBe(2);
    // 4 frames total — no duplication.
    expect(onFrame).toHaveBeenCalledTimes(4);
    expect(onDone).toHaveBeenCalledTimes(1);
    const r = useRunsStore.getState().runs.r1!;
    expect(r.seqCount).toBe(4);
    expect(Array.from(r.t.subarray(0, 4))).toEqual([0.0, 0.01, 0.02, 0.03]);
  });

  it('emits disconnected({reason:"max_retries"}) after exhausting retries', async () => {
    const onConn = vi.fn();
    const onError = vi.fn();
    let connectionCount = 0;

    server.on('connection', (socket) => {
      connectionCount += 1;
      const isFirst = connectionCount === 1;
      socket.on('message', (raw: unknown) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'auth') socket.send(JSON.stringify({ type: 'ready' }));
        else if (msg.type === 'start_tds' && isFirst) {
          socket.send(
            JSON.stringify({
              type: 'stream_start',
              run_id: 'r1',
              metadata: { schema_version: '1.0', vars: ['bus_v'], var_columns: [] },
            }),
          );
          socket.close({ code: 1006 });
        } else if (msg.type === 'resume') {
          // Fail every resume with abnormal close.
          socket.close({ code: 1006 });
        }
      });
    });

    const stream = new RunStream(
      {
        sessionId: SESSION_ID,
        token: 'tok',
        wsUrl: WS_URL,
        tdsArgs: { tf: 1 },
        onError,
        onConnectionStatus: onConn,
        reconnectDelaysMs: [0, 0, 0, 0, 0],
        maxReconnectAttempts: 3,
      },
      {
        webSocketCtor: MockWebSocket as unknown as typeof WebSocket,
        setTimeout: ((cb: () => void) =>
          globalThis.setTimeout(cb, 0)) as typeof globalThis.setTimeout,
        clearTimeout: (h: unknown) => globalThis.clearTimeout(h as number),
      },
    );
    stream.start();

    for (let i = 0; i < 50 && onError.mock.calls.length === 0; i += 1) await tick();

    const disconnects = onConn.mock.calls.filter(
      (c) => (c[0] as { state: string; reason?: string }).state === 'disconnected',
    );
    expect(disconnects).toHaveLength(1);
    expect(disconnects[0]![0]).toMatchObject({
      state: 'disconnected',
      reason: 'max_retries',
    });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'max_retries' }));
    // Connection attempts: 1 initial + 3 reconnects = 4.
    expect(connectionCount).toBe(4);
  });

  it('start() then immediate dispose() before WS open: no leaks, no errors', async () => {
    const onError = vi.fn();
    const onStart = vi.fn();

    server.on('connection', (socket) => {
      // Even if we connect, dispose should have stripped handlers.
      socket.on('message', () => {
        socket.send(JSON.stringify({ type: 'ready' }));
      });
    });

    const stream = new RunStream(
      {
        sessionId: SESSION_ID,
        token: 'tok',
        wsUrl: WS_URL,
        tdsArgs: { tf: 1 },
        onError,
        onStart,
      },
      { webSocketCtor: MockWebSocket as unknown as typeof WebSocket },
    );
    stream.start();
    stream.dispose();

    // Let mock-socket finish opening the underlying socket.
    for (let i = 0; i < 10; i += 1) await tick();

    expect(stream.isClosed).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
  });
});
