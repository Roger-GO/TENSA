/**
 * `useEnginesSync` mirrors the engines query into the session store: before
 * `GET /api/engines` has answered the store's `engines` is null, and once it
 * has, the store holds the list, so the run-readiness gate can read it
 * without a query client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { makeQueryClient } from '@/api/queries';
import { useEnginesSync } from '@/api/useEnginesSync';
import { useSessionStore } from '@/store/session';
import type { EngineList } from '@/api/types';

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

const ENGINES: EngineList = {
  engines: [
    {
      name: 'andes',
      available: true,
      unavailable_reason: null,
      versions: { andes: '2.0.0' },
      formats: { read: ['raw'], write: ['raw'] },
      routines: ['pflow', 'tds', 'eig', 'cpf', 'se'],
      ops: [],
      editing: true,
    },
  ],
};

describe('useEnginesSync', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch');
    useSessionStore.setState({ engines: null });
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    useSessionStore.setState({ engines: null });
  });

  it('leaves the store null before the answer and mirrors the list once it lands', async () => {
    let answer: (response: Response) => void = () => {};
    fetchSpy.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    const { Wrapper } = makeWrapper();
    renderHook(() => useEnginesSync(), { wrapper: Wrapper });

    // The query is in flight; the store has nothing yet.
    expect(useSessionStore.getState().engines).toBeNull();

    answer(jsonResponse(ENGINES));
    await waitFor(() => expect(useSessionStore.getState().engines).toEqual(ENGINES));
    const [url] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/api/engines');
  });
});
