/**
 * "Check initialisation" end to end through the real `useTdsInit` and the real
 * query client, against a faked substrate: what the request sends, and that a
 * successful check fixes the system for the rest of the app as a run does
 * (the topology reads `committed`, so every place that says a run has fixed the
 * system says it), while a refused one changes nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
  },
}));

import { RunButton } from '@/components/tds/RunButton';
import { makeQueryClient, queryKeys, useTdsInit } from '@/api/queries';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { TopologySummary } from '@/api/types';
import { runLockNotice } from '@/lib/runLock';
import { useAddComponent } from '@/lib/useAddComponent';
import { useSyncTopologyMirror } from '@/lib/useSyncTopologyMirror';
import { useCaseStore } from '@/store/case';
import { useDisturbanceStore } from '@/store/disturbance';
import { useRunsStore } from '@/store/runs';
import { useSessionStore } from '@/store/session';

const SESSION_ID = parseSessionId('sess-init');

function topology(state: 'pre-setup' | 'committed'): TopologySummary {
  return {
    state,
    buses: [],
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
    controllers: [{ idx: 'TGOV1_1', name: 't', kind: 'TGOV1', params: {} }],
    events: [],
    undo: null,
  } as TopologySummary;
}

const PASSED = {
  initialized: true,
  test_ok: true,
  test_init: true,
  n_states: 10,
  n_algeb: 20,
  max_residual: 0,
  nan_residuals: 0,
  clamped: [],
  residuals: [],
  diagnostics_truncated: false,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function urlOf(input: unknown): string {
  return typeof input === 'string' ? input : ((input as Request).url ?? String(input));
}

/** A place that says a run has fixed the system: the Components palette's reason. */
function LockProbe() {
  useSyncTopologyMirror();
  const { blockedReason } = useAddComponent();
  return <p data-testid="lock-probe">{blockedReason ?? 'open'}</p>;
}

function renderApp() {
  const client = makeQueryClient();
  client.setQueryData(queryKeys.topology(SESSION_ID), topology('pre-setup'));
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  render(
    <>
      <RunButton />
      <LockProbe />
    </>,
    { wrapper: Wrapper },
  );
  return client;
}

describe('Check initialisation against the substrate', () => {
  let fetchSpy: MockInstance<typeof fetch>;
  let committed: boolean;

  beforeEach(() => {
    committed = false;
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
      topology: topology('pre-setup'),
      layoutSidecar: null,
      selectedElement: null,
    });
    useSessionStore.setState({ sessionId: SESSION_ID });
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    useSessionStore.setState({ sessionId: null });
    useCaseStore.setState({ selection: null, topology: null });
    useDisturbanceStore.setState({ disturbances: [], dirty: false, committed: false });
    useRunsStore.setState({ runs: {}, activeRunId: null });
  });

  it('a passed check sends no body options, and the app then shows the run lock', async () => {
    fetchSpy.mockImplementation((input) => {
      const url = urlOf(input);
      if (url.endsWith('/tds/init')) {
        committed = true;
        return Promise.resolve(json(PASSED));
      }
      if (url.endsWith('/topology')) {
        return Promise.resolve(json(topology(committed ? 'committed' : 'pre-setup')));
      }
      if (url.endsWith('/reload')) {
        committed = false;
        return Promise.resolve(json(topology('pre-setup')));
      }
      return Promise.resolve(json({}));
    });
    renderApp();
    expect(screen.getByTestId('lock-probe')).toHaveTextContent('open');

    await userEvent.click(screen.getByTestId('run-mode-tds'));
    await userEvent.click(screen.getByTestId('tds-init-check'));

    const sent = fetchSpy.mock.calls.find(([input]) => urlOf(input).endsWith('/tds/init'));
    expect(sent).toBeDefined();
    expect(urlOf(sent?.[0])).toContain(`/sessions/${SESSION_ID}/tds/init`);
    expect((sent?.[1] as RequestInit | undefined)?.method).toBe('POST');
    expect(JSON.parse(String((sent?.[1] as RequestInit | undefined)?.body))).toEqual({});

    expect(await screen.findByTestId('tds-init-verdict')).toHaveTextContent(
      'Every dynamic model starts at a steady state.',
    );
    // The topology is read again, as after a power flow, and the lock is said
    // where a run would have it said.
    await waitFor(() => expect(useCaseStore.getState().topology?.state).toBe('committed'));
    await waitFor(() =>
      expect(screen.getByTestId('lock-probe')).toHaveTextContent(runLockNotice(false)),
    );
    expect(screen.getByTestId('tds-init-session-note')).toHaveTextContent(runLockNotice(false));

    // Reset run from the dialog reads the case again: the lock goes, and the
    // check is offered again.
    await userEvent.click(screen.getByTestId('tds-init-reset-run'));
    await waitFor(() => expect(screen.getByTestId('lock-probe')).toHaveTextContent('open'));
    await waitFor(() => expect(screen.getByTestId('tds-init-check')).toBeEnabled());
  });

  it('a refused check (422) shows the server detail and leaves the system as it was', async () => {
    fetchSpy.mockImplementation((input) => {
      const url = urlOf(input);
      if (url.endsWith('/tds/init')) {
        return Promise.resolve(
          json(
            {
              type: 'about:blank',
              title: 'Unprocessable Entity',
              status: 422,
              detail:
                'the loaded case has no dynamic models; there is no time-domain run to initialise',
            },
            422,
          ),
        );
      }
      if (url.endsWith('/topology')) return Promise.resolve(json(topology('pre-setup')));
      return Promise.resolve(json({}));
    });
    renderApp();
    await userEvent.click(screen.getByTestId('run-mode-tds'));
    await userEvent.click(screen.getByTestId('tds-init-check'));
    expect(await screen.findByTestId('tds-init-error')).toHaveTextContent(
      'The initialisation could not be checked: the loaded case has no dynamic models; there is no time-domain run to initialise',
    );
    expect(screen.queryByTestId('tds-init-session-note')).not.toBeInTheDocument();
    expect(fetchSpy.mock.calls.some(([input]) => urlOf(input).endsWith('/topology'))).toBe(false);
    expect(screen.getByTestId('lock-probe')).toHaveTextContent('open');
  });
});

describe('useTdsInit', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch');
    fetchSpy.mockImplementation(() => Promise.resolve(json(PASSED)));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function wrapper() {
    const client = makeQueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    return { Wrapper, invalidate };
  }

  it('sends test_init only when it is asked for', async () => {
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useTdsInit(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({ sessionId: SESSION_ID, testInit: false });
    });
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body))).toEqual({ test_init: false });
  });

  it('invalidates the topology on success and not on a failure', async () => {
    const { Wrapper, invalidate } = wrapper();
    const { result } = renderHook(() => useTdsInit(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({ sessionId: SESSION_ID });
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.topology(SESSION_ID) });

    invalidate.mockClear();
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        json({ type: 'about:blank', title: 'Unprocessable Entity', status: 422, detail: 'x' }, 422),
      ),
    );
    await act(async () => {
      await result.current.mutateAsync({ sessionId: SESSION_ID }).catch(() => undefined);
    });
    expect(invalidate).not.toHaveBeenCalled();
  });
});
