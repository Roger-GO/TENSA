/**
 * Reset run reloads the case and releases the active run, and leaves the runs
 * themselves alone: a finished run stays for the researcher to compare with the
 * next one, under its own name and number, until it is deleted from History.
 * Importing a bundle replaces the System the same way, so it treats the runs the
 * same.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { makeQueryClient, useImportBundle, useResetRun } from '@/api/queries';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import { useCaseStore } from '@/store/case';
import { useDisturbanceStore } from '@/store/disturbance';
import { useEditJournalStore } from '@/store/editJournal';
import { useJobsStore } from '@/store/jobs';
import { usePflowStore } from '@/store/pflow';
import { useRunsStore } from '@/store/runs';

const SESSION = parseSessionId('sess-1');

const TOPOLOGY = {
  state: 'pre-setup',
  buses: [],
  lines: [],
  transformers: [],
  generators: [],
  loads: [],
  shunts: [],
  controllers: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function wrapper() {
  const client = makeQueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/** Two finished runs, the second one active, with a name and a pin on the first. */
function seedFinishedRuns(): void {
  const runs = useRunsStore.getState();
  runs.startRun({ runId: 'r1', tf: 5, columnNames: ['Bus_1_v'], scenario: 'fault bus 7' });
  runs.appendFrame('r1', {
    t: new Float64Array([0, 0.1]),
    columns: { Bus_1_v: new Float64Array([1, 0.9]) },
  });
  runs.markRunDone('r1', 0.1, true);
  runs.startRun({ runId: 'r2', tf: 5, columnNames: ['Bus_1_v'] });
  runs.markRunDone('r2', 0.1, true);
  runs.setRunDisplayName('r1', 'Base case');
  runs.addOverlayRun('r1');
}

describe('Reset run keeps the runs', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    useRunsStore.getState().clearRuns();
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    });
    useEditJournalStore.getState().reset();
    useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
    useDisturbanceStore.setState({ committed: true, dirty: false });
    fetchSpy = vi
      .spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch')
      .mockImplementation(async () => jsonResponse(TOPOLOGY)) as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    useRunsStore.getState().clearRuns();
    useCaseStore.setState({ selection: null });
    useEditJournalStore.getState().reset();
    useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
    useDisturbanceStore.setState({ committed: false, dirty: false });
  });

  it('releases the active run and leaves every run, name, pin and number in place', async () => {
    seedFinishedRuns();
    expect(useRunsStore.getState().activeRunId).toBe('r2');
    const { result } = renderHook(() => useResetRun(), { wrapper: wrapper() });

    await act(async () => {
      await result.current.mutateAsync(SESSION);
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));

    const { runs, activeRunId, overlayRunIds, runCount } = useRunsStore.getState();
    expect(activeRunId).toBeNull();
    expect(Object.keys(runs)).toEqual(['r1', 'r2']);
    expect(runs.r1?.displayName).toBe('Base case');
    expect(runs.r1?.ordinal).toBe(1);
    expect(runs.r1?.seqCount).toBe(2);
    expect(runs.r2?.state).toBe('done');
    expect([...overlayRunIds]).toEqual(['r1']);
    expect(runCount).toBe(2);
  });

  it('still reloads: the System is fresh, the PF result is gone and the faults can be re-committed', async () => {
    seedFinishedRuns();
    usePflowStore.setState({
      lastRun: {
        converged: true,
        iterations: 3,
        mismatch: 0,
        bus_voltages: { '1': 1 },
        bus_angles: { '1': 0 },
      } as never,
    });
    const { result } = renderHook(() => useResetRun(), { wrapper: wrapper() });

    await act(async () => {
      await result.current.mutateAsync(SESSION);
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/sessions/sess-1/reload');
    expect(usePflowStore.getState().lastRun).toBeNull();
    expect(useDisturbanceStore.getState().committed).toBe(false);
  });

  it('numbers the next run after the ones it kept', async () => {
    seedFinishedRuns();
    const { result } = renderHook(() => useResetRun(), { wrapper: wrapper() });
    await act(async () => {
      await result.current.mutateAsync(SESSION);
    });

    useRunsStore.getState().startRun({ runId: 'r3', tf: 5, columnNames: ['Bus_1_v'] });

    const { runs, activeRunId } = useRunsStore.getState();
    expect(activeRunId).toBe('r3');
    expect(runs.r3?.ordinal).toBe(3);
    expect(Object.keys(runs)).toEqual(['r1', 'r2', 'r3']);
  });

  it('does nothing to the runs when the reload fails', async () => {
    seedFinishedRuns();
    fetchSpy.mockImplementation(async () =>
      jsonResponse({ title: 'Conflict', status: 409, detail: 'session is busy' }, 409),
    );
    const { result } = renderHook(() => useResetRun(), { wrapper: wrapper() });

    await act(async () => {
      await result.current.mutateAsync(SESSION).catch(() => undefined);
    });

    // The reload did not happen, so the System still holds the run.
    expect(useRunsStore.getState().activeRunId).toBe('r2');
    expect(Object.keys(useRunsStore.getState().runs)).toEqual(['r1', 'r2']);
  });
});

describe('Bundle import keeps the runs too', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    useRunsStore.getState().clearRuns();
    useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
    useEditJournalStore.getState().reset();
    fetchSpy = vi
      .spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch')
      .mockImplementation(async () =>
        jsonResponse({ status: 'committed', warnings: [], conflicts: [] }),
      ) as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    useRunsStore.getState().clearRuns();
    useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
    useEditJournalStore.getState().reset();
  });

  it('releases the active run but leaves the runs once the import commits', async () => {
    seedFinishedRuns();
    const { result } = renderHook(() => useImportBundle(), { wrapper: wrapper() });

    await act(async () => {
      await result.current.mutateAsync({
        sessionId: SESSION,
        file: new File(['zip'], 'bundle.zip', { type: 'application/zip' }),
      });
    });

    const { runs, activeRunId } = useRunsStore.getState();
    expect(activeRunId).toBeNull();
    expect(Object.keys(runs)).toEqual(['r1', 'r2']);
    expect(runs.r1?.displayName).toBe('Base case');
  });
});
