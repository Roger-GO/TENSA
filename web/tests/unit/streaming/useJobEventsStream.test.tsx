/**
 * Tests for ``useJobEventsStream`` (v3.1 Unit 11) — the app-root owner of the
 * per-session ``JobStream`` lifecycle.
 *
 * Coverage:
 *  - opens + starts exactly one stream when sessionId set and token present;
 *  - opens for a no-auth backend (authDisabled) with an empty token;
 *  - opens NOTHING when sessionId is null, or when token is null + auth on;
 *  - a sessionId change disposes the prior stream and creates a fresh one;
 *  - unmount disposes;
 *  - the onError auth_failed callback clears the auth token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import type { JobStreamOptions } from '@/streaming/JobStream';

// ---- JobStream mock --------------------------------------------------------

interface MockInstance {
  opts: JobStreamOptions;
  start: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

const instances: MockInstance[] = [];

vi.mock('@/streaming/JobStream', () => {
  class JobStream {
    opts: JobStreamOptions;
    start = vi.fn();
    dispose = vi.fn();
    constructor(opts: JobStreamOptions) {
      this.opts = opts;
      instances.push(this as unknown as MockInstance);
    }
  }
  return { JobStream };
});

import { useJobEventsStream, STALE_SWEEP_INTERVAL_MS } from '@/streaming/useJobEventsStream';
import { useSessionStore } from '@/store/session';
import { useAuthStore } from '@/store/auth';
import { useJobsStore } from '@/store/jobs';

function setSession(id: string | null): void {
  useSessionStore.setState({
    sessionId: id as Parameters<
      ReturnType<typeof useSessionStore.getState>['setSessionId']
    >[0] | null,
  });
}

describe('useJobEventsStream', () => {
  beforeEach(() => {
    instances.length = 0;
    useSessionStore.setState({ sessionId: null });
    useAuthStore.setState({ token: null, authDisabled: false });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('opens + starts one stream when sessionId set and token present', () => {
    setSession('sess-1');
    useAuthStore.setState({ token: 't'.repeat(64) });
    renderHook(() => useJobEventsStream());
    expect(instances).toHaveLength(1);
    expect(instances[0]!.start).toHaveBeenCalledTimes(1);
    expect(instances[0]!.opts.sessionId).toBe('sess-1');
  });

  it('opens for a no-auth backend (authDisabled) with an empty token', () => {
    setSession('sess-noauth');
    useAuthStore.setState({ token: null, authDisabled: true });
    renderHook(() => useJobEventsStream());
    expect(instances).toHaveLength(1);
    expect(instances[0]!.opts.token).toBe('');
  });

  it('opens nothing when sessionId is null', () => {
    setSession(null);
    useAuthStore.setState({ token: 't'.repeat(64) });
    renderHook(() => useJobEventsStream());
    expect(instances).toHaveLength(0);
  });

  it('opens nothing when token is null and auth is on', () => {
    setSession('sess-2');
    useAuthStore.setState({ token: null, authDisabled: false });
    renderHook(() => useJobEventsStream());
    expect(instances).toHaveLength(0);
  });

  it('disposes the prior stream and creates a fresh one on sessionId change', () => {
    setSession('sess-a');
    useAuthStore.setState({ token: 't'.repeat(64) });
    const { rerender } = renderHook(() => useJobEventsStream());
    expect(instances).toHaveLength(1);

    setSession('sess-b');
    rerender();

    expect(instances).toHaveLength(2);
    expect(instances[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(instances[1]!.opts.sessionId).toBe('sess-b');
    expect(instances[1]!.start).toHaveBeenCalledTimes(1);
  });

  it('disposes on unmount', () => {
    setSession('sess-x');
    useAuthStore.setState({ token: 't'.repeat(64) });
    const { unmount } = renderHook(() => useJobEventsStream());
    expect(instances).toHaveLength(1);
    unmount();
    expect(instances[0]!.dispose).toHaveBeenCalled();
  });

  it('the onError auth_failed callback clears the auth token', () => {
    setSession('sess-auth');
    useAuthStore.setState({ token: 't'.repeat(64) });
    const clearSpy = vi.spyOn(useAuthStore.getState(), 'clearToken');
    renderHook(() => useJobEventsStream());
    expect(instances).toHaveLength(1);
    // Fire the stream's onError with an auth_failed code.
    instances[0]!.opts.onError?.({ code: 'auth_failed', reason: 'stale' });
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});

describe('useJobEventsStream — staleness-sweep backstop timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    instances.length = 0;
    useSessionStore.setState({ sessionId: null });
    useAuthStore.setState({ token: null, authDisabled: false });
    useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    useJobsStore.setState({ jobs: {}, dismissedJobIds: [] });
  });

  it('fires sweepStaleJobs on the interval even with no session/stream open', () => {
    // The backstop runs for the whole app lifetime, independent of the
    // stream — the pill must clear even when no stream is open.
    const sweepSpy = vi.spyOn(useJobsStore.getState(), 'sweepStaleJobs');
    renderHook(() => useJobEventsStream());
    expect(instances).toHaveLength(0); // no session → no stream...
    expect(sweepSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(STALE_SWEEP_INTERVAL_MS);
    expect(sweepSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(STALE_SWEEP_INTERVAL_MS);
    expect(sweepSpy).toHaveBeenCalledTimes(2);
  });

  it('clears the sweep interval on unmount', () => {
    const sweepSpy = vi.spyOn(useJobsStore.getState(), 'sweepStaleJobs');
    const { unmount } = renderHook(() => useJobEventsStream());
    unmount();
    vi.advanceTimersByTime(STALE_SWEEP_INTERVAL_MS * 3);
    expect(sweepSpy).not.toHaveBeenCalled();
  });
});
