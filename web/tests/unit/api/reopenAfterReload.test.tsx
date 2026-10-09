/**
 * After a reload of the page, the case the tab had open is opened again.
 *
 * A reload gives the session back and the page starts with an empty one. It
 * used to stay that way, with a note that named the case and a button that
 * reopened it. `useReopenAfterReload` now opens it by itself once the new
 * session is there: the case file with the dynamic files it was opened with,
 * or a new blank system for one built from scratch, and onto it the edits the
 * tab kept, as a session recovery replays them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

// What the tab kept of the journal is read once, as the module loads: a test
// says here what the page that was reloaded had.
const kept = vi.hoisted(() => ({ journal: null as unknown }));
vi.mock('@/store/editJournal', async () => {
  const actual = await vi.importActual<typeof import('@/store/editJournal')>('@/store/editJournal');
  return { ...actual, journalBeforeReload: () => kept.journal };
});

import { makeQueryClient } from '@/api/queries';
import { useReopenAfterReload } from '@/api/useReopenAfterReload';
import { parseSessionId } from '@/api/types';
import { toast } from '@/lib/toast';
import { __resetCascadeForTests, wireStoreCascade } from '@/store';
import { useCaseStore } from '@/store/case';
import {
  JOURNAL_STORAGE_KEY,
  hasUnsavedEdits,
  readKeptJournal,
  useEditJournalStore,
} from '@/store/editJournal';
import type { JournalEntry, KeptJournal } from '@/store/editJournal';
import {
  BLANK_DRAFTS_STORAGE_KEY,
  OPEN_CASE_STORAGE_KEY,
  readOpenCaseMark,
  useReloadedCaseStore,
} from '@/store/reloadedCase';
import type { OpenCaseMark } from '@/store/reloadedCase';
import { useSessionStore } from '@/store/session';

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
const ON_FILE: OpenCaseMark = { primaryPath: 'ieee14.raw', addfiles: ['ieee14.dyr'] };
const FROM_SCRATCH: OpenCaseMark = { primaryPath: null, addfiles: [], blank: true };

const BUILD: JournalEntry[] = [
  { op: 'add', model: 'Bus', params: { idx: 1, Vn: 110 }, rev: 1 },
  { op: 'add', model: 'Bus', params: { idx: 2, Vn: 110 }, rev: 2 },
  { op: 'edit', model: 'Bus', idx: '1', params: { Vn: 230 }, rev: 3 },
];

function journal(entries: JournalEntry[], more: Partial<KeptJournal> = {}): KeptJournal {
  return {
    entries,
    revision: entries.at(-1)?.rev ?? 0,
    savedRevision: 0,
    fileSavedRevision: 0,
    replayable: true,
    opaqueRevision: 0,
    replaced: false,
    ...more,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** What `fetch` rejects with when a request got no answer. */
const noAnswer = () => new TypeError('Failed to fetch');

/** A request that stays under way until the test ends it without an answer. */
function underWay(): { answer: () => Promise<Response>; end: () => void } {
  let end!: () => void;
  const request = new Promise<Response>((_resolve, reject) => {
    end = () => reject(noAnswer());
  });
  return { answer: () => request, end };
}

/** Let what follows a request that ended run to its end. */
const settled = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

