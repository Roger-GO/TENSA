/**
 * Tests for `useSafeTimeout`: a timer that is cleared when the component
 * unmounts, and never starts once it has.
 */
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { useSafeTimeout } from '@/lib/useSafeTimeout';

type Schedule = ReturnType<typeof useSafeTimeout>;

/** Mount a component that exposes the hook's `schedule` function. */
function mountProbe(options: { strict?: boolean } = {}) {
  const box: { schedule: Schedule | null } = { schedule: null };
  function Probe() {
    box.schedule = useSafeTimeout();
    return null;
  }
  const utils = render(
    options.strict ? (
      <StrictMode>
        <Probe />
      </StrictMode>
    ) : (
      <Probe />
    ),
  );
  return {
    ...utils,
    schedule: ((callback, delayMs) => box.schedule!(callback, delayMs)) as Schedule,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useSafeTimeout', () => {
  it('runs the callback once after the delay', () => {
    const { schedule } = mountProbe();
    const callback = vi.fn();
    schedule(callback, 500);

    vi.advanceTimersByTime(499);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('keeps several timers apart', () => {
    const { schedule } = mountProbe();
    const early = vi.fn();
    const late = vi.fn();
    schedule(early, 100);
    schedule(late, 300);

    vi.advanceTimersByTime(100);
    expect(early).toHaveBeenCalledTimes(1);
    expect(late).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('clears every pending timer when the component unmounts', () => {
    const { schedule, unmount } = mountProbe();
    const first = vi.fn();
    const second = vi.fn();
    schedule(first, 100);
    schedule(second, 900);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(2000);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it('starts nothing when called after the component unmounted', () => {
    const { schedule, unmount } = mountProbe();
    unmount();

    // A request that resolves after the dialog was dismissed ends up here.
    const callback = vi.fn();
    schedule(callback, 100);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(callback).not.toHaveBeenCalled();
  });

  it('hands out the same function on every render', () => {
    const seen: Schedule[] = [];
    function Probe() {
      seen.push(useSafeTimeout());
      return null;
    }
    const { rerender } = render(<Probe />);
    rerender(<Probe />);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seen).size).toBe(1);
  });

  it('still works under Strict Mode, which mounts, unmounts and mounts again', () => {
    const { schedule } = mountProbe({ strict: true });
    const callback = vi.fn();
    schedule(callback, 100);
    vi.advanceTimersByTime(100);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
