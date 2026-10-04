/**
 * `RunStream` and the lazily loaded Arrow decoder.
 *
 * `apache-arrow` is the largest dependency of the page, so the decoder is its
 * own chunk, fetched when the first run starts. The stream must not send its
 * `start_tds` command until the chunk is in (the server answers with binary
 * frames, and a frame needs the decoder), and must fail the run cleanly, not
 * hang or throw, when the chunk cannot be fetched.
 *
 * Every test gets a fresh module registry so the decoder starts out unloaded
 * (the module keeps it for the life of the page), and swaps `@/streaming/arrow`
 * for a module whose load the test controls.
 */
import { Server as MockServer, WebSocket as MockWebSocket } from 'mock-socket';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { arrowFrame } from '../helpers/frames';

const WS_URL = 'ws://localhost:1234';
const SESSION_ID = 'sess-arrow';
const FULL_URL = `${WS_URL}/api/ws/${SESSION_ID}`;

interface ServerSocket {
  send: (data: string | ArrayBuffer) => void;
  on: (ev: string, cb: (...args: unknown[]) => void) => void;
  close: (opts?: { code?: number }) => void;
}
interface MockServerHandle {
  on: (ev: 'connection', cb: (socket: ServerSocket) => void) => void;
  stop: () => void;
}

function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A fresh `RunStream` module whose `@/streaming/arrow` is `factory`'s module. */
async function loadRunStreamWith(factory: () => Promise<unknown>) {
  vi.resetModules();
  vi.doMock('@/streaming/arrow', factory);
  return import('@/streaming/RunStream');
}

describe('RunStream — Arrow decoder chunk', () => {
  let server: MockServerHandle;
  const commands: string[] = [];

  beforeEach(() => {
    commands.length = 0;
    server = new MockServer(FULL_URL) as unknown as MockServerHandle;
    server.on('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'ready' }));
      socket.on('message', (raw: unknown) => {
        const msg = JSON.parse(String(raw));
        commands.push(msg.type);
        if (msg.type !== 'start_tds') return;
        socket.send(
          JSON.stringify({
            type: 'stream_start',
            run_id: 'run-1',
            metadata: { schema_version: '2.0', vars: ['bus_v'], var_columns: ['Bus_1_v'] },
          }),
        );
        socket.send(arrowFrame([0.0, 0.01], { Bus_1_v: [1.0, 0.999] }));
        socket.send(
          JSON.stringify({
            type: 'done',
            run_id: 'run-1',
            converged: true,
            final_t: 0.01,
            callpert_count: 0,
          }),
        );
        socket.close({ code: 1000 });
      });
    });
  });

  afterEach(() => {
    server.stop();
    vi.doUnmock('@/streaming/arrow');
    vi.resetModules();
  });

  it('holds start_tds until the decoder has loaded, then decodes the run', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { RunStream } = await loadRunStreamWith(async () => {
      await gate;
      return vi.importActual('@/streaming/arrow');
    });
    const onFrame = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();
    const stream = new RunStream(
      {
        sessionId: SESSION_ID,
        wsUrl: WS_URL,
        tdsArgs: { tf: 0.01, vars: ['bus_v'] },
        onFrame,
        onDone,
        onError,
      },
      { webSocketCtor: MockWebSocket as unknown as typeof WebSocket },
    );
    stream.start();

    // The server's `ready` has long arrived; the command waits for the chunk.
    await tick(60);
    expect(commands).toEqual([]);
    expect(onError).not.toHaveBeenCalled();

    release();
    for (let i = 0; i < 20 && onDone.mock.calls.length === 0; i += 1) await tick();

    expect(commands).toEqual(['start_tds']);
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(Array.from(onFrame.mock.calls[0]![0].t)).toEqual([0.0, 0.01]);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('fails the run with a protocol error, and sends nothing, when the chunk cannot be loaded', async () => {
    const { RunStream } = await loadRunStreamWith(async () => {
      throw new Error('Failed to fetch dynamically imported module');
    });
    const onError = vi.fn();
    const onFrame = vi.fn();
    const stream = new RunStream(
      {
        sessionId: SESSION_ID,
        wsUrl: WS_URL,
        tdsArgs: { tf: 0.01, vars: ['bus_v'] },
        onError,
        onFrame,
      },
      { webSocketCtor: MockWebSocket as unknown as typeof WebSocket },
    );
    stream.start();
    for (let i = 0; i < 20 && onError.mock.calls.length === 0; i += 1) await tick();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toMatchObject({ code: 'protocol_error' });
    expect(onError.mock.calls[0]![0].reason).toMatch(/Arrow decoder/);
    expect(stream.isClosed).toBe(true);
    await tick(30);
    expect(commands).toEqual([]);
    expect(onFrame).not.toHaveBeenCalled();
  });

  it('does not cache a failed load: the next run fetches the chunk again', async () => {
    const { loadArrowDecoder } = await loadRunStreamWith(async () => {
      throw new Error('Failed to fetch dynamically imported module');
    });
    await expect(loadArrowDecoder()).rejects.toThrow();

    vi.doMock('@/streaming/arrow', () => vi.importActual('@/streaming/arrow'));
    const decode = await loadArrowDecoder();
    expect(typeof decode).toBe('function');
    const frame = decode(arrowFrame([0.5], { A: [2.0] }), ['A']);
    expect(Array.from(frame.t)).toEqual([0.5]);
    // Loaded now: later calls answer from the module, not from another fetch.
    expect(await loadArrowDecoder()).toBe(decode);
  });
});
