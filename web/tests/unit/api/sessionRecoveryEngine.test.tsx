/**
 * The engine switch at the level of the session lifecycle: `startSessionOver`
 * (the release of the old session and the one store change that follows it)
 * and the parts of `useSessionRecovery` that create the next session, put the
 * old engine back when the new one is refused, and keep the engine through a
 * recovery.
 *
 * The API client is the seam: `andesClient` is mocked and everything above it
 * is real, the store cascade (`store/index.ts`) included, since closing the
 * case is the cascade's work. What a reload of the page would reopen is read
 * the way the next page reads it as its modules load: `readOpenCaseMark` and
 * `readKeptJournal` over `sessionStorage`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return { ...actual, andesClient: { post: vi.fn(), delete: vi.fn(), get: vi.fn() } };
});

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { startSessionOver, useSessionRecovery } from '@/api/useSessionRecovery';
import { andesClient, ProblemDetailsError } from '@/api/client';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { SessionDescriptor } from '@/api/types';
import { toast } from '@/lib/toast';
import { __resetCascadeForTests, wireStoreCascade } from '@/store';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useRunsStore } from '@/store/runs';
import { useLayoutHistoryStore } from '@/store/layoutHistory';
import { readKeptJournal, useEditJournalStore } from '@/store/editJournal';
import { readOpenCaseMark } from '@/store/reloadedCase';

const post = vi.mocked(andesClient.post);
const del = vi.mocked(andesClient.delete);

const FRESH_SESSION = {
  sessionId: null,
  engine: null,
  previousEngine: null,
  engines: null,
  recoveryInProgress: false,
  recoveryFailed: false,
  recoveryAttempts: [],
  recoveryStuckSince: null,
};

const CASE = {
  primaryPath: parseWorkspacePath('ieee14.raw'),
  addfiles: [parseWorkspacePath('ieee14.dyr')],
};

function descriptor(sessionId: string, engine: string): SessionDescriptor {
  return { session_id: sessionId, engine, workspace_id: 'ws-test' } as unknown as SessionDescriptor;
}

function refusal(status: number, detail: string, path: string): ProblemDetailsError {
  return new ProblemDetailsError(
    { type: 'about:blank', title: 'Conflict', status, detail, instance: null },
    undefined,
    path,
  );
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** The bodies of the `POST /sessions` calls, in order. */
function createBodies(): unknown[] {
  return post.mock.calls
    .filter(([path]) => path === '/sessions')
    .map(([, options]) => (options as { body?: unknown } | undefined)?.body);
}

/** The `POST` calls other than a session create (a case load, a replay). */
function otherPosts(): string[] {
  return post.mock.calls.map(([path]) => path).filter((path) => path !== '/sessions');
}

/**
 * A live ANDES session with a case open, an edit in the journal, a finished
 * run and a step in the layout history: what the tab keeps for the case.
 */
function openCaseOnAndes(): void {
  useSessionStore.setState({ sessionId: parseSessionId('sess-1'), engine: 'andes' });
  useCaseStore.getState().setCase(CASE);
  useEditJournalStore.getState().record({ op: 'add', model: 'Bus', params: { idx: 99 } });
  useLayoutHistoryStore.setState({ past: [{} as never], future: [] });
  useRunsStore.setState({ runs: { r1: { runId: 'r1', state: 'done' } as never } });
}

beforeEach(() => {
  window.sessionStorage.clear();
  wireStoreCascade();
  useSessionStore.setState(FRESH_SESSION);
  useEditJournalStore.getState().reset();
  post.mockReset();
  del.mockReset();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  cleanup();
  __resetCascadeForTests();
  useSessionStore.setState(FRESH_SESSION);
  useEditJournalStore.getState().reset();
  useLayoutHistoryStore.getState().clear();
  window.sessionStorage.clear();
});

