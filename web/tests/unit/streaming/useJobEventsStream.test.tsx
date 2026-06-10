/**
 * Tests for ``useJobEventsStream`` (v3.1 Unit 11) — the app-root owner of the
 * per-session ``JobStream`` lifecycle.
 *
 * Coverage:
 *  - opens + starts exactly one stream when sessionId is set;
 *  - opens NOTHING when sessionId is null;
 *  - a sessionId change disposes the prior stream and creates a fresh one;
 *  - unmount disposes.
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
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('opens + starts one stream when sessionId is set', () => {
    setSession('sess-1');
    renderHook(() => useJobEventsStream());
    expect(instances).toHaveLength(1);
    expect(instances[0]!.start).toHaveBeenCalledTimes(1);
    expect(instances[0]!.opts.sessionId).toBe('sess-1');
  });

  it('opens nothing when sessionId is null', () => {
    setSession(null);
    renderHook(() => useJobEventsStream());
    expect(instances).toHaveLength(0);
  });

  it('disposes the prior stream and creates a fresh one on sessionId change', () => {
    setSession('sess-a');
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
    const { unmount } = renderHook(() => useJobEventsStream());
    expect(instances).toHaveLength(1);
    unmount();
    expect(instances[0]!.dispose).toHaveBeenCalled();
  });
});

describe('useJobEventsStream — staleness-sweep backstop timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    instances.length = 0;
    useSessionStore.setState({ sessionId: null });
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
