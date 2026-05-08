/**
 * Tests for the v0.1.y Unit 5 session-recovery flow.
 *
 * Covers ``wireGlobalErrorRecovery`` (the renamed ``wireGlobal401Handler``)
 * + the ``useSessionStore`` recovery state machine:
 *
 * - 401 still clears auth (regression guard for the existing 401 path).
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
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  makeQueryClient,
  wireGlobalErrorRecovery,
  handleGlobalRecoveryError,
  __resetRecoveryDebounceForTests,
  useTopology,
} from '@/api/queries';
import { ProblemDetailsError, setTokenGetter } from '@/api/client';
import { useAuthStore } from '@/store/auth';
import {
  useSessionStore,
  MAX_RECOVERY_ATTEMPTS,
  RECOVERY_WINDOW_MS,
} from '@/store/session';
import { parseSessionId } from '@/api/types';
import type { ProblemDetails, SessionId } from '@/api/types';

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
    useAuthStore.setState({ token: 'a'.repeat(64), persistFailed: false });
    useSessionStore.setState({
      sessionId: parseSessionId('sess-abc'),
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
    });
  });

  afterEach(() => {
    __resetRecoveryDebounceForTests();
    useAuthStore.setState({ token: null, persistFailed: false });
    useSessionStore.setState({
      sessionId: null,
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
    });
  });

  it('clears the auth token on a 401 (regression guard)', () => {
    const err = new ProblemDetailsError(
      makeProblem(401, 'Unauthorized'),
      undefined,
      '/api/sessions/sess-abc/topology',
    );
    expect(handleGlobalRecoveryError(err)).toBe('auth-cleared');
    expect(useAuthStore.getState().token).toBeNull();
  });

  it('401 with no auth token is a no-op (auth-fast-path race guard)', () => {
    useAuthStore.setState({ token: null, persistFailed: false });
    const err = new ProblemDetailsError(makeProblem(401), undefined, '/api/sessions');
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
    const err = new ProblemDetailsError(
      makeProblem(404),
      undefined,
      '/api/sessions/sess-abc',
    );
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
    const err = (path: string) =>
      new ProblemDetailsError(makeProblem(404), undefined, path);

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
    setTokenGetter(() => 'test-token');
    useAuthStore.setState({ token: 'a'.repeat(64), persistFailed: false });
    useSessionStore.setState({
      sessionId: parseSessionId('sess-abc'),
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
    setTokenGetter(() => null);
    __resetRecoveryDebounceForTests();
    useAuthStore.setState({ token: null, persistFailed: false });
    useSessionStore.setState({
      sessionId: null,
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
    });
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
