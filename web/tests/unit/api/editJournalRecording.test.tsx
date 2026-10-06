/**
 * The mutation hooks feed the edit journal: a successful edit is recorded in the
 * terms of its request, a failed one is not, and the saves and the operations the
 * journal cannot replay change its state accordingly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  makeQueryClient,
  queryKeys,
  useAddElement,
  useAddPmu,
  useAddProfile,
  useCloneEdit,
  useCloneRedo,
  useCloneReset,
  useCloneSaveAs,
  useCloneUndo,
  useDeleteElement,
  useEditElement,
  useInitClone,
  useRedoEdit,
  useReloadCase,
  useResetRun,
  useRestoreSnapshot,
  useSaveCase,
  useUndoLastEdit,
} from '@/api/queries';
import { parseSessionId } from '@/api/types';
import { useCaseStore } from '@/store/case';
import { useDisturbanceStore } from '@/store/disturbance';
import { hasUnsavedEdits, useEditJournalStore } from '@/store/editJournal';
import { useJobsStore } from '@/store/jobs';
import { parseWorkspacePath } from '@/api/types';

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
const CLONE_EDIT = {
  model: 'EXST1',
  idx: '1',
  param: 'KA',
  new_value: 50,
  undo_depth: 1,
  redo_depth: 0,
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

/** Run one mutation to completion and wait for it to settle either way. */
async function run<TVars>(
  useHook: () => UseMutationResult<unknown, Error, TVars>,
  vars: TVars,
): Promise<void> {
  const { result } = renderHook(() => useHook(), { wrapper: wrapper() });
  await act(async () => {
    await result.current.mutateAsync(vars).catch(() => undefined);
  });
  await waitFor(() => expect(result.current.isPending).toBe(false));
}

function journalOps(): unknown[] {
  return useEditJournalStore.getState().entries.map(({ rev: _rev, ...op }) => op);
}

