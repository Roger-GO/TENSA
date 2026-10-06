/**
 * Reset run as one action: the reload, and the toast that says what became of
 * the run and of the edits, the same from the top bar and from a table's bar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return { ...actual, andesClient: client };
});

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

import { EDITS_DISCARDED, useResetRunAction } from '@/lib/useResetRunAction';
import { useCaseStore } from '@/store/case';
import { useRunsStore } from '@/store/runs';
import { useSessionStore } from '@/store/session';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { TopologySummary } from '@/api/types';
import { finishedRun } from '../helpers/runs';

const TOPOLOGY = {
  state: 'committed',
  buses: [],
  lines: [],
  transformers: [],
  generators: [],
  loads: [],
} as unknown as TopologySummary;

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  client.post.mockResolvedValue({ ...TOPOLOGY, state: 'pre-setup' });
  useSessionStore.setState({ sessionId: parseSessionId('s1') });
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    topology: TOPOLOGY,
  });
  useRunsStore.setState({ runs: {}, activeRunId: null });
});

afterEach(() => {
  useRunsStore.setState({ runs: {}, activeRunId: null });
});

describe('useResetRunAction', () => {
  it('reloads the case and, asked to confirm, says the run was reset', async () => {
    const { result } = renderHook(
      () => useResetRunAction({ errorTitle: 'Reset run', confirm: true }),
      {
        wrapper,
      },
    );
    act(() => result.current.reset());
    await waitFor(() =>
      expect(toastMock.info).toHaveBeenCalledWith('Run reset', {
        description: 'The results are cleared and the values can be changed again.',
      }),
    );
    expect(client.post).toHaveBeenCalledWith('/sessions/s1/reload', expect.anything());
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it('says nothing of its own when it is not asked to confirm', async () => {
    const { result } = renderHook(() => useResetRunAction({ errorTitle: 'TDS error' }), {
      wrapper,
    });
    act(() => result.current.reset());
    await waitFor(() => expect(client.post).toHaveBeenCalled());
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(toastMock.info).not.toHaveBeenCalled();
  });

  it('points to History for the run it releases, in place of the confirmation', async () => {
    const run = finishedRun('run-done', { displayName: 'Base run' });
    useRunsStore.setState({ runs: { [run.runId]: run }, activeRunId: run.runId });
    const { result } = renderHook(
      () => useResetRunAction({ errorTitle: 'Reset run', confirm: true }),
      {
        wrapper,
      },
    );
    act(() => result.current.reset());
    await waitFor(() =>
      expect(toastMock.info).toHaveBeenCalledWith('Base run stays in History', expect.anything()),
    );
    expect(toastMock.info).toHaveBeenCalledTimes(1);
  });

  it('warns that the edits of a case file are gone, in place of the confirmation', async () => {
    useCaseStore.setState({
      topology: { ...TOPOLOGY, undo: { label: 'add Bus 15' } } as unknown as TopologySummary,
    });
    const { result } = renderHook(
      () => useResetRunAction({ errorTitle: 'Reset run', confirm: true }),
      {
        wrapper,
      },
    );
    act(() => result.current.reset());
    await waitFor(() =>
      expect(toastMock.warning).toHaveBeenCalledWith('Edits discarded', {
        description: EDITS_DISCARDED,
        duration: 10000,
      }),
    );
    expect(toastMock.info).not.toHaveBeenCalled();
  });

  it('says why a reset failed, under the title it was given', async () => {
    client.post.mockRejectedValue(new Error('worker is gone'));
    const { result } = renderHook(() => useResetRunAction({ errorTitle: 'TDS error' }), {
      wrapper,
    });
    act(() => result.current.reset());
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith('TDS error', {
        description: 'Could not reset: worker is gone',
      }),
    );
  });

  it('does nothing without a session', () => {
    useSessionStore.setState({ sessionId: null });
    const { result } = renderHook(() => useResetRunAction({ errorTitle: 'Reset run' }), {
      wrapper,
    });
    act(() => result.current.reset());
    expect(client.post).not.toHaveBeenCalled();
  });
});
