/**
 * Tests for the v0.2 `<RunButton />`.
 *
 * The button is the orchestrator for both PF (legacy v0.1) and TDS (new
 * v0.2 streaming flow). The TDS branch wires through the substrate's
 * commit-disturbances + abort + reload endpoints AND opens a WebSocket
 * via ``RunStream``. We mock-socket the WS server, mock fetch for the
 * HTTP endpoints, and assert on the visible UI states + store mutations.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { Server as MockServer, WebSocket as MockWebSocket } from 'mock-socket';

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
import { loadArrowDecoder } from '@/streaming/RunStream';
import { makeQueryClient, queryKeys, useCurrentTopology } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useDisturbanceStore } from '@/store/disturbance';
import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layout';
import { useRunsStore, DEFAULT_MEMORY_BUDGET_BYTES } from '@/store/runs';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { CaseEvent, FaultSpec } from '@/api/types';
import { arrowFrame } from '../../helpers/frames';

// A run waits for the lazily loaded Arrow decoder before it sends its command;
// load it once so the waits below measure the flow and not the first import.
beforeAll(async () => {
  await loadArrowDecoder();
});

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
  return arrowFrame(t, cols);
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
  return { Wrapper, client };
}

// A TDS-runnable case has dynamic models; the topology carries one so the
// dynamic-content gate keeps the TDS button enabled.
const DYNAMIC_CONTROLLER = { idx: 'TGOV1_1', name: 't', kind: 'TGOV1', params: {} };

/**
 * Mounts the topology query and keeps the case-store mirror in step with it,
 * as the app's root does, so a refresh of the query is seen by the next click.
 */
function TopologyMirror() {
  const topology = useCurrentTopology();
  const setTopology = useCaseStore((s) => s.setTopology);
  useEffect(() => {
    if (topology !== null) setTopology(topology);
  }, [topology, setTopology]);
  return null;
}

function seedReady(
  opts: {
    withDisturbances?: boolean;
    topologyState?: 'pre-setup' | 'committed';
    events?: CaseEvent[];
  } = {},
) {
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    topology: {
      state: opts.topologyState ?? 'pre-setup',
      buses: [],
      lines: [],
      transformers: [],
      generators: [],
      loads: [],
      controllers: [DYNAMIC_CONTROLLER],
      events: opts.events ?? [],
    },
    layoutSidecar: null,
    selectedElement: null,
  });
  useSessionStore.setState({ sessionId: parseSessionId(SESSION_ID) });
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

function topologyBody(state: 'pre-setup' | 'committed') {
  return {
    state,
    buses: [],
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
    controllers: [DYNAMIC_CONTROLLER],
  };
}

/**
 * Fake the substrate's disturbance gate on a System a prior run committed:
 * a commit is refused with a 409 until ``/reload`` returns it to pre-setup.
 * ``calls`` records which endpoint was hit, in order, with the commit's
 * status, so a test can tell a commit that was sent and refused from one
 * that was never sent. The returned handle moves the System in or out of the
 * committed state, as a run that starts does.
 *
 * ``singleFlight`` makes the reads (topology, operating point) share the
 * session's lock as the real substrate does: one that arrives while another
 * is still being answered is refused with a 409 ``session is busy``, and its
 * call is recorded with that status. ``holdOperatingPoint`` keeps the first
 * operating-point read open until the handle's ``releaseOperatingPoint``.
 */
function fakeCommittedSubstrate(
  fetchSpy: ReturnType<typeof vi.spyOn>,
  calls: string[],
  opts: {
    reloadFails?: boolean;
    committed?: boolean;
    singleFlight?: boolean;
    holdOperatingPoint?: boolean;
  } = {},
) {
  let committed = opts.committed ?? true;
  let reading = false;
  let holdOperatingPoint = opts.holdOperatingPoint ?? false;
  let releaseOperatingPoint: (() => void) | null = null;
  const serveRead = (name: string, body: () => unknown, hold?: Promise<void>) => {
    if (opts.singleFlight && reading) {
      calls.push(`${name}:409`);
      return Promise.resolve(
        jsonResponse(
          { title: 'Conflict', status: 409, detail: 'session is busy with an in-flight operation' },
          409,
        ),
      );
    }
    calls.push(name);
    reading = true;
    return (hold ?? Promise.resolve()).then(() => {
      reading = false;
      return jsonResponse(body());
    });
  };
  fetchSpy.mockImplementation((input) => {
    const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
    if (url.endsWith('/topology')) {
      return serveRead('topology', () => topologyBody(committed ? 'committed' : 'pre-setup'));
    }
    if (url.endsWith('/operating-point')) {
      const hold = holdOperatingPoint
        ? new Promise<void>((resolve) => {
            releaseOperatingPoint = resolve;
          })
        : undefined;
      return serveRead('operating-point', () => ({}), hold);
    }
    if (url.includes('/reload')) {
      if (opts.reloadFails) {
        calls.push('reload:409');
        return Promise.resolve(
          jsonResponse({ title: 'Conflict', status: 409, detail: 'no case has been loaded' }, 409),
        );
      }
      calls.push('reload');
      committed = false;
      return Promise.resolve(jsonResponse(topologyBody('pre-setup'), 200));
    }
    if (url.includes('/disturbances')) {
      if (committed) {
        calls.push('disturbances:409');
        return Promise.resolve(
          jsonResponse(
            {
              title: 'Conflict',
              status: 409,
              detail: 'cannot modify disturbances after setup() has been committed',
              recovery: { kind: 'reload-case', label: 'Reload case' },
            },
            409,
          ),
        );
      }
      calls.push('disturbances:200');
      return Promise.resolve(jsonResponse({ accepted: [{ kind: 'fault', idx: 'Fault_0' }] }, 200));
    }
    return Promise.resolve(jsonResponse({}, 200));
  });
  return {
    setCommitted: (value: boolean) => {
      committed = value;
    },
    releaseOperatingPoint: () => {
      holdOperatingPoint = false;
      releaseOperatingPoint?.();
      releaseOperatingPoint = null;
    },
  };
}

