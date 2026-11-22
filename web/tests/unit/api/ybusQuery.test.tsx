/**
 * The ``useYbus`` hook: the matrix is read from ``GET /sessions/{id}/ybus``,
 * only when the consumer calls ``refetch`` (``enabled: false``), and a refetch
 * without a session is refused before anything is sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useForgetYbus, useYbus } from '@/api/queries';
import { parseSessionId } from '@/api/types';
import { useSessionStore } from '@/store/session';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeWrapper() {
  // No retries: a refusal (the no-session refetch) must surface at once, and a
  // retrying client would keep the test waiting on the backoff.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, Wrapper };
}

const YBUS = {
  n_bus: 2,
  base_mva: 100,
  bus_idx: ['1', '2'],
  bus_key: [null, null],
  entries: [{ row: 0, col: 1, re: 0.5, im: -2.5 }],
};

describe('useYbus', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch');
    useSessionStore.setState({ sessionId: parseSessionId('sess 1') });
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    useSessionStore.setState({ sessionId: null });
  });

  it('never fires on its own: nothing is sent until refetch is called', async () => {
    const { Wrapper } = makeWrapper();
    const { result, rerender } = renderHook(() => useYbus(), { wrapper: Wrapper });
    // Give a query that would fetch on mount the time to do it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    rerender();
    expect(result.current.data).toBeUndefined();
    expect(result.current.fetchStatus).toBe('idle');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('forgets a matrix that was read, and sends nothing for it', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(YBUS));
    const { Wrapper, client } = makeWrapper();
    const { result } = renderHook(() => ({ query: useYbus(), forget: useForgetYbus() }), {
      wrapper: Wrapper,
    });
    await act(async () => {
      await result.current.query.refetch();
    });
    const key = ['ybus', parseSessionId('sess 1')];
    expect(client.getQueryData(key)).toEqual(YBUS);
    await act(async () => {
      result.current.forget();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(client.getQueryData(key)).toBeUndefined();
    expect(result.current.query.data).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('reads the matrix of the session, encoding the id, when refetch is called', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(YBUS));
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useYbus(), { wrapper: Wrapper });
    // ``refetch()`` resolves with the query's outcome; the observer of a
    // disabled query does not re-render the hook for it, so read it there.
    let outcome: Awaited<ReturnType<typeof result.current.refetch>> | undefined;
    await act(async () => {
      outcome = await result.current.refetch();
    });
    expect(outcome?.status).toBe('success');
    expect(outcome?.data).toEqual(YBUS);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/api/sessions/sess%201/ybus');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('refuses a refetch without a session before anything is sent', async () => {
    useSessionStore.setState({ sessionId: null });
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useYbus(), { wrapper: Wrapper });
    let outcome: Awaited<ReturnType<typeof result.current.refetch>> | undefined;
    await act(async () => {
      outcome = await result.current.refetch();
    });
    expect(outcome?.status).toBe('error');
    expect(outcome?.error?.message).toBe('useYbus refetched without a session');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
