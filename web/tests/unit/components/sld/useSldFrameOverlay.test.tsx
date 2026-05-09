/**
 * Tests for ``useSldFrameOverlay`` — the SINGLE rAF loop driving the
 * SLD streaming overlay. Mounted once at the App root in production;
 * the hook is responsible for:
 *
 *  - Reading the active run's latest frame on every rAF tick.
 *  - Computing the per-bus overlay map.
 *  - Writing it into the animation slice.
 *  - Tearing down the loop when the run finishes (and isn't being
 *    scrubbed) or when the active run id changes.
 *
 * jsdom doesn't run rAF on its own; we install a manual scheduler that
 * lets the test step the loop one tick at a time. Same approach the
 * ScrubControl test uses for its playback rAF.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useSldFrameOverlay } from '@/components/sld/overlay';
import { useRunsStore } from '@/store/runs';
import { usePlotStore } from '@/store/plot';
import { useAnimationStore } from '@/store/animation';

function HookHost() {
  useSldFrameOverlay();
  return null;
}

function installRafScheduler() {
  let nextHandle = 1;
  let pending: { handle: number; cb: FrameRequestCallback } | null = null;
  let now = 0;
  const origRaf = window.requestAnimationFrame;
  const origCaf = window.cancelAnimationFrame;
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const handle = nextHandle++;
    pending = { handle, cb };
    return handle;
  };
  window.cancelAnimationFrame = (handle: number) => {
    if (pending && pending.handle === handle) pending = null;
  };
  const tick = (dt = 16) => {
    now += dt;
    const p = pending;
    pending = null;
    if (p) {
      act(() => {
        p.cb(now);
      });
    }
  };
  const restore = () => {
    window.requestAnimationFrame = origRaf;
    window.cancelAnimationFrame = origCaf;
  };
  return { tick, restore, hasPending: () => pending !== null };
}

function seedRun(runId: string, columnNames: string[] = ['Bus_1_v', 'Bus_2_v']) {
  useRunsStore.setState({ runs: {}, activeRunId: null });
  useRunsStore.getState().startRun({ runId, tf: 10, columnNames });
}

function appendRows(runId: string, t: number[], cols: Record<string, number[]>) {
  const tArr = new Float64Array(t);
  const colArrs: Record<string, Float64Array> = {};
  for (const k of Object.keys(cols)) colArrs[k] = new Float64Array(cols[k]!);
  useRunsStore.getState().appendFrame(runId, { t: tArr, columns: colArrs });
}

function reset() {
  useRunsStore.setState({ runs: {}, activeRunId: null });
  usePlotStore.setState({
    selectedByRun: {},
    filterByRun: {},
    expandedByRun: {},
    scrubByRun: {},
    playingByRun: {},
  });
  useAnimationStore.setState({ busOverlayByRun: {} });
}

describe('useSldFrameOverlay', () => {
  let scheduler: ReturnType<typeof installRafScheduler>;

  beforeEach(() => {
    reset();
    scheduler = installRafScheduler();
  });

  afterEach(() => {
    cleanup();
    scheduler.restore();
    reset();
  });

  it('does not schedule rAF when there is no active run', () => {
    render(<HookHost />);
    expect(scheduler.hasPending()).toBe(false);
  });

  it('writes the latest-frame overlay into the animation slice on each tick', () => {
    seedRun('r1');
    appendRows('r1', [0, 0.5, 1.0], {
      Bus_1_v: [1.0, 0.96, 0.92],
      Bus_2_v: [1.0, 1.0, 1.04],
    });
    render(<HookHost />);
    // First tick processes the latest frame (live mode → seqCount-1 = 2).
    scheduler.tick();
    const overlay = useAnimationStore.getState().busOverlayByRun['r1'];
    expect(overlay).toBeDefined();
    expect(overlay!.get('1')?.band).toBe('danger');
    expect(overlay!.get('2')?.band).toBe('warning');
  });

  it('responds to scrubT changes within the next tick (no loop restart)', () => {
    seedRun('r1');
    appendRows('r1', [0, 1, 2], {
      Bus_1_v: [1.0, 1.0, 0.92],
      Bus_2_v: [1.0, 1.0, 1.0],
    });
    render(<HookHost />);
    // Tick once: live mode → bus 1 should be danger (frame 2).
    scheduler.tick();
    expect(useAnimationStore.getState().busOverlayByRun['r1']!.get('1')?.band).toBe('danger');

    // User scrubs to t=0.5 → expect frame 0 (success) on the next tick.
    act(() => {
      usePlotStore.getState().setScrubT('r1', 0.5);
    });
    scheduler.tick();
    expect(useAnimationStore.getState().busOverlayByRun['r1']!.get('1')?.band).toBe('success');
  });

  it('tears down the loop when the run completes (and is not scrubbed)', () => {
    seedRun('r1');
    appendRows('r1', [0, 1, 2], {
      Bus_1_v: [1.0, 1.0, 0.92],
      Bus_2_v: [1.0, 1.0, 1.0],
    });
    render(<HookHost />);
    scheduler.tick();
    expect(useAnimationStore.getState().busOverlayByRun['r1']).toBeDefined();

    // Run finishes → state flips to "done". The hook's effect re-runs
    // (we depend on activeRunState), the new tick fires its
    // ``isOverlayActive`` short-circuit on the first iteration, clears
    // the overlay, and does NOT reschedule.
    act(() => {
      useRunsStore.getState().markRunDone('r1', 2.0);
    });
    // After the cleanup + re-arm, the new tick fires and tears down.
    scheduler.tick();
    expect(useAnimationStore.getState().busOverlayByRun['r1']).toBeUndefined();
    expect(scheduler.hasPending()).toBe(false);
  });

  it('keeps animating a finished run while it is being scrubbed', () => {
    seedRun('r1');
    appendRows('r1', [0, 1, 2], {
      Bus_1_v: [1.0, 0.96, 0.92],
    });
    // Mark run done up front, then scrub to t=1 BEFORE mounting the
    // hook so the overlay-active branch fires on first tick.
    act(() => {
      useRunsStore.getState().markRunDone('r1', 2.0);
      usePlotStore.getState().setScrubT('r1', 1.0);
    });
    render(<HookHost />);
    scheduler.tick();
    // Frame closest to t=1 is index 1 → bus 1 should be in warning.
    expect(useAnimationStore.getState().busOverlayByRun['r1']!.get('1')?.band).toBe('warning');
  });

  it('clears the previous run overlay when the active run id changes', () => {
    seedRun('r1');
    appendRows('r1', [0, 1], {
      Bus_1_v: [1.0, 0.92],
    });
    render(<HookHost />);
    scheduler.tick();
    expect(useAnimationStore.getState().busOverlayByRun['r1']).toBeDefined();

    // Start a new run → activeRunId flips to r2 → the effect re-arms,
    // its cleanup clears the r1 overlay before the new loop starts.
    act(() => {
      useRunsStore.getState().startRun({
        runId: 'r2',
        tf: 5,
        columnNames: ['Bus_1_v'],
      });
    });
    expect(useAnimationStore.getState().busOverlayByRun['r1']).toBeUndefined();

    act(() => {
      appendRows('r2', [0, 1], { Bus_1_v: [1.0, 1.04] });
    });
    scheduler.tick();
    expect(useAnimationStore.getState().busOverlayByRun['r2']!.get('1')?.band).toBe('warning');
  });

  it('cancels the rAF and clears overlay on unmount', () => {
    seedRun('r1');
    appendRows('r1', [0, 1], {
      Bus_1_v: [1.0, 0.92],
    });
    const { unmount } = render(<HookHost />);
    scheduler.tick();
    expect(useAnimationStore.getState().busOverlayByRun['r1']).toBeDefined();
    expect(scheduler.hasPending()).toBe(true);

    unmount();
    expect(scheduler.hasPending()).toBe(false);
    expect(useAnimationStore.getState().busOverlayByRun['r1']).toBeUndefined();
  });

  it('runs ONE rAF loop regardless of how many bus overlays it produces', () => {
    // 14 buses (IEEE 14 scale) → still ONE pending rAF after a tick.
    const cols = Array.from({ length: 14 }, (_, i) => `Bus_${i + 1}_v`);
    seedRun('r1', cols);
    const tArr = [0, 1];
    const valuesByCol: Record<string, number[]> = {};
    for (const c of cols) valuesByCol[c] = [1.0, 1.0];
    appendRows('r1', tArr, valuesByCol);
    render(<HookHost />);
    scheduler.tick();
    expect(useAnimationStore.getState().busOverlayByRun['r1']!.size).toBe(14);
    // After the tick, EXACTLY one rAF is scheduled (not 14).
    expect(scheduler.hasPending()).toBe(true);
    scheduler.tick();
    expect(scheduler.hasPending()).toBe(true);
  });
});