/**
 * Answer ``start_tds`` with a stream that starts and finishes at once.
 * ``onStart`` runs when the command arrives, before the stream starts; ``runId``
 * can be a function to give each run its own id.
 */
function serveShortRun(
  server: MockServerHandle,
  runId: string | (() => string),
  onStart?: () => void,
) {
  server.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }));
    socket.on('message', (raw: unknown) => {
      const msg = JSON.parse(String(raw)) as { type: string };
      if (msg.type !== 'start_tds') return;
      onStart?.();
      const id = typeof runId === 'string' ? runId : runId();
      socket.send(
        JSON.stringify({
          type: 'stream_start',
          run_id: id,
          metadata: { schema_version: '2.0', vars: ['bus_v'], var_columns: ['Bus_1_v'] },
        }),
      );
      socket.send(
        JSON.stringify({
          type: 'done',
          run_id: id,
          converged: true,
          final_t: 5,
          callpert_count: 0,
        }),
      );
      socket.close({ code: 1000 });
    });
  });
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
    useRunsStore.setState({
      runs: {},
      activeRunId: null,
      memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('is disabled and tooltip explains the cause when no case is loaded', () => {
    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    // PF mode by default (no disturbances).
    expect(screen.getByTestId('run-pflow-button')).toBeDisabled();
  });

  it('is enabled in PF mode when case + session are present', () => {
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

  it('says in the run mode buttons what PF and TDS are', () => {
    seedReady();
    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    expect(screen.getByTestId('run-mode-pf')).toHaveAttribute(
      'title',
      expect.stringMatching(/power flow/i),
    );
    expect(screen.getByTestId('run-mode-tds')).toHaveAttribute(
      'title',
      expect.stringMatching(/time-domain.*faults/i),
    );
  });

  it('manual mode override sticks across re-renders', async () => {
    seedReady();
    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('run-mode-tds'));
    expect(screen.getByTestId('run-mode-tds')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('run-tds-button')).toBeInTheDocument();
  });

  // ---- Run-readiness gates (v2.0 polish, Unit 4) -----------------------

  it('shows the "No case loaded." tooltip on hover when no case is loaded', async () => {
    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    const button = screen.getByTestId('run-pflow-button');
    await userEvent.hover(button.parentElement!);
    const matches = await screen.findAllByText(/No case loaded/i);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('shows "Sweep ... in progress" tooltip when an active sweep is running', async () => {
    seedReady();
    const { useSweepStore } = await import('@/store/sweep');
    useSweepStore.setState({
      activeSweepId: 'sweep-7',
      sweeps: {
        'sweep-7': {
          sweepId: 'sweep-7',
          parameterKind: 'disturbance.fault.tc',
          parameterTarget: 0,
          snapshotName: 'snap-A',
          total: 5,
          state: 'running',
          iterations: [],
          truncated: false,
          error: null,
          startedAt: 0,
        },
      },
    });

    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    expect(screen.getByTestId('run-pflow-button')).toBeDisabled();

    const button = screen.getByTestId('run-pflow-button');
    await userEvent.hover(button.parentElement!);
    const matches = await screen.findAllByText(/Sweep sweep-7 in progress/i);
    expect(matches.length).toBeGreaterThan(0);

    // Cleanup so the next test gets a clean slate.
    useSweepStore.setState({ activeSweepId: null, sweeps: {} });
  });

  it('PF mode after EIG mutated dae shows the reload-case inline recovery + tooltip', async () => {
    seedReady();
    const { useAnalyzeStore } = await import('@/store/analyze');
    usePflowStore.setState({
      lastRun: {
        run_id: 'pf-1',
        converged: true,
        iterations: 3,
        mismatch: 1e-7,
        bus_voltages: {},
        bus_angles: {},
        line_flows: {},
      },
      isRunning: false,
      error: null,
    });
    useAnalyzeStore.setState({
      eigResult: {
        eigenvalues: [{ real: -0.1, imag: 1.0 }],
        damping_ratios: [0.1],
        frequencies_hz: [0.159],
        mode_count: 1,
        state_count: 1,
        state_names: ['delta_1'],
        tds_initialized: true,
      },
    });

    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });

    // Inline recovery rendered.
    const recovery = screen.getByTestId('run-button-recovery-reload');
    expect(recovery).toBeInTheDocument();
    expect(recovery).toHaveTextContent(/Reload case/i);

    // Run button disabled with explanatory tooltip.
    const button = screen.getByTestId('run-pflow-button');
    expect(button).toBeDisabled();
    await userEvent.hover(button.parentElement!);
    const matches = await screen.findAllByText(/EIG initialised the dynamic state/i);
    expect(matches.length).toBeGreaterThan(0);

    useAnalyzeStore.setState({ eigResult: null });
  });

  it('keeps the disabled reason in the page, so the button is described by it without a hover', async () => {
    seedReady();
    const { useAnalyzeStore } = await import('@/store/analyze');
    usePflowStore.setState({
      lastRun: {
        run_id: 'pf-1',
        converged: true,
        iterations: 4,
        mismatch: 1e-7,
        bus_voltages: {},
        bus_angles: {},
        line_flows: {},
      },
      isRunning: false,
      error: null,
    });
    useAnalyzeStore.setState({
      eigResult: {
        eigenvalues: [{ real: -0.1, imag: 1.0 }],
        damping_ratios: [0.1],
        frequencies_hz: [0.159],
        mode_count: 1,
        state_count: 1,
        state_names: ['delta_1'],
        tds_initialized: true,
      },
    });

    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });

    const button = screen.getByTestId('run-pflow-button');
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/EIG initialised the dynamic state/i);

    useAnalyzeStore.setState({ eigResult: null });
  });
});

