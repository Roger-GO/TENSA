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
  useAlterableParams,
  useCreateSession,
  useListPmus,
  useListProfiles,
  useListSnapshots,
  useLoadCase,
  useRunPflow,
  useTopology,
} from '@/api/queries';
import { parseSessionId } from '@/api/types';
import { setTokenGetter } from '@/api/client';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { useJobsStore, LOCAL_ID_PREFIX, isTerminalStatus } from '@/store/jobs';
import type { SessionId, WorkspacePath } from '@/api/types';

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
    useCaseStore.setState({ selection: null });
    useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    setTokenGetter(() => null);
    useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
    useCaseStore.setState({ selection: null });
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

  it('useLoadCase invalidates the per-case snapshots list on success', async () => {
    // Snapshots are listed per-case; the query first runs before any case
    // is loaded (caching []). Loading a case must invalidate it so the new
    // case's existing snapshots surface (panel + Sweep picker).
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
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useLoadCase(), { wrapper: Wrapper });

    const sessionId = 'sess-snap' as SessionId;
    result.current.mutate({ sessionId, request: { primary_path: 'kundur_full.xlsx' } });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['snapshots', sessionId] });
  });

  it('useAlterableParams hits the substrate path scoped to (session, model)', async () => {
    const sessionId = parseSessionId('sess-alter');
    useSessionStore.setState({ sessionId });
    fetchSpy.mockResolvedValueOnce(jsonResponse({ model: 'PQ', params: ['p0', 'q0'] }));

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useAlterableParams('PQ'), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data?.params).toEqual(['p0', 'q0']);
    // The fetch went to the alterable_params path scoped to the session.
    const url = String(fetchSpy.mock.calls[0]?.[0] ?? '');
    expect(url).toContain('/sessions/sess-alter/topology/models/PQ/alterable_params');
  });

  it('useAlterableParams stays disabled until session + model are present', () => {
    useSessionStore.setState({ sessionId: null });
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useAlterableParams('PQ'), { wrapper: Wrapper });
    // Without a session, the hook never fires; status sits at "pending"
    // with fetchStatus "idle".
    expect(result.current.fetchStatus).toBe('idle');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('useRunPflow onMutate registers a pending placeholder; onSuccess re-keys to the server job_id', async () => {
    useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        run_id: 'r1',
        converged: true,
        iterations: 3,
        mismatch: 1e-6,
        bus_voltages: {},
        bus_angles: {},
        line_flows: {},
        job_id: 'srv-pf-1',
      }),
    );

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useRunPflow(), { wrapper: Wrapper });
    result.current.mutate('sess-7' as SessionId);

    // onMutate placeholder appears synchronously.
    await waitFor(() => {
      const ids = Object.keys(useJobsStore.getState().jobs);
      expect(ids.some((id) => id.startsWith(LOCAL_ID_PREFIX))).toBe(true);
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const jobs = useJobsStore.getState().jobs;
    // The placeholder re-keyed onto the canonical server job_id.
    expect(jobs['srv-pf-1']).toBeDefined();
    expect(jobs['srv-pf-1']!.status).toBe('done');
    expect(jobs['srv-pf-1']!.isPlaceholder).toBeUndefined();
    expect(Object.keys(jobs).some((id) => id.startsWith(LOCAL_ID_PREFIX))).toBe(false);
  });

  it('useRunPflow onSuccess WITHOUT a job_id marks the placeholder done in place', async () => {
    useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        run_id: 'r2',
        converged: true,
        iterations: 2,
        mismatch: 1e-7,
        bus_voltages: {},
        bus_angles: {},
        line_flows: {},
        // No job_id field.
      }),
    );

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useRunPflow(), { wrapper: Wrapper });
    result.current.mutate('sess-8' as SessionId);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const jobs = useJobsStore.getState().jobs;
    const ids = Object.keys(jobs);
    // The temp record stays under its local id, marked done.
    expect(ids).toHaveLength(1);
    expect(ids[0]!.startsWith(LOCAL_ID_PREFIX)).toBe(true);
    expect(jobs[ids[0]!]!.status).toBe('done');
  });

  it('a 409 SessionBusy onError produces a failed JobRecord carrying the problem + recovery', async () => {
    useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          type: 'about:blank',
          title: 'Session Busy',
          status: 409,
          detail: 'A routine is already running on this session.',
          recovery: { kind: 'retry', label: 'Retry' },
        },
        409,
      ),
    );

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useRunPflow(), { wrapper: Wrapper });
    result.current.mutate('sess-9' as SessionId);

    await waitFor(() => expect(result.current.isError).toBe(true));

    const jobs = useJobsStore.getState().jobs;
    const ids = Object.keys(jobs);
    // No canonical record exists (WS not connected in this test), so the
    // placeholder is marked failed in place, carrying the problem.
    expect(ids).toHaveLength(1);
    const rec = jobs[ids[0]!]!;
    expect(rec.status).toBe('failed');
    expect(rec.problem?.title).toBe('Session Busy');
    expect(rec.problem?.status).toBe(409);
    expect(rec.problem?.recovery).toEqual({ kind: 'retry', label: 'Retry' });
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

  it('a 422 case-load leaves NO in-flight record (placeholder cleared, none stranded)', async () => {
    // STUCK-PILL FIX: a failed case-load must not leave any record in a
    // pending/running state that would spin the InFlightChip pill forever.
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          type: 'about:blank',
          title: 'Unprocessable Entity',
          status: 422,
          detail: 'Failed to parse case file.',
        },
        422,
      ),
    );

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useLoadCase(), { wrapper: Wrapper });
    result.current.mutate({ sessionId: 'sess-422' as SessionId, request: { primary_path: 'bad.xlsx' } });

    await waitFor(() => expect(result.current.isError).toBe(true));

    const jobs = Object.values(useJobsStore.getState().jobs);
    // No record may remain in-flight — every record is terminal (here: the
    // single placeholder, marked failed in place).
    expect(jobs.every((j) => isTerminalStatus(j.status))).toBe(true);
    expect(jobs.some((j) => j.status === 'failed')).toBe(true);
  });

  it('failJob drives a stranded canonical running case-load record to failed (instant pill clear)', async () => {
    // Simulate the WS having registered the canonical ``srv-load`` record
    // (running) for this case-load before the HTTP 422 unwinds. The error
    // carries no job_id, so failJob must drive that stranded canonical record
    // to ``failed`` immediately — clearing the pill without a terminal WS event.
    useJobsStore.getState().upsertJob({
      job_id: 'srv-load',
      kind: 'case-load',
      status: 'running',
    });

    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        { type: 'about:blank', title: 'Unprocessable Entity', status: 422, detail: 'parse error' },
        422,
      ),
    );

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useLoadCase(), { wrapper: Wrapper });
    result.current.mutate({ sessionId: 'sess-x' as SessionId, request: { primary_path: 'bad.xlsx' } });

    await waitFor(() => expect(result.current.isError).toBe(true));

    const jobs = useJobsStore.getState().jobs;
    // The stranded canonical record is now terminal — the pill clears.
    expect(jobs['srv-load']!.status).toBe('failed');
    expect(Object.values(jobs).every((j) => isTerminalStatus(j.status))).toBe(true);
  });

  it('useTopology stays disabled when selection is null even with a sessionId', () => {
    useSessionStore.setState({ sessionId: parseSessionId('sess-gate') });
    useCaseStore.setState({ selection: null });
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useTopology(parseSessionId('sess-gate')), {
      wrapper: Wrapper,
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('useTopology fires once a case is loaded (selection set)', async () => {
    useSessionStore.setState({ sessionId: parseSessionId('sess-loaded') });
    useCaseStore.setState({
      selection: { primaryPath: 'ieee14.xlsx' as WorkspacePath, addfiles: [] },
    });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        state: 'pre-setup',
        buses: [],
        lines: [],
        transformers: [],
        generators: [],
        loads: [],
      }),
    );
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useTopology(parseSessionId('sess-loaded')), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('the landing-state list queries stay disabled when selection is null (no 409 noise)', () => {
    // useListSnapshots / useListPmus / useListProfiles must NOT fire on a
    // fresh session with no case loaded — each would 409 and spam the console.
    useSessionStore.setState({ sessionId: parseSessionId('sess-landing') });
    useCaseStore.setState({ selection: null });
    const { Wrapper } = makeWrapper();

    const snap = renderHook(() => useListSnapshots(), { wrapper: Wrapper });
    const pmus = renderHook(() => useListPmus(), { wrapper: Wrapper });
    const profiles = renderHook(() => useListProfiles(), { wrapper: Wrapper });

    expect(snap.result.current.fetchStatus).toBe('idle');
    expect(pmus.result.current.fetchStatus).toBe('idle');
    expect(profiles.result.current.fetchStatus).toBe('idle');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
