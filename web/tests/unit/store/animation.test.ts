/**
 * Tests for the ``animation`` slice — the per-bus overlay map fed by
 * the rAF tick driver in :func:`useSldFrameOverlay`. Selective-redraw
 * plumbing (suppress no-op band updates) is the make-or-break property
 * here, so the structural-equality tests carry their weight.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __internal,
  useAnimationStore,
  type BusOverlayMap,
  type FrameBusOverlay,
} from '@/store/animation';

function reset(): void {
  useAnimationStore.setState({ busOverlayByRun: {} });
}

function entry(band: FrameBusOverlay['band'], voltage: number): FrameBusOverlay {
  return { band, voltage };
}

describe('animation slice — setBusOverlayForRun', () => {
  beforeEach(reset);
  afterEach(reset);

  it('writes a fresh overlay for a runId', () => {
    const overlay: BusOverlayMap = new Map([
      ['1', entry('success', 1.0)],
      ['2', entry('danger', 0.92)],
    ]);
    useAnimationStore.getState().setBusOverlayForRun('r1', overlay);
    const stored = useAnimationStore.getState().busOverlayByRun['r1'];
    expect(stored).toBeDefined();
    expect(stored!.size).toBe(2);
    expect(stored!.get('1')?.band).toBe('success');
    expect(stored!.get('2')?.band).toBe('danger');
  });

  it('replaces the overlay when the band set changes', () => {
    const a: BusOverlayMap = new Map([['1', entry('success', 1.0)]]);
    const b: BusOverlayMap = new Map([['1', entry('danger', 0.92)]]);
    useAnimationStore.getState().setBusOverlayForRun('r1', a);
    const beforeRef = useAnimationStore.getState().busOverlayByRun['r1'];
    useAnimationStore.getState().setBusOverlayForRun('r1', b);
    const afterRef = useAnimationStore.getState().busOverlayByRun['r1'];
    expect(afterRef).not.toBe(beforeRef);
    expect(afterRef!.get('1')?.band).toBe('danger');
  });

  it('SKIPS the state update when bands are unchanged (selective-redraw guarantee)', () => {
    const a: BusOverlayMap = new Map([
      ['1', entry('success', 1.0)],
      ['2', entry('warning', 0.96)],
    ]);
    // A second map with the SAME bands but different voltage values —
    // simulating a frame tick where every bus's band is still in the
    // same window even though the underlying voltage drifted.
    const b: BusOverlayMap = new Map([
      ['1', entry('success', 0.999)],
      ['2', entry('warning', 0.961)],
    ]);
    useAnimationStore.getState().setBusOverlayForRun('r1', a);
    const ref1 = useAnimationStore.getState().busOverlayByRun['r1'];
    useAnimationStore.getState().setBusOverlayForRun('r1', b);
    const ref2 = useAnimationStore.getState().busOverlayByRun['r1'];
    // Same reference → no setState fired → no Zustand subscriber re-render.
    expect(ref2).toBe(ref1);
  });

  it('REPLACES the state when the size changes (bus added)', () => {
    const a: BusOverlayMap = new Map([['1', entry('success', 1.0)]]);
    const b: BusOverlayMap = new Map([
      ['1', entry('success', 1.0)],
      ['2', entry('success', 1.0)],
    ]);
    useAnimationStore.getState().setBusOverlayForRun('r1', a);
    const ref1 = useAnimationStore.getState().busOverlayByRun['r1'];
    useAnimationStore.getState().setBusOverlayForRun('r1', b);
    const ref2 = useAnimationStore.getState().busOverlayByRun['r1'];
    expect(ref2).not.toBe(ref1);
  });
});

describe('animation slice — clearOverlayForRun', () => {
  beforeEach(reset);
  afterEach(reset);

  it('drops a single run from the map', () => {
    useAnimationStore.getState().setBusOverlayForRun('r1', new Map([['1', entry('success', 1.0)]]));
    useAnimationStore
      .getState()
      .setBusOverlayForRun('r2', new Map([['1', entry('warning', 0.96)]]));
    useAnimationStore.getState().clearOverlayForRun('r1');
    const map = useAnimationStore.getState().busOverlayByRun;
    expect(map['r1']).toBeUndefined();
    expect(map['r2']).toBeDefined();
  });

  it('is a no-op when the runId is unknown (does not allocate)', () => {
    const before = useAnimationStore.getState().busOverlayByRun;
    useAnimationStore.getState().clearOverlayForRun('does-not-exist');
    const after = useAnimationStore.getState().busOverlayByRun;
    expect(after).toBe(before);
  });
});

describe('animation slice — clearAll', () => {
  beforeEach(reset);
  afterEach(reset);

  it('drops every run', () => {
    useAnimationStore.getState().setBusOverlayForRun('r1', new Map([['1', entry('success', 1.0)]]));
    useAnimationStore
      .getState()
      .setBusOverlayForRun('r2', new Map([['1', entry('warning', 0.96)]]));
    useAnimationStore.getState().clearAll();
    expect(Object.keys(useAnimationStore.getState().busOverlayByRun)).toHaveLength(0);
  });
});

describe('bandsEqual (internal)', () => {
  it('returns true for identical band sets', () => {
    const a: BusOverlayMap = new Map([['1', entry('success', 1.0)]]);
    const b: BusOverlayMap = new Map([['1', entry('success', 0.999)]]);
    expect(__internal.bandsEqual(a, b)).toBe(true);
  });

  it('returns false on band mismatch even at the same idx', () => {
    const a: BusOverlayMap = new Map([['1', entry('success', 1.0)]]);
    const b: BusOverlayMap = new Map([['1', entry('warning', 0.96)]]);
    expect(__internal.bandsEqual(a, b)).toBe(false);
  });

  it('returns false on size mismatch', () => {
    const a: BusOverlayMap = new Map([['1', entry('success', 1.0)]]);
    const b: BusOverlayMap = new Map([
      ['1', entry('success', 1.0)],
      ['2', entry('success', 1.0)],
    ]);
    expect(__internal.bandsEqual(a, b)).toBe(false);
  });

  it('returns false when the bus idx set differs at the same size', () => {
    const a: BusOverlayMap = new Map([['1', entry('success', 1.0)]]);
    const b: BusOverlayMap = new Map([['2', entry('success', 1.0)]]);
    expect(__internal.bandsEqual(a, b)).toBe(false);
  });
});
