/**
 * `useEditElements`: several edits that are one change to the user, as a
 * generating unit moved to another bus is. They are sent in order, the
 * topology is read again once, a change that is refused part way is taken
 * back, and the edit journal lists every request that was answered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { makeQueryClient, queryKeys, useEditElements } from '@/api/queries';
import type { EditElementsVars } from '@/api/queries';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import { useCaseStore } from '@/store/case';
import { useEditJournalStore } from '@/store/editJournal';
import { useJobsStore } from '@/store/jobs';

const SESSION = parseSessionId('sess-1');

const MOVE: EditElementsVars = {
  sessionId: SESSION,
  edits: [
    { model: 'PV', idx: '2', params: { bus: 5 } },
    { model: 'GENROU', idx: 'GENROU 2', params: { bus: 5, Vn: 138 } },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const refused = (detail: string) =>
  jsonResponse({ type: 'about:blank', title: 'Unprocessable', status: 422, detail }, 422);

function journalOps(): unknown[] {
  return useEditJournalStore.getState().entries.map(({ rev: _rev, ...op }) => op);
}

describe('useEditElements', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let client: QueryClient;

  /** Run the change and answer how it ended. */
  async function run(vars: EditElementsVars): Promise<{ made: unknown; error: Error | null }> {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useEditElements(), { wrapper });
    let made: unknown = null;
    let error: Error | null = null;
    await act(async () => {
      await result.current.mutateAsync(vars).then(
        (entries) => (made = entries),
        (err: Error) => (error = err),
      );
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));
    return { made, error };
  }

  /** What was sent, as `METHOD path body`. */
  const sent = (): string[] =>
    (fetchSpy.mock.calls as [unknown, RequestInit | undefined][]).map(
      ([url, init]) => `${init?.method} ${String(url)} ${String(init?.body ?? '')}`,
    );

  beforeEach(() => {
    client = makeQueryClient();
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    });
    useEditJournalStore.getState().reset();
    useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
      typeof vi.spyOn
    >;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    useCaseStore.setState({ selection: null });
    useEditJournalStore.getState().reset();
    useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
  });

  it('sends the edits one after the other, and reads the topology again once at the end', async () => {
    fetchSpy.mockImplementation(async (url: unknown) =>
      jsonResponse({ idx: String(url).endsWith('/PV/2') ? 2 : 'GENROU 2', name: 'x', kind: 'x' }),
    );
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    const { made, error } = await run(MOVE);

    expect(error).toBeNull();
    expect(made).toHaveLength(2);
    expect(sent()).toEqual([
      'PUT /api/sessions/sess-1/elements/PV/2 {"params":{"bus":5}}',
      'PUT /api/sessions/sess-1/elements/GENROU/GENROU%202 {"params":{"bus":5,"Vn":138}}',
    ]);
    expect(journalOps()).toEqual([
      { op: 'edit', model: 'PV', idx: '2', params: { bus: 5 } },
      { op: 'edit', model: 'GENROU', idx: 'GENROU 2', params: { bus: 5, Vn: 138 } },
    ]);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.topology(SESSION) });
  });

  it('takes back the edits it made when a later one is refused, so the change is whole or not made', async () => {
    fetchSpy.mockImplementation(async (url: unknown, init: unknown) => {
      if ((init as RequestInit).method === 'PUT' && String(url).includes('/GENROU/')) {
        return refused('GENROU cannot be on bus 5');
      }
      return jsonResponse({ idx: 2, name: '2', kind: 'PV' });
    });
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    const { made, error } = await run(MOVE);

    expect(made).toBeNull();
    // What the server said of the edit it refused.
    expect(error).toMatchObject({ status: 422, detail: 'GENROU cannot be on bus 5' });
    expect(sent().map((line) => line.split(' ').slice(0, 2).join(' '))).toEqual([
      'PUT /api/sessions/sess-1/elements/PV/2',
      'PUT /api/sessions/sess-1/elements/GENROU/GENROU%202',
      'POST /api/sessions/sess-1/undo-last-edit',
    ]);
    // The journal lists what the server was asked and did: a replay gives the same system.
    expect(journalOps()).toEqual([
      { op: 'edit', model: 'PV', idx: '2', params: { bus: 5 } },
      { op: 'undo' },
    ]);
    // The system is read again all the same.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.topology(SESSION) });
  });

  it('sends nothing more, and takes nothing back, when the first edit is refused', async () => {
    fetchSpy.mockImplementation(async () => refused('no such bus'));

    const { error } = await run(MOVE);

    expect(error).toMatchObject({ status: 422 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(journalOps()).toEqual([]);
  });

  it('says how many edits stand when they cannot be taken back either', async () => {
    fetchSpy.mockImplementation(async (url: unknown, init: unknown) => {
      if ((init as RequestInit).method === 'POST') return refused('a run has set the system up');
      if (String(url).includes('/GENROU/')) return refused('GENROU cannot be on bus 5');
      return jsonResponse({ idx: 2, name: '2', kind: 'PV' });
    });

    const { error } = await run(MOVE);

    expect(error?.message).toMatch(/GENROU cannot be on bus 5/);
    expect(error?.message).toMatch(
      /1 of the 2 edits it takes were made before that and could not be taken back: Undo in the Edit menu takes them back\.$/,
    );
    expect(journalOps()).toEqual([{ op: 'edit', model: 'PV', idx: '2', params: { bus: 5 } }]);
  });
});
