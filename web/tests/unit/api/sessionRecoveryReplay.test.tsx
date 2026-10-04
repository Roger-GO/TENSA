/**
 * Session recovery rebuilds the user's edits from the edit journal.
 *
 * Recovery used to re-load the case file into the replacement session and stop
 * there: elements added to a loaded case, parameters edited, and a system built from
 * scratch were gone. With a replayable journal it now replays every recorded edit
 * after the load (or after recreating the blank system), tells the user, and cuts
 * the journal back when the substrate refuses one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  makeQueryClient,
  __resetRecoveryDebounceForTests,
  useSaveCase,
  useTopology,
} from '@/api/queries';
import { useSessionRecovery } from '@/api/useSessionRecovery';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { hasUnsavedEdits, useEditJournalStore } from '@/store/editJournal';
import type { JournalOp } from '@/store/editJournal';
import { toast } from '@/lib/toast';

const FILE_CASE = { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] };
const BLANK_CASE = { primaryPath: null, addfiles: [], blank: true };
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

function problem(status: number, detail: string): Response {
  return jsonResponse({ type: 'about:blank', title: 'Refused', status, detail }, status);
}

function record(...ops: JournalOp[]): void {
  for (const op of ops) useEditJournalStore.getState().record(op);
}

describe('useSessionRecovery rebuilds edits from the journal', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let calls: string[];
  let bodies: Record<string, unknown>;
  /** Overrides for one `METHOD path`; anything else is answered by `defaultAnswer`. */
  let answers: Record<string, () => Response>;
  let successSpy: MockInstance<typeof toast.success>;
  let warningSpy: MockInstance<typeof toast.warning>;
  let errorSpy: MockInstance<typeof toast.error>;
  let infoSpy: MockInstance<typeof toast.info>;

  function defaultAnswer(key: string): Response {
    if (key === 'POST /api/sessions') {
      return jsonResponse({ session_id: 'sess-new', state: 'live' }, 201);
    }
    if (key.endsWith('/blank')) return jsonResponse({ topology: TOPOLOGY }, 201);
    if (key.endsWith('/case')) return jsonResponse(TOPOLOGY);
    if (key.includes('/case/clone/params/')) {
      return jsonResponse({
        model: 'EXST1',
        idx: '1',
        param: 'KA',
        new_value: 50,
        undo_depth: 2,
        redo_depth: 0,
      });
    }
    if (key.endsWith('/case/clone')) {
      return jsonResponse({ clone_dir: '/x', clone_files: [], already_initialized: false });
    }
    return jsonResponse({});
  }

  beforeEach(() => {
    __resetRecoveryDebounceForTests();
    calls = [];
    bodies = {};
    answers = {};
    useSessionStore.setState({
      sessionId: parseSessionId('sess-old'),
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
    });
    fetchSpy = vi
      .spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch')
      .mockImplementation(async (input, init) => {
        const key = `${init?.method ?? 'GET'} ${String(input)}`;
        calls.push(key);
        if (typeof init?.body === 'string') bodies[key] = JSON.parse(init.body);
        return (answers[key] ?? (() => defaultAnswer(key)))();
      }) as ReturnType<typeof vi.spyOn>;
    successSpy = vi.spyOn(toast, 'success');
    warningSpy = vi.spyOn(toast, 'warning');
    errorSpy = vi.spyOn(toast, 'error');
    infoSpy = vi.spyOn(toast, 'info');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    successSpy.mockRestore();
    warningSpy.mockRestore();
    errorSpy.mockRestore();
    infoSpy.mockRestore();
    __resetRecoveryDebounceForTests();
    useSessionStore.setState({
      sessionId: null,
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
    });
    useCaseStore.setState({
      selection: null,
      cloneInitialized: false,
      cloneUndoDepth: 0,
      cloneRedoDepth: 0,
    });
    useEditJournalStore.getState().reset();
  });

  function recover(): void {
    const client = makeQueryClient();
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    renderHook(() => useSessionRecovery(), { wrapper: Wrapper });
    useSessionStore.getState().resetSession();
  }

  async function recovered(): Promise<void> {
    await waitFor(() => {
      expect(useSessionStore.getState().sessionId).toBe('sess-new');
      expect(useSessionStore.getState().recoveryInProgress).toBe(false);
    });
  }

  it('recreates a blank system and replays the build into it, in order', async () => {
    useCaseStore.setState({ selection: BLANK_CASE });
    record(
      { op: 'add', model: 'Bus', params: { idx: 1, Vn: 110 } },
      { op: 'add', model: 'Bus', params: { idx: 2, Vn: 110 } },
      { op: 'add', model: 'Line', params: { bus1: 1, bus2: 2, r: 0.01, x: 0.1 } },
      { op: 'edit', model: 'Bus', idx: '1', params: { Vn: 230 } },
    );

    recover();
    await recovered();

    expect(calls).toEqual([
      'POST /api/sessions',
      'POST /api/sessions/sess-new/blank',
      'POST /api/sessions/sess-new/elements',
      'POST /api/sessions/sess-new/elements',
      'POST /api/sessions/sess-new/elements',
      'PUT /api/sessions/sess-new/elements/Bus/1',
    ]);
    expect(successSpy).toHaveBeenCalledWith(
      'Edits restored',
      expect.objectContaining({ description: expect.stringContaining('4 changes') }),
    );
    expect(errorSpy).not.toHaveBeenCalled();
    // The journal still describes the session, so a second loss is recoverable too.
    expect(useEditJournalStore.getState().entries).toHaveLength(4);
    expect(useCaseStore.getState().selection).toBe(BLANK_CASE);
  });

  it('recreates an empty blank system without a word', async () => {
    useCaseStore.setState({ selection: BLANK_CASE });

    recover();
    await recovered();

    expect(calls).toEqual(['POST /api/sessions', 'POST /api/sessions/sess-new/blank']);
    expect(successSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('still says a blank system is lost when the journal cannot rebuild it', async () => {
    useCaseStore.setState({ selection: BLANK_CASE });
    record({ op: 'add', model: 'Bus', params: { idx: 1 } });
    useEditJournalStore.getState().markOpaque();

    recover();
    await recovered();

    expect(calls).toEqual(['POST /api/sessions']);
    expect(errorSpy).toHaveBeenCalledWith('Session expired — blank system lost', expect.anything());
    expect(useEditJournalStore.getState().replayable).toBe(true);
  });

  it('says a blank system is lost when the substrate will not recreate it', async () => {
    useCaseStore.setState({ selection: BLANK_CASE });
    record({ op: 'add', model: 'Bus', params: { idx: 1 } });
    answers['POST /api/sessions/sess-new/blank'] = () => problem(409, 'already loaded');

    recover();
    await recovered();

    expect(calls).toEqual(['POST /api/sessions', 'POST /api/sessions/sess-new/blank']);
    expect(errorSpy).toHaveBeenCalledWith('Session expired — blank system lost', expect.anything());
    expect(useEditJournalStore.getState().entries).toEqual([]);
  });

  it('replays the edits made to a loaded case after reloading the file', async () => {
    useCaseStore.setState({ selection: FILE_CASE });
    record(
      { op: 'add', model: 'Bus', params: { idx: 15, Vn: 110 } },
      { op: 'edit', model: 'Bus', idx: '15', params: { Vn: 230 } },
    );

    recover();
    await recovered();

    expect(calls).toEqual([
      'POST /api/sessions',
      'POST /api/sessions/sess-new/case',
      'POST /api/sessions/sess-new/elements',
      'PUT /api/sessions/sess-new/elements/Bus/15',
    ]);
    expect(bodies['POST /api/sessions/sess-new/case']).toEqual({
      primary_path: 'ieee14.raw',
      addfiles: null,
    });
    expect(successSpy).toHaveBeenCalledWith(
      'Edits restored',
      expect.objectContaining({ description: expect.stringContaining('2 changes') }),
    );
    expect(infoSpy).not.toHaveBeenCalled();
    expect(useEditJournalStore.getState().entries).toHaveLength(2);
    expect(hasUnsavedEdits()).toBe(true);
  });

  it('replays only what came after a save over the case file, which already holds the rest', async () => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.xlsx'), addfiles: [] },
    });
    record({ op: 'add', model: 'Bus', params: { idx: 15, Vn: 110 } });
    // Save, through the mutation the Save command and Save system as both use.
    const client = makeQueryClient();
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const saver = renderHook(() => useSaveCase(), { wrapper: Wrapper });
    await act(async () => {
      await saver.result.current.mutateAsync({
        sessionId: parseSessionId('sess-old'),
        body: { filename: 'ieee14.xlsx', format: 'xlsx', overwrite: true },
      });
    });
    saver.unmount();
    record({ op: 'add', model: 'Bus', params: { idx: 16, Vn: 110 } });
    calls.length = 0;

    recover();
    await recovered();

    expect(calls).toEqual([
      'POST /api/sessions',
      'POST /api/sessions/sess-new/case',
      'POST /api/sessions/sess-new/elements',
    ]);
    expect(bodies['POST /api/sessions/sess-new/elements']).toEqual({
      model: 'Bus',
      params: { idx: 16, Vn: 110 },
    });
    expect(successSpy).toHaveBeenCalledWith(
      'Edits restored',
      expect.objectContaining({ description: expect.stringContaining('1 change ') }),
    );
  });

  it('replays everything after a save under another name, which leaves the open file as it was', async () => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.xlsx'), addfiles: [] },
    });
    record({ op: 'add', model: 'Bus', params: { idx: 15, Vn: 110 } });
    const client = makeQueryClient();
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const saver = renderHook(() => useSaveCase(), { wrapper: Wrapper });
    await act(async () => {
      await saver.result.current.mutateAsync({
        sessionId: parseSessionId('sess-old'),
        body: { filename: 'backup.xlsx', format: 'xlsx', overwrite: false },
      });
    });
    saver.unmount();
    calls.length = 0;

    recover();
    await recovered();

    expect(calls.filter((c) => c.endsWith('/elements'))).toHaveLength(1);
  });

  it('brings the clone-on-write edits back and sets the stack depths from the replay', async () => {
    useCaseStore.setState({
      selection: FILE_CASE,
      cloneInitialized: true,
      cloneUndoDepth: 2,
      cloneRedoDepth: 0,
    });
    record(
      { op: 'clone-init' },
      { op: 'clone-edit', model: 'EXST1', idx: '1', param: 'KA', value: 40 },
      { op: 'clone-edit', model: 'EXST1', idx: '1', param: 'KA', value: 50 },
    );

    recover();
    await recovered();

    expect(calls).toEqual([
      'POST /api/sessions',
      'POST /api/sessions/sess-new/case',
      'POST /api/sessions/sess-new/case/clone',
      'PUT /api/sessions/sess-new/case/clone/params/EXST1/1/KA',
      'PUT /api/sessions/sess-new/case/clone/params/EXST1/1/KA',
    ]);
    const state = useCaseStore.getState();
    expect(state.cloneInitialized).toBe(true);
    expect(state.cloneUndoDepth).toBe(2);
    expect(state.cloneRedoDepth).toBe(0);
    expect(infoSpy).not.toHaveBeenCalledWith('Unsaved edits lost', expect.anything());
  });

  it('says nothing about a replay that held no edits of the user, only bookkeeping', async () => {
    useCaseStore.setState({ selection: FILE_CASE, cloneInitialized: true });
    record({ op: 'clone-init' });

    recover();
    await recovered();

    expect(calls).toContain('POST /api/sessions/sess-new/case/clone');
    expect(successSpy).not.toHaveBeenCalled();
    expect(warningSpy).not.toHaveBeenCalled();
    expect(useCaseStore.getState().cloneInitialized).toBe(true);
  });

  it('stops at an edit the substrate refuses, says how many came back, and cuts the journal', async () => {
    useCaseStore.setState({ selection: FILE_CASE });
    record(
      { op: 'add', model: 'Bus', params: { idx: 15 } },
      { op: 'add', model: 'Bus', params: { idx: 16 } },
      { op: 'edit', model: 'Bus', idx: '16', params: { nope: 1 } },
      { op: 'add', model: 'Bus', params: { idx: 17 } },
    );
    answers['PUT /api/sessions/sess-new/elements/Bus/16'] = () => problem(422, 'bad param nope');

    recover();
    await recovered();

    // The add after the refused edit was never sent.
    expect(calls.filter((c) => c.endsWith('/elements'))).toHaveLength(2);
    expect(warningSpy).toHaveBeenCalledWith(
      'Some edits could not be restored',
      expect.objectContaining({
        description: expect.stringMatching(/Restored 2 of 4 changes.*bad param nope/),
      }),
    );
    expect(successSpy).not.toHaveBeenCalled();
    expect(useEditJournalStore.getState().entries.map((e) => e.op)).toEqual(['add', 'add']);
  });

  it('falls back to reloading the file, and says what was lost, when the journal cannot replay', async () => {
    useCaseStore.setState({ selection: FILE_CASE });
    record({ op: 'add', model: 'Bus', params: { idx: 15 } });
    useEditJournalStore.getState().markOpaque();

    recover();
    await recovered();

    expect(calls).toEqual(['POST /api/sessions', 'POST /api/sessions/sess-new/case']);
    expect(infoSpy).toHaveBeenCalledWith('Unsaved edits lost', expect.anything());
    // Nothing is left to lose, so the journal starts over (and can replay again).
    expect(useEditJournalStore.getState().replayable).toBe(true);
    expect(hasUnsavedEdits()).toBe(false);
  });

  it('does not pretend to restore anything when the case itself will not reload', async () => {
    useCaseStore.setState({ selection: FILE_CASE });
    record({ op: 'add', model: 'Bus', params: { idx: 15 } });
    answers['POST /api/sessions/sess-new/case'] = () => problem(422, 'parse error');

    recover();
    await recovered();

    expect(calls).toEqual(['POST /api/sessions', 'POST /api/sessions/sess-new/case']);
    expect(successSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith('Unsaved edits lost', expect.anything());
    expect(useEditJournalStore.getState().entries).toEqual([]);
  });

  it('keeps the case queries off the replacement session until recovery ends, so they cannot hold it', async () => {
    useCaseStore.setState({ selection: FILE_CASE });
    // A topology read that reaches a session mid-recovery would hold it, and the
    // recovery's own load is then refused as busy.
    let topologyReads = 0;
    answers['GET /api/sessions/sess-new/topology'] = () => {
      topologyReads += 1;
      return jsonResponse(TOPOLOGY);
    };
    let readsBeforeLoadSettled = -1;
    answers['POST /api/sessions/sess-new/case'] = () => {
      readsBeforeLoadSettled = topologyReads;
      return jsonResponse(TOPOLOGY);
    };

    const client = makeQueryClient();
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    renderHook(
      () => {
        useSessionRecovery();
        useTopology(useSessionStore((s) => s.sessionId));
      },
      { wrapper: Wrapper },
    );
    useSessionStore.getState().resetSession();
    await recovered();

    expect(readsBeforeLoadSettled).toBe(0);
  });
});
