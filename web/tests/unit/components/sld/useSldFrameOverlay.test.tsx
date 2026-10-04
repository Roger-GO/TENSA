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
import type { ReactNode } from 'react';
import { render, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSldFrameOverlay } from '@/components/sld/overlay';
import { queryKeys } from '@/api/queries';
import { parseSessionId } from '@/api/types';
import type { TopologyEntry, TopologySummary } from '@/api/types';
import { useRunsStore } from '@/store/runs';
import { usePlotStore } from '@/store/plot';
import { useAnimationStore } from '@/store/animation';
import { useSessionStore } from '@/store/session';

function HookHost() {
  useSldFrameOverlay();
  return null;
}

let queryClient: QueryClient;

/** Mount the hook where it lives in the app: under the query client. */
function renderHost() {
  return render(<HookHost />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

const SESSION = parseSessionId('s-limits');

function busEntry(idx: string, params: TopologyEntry['params']): TopologyEntry {
  return { idx, name: `b${idx}`, kind: 'Bus', params };
}

function topologyOf(...buses: TopologyEntry[]): TopologySummary {
  return { state: 'committed', buses, lines: [], transformers: [], generators: [], loads: [] };
}

/** Open a session whose cached topology holds these buses. */
function openSessionWith(topology: TopologySummary): void {
  useSessionStore.setState({ sessionId: SESSION });
  queryClient.setQueryData(queryKeys.topology(SESSION), topology);
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
  useSessionStore.setState({ sessionId: null });
}

describe('useSldFrameOverlay', () => {
  let scheduler: ReturnType<typeof installRafScheduler>;

  beforeEach(() => {
    reset();
    queryClient = new QueryClient();
    scheduler = installRafScheduler();
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
    scheduler.restore();
    reset();
  });

  it('does not schedule rAF when there is no active run', () => {
    renderHost();
    expect(scheduler.hasPending()).toBe(false);
  });

  it('writes the latest-frame overlay into the animation slice on each tick', () => {
    seedRun('r1');
    appendRows('r1', [0, 0.5, 1.0], {
      Bus_1_v: [1.0, 0.96, 0.92],
      Bus_2_v: [1.0, 1.0, 1.04],
    });
    renderHost();
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
    renderHost();
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
    renderHost();
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
    renderHost();
    scheduler.tick();
    // Frame closest to t=1 is index 1 → bus 1 should be in warning.
    expect(useAnimationStore.getState().busOverlayByRun['r1']!.get('1')?.band).toBe('warning');
  });

  it('clears the previous run overlay when the active run id changes', () => {
    seedRun('r1');
    appendRows('r1', [0, 1], {
      Bus_1_v: [1.0, 0.92],
    });
    renderHost();
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
    const { unmount } = renderHost();
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
    renderHost();
    scheduler.tick();
    expect(useAnimationStore.getState().busOverlayByRun['r1']!.size).toBe(14);
    // After the tick, EXACTLY one rAF is scheduled (not 14).
    expect(scheduler.hasPending()).toBe(true);
    scheduler.tick();
    expect(scheduler.hasPending()).toBe(true);
  });

  describe("the open case's bus limits", () => {
    it("classifies each streamed bus on its own limits from the case's topology", () => {
      openSessionWith(
        topologyOf(
          busEntry('1', { vmin: 0.9, vmax: 1.1 }),
          busEntry('2', { vmin: 0.95, vmax: 1.05 }),
          busEntry('3', {}),
        ),
      );
      seedRun('r1', ['Bus_1_v', 'Bus_2_v', 'Bus_3_v']);
      appendRows('r1', [0, 1], {
        Bus_1_v: [1.0, 1.07],
        Bus_2_v: [1.0, 1.07],
        Bus_3_v: [1.0, 1.07],
      });
      renderHost();
      scheduler.tick();
      const overlay = useAnimationStore.getState().busOverlayByRun['r1']!;
      // 1.07 pu is clear on the wide 0.9 / 1.1 band, past 1.05 on the other two.
      expect(overlay.get('1')).toMatchObject({ band: 'success', side: null });
      expect(overlay.get('2')).toMatchObject({ band: 'danger', side: 'high' });
      expect(overlay.get('3')).toMatchObject({ band: 'danger', side: 'high' });
    });

    it('uses the default limits until the topology has been fetched', () => {
      useSessionStore.setState({ sessionId: SESSION });
      seedRun('r1');
      appendRows('r1', [0, 1], { Bus_1_v: [1.0, 1.07], Bus_2_v: [1.0, 1.0] });
      renderHost();
      scheduler.tick();
      const overlay = useAnimationStore.getState().busOverlayByRun['r1']!;
      expect(overlay.get('1')).toMatchObject({ band: 'danger', side: 'high' });
      expect(overlay.get('2')).toMatchObject({ band: 'success', side: null });
    });

    it('picks up an edited limit on the next tick, without remounting', () => {
      openSessionWith(topologyOf(busEntry('1', { vmin: 0.9, vmax: 1.1 })));
      seedRun('r1', ['Bus_1_v']);
      appendRows('r1', [0, 1], { Bus_1_v: [1.0, 1.07] });
      renderHost();
      scheduler.tick();
      expect(useAnimationStore.getState().busOverlayByRun['r1']!.get('1')?.band).toBe('success');

      // The user tightens the bus's vmax in the inspector; the topology refetch
      // lands in the query cache.
      act(() => {
        queryClient.setQueryData(
          queryKeys.topology(SESSION),
          topologyOf(busEntry('1', { vmin: 0.9, vmax: 1.06 })),
        );
      });
      scheduler.tick();
      expect(useAnimationStore.getState().busOverlayByRun['r1']!.get('1')).toMatchObject({
        band: 'danger',
        side: 'high',
      });
    });
  });
});
