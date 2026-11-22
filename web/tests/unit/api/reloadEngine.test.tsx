/**
 * The engine of the session across a reload of the page, with the case it
 * belongs to.
 *
 * A session belongs to one engine. The tab keeps the engine of its session
 * (`ENGINE_STORAGE_KEY` in `store/session.ts`) and the mark of the case it
 * has open names it (`store/reloadedCase.ts`), so the first session of the
 * next page asks for that engine and the case is reopened in it. A case is
 * never reopened, and its edits never replayed, under another engine than
 * the one it was open in.
 *
 * Each page here is the modules loaded afresh over what the tab kept in
 * `sessionStorage` (`vi.resetModules`), as a reload loads them: the stores
 * read the kept engine, the mark and the journal as they are created. The
 * two hooks that act on them, `useSessionRecovery` (which creates the
 * session) and `useReopenAfterReload`, run against a mocked `fetch`, so what
 * is asserted is the requests the page sends and what it leaves in storage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const ENGINE_KEY = 'tensa:engine-v1';
const MARK_KEY = 'tensa:open-case-v1';
const JOURNAL_KEY = 'tensa:edit-journal-v1';
/** The drafts kept per case file: they belong to the file, not to a session. */
const FILE_DRAFTS_KEY = 'tensa:sld-drafts-v1';

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

type Answer = () => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const created = (id: string, engine: string): Answer => {
  return () => json({ session_id: id, engine, workspace_id: 'ws', state: 'live' }, 201);
};
const refused = (status: number, detail: string): Answer => {
  return () => json({ type: 'about:blank', title: 'Refused', status, detail }, status);
};
/** What `fetch` rejects with when a request got no answer. */
const noAnswer: Answer = () => Promise.reject(new TypeError('Failed to fetch'));

/** A request that stays under way until the test ends it without an answer. */
function underWay(): { answer: Answer; end: () => void } {
  let end!: () => void;
  const request = new Promise<Response>((_resolve, reject) => {
    end = () => reject(new TypeError('Failed to fetch'));
  });
  return { answer: () => request, end };
}

let fetchSpy: MockInstance<typeof fetch>;
let calls: string[];
let bodies: { key: string; body: unknown }[];
/** The answers to `POST /api/sessions`, in turn. */
let creates: Answer[];
let answers: Record<string, Answer>;

/** The requests that change the session, in the order they were sent. */
const sent = () => calls.filter((key) => !key.startsWith('GET '));
/** The bodies of the session creates, in order. */
const createBodies = () =>
  bodies.filter(({ key }) => key === 'POST /api/sessions').map(({ body }) => body);
