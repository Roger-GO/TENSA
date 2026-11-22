/**
 * The engines query and the engine of a session: `useEngines` reads
 * `GET /engines`, and `useCreateSession` asks for the engine the session
 * store holds (none: the server picks its default) and keeps the engine of
 * the session it created.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { makeQueryClient, useCreateSession, useEngines } from '@/api/queries';
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

describe('engine hooks', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch');
    useSessionStore.setState({ sessionId: null, engine: null, workspaceId: null });
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    useSessionStore.setState({ sessionId: null, engine: null, workspaceId: null });
  });

  it('useEngines returns the list from GET /api/engines', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(ENGINES));
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useEngines(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(ENGINES);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/api/engines');
    expect(init.method).toBe('GET');
  });

  it('useCreateSession sends {} when the store holds no engine', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        session_id: 'sess-1',
        state: 'live',
        workspace_id: 'ws-1',
        engine: 'andes',
      }),
    );
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useCreateSession(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync();
    });
    const [, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(init.body).toBe('{}');
    expect(useSessionStore.getState().engine).toBe('andes');
  });

  it('useCreateSession sends the engine the store holds and stores the one of the response', async () => {
    useSessionStore.getState().setEngine('sienna');
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        session_id: 'sess-2',
        state: 'live',
        workspace_id: 'ws-1',
        engine: 'sienna',
      }),
    );
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useCreateSession(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync();
    });
    const [, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify({ engine: 'sienna' }));
    expect(useSessionStore.getState().engine).toBe('sienna');
    expect(useSessionStore.getState().sessionId).toBe('sess-2');
  });
});
