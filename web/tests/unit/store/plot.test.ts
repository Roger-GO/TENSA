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
import {
  DEFAULT_PLAYBACK_RATE,
  PLAYBACK_RATES,
  chartKeyOf,
  chartTitle,
  findClosestFrameIdx,
  groupLabel,
  parseColumnName,
  usePlotStore,
} from '@/store/plot';
import type { VarGroup } from '@/store/plot';

function reset(): void {
  usePlotStore.setState({
    selectedByRun: {},
    filterByRun: {},
    expandedByRun: {},
    scrubByRun: {},
    playingByRun: {},
    playbackRate: DEFAULT_PLAYBACK_RATE,
    cursorsByRun: {},
    cursorsArmed: false,
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

describe('plot store: playback speed', () => {
  beforeEach(reset);
  afterEach(reset);

  it('offers 0.25x up to 10x and starts at real time', () => {
    expect(PLAYBACK_RATES[0]).toBe(0.25);
    expect(PLAYBACK_RATES[PLAYBACK_RATES.length - 1]).toBe(10);
    expect(PLAYBACK_RATES).toContain(1);
    expect(usePlotStore.getState().playbackRate).toBe(1);
  });

  it('setPlaybackRate takes every offered speed', () => {
    for (const rate of PLAYBACK_RATES) {
      usePlotStore.getState().setPlaybackRate(rate);
      expect(usePlotStore.getState().playbackRate).toBe(rate);
    }
  });

  it('ignores a speed that is not offered, so a bad rate never reaches the loop', () => {
    usePlotStore.getState().setPlaybackRate(5);
    for (const bad of [0, -1, 3, 11, Number.NaN, Number.POSITIVE_INFINITY]) {
      usePlotStore.getState().setPlaybackRate(bad);
      expect(usePlotStore.getState().playbackRate).toBe(5);
    }
  });

  it('is one speed for every run: resetRun and clearAll leave it alone', () => {
    usePlotStore.getState().setPlaybackRate(0.5);
    usePlotStore.getState().resetRun('r1');
    expect(usePlotStore.getState().playbackRate).toBe(0.5);
    usePlotStore.getState().clearAll();
    expect(usePlotStore.getState().playbackRate).toBe(0.5);
  });
});

describe('parseColumnName (smoke — full coverage lives in TimeSeriesPlot tests)', () => {
  it('classifies Bus_<n>_v as bus_v (field v)', () => {
    expect(parseColumnName('Bus_5_v')).toEqual({
      name: 'Bus_5_v',
      group: 'bus_v',
      elementIdx: '5',
      field: 'v',
    });
  });

  it('classifies Bus_<n>_a (angle) into the bus_v group with field a', () => {
    expect(parseColumnName('Bus_5_a')).toEqual({
      name: 'Bus_5_a',
      group: 'bus_v',
      elementIdx: '5',
      field: 'a',
    });
  });

  it('classifies Gen_<n>_omega / _delta as gen_state', () => {
    expect(parseColumnName('Gen_1_omega')).toEqual({
      name: 'Gen_1_omega',
      group: 'gen_state',
      elementIdx: '1',
      field: 'omega',
    });
    expect(parseColumnName('Gen_1_delta')).toEqual({
      name: 'Gen_1_delta',
      group: 'gen_state',
      elementIdx: '1',
      field: 'delta',
    });
  });

  it('routes Gen_<n>_Pe / _Qe into the dedicated gen_power group', () => {
    expect(parseColumnName('Gen_2_Pe')).toEqual({
      name: 'Gen_2_Pe',
      group: 'gen_power',
      elementIdx: '2',
      field: 'Pe',
    });
    expect(parseColumnName('Gen_2_Qe')).toEqual({
      name: 'Gen_2_Qe',
      group: 'gen_power',
      elementIdx: '2',
      field: 'Qe',
    });
  });

  it('classifies Line_<n>_p / _q as line_flow', () => {
    expect(parseColumnName('Line_3_p')).toEqual({
      name: 'Line_3_p',
      group: 'line_flow',
      elementIdx: '3',
      field: 'p',
    });
    expect(parseColumnName('Line_3_q')).toEqual({
      name: 'Line_3_q',
      group: 'line_flow',
      elementIdx: '3',
      field: 'q',
    });
  });

  it('classifies Load_<n>_p / _q into the load_pq group', () => {
    expect(parseColumnName('Load_7_p')).toEqual({
      name: 'Load_7_p',
      group: 'load_pq',
      elementIdx: '7',
      field: 'p',
    });
    expect(parseColumnName('Load_7_q')).toEqual({
      name: 'Load_7_q',
      group: 'load_pq',
      elementIdx: '7',
      field: 'q',
    });
  });

  it('handles non-numeric element idxs (e.g. named devices)', () => {
    expect(parseColumnName('Gen_GENROU_1_Pe')).toEqual({
      name: 'Gen_GENROU_1_Pe',
      group: 'gen_power',
      elementIdx: 'GENROU_1',
      field: 'Pe',
    });
  });

  it('returns null for unknown shapes', () => {
    expect(parseColumnName('garbage_column')).toBeNull();
    // A bus field outside v|a doesn't match.
    expect(parseColumnName('Bus_5_z')).toBeNull();
    // A gen field outside the known set doesn't match.
    expect(parseColumnName('Gen_1_Pm')).toBeNull();
  });
});

describe('parseColumnName: ANDES variables named as dae.x_name / dae.y_name name them', () => {
  it('splits <variable> <Model> <idx> into the variable and the device', () => {
    expect(parseColumnName('omega GENROU 1')).toEqual({
      name: 'omega GENROU 1',
      group: 'dae',
      elementIdx: 'GENROU 1',
      field: 'omega',
    });
    expect(parseColumnName('LL_x TGOV1 2')).toMatchObject({
      group: 'dae',
      elementIdx: 'TGOV1 2',
      field: 'LL_x',
    });
    // A string idx that does not hold the model name keeps all of it.
    expect(parseColumnName('delta GENROU G 2')).toMatchObject({
      elementIdx: 'GENROU G 2',
      field: 'delta',
    });
  });

  it('leaves the streamed groups alone, whatever an idx holds', () => {
    expect(parseColumnName('Bus_1_v')).toMatchObject({ group: 'bus_v' });
    expect(parseColumnName('Gen_GENROU_1_omega')).toMatchObject({ group: 'gen_state' });
    // A space inside an idx still belongs to the group's own column.
    expect(parseColumnName('Bus_A 1_v')).toMatchObject({ group: 'bus_v', elementIdx: 'A 1' });
  });

  it('does not take a lone word or a variable and a model without a device for one', () => {
    expect(parseColumnName('omega')).toBeNull();
    expect(parseColumnName('omega GENROU')).toBeNull();
  });
});

describe('chartKeyOf: which chart a series is drawn on', () => {
  it('is the group for a streamed group', () => {
    expect(chartKeyOf({ group: 'bus_v', field: 'a' })).toBe('bus_v');
    expect(chartKeyOf({ group: 'line_flow', field: 'p' })).toBe('line_flow');
  });

  it('is one chart per variable for ANDES variables, so only like quantities share a scale', () => {
    expect(chartKeyOf({ group: 'dae', field: 'omega' })).toBe('dae:omega');
    expect(chartKeyOf({ group: 'dae', field: 'vf' })).toBe('dae:vf');
  });
});

describe('plot store: A/B cursors', () => {
  beforeEach(reset);
  afterEach(reset);

  it('places A, then B, and a third click starts over from A', () => {
    const { placeCursor } = usePlotStore.getState();
    placeCursor('r1', 1.0);
    expect(usePlotStore.getState().cursorsByRun['r1']).toEqual({ a: 1.0, b: null });
    placeCursor('r1', 3.0);
    expect(usePlotStore.getState().cursorsByRun['r1']).toEqual({ a: 1.0, b: 3.0 });
    placeCursor('r1', 2.0);
    expect(usePlotStore.getState().cursorsByRun['r1']).toEqual({ a: 2.0, b: null });
  });

  it('keeps the cursors as placed: B may sit before A', () => {
    usePlotStore.getState().placeCursor('r1', 5);
    usePlotStore.getState().placeCursor('r1', 2);
    expect(usePlotStore.getState().cursorsByRun['r1']).toEqual({ a: 5, b: 2 });
  });

  it('moves one cursor without touching the other, and takes one off with null', () => {
    usePlotStore.getState().placeCursor('r1', 1);
    usePlotStore.getState().placeCursor('r1', 2);
    usePlotStore.getState().setCursor('r1', 'b', 2.5);
    expect(usePlotStore.getState().cursorsByRun['r1']).toEqual({ a: 1, b: 2.5 });
    usePlotStore.getState().setCursor('r1', 'a', null);
    expect(usePlotStore.getState().cursorsByRun['r1']).toEqual({ a: null, b: 2.5 });
  });

  it('is per run', () => {
    usePlotStore.getState().placeCursor('r1', 1);
    usePlotStore.getState().placeCursor('r2', 9);
    expect(usePlotStore.getState().cursorsByRun['r1']).toEqual({ a: 1, b: null });
    expect(usePlotStore.getState().cursorsByRun['r2']).toEqual({ a: 9, b: null });
  });

  it('clearCursors takes both off one run', () => {
    usePlotStore.getState().placeCursor('r1', 1);
    usePlotStore.getState().placeCursor('r2', 2);
    usePlotStore.getState().clearCursors('r1');
    expect(usePlotStore.getState().cursorsByRun['r1']).toBeUndefined();
    expect(usePlotStore.getState().cursorsByRun['r2']).toBeDefined();
  });

  it('click-to-place is off until asked for, for every run', () => {
    expect(usePlotStore.getState().cursorsArmed).toBe(false);
    usePlotStore.getState().setCursorsArmed(true);
    expect(usePlotStore.getState().cursorsArmed).toBe(true);
  });

  it('resetRun and clearAll drop the cursors with the rest of the run, and leave the mode', () => {
    usePlotStore.getState().setCursorsArmed(true);
    usePlotStore.getState().placeCursor('r1', 1);
    usePlotStore.getState().placeCursor('r2', 2);
    usePlotStore.getState().resetRun('r1');
    expect(usePlotStore.getState().cursorsByRun['r1']).toBeUndefined();
    expect(usePlotStore.getState().cursorsByRun['r2']).toBeDefined();
    usePlotStore.getState().clearAll();
    expect(usePlotStore.getState().cursorsByRun).toEqual({});
    expect(usePlotStore.getState().cursorsArmed).toBe(true);
  });
});

describe('group labels are exhaustive over VarGroup', () => {
  const ALL_GROUPS: readonly VarGroup[] = [
    'bus_v',
    'gen_state',
    'gen_power',
    'line_flow',
    'load_pq',
    'dae',
  ];

  it('groupLabel returns a non-empty string for every group', () => {
    for (const g of ALL_GROUPS) {
      expect(groupLabel(g)).toBeTruthy();
      expect(typeof groupLabel(g)).toBe('string');
    }
  });

  it('labels are distinct per group (no accidental copy-paste collision on names)', () => {
    const labels = ALL_GROUPS.map(groupLabel);
    expect(new Set(labels).size).toBe(ALL_GROUPS.length);
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

describe('chartTitle', () => {
  const fields = (...f: string[]) => new Set(f);

  it('names the bus quantities a chart draws', () => {
    expect(chartTitle('bus_v', fields('v'))).toBe('Bus voltage');
    expect(chartTitle('bus_v', fields('a'))).toBe('Bus angle');
    expect(chartTitle('bus_v', fields('v', 'a'))).toBe('Bus voltage and angle');
  });

  it('names the machine quantities a chart draws', () => {
    expect(chartTitle('gen_state', fields('omega'))).toBe('Generator speed');
    expect(chartTitle('gen_state', fields('delta'))).toBe('Generator rotor angle');
    expect(chartTitle('gen_state', fields('omega', 'delta'))).toBe(
      'Generator speed and rotor angle',
    );
  });

  it('names the chart of an ANDES variable for the variable', () => {
    expect(chartTitle('dae', fields('omega'))).toBe('omega · ANDES variable');
  });

  it('leaves the groups that hold one kind of quantity with their group label', () => {
    for (const g of ['gen_power', 'line_flow', 'load_pq'] as const) {
      expect(chartTitle(g, fields('p', 'q'))).toBe(groupLabel(g));
    }
  });
});
