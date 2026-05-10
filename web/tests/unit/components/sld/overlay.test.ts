/**
 * Tests for `overlay.ts` — the pure helpers that translate a PflowResult
 * into per-bus / per-line visual state, AND the v0.2 frame-driven
 * helpers that derive the streaming overlay from a TDS run record.
 *
 * Voltage thresholds (per the plan): green 0.97-1.03 pu, amber
 * 0.95-0.97 + 1.03-1.05, red <0.95 or >1.05.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyVoltage,
  colorClassForBand,
  getBusOverlayState,
  getFrameBusOverlay,
  getLineOverlayState,
  pickFrameIdx,
} from '@/components/sld/overlay';
import type { PflowResult } from '@/api/types';
import { parseRunId } from '@/api/types';
import type { RunRecord } from '@/store/runs';

function makeResult(overrides: Partial<PflowResult> = {}): PflowResult {
  return {
    run_id: parseRunId('run-1'),
    converged: true,
    iterations: 4,
    mismatch: 1e-6,
    bus_voltages: {},
    bus_angles: {},
    line_flows: {},
    ...overrides,
  };
}

describe('classifyVoltage', () => {
  it('returns success for 1.00 pu', () => {
    expect(classifyVoltage(1.0)).toBe('success');
  });

  it('returns success for the band edges (0.97, 1.03)', () => {
    expect(classifyVoltage(0.97)).toBe('success');
    expect(classifyVoltage(1.03)).toBe('success');
  });

  it('returns warning for 0.96', () => {
    expect(classifyVoltage(0.96)).toBe('warning');
  });

  it('returns warning for 1.04', () => {
    expect(classifyVoltage(1.04)).toBe('warning');
  });

  it('returns danger for 0.92', () => {
    expect(classifyVoltage(0.92)).toBe('danger');
  });

  it('returns danger for 1.08', () => {
    expect(classifyVoltage(1.08)).toBe('danger');
  });

  it('returns neutral for non-finite', () => {
    expect(classifyVoltage(NaN)).toBe('neutral');
    expect(classifyVoltage(Infinity)).toBe('neutral');
  });
});

describe('getBusOverlayState', () => {
  it('returns neutral when pflowResult is null', () => {
    const result = getBusOverlayState('1', null);
    expect(result.band).toBe('neutral');
    expect(result.color_class).toBe('border-border');
    expect(result.voltage_label).toBeNull();
    expect(result.angle_label).toBeNull();
  });

  it('returns neutral when pflow did not converge', () => {
    const pflow = makeResult({
      converged: false,
      bus_voltages: { '1': 1.0 },
      bus_angles: { '1': 0 },
    });
    const result = getBusOverlayState('1', pflow);
    expect(result.band).toBe('neutral');
    expect(result.voltage_label).toBeNull();
  });

  it('returns success band + labels for in-band voltage', () => {
    const pflow = makeResult({
      bus_voltages: { '1': 1.0 },
      bus_angles: { '1': 0 },
    });
    const result = getBusOverlayState('1', pflow);
    expect(result.band).toBe('success');
    expect(result.color_class).toBe('border-success');
    expect(result.voltage_label).toBe('1.000 pu');
    expect(result.angle_label).toBe('0.00°');
  });

  it('formats voltage to 3 decimals + angle in degrees', () => {
    const pflow = makeResult({
      bus_voltages: { '5': 1.0612 },
      bus_angles: { '5': Math.PI / 18 }, // 10°
    });
    const result = getBusOverlayState('5', pflow);
    expect(result.voltage_label).toBe('1.061 pu');
    expect(result.angle_label).toBe('10.00°');
  });

  it('returns warning band for 0.96 pu', () => {
    const pflow = makeResult({
      bus_voltages: { '2': 0.96 },
      bus_angles: { '2': 0 },
    });
    const result = getBusOverlayState('2', pflow);
    expect(result.band).toBe('warning');
    expect(result.color_class).toBe('border-warning');
  });

  it('returns danger band for 0.92 pu', () => {
    const pflow = makeResult({
      bus_voltages: { '14': 0.92 },
      bus_angles: { '14': 0 },
    });
    const result = getBusOverlayState('14', pflow);
    expect(result.band).toBe('danger');
    expect(result.color_class).toBe('border-danger');
  });

  it('returns neutral when bus idx is missing from result', () => {
    const pflow = makeResult({
      bus_voltages: { '1': 1.0 },
      bus_angles: { '1': 0 },
    });
    const result = getBusOverlayState('99', pflow);
    expect(result.band).toBe('neutral');
    expect(result.voltage_label).toBeNull();
  });

  it('hides labels when hideLabels=true but keeps the band', () => {
    const pflow = makeResult({
      bus_voltages: { '1': 0.92 },
      bus_angles: { '1': 0 },
    });
    const result = getBusOverlayState('1', pflow, true);
    expect(result.band).toBe('danger');
    expect(result.color_class).toBe('border-danger');
    expect(result.voltage_label).toBeNull();
    expect(result.angle_label).toBeNull();
  });
});

describe('getLineOverlayState', () => {
  it('returns neutral when no result', () => {
    const result = getLineOverlayState('L1', null);
    expect(result.has_data).toBe(false);
    expect(result.direction).toBe('neutral');
  });

  it('returns neutral when not converged', () => {
    const pflow = makeResult({ converged: false });
    const result = getLineOverlayState('L1', pflow);
    expect(result.has_data).toBe(false);
  });

  it('returns forward direction for positive p', () => {
    const pflow = makeResult({
      line_flows: {
        L1: { p: 12.5, q: 3.2, from_idx: 1, to_idx: 2 },
      },
    });
    const result = getLineOverlayState('L1', pflow);
    expect(result.has_data).toBe(true);
    expect(result.direction).toBe('forward');
    expect(result.p_label).toBe('12.50 MW');
    expect(result.q_label).toBe('3.20 MVAr');
  });

  it('returns reverse direction for negative p', () => {
    const pflow = makeResult({
      line_flows: {
        L2: { p: -8.7, q: 1.0, from_idx: 1, to_idx: 2 },
      },
    });
    const result = getLineOverlayState('L2', pflow);
    expect(result.direction).toBe('reverse');
    expect(result.p_label).toBe('-8.70 MW');
  });

  it('returns neutral when line idx is missing', () => {
    const pflow = makeResult({ line_flows: { L1: { p: 1, q: 1, from_idx: 1, to_idx: 2 } } });
    const result = getLineOverlayState('L99', pflow);
    expect(result.has_data).toBe(false);
  });

  it('hides labels when hideLabels=true but keeps direction', () => {
    const pflow = makeResult({
      line_flows: { L1: { p: 5, q: 1, from_idx: 1, to_idx: 2 } },
    });
    const result = getLineOverlayState('L1', pflow, true);
    expect(result.direction).toBe('forward');
    expect(result.p_label).toBeNull();
    expect(result.q_label).toBeNull();
  });
});

// ---- frame-driven overlay (v0.2 Unit 5) ---------------------------------

/**
 * Build a synthetic RunRecord whose ``columns`` mimic the runs slice's
 * over-allocated typed arrays. The ``columnNames`` list is the
 * authoritative column set the frame-overlay walker iterates.
 */
