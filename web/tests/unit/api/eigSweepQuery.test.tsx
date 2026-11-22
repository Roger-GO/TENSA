/**
 * The EIG parameter-sweep hook: it posts the model, device, parameter and the
 * values to `/sessions/{id}/eig/sweep`, writes the answer through to the
 * analyze store and the query cache, and registers a job of kind `eig` that
 * is reconciled on success and failed on error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { makeQueryClient, queryKeys, useEigSweepRun } from '@/api/queries';
import type { EigSweepResponse } from '@/api/types';
import { useAnalyzeStore } from '@/store/analyze';
import { useJobsStore } from '@/store/jobs';
import { parseSessionId } from '@/api/types';
import { andesClient, TIMEOUTS } from '@/api/client';

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

const SWEEP_RESULT: EigSweepResponse = {
  model: 'GENROU',
  idx: '1',
  param: 'M',
  points: [
    {
      value: 1,
      eigenvalues: [
        { real: -0.2, imag: 3 },
        { real: -1, imag: 0 },
      ],
      damping_ratios: [0.066, 1],
      frequencies_hz: [0.477, 0],
    },
    {
      value: 3,
      eigenvalues: [
        { real: 0.05, imag: 2.5 },
        { real: -0.9, imag: 0 },
      ],
      damping_ratios: [-0.02, 1],
      frequencies_hz: [0.398, 0],
    },
  ],
  mode_count: 2,
  tds_initialized: false,
  job_id: 'job-1',
};

describe('useEigSweepRun', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch');
    useAnalyzeStore.getState().clearEigSweepResult();
    useJobsStore.setState({ jobs: {} });
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    useAnalyzeStore.getState().clearEigSweepResult();
    useJobsStore.setState({ jobs: {} });
  });

  it('posts the four required fields and nothing else', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(SWEEP_RESULT));
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useEigSweepRun(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        sessionId: parseSessionId('s1'),
        model: 'GENROU',
        idx: '1',
        param: 'M',
        values: [1, 2, 3],
      });
    });
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/api/sessions/s1/eig/sweep');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'GENROU',
      idx: '1',
      param: 'M',
      values: [1, 2, 3],
    });
  });

  it('waits a power flow and half a minute for each value of the sweep', async () => {
    const post = vi.spyOn(andesClient, 'post');
    try {
      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useEigSweepRun(), { wrapper: Wrapper });
      for (const values of [[1, 3], Array.from({ length: 200 }, (_, i) => i + 1)]) {
        fetchSpy.mockResolvedValueOnce(jsonResponse(SWEEP_RESULT));
        await act(async () => {
          await result.current.mutateAsync({
            sessionId: parseSessionId('s1'),
            model: 'GENROU',
            idx: '1',
            param: 'M',
            values,
          });
        });
      }
      expect(post).toHaveBeenCalledTimes(2);
      expect(TIMEOUTS.eigSweepPoint).toBe(30_000);
      expect(post.mock.calls[0]![1]).toMatchObject({ timeoutMs: TIMEOUTS.pflowRun + 60_000 });
      // 200 points, each a read, a setup, a power flow and an eigenvalue
      // analysis: an hour and forty minutes, past what a fixed bound gave.
      expect(post.mock.calls[1]![1]).toMatchObject({
        timeoutMs: TIMEOUTS.pflowRun + 6_000_000,
      });
    } finally {
      post.mockRestore();
    }
  });

  it('writes the result through to the store and seeds the query cache', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(SWEEP_RESULT));
    const { client, Wrapper } = makeWrapper();
    const { result } = renderHook(() => useEigSweepRun(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        sessionId: parseSessionId('s1'),
        model: 'GENROU',
        idx: '1',
        param: 'M',
        values: [1, 3],
      });
    });
    expect(useAnalyzeStore.getState().eigSweepResult).toEqual(SWEEP_RESULT);
    expect(client.getQueryData(queryKeys.eigSweep(parseSessionId('s1')))).toEqual(SWEEP_RESULT);
  });

  it('registers a job of kind eig with the body sent, and reconciles it on success', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(SWEEP_RESULT));
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useEigSweepRun(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        sessionId: parseSessionId('s1'),
        model: 'GENROU',
        idx: '1',
        param: 'M',
        values: [1, 3],
      });
    });
    const jobs = Object.values(useJobsStore.getState().jobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.kind).toBe('eig');
    expect(jobs[0]!.request_summary).toEqual({
      model: 'GENROU',
      idx: '1',
      param: 'M',
      values: [1, 3],
    });
    expect(jobs[0]!.status).toBe('done');
  });

  it('fails the job and propagates a 422 with its detail', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          type: 'about:blank',
          title: 'Unprocessable',
          status: 422,
          detail: 'point at value 2.5: power flow did not converge',
        },
        422,
      ),
    );
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useEigSweepRun(), { wrapper: Wrapper });
    let caught: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync({
          sessionId: parseSessionId('s1'),
          model: 'GENROU',
          idx: '1',
          param: 'M',
          values: [1, 2.5, 4],
        });
      } catch (err) {
        caught = err;
      }
    });
    expect(caught).toMatchObject({
      status: 422,
      detail: 'point at value 2.5: power flow did not converge',
    });
    await waitFor(() => expect(result.current.error).toMatchObject({ status: 422 }));
    const jobs = Object.values(useJobsStore.getState().jobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe('failed');
    expect(useAnalyzeStore.getState().eigSweepResult).toBeNull();
  });
});