/** Requests that load a case or replay an edit, in any session. */
const caseRequests = () => sent().filter((key) => /\/sessions\/[^/]+\//.test(key));

const kept = {
  engine: () => window.sessionStorage.getItem(ENGINE_KEY),
  mark: () => {
    const raw = window.sessionStorage.getItem(MARK_KEY);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  },
  journal: () => window.sessionStorage.getItem(JOURNAL_KEY),
};

/**
 * Load the page: every module afresh over the tab's `sessionStorage`, the
 * store cascade wired as `App.tsx` wires it, and the two hooks mounted when
 * `mount` is true.
 */
async function page(mount = true) {
  vi.resetModules();
  await import('@/store');
  const session = await import('@/store/session');
  const cases = await import('@/store/case');
  const reloadedCase = await import('@/store/reloadedCase');
  const editJournal = await import('@/store/editJournal');
  const recovery = await import('@/api/useSessionRecovery');
  const reopen = await import('@/api/useReopenAfterReload');
  const { makeQueryClient } = await import('@/api/queries');
  const { toast } = await import('@/lib/toast');
  const error = vi.spyOn(toast, 'error').mockImplementation(() => 0 as never);
  vi.spyOn(toast, 'success').mockImplementation(() => 0 as never);
  vi.spyOn(toast, 'warning').mockImplementation(() => 0 as never);
  recovery.setRecoveryLogger(() => {});
  if (mount) {
    const client = makeQueryClient();
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    renderHook(
      () => {
        recovery.useSessionRecovery();
        reopen.useReopenAfterReload();
      },
      { wrapper: Wrapper },
    );
  }
  return { session, cases, reloadedCase, editJournal, recovery, error };
}

type Page = Awaited<ReturnType<typeof page>>;

/** A session of `engine` has landed, as `useCreateSession` lands one. */
function landed(p: Page, id: string, engine: string): void {
  act(() => {
    p.session.useSessionStore.getState().setEngine(engine);
    p.session.useSessionStore.getState().setSessionId(id as never);
  });
}

/** IEEE 14 opened in the session, and one edit made to it. */
function openCaseAndEdit(p: Page): void {
  act(() => {
    p.cases.useCaseStore.getState().setCase({
      primaryPath: 'ieee14.raw' as never,
      addfiles: ['ieee14.dyr' as never],
    });
    p.editJournal.useEditJournalStore
      .getState()
      .record({ op: 'add', model: 'Bus', params: { idx: 99, Vn: 110 } });
  });
}

/** A first page with IEEE 14 open under Sienna and one edit made to it. */
async function siennaCaseOpen(): Promise<void> {
  const first = await page(false);
  landed(first, 's-1', 'sienna');
  openCaseAndEdit(first);
  expect(kept.engine()).toBe('sienna');
  expect(kept.mark()).toEqual({
    primaryPath: 'ieee14.raw',
    addfiles: ['ieee14.dyr'],
    engine: 'sienna',
  });
  expect(kept.journal()).not.toBeNull();
}

/** The page goes: the browser ends its requests, and the page shows nothing more. */
async function leave(request?: { end: () => void }): Promise<void> {
  window.dispatchEvent(new Event('pagehide'));
  request?.end();
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  cleanup();
}

const settled = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 30)));

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  calls = [];
  bodies = [];
  creates = [];
  answers = {};
  fetchSpy = vi
    .spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch')
    .mockImplementation(async (input, init) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      calls.push(key);
      if (typeof init?.body === 'string') bodies.push({ key, body: JSON.parse(init.body) });
      if (key === 'POST /api/sessions') {
        const next = creates.shift();
        if (next === undefined) throw new Error('no answer set for this create');
        return next();
      }
      const answer = answers[key];
      if (answer !== undefined) return answer();
      if (key.endsWith('/blank')) return json({ topology: TOPOLOGY }, 201);
      if (key.endsWith('/case')) return json(TOPOLOGY);
      if (key.startsWith('DELETE ')) return new Response(null, { status: 204 });
      return json({});
    });
});