describe('<RunButton /> v0.2 — PF branch (legacy v0.1 flow still works)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
      typeof vi.spyOn
    >;
    seedReady();
    usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    useSessionStore.setState({ sessionId: null });
    useCaseStore.setState({
      selection: null,
      topology: null,
      layoutSidecar: null,
      selectedElement: null,
    });
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
      expect(toastSuccessMock).toHaveBeenCalledWith('PF converged in 3 iterations.'),
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
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
      typeof vi.spyOn
    >;
    useRunsStore.setState({
      runs: {},
      activeRunId: null,
      memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
    });
    server = new MockServer(`ws://${WS_HOST}/api/ws/${SESSION_ID}`) as unknown as MockServerHandle;
  });

  afterEach(() => {
    server.stop();
    fetchSpy.mockRestore();
    restoreWebSocket();
    useSessionStore.setState({ sessionId: null });
    useCaseStore.setState({
      selection: null,
      topology: null,
      layoutSidecar: null,
      selectedElement: null,
    });
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
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.includes('/disturbances')) {
        postedDisturbances = true;
        return Promise.resolve(
          jsonResponse({ accepted: [{ kind: 'fault', idx: 'Fault_0' }] }, 200),
        );
      }
      return Promise.resolve(jsonResponse({}, 200));
    });

    server.on('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'ready' }));
      socket.on('message', (raw: unknown) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === 'start_tds') {
          socket.send(
            JSON.stringify({
              type: 'stream_start',
              run_id: 'run-tds-1',
              metadata: {
                schema_version: '2.0',
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
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.includes('/disturbances')) {
        disturbancesPosted = true;
      }
      return Promise.resolve(jsonResponse({}, 200));
    });

    server.on('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'ready' }));
      socket.on('message', (raw: unknown) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === 'start_tds') {
          socket.send(
            JSON.stringify({
              type: 'stream_start',
              run_id: 'run-free',
              metadata: {
                schema_version: '2.0',
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

  it('records the unit bases of the open case on the run it starts', async () => {
    seedReady();
    // The case's rated voltages and system frequency, as the topology carries them.
    const seeded = useCaseStore.getState().topology!;
    useCaseStore.setState({
      topology: {
        ...seeded,
        buses: [
          { idx: 1, name: 'b1', kind: 'Bus', params: { Vn: 230 } },
          { idx: 2, name: 'b2', kind: 'Bus', params: {} },
        ],
        freq_hz: 50,
      },
    });
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse({}, 200)));
    serveShortRun(server, 'run-bases');

    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('run-mode-tds'));
    await userEvent.click(screen.getByTestId('run-tds-button'));

    await waitFor(() => {
      expect(useRunsStore.getState().runs['run-bases']?.state).toBe('done');
    });
    // The run keeps them, so it can be read in kV and Hz after another case is loaded.
    expect(useRunsStore.getState().runs['run-bases']?.bases).toEqual({
      busKv: { '1': 230 },
      freqHz: 50,
    });
  });

  describe('a run with no fault', () => {
    function serveShort(runId: string) {
      server.on('connection', (socket) => {
        socket.send(JSON.stringify({ type: 'ready' }));
        socket.on('message', (raw: unknown) => {
          const msg = JSON.parse(String(raw)) as { type: string };
          if (msg.type !== 'start_tds') return;
          socket.send(
            JSON.stringify({
              type: 'stream_start',
              run_id: runId,
              metadata: {
                schema_version: '2.0',
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
              run_id: runId,
              converged: true,
              final_t: 5,
              callpert_count: 0,
            }),
          );
          socket.close({ code: 1000 });
        });
      });
    }

    beforeEach(() => {
      fetchSpy.mockImplementation(() =>
        Promise.resolve(jsonResponse({ accepted: [{ kind: 'fault', idx: 'Fault_0' }] }, 200)),
      );
    });

    it('says that nothing is scheduled, and where to add a fault, as it starts', async () => {
      seedReady();
      serveShort('run-nofault');

      const { Wrapper } = makeWrapper();
      render(<RunButton />, { wrapper: Wrapper });
      await userEvent.click(screen.getByTestId('run-mode-tds'));
      await userEvent.click(screen.getByTestId('run-tds-button'));
      await waitFor(() => {
        expect(useRunsStore.getState().runs['run-nofault']?.state).toBe('done');
      });

      expect(toastInfoMock).toHaveBeenCalledTimes(1);
      const [title, opts] = toastInfoMock.mock.calls[0] as [string, { description: string }];
      expect(title).toBe('No fault is set');
      expect(opts.description).toMatch(
        /Neither the sidebar nor the case schedules.*Disturbances in the left sidebar/,
      );
      // It claims nothing about the curves.
      expect(opts.description).not.toMatch(/flat/);
    });

    it('says nothing of the kind when the case defines an event of its own', async () => {
      // The Kundur case trips Line_8 at 2 s with nothing scheduled in the UI.
      seedReady({
        events: [
          {
            source: 'case',
            kind: 'toggle',
            name: 'Toggler_1',
            t: 2,
            model: 'Line',
            dev_idx: 'Line_8',
          },
        ],
      });
      serveShort('run-case-event');

      const { Wrapper } = makeWrapper();
      render(<RunButton />, { wrapper: Wrapper });
      await userEvent.click(screen.getByTestId('run-mode-tds'));
      await userEvent.click(screen.getByTestId('run-tds-button'));
      await waitFor(() => {
        expect(useRunsStore.getState().runs['run-case-event']?.state).toBe('done');
      });

      expect(toastInfoMock).not.toHaveBeenCalledWith('No fault is set', expect.anything());
    });

    it('says nothing of the kind when a bundle or snapshot replayed a disturbance', async () => {
      seedReady({
        events: [{ source: 'restored', kind: 'fault', t: 1, tc: 1.1, model: 'Bus', dev_idx: 4 }],
      });
      serveShort('run-restored');

      const { Wrapper } = makeWrapper();
      render(<RunButton />, { wrapper: Wrapper });
      await userEvent.click(screen.getByTestId('run-mode-tds'));
      await userEvent.click(screen.getByTestId('run-tds-button'));
      await waitFor(() => {
        expect(useRunsStore.getState().runs['run-restored']?.state).toBe('done');
      });

      expect(toastInfoMock).not.toHaveBeenCalledWith('No fault is set', expect.anything());
    });

    it('says nothing of the kind when a fault is set', async () => {
      seedReady({ withDisturbances: true });
      serveShort('run-fault');

      const { Wrapper } = makeWrapper();
      render(<RunButton />, { wrapper: Wrapper });
      await userEvent.click(screen.getByTestId('run-tds-button'));
      await waitFor(() => {
        expect(useRunsStore.getState().runs['run-fault']?.state).toBe('done');
      });

      expect(toastInfoMock).not.toHaveBeenCalledWith('No fault is set', expect.anything());
    });
  });

  describe('showing the run where it is plotted', () => {
    /** A server that starts a short run named ``runId`` and finishes it. */
    function serveRun(runId: string) {
      server.on('connection', (socket) => {
        socket.send(JSON.stringify({ type: 'ready' }));
        socket.on('message', (raw: unknown) => {
          const msg = JSON.parse(String(raw)) as { type: string };
          if (msg.type !== 'start_tds') return;
          socket.send(
            JSON.stringify({
              type: 'stream_start',
              run_id: runId,
              metadata: {
                schema_version: '2.0',
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
              run_id: runId,
              converged: true,
              final_t: 5,
              callpert_count: 0,
            }),
          );
          socket.close({ code: 1000 });
        });
      });
    }

    beforeEach(() => {
      useLayoutStore.setState({ ...DEFAULT_LAYOUT });
      fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse({}, 200)));
    });

    afterEach(() => {
      useLayoutStore.setState({ ...DEFAULT_LAYOUT });
    });

    it('opens Analysis, then Plot, in the drawer when a run starts, as the Run menu does', async () => {
      seedReady();
      useLayoutStore.setState({
        activeBottomDrawerTab: 'buses',
        activeAnalysisSubTab: 'tds',
      });
      serveRun('run-route');

      const { Wrapper } = makeWrapper();
      render(<RunButton />, { wrapper: Wrapper });
      await userEvent.click(screen.getByTestId('run-mode-tds'));
      await userEvent.click(screen.getByTestId('run-tds-button'));
      await waitFor(() => {
        expect(useRunsStore.getState().runs['run-route']?.state).toBe('done');
      });

      const layout = useLayoutStore.getState();
      expect(layout.activeBottomDrawerTab).toBe('analysis');
      expect(layout.activeAnalysisSubTab).toBe('plot');
      expect(layout.drawerHasUnreadResults).toBe(false);
    });

    it('leaves a collapsed drawer collapsed and marks it unread instead', async () => {
      seedReady();
      useLayoutStore.setState({ bottomDrawerCollapsed: true });
      serveRun('run-collapsed');

      const { Wrapper } = makeWrapper();
      render(<RunButton />, { wrapper: Wrapper });
      await userEvent.click(screen.getByTestId('run-mode-tds'));
      await userEvent.click(screen.getByTestId('run-tds-button'));
      await waitFor(() => {
        expect(useRunsStore.getState().runs['run-collapsed']?.state).toBe('done');
      });

      const layout = useLayoutStore.getState();
      expect(layout.bottomDrawerCollapsed).toBe(true);
      expect(layout.drawerHasUnreadResults).toBe(true);
      expect(layout.activeBottomDrawerTab).toBe('analysis');
    });

    it('does not move the drawer for a run that never started', async () => {
      seedReady({ withDisturbances: true });
      useLayoutStore.setState({ activeBottomDrawerTab: 'buses' });
      fetchSpy.mockImplementation(() =>
        Promise.resolve(jsonResponse({ detail: 'no such bus', title: 'Unprocessable' }, 422)),
      );

      const { Wrapper } = makeWrapper();
      render(<RunButton />, { wrapper: Wrapper });
      await userEvent.click(screen.getByTestId('run-tds-button'));
      await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());

      expect(useLayoutStore.getState().activeBottomDrawerTab).toBe('buses');
    });
  });

  it('disturbance commit 422 surfaces inline error toast and does NOT open WS', async () => {
    seedReady({ withDisturbances: true });
    let wsOpened = false;
    server.on('connection', () => {
      wsOpened = true;
    });
    fetchSpy.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
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

  it('commit 409 with a topology that still says pre-setup auto-reloads, retries once, and runs', async () => {
    seedReady({ withDisturbances: true });

    let disturbancePosts = 0;
    let reloadPosts = 0;
    fetchSpy.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.includes('/disturbances')) {
        disturbancePosts += 1;
        if (disturbancePosts === 1) {
          // First commit lands on a committed System → substrate 409s
          // with recovery reload-case.
          return Promise.resolve(
            jsonResponse(
              {
                title: 'Conflict',
                status: 409,
                detail: 'cannot modify disturbances after setup() has been committed',
                recovery: { kind: 'reload-case', label: 'Reload case' },
              },
              409,
            ),
          );
        }
        return Promise.resolve(
          jsonResponse({ accepted: [{ kind: 'fault', idx: 'Fault_0' }] }, 200),
        );
      }
      if (url.includes('/reload')) {
        reloadPosts += 1;
        return Promise.resolve(
          jsonResponse(
            {
              state: 'pre-setup',
              buses: [],
              lines: [],
              transformers: [],
              generators: [],
              loads: [],
              controllers: [],
            },
            200,
          ),
        );
      }
      return Promise.resolve(jsonResponse({}, 200));
    });

    server.on('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'ready' }));
      socket.on('message', (raw: unknown) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === 'start_tds') {
          socket.send(
            JSON.stringify({
              type: 'stream_start',
              run_id: 'run-tds-retry',
              metadata: {
                schema_version: '2.0',
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
              run_id: 'run-tds-retry',
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

    await waitFor(() => {
      expect(useRunsStore.getState().runs['run-tds-retry']?.state).toBe('done');
    });
    expect(reloadPosts).toBe(1);
    expect(disturbancePosts).toBe(2);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('disturbances on a committed System reload first and commit once, with no refused commit', async () => {
    seedReady({ withDisturbances: true, topologyState: 'committed' });
    const calls: string[] = [];
    fakeCommittedSubstrate(fetchSpy, calls);
    serveShortRun(server, 'run-after-pf');

    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('run-tds-button'));

    await waitFor(() => {
      expect(useRunsStore.getState().runs['run-after-pf']?.state).toBe('done');
    });
    // The 409 round trip is gone: reload, then the one commit that lands. The
    // operating point is read once the run is over.
    await waitFor(() => {
      expect(calls).toEqual(['reload', 'disturbances:200', 'operating-point']);
    });
    expect(toastInfoMock).toHaveBeenCalledWith('Reloading case', expect.anything());
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(useDisturbanceStore.getState().committed).toBe(true);
    // The reload's topology replaced the stale committed one.
    expect(useCaseStore.getState().topology?.state).toBe('pre-setup');
  });

  it('a pre-setup topology commits straight away, with no reload', async () => {
    seedReady({ withDisturbances: true, topologyState: 'pre-setup' });
    const calls: string[] = [];
    // The substrate really is pre-setup here, so the commit goes through.
    fetchSpy.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.includes('/disturbances')) {
        calls.push('disturbances:200');
        return Promise.resolve(
          jsonResponse({ accepted: [{ kind: 'fault', idx: 'Fault_0' }] }, 200),
        );
      }
      if (url.includes('/reload')) calls.push('reload');
      return Promise.resolve(jsonResponse({}, 200));
    });
    serveShortRun(server, 'run-fresh');

    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('run-tds-button'));

    await waitFor(() => {
      expect(useRunsStore.getState().runs['run-fresh']?.state).toBe('done');
    });
    expect(calls).toEqual(['disturbances:200']);
    expect(toastInfoMock).not.toHaveBeenCalled();
  });

  it('a committed System with no disturbances to commit runs without a reload', async () => {
    seedReady({ topologyState: 'committed' });
    const calls: string[] = [];
    fakeCommittedSubstrate(fetchSpy, calls);
    serveShortRun(server, 'run-free-committed');

    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('run-mode-tds'));
    await userEvent.click(screen.getByTestId('run-tds-button'));

    await waitFor(() => {
      expect(useRunsStore.getState().runs['run-free-committed']?.state).toBe('done');
    });
    // Nothing to reload or commit; only the operating point is read at the end.
    await waitFor(() => {
      expect(calls).toEqual(['operating-point']);
    });
    expect(toastInfoMock).not.toHaveBeenCalledWith('Reloading case', expect.anything());
  });

  /**
   * Run TDS with a disturbance on a pre-setup case, with the topology query
   * mounted the way the app mounts it. The substrate commits setup() when a run
   * starts, as the worker does, and returns no topology for the stream, so only
   * the client's refresh at the end of the run can tell the topology about it.
   */
  async function startTdsRun(
    calls: string[],
    substrateOpts: { singleFlight?: boolean; holdOperatingPoint?: boolean } = {},
  ) {
    seedReady({ withDisturbances: true, topologyState: 'pre-setup' });
    const substrate = fakeCommittedSubstrate(fetchSpy, calls, {
      ...substrateOpts,
      committed: false,
    });
    let started = 0;
    serveShortRun(
      server,
      () => `run-${(started += 1)}`,
      () => substrate.setCommitted(true),
    );
    const { Wrapper, client } = makeWrapper();
    // Seed the cache as the case load does, so mounting the query is no fetch.
    client.setQueryData(queryKeys.topology(parseSessionId(SESSION_ID)), topologyBody('pre-setup'));
    render(
      <>
        <TopologyMirror />
        <RunButton />
      </>,
      { wrapper: Wrapper },
    );
    await userEvent.click(screen.getByTestId('run-tds-button'));
    await waitFor(() => {
      expect(useRunsStore.getState().runs['run-1']?.state).toBe('done');
    });
    return substrate;
  }

  async function runTdsOnce(calls: string[]) {
    await startTdsRun(calls);
    // The topology is read again once the run is over.
    await waitFor(() => {
      expect(useCaseStore.getState().topology?.state).toBe('committed');
    });
  }

  it('a run dropped from the history and started again reloads first, with no refused commit', async () => {
    const calls: string[] = [];
    await runTdsOnce(calls);
    expect(calls).toEqual(['disturbances:200', 'operating-point', 'topology']);

    // Dropping a run from the history clears it without reloading the case,
    // so the button reads Run TDS again over a System the first run committed.
    act(() => {
      useRunsStore.getState().resetRun('run-1');
    });
    await userEvent.click(screen.getByTestId('run-tds-button'));
    await waitFor(() => {
      expect(useRunsStore.getState().runs['run-2']?.state).toBe('done');
    });

    // The second run's end reads the topology again.
    await waitFor(() => {
      expect(calls).toEqual([
        'disturbances:200',
        'operating-point',
        'topology',
        'reload',
        'disturbances:200',
        'operating-point',
        'topology',
      ]);
    });
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('reads the topology after the operating point, not beside it, on a substrate that serves one read at a time', async () => {
    const calls: string[] = [];
    const substrate = await startTdsRun(calls, { singleFlight: true, holdOperatingPoint: true });

    // The operating point is the read in flight. The topology waits for it
    // instead of going out beside it and being refused as busy.
    await waitFor(() => {
      expect(calls).toContain('operating-point');
    });
    await tick(20);
    expect(calls).toEqual(['disturbances:200', 'operating-point']);

    substrate.releaseOperatingPoint();
    await waitFor(() => {
      expect(useCaseStore.getState().topology?.state).toBe('committed');
    });
    expect(calls).toEqual(['disturbances:200', 'operating-point', 'topology']);

    // The topology landed, so the next run reloads first and commits once.
    act(() => {
      useRunsStore.getState().resetRun('run-1');
    });
    await userEvent.click(screen.getByTestId('run-tds-button'));
    await waitFor(() => {
      expect(useRunsStore.getState().runs['run-2']?.state).toBe('done');
    });
    await waitFor(() => {
      expect(calls).toEqual([
        'disturbances:200',
        'operating-point',
        'topology',
        'reload',
        'disturbances:200',
        'operating-point',
        'topology',
      ]);
    });
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('a run started after Reset run commits once, with no refused commit', async () => {
    const calls: string[] = [];
    await runTdsOnce(calls);

    await waitFor(() => {
      expect(screen.getByTestId('run-tds-button')).toHaveTextContent(/reset run/i);
    });
    await userEvent.click(screen.getByTestId('run-tds-button'));
    await waitFor(() => {
      expect(screen.getByTestId('run-tds-button')).toHaveTextContent(/run tds/i);
    });
    await userEvent.click(screen.getByTestId('run-tds-button'));
    await waitFor(() => {
      expect(useRunsStore.getState().runs['run-2']?.state).toBe('done');
    });

    // Reset run reloaded the case, so the second commit lands as it is.
    await waitFor(() => {
      expect(calls).toEqual([
        'disturbances:200',
        'operating-point',
        'topology',
        'reload',
        'disturbances:200',
        'operating-point',
        'topology',
      ]);
    });
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('a commit refused again after the reload surfaces the error, retries once, and does not open the WS', async () => {
    seedReady({ withDisturbances: true, topologyState: 'pre-setup' });
    const calls: string[] = [];
    fetchSpy.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.includes('/reload')) {
        calls.push('reload');
        return Promise.resolve(jsonResponse(topologyBody('pre-setup'), 200));
      }
      if (url.includes('/disturbances')) {
        calls.push('disturbances:409');
        return Promise.resolve(
          jsonResponse(
            {
              title: 'Conflict',
              status: 409,
              detail: 'cannot modify disturbances after setup() has been committed',
              recovery: { kind: 'reload-case', label: 'Reload case' },
            },
            409,
          ),
        );
      }
      return Promise.resolve(jsonResponse({}, 200));
    });
    let wsOpened = false;
    server.on('connection', () => {
      wsOpened = true;
    });

    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('run-tds-button'));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        'TDS error',
        expect.objectContaining({
          description: expect.stringMatching(/Could not commit disturbances: .*setup\(\)/),
        }),
      ),
    );
    await tick(20);
    // One recovery, not a loop: commit, reload, commit, stop.
    expect(calls).toEqual(['disturbances:409', 'reload', 'disturbances:409']);
    expect(wsOpened).toBe(false);
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    // The button is usable again for another try.
    expect(screen.getByTestId('run-tds-button')).toBeEnabled();
  });

  it('a failed proactive reload surfaces the error and neither commits nor opens the WS', async () => {
    seedReady({ withDisturbances: true, topologyState: 'committed' });
    const calls: string[] = [];
    fakeCommittedSubstrate(fetchSpy, calls, { reloadFails: true });
    let wsOpened = false;
    server.on('connection', () => {
      wsOpened = true;
    });

    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('run-tds-button'));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        'TDS error',
        expect.objectContaining({
          description: expect.stringMatching(/no case has been loaded/),
        }),
      ),
    );
    await tick(20);
    expect(calls).toEqual(['reload:409']);
    expect(wsOpened).toBe(false);
    // The button is usable again for another try.
    expect(screen.getByTestId('run-tds-button')).toBeEnabled();
  });

  it('WS run_not_found (close 4404) shows a non-modal warning toast', async () => {
    seedReady();
    useDisturbanceStore.setState({ disturbances: [], dirty: false, committed: false });
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse({}, 200)));
    server.on('connection', (socket) => {
      socket.close({ code: 4404, reason: 'session not found' });
    });

    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('run-mode-tds'));
    await userEvent.click(screen.getByTestId('run-tds-button'));

    await waitFor(() =>
      expect(toastWarningMock).toHaveBeenCalledWith(expect.stringMatching(/no longer available/i)),
    );
  });

  /** Run a TDS whose server answers ``start_tds`` with a run that is cut off by ``resync``. */
  async function runCutOffByResync(resync: Record<string, unknown>): Promise<void> {
    seedReady();
    useDisturbanceStore.setState({ disturbances: [], dirty: false, committed: false });
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse({}, 200)));
    server.on('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'ready' }));
      socket.on('message', (raw: unknown) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === 'start_tds') {
          socket.send(
            JSON.stringify({
              type: 'stream_start',
              run_id: 'run-resync',
              metadata: {
                schema_version: '2.0',
                vars: ['bus_v'],
                var_columns: ['Bus_1_v'],
              },
            }),
          );
          socket.send(JSON.stringify({ type: 'resync', run_id: 'run-resync', ...resync }));
          socket.close({ code: 1000 });
        }
      });
    });

    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('run-mode-tds'));
    await userEvent.click(screen.getByTestId('run-tds-button'));
  }

  it('WS resync (buffer evicted) shows a non-modal warning toast', async () => {
    await runCutOffByResync({ current_seq: 50, cause: 'buffer_evicted', reason: 'buffer evicted' });

    await waitFor(() =>
      expect(toastWarningMock).toHaveBeenCalledWith(expect.stringMatching(/connection dropped/i)),
    );
  });

  it('WS resync for a client that fell behind the run says so, not that the connection dropped', async () => {
    await runCutOffByResync({
      current_seq: 9000,
      cause: 'client_lagged',
      reason: 'the client fell too far behind the run and missed frames',
    });

    await waitFor(() =>
      expect(toastWarningMock).toHaveBeenCalledWith(
        expect.stringMatching(/fell too far behind the run and missed frames/i),
      ),
    );
    expect(toastWarningMock).toHaveBeenCalledTimes(1);
    expect(toastWarningMock).not.toHaveBeenCalledWith(expect.stringMatching(/connection dropped/i));
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});