describe('startSessionOver: the release', () => {
  it('closes the old session on the server before the store changes', async () => {
    openCaseOnAndes();
    let answer: () => void = () => {};
    del.mockReturnValue(new Promise<void>((resolve) => (answer = resolve)) as never);

    const outcome = startSessionOver('sienna');
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0]?.[0]).toBe('/sessions/sess-1');
    // While the DELETE is out, the store is the old session, its engine and its case.
    expect(useSessionStore.getState()).toMatchObject({
      sessionId: 'sess-1',
      engine: 'andes',
      previousEngine: null,
    });
    expect(useCaseStore.getState().selection).not.toBeNull();

    answer();
    expect(await outcome).toBe('switched');
    expect(useSessionStore.getState()).toMatchObject({
      sessionId: null,
      engine: 'sienna',
      previousEngine: 'andes',
    });
  });

  it('closes the case and everything the tab kept for it', async () => {
    openCaseOnAndes();
    expect(readOpenCaseMark()).not.toBeNull();
    expect(readKeptJournal()).not.toBeNull();
    del.mockResolvedValue(undefined as never);

    await startSessionOver('sienna');

    expect(useCaseStore.getState().selection).toBeNull();
    expect(useEditJournalStore.getState().entries).toEqual([]);
    expect(useLayoutHistoryStore.getState().past).toEqual([]);
    expect(useRunsStore.getState().runs).toEqual({});
    expect(usePflowStore.getState().lastRun).toBeNull();
    // What the next page reads as it loads: no case to reopen, no edits to replay.
    expect(readOpenCaseMark()).toBeNull();
    expect(readKeptJournal()).toBeNull();
  });

  it('a DELETE that fails keeps the session, the engine and the case, and says why', async () => {
    openCaseOnAndes();
    del.mockRejectedValue(new Error('Failed to fetch'));

    expect(await startSessionOver('sienna')).toBe('kept');

    expect(useSessionStore.getState()).toMatchObject({
      sessionId: 'sess-1',
      engine: 'andes',
      previousEngine: null,
    });
    expect(useCaseStore.getState().selection).toEqual(CASE);
    expect(readOpenCaseMark()).not.toBeNull();
    expect(useEditJournalStore.getState().entries).toHaveLength(1);
    expect(toast.error).toHaveBeenCalledWith(
      'Could not switch to Sienna: Failed to fetch',
      expect.objectContaining({ description: expect.stringContaining('still on ANDES') }),
    );
  });

  it('a DELETE answered 404 (the session is gone already) goes on with the switch', async () => {
    openCaseOnAndes();
    del.mockRejectedValue(refusal(404, 'no such session', '/api/sessions/sess-1'));

    expect(await startSessionOver('sienna')).toBe('switched');
    expect(useSessionStore.getState()).toMatchObject({ sessionId: null, engine: 'sienna' });
  });

  it('does nothing for the engine the session already has', async () => {
    openCaseOnAndes();
    expect(await startSessionOver('andes')).toBe('ignored');
    expect(del).not.toHaveBeenCalled();
    expect(useCaseStore.getState().selection).toEqual(CASE);
  });

  it('does nothing with no live session, or while one is being recovered', async () => {
    useSessionStore.setState({ engine: 'andes' });
    expect(await startSessionOver('sienna')).toBe('ignored');
    useSessionStore.setState({ sessionId: parseSessionId('s'), recoveryInProgress: true });
    expect(await startSessionOver('sienna')).toBe('ignored');
    expect(del).not.toHaveBeenCalled();
    expect(useSessionStore.getState().engine).toBe('andes');
  });

  it('a second request while the first is out sends no second DELETE', async () => {
    openCaseOnAndes();
    let answer: () => void = () => {};
    del.mockReturnValue(new Promise<void>((resolve) => (answer = resolve)) as never);

    const first = startSessionOver('sienna');
    expect(await startSessionOver('sienna')).toBe('ignored');
    answer();
    await first;
    // And none while the new session is on its way (previousEngine is set).
    expect(await startSessionOver('andes')).toBe('ignored');
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('is refused while a power flow runs, as Change case is', async () => {
    openCaseOnAndes();
    usePflowStore.setState({ isRunning: true });
    expect(await startSessionOver('sienna')).toBe('kept');
    expect(del).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      'Could not switch to Sienna',
      expect.objectContaining({ description: 'Wait for power flow to finish.' }),
    );
    usePflowStore.setState({ isRunning: false });
  });

  it('is called off when a recovery replaced the session while the DELETE was out', async () => {
    openCaseOnAndes();
    del.mockImplementation((async () => {
      useSessionStore.setState({ sessionId: parseSessionId('sess-9') });
    }) as never);
    expect(await startSessionOver('sienna')).toBe('kept');
    expect(useSessionStore.getState()).toMatchObject({ sessionId: 'sess-9', engine: 'andes' });
  });
});

