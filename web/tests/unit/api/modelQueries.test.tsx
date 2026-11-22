/**
 * The hooks of the model catalogue and its documentation: the list is read from
 * ``GET /sessions/{id}/models`` and one model's text from
 * ``GET /sessions/{id}/models/{model}/doc``, both with a session and neither
 * without one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ProblemDetailsError, TIMEOUTS } from '@/api/client';
import { makeQueryClient, useModelDoc, useSupportedModels } from '@/api/queries';
import { parseSessionId } from '@/api/types';
import { useSessionStore } from '@/store/session';

const get = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    andesClient: { ...actual.andesClient, get },
  };
});

function makeWrapper() {
  const client = makeQueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

/** A 409 as the server sends it, with the busy session's recovery or none. */
function problem409(detail: string, busy: boolean): ProblemDetailsError {
  const body = {
    type: 'about:blank',
    title: 'Conflict',
    status: 409,
    detail,
    instance: null,
    recovery: busy
      ? { kind: 'wait-for-job' as const, label: 'Wait for the running operation' }
      : null,
  };
  return new ProblemDetailsError(body, body);
}

function withSession(sessionId: string | null) {
  useSessionStore.setState({ sessionId: sessionId === null ? null : parseSessionId(sessionId) });
}

beforeEach(() => {
  get.mockReset();
  withSession('s1');
});

afterEach(() => {
  withSession(null);
});

describe('useSupportedModels', () => {
  it('GETs the catalogue of the session and hands the groups through', async () => {
    const body = { groups: { ACNode: ['Bus'], SynGen: ['GENROU', 'GENCLS'] } };
    get.mockResolvedValueOnce(body);
    const { result } = renderHook(() => useSupportedModels(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(body);
    expect(get).toHaveBeenCalledWith('/sessions/s1/models', { timeoutMs: TIMEOUTS.workspace });
  });

  it('sends nothing without a session', () => {
    withSession(null);
    const { result } = renderHook(() => useSupportedModels(), { wrapper: makeWrapper() });
    expect(result.current.fetchStatus).toBe('idle');
    expect(get).not.toHaveBeenCalled();
  });
});

describe('useModelDoc', () => {
  it('GETs the documentation of the model and hands it through', async () => {
    const body = { model: 'GENROU', doc: 'GENROU\n=====\nRound rotor generator.' };
    get.mockResolvedValueOnce(body);
    const { result } = renderHook(() => useModelDoc('GENROU'), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(body);
    expect(get).toHaveBeenCalledWith('/sessions/s1/models/GENROU/doc', {
      timeoutMs: TIMEOUTS.workspace,
    });
  });

  it('sends nothing for a null model', () => {
    const { result } = renderHook(() => useModelDoc(null), { wrapper: makeWrapper() });
    expect(result.current.fetchStatus).toBe('idle');
    expect(get).not.toHaveBeenCalled();
  });

  it('sends nothing without a session', () => {
    withSession(null);
    const { result } = renderHook(() => useModelDoc('GENROU'), { wrapper: makeWrapper() });
    expect(result.current.fetchStatus).toBe('idle');
    expect(get).not.toHaveBeenCalled();
  });

  it('encodes the model in the path', async () => {
    get.mockResolvedValueOnce({ model: 'a/b c', doc: '' });
    const { result } = renderHook(() => useModelDoc('a/b c'), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith('/sessions/s1/models/a%2Fb%20c/doc', {
      timeoutMs: TIMEOUTS.workspace,
    });
  });

  it('sends a request again while the session is busy, and fails at once on any other 409', async () => {
    get.mockRejectedValueOnce(problem409('session is busy with an in-flight operation', true));
    get.mockResolvedValueOnce({ model: 'GENROU', doc: 'text' });
    const busy = renderHook(() => useModelDoc('GENROU'), { wrapper: makeWrapper() });
    await waitFor(() => expect(busy.result.current.isSuccess).toBe(true));
    expect(busy.result.current.data?.doc).toBe('text');
    expect(get).toHaveBeenCalledTimes(2);

    get.mockReset();
    get.mockRejectedValueOnce(problem409('only ANDES documents its models', false));
    const list = renderHook(() => useSupportedModels(), { wrapper: makeWrapper() });
    await waitFor(() => expect(list.result.current.isError).toBe(true));
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('asks again for another model, and answers with that model', async () => {
    get.mockImplementation((path: string) =>
      Promise.resolve({ model: path.split('/')[4], doc: `text of ${path.split('/')[4]}` }),
    );
    const { result, rerender } = renderHook(({ model }) => useModelDoc(model), {
      wrapper: makeWrapper(),
      initialProps: { model: 'GENROU' },
    });
    await waitFor(() => expect(result.current.data?.doc).toBe('text of GENROU'));
    rerender({ model: 'TGOV1' });
    await waitFor(() => expect(result.current.data?.doc).toBe('text of TGOV1'));
    expect(get.mock.calls.map((c) => c[0])).toEqual([
      '/sessions/s1/models/GENROU/doc',
      '/sessions/s1/models/TGOV1/doc',
    ]);
  });
});