afterEach(() => {
  cleanup();
  window.dispatchEvent(new Event('pageshow'));
  fetchSpy.mockRestore();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe('a reload of a page on ANDES', () => {
  it('keeps nothing for the engine, and asks for a session as it always did', async () => {
    const first = await page(false);
    landed(first, 's-1', 'andes');
    openCaseAndEdit(first);
    // The mark is what it always was, with no engine in it, and no engine is kept.
    expect(kept.mark()).toEqual({ primaryPath: 'ieee14.raw', addfiles: ['ieee14.dyr'] });
    expect(kept.engine()).toBeNull();

    creates.push(created('s-2', 'andes'));
    const second = await page();
    await waitFor(() => expect(second.cases.useCaseStore.getState().selection).not.toBeNull());
    await waitFor(() => expect(sent()).toHaveLength(3));
    expect(createBodies()).toEqual([{}]);
    expect(sent()).toEqual([
      'POST /api/sessions',
      'POST /api/sessions/s-2/case',
      'POST /api/sessions/s-2/elements',
    ]);
    expect(kept.engine()).toBeNull();
  });
});

describe('a reload of a page on Sienna', () => {
  it('creates a Sienna session, reopens the case in it and replays its edits', async () => {
    await siennaCaseOpen();
    creates.push(created('s-2', 'sienna'));
    const second = await page();
    expect(second.session.useSessionStore.getState().engine).toBe('sienna');

    await waitFor(() => expect(sent()).toHaveLength(3));
    expect(sent()).toEqual([
      'POST /api/sessions',
      'POST /api/sessions/s-2/case',
      'POST /api/sessions/s-2/elements',
    ]);
    expect(createBodies()).toEqual([{ engine: 'sienna' }]);
    expect(second.cases.useCaseStore.getState().selection).toEqual({
      primaryPath: 'ieee14.raw',
      addfiles: ['ieee14.dyr'],
    });
    expect(second.editJournal.useEditJournalStore.getState().entries).toHaveLength(1);
    expect(kept.engine()).toBe('sienna');
    expect(kept.mark()).toMatchObject({ engine: 'sienna' });
  });

  it('falls back to ANDES when Sienna is refused, and neither reopens nor replays the case', async () => {
    await siennaCaseOpen();
    window.localStorage.setItem(FILE_DRAFTS_KEY, '{"kept":"by file"}');
    creates.push(
      refused(409, 'the sienna engine is not available: Julia was not found.'),
      created('s-2', 'andes'),
    );
    const second = await page();

    await waitFor(() => expect(second.session.useSessionStore.getState().sessionId).toBe('s-2'));
    await waitFor(() =>
      expect(second.session.useSessionStore.getState().recoveryInProgress).toBe(false),
    );
    await settled();
    // The fallback asks for the default engine as a first visit does.
    expect(createBodies()).toEqual([{ engine: 'sienna' }, {}]);
    // No case load and no edit went out, in any session.
    expect(caseRequests()).toEqual([]);
    expect(second.error).toHaveBeenNthCalledWith(
      1,
      'Sienna is not available any more: the sienna engine is not available: Julia was not found. Started an ANDES session instead.',
    );
    expect(second.error).toHaveBeenNthCalledWith(
      2,
      'ieee14.raw was open under Sienna and was not reopened: a case opened under one engine is not replayed into another.',
      expect.objectContaining({ description: 'The page was reloaded.' }),
    );
    expect(second.error).toHaveBeenCalledTimes(2);
    // What the tab kept for the case and its engine is gone, the drafts of the file are not.
    expect(kept.engine()).toBeNull();
    expect(kept.mark()).toBeNull();
    expect(kept.journal()).toBeNull();
    expect(window.localStorage.getItem(FILE_DRAFTS_KEY)).toBe('{"kept":"by file"}');
    expect(second.cases.useCaseStore.getState()).toMatchObject({
      selection: null,
      loadingPath: null,
    });
    expect(second.reloadedCase.useReloadedCaseStore.getState().closed).toBeNull();

    // And the next reload is an ANDES page with nothing to reopen.
    cleanup();
    creates.push(created('s-3', 'andes'));
    const third = await page();
    await waitFor(() => expect(third.session.useSessionStore.getState().sessionId).toBe('s-3'));
    await settled();
    expect(createBodies()).toEqual([{ engine: 'sienna' }, {}, {}]);
    expect(caseRequests()).toEqual([]);
  });

  it('forgets the refused engine at once, before the ANDES session has landed', async () => {
    await siennaCaseOpen();
    creates.push(refused(409, 'the sienna engine is not available'), noAnswer);
    const second = await page();
    await waitFor(() => expect(createBodies()).toHaveLength(2));
    await settled();
    expect(createBodies()).toEqual([{ engine: 'sienna' }, {}]);
    expect(second.session.useSessionStore.getState().sessionId).toBeNull();
    expect(kept.engine()).toBeNull();
    expect(kept.mark()).toBeNull();
    expect(kept.journal()).toBeNull();

    // The next reload asks for the default engine, and has nothing to reopen.
    cleanup();
    creates.push(created('s-3', 'andes'));
    await page();
    await waitFor(() => expect(createBodies()).toHaveLength(3));
    await settled();
    expect(createBodies()[2]).toEqual({});
    expect(caseRequests()).toEqual([]);
  });

  it('with no case open, the refusal only falls back and forgets the kept engine', async () => {
    const first = await page(false);
    landed(first, 's-1', 'sienna');
    creates.push(refused(409, 'the sienna engine is not available'), created('s-2', 'andes'));
    const second = await page();
    await waitFor(() => expect(second.session.useSessionStore.getState().sessionId).toBe('s-2'));
    expect(createBodies()).toEqual([{ engine: 'sienna' }, {}]);
    expect(second.error).toHaveBeenCalledTimes(1);
    expect(kept.engine()).toBeNull();
  });

  it('drops nothing when the create gets no answer, and the next reload reopens the case under Sienna', async () => {
    await siennaCaseOpen();
    const journalBefore = kept.journal();
    creates.push(noAnswer);
    const second = await page();
    await waitFor(() => expect(createBodies()).toHaveLength(1));
    await settled();
    expect(createBodies()).toEqual([{ engine: 'sienna' }]);
    expect(second.error).not.toHaveBeenCalled();
    expect(second.session.useSessionStore.getState().engine).toBe('sienna');
    expect(kept.engine()).toBe('sienna');
    expect(kept.mark()).toMatchObject({ primaryPath: 'ieee14.raw', engine: 'sienna' });
    expect(kept.journal()).toBe(journalBefore);

    cleanup();
    creates.push(created('s-3', 'sienna'));
    const third = await page();
    await waitFor(() => expect(caseRequests()).toHaveLength(2));
    expect(createBodies()).toEqual([{ engine: 'sienna' }, { engine: 'sienna' }]);
    expect(caseRequests()).toEqual([
      'POST /api/sessions/s-3/case',
      'POST /api/sessions/s-3/elements',
    ]);
    expect(third.cases.useCaseStore.getState().selection).not.toBeNull();
  });

  it('drops nothing when the page is reloaded again while the create is out', async () => {
    await siennaCaseOpen();
    const journalBefore = kept.journal();
    const create = underWay();
    creates.push(create.answer);
    const second = await page();
    await waitFor(() => expect(createBodies()).toHaveLength(1));
    await leave(create);
    expect(second.error).not.toHaveBeenCalled();
    expect(kept.engine()).toBe('sienna');
    expect(kept.mark()).toMatchObject({ engine: 'sienna' });
    expect(kept.journal()).toBe(journalBefore);
  });

  it('keeps the engine and the case when the page is reloaded again while the case is on its way back', async () => {
    await siennaCaseOpen();
    const journalBefore = kept.journal();
    const load = underWay();
    answers['POST /api/sessions/s-2/case'] = load.answer;
    creates.push(created('s-2', 'sienna'));
    await page();
    await waitFor(() => expect(sent()).toContain('POST /api/sessions/s-2/case'));
    await leave(load);
    expect(kept.engine()).toBe('sienna');
    expect(kept.mark()).toMatchObject({ primaryPath: 'ieee14.raw', engine: 'sienna' });
    expect(kept.journal()).toBe(journalBefore);

    creates.push(created('s-3', 'sienna'));
    const third = await page();
    await waitFor(() => expect(caseRequests()).toContain('POST /api/sessions/s-3/elements'));
    expect(createBodies()).toEqual([{ engine: 'sienna' }, { engine: 'sienna' }]);
    expect(third.cases.useCaseStore.getState().selection).not.toBeNull();
  });
});

describe('a switch of engine and a reload', () => {
  it('a reload before the new session lands comes back on the old engine, with no case', async () => {
    const first = await page(false);
    landed(first, 's-1', 'andes');
    openCaseAndEdit(first);
    await act(async () => {
      expect(await first.recovery.startSessionOver('sienna')).toBe('switched');
    });
    // The session of the new engine has not landed: nothing is kept for it.
    expect(first.session.useSessionStore.getState().engine).toBe('sienna');
    expect(kept.engine()).toBeNull();
    expect(kept.mark()).toBeNull();
    expect(kept.journal()).toBeNull();

    creates.push(created('s-2', 'andes'));
    const second = await page();
    await waitFor(() => expect(second.session.useSessionStore.getState().sessionId).toBe('s-2'));
    await settled();
    expect(createBodies()).toEqual([{}]);
    expect(caseRequests()).toEqual([]);
  });

  it('from Sienna, a reload before ANDES lands comes back on Sienna, with no case', async () => {
    const first = await page(false);
    landed(first, 's-1', 'sienna');
    openCaseAndEdit(first);
    await act(async () => {
      expect(await first.recovery.startSessionOver('andes')).toBe('switched');
    });
    expect(kept.engine()).toBe('sienna');
    expect(kept.mark()).toBeNull();

    creates.push(created('s-2', 'sienna'));
    await page();
    await waitFor(() => expect(createBodies()).toHaveLength(1));
    await settled();
    expect(createBodies()).toEqual([{ engine: 'sienna' }]);
    expect(caseRequests()).toEqual([]);
  });

  it('once the new session lands it is the one kept', async () => {
    const first = await page(false);
    landed(first, 's-1', 'sienna');
    expect(kept.engine()).toBe('sienna');
    await act(async () => {
      await first.recovery.startSessionOver('andes');
    });
    landed(first, 's-2', 'andes');
    expect(kept.engine()).toBeNull();
    landed(first, 's-3', 'sienna');
    expect(kept.engine()).toBe('sienna');
  });
});

describe('a mark whose engine is not the session’s', () => {
  it('is not reopened, the user is told, and nothing is replayed', async () => {
    // A stale mark: the kept engine was removed, or the mark is from an older page.
    await siennaCaseOpen();
    window.sessionStorage.removeItem(ENGINE_KEY);
    creates.push(created('s-2', 'andes'));
    const second = await page();
    await waitFor(() => expect(second.error).toHaveBeenCalled());
    await settled();
    expect(createBodies()).toEqual([{}]);
    expect(caseRequests()).toEqual([]);
    expect(second.error).toHaveBeenCalledWith(
      'ieee14.raw was not reopened',
      expect.objectContaining({
        description:
          'The page was reloaded. It was open under Sienna, and this session is ANDES. Open it again from the Project tab of the left sidebar.',
      }),
    );
    expect(kept.mark()).toBeNull();
    expect(kept.journal()).toBeNull();
    expect(second.cases.useCaseStore.getState().loadingPath).toBeNull();
  });
});

describe('a session recovery under Sienna (the page stays)', () => {
  /** A page with a Sienna session and IEEE 14 open, and the recovery driver mounted. */
  async function siennaPage(): Promise<Page> {
    const p = await page(false);
    landed(p, 's-1', 'sienna');
    openCaseAndEdit(p);
    // The same modules, now with the hook mounted: no reload in between.
    const client = (await import('@/api/queries')).makeQueryClient();
    const { useSessionRecovery } = p.recovery;
    renderHook(() => useSessionRecovery(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    return p;
  }

  it('creates the session of the same engine, reloads the case and keeps the engine', async () => {
    const first = await siennaPage();
    creates.push(created('s-2', 'sienna'));
    act(() => first.session.useSessionStore.getState().resetSession());
    await waitFor(() =>
      expect(first.session.useSessionStore.getState().recoveryInProgress).toBe(false),
    );
    expect(createBodies()).toEqual([{ engine: 'sienna' }]);
    expect(caseRequests()).toEqual([
      'POST /api/sessions/s-2/case',
      'POST /api/sessions/s-2/elements',
    ]);
    expect(kept.engine()).toBe('sienna');
    expect(kept.mark()).toMatchObject({ engine: 'sienna' });
  });

  it('a refused recovery does not fall back to ANDES with the case still open', async () => {
    const first = await siennaPage();
    creates.push(refused(409, 'the sienna engine is not available'), created('s-2', 'andes'));
    act(() => first.session.useSessionStore.getState().resetSession());
    await waitFor(() => expect(createBodies()).toHaveLength(1));
    await settled();
    expect(createBodies()).toEqual([{ engine: 'sienna' }]);
    expect(caseRequests()).toEqual([]);
    expect(first.error).not.toHaveBeenCalled();
    expect(first.cases.useCaseStore.getState().selection).not.toBeNull();
    expect(kept.engine()).toBe('sienna');
    expect(kept.mark()).toMatchObject({ engine: 'sienna' });
  });
});

describe('storage that throws (private browsing, blocked site data)', () => {
  const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');

  afterEach(() => {
    if (original !== undefined) Object.defineProperty(window, 'sessionStorage', original);
  });

  it('starts as with nothing kept, and nothing throws out of the stores or the hooks', async () => {
    const denied = () => {
      throw new Error('denied');
    };
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: {
        get length() {
          return denied();
        },
        key: denied,
        getItem: denied,
        setItem: denied,
        removeItem: denied,
        clear: denied,
      } satisfies Storage,
    });
    creates.push(created('s-1', 'sienna'));
    const p = await page();
    expect(p.session.useSessionStore.getState().engine).toBeNull();
    expect(p.reloadedCase.useReloadedCaseStore.getState().closed).toBeNull();
    await waitFor(() => expect(p.session.useSessionStore.getState().sessionId).toBe('s-1'));
    expect(createBodies()).toEqual([{}]);
    // What this page writes for a reload: the mark, with its engine, and the
    // kept engine when a session lands. (`setCase` is not called here: the
    // persisted UI store throws on such a storage, which is not this test's.)
    expect(() =>
      p.reloadedCase.useReloadedCaseStore
        .getState()
        .follow({ primaryPath: 'ieee14.raw' as never, addfiles: [] }),
    ).not.toThrow();
    expect(() => p.reloadedCase.useReloadedCaseStore.getState().forget()).not.toThrow();
    expect(() => landed(p, 's-2', 'sienna')).not.toThrow();
    expect(() => p.session.useSessionStore.getState().clearSession()).not.toThrow();
    expect(p.session.writeKeptEngine('sienna')).toBe(false);
    expect(p.session.readKeptEngine()).toBeNull();
  });
});

describe('an engine the server does not know in what the tab kept', () => {
  it('is answered 422 and handled as a refusal: an ANDES session, the value forgotten', async () => {
    window.sessionStorage.setItem(ENGINE_KEY, 'nonesuch');
    window.sessionStorage.setItem(
      MARK_KEY,
      JSON.stringify({ primaryPath: 'ieee14.raw', addfiles: [], engine: 'nonesuch' }),
    );
    creates.push(
      refused(422, "POST /sessions accepts only an optional 'engine' field. validation errors: []"),
      created('s-1', 'andes'),
    );
    const p = await page();
    await waitFor(() => expect(p.session.useSessionStore.getState().sessionId).toBe('s-1'));
    await settled();
    expect(createBodies()).toEqual([{ engine: 'nonesuch' }, {}]);
    expect(caseRequests()).toEqual([]);
    expect(p.error).toHaveBeenNthCalledWith(
      1,
      'nonesuch is not available any more: the server does not know this engine. Started an ANDES session instead.',
    );
    expect(kept.engine()).toBeNull();
    expect(kept.mark()).toBeNull();
  });

  it('a session-cap refusal (429) is no refusal of the engine: nothing is dropped', async () => {
    await siennaCaseOpen();
    creates.push(refused(429, 'max_sessions cap reached'));
    const p = await page();
    await waitFor(() => expect(createBodies()).toHaveLength(1));
    await settled();
    expect(p.error).not.toHaveBeenCalled();
    expect(kept.engine()).toBe('sienna');
    expect(kept.mark()).toMatchObject({ engine: 'sienna' });
  });
});
