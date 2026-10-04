/**
 * The heartbeat that keeps a session from being reaped while its tab is open.
 *
 * The substrate counts ``GET /sessions/{id}`` as activity, so ``useSessionHeartbeat``
 * polls it every 30 s while a session exists, including from a background tab, and
 * routes a 404 into the recovery cycle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  makeQueryClient,
  wireGlobalErrorRecovery,
  __resetRecoveryDebounceForTests,
} from '@/api/queries';
import { SESSION_HEARTBEAT_INTERVAL_MS, useSessionHeartbeat } from '@/api/useSessionHeartbeat';
import { useSessionStore } from '@/store/session';
import { parseSessionId } from '@/api/types';

const SESSION_URL = '/api/sessions/sess-abc';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function heartbeatCalls(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter(([url]) => String(url).endsWith(SESSION_URL)).length;
}

function renderHeartbeat() {
  const client = makeQueryClient();
  wireGlobalErrorRecovery(client);
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return renderHook(() => useSessionHeartbeat(), { wrapper: Wrapper });
}

/** Advance the clock inside ``act`` and let the fetch the poll started settle. */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(10);
  });
}

function setTabVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

describe('useSessionHeartbeat', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    __resetRecoveryDebounceForTests();
    useSessionStore.setState({
      sessionId: null,
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
    });
    fetchSpy = vi
      .spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch')
      .mockImplementation(async () =>
        jsonResponse({ session_id: 'sess-abc', state: 'live' }),
      ) as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    // Unmount while the fake timers are still in place, so a poll in flight does not
    // update the hook's component after the test.
    cleanup();
    fetchSpy.mockRestore();
    setTabVisibility('visible');
    vi.useRealTimers();
    __resetRecoveryDebounceForTests();
    useSessionStore.setState({
      sessionId: null,
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
    });
  });

  it('sends nothing while there is no session', async () => {
    renderHeartbeat();

    await tick(SESSION_HEARTBEAT_INTERVAL_MS * 3);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('checks in at once and then every interval while a session exists', async () => {
    useSessionStore.setState({ sessionId: parseSessionId('sess-abc') });
    renderHeartbeat();

    await tick(0);
    expect(heartbeatCalls(fetchSpy)).toBe(1);

    await tick(SESSION_HEARTBEAT_INTERVAL_MS);
    expect(heartbeatCalls(fetchSpy)).toBe(2);

    await tick(SESSION_HEARTBEAT_INTERVAL_MS);
    expect(heartbeatCalls(fetchSpy)).toBe(3);
  });

  it('keeps checking in from a background tab', async () => {
    setTabVisibility('hidden');
    useSessionStore.setState({ sessionId: parseSessionId('sess-abc') });
    renderHeartbeat();

    await tick(SESSION_HEARTBEAT_INTERVAL_MS * 2);

    // The mount check-in plus two intervals, though the tab never became visible.
    expect(heartbeatCalls(fetchSpy)).toBeGreaterThanOrEqual(3);
  });

  it('stops when the session is cleared', async () => {
    useSessionStore.setState({ sessionId: parseSessionId('sess-abc') });
    renderHeartbeat();
    await tick(0);
    const before = heartbeatCalls(fetchSpy);

    await act(async () => {
      useSessionStore.setState({ sessionId: null });
      await vi.advanceTimersByTimeAsync(SESSION_HEARTBEAT_INTERVAL_MS * 3);
    });

    expect(heartbeatCalls(fetchSpy)).toBe(before);
  });

  it('starts the recovery cycle when the substrate no longer knows the session', async () => {
    fetchSpy.mockImplementation(async () =>
      jsonResponse(
        { type: 'about:blank', title: 'Not Found', status: 404, detail: 'session is not active' },
        404,
      ),
    );
    useSessionStore.setState({ sessionId: parseSessionId('sess-abc') });
    renderHeartbeat();

    await tick(0);

    const state = useSessionStore.getState();
    expect(state.recoveryInProgress).toBe(true);
    expect(state.sessionId).toBeNull();
  });
});