function makeRun(options: {
  seqCount: number;
  t: number[];
  busColumns: Record<string, number[]>;
  extraColumns?: Record<string, number[]>;
  state?: RunRecord['state'];
}): RunRecord {
  const { seqCount, t, busColumns, extraColumns = {}, state = 'streaming' } = options;
  const columns: Record<string, Float64Array> = {};
  const columnNames: string[] = [];
  for (const [idx, values] of Object.entries(busColumns)) {
    const name = `Bus_${idx}_v`;
    columns[name] = new Float64Array(values);
    columnNames.push(name);
  }
  for (const [name, values] of Object.entries(extraColumns)) {
    columns[name] = new Float64Array(values);
    columnNames.push(name);
  }
  return {
    runId: 'run-test',
    startedAt: 0,
    tf: 10,
    tCurrent: t[t.length - 1] ?? 0,
    seqCount,
    t: new Float64Array(t),
    columns,
    columnNames,
    state,
    connection: 'connected',
    abortedLocally: false,
    errorReason: null,
  };
}

describe('colorClassForBand', () => {
  it('maps each band to its tailwind border class', () => {
    expect(colorClassForBand('success')).toBe('border-success');
    expect(colorClassForBand('warning')).toBe('border-warning');
    expect(colorClassForBand('danger')).toBe('border-danger');
    expect(colorClassForBand('neutral')).toBe('border-border');
  });
});

describe('pickFrameIdx', () => {
  it('returns -1 when seqCount is 0', () => {
    const run = makeRun({ seqCount: 0, t: [], busColumns: { '1': [] } });
    expect(pickFrameIdx(run, null)).toBe(-1);
    expect(pickFrameIdx(run, 1.5)).toBe(-1);
  });

  it('live mode (scrubT === null) → seqCount - 1', () => {
    const run = makeRun({
      seqCount: 5,
      t: [0, 0.5, 1, 1.5, 2],
      busColumns: { '1': [1, 1, 1, 1, 1] },
    });
    expect(pickFrameIdx(run, null)).toBe(4);
  });

  it('scrub mode picks the closest frame at-or-before the requested t', () => {
    const run = makeRun({
      seqCount: 5,
      t: [0, 0.5, 1, 1.5, 2],
      busColumns: { '1': [1, 1, 1, 1, 1] },
    });
    expect(pickFrameIdx(run, 1.0)).toBe(2);
    // 1.4 → frame at 1.0 (last <= 1.4 is index 2).
    expect(pickFrameIdx(run, 1.4)).toBe(2);
    // 1.5 lands exactly on frame 3.
    expect(pickFrameIdx(run, 1.5)).toBe(3);
  });

  it('returns the last frame when scrubT > t_max (run extended after seek)', () => {
    const run = makeRun({
      seqCount: 3,
      t: [0, 1, 2],
      busColumns: { '1': [1, 1, 1] },
    });
    // User scrubbed to t=5.0, but the run has only buffered up to t=2.
    expect(pickFrameIdx(run, 5.0)).toBe(2);
  });

  it('returns -1 when scrubT < t[0]', () => {
    const run = makeRun({
      seqCount: 3,
      t: [1, 2, 3],
      busColumns: { '1': [1, 1, 1] },
    });
    expect(pickFrameIdx(run, 0.5)).toBe(-1);
  });
});

