/**
 * The eigenvalue-run hook: it posts to `/sessions/{id}/eig`, with the load
 * model in the body only when one is given (a Sienna session's choice), and
 * takes a bare session id as every caller without one does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { makeQueryClient, queryKeys, useEigRun } from '@/api/queries';
import { parseSessionId } from '@/api/types';
import { useJobsStore } from '@/store/jobs';

const SID = parseSessionId('s-eig');
const RESULT = { eigenvalues: [], damping_ratios: [], frequencies_hz: [], mode_count: 0 };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function wrapper() {
  const client = makeQueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, Wrapper };
}

describe('useEigRun', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch');
    fetchSpy.mockResolvedValue(jsonResponse(RESULT));
    useJobsStore.setState({ jobs: {} });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  async function run(vars: Parameters<ReturnType<typeof useEigRun>['mutate']>[0]) {
    const { client, Wrapper } = wrapper();
    const { result } = renderHook(() => useEigRun(), { wrapper: Wrapper });
    act(() => result.current.mutate(vars));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url, init] = fetchSpy.mock.calls[0]!;
    return { client, url: String(url), body: JSON.parse(String(init?.body)) as unknown };
  }

  it('posts an empty body for a bare session id', async () => {
    const { client, url, body } = await run(SID);
    expect(url).toMatch(/\/sessions\/s-eig\/eig$/);
    expect(body).toEqual({});
    expect(client.getQueryData(queryKeys.eig(SID))).toEqual(RESULT);
  });

  it('sends the load model it is given', async () => {
    const { client, url, body } = await run({ sessionId: SID, loadModel: 'power' });
    expect(url).toMatch(/\/sessions\/s-eig\/eig$/);
    expect(body).toEqual({ load_model: 'power' });
    expect(client.getQueryData(queryKeys.eig(SID))).toEqual(RESULT);
  });
});
