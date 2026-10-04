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
 *
 * Waits on the chunk are generous: evaluating `apache-arrow` again in a cleared
 * registry is slow when the whole suite runs in parallel. Each test's stream is
 * disposed afterwards so a slow one cannot send its held command into the next.
 */
import { Server as MockServer, WebSocket as MockWebSocket } from 'mock-socket';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunStream as RunStreamClass, RunStreamOptions } from '@/streaming/RunStream';
import { arrowFrame } from '../helpers/frames';

const WS_URL = 'ws://localhost:1234';
const SESSION_ID = 'sess-arrow';
const FULL_URL = `${WS_URL}/api/ws/${SESSION_ID}`;

interface ServerSocket {
  send: (data: string | ArrayBuffer) => void;
  on: (ev: string, cb: (...args: unknown[]) => void) => void;
  close: (opts?: { code?: number; reason?: string }) => void;
}
interface MockServerHandle {
  on: (ev: 'connection', cb: (socket: ServerSocket) => void) => void;
  stop: () => void;
}

/** Budget for the stream to react to a chunk that has arrived (or failed). */
const CHUNK_WAIT = { timeout: 10_000 };

function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A socket class that reports when the server's `ready` frame reaches it. Its
 * listener is added before the stream's own, so by the next timer the stream
 * has handled the frame too.
 */
function socketCtorWatchingReady(onReady: () => void): typeof WebSocket {
  class Watching extends MockWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener('message', (ev: Event) => {
        const { data } = ev as MessageEvent;
        if (typeof data === 'string' && JSON.parse(data).type === 'ready') onReady();
      });
    }
  }
  return Watching as unknown as typeof WebSocket;
}

/** A fresh `RunStream` module whose `@/streaming/arrow` is `factory`'s module. */
async function loadRunStreamWith(factory: () => Promise<unknown>) {
  vi.resetModules();
  vi.doMock('@/streaming/arrow', factory);
  return import('@/streaming/RunStream');
}

describe('RunStream — Arrow decoder chunk', { timeout: 30_000 }, () => {
  let server: MockServerHandle;
  let serverSocket: ServerSocket | undefined;
  let stream: RunStreamClass | undefined;
  const commands: string[] = [];

  beforeEach(() => {
    commands.length = 0;
    serverSocket = undefined;
    server = new MockServer(FULL_URL) as unknown as MockServerHandle;
    server.on('connection', (socket) => {
      serverSocket = socket;
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
    stream?.dispose();
    stream = undefined;
    server.stop();
    vi.doUnmock('@/streaming/arrow');
    vi.resetModules();
  });

  /**
   * Starts a stream whose decoder chunk stays out until the test settles it
   * (`'load'` delivers the module, `'fail'` makes the fetch fail), and returns
   * once the server's `ready` has been handled, so the command is being held.
   */
  async function startHeldStream(
    handlers: Pick<RunStreamOptions, 'onFrame' | 'onDone' | 'onError'>,
  ) {
    let settle: (outcome: 'load' | 'fail') => void = () => undefined;
    const gate = new Promise<'load' | 'fail'>((resolve) => {
      settle = resolve;
    });
    const { RunStream, loadArrowDecoder } = await loadRunStreamWith(async () => {
      if ((await gate) === 'fail') throw new Error('Failed to fetch dynamically imported module');
      return vi.importActual('@/streaming/arrow');
    });
    let readyHandled = false;
    stream = new RunStream(
      {
        sessionId: SESSION_ID,
        wsUrl: WS_URL,
        tdsArgs: { tf: 0.01, vars: ['bus_v'] },
        ...handlers,
      },
      {
        webSocketCtor: socketCtorWatchingReady(() => {
          readyHandled = true;
        }),
      },
    );
    stream.start();
    await vi.waitFor(() => expect(readyHandled).toBe(true), CHUNK_WAIT);
    await tick(0);
    /** Resolves once every callback the stream queued on the chunk has run. */
    const settled = async () => {
      await loadArrowDecoder().catch(() => undefined);
      await tick(20);
    };
    return { stream, settle, settled };
  }

  it('holds start_tds until the decoder has loaded, then decodes the run', async () => {
    const onFrame = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();
    const held = await startHeldStream({ onFrame, onDone, onError });

    // The server's `ready` has been handled; the command waits for the chunk.
    await tick(30);
    expect(commands).toEqual([]);
    expect(onError).not.toHaveBeenCalled();

    held.settle('load');
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled(), CHUNK_WAIT);

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
    stream = new RunStream(
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
    await vi.waitFor(() => expect(onError).toHaveBeenCalled(), CHUNK_WAIT);

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

  it('sends nothing when the stream is disposed while the command is held', async () => {
    const onFrame = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();
    const held = await startHeldStream({ onFrame, onDone, onError });

    held.stream.dispose();
    held.settle('load');
    await held.settled();

    expect(commands).toEqual([]);
    expect(held.stream.isClosed).toBe(true);
    expect(onFrame).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('stays quiet about a failed load when the stream was disposed meanwhile', async () => {
    const onError = vi.fn();
    const held = await startHeldStream({ onError });

    held.stream.dispose();
    held.settle('fail');
    await held.settled();

    expect(onError).not.toHaveBeenCalled();
    expect(commands).toEqual([]);
  });

  it('stays closed when the socket closes while the command is held', async () => {
    const onError = vi.fn();
    const held = await startHeldStream({ onError });

    serverSocket!.close({ code: 1006, reason: 'abnormal' });
    await vi.waitFor(() => expect(onError).toHaveBeenCalled(), CHUNK_WAIT);
    expect(onError.mock.calls[0]![0]).toMatchObject({ code: 'protocol_error' });
    expect(onError.mock.calls[0]![0].reason).toMatch(/before stream_start/);

    held.settle('load');
    await held.settled();

    // The late chunk neither sends a command nor reopens the finished stream.
    expect(commands).toEqual([]);
    expect(held.stream.isClosed).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
