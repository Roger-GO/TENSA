/**
 * The notice after a power flow that breaks a limit: a toast that says how
 * many, with a button to the Violations tab. A clean run says nothing, and a
 * warning on its own does not interrupt. Every power flow the UI starts goes
 * through `useRunPflow`, so the last test runs that hook end to end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const toastWarningMock = vi.fn();
vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: (...args: unknown[]) => toastWarningMock(...args),
    dismiss: vi.fn(),
  },
}));

import { announceViolations, showViolations } from '@/lib/announceViolations';
import { makeQueryClient, queryKeys, useRunPflow } from '@/api/queries';
import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layout';
import { usePflowStore } from '@/store/pflow';
import { useSessionStore } from '@/store/session';
import { parseSessionId } from '@/api/types';
import { LIMITS_TOPOLOGY, limitsPflow } from '../helpers/limitsCase';
import { lineFlow } from '../helpers/lineFlow';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** What the server sends for a PF that only crosses the warning lines. */
const WARNINGS_ONLY = {
  bus_voltages: { '1': 1.0, '2': 0.915, '3': 1.0 },
  line_flows: { L2: lineFlow(85, 5, undefined, { rate_a: 100, loading_pct: 85 }) },
  generator_outputs: { '2': { p: 10, q: 15, v: 1.0, bus: 2, q_min: -50, q_max: 15 } },
};

beforeEach(() => {
  toastWarningMock.mockReset();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
});

afterEach(() => {
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
});

describe('announceViolations', () => {
  it('says how many violations and warnings a run left, with a way to the list', () => {
    announceViolations(limitsPflow(), LIMITS_TOPOLOGY);
    expect(toastWarningMock).toHaveBeenCalledTimes(1);
    const [message, options] = toastWarningMock.mock.calls[0]!;
    expect(message).toBe('4 violations and 3 warnings after the power flow.');
    expect(options.description).toContain('Violations tab');
    expect(options.action.label).toBe('Show violations');
  });

  it('says nothing when every limit holds', () => {
    announceViolations(
      limitsPflow({
        bus_voltages: { '1': 1.0, '2': 1.0, '3': 1.0 },
        line_flows: {},
        generator_outputs: {},
      }),
      LIMITS_TOPOLOGY,
    );
    expect(toastWarningMock).not.toHaveBeenCalled();
  });

  it('says nothing for warnings alone: they show in the tab count and on the diagram', () => {
    announceViolations(limitsPflow(WARNINGS_ONLY), LIMITS_TOPOLOGY);
    expect(toastWarningMock).not.toHaveBeenCalled();
  });

  it('says nothing when the run did not converge, or the case is not known', () => {
    announceViolations(limitsPflow({ converged: false }), LIMITS_TOPOLOGY);
    announceViolations(limitsPflow(), undefined);
    expect(toastWarningMock).not.toHaveBeenCalled();
  });

  it('opens the drawer on the Violations tab from the toast action', () => {
    useLayoutStore.setState({
      bottomDrawerCollapsed: true,
      resultsViewActive: true,
      activeBottomDrawerTab: 'buses',
    });
    announceViolations(limitsPflow(), LIMITS_TOPOLOGY);
    toastWarningMock.mock.calls[0]![1].action.onClick();
    const layout = useLayoutStore.getState();
    expect(layout.activeBottomDrawerTab).toBe('violations');
    expect(layout.bottomDrawerCollapsed).toBe(false);
    // The drawer is part of the diagram view, which the results page replaces.
    expect(layout.resultsViewActive).toBe(false);
  });
});

describe('showViolations', () => {
  it('leaves an open drawer open and switches it to the Violations tab', () => {
    useLayoutStore.setState({ bottomDrawerCollapsed: false, activeBottomDrawerTab: 'lines' });
    showViolations();
    expect(useLayoutStore.getState().activeBottomDrawerTab).toBe('violations');
    expect(useLayoutStore.getState().bottomDrawerCollapsed).toBe(false);
  });
});

describe('useRunPflow', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
      typeof vi.spyOn
    >;
    useSessionStore.setState({ sessionId: null });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  async function run(body: Record<string, unknown>, withTopology = true) {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ ...body, job_id: 'srv-pf-1' }));
    const client = makeQueryClient();
    const sessionId = parseSessionId('sess-9');
    if (withTopology) client.setQueryData(queryKeys.topology(sessionId), LIMITS_TOPOLOGY);
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const { result } = renderHook(() => useRunPflow(), { wrapper: Wrapper });
    result.current.mutate(sessionId);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  }

  it('announces the violations of the run it just stored', async () => {
    await run({ ...limitsPflow() });
    expect(usePflowStore.getState().lastRun?.converged).toBe(true);
    expect(toastWarningMock).toHaveBeenCalledTimes(1);
    expect(toastWarningMock.mock.calls[0]![0]).toBe(
      '4 violations and 3 warnings after the power flow.',
    );
  });

  it('announces nothing for a run that breaks no limit, or before the topology is known', async () => {
    await run({
      ...limitsPflow({
        bus_voltages: { '1': 1.0, '2': 1.0, '3': 1.0 },
        line_flows: {},
        generator_outputs: {},
      }),
    });
    expect(toastWarningMock).not.toHaveBeenCalled();

    await run({ ...limitsPflow() }, false);
    expect(toastWarningMock).not.toHaveBeenCalled();
  });
});