describe('<RunButton /> — tds_config_overrides wire merge (Unit 14/16)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let server: MockServerHandle;

  /**
   * Drive a TDS run to the point the client emits ``start_tds`` and return
   * the payload's ``tds_config_overrides`` field (or ``undefined`` when the
   * key is absent). This is the load-bearing wire decision the store-level
   * tests never exercise: the RunButton merge of the structured QNDF preset
   * with the free-form editor dict + the trapezoidal/empty gating.
   */
  async function captureStartTdsOverrides(): Promise<unknown> {
    seedReady();
    useDisturbanceStore.setState({ disturbances: [], dirty: false, committed: false });
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse({}, 200)));

    const captured: { value: unknown; seen: boolean } = { value: undefined, seen: false };
    server.on('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'ready' }));
      socket.on('message', (raw: unknown) => {
        const msg = JSON.parse(String(raw)) as Record<string, unknown>;
        if (msg.type === 'start_tds') {
          captured.value = msg.tds_config_overrides;
          captured.seen = true;
          socket.close({ code: 1000 });
        }
      });
    });

    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    await userEvent.click(screen.getByTestId('run-mode-tds'));
    await userEvent.click(screen.getByTestId('run-tds-button'));
    await waitFor(() => expect(captured.seen).toBe(true));
    return captured.value;
  }

  beforeEach(async () => {
    installMockWebSocket();
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
      typeof vi.spyOn
    >;
    useRunsStore.setState({
      runs: {},
      activeRunId: null,
      memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
    });
    server = new MockServer(`ws://${WS_HOST}/api/ws/${SESSION_ID}`) as unknown as MockServerHandle;
    const { useUiStore } = await import('@/store/ui');
    useUiStore.getState().setTdsIntegrator('trapezoidal');
    useUiStore.getState().resetTdsToleranceOverrides();
    useUiStore.getState().resetTdsConfigOverrides();
  });

  afterEach(async () => {
    server.stop();
    fetchSpy.mockRestore();
    restoreWebSocket();
    useSessionStore.setState({ sessionId: null });
    useCaseStore.setState({
      selection: null,
      topology: null,
      layoutSidecar: null,
      selectedElement: null,
    });
    useDisturbanceStore.setState({ disturbances: [], dirty: false, committed: false });
    useRunsStore.setState({
      runs: {},
      activeRunId: null,
      memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
    });
    const { useUiStore } = await import('@/store/ui');
    useUiStore.getState().setTdsIntegrator('trapezoidal');
    useUiStore.getState().resetTdsToleranceOverrides();
    useUiStore.getState().resetTdsConfigOverrides();
  });

  it('trapezoidal + empty editor → no tds_config_overrides key on the wire', async () => {
    // Defaults already trapezoidal + empty editor.
    const overrides = await captureStartTdsOverrides();
    expect(overrides).toBeUndefined();
  });

  it('qndf + empty editor → only the structured rtol/atol/max_step preset', async () => {
    const { useUiStore } = await import('@/store/ui');
    useUiStore.getState().setTdsIntegrator('qndf-auto');
    const overrides = await captureStartTdsOverrides();
    expect(overrides).toEqual({ rtol: 1e-3, atol: 1e-6, max_step: 0.05 });
  });

  it('qndf + free-form key → editor dict merged on top of the preset', async () => {
    const { useUiStore } = await import('@/store/ui');
    useUiStore.getState().setTdsIntegrator('qndf-auto');
    useUiStore.getState().setTdsConfigOverrides({ tol: 1e-5 });
    const overrides = await captureStartTdsOverrides();
    expect(overrides).toEqual({ rtol: 1e-3, atol: 1e-6, max_step: 0.05, tol: 1e-5 });
  });

  it('collision: an editor key wins over the structured preset value', async () => {
    const { useUiStore } = await import('@/store/ui');
    useUiStore.getState().setTdsIntegrator('qndf-auto');
    useUiStore.getState().setTdsConfigOverrides({ rtol: 5e-4 });
    const overrides = await captureStartTdsOverrides();
    expect((overrides as Record<string, number>).rtol).toBe(5e-4);
  });

  it('trapezoidal + free-form key → just the editor dict (no preset)', async () => {
    const { useUiStore } = await import('@/store/ui');
    useUiStore.getState().setTdsConfigOverrides({ max_iter: 25 });
    const overrides = await captureStartTdsOverrides();
    expect(overrides).toEqual({ max_iter: 25 });
  });
});

