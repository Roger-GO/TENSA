/**
 * Tests for the v0.1.y Unit 5 session-recovery flow.
 *
 * Covers ``wireGlobalErrorRecovery`` + the ``useSessionStore`` recovery
 * state machine:
 *
 * - 404 on a session-scoped path raises ``recoveryInProgress`` and clears
 *   the session id.
 * - 404 on a non-session path is left alone.
 * - Burst of 404s only fires recovery once (per-second debounce).
 * - >3 attempts in a 30s window raises ``recoveryFailed``.
 * - The QueryCache subscriber wiring routes errors to the handler.
 *
 * The handler logic is exported as ``handleGlobalRecoveryError`` so tests
 * can drive it directly without manufacturing TanStack Query's internal
 * error-action dispatch shape. The end-to-end ``useEnsureSession`` recovery
 * effect is exercised by the WorkspaceFilePicker test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  makeQueryClient,
  wireGlobalErrorRecovery,
  handleGlobalRecoveryError,
  __resetRecoveryDebounceForTests,
  useTopology,
} from '@/api/queries';
import { ProblemDetailsError } from '@/api/client';
import { useSessionStore, MAX_RECOVERY_ATTEMPTS, RECOVERY_WINDOW_MS } from '@/store/session';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { ProblemDetails, SessionId } from '@/api/types';
import { useCaseStore } from '@/store/case';

function makeProblem(status: number, title = 'Error'): ProblemDetails {
  return {
    type: 'about:blank',
    title,
    status,
    detail: null,
    instance: null,
  };
}

describe('handleGlobalRecoveryError', () => {
  beforeEach(() => {
    __resetRecoveryDebounceForTests();
    useSessionStore.setState({
      sessionId: parseSessionId('sess-abc'),
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
    });
  });

  afterEach(() => {
    __resetRecoveryDebounceForTests();
    useSessionStore.setState({
      sessionId: null,
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
    });
  });

  it('401 is a no-op (no auth machinery to clear)', () => {
    const err = new ProblemDetailsError(
      makeProblem(401, 'Unauthorized'),
      undefined,
      '/api/sessions',
    );
    expect(handleGlobalRecoveryError(err)).toBe('noop');
  });

  it('on 404 against a session-scoped path: clears sessionId + raises recoveryInProgress', () => {
    const err = new ProblemDetailsError(
      makeProblem(404, 'Not Found'),
      undefined,
      '/api/sessions/sess-abc/topology',
    );
    expect(handleGlobalRecoveryError(err)).toBe('session-recovery');

    const state = useSessionStore.getState();
    expect(state.sessionId).toBeNull();
    expect(state.recoveryInProgress).toBe(true);
    expect(state.recoveryFailed).toBe(false);
    expect(state.recoveryAttempts.length).toBe(1);
  });

  it('matches a 404 on the bare /api/sessions/{id} path (session-describe)', () => {
    const err = new ProblemDetailsError(makeProblem(404), undefined, '/api/sessions/sess-abc');
    expect(handleGlobalRecoveryError(err)).toBe('session-recovery');
  });

  it('does NOT recover for a 404 on a non-session path', () => {
    const err = new ProblemDetailsError(
      makeProblem(404, 'Not Found'),
      undefined,
      '/api/workspace/file/missing.raw',
    );
    expect(handleGlobalRecoveryError(err)).toBe('noop');

    const state = useSessionStore.getState();
    expect(state.sessionId).toBe('sess-abc');
    expect(state.recoveryInProgress).toBe(false);
  });

  it('does NOT recover for a 404 with no requestPath (defensive)', () => {
    const err = new ProblemDetailsError(makeProblem(404, 'Not Found'));
    expect(handleGlobalRecoveryError(err)).toBe('noop');
    expect(useSessionStore.getState().recoveryInProgress).toBe(false);
  });

  it('debounces a burst of session-scoped 404s — only one recovery fires', () => {
    const err = (path: string) => new ProblemDetailsError(makeProblem(404), undefined, path);

    handleGlobalRecoveryError(err('/api/sessions/sess-abc/topology'));
    handleGlobalRecoveryError(err('/api/sessions/sess-abc/topology'));
    handleGlobalRecoveryError(err('/api/sessions/sess-abc/topology'));

    expect(useSessionStore.getState().recoveryAttempts.length).toBe(1);
    expect(useSessionStore.getState().recoveryInProgress).toBe(true);
  });

  it('raises recoveryFailed after MAX_RECOVERY_ATTEMPTS within the window', () => {
    // Drive the store directly to exceed the threshold (the debounce in
    // the handler would otherwise gate fast successive fires; the
    // store-level slide-window arithmetic is what we're verifying here).
    for (let i = 0; i < MAX_RECOVERY_ATTEMPTS + 1; i++) {
      useSessionStore.getState().resetSession();
    }
    expect(useSessionStore.getState().recoveryFailed).toBe(true);

    // Once recoveryFailed is true, the global handler short-circuits.
    __resetRecoveryDebounceForTests();
    const err = new ProblemDetailsError(
      makeProblem(404),
      undefined,
      '/api/sessions/sess-abc/topology',
    );
    const before = useSessionStore.getState().recoveryAttempts.length;
    expect(handleGlobalRecoveryError(err)).toBe('noop');
    expect(useSessionStore.getState().recoveryAttempts.length).toBe(before);
  });

  it('drops attempts older than the sliding window before counting', () => {
    const longAgo = Date.now() - RECOVERY_WINDOW_MS - 1000;
    useSessionStore.setState({
      sessionId: parseSessionId('sess-abc'),
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [longAgo, longAgo + 100, longAgo + 200],
    });

    useSessionStore.getState().resetSession();

    const state = useSessionStore.getState();
    expect(state.recoveryFailed).toBe(false);
    expect(state.recoveryAttempts.length).toBe(1);
  });

  it('does NOT recover when recoveryFailed is already pinned (terminal state)', () => {
    useSessionStore.setState({
      sessionId: parseSessionId('sess-abc'),
      recoveryInProgress: false,
      recoveryFailed: true,
      recoveryAttempts: [],
    });
    const err = new ProblemDetailsError(
      makeProblem(404),
      undefined,
      '/api/sessions/sess-abc/topology',
    );
    expect(handleGlobalRecoveryError(err)).toBe('noop');
    expect(useSessionStore.getState().sessionId).toBe('sess-abc');
    expect(useSessionStore.getState().recoveryInProgress).toBe(false);
  });
});

describe('wireGlobalErrorRecovery — cache subscriber integration', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetRecoveryDebounceForTests();
    useSessionStore.setState({
      sessionId: parseSessionId('sess-abc'),
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
    });
    // ``useTopology`` is gated on a loaded case (it 409s on a no-case
    // session), so set a case selection here for the subscriber-integration
    // test that needs the topology query to actually fire and 404.
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    });
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
      typeof vi.spyOn
    >;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    __resetRecoveryDebounceForTests();
    useSessionStore.setState({
      sessionId: null,
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
    });
    useCaseStore.setState({ selection: null, topology: null, layoutSidecar: null });
  });

  it('routes a topology 404 through the QueryCache subscriber and triggers recovery', async () => {
    // 404 ProblemDetails for the topology query.
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: 'about:blank',
          title: 'Session not found',
          status: 404,
          detail: null,
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const client = makeQueryClient();
    wireGlobalErrorRecovery(client);

    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const sessionId = parseSessionId('sess-abc');
    const { result } = renderHook(() => useTopology(sessionId), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    // The cache subscriber should have routed the 404 into recovery.
    expect(useSessionStore.getState().recoveryInProgress).toBe(true);
    expect(useSessionStore.getState().sessionId).toBeNull();
  });

  it('useTopology(null) does not fire a request (enabled-guard invariant)', () => {
    const client = makeQueryClient();
    wireGlobalErrorRecovery(client);
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    renderHook(() => useTopology(null as unknown as SessionId | null), { wrapper: Wrapper });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('useSessionStore recovery state machine', () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessionId: parseSessionId('sess-x'),
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
    });
  });

  afterEach(() => {
    useSessionStore.setState({
      sessionId: null,
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
    });
  });

  it('resetSession clears id + raises recoveryInProgress', () => {
    useSessionStore.getState().resetSession();
    const state = useSessionStore.getState();
    expect(state.sessionId).toBeNull();
    expect(state.recoveryInProgress).toBe(true);
  });

  it('clearRecoveryInProgress flips recoveryInProgress back to false', () => {
    useSessionStore.getState().resetSession();
    expect(useSessionStore.getState().recoveryInProgress).toBe(true);
    useSessionStore.getState().clearRecoveryInProgress();
    expect(useSessionStore.getState().recoveryInProgress).toBe(false);
  });

  it('counts attempts in a sliding window', () => {
    for (let i = 0; i < MAX_RECOVERY_ATTEMPTS; i++) {
      useSessionStore.getState().resetSession();
    }
    expect(useSessionStore.getState().recoveryFailed).toBe(false);
    useSessionStore.getState().resetSession();
    expect(useSessionStore.getState().recoveryFailed).toBe(true);
  });
});

describe('cross-slice cascade — session-clear during recovery', () => {
  beforeEach(async () => {
    // Import the combined store entrypoint so the cross-slice cascade is
    // wired (idempotent — the module's import side-effect does it).
    await import('@/store');
    useSessionStore.setState({
      sessionId: parseSessionId('sess-loaded'),
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
    });
  });

  afterEach(() => {
    useSessionStore.setState({
      sessionId: null,
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
    });
  });

  it('preserves the case selection when sessionId clears via resetSession', async () => {
    // The cross-slice cascade in store/index.ts subscribes to sessionId
    // transitions; during recovery it must NOT clear the case selection
    // (the recovery effect needs primaryPath to re-issue loadCase).
    const { useCaseStore } = await import('@/store/case');
    const { parseWorkspacePath } = await import('@/api/types');
    useCaseStore.setState({
      selection: {
        primaryPath: parseWorkspacePath('ieee14.raw'),
        addfiles: [],
      },
    });

    useSessionStore.getState().resetSession();

    // After resetSession (which sets recoveryInProgress=true), the
    // case selection should still be there.
    expect(useCaseStore.getState().selection).not.toBeNull();
    expect(useCaseStore.getState().selection?.primaryPath).toBe('ieee14.raw');
  });

  it('clears the case selection on a non-recovery sessionId clear (regression)', async () => {
    const { useCaseStore } = await import('@/store/case');
    const { parseWorkspacePath } = await import('@/api/types');
    useCaseStore.setState({
      selection: {
        primaryPath: parseWorkspacePath('ieee14.raw'),
        addfiles: [],
      },
    });

    // Direct ``clearSession`` (not via resetSession) — recoveryInProgress
    // stays false, the cascade fires and wipes the selection.
    useSessionStore.getState().clearSession();

    expect(useCaseStore.getState().selection).toBeNull();
  });
});

// ---- v0.2 polish Unit 1 — useSessionRecovery driver --------------------
//
// The hook is now the SINGLE caller of ``useCreateSession.mutate()`` in the
// app. These tests exercise the auto-create + post-DELETE re-create
// behaviours the picker and CaseNav previously each owned (and raced).
describe('useSessionRecovery — auto-create + post-delete re-create', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetRecoveryDebounceForTests();
    useSessionStore.setState({
      sessionId: null,
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
    });
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
      typeof vi.spyOn
    >;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    __resetRecoveryDebounceForTests();
    useSessionStore.setState({
      sessionId: null,
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
    });
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('fires POST /sessions on first paint when no session exists', async () => {
    let postCalls = 0;
    fetchSpy.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.endsWith('/api/sessions') && !url.includes('/api/sessions/')) {
        postCalls += 1;
        return Promise.resolve(jsonResponse({ session_id: 'sess-fresh', state: 'live' }, 201));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const client = makeQueryClient();
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const { useSessionRecovery } = await import('@/api/useSessionRecovery');
    renderHook(() => useSessionRecovery(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(postCalls).toBe(1);
    });
    await waitFor(() => {
      expect(useSessionStore.getState().sessionId).toBe('sess-fresh');
    });
  });

  it('auto-creates a fresh session after DELETE clears the id (post-change-case)', async () => {
    // Pre-seed a session id to model the "case loaded" state.
    useSessionStore.setState({ sessionId: parseSessionId('sess-old') });

    let postCalls = 0;
    fetchSpy.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.endsWith('/api/sessions') && !url.includes('/api/sessions/')) {
        postCalls += 1;
        return Promise.resolve(
          jsonResponse({ session_id: 'sess-after-delete', state: 'live' }, 201),
        );
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const client = makeQueryClient();
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const { useSessionRecovery } = await import('@/api/useSessionRecovery');
    renderHook(() => useSessionRecovery(), { wrapper: Wrapper });

    // Initial pre-seed: no create should fire (sessionId is non-null).
    await new Promise((r) => setTimeout(r, 50));
    expect(postCalls).toBe(0);

    // Simulate the change-case DELETE settling: clearSession() sets
    // sessionId to null. The driver should notice and fire ONE POST.
    useSessionStore.getState().clearSession();

    await waitFor(() => {
      expect(postCalls).toBe(1);
    });
    await waitFor(() => {
      expect(useSessionStore.getState().sessionId).toBe('sess-after-delete');
    });
  });

  it('does not fire when recoveryFailed is pinned (terminal state)', async () => {
    useSessionStore.setState({ recoveryFailed: true });
    let postCalls = 0;
    fetchSpy.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.endsWith('/api/sessions') && !url.includes('/api/sessions/')) {
        postCalls += 1;
        return Promise.resolve(jsonResponse({ session_id: 'sess-fresh', state: 'live' }, 201));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const client = makeQueryClient();
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const { useSessionRecovery } = await import('@/api/useSessionRecovery');
    renderHook(() => useSessionRecovery(), { wrapper: Wrapper });

    await new Promise((r) => setTimeout(r, 100));
    expect(postCalls).toBe(0);
  });

  it('re-issues loadCase against the new session id when a case was loaded pre-recovery', async () => {
    const { useCaseStore } = await import('@/store/case');
    const { parseWorkspacePath } = await import('@/api/types');
    useSessionStore.setState({ sessionId: parseSessionId('sess-pre') });
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
      topology: null,
      layoutSidecar: null,
    });

    fetchSpy.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.endsWith('/api/sessions') && !url.includes('/api/sessions/')) {
        return Promise.resolve(jsonResponse({ session_id: 'sess-new', state: 'live' }, 201));
      }
      if (url.endsWith('/api/sessions/sess-new/case')) {
        return Promise.resolve(
          jsonResponse({
            state: 'pre-setup',
            buses: [],
            lines: [],
            transformers: [],
            generators: [],
            loads: [],
          }),
        );
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const client = makeQueryClient();
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const { useSessionRecovery } = await import('@/api/useSessionRecovery');
    renderHook(() => useSessionRecovery(), { wrapper: Wrapper });

    // Trigger a recovery cycle.
    useSessionStore.getState().resetSession();

    // The driver should fire the post for the new session, then re-issue
    // loadCase against it.
    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([url]) => {
        const u = typeof url === 'string' ? url : ((url as Request).url ?? String(url));
        return u.endsWith('/api/sessions/sess-new/case');
      });
      expect(call).toBeDefined();
    });
    await waitFor(() => {
      expect(useSessionStore.getState().recoveryInProgress).toBe(false);
    });
  });

  it('warns and does NOT re-load when a BLANK system was active pre-recovery', async () => {
    const { useCaseStore } = await import('@/store/case');
    const { parseWorkspacePath: _pwp } = await import('@/api/types');
    void _pwp;
    const toastMod = await import('@/lib/toast');
    const errSpy = vi.spyOn(toastMod.toast, 'error');
    useSessionStore.setState({ sessionId: parseSessionId('sess-pre') });
    // Blank system: no file to re-load into the fresh session.
    useCaseStore.setState({
      selection: { primaryPath: null, addfiles: [], blank: true },
      topology: null,
      layoutSidecar: null,
    });

    fetchSpy.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.endsWith('/api/sessions') && !url.includes('/api/sessions/')) {
        return Promise.resolve(jsonResponse({ session_id: 'sess-new', state: 'live' }, 201));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const client = makeQueryClient();
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const { useSessionRecovery } = await import('@/api/useSessionRecovery');
    renderHook(() => useSessionRecovery(), { wrapper: Wrapper });

    useSessionStore.getState().resetSession();

    await waitFor(() => {
      expect(useSessionStore.getState().recoveryInProgress).toBe(false);
    });
    // No /case re-load was attempted (there is no file), and the user was told.
    const caseCall = fetchSpy.mock.calls.find(([url]) => {
      const u = typeof url === 'string' ? url : ((url as Request).url ?? String(url));
      return u.includes('/case');
    });
    expect(caseCall).toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(
      'Session expired — blank system lost',
      expect.anything(),
    );
    errSpy.mockRestore();
  });

  it('re-loads and warns about lost edits when clone-on-write had pending edits pre-recovery', async () => {
    const { useCaseStore } = await import('@/store/case');
    const { parseWorkspacePath } = await import('@/api/types');
    const toastMod = await import('@/lib/toast');
    const infoSpy = vi.spyOn(toastMod.toast, 'info');
    useSessionStore.setState({ sessionId: parseSessionId('sess-pre') });
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
      topology: null,
      layoutSidecar: null,
      cloneInitialized: true,
      cloneUndoDepth: 2, // actual edits pending → warning is warranted
      cloneRedoDepth: 0,
    });

    fetchSpy.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.endsWith('/api/sessions') && !url.includes('/api/sessions/')) {
        return Promise.resolve(jsonResponse({ session_id: 'sess-new', state: 'live' }, 201));
      }
      if (url.endsWith('/api/sessions/sess-new/case')) {
        return Promise.resolve(
          jsonResponse({
            state: 'pre-setup',
            buses: [],
            lines: [],
            transformers: [],
            generators: [],
            loads: [],
          }),
        );
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const client = makeQueryClient();
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const { useSessionRecovery } = await import('@/api/useSessionRecovery');
    renderHook(() => useSessionRecovery(), { wrapper: Wrapper });

    useSessionStore.getState().resetSession();

    // The file is re-loaded...
    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([url]) => {
        const u = typeof url === 'string' ? url : ((url as Request).url ?? String(url));
        return u.endsWith('/api/sessions/sess-new/case');
      });
      expect(call).toBeDefined();
    });
    // ...the user is warned their pending edits were lost, and ALL clone
    // state clears (incl. depths, so a stale Undo can't fire against a clone
    // that no longer exists).
    await waitFor(() => {
      expect(infoSpy).toHaveBeenCalledWith('Unsaved edits lost', expect.anything());
    });
    expect(useCaseStore.getState().cloneInitialized).toBe(false);
    expect(useCaseStore.getState().cloneUndoDepth).toBe(0);
    expect(useCaseStore.getState().cloneRedoDepth).toBe(0);
    infoSpy.mockRestore();
  });

  it('re-loads SILENTLY (no edits-lost toast) when Edit mode was on but nothing was edited', async () => {
    const { useCaseStore } = await import('@/store/case');
    const { parseWorkspacePath } = await import('@/api/types');
    const toastMod = await import('@/lib/toast');
    const infoSpy = vi.spyOn(toastMod.toast, 'info');
    useSessionStore.setState({ sessionId: parseSessionId('sess-pre') });
    // Edit mode toggled (clone initialised) but ZERO edits — nothing to lose.
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
      topology: null,
      layoutSidecar: null,
      cloneInitialized: true,
      cloneUndoDepth: 0,
      cloneRedoDepth: 0,
    });

    fetchSpy.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.endsWith('/api/sessions') && !url.includes('/api/sessions/')) {
        return Promise.resolve(jsonResponse({ session_id: 'sess-new', state: 'live' }, 201));
      }
      if (url.endsWith('/api/sessions/sess-new/case')) {
        return Promise.resolve(
          jsonResponse({
            state: 'pre-setup',
            buses: [],
            lines: [],
            transformers: [],
            generators: [],
            loads: [],
          }),
        );
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const client = makeQueryClient();
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const { useSessionRecovery } = await import('@/api/useSessionRecovery');
    renderHook(() => useSessionRecovery(), { wrapper: Wrapper });
    useSessionStore.getState().resetSession();

    await waitFor(() => {
      const call = fetchSpy.mock.calls.find(([url]) => {
        const u = typeof url === 'string' ? url : ((url as Request).url ?? String(url));
        return u.endsWith('/api/sessions/sess-new/case');
      });
      expect(call).toBeDefined();
    });
    await waitFor(() => {
      expect(useSessionStore.getState().recoveryInProgress).toBe(false);
    });
    // No false-positive "Unsaved edits lost" — there were no edits.
    expect(infoSpy).not.toHaveBeenCalled();
    // Clone state still cleared so a stale Undo can't act on the dead clone.
    expect(useCaseStore.getState().cloneInitialized).toBe(false);
    infoSpy.mockRestore();
  });

  it('clears recoveryInProgress on the blank-session path (no re-load)', async () => {
    const { useCaseStore } = await import('@/store/case');
    useSessionStore.setState({ sessionId: parseSessionId('sess-pre') });
    useCaseStore.setState({ selection: null, topology: null, layoutSidecar: null });

    fetchSpy.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.endsWith('/api/sessions') && !url.includes('/api/sessions/')) {
        return Promise.resolve(jsonResponse({ session_id: 'sess-new', state: 'live' }, 201));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const client = makeQueryClient();
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const { useSessionRecovery } = await import('@/api/useSessionRecovery');
    renderHook(() => useSessionRecovery(), { wrapper: Wrapper });

    useSessionStore.getState().resetSession();

    await waitFor(() => {
      expect(useSessionStore.getState().sessionId).toBe('sess-new');
    });
    await waitFor(() => {
      expect(useSessionStore.getState().recoveryInProgress).toBe(false);
    });
  });

  it('debounces rapid create attempts to at most one per second', async () => {
    let postCalls = 0;
    fetchSpy.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.endsWith('/api/sessions') && !url.includes('/api/sessions/')) {
        postCalls += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              type: 'about:blank',
              title: 'Bad gateway',
              status: 502,
              detail: null,
            }),
            { status: 502, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const client = makeQueryClient();
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const { useSessionRecovery } = await import('@/api/useSessionRecovery');
    renderHook(() => useSessionRecovery(), { wrapper: Wrapper });

    // First attempt fires + fails.
    await waitFor(() => {
      expect(postCalls).toBeGreaterThanOrEqual(1);
    });

    // Burst of resetSession calls within the debounce window: at most
    // one additional create should fire.
    const before = postCalls;
    for (let i = 0; i < 5; i += 1) {
      useSessionStore.getState().resetSession();
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(postCalls - before).toBeLessThanOrEqual(1);
  });
});

// ---- v2.0 polish Unit 2 — stuck-detection + transition telemetry --------
//
// The hook now schedules a 10s setTimeout on entry into ``connecting``
// and emits transition logs + toasts on the surface state machine
// transitions (idle / connecting / live / failed). These tests pin the
// behaviour so the badge never silently stays at "Reconnecting…" forever
// and the user always gets a recovery affordance when the substrate is
// unreachable.
describe('useSessionRecovery — stuck-detection + transition telemetry', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetRecoveryDebounceForTests();
    useSessionStore.setState({
      sessionId: null,
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
      recoveryStuckSince: null,
    });
    fetchSpy = vi.spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch') as ReturnType<
      typeof vi.spyOn
    >;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    __resetRecoveryDebounceForTests();
    useSessionStore.setState({
      sessionId: null,
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
      recoveryStuckSince: null,
    });
    vi.useRealTimers();
  });

  it('flips recoveryFailed after 10s of connecting via the stuck timer', async () => {
    // Pre-seed a session id to suppress the auto-create branch — we
    // want to drive ONLY the connecting state via setState below so
    // the stuck-timer effect is the only side channel exercised.
    useSessionStore.setState({
      sessionId: parseSessionId('sess-pre'),
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
      recoveryStuckSince: null,
    });
    fetchSpy.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    vi.useFakeTimers();

    const client = makeQueryClient();
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const { useSessionRecovery } = await import('@/api/useSessionRecovery');
    renderHook(() => useSessionRecovery(), { wrapper: Wrapper });

    // Drive the surface state into ``connecting`` via setState. Wrap
    // in act() so React flushes the effect that schedules the timer.
    await act(async () => {
      useSessionStore.setState({
        sessionId: null,
        recoveryInProgress: true,
        recoveryFailed: false,
        recoveryStuckSince: Date.now(),
      });
    });
    expect(useSessionStore.getState().recoveryInProgress).toBe(true);
    expect(useSessionStore.getState().recoveryFailed).toBe(false);

    // Advance just under the 10s timeout.
    await act(async () => {
      vi.advanceTimersByTime(9_999);
    });
    expect(useSessionStore.getState().recoveryFailed).toBe(false);

    // Cross the threshold: timer fires, stuck-detection flips failed.
    await act(async () => {
      vi.advanceTimersByTime(2);
    });
    expect(useSessionStore.getState().recoveryFailed).toBe(true);
  });

  it('cancels the stuck timer when sessionId arrives before timeout', async () => {
    fetchSpy.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.endsWith('/api/sessions') && !url.includes('/api/sessions/')) {
        return Promise.resolve(
          new Response(JSON.stringify({ session_id: 'sess-fresh', state: 'live' }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const client = makeQueryClient();
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const { useSessionRecovery } = await import('@/api/useSessionRecovery');
    renderHook(() => useSessionRecovery(), { wrapper: Wrapper });

    // Wait for the auto-create to land + clearRecoveryInProgress to run.
    await waitFor(() => {
      expect(useSessionStore.getState().sessionId).toBe('sess-fresh');
    });

    // Now switch to fake timers and advance past the threshold. The
    // timer was cancelled when the surface state moved to 'live', so
    // recoveryFailed must NOT be raised.
    vi.useFakeTimers();
    vi.advanceTimersByTime(15_000);
    expect(useSessionStore.getState().recoveryFailed).toBe(false);
  });

  it('emits transition logs through the configurable logger', async () => {
    fetchSpy.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.endsWith('/api/sessions') && !url.includes('/api/sessions/')) {
        return Promise.resolve(
          new Response(JSON.stringify({ session_id: 'sess-logged', state: 'live' }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const log: Array<{ from: string; to: string }> = [];
    const { setRecoveryLogger, resetRecoveryLogger, useSessionRecovery } =
      await import('@/api/useSessionRecovery');
    setRecoveryLogger(({ from, to }) => {
      log.push({ from, to });
    });

    const client = makeQueryClient();
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    renderHook(() => useSessionRecovery(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(useSessionStore.getState().sessionId).toBe('sess-logged');
    });
    // Cold-start path: idle → live (no connecting middle because the
    // store's recoveryInProgress flag stays false on the auto-create
    // path; only the 404 recovery raises it).
    expect(log.some((entry) => entry.to === 'live')).toBe(true);

    resetRecoveryLogger();
  });

  it('logs the failed → connecting → live arc as discrete transitions', async () => {
    // Pre-seed failed state. The recovery driver short-circuits the
    // auto-create when recoveryFailed is pinned, so the only edge
    // exercised here is the synthetic state-machine transition we
    // drive via setState. The toast.success call is wired off the
    // same edge as the logger entry: when the test sees
    // ``failed → connecting`` then ``connecting → live`` the toast
    // assertion is implicit (the live-edge code path has exactly one
    // branch and it always invokes ``toast.success`` when the prior
    // state was failed).
    useSessionStore.setState({
      sessionId: null,
      recoveryInProgress: false,
      recoveryFailed: true,
      recoveryAttempts: [],
      recoveryStuckSince: null,
    });

    const log: Array<{ from: string; to: string }> = [];
    const { setRecoveryLogger, resetRecoveryLogger, useSessionRecovery } =
      await import('@/api/useSessionRecovery');
    setRecoveryLogger(({ from, to }) => {
      log.push({ from, to });
    });

    fetchSpy.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const client = makeQueryClient();
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    renderHook(() => useSessionRecovery(), { wrapper: Wrapper });

    // Drive: failed → connecting → live.
    await act(async () => {
      useSessionStore.setState({
        sessionId: null,
        recoveryInProgress: true,
        recoveryFailed: false,
        recoveryStuckSince: Date.now(),
      });
    });
    await act(async () => {
      useSessionStore.setState({
        sessionId: parseSessionId('sess-recovered'),
        recoveryInProgress: false,
        recoveryFailed: false,
        recoveryStuckSince: null,
      });
    });

    await waitFor(() => {
      expect(log.some((e) => e.from === 'failed' && e.to === 'connecting')).toBe(true);
      expect(log.some((e) => e.from === 'connecting' && e.to === 'live')).toBe(true);
    });

    resetRecoveryLogger();
  });
});
