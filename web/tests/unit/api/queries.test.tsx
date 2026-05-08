/**
 * Smoke tests for the TanStack Query hooks in `src/api/queries.ts`.
 *
 * These tests don't exercise every cache permutation — the goal is to
 * prove the wrapper-around-fetch-+-store-write contract holds end-to-end:
 *
 * - `useCreateSession` writes to the session store on success.
 * - `useLoadCase` populates the topology cache on success.
 * - `useRunPflow` invalidates the topology cache (state flips).
 *
 * The fetch is stubbed; the QueryClient is freshly minted per test to
 * isolate cache state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  makeQueryClient,
  queryKeys,
  useCreateSession,
  useLoadCase,
  useRunPflow,
} from '@/api/queries';
import { setTokenGetter } from '@/api/client';
import { useSessionStore } from '@/store/session';
import type { SessionId } from '@/api/types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeWrapper() {
  const client = makeQueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, Wrapper };
}

describe('queries hooks', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setTokenGetter(() => 'test-token');
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
      typeof vi.spyOn
    >;
    useSessionStore.setState({ sessionId: null });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    setTokenGetter(() => null);
  });

  it('useCreateSession writes session_id to the session store', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ session_id: 'sess-123', state: 'live' }, 201));

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useCreateSession(), { wrapper: Wrapper });

    result.current.mutate();

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(useSessionStore.getState().sessionId).toBe('sess-123');
  });

  it('useLoadCase seeds the topology cache on success', async () => {
    const topology = {
      state: 'pre-setup' as const,
      buses: [],
      lines: [],
      transformers: [],
      generators: [],
      loads: [],
    };
    fetchSpy.mockResolvedValueOnce(jsonResponse(topology));

    const { client, Wrapper } = makeWrapper();
    const { result } = renderHook(() => useLoadCase(), { wrapper: Wrapper });

    const sessionId = 'sess-1' as SessionId;
    result.current.mutate({
      sessionId,
      request: { primary_path: 'ieee14.xlsx' },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(client.getQueryData(queryKeys.topology(sessionId))).toEqual(topology);
  });

  it('useRunPflow invalidates the topology cache', async () => {
    const pfResult = {
      run_id: 'r1',
      converged: true,
      iterations: 3,
      mismatch: 1e-6,
      bus_voltages: {},
      bus_angles: {},
      line_flows: {},
    };
    fetchSpy.mockResolvedValueOnce(jsonResponse(pfResult));

    const { client, Wrapper } = makeWrapper();
    const sessionId = 'sess-2' as SessionId;
    // Seed a topology cache value.
    client.setQueryData(queryKeys.topology(sessionId), {
      state: 'pre-setup',
      buses: [],
      lines: [],
      transformers: [],
      generators: [],
      loads: [],
    });

    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useRunPflow(), { wrapper: Wrapper });
    result.current.mutate(sessionId);

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.topology(sessionId) });
  });
});
