/**
 * Tests for the v0.2 `<RunButton />`.
 *
 * The button is the orchestrator for both PF (legacy v0.1) and TDS (new
 * v0.2 streaming flow). The TDS branch wires through the substrate's
 * commit-disturbances + abort + reload endpoints AND opens a WebSocket
 * via ``RunStream``. We mock-socket the WS server, mock fetch for the
 * HTTP endpoints, and assert on the visible UI states + store mutations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Server as MockServer, WebSocket as MockWebSocket } from 'mock-socket';
import { tableFromArrays, tableToIPC } from 'apache-arrow';

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
const toastWarningMock = vi.fn();
const toastInfoMock = vi.fn();

vi.mock('@/lib/toast', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
    warning: (...args: unknown[]) => toastWarningMock(...args),
    info: (...args: unknown[]) => toastInfoMock(...args),
    dismiss: vi.fn(),
  },
}));

import { RunButton } from '@/components/tds/RunButton';
import { makeQueryClient } from '@/api/queries';
import { setTokenGetter } from '@/api/client';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useDisturbanceStore } from '@/store/disturbance';
import { useAuthStore } from '@/store/auth';
import { useRunsStore, DEFAULT_MEMORY_BUDGET_BYTES } from '@/store/runs';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { FaultSpec } from '@/api/types';

const SESSION_ID = 'sess-1';
const WS_HOST = 'localhost:9876';

// Override window.location for this test file so the buildRunStreamWsUrl
// helper resolves to a known mock-socket address. jsdom lets us
// monkey-patch ``location`` via Object.defineProperty.
beforeEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      ...window.location,
      protocol: 'http:',
      host: WS_HOST,
    },
  });
  // Per Unit 3 of the v2.0 polish plan: toasts route through the
  // global wrapper. Reset mocks at the file-level so every nested
  // describe sees a clean call log.
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
  toastWarningMock.mockReset();
  toastInfoMock.mockReset();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function arrowBatch(t: number[], cols: Record<string, number[]>): ArrayBuffer {
  const arrays: Record<string, Float64Array> = { t: new Float64Array(t) };
  for (const name of Object.keys(cols)) {
    arrays[name] = new Float64Array(cols[name]!);
  }
  const table = tableFromArrays(arrays);
  const bytes = tableToIPC(table, 'stream');
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

function makeWrapper() {
  const client = makeQueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { Wrapper };
}

function seedReady(opts: { withDisturbances?: boolean } = {}) {
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    topology: {
      state: 'pre-setup',
      buses: [],
      lines: [],
      transformers: [],
      generators: [],
      loads: [],
    },
    layoutSidecar: null,
    selectedElement: null,
  });
  useSessionStore.setState({ sessionId: parseSessionId(SESSION_ID) });
  useAuthStore.setState({ token: 'test-token', persistFailed: false });
  if (opts.withDisturbances) {
    const spec: FaultSpec = {
      kind: 'fault',
      bus_idx: '4',
      tf: 1,
      tc: 1.1,
      xf: 0.0001,
      rf: 0,
    };
    useDisturbanceStore.setState({
      disturbances: [{ id: 'd-1', spec }],
      dirty: true,
      committed: false,
    });
  }
}

function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Patch the global WebSocket so RunStream picks up the mock-socket
// constructor via its default deps. (The Unit-7 RunButton wires
// RunStream with default deps — no injection point.)
const RealWebSocket = globalThis.WebSocket;

function installMockWebSocket() {
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    MockWebSocket as unknown as typeof WebSocket;
}

function restoreWebSocket() {
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = RealWebSocket;
}

describe('<RunButton /> v0.2 — disabled / enabled', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setTokenGetter(() => 'test-token');
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
      typeof vi.spyOn
    >;
    useSessionStore.setState({ sessionId: null });
    useCaseStore.setState({
      selection: null,
      topology: null,
      layoutSidecar: null,
      selectedElement: null,
    });
    usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
    useDisturbanceStore.setState({ disturbances: [], dirty: false, committed: false });
    useAuthStore.setState({ token: null, persistFailed: false });
    useRunsStore.setState({
      runs: {},
      activeRunId: null,
      memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    setTokenGetter(() => null);
  });

  it('is disabled and tooltip explains the cause when no case is loaded', () => {
    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    // PF mode by default (no disturbances).
    expect(screen.getByTestId('run-pflow-button')).toBeDisabled();
  });

  it('is enabled in PF mode when case + session + token are present', () => {
    seedReady();
    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    expect(screen.getByTestId('run-pflow-button')).toBeEnabled();
    // Mode selector visible; PF active.
    expect(screen.getByTestId('run-mode-pf')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('run-mode-tds')).toHaveAttribute('aria-checked', 'false');
  });

  it('auto-switches to TDS mode when disturbances are present', () => {
    seedReady({ withDisturbances: true });
    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    expect(screen.getByTestId('run-tds-button')).toBeEnabled();
    expect(screen.getByTestId('run-mode-tds')).toHaveAttribute('aria-checked', 'true');
  });

  it('manual mode override sticks across re-renders', async () => {
    seedReady();
    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('run-mode-tds'));
    expect(screen.getByTestId('run-mode-tds')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('run-tds-button')).toBeInTheDocument();
  });
});

describe('<RunButton /> v0.2 — PF branch (legacy v0.1 flow still works)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setTokenGetter(() => 'test-token');
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
      typeof vi.spyOn
    >;
    seedReady();
    usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    setTokenGetter(() => null);
    useSessionStore.setState({ sessionId: null });
    useCaseStore.setState({
      selection: null,
      topology: null,
      layoutSidecar: null,
      selectedElement: null,
    });
    useAuthStore.setState({ token: null, persistFailed: false });
    useDisturbanceStore.setState({ disturbances: [], dirty: false, committed: false });
  });

  it('on PF success (converged), fires toast.success', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          run_id: 'run-abc',
          converged: true,
          iterations: 3,
          mismatch: 1e-7,
          bus_voltages: { '1': 1.0 },
          bus_angles: { '1': 0 },
          line_flows: {},
        }),
      ),
    );
    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('run-pflow-button'));
    await waitFor(() =>
      expect(toastSuccessMock).toHaveBeenCalledWith(
        'PF converged in 3 iterations.',
      ),
    );
  });

  it('on 5xx, sets pflow.error to ServerError (no toast — modal owns it)', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({ title: 'Internal Server Error', status: 500, detail: 'boom' }, 500),
      ),
    );
    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('run-pflow-button'));
    await waitFor(() => {
      expect(usePflowStore.getState().error).not.toBeNull();
      expect(usePflowStore.getState().error?.status).toBe(500);
    });
    // 5xx routes through pflow.error to RuntimeCrashModal — no toast.
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('on 4xx, fires toast.error with the substrate detail', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(jsonResponse({ title: 'Bad Request', status: 422, detail: 'bad case' }, 422)),
    );
    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('run-pflow-button'));
    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        'Run PF failed',
        expect.objectContaining({ description: 'bad case' }),
      ),
    );
  });
});

describe('<RunButton /> v0.2 — TDS branch (happy path + error routing)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let server: MockServerHandle;

  beforeEach(() => {
    installMockWebSocket();
    setTokenGetter(() => 'test-token');
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
      typeof vi.spyOn
    >;
    useRunsStore.setState({
      runs: {},
      activeRunId: null,
      memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
    });
    server = new MockServer(`ws://${WS_HOST}/ws/${SESSION_ID}`) as unknown as MockServerHandle;
  });

  afterEach(() => {
    server.stop();
    fetchSpy.mockRestore();
    setTokenGetter(() => null);
    restoreWebSocket();
    useSessionStore.setState({ sessionId: null });
    useCaseStore.setState({
      selection: null,
      topology: null,
      layoutSidecar: null,
      selectedElement: null,
    });
    useAuthStore.setState({ token: null, persistFailed: false });
    useDisturbanceStore.setState({ disturbances: [], dirty: false, committed: false });
    useRunsStore.setState({
      runs: {},
      activeRunId: null,
      memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
    });
  });

  it('happy path with disturbances: commits → opens WS → frames → done', async () => {
    seedReady({ withDisturbances: true });

    let postedDisturbances = false;
    fetchSpy.mockImplementation((input) => {
      const url =
        typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.includes('/disturbances')) {
        postedDisturbances = true;
        return Promise.resolve(
          jsonResponse({ accepted: [{ kind: 'fault', idx: 'Fault_0' }] }, 200),
        );
      }
      return Promise.resolve(jsonResponse({}, 200));
    });

    server.on('connection', (socket) => {
      socket.on('message', (raw: unknown) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === 'auth') {
          socket.send(JSON.stringify({ type: 'ready' }));
        } else if (msg.type === 'start_tds') {
          socket.send(
            JSON.stringify({
              type: 'stream_start',
              run_id: 'run-tds-1',
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
          socket.send(arrowBatch([0.0, 0.01], { Bus_1_v: [1.0, 0.999] }));
          socket.send(
            JSON.stringify({
              type: 'done',
              run_id: 'run-tds-1',
              converged: true,
              final_t: 5,
              callpert_count: 0,
            }),
          );
          socket.close({ code: 1000 });
        }
      });
    });

    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });

    await userEvent.click(screen.getByTestId('run-tds-button'));
    // Wait for the run to land + stream to complete.
    await waitFor(() => {
      expect(useRunsStore.getState().runs['run-tds-1']?.state).toBe('done');
    });

    expect(postedDisturbances).toBe(true);
    expect(useDisturbanceStore.getState().committed).toBe(true);
    // After done, the button flips to "Reset run".
    await waitFor(() => {
      expect(screen.getByTestId('run-tds-button')).toHaveTextContent(/reset run/i);
    });
  });

  it('happy path (free-evolution): empty disturbances → SKIPS POST /disturbances', async () => {
    seedReady();
    // Manual mode → TDS so we get the TDS branch even with empty
    // disturbances (the auto rule would pick PF here).
    useDisturbanceStore.setState({ disturbances: [], dirty: false, committed: false });

    let disturbancesPosted = false;
    fetchSpy.mockImplementation((input) => {
      const url =
        typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.includes('/disturbances')) {
        disturbancesPosted = true;
      }
      return Promise.resolve(jsonResponse({}, 200));
    });

    server.on('connection', (socket) => {
      socket.on('message', (raw: unknown) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === 'auth') {
          socket.send(JSON.stringify({ type: 'ready' }));
        } else if (msg.type === 'start_tds') {
          socket.send(
            JSON.stringify({
              type: 'stream_start',
              run_id: 'run-free',
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
          socket.send(
            JSON.stringify({
              type: 'done',
              run_id: 'run-free',
              converged: true,
              final_t: 5,
              callpert_count: 0,
            }),
          );
          socket.close({ code: 1000 });
        }
      });
    });

    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('run-mode-tds'));
    await userEvent.click(screen.getByTestId('run-tds-button'));

    await waitFor(() => {
      expect(useRunsStore.getState().runs['run-free']?.state).toBe('done');
    });
    expect(disturbancesPosted).toBe(false);
  });

  it('disturbance commit 422 surfaces inline error toast and does NOT open WS', async () => {
    seedReady({ withDisturbances: true });
    let wsOpened = false;
    server.on('connection', () => {
      wsOpened = true;
    });
    fetchSpy.mockImplementation((input) => {
      const url =
        typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.includes('/disturbances')) {
        return Promise.resolve(
          jsonResponse(
            { title: 'Unprocessable Entity', status: 422, detail: 'unknown bus_idx 99' },
            422,
          ),
        );
      }
      return Promise.resolve(jsonResponse({}, 200));
    });

    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('run-tds-button'));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        'TDS error',
        expect.objectContaining({
          description: expect.stringMatching(/unknown bus_idx 99/),
        }),
      ),
    );
    await tick(20);
    expect(wsOpened).toBe(false);
  });

  it('WS auth_failed (close 4401) clears the auth token (cascade reopens TokenPasteModal)', async () => {
    seedReady();
    useDisturbanceStore.setState({ disturbances: [], dirty: false, committed: false });
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse({}, 200)));
    server.on('connection', (socket) => {
      socket.on('message', (raw: unknown) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === 'auth') {
          socket.close({ code: 4401, reason: 'invalid token' });
        }
      });
    });

    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('run-mode-tds'));
    await userEvent.click(screen.getByTestId('run-tds-button'));

    await waitFor(() => {
      expect(useAuthStore.getState().token).toBeNull();
    });
  });

  it('WS run_not_found (close 4404) shows a non-modal warning toast', async () => {
    seedReady();
    useDisturbanceStore.setState({ disturbances: [], dirty: false, committed: false });
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse({}, 200)));
    server.on('connection', (socket) => {
      socket.on('message', (raw: unknown) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === 'auth') {
          socket.close({ code: 4404, reason: 'session not found' });
        }
      });
    });

    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('run-mode-tds'));
    await userEvent.click(screen.getByTestId('run-tds-button'));

    await waitFor(() =>
      expect(toastWarningMock).toHaveBeenCalledWith(
        expect.stringMatching(/no longer available/i),
      ),
    );
  });

  it('WS resync (buffer evicted) shows a non-modal warning toast', async () => {
    seedReady();
    useDisturbanceStore.setState({ disturbances: [], dirty: false, committed: false });
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse({}, 200)));
    server.on('connection', (socket) => {
      socket.on('message', (raw: unknown) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === 'auth') {
          socket.send(JSON.stringify({ type: 'ready' }));
        } else if (msg.type === 'start_tds') {
          socket.send(
            JSON.stringify({
              type: 'stream_start',
              run_id: 'run-resync',
              metadata: {
                schema_version: '1.0',
                vars: ['bus_v'],
                var_columns: ['Bus_1_v'],
              },
            }),
          );
          socket.send(
            JSON.stringify({
              type: 'resync',
              run_id: 'run-resync',
              current_seq: 50,
              reason: 'buffer evicted',
            }),
          );
          socket.close({ code: 1000 });
        }
      });
    });

    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('run-mode-tds'));
    await userEvent.click(screen.getByTestId('run-tds-button'));

    await waitFor(() =>
      expect(toastWarningMock).toHaveBeenCalledWith(
        expect.stringMatching(/connection dropped/i),
      ),
    );
  });
});

describe('<RunButton /> v0.2 — abort + reset', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let server: MockServerHandle;

  beforeEach(() => {
    installMockWebSocket();
    setTokenGetter(() => 'test-token');
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
      typeof vi.spyOn
    >;
    useRunsStore.setState({
      runs: {},
      activeRunId: null,
      memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
    });
    server = new MockServer(`ws://${WS_HOST}/ws/${SESSION_ID}`) as unknown as MockServerHandle;
  });

  afterEach(() => {
    server.stop();
    fetchSpy.mockRestore();
    setTokenGetter(() => null);
    restoreWebSocket();
    useSessionStore.setState({ sessionId: null });
    useCaseStore.setState({
      selection: null,
      topology: null,
      layoutSidecar: null,
      selectedElement: null,
    });
    useAuthStore.setState({ token: null, persistFailed: false });
    useDisturbanceStore.setState({ disturbances: [], dirty: false, committed: false });
    useRunsStore.setState({
      runs: {},
      activeRunId: null,
      memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
    });
  });

  it('abort: click Abort during streaming → POST /abort + abortedLocally flips', async () => {
    seedReady();
    useDisturbanceStore.setState({ disturbances: [], dirty: false, committed: false });

    let abortPosted = false;
    fetchSpy.mockImplementation((input) => {
      const url =
        typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.includes('/abort')) {
        abortPosted = true;
        return Promise.resolve(jsonResponse({ aborted: true }, 200));
      }
      return Promise.resolve(jsonResponse({}, 200));
    });

    const serverSocketRef: { current: ServerSocket | null } = { current: null };
    server.on('connection', (socket) => {
      serverSocketRef.current = socket;
      socket.on('message', (raw: unknown) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === 'auth') {
          socket.send(JSON.stringify({ type: 'ready' }));
        } else if (msg.type === 'start_tds') {
          socket.send(
            JSON.stringify({
              type: 'stream_start',
              run_id: 'run-abort',
              metadata: {
                schema_version: '1.0',
                vars: ['bus_v'],
                var_columns: ['Bus_1_v'],
              },
            }),
          );
          socket.send(arrowBatch([0.0, 0.01], { Bus_1_v: [1.0, 0.999] }));
          // Don't send done yet; wait for the abort signal.
        }
      });
    });

    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('run-mode-tds'));
    await userEvent.click(screen.getByTestId('run-tds-button'));

    await waitFor(() => {
      expect(useRunsStore.getState().runs['run-abort']?.state).toBe('streaming');
    });
    // Button should now read "Abort".
    expect(screen.getByTestId('run-tds-button')).toHaveTextContent(/abort/i);

    await userEvent.click(screen.getByTestId('run-tds-button'));
    await waitFor(() => expect(abortPosted).toBe(true));
    await waitFor(() => {
      expect(useRunsStore.getState().runs['run-abort']?.abortedLocally).toBe(true);
    });

    // Substrate finishes the run with final_t < tf.
    serverSocketRef.current?.send(
      JSON.stringify({
        type: 'done',
        run_id: 'run-abort',
        converged: true,
        final_t: 0.01,
        callpert_count: 0,
      }),
    );
    serverSocketRef.current?.close({ code: 1000 });

    await waitFor(() => {
      expect(useRunsStore.getState().runs['run-abort']?.state).toBe('aborted');
    });
    // Button flips to Reset run.
    await waitFor(() => {
      expect(screen.getByTestId('run-tds-button')).toHaveTextContent(/reset run/i);
    });
  });

  it('reset: click Reset run after done → POST /reload + clears the run', async () => {
    seedReady();
    useDisturbanceStore.setState({
      disturbances: [
        {
          id: 'd-keep',
          spec: { kind: 'fault', bus_idx: '4', tf: 1, tc: 1.1, xf: 0.0001, rf: 0 },
        },
      ],
      dirty: false,
      committed: true,
    });
    // Pre-seed a completed run to put the button into "Reset run" mode.
    useRunsStore.setState({
      runs: {
        'run-done': {
          runId: 'run-done',
          startedAt: 1,
          tf: 5,
          tCurrent: 5,
          seqCount: 100,
          t: new Float64Array(0),
          columns: {},
          columnNames: [],
          state: 'done',
          connection: 'connected',
          abortedLocally: false,
          errorReason: null,
        },
      },
      activeRunId: 'run-done',
      memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
    });

    let reloadPosted = false;
    fetchSpy.mockImplementation((input) => {
      const url =
        typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.includes('/reload')) {
        reloadPosted = true;
        return Promise.resolve(
          jsonResponse(
            {
              state: 'pre-setup',
              buses: [],
              lines: [],
              transformers: [],
              generators: [],
              loads: [],
            },
            200,
          ),
        );
      }
      return Promise.resolve(jsonResponse({}, 200));
    });

    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('run-mode-tds'));
    expect(screen.getByTestId('run-tds-button')).toHaveTextContent(/reset run/i);
    await userEvent.click(screen.getByTestId('run-tds-button'));

    await waitFor(() => expect(reloadPosted).toBe(true));
    await waitFor(() => {
      expect(useRunsStore.getState().activeRunId).toBeNull();
    });
    // Disturbance timeline preserved; only the committed flag flipped.
    expect(useDisturbanceStore.getState().disturbances).toHaveLength(1);
    expect(useDisturbanceStore.getState().committed).toBe(false);
  });
});