describe('useSessionRecovery: the session after a switch', () => {
  it('creates the session of the new engine and ends the switch when it lands', async () => {
    openCaseOnAndes();
    del.mockResolvedValue(undefined as never);
    post.mockResolvedValue(descriptor('sess-2', 'sienna') as never);
    renderHook(() => useSessionRecovery(), { wrapper });

    await act(async () => {
      await startSessionOver('sienna');
    });

    await waitFor(() => expect(useSessionStore.getState().sessionId).toBe('sess-2'));
    expect(createBodies()).toEqual([{ engine: 'sienna' }]);
    expect(useSessionStore.getState()).toMatchObject({ engine: 'sienna', previousEngine: null });
    expect(otherPosts()).toEqual([]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('a refused create puts the old engine back, says why, and starts a session of it', async () => {
    openCaseOnAndes();
    del.mockResolvedValue(undefined as never);
    post
      .mockRejectedValueOnce(
        refusal(409, 'the sienna engine is not available: Julia was not found', '/api/sessions'),
      )
      .mockResolvedValueOnce(descriptor('sess-3', 'andes') as never);
    renderHook(() => useSessionRecovery(), { wrapper });

    await act(async () => {
      await startSessionOver('sienna');
    });

    await waitFor(() => expect(useSessionStore.getState().sessionId).toBe('sess-3'));
    expect(createBodies()).toEqual([{ engine: 'sienna' }, { engine: 'andes' }]);
    expect(useSessionStore.getState()).toMatchObject({ engine: 'andes', previousEngine: null });
    expect(toast.error).toHaveBeenCalledWith(
      'Could not switch to Sienna: the sienna engine is not available: Julia was not found',
      expect.objectContaining({ description: 'Starting a new ANDES session instead.' }),
    );
    // The case was closed by the switch and stays closed.
    expect(useCaseStore.getState().selection).toBeNull();
    expect(otherPosts()).toEqual([]);
    await waitFor(() => expect(useSessionStore.getState().recoveryInProgress).toBe(false));
  });

  it('a create that gets no answer is handled the same way', async () => {
    openCaseOnAndes();
    del.mockResolvedValue(undefined as never);
    post
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce(descriptor('sess-3', 'andes') as never);
    renderHook(() => useSessionRecovery(), { wrapper });

    await act(async () => {
      await startSessionOver('sienna');
    });

    await waitFor(() => expect(useSessionStore.getState().sessionId).toBe('sess-3'));
    expect(useSessionStore.getState().engine).toBe('andes');
    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toBe(
      'Could not switch to Sienna: Failed to fetch',
    );
  });

  it('a create error with no switch under way leaves the engine alone', async () => {
    post.mockRejectedValue(new Error('offline'));
    renderHook(() => useSessionRecovery(), { wrapper });

    await waitFor(() => expect(post).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(useSessionStore.getState().engine).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('a lost session after a switch is recreated with the new engine, and no old case comes back', async () => {
    openCaseOnAndes();
    del.mockResolvedValue(undefined as never);
    post
      .mockResolvedValueOnce(descriptor('sess-2', 'sienna') as never)
      .mockResolvedValueOnce(descriptor('sess-4', 'sienna') as never);
    renderHook(() => useSessionRecovery(), { wrapper });

    await act(async () => {
      await startSessionOver('sienna');
    });
    await waitFor(() => expect(useSessionStore.getState().sessionId).toBe('sess-2'));

    // The server restarted: a session-scoped 404 resets the session for
    // recovery. (Past the recovery driver's one-second debounce on creates.)
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    act(() => useSessionStore.getState().resetSession());

    await waitFor(() => expect(useSessionStore.getState().sessionId).toBe('sess-4'));
    await waitFor(() => expect(useSessionStore.getState().recoveryInProgress).toBe(false));
    expect(createBodies()).toEqual([{ engine: 'sienna' }, { engine: 'sienna' }]);
    expect(useSessionStore.getState().engine).toBe('sienna');
    // Nothing of the ANDES case was loaded or replayed into the Sienna session.
    expect(otherPosts()).toEqual([]);
    expect(useCaseStore.getState().selection).toBeNull();
    expect(readOpenCaseMark()).toBeNull();
    expect(readKeptJournal()).toBeNull();
  });
});