describe('getFrameBusOverlay', () => {
  it('returns an empty map when frameIdx is -1 (no buffered frames yet)', () => {
    const run = makeRun({ seqCount: 0, t: [], busColumns: { '1': [] } });
    const overlay = getFrameBusOverlay(run, -1);
    expect(overlay.size).toBe(0);
  });

  it('extracts bus voltages from the chosen frame and classifies bands', () => {
    const run = makeRun({
      seqCount: 3,
      t: [0, 1, 2],
      busColumns: {
        '1': [1.0, 0.96, 0.92],
        '2': [1.0, 1.04, 1.08],
      },
    });
    // Frame 0: both buses at 1.0 → success.
    const f0 = getFrameBusOverlay(run, 0);
    expect(f0.get('1')?.band).toBe('success');
    expect(f0.get('1')?.voltage).toBe(1.0);
    expect(f0.get('2')?.band).toBe('success');

    // Frame 1: 0.96 + 1.04 → warning bands.
    const f1 = getFrameBusOverlay(run, 1);
    expect(f1.get('1')?.band).toBe('warning');
    expect(f1.get('2')?.band).toBe('warning');

    // Frame 2: 0.92 + 1.08 → danger bands.
    const f2 = getFrameBusOverlay(run, 2);
    expect(f2.get('1')?.band).toBe('danger');
    expect(f2.get('1')?.voltage).toBeCloseTo(0.92, 5);
    expect(f2.get('2')?.band).toBe('danger');
  });

  it('skips non-bus_v columns (Gen_*, Line_*) when building the bus overlay', () => {
    const run = makeRun({
      seqCount: 2,
      t: [0, 1],
      busColumns: { '1': [1.0, 0.99] },
      extraColumns: {
        Gen_g1_omega: [1.0, 1.001],
        Line_l1_p: [50, 51],
        Line_l1_q: [10, 11],
      },
    });
    const overlay = getFrameBusOverlay(run, 1);
    // Only the bus column showed up.
    expect(overlay.size).toBe(1);
    expect(overlay.get('1')?.band).toBe('success');
    expect(overlay.has('g1')).toBe(false);
    expect(overlay.has('l1')).toBe(false);
  });

  it('does not over-read the over-allocated typed-array tail', () => {
    // Simulate a run whose typed arrays have capacity > seqCount (the
    // runs slice grows geometrically; the tail is uninitialised /
    // zero). A request for an out-of-range frame must NOT classify the
    // zero-tail value as 'danger' (which 0 < 0.95 would otherwise be).
    const t = new Float64Array(8);
    t.set([0, 0.5, 1.0]);
    const v = new Float64Array(8);
    v.set([1.0, 1.0, 0.99]);
    const run: RunRecord = {
      runId: 'r',
      startedAt: 0,
      tf: 10,
      tCurrent: 1.0,
      seqCount: 3,
      t,
      columns: { Bus_1_v: v },
      columnNames: ['Bus_1_v'],
      state: 'streaming',
      connection: 'connected',
      abortedLocally: false,
      errorReason: null,
    };
    // frameIdx >= seqCount → no extraction.
    const overlay = getFrameBusOverlay(run, 5);
    expect(overlay.size).toBe(0);
  });

  it('end-to-end happy path: scrubT = 1.5 → bus shows the closest-frame band', () => {
    const run = makeRun({
      seqCount: 5,
      t: [0, 0.5, 1.0, 1.5, 2.0],
      busColumns: { '1': [1.0, 1.0, 1.0, 0.96, 0.92] },
    });
    const idx = pickFrameIdx(run, 1.5);
    const overlay = getFrameBusOverlay(run, idx);
    expect(overlay.get('1')?.band).toBe('warning');
    expect(overlay.get('1')?.voltage).toBeCloseTo(0.96, 5);
  });

  it('end-to-end happy path: scrubT === null → bus shows the latest-frame band', () => {
    const run = makeRun({
      seqCount: 4,
      t: [0, 0.5, 1.0, 1.5],
      busColumns: { '1': [1.0, 1.0, 1.0, 0.92] },
    });
    const idx = pickFrameIdx(run, null);
    const overlay = getFrameBusOverlay(run, idx);
    expect(overlay.get('1')?.band).toBe('danger');
  });
});
