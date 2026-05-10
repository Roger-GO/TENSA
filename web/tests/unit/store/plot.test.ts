/**
 * Tests for the ``plot`` slice — selection / filter / expand state plus
 * the v0.2 scrubT + playing additions.
 *
 * The store predates a dedicated test file (the plot slice was
 * exercised entirely via component tests in v0.1). This file fills the
 * gap for the v0.2 surface area (scrubT setter, playing setter, reset
 * cascade, findClosestFrameIdx helper).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findClosestFrameIdx, parseColumnName, usePlotStore } from '@/store/plot';

function reset(): void {
  usePlotStore.setState({
    selectedByRun: {},
    filterByRun: {},
    expandedByRun: {},
    scrubByRun: {},
    playingByRun: {},
  });
}

describe('plot store — selection state', () => {
  beforeEach(reset);
  afterEach(reset);

  it('toggleSeries adds + removes a series for a run', () => {
    usePlotStore.getState().toggleSeries('r1', 'Bus_1_v');
    expect(usePlotStore.getState().selectedByRun['r1']!.has('Bus_1_v')).toBe(true);
    usePlotStore.getState().toggleSeries('r1', 'Bus_1_v');
    expect(usePlotStore.getState().selectedByRun['r1']!.has('Bus_1_v')).toBe(false);
  });

  it('setSelection replaces the whole set', () => {
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v', 'Bus_2_v']));
    const sel = usePlotStore.getState().selectedByRun['r1']!;
    expect(sel.size).toBe(2);
    usePlotStore.getState().setSelection('r1', new Set(['Bus_5_v']));
    const sel2 = usePlotStore.getState().selectedByRun['r1']!;
    expect(sel2.size).toBe(1);
    expect(sel2.has('Bus_5_v')).toBe(true);
  });

  it('toggleExpanded toggles a group key', () => {
    usePlotStore.getState().toggleExpanded('r1', 'bus_v');
    expect(usePlotStore.getState().expandedByRun['r1']!.has('bus_v')).toBe(true);
    usePlotStore.getState().toggleExpanded('r1', 'bus_v');
    expect(usePlotStore.getState().expandedByRun['r1']!.has('bus_v')).toBe(false);
  });
});

describe('plot store — scrubT + playing (v0.2)', () => {
  beforeEach(reset);
  afterEach(reset);

  it('defaults: scrubByRun + playingByRun start empty (live + paused)', () => {
    expect(usePlotStore.getState().scrubByRun).toEqual({});
    expect(usePlotStore.getState().playingByRun).toEqual({});
  });

  it('setScrubT to a number switches the run into scrub mode', () => {
    usePlotStore.getState().setScrubT('r1', 1.234);
    expect(usePlotStore.getState().scrubByRun['r1']).toBe(1.234);
  });

  it('setScrubT(null) returns the run to live mode', () => {
    usePlotStore.getState().setScrubT('r1', 1.0);
    usePlotStore.getState().setScrubT('r1', null);
    expect(usePlotStore.getState().scrubByRun['r1']).toBeNull();
  });

  it('setPlaying flips the per-run flag without touching scrubT', () => {
    usePlotStore.getState().setScrubT('r1', 0.5);
    usePlotStore.getState().setPlaying('r1', true);
    expect(usePlotStore.getState().playingByRun['r1']).toBe(true);
    expect(usePlotStore.getState().scrubByRun['r1']).toBe(0.5);
    usePlotStore.getState().setPlaying('r1', false);
    expect(usePlotStore.getState().playingByRun['r1']).toBe(false);
    // Pause does NOT clear scrubT.
    expect(usePlotStore.getState().scrubByRun['r1']).toBe(0.5);
  });

  it('scrubT + playing are independent across runs', () => {
    usePlotStore.getState().setScrubT('r1', 1);
    usePlotStore.getState().setScrubT('r2', 2);
    usePlotStore.getState().setPlaying('r1', true);
    expect(usePlotStore.getState().scrubByRun['r1']).toBe(1);
    expect(usePlotStore.getState().scrubByRun['r2']).toBe(2);
    expect(usePlotStore.getState().playingByRun['r1']).toBe(true);
    expect(usePlotStore.getState().playingByRun['r2']).toBeUndefined();
  });

  it('resetRun drops scrub + playing alongside selection state', () => {
    usePlotStore.getState().setSelection('r1', new Set(['Bus_1_v']));
    usePlotStore.getState().setScrubT('r1', 5);
    usePlotStore.getState().setPlaying('r1', true);
    usePlotStore.getState().resetRun('r1');
    expect(usePlotStore.getState().selectedByRun['r1']).toBeUndefined();
    expect(usePlotStore.getState().scrubByRun['r1']).toBeUndefined();
    expect(usePlotStore.getState().playingByRun['r1']).toBeUndefined();
  });

  it('clearAll wipes scrub + playing maps too', () => {
    usePlotStore.getState().setScrubT('r1', 1);
    usePlotStore.getState().setPlaying('r2', true);
    usePlotStore.getState().clearAll();
    expect(usePlotStore.getState().scrubByRun).toEqual({});
    expect(usePlotStore.getState().playingByRun).toEqual({});
  });

  it('scrubT survives unrelated state changes (selection toggle)', () => {
    usePlotStore.getState().setScrubT('r1', 2.5);
    usePlotStore.getState().toggleSeries('r1', 'Bus_1_v');
    expect(usePlotStore.getState().scrubByRun['r1']).toBe(2.5);
  });
});

describe('parseColumnName (smoke — full coverage lives in TimeSeriesPlot tests)', () => {
  it('classifies Bus_<n>_v as bus_v', () => {
    expect(parseColumnName('Bus_5_v')).toEqual({
      name: 'Bus_5_v',
      group: 'bus_v',
      elementIdx: '5',
      field: 'v',
    });
  });

  it('returns null for unknown shapes', () => {
    expect(parseColumnName('garbage_column')).toBeNull();
  });
});

describe('findClosestFrameIdx (binary search for scrub → frame index)', () => {
  it('returns -1 for empty arrays', () => {
    expect(findClosestFrameIdx(new Float64Array(0), 0, 1.0)).toBe(-1);
  });

  it('returns -1 when target is before the first frame', () => {
    const t = new Float64Array([0, 1, 2, 3]);
    expect(findClosestFrameIdx(t, 4, -0.5)).toBe(-1);
  });

  it('returns the last index when target is at or past the last frame', () => {
    const t = new Float64Array([0, 1, 2, 3]);
    expect(findClosestFrameIdx(t, 4, 3)).toBe(3);
    expect(findClosestFrameIdx(t, 4, 100)).toBe(3);
  });

  it('returns the index of the largest t <= target', () => {
    // Mirrors the plan's example: t=[0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
    // target 0.5 → idx 5 (the closest-prior frame).
    const t = new Float64Array([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    expect(findClosestFrameIdx(t, 7, 0.5)).toBe(5);
    // Slightly under 0.5 → idx 4.
    expect(findClosestFrameIdx(t, 7, 0.49)).toBe(4);
  });

  it('respects the logical length (over-allocated tails are ignored)', () => {
    // Simulates the runs-slice over-allocation: array is length 8 but
    // only 4 logical rows.
    const t = new Float64Array(8);
    t.set([0, 1, 2, 3]);
    // Tail rows are 0, 0, 0, 0 — but we pass length=4 so the search
    // ignores them.
    expect(findClosestFrameIdx(t, 4, 2.5)).toBe(2);
    expect(findClosestFrameIdx(t, 4, 100)).toBe(3);
  });

  it('handles single-frame arrays', () => {
    const t = new Float64Array([1.0]);
    expect(findClosestFrameIdx(t, 1, 0.5)).toBe(-1);
    expect(findClosestFrameIdx(t, 1, 1.0)).toBe(0);
    expect(findClosestFrameIdx(t, 1, 5.0)).toBe(0);
  });

  it('handles repeated t values (returns the latest index with t <= target)', () => {
    // Defensive — ANDES streams are monotonic, but the search should
    // still behave sensibly if a frame batch repeats a t value.
    const t = new Float64Array([0, 1, 1, 2]);
    expect(findClosestFrameIdx(t, 4, 1)).toBe(2);
  });
});