describe('<RunButton /> v0.2 — abort + reset', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let server: MockServerHandle;

  beforeEach(() => {
    installMockWebSocket();
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
      typeof vi.spyOn
    >;
    useRunsStore.setState({
      runs: {},
      activeRunId: null,
      memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
    });
    server = new MockServer(`ws://${WS_HOST}/api/ws/${SESSION_ID}`) as unknown as MockServerHandle;
  });

  afterEach(() => {
    server.stop();
    fetchSpy.mockRestore();
    restoreWebSocket();
    useSessionStore.setState({ sessionId: null });
    useCaseStore.setState({
      selection: null,
      topology: null,
      layoutSidecar: null,
      selectedElement: null,
    });
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
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.includes('/abort')) {
        abortPosted = true;
        return Promise.resolve(jsonResponse({ aborted: true }, 200));
      }
      return Promise.resolve(jsonResponse({}, 200));
    });

    const serverSocketRef: { current: ServerSocket | null } = { current: null };
    server.on('connection', (socket) => {
      serverSocketRef.current = socket;
      socket.send(JSON.stringify({ type: 'ready' }));
      socket.on('message', (raw: unknown) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === 'start_tds') {
          socket.send(
            JSON.stringify({
              type: 'stream_start',
              run_id: 'run-abort',
              metadata: {
                schema_version: '2.0',
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

  it('says "Aborting…" and cannot be pressed again once the run was asked to stop from elsewhere (Esc)', async () => {
    seedReady();
    // A disturbance makes TDS the mode (the mode switch is locked during a run).
    useDisturbanceStore.setState({
      disturbances: [
        { id: 'd1', spec: { kind: 'fault', bus_idx: '4', tf: 1, tc: 1.1, xf: 0.05, rf: 0 } },
      ],
      dirty: false,
      committed: true,
    });
    useRunsStore.setState({
      runs: {
        'run-esc': {
          runId: 'run-esc',
          startedAt: 1,
          tf: 5,
          tCurrent: 1,
          seqCount: 10,
          t: new Float64Array(0),
          columns: {},
          columnNames: [],
          state: 'streaming',
          connection: 'connected',
          // The Esc command's request succeeded; the run has not ended yet.
          abortedLocally: true,
          errorReason: null,
        },
      },
      activeRunId: 'run-esc',
      memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
    });
    const { Wrapper } = makeWrapper();
    render(<RunButton />, { wrapper: Wrapper });
    const button = screen.getByTestId('run-tds-button');
    expect(button).toHaveTextContent(/aborting/i);
    expect(button).toBeDisabled();
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
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
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
    // The button says what it throws away, since the run is gone afterwards.
    expect(screen.getByTestId('run-tds-button')).toHaveAttribute(
      'title',
      expect.stringMatching(/discard this run's results/i),
    );
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