describe('useReopenAfterReload', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let calls: string[];
  let bodies: Record<string, unknown>;
  let answers: Record<string, () => Response | Promise<Response>>;
  let success: MockInstance<typeof toast.success>;
  let warning: MockInstance<typeof toast.warning>;
  let error: MockInstance<typeof toast.error>;

  /** The page as it starts after a reload that interrupted `mark`. */
  function reloaded(mark: OpenCaseMark | null, session: string | null = 's-new'): void {
    window.sessionStorage.setItem(OPEN_CASE_STORAGE_KEY, JSON.stringify(mark));
    useReloadedCaseStore.setState({ closed: mark });
    useSessionStore.setState({ sessionId: session === null ? null : parseSessionId(session) });
    const client = makeQueryClient();
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    renderHook(() => useReopenAfterReload(), { wrapper: Wrapper });
  }

  beforeEach(() => {
    // The mark follows the open case through the cascade, as in the app.
    wireStoreCascade();
    calls = [];
    bodies = {};
    answers = {};
    kept.journal = null;
    fetchSpy = vi
      .spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch')
      .mockImplementation(async (input, init) => {
        const key = `${init?.method ?? 'GET'} ${String(input)}`;
        calls.push(key);
        if (typeof init?.body === 'string') bodies[key] = JSON.parse(init.body);
        const answer = answers[key];
        if (answer !== undefined) return answer();
        if (key.endsWith('/blank')) return jsonResponse({ topology: TOPOLOGY }, 201);
        if (key.endsWith('/case')) return jsonResponse(TOPOLOGY);
        return jsonResponse({});
      }) as ReturnType<typeof vi.spyOn>;
    success = vi.spyOn(toast, 'success');
    warning = vi.spyOn(toast, 'warning');
    error = vi.spyOn(toast, 'error');
  });

  afterEach(() => {
    cleanup();
    // A test that let the page go shows it again.
    window.dispatchEvent(new Event('pageshow'));
    fetchSpy.mockRestore();
    success.mockRestore();
    warning.mockRestore();
    error.mockRestore();
    window.sessionStorage.clear();
    useReloadedCaseStore.setState({ closed: null });
    useSessionStore.setState({ sessionId: null, recoveryFailed: false });
    useCaseStore.setState({ selection: null, topology: null, loadingPath: null });
    useEditJournalStore.getState().reset();
    __resetCascadeForTests();
  });

  /** The requests that change the session, in the order they were sent. */
  const sent = () => calls.filter((key) => !key.startsWith('GET '));

  it('opens the case file again, with the dynamic files it was opened with', async () => {
    reloaded(ON_FILE);
    await waitFor(() =>
      expect(useCaseStore.getState().selection).toEqual({
        primaryPath: 'ieee14.raw',
        addfiles: ['ieee14.dyr'],
      }),
    );
    expect(sent()).toEqual(['POST /api/sessions/s-new/case']);
    expect(bodies['POST /api/sessions/s-new/case']).toEqual({
      primary_path: 'ieee14.raw',
      addfiles: ['ieee14.dyr'],
    });
    // Nothing was edited, so there is nothing to say: the case is simply there.
    expect(success).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    // The mark is answered: the page is no longer reopening anything.
    expect(useReloadedCaseStore.getState().closed).toBeNull();
  });

  it('replays the edits the tab kept onto the case, in order, and says so', async () => {
    kept.journal = journal(BUILD, { savedRevision: 1 });
    reloaded({ primaryPath: 'ieee14.raw', addfiles: [] });
    await waitFor(() => expect(success).toHaveBeenCalled());
    expect(sent()).toEqual([
      'POST /api/sessions/s-new/case',
      'POST /api/sessions/s-new/elements',
      'POST /api/sessions/s-new/elements',
      'PUT /api/sessions/s-new/elements/Bus/1',
    ]);
    expect(success).toHaveBeenCalledWith('Edits restored', {
      description: 'The page was reloaded. 3 changes replayed onto a fresh copy of the case.',
    });
    // The journal is the one the tab had: Undo, the unsaved-work guard and a
    // later loss of the session go on from it.
    const now = useEditJournalStore.getState();
    expect(now.entries).toEqual(BUILD);
    expect(now).toMatchObject({ revision: 3, savedRevision: 1 });
    expect(hasUnsavedEdits()).toBe(true);
  });

  it('builds a system that was built from scratch again, element by element', async () => {
    kept.journal = journal(BUILD);
    reloaded(FROM_SCRATCH);
    await waitFor(() => expect(success).toHaveBeenCalled());
    expect(sent()).toEqual([
      'POST /api/sessions/s-new/blank',
      'POST /api/sessions/s-new/elements',
      'POST /api/sessions/s-new/elements',
      'PUT /api/sessions/s-new/elements/Bus/1',
    ]);
    expect(useCaseStore.getState().selection).toEqual({
      primaryPath: null,
      addfiles: [],
      blank: true,
    });
    expect(success).toHaveBeenCalledWith('Edits restored', {
      description: 'The page was reloaded. 3 changes replayed onto a new blank system.',
    });
  });

  it('waits for the session, and says meanwhile which case is on its way back', async () => {
    reloaded({ primaryPath: 'ieee14.raw', addfiles: [] }, null);
    // Not "No case loaded", which is what a first visit reads.
    expect(useCaseStore.getState().loadingPath).toBe('ieee14.raw');
    expect(sent()).toEqual([]);
    act(() => useSessionStore.setState({ sessionId: parseSessionId('s-late') }));
    await waitFor(() => expect(useCaseStore.getState().selection).not.toBeNull());
    expect(sent()).toEqual(['POST /api/sessions/s-late/case']);
    expect(useCaseStore.getState().loadingPath).toBeNull();
  });

  it('says that it is not loading when there is no server to open the case on', () => {
    reloaded({ primaryPath: 'ieee14.raw', addfiles: [] }, null);
    expect(useCaseStore.getState().loadingPath).toBe('ieee14.raw');
    act(() => useSessionStore.setState({ recoveryFailed: true }));
    expect(useCaseStore.getState().loadingPath).toBeNull();
    expect(sent()).toEqual([]);
  });

  it('leaves a case the user opened first alone', async () => {
    useCaseStore.setState({ selection: { primaryPath: 'kundur.xlsx' as never, addfiles: [] } });
    kept.journal = journal(BUILD);
    reloaded({ primaryPath: 'ieee14.raw', addfiles: [] });
    await Promise.resolve();
    expect(sent()).toEqual([]);
    expect(useCaseStore.getState().selection?.primaryPath).toBe('kundur.xlsx');
    expect(useEditJournalStore.getState().entries).toEqual([]);
  });

  it('starts as on a first visit, and says which case it could not open, when the file is gone', async () => {
    answers['POST /api/sessions/s-new/case'] = () =>
      jsonResponse(
        { type: 'about:blank', title: 'Not found', status: 404, detail: 'No such case file.' },
        404,
      );
    kept.journal = journal(BUILD);
    reloaded({ primaryPath: 'studies/ieee14.raw', addfiles: [] });
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(error).toHaveBeenCalledWith(
      'Could not reopen ieee14.raw',
      expect.objectContaining({
        description: expect.stringMatching(
          /^The page was reloaded\. .*No such case file\..* Pick a case in the Project tab of the left sidebar\.$/,
        ),
      }),
    );
    expect(useCaseStore.getState()).toMatchObject({ selection: null, loadingPath: null });
    expect(useReloadedCaseStore.getState().closed).toBeNull();
    // Not tried again at the next reload either.
    expect(window.sessionStorage.getItem(OPEN_CASE_STORAGE_KEY)).toBeNull();
    expect(sent()).toEqual(['POST /api/sessions/s-new/case']);
  });

  it('opens the case from its file and says what was lost when the edits cannot be replayed', async () => {
    // A snapshot restore or a bundle import replaced the system: no journal describes that.
    kept.journal = journal(BUILD, { replayable: false, replaced: true });
    reloaded({ primaryPath: 'ieee14.raw', addfiles: [] });
    await waitFor(() => expect(warning).toHaveBeenCalled());
    expect(sent()).toEqual(['POST /api/sessions/s-new/case']);
    expect(warning).toHaveBeenCalledWith(
      'ieee14.raw was reopened from its file',
      expect.objectContaining({
        description: expect.stringContaining('Changes that cannot be replayed were made'),
      }),
    );
    expect(useEditJournalStore.getState().entries).toEqual([]);
  });

  it('starts an empty system and says so when a build from scratch cannot be replayed', async () => {
    kept.journal = journal(BUILD, { replayable: false, opaqueRevision: 3 });
    reloaded(FROM_SCRATCH);
    await waitFor(() => expect(warning).toHaveBeenCalled());
    expect(sent()).toEqual(['POST /api/sessions/s-new/blank']);
    expect(warning).toHaveBeenCalledWith('The system was not rebuilt', expect.anything());
    expect(useCaseStore.getState().selection?.blank).toBe(true);
  });

  it('says so when the system that was being built cannot be started again', async () => {
    answers['POST /api/sessions/s-new/blank'] = () =>
      jsonResponse(
        { type: 'about:blank', title: 'Refused', status: 500, detail: 'worker gone' },
        500,
      );
    kept.journal = journal(BUILD);
    reloaded(FROM_SCRATCH);
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(error).toHaveBeenCalledWith(
      'The system you were building could not be opened again',
      expect.anything(),
    );
    expect(useCaseStore.getState().selection).toBeNull();
    expect(useReloadedCaseStore.getState().closed).toBeNull();
  });

  it('cuts the journal back to what was applied when the server refuses an edit', async () => {
    answers['PUT /api/sessions/s-new/elements/Bus/1'] = () =>
      jsonResponse(
        { type: 'about:blank', title: 'Refused', status: 422, detail: 'Vn must be positive' },
        422,
      );
    kept.journal = journal(BUILD);
    reloaded({ primaryPath: 'ieee14.raw', addfiles: [] });
    await waitFor(() => expect(warning).toHaveBeenCalled());
    expect(warning).toHaveBeenCalledWith(
      'Some edits could not be restored',
      expect.objectContaining({ description: expect.stringContaining('Vn must be positive') }),
    );
    expect(useEditJournalStore.getState().entries).toEqual(BUILD.slice(0, 2));
  });

  describe('a request that ends without an answer', () => {
    const CASE: OpenCaseMark = { primaryPath: 'ieee14.raw', addfiles: [] };
    const DRAFTS = JSON.stringify([{ id: 'draft-1', kind: 'Bus', position: { x: 0, y: 0 } }]);

    /** The page as it starts after a reload, with the edits of `BUILD` kept by the tab. */
    function reloadedWithEdits(mark: OpenCaseMark): void {
      kept.journal = journal(BUILD);
      window.sessionStorage.setItem(JOURNAL_STORAGE_KEY, JSON.stringify(kept.journal));
      if (mark.primaryPath === null) {
        window.sessionStorage.setItem(BLANK_DRAFTS_STORAGE_KEY, DRAFTS);
      }
      reloaded(mark);
    }

    /** The page is reloaded again: it goes, and the browser ends its requests. */
    async function reloadAgain(request: { end: () => void }): Promise<void> {
      window.dispatchEvent(new Event('pagehide'));
      request.end();
      await settled();
    }

    it('leaves the case and its edits to the next page when the page is reloaded again while the case loads', async () => {
      const load = underWay();
      answers['POST /api/sessions/s-new/case'] = load.answer;
      reloadedWithEdits(CASE);
      await waitFor(() => expect(sent()).toEqual(['POST /api/sessions/s-new/case']));
      await reloadAgain(load);
      // The page that comes next finds what this one found.
      expect(readOpenCaseMark()).toEqual(CASE);
      expect(readKeptJournal()).toEqual(kept.journal);
      // And this one, which no one sees any more, says nothing.
      expect(error).not.toHaveBeenCalled();
    });

    it('leaves a system built from scratch, its build and its drafts to the next page as well', async () => {
      const start = underWay();
      answers['POST /api/sessions/s-new/blank'] = start.answer;
      reloadedWithEdits(FROM_SCRATCH);
      await waitFor(() => expect(sent()).toEqual(['POST /api/sessions/s-new/blank']));
      await reloadAgain(start);
      expect(readOpenCaseMark()).toEqual(FROM_SCRATCH);
      expect(readKeptJournal()).toEqual(kept.journal);
      expect(window.sessionStorage.getItem(BLANK_DRAFTS_STORAGE_KEY)).toBe(DRAFTS);
      expect(error).not.toHaveBeenCalled();
    });

    it('leaves every edit to the next page when the page is reloaded again while they are replayed', async () => {
      const edit = underWay();
      answers['PUT /api/sessions/s-new/elements/Bus/1'] = edit.answer;
      reloadedWithEdits(CASE);
      await waitFor(() => expect(sent()).toHaveLength(4));
      await reloadAgain(edit);
      // Not cut back to the two that were applied before the page went.
      expect(readKeptJournal()?.entries).toEqual(BUILD);
      expect(readOpenCaseMark()).toEqual(CASE);
      expect(warning).not.toHaveBeenCalled();
    });

    it('keeps the case for the next reload, and says so, when the server does not answer the load', async () => {
      answers['POST /api/sessions/s-new/case'] = () => Promise.reject(noAnswer());
      reloadedWithEdits(CASE);
      await waitFor(() => expect(error).toHaveBeenCalled());
      expect(error).toHaveBeenCalledWith(
        'Could not reopen ieee14.raw',
        expect.objectContaining({
          description:
            'The page was reloaded. The server did not answer. Reload the page to try again, or pick a case in the Project tab of the left sidebar.',
        }),
      );
      // This page stops waiting, and is as on a first visit.
      expect(useReloadedCaseStore.getState().closed).toBeNull();
      expect(useCaseStore.getState()).toMatchObject({ selection: null, loadingPath: null });
      // The tab keeps all of it: a lost connection says nothing about the case.
      expect(readOpenCaseMark()).toEqual(CASE);
      expect(readKeptJournal()).toEqual(kept.journal);
    });

    it('keeps a system built from scratch for the next reload when the server does not answer', async () => {
      answers['POST /api/sessions/s-new/blank'] = () => Promise.reject(noAnswer());
      reloadedWithEdits(FROM_SCRATCH);
      await waitFor(() => expect(error).toHaveBeenCalled());
      expect(error).toHaveBeenCalledWith(
        'The system you were building could not be opened again',
        expect.objectContaining({
          description:
            'The page was reloaded. The server did not answer. Reload the page to try again.',
        }),
      );
      expect(useReloadedCaseStore.getState().closed).toBeNull();
      expect(useCaseStore.getState().selection).toBeNull();
      expect(readOpenCaseMark()).toEqual(FROM_SCRATCH);
      expect(readKeptJournal()).toEqual(kept.journal);
      expect(window.sessionStorage.getItem(BLANK_DRAFTS_STORAGE_KEY)).toBe(DRAFTS);
    });

    it('goes on with the edits that were applied, and keeps them all for a reload, when a replayed one gets no answer', async () => {
      answers['PUT /api/sessions/s-new/elements/Bus/1'] = () => Promise.reject(noAnswer());
      reloadedWithEdits(CASE);
      await waitFor(() => expect(warning).toHaveBeenCalled());
      expect(warning).toHaveBeenCalledWith(
        'Some edits are not restored yet',
        expect.objectContaining({
          description:
            'Restored 2 of 3 changes onto a fresh copy of the case before the server stopped answering. Reload the page now to restore them all.',
        }),
      );
      // The page has what its session holds, and the tab what the user had.
      expect(useEditJournalStore.getState().entries).toEqual(BUILD.slice(0, 2));
      expect(readKeptJournal()?.entries).toEqual(BUILD);
    });

    it('forgets a mark that names no file of a workspace', async () => {
      reloaded({ primaryPath: '../outside.raw', addfiles: [] });
      await waitFor(() => expect(error).toHaveBeenCalled());
      expect(sent()).toEqual([]);
      expect(readOpenCaseMark()).toBeNull();
      expect(useCaseStore.getState().loadingPath).toBeNull();
    });
  });

  it('does nothing on a first visit', async () => {
    reloaded(null);
    await Promise.resolve();
    expect(calls).toEqual([]);
    expect(useCaseStore.getState().loadingPath).toBeNull();
  });
});