describe('edit journal recording', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    });
    useEditJournalStore.getState().reset();
    useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
    fetchSpy = vi
      .spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch')
      .mockImplementation(async () => jsonResponse({})) as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    useCaseStore.setState({ selection: null });
    useEditJournalStore.getState().reset();
    useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
  });

  it('records an element add with the params that were sent', async () => {
    fetchSpy.mockImplementation(async () =>
      jsonResponse({ element: { idx: '15', name: 'Bus 15', kind: 'Bus' }, job_id: 'j1' }, 201),
    );

    await run(useAddElement, {
      sessionId: SESSION,
      body: { model: 'Bus', params: { idx: 15, Vn: 110 } },
    });

    expect(journalOps()).toEqual([{ op: 'add', model: 'Bus', params: { idx: 15, Vn: 110 } }]);
  });

  it('records an element edit', async () => {
    fetchSpy.mockImplementation(async () => jsonResponse({ idx: '1', name: 'Bus 1', kind: 'Bus' }));

    await run(useEditElement, { sessionId: SESSION, model: 'Bus', idx: '1', params: { Vn: 230 } });

    expect(journalOps()).toEqual([{ op: 'edit', model: 'Bus', idx: '1', params: { Vn: 230 } }]);
  });

  it('records an element delete, an undo, a redo, and a reload', async () => {
    fetchSpy.mockImplementation(async () => jsonResponse(TOPOLOGY));

    await run(useDeleteElement, { sessionId: SESSION, model: 'Bus', idx: '9' });
    await run(useUndoLastEdit, SESSION);
    await run(useRedoEdit, SESSION);
    await run(useDeleteElement, { sessionId: SESSION, model: 'Bus', idx: '3', cascade: true });

    expect(journalOps()).toEqual([
      { op: 'delete', model: 'Bus', idx: '9' },
      { op: 'undo' },
      { op: 'redo' },
      { op: 'delete', model: 'Bus', idx: '3', cascade: true },
    ]);
    const sent = (fetchSpy.mock.calls as [unknown, RequestInit | undefined][]).map(
      ([url, init]) => `${init?.method} ${String(url)}`,
    );
    expect(sent).toEqual([
      'DELETE /api/sessions/sess-1/elements/Bus/9',
      'POST /api/sessions/sess-1/undo-last-edit',
      'POST /api/sessions/sess-1/redo-edit',
      'DELETE /api/sessions/sess-1/elements/Bus/3?cascade=true',
    ]);

    await run(useReloadCase, SESSION);
    // A reload on a file-backed case reverts the adds and deletes before it.
    expect(journalOps()).toEqual([]);
  });

  it('keeps what a delete removed out of the topology it stores', async () => {
    const deleted = [
      { idx: 'L1', name: 'L1', kind: 'Line' },
      { idx: 3, name: 'B3', kind: 'Bus' },
    ];
    fetchSpy.mockImplementation(async () =>
      jsonResponse({ ...TOPOLOGY, deleted, disturbances: [], undo: null }),
    );

    await run(useDeleteElement, { sessionId: SESSION, model: 'Bus', idx: '3', cascade: true });

    const stored = useCaseStore.getState().topology;
    expect(stored).toMatchObject({ state: 'pre-setup', buses: [] });
    expect(stored).not.toHaveProperty('deleted');
    expect(stored).not.toHaveProperty('disturbances');
  });

  it('takes the timeline disturbances on a deleted element off, and an undo and a redo follow', async () => {
    const timeline = useDisturbanceStore.getState();
    timeline.clearDisturbances();
    const elsewhere = timeline.addDisturbance({
      kind: 'fault',
      bus_idx: '5',
      tf: 1,
      tc: 1.1,
      xf: 0.05,
      rf: 0,
    });
    const onTheBus = timeline.addDisturbance({
      kind: 'fault',
      bus_idx: '3',
      tf: 2,
      tc: 2.1,
      xf: 0.05,
      rf: 0,
    });
    const onItsLine = timeline.addDisturbance({
      kind: 'toggle',
      model: 'Line',
      dev_idx: 'L1',
      t: 3,
    });
    useDisturbanceStore.getState().markCommitted();
    const list = () => useDisturbanceStore.getState().disturbances;
    const step = { op: 'delete', model: 'Bus', idx: 3, params: [], also: 1 };

    // The delete took the line with the bus: what acted on either goes.
    fetchSpy.mockImplementation(async () =>
      jsonResponse({
        ...TOPOLOGY,
        deleted: [
          { idx: 'L1', name: 'L1', kind: 'Line' },
          { idx: 3, name: 'B3', kind: 'Bus' },
        ],
        undo: step,
      }),
    );
    await run(useDeleteElement, { sessionId: SESSION, model: 'Bus', idx: '3', cascade: true });
    expect(list()).toEqual([elsewhere]);
    // The list is no longer what was committed.
    expect(useDisturbanceStore.getState().committed).toBe(false);

    // The undo's topology names the delete as what can now be redone.
    fetchSpy.mockImplementation(async () => jsonResponse({ ...TOPOLOGY, redo: step }));
    await run(useUndoLastEdit, SESSION);
    expect(list()).toEqual([elsewhere, onTheBus, onItsLine]);

    fetchSpy.mockImplementation(async () => jsonResponse({ ...TOPOLOGY, undo: step }));
    await run(useRedoEdit, SESSION);
    expect(list()).toEqual([elsewhere]);

    // An undo of something else leaves the timeline alone.
    fetchSpy.mockImplementation(async () =>
      jsonResponse({ ...TOPOLOGY, redo: { op: 'add', model: 'Bus', idx: 9, params: [], also: 0 } }),
    );
    await run(useUndoLastEdit, SESSION);
    expect(list()).toEqual([elsewhere]);
    useDisturbanceStore.getState().clearDisturbances();
  });

  it('a redone delete takes the timeline disturbances put on what it takes since the undo', async () => {
    // The substrate hears of a timeline disturbance only when it is committed,
    // so it redoes the delete; committed later, these two would name a line
    // and a bus that are gone.
    const timeline = useDisturbanceStore.getState();
    timeline.clearDisturbances();
    const elsewhere = timeline.addDisturbance({
      kind: 'fault',
      bus_idx: '5',
      tf: 1,
      tc: 1.1,
      xf: 0.05,
      rf: 0,
    });
    const onItsLine = timeline.addDisturbance({
      kind: 'toggle',
      model: 'Line',
      dev_idx: 'L1',
      t: 3,
    });
    const onTheBus = timeline.addDisturbance({
      kind: 'fault',
      bus_idx: '3',
      tf: 2,
      tc: 2.1,
      xf: 0.05,
      rf: 0,
    });
    const list = () => useDisturbanceStore.getState().disturbances;
    const step = { op: 'delete', model: 'Bus', idx: 3, params: [], also: 1 };
    const bus5 = { idx: 5, name: 'B5', kind: 'Bus' };
    // The topology as the undo left it: the bus and the line on it are back.
    const client = makeQueryClient();
    client.setQueryData(queryKeys.topology(SESSION), {
      ...TOPOLOGY,
      buses: [{ idx: 3, name: 'B3', kind: 'Bus' }, bus5],
      lines: [{ idx: 'L1', name: 'L1', kind: 'Line' }],
      redo: step,
    });
    fetchSpy.mockImplementation(async () =>
      jsonResponse({ ...TOPOLOGY, buses: [bus5], undo: step }),
    );

    const redo = renderHook(() => useRedoEdit(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    await act(async () => {
      await redo.result.current.mutateAsync(SESSION);
    });

    expect(list()).toEqual([elsewhere]);
    expect(useDisturbanceStore.getState().committed).toBe(false);

    // They went with the element, so an undo brings them back with it.
    fetchSpy.mockImplementation(async () => jsonResponse({ ...TOPOLOGY, redo: step }));
    await run(useUndoLastEdit, SESSION);
    expect(list()).toEqual([elsewhere, onItsLine, onTheBus]);
    useDisturbanceStore.getState().clearDisturbances();
  });

  it('records the Reset run reload the same way as a reload', async () => {
    fetchSpy.mockImplementation(async () => jsonResponse(TOPOLOGY));
    useEditJournalStore.getState().record({ op: 'clone-init' });

    await run(useResetRun, SESSION);

    expect(journalOps()).toEqual([{ op: 'clone-init' }, { op: 'reload' }]);
  });

  it('records the clone operations', async () => {
    fetchSpy.mockImplementation(async (input) =>
      String(input).endsWith('/case/clone')
        ? jsonResponse({ clone_dir: '/x', clone_files: [], already_initialized: false })
        : jsonResponse(CLONE_EDIT),
    );

    await run(useInitClone, SESSION);
    await run(useCloneEdit, {
      sessionId: SESSION,
      model: 'EXST1',
      idx: '1',
      param: 'KA',
      value: 50,
    });
    await run(useCloneUndo, SESSION);
    await run(useCloneRedo, SESSION);

    expect(journalOps()).toEqual([
      { op: 'clone-init' },
      { op: 'clone-edit', model: 'EXST1', idx: '1', param: 'KA', value: 50 },
      { op: 'clone-undo' },
      { op: 'clone-redo' },
    ]);

    fetchSpy.mockImplementation(async () => jsonResponse({ reset: true }));
    await run(useCloneReset, SESSION);
    // Resetting the clone on a file-backed case leaves a pristine case.
    expect(journalOps()).toEqual([]);
  });

  it('records nothing for an edit the substrate refused', async () => {
    fetchSpy.mockImplementation(async () =>
      jsonResponse({ type: 'about:blank', title: 'Unprocessable', status: 422, detail: 'no' }, 422),
    );

    await run(useAddElement, { sessionId: SESSION, body: { model: 'Bus', params: { idx: 1 } } });
    await run(useEditElement, { sessionId: SESSION, model: 'Bus', idx: '1', params: { Vn: 1 } });
    await run(useDeleteElement, { sessionId: SESSION, model: 'Bus', idx: '1' });
    await run(useCloneEdit, {
      sessionId: SESSION,
      model: 'EXST1',
      idx: '1',
      param: 'KA',
      value: 1,
    });

    expect(journalOps()).toEqual([]);
    expect(hasUnsavedEdits()).toBe(false);
  });

  it('counts the work as saved once the system or the clone is written out', async () => {
    useEditJournalStore.getState().record({
      op: 'add',
      model: 'Bus',
      params: { idx: 1 },
    });
    expect(hasUnsavedEdits()).toBe(true);

    fetchSpy.mockImplementation(async () =>
      jsonResponse({ filename: 'x.xlsx', bytes_written: 10, job_id: 'j' }, 201),
    );
    await run(useSaveCase, {
      sessionId: SESSION,
      body: { filename: 'x.xlsx', format: 'xlsx' as const, overwrite: false },
    });
    expect(hasUnsavedEdits()).toBe(false);

    useEditJournalStore.getState().record({ op: 'edit', model: 'Bus', idx: '1', params: { a: 1 } });
    expect(hasUnsavedEdits()).toBe(true);

    fetchSpy.mockImplementation(async () =>
      jsonResponse({ name: 'mine', files: [], job_id: 'j' }, 201),
    );
    await run(useCloneSaveAs, { sessionId: SESSION, name: 'mine' });
    expect(hasUnsavedEdits()).toBe(false);
  });

  it.each([
    ['a PMU placement', useAddPmu, { sessionId: SESSION, body: { bus_idx: '1' } }],
    [
      'a profile placement',
      useAddProfile,
      {
        sessionId: SESSION,
        body: {
          model: 'PQ',
          dev: '1',
          path: 'p.csv',
          mode: 1,
          sheet: null,
          tkey: 'Time',
          fields: 'p0',
        },
      },
    ],
  ] as const)('marks the journal as not replayable after %s', async (_label, hook, vars) => {
    fetchSpy.mockImplementation(async () =>
      jsonResponse({ idx: 'PMU_1', name: 'PMU 1', kind: 'PMU' }),
    );

    await run(hook as () => UseMutationResult<unknown, Error, unknown>, vars);

    expect(useEditJournalStore.getState().replayable).toBe(false);
    expect(hasUnsavedEdits()).toBe(true);
  });

  it('marks the journal as not replayable after a snapshot restore, with nothing unsaved', async () => {
    useEditJournalStore.getState().record({ op: 'add', model: 'Bus', params: { idx: 1 } });
    fetchSpy.mockImplementation(async () => jsonResponse({ name: 's', metadata: {}, job_id: 'j' }));

    await run(useRestoreSnapshot, { sessionId: SESSION, name: 's' });

    const state = useEditJournalStore.getState();
    expect(state.replayable).toBe(false);
    expect(state.entries).toEqual([]);
    expect(hasUnsavedEdits()).toBe(false);
  });
});
