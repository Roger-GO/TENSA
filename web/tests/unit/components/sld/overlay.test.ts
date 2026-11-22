/**
 * Tests for `overlay.ts` — the pure helpers that translate a PflowResult
 * into per-bus / per-line visual state. The v0.2 frame-driven helpers
 * (`pickFrameIdx`, `getFrameBusOverlay`) moved to `frameOverlay.ts` and are
 * covered by `frameOverlay.test.ts`; the re-exports are pinned below.
 *
 * A bus with no limits of its own is judged on the default band: green
 * 0.97-1.03 pu, amber 0.95-0.97 + 1.03-1.05, red <0.95 or >1.05 (the rules
 * themselves are covered in `voltage.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import {
  colorClassForBand,
  getBusOverlayState,
  getDeviceOverlayState,
  getFrameBusOverlay,
  getGeneratorLimitState,
  getLineOverlayState,
  lineStrokeStyle,
  pickFrameIdx,
  useSldFrameOverlay,
} from '@/components/sld/overlay';
import {
  getFrameBusOverlay as getFrameBusOverlayDirect,
  pickFrameIdx as pickFrameIdxDirect,
  useSldFrameOverlay as useSldFrameOverlayDirect,
} from '@/components/sld/frameOverlay';
import type { PflowResult } from '@/api/types';
import { parseRunId } from '@/api/types';
import { lineFlow } from '../../helpers/lineFlow';

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

describe('getBusOverlayState, display units', () => {
  const solved = makeResult({ bus_voltages: { '1': 1.06 }, bus_angles: { '1': -0.087 } });

  it('labels the voltage in pu by default', () => {
    expect(getBusOverlayState('1', solved).voltage_label).toBe('1.060 pu');
  });

  it('labels the voltage in kV when given the bus rated voltage as the display', () => {
    const state = getBusOverlayState('1', solved, false, undefined, { factor: 230, unit: 'kV' });
    expect(state.voltage_label).toBe('243.80 kV');
  });

  it('judges the band in pu whatever unit the label is in', () => {
    const high = makeResult({ bus_voltages: { '1': 1.08 }, bus_angles: { '1': 0 } });
    const state = getBusOverlayState('1', high, false, undefined, { factor: 230, unit: 'kV' });
    expect(state.band).toBe('danger');
    expect(state.side).toBe('high');
  });

  it('writes the angle in degrees in either unit', () => {
    expect(getBusOverlayState('1', solved).angle_label).toBe('-4.98°');
    expect(
      getBusOverlayState('1', solved, false, undefined, { factor: 230, unit: 'kV' }).angle_label,
    ).toBe('-4.98°');
  });

  it('hides the label whatever the unit', () => {
    const state = getBusOverlayState('1', solved, true, undefined, { factor: 230, unit: 'kV' });
    expect(state.voltage_label).toBeNull();
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

describe('getBusOverlayState against the bus limits', () => {
  const wide = { vmin: 0.9, vmax: 1.1 };

  it('judges the voltage on the limits it is given, not on 0.95 / 1.05', () => {
    const pflow = makeResult({ bus_voltages: { '1': 1.07 }, bus_angles: { '1': 0 } });
    // Past the default 1.05 limit, inside a case's own 1.10 one.
    expect(getBusOverlayState('1', pflow).band).toBe('danger');
    expect(getBusOverlayState('1', pflow, false, wide).band).toBe('success');
  });

  it('flags a voltage past a tighter limit than the default', () => {
    const pflow = makeResult({ bus_voltages: { '1': 1.0 }, bus_angles: { '1': 0 } });
    const tight = { vmin: 1.01, vmax: 1.04 };
    const state = getBusOverlayState('1', pflow, false, tight);
    expect(state.band).toBe('danger');
    expect(state.side).toBe('low');
    expect(state.color_class).toBe('border-danger');
  });

  it('names the limit side, and none for a bus in the clear or without a result', () => {
    const pflow = makeResult({
      bus_voltages: { '1': 1.0, '2': 0.93, '3': 1.07, '4': 1.04 },
      bus_angles: {},
    });
    expect(getBusOverlayState('1', pflow).side).toBeNull();
    expect(getBusOverlayState('2', pflow).side).toBe('low');
    expect(getBusOverlayState('3', pflow).side).toBe('high');
    expect(getBusOverlayState('4', pflow)).toMatchObject({ band: 'warning', side: 'high' });
    expect(getBusOverlayState('9', pflow).side).toBeNull();
    expect(getBusOverlayState('1', null).side).toBeNull();
  });

  it('keeps the side when the labels are hidden', () => {
    const pflow = makeResult({ bus_voltages: { '1': 0.92 }, bus_angles: { '1': 0 } });
    expect(getBusOverlayState('1', pflow, true).side).toBe('low');
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
        L1: lineFlow(12.5, 3.2),
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
        L2: lineFlow(-8.7, 1.0),
      },
    });
    const result = getLineOverlayState('L2', pflow);
    expect(result.direction).toBe('reverse');
    expect(result.p_label).toBe('-8.70 MW');
  });

  it('returns neutral when line idx is missing', () => {
    const pflow = makeResult({ line_flows: { L1: lineFlow(1, 1) } });
    const result = getLineOverlayState('L99', pflow);
    expect(result.has_data).toBe(false);
  });

  it('hides labels when hideLabels=true but keeps direction', () => {
    const pflow = makeResult({
      line_flows: { L1: lineFlow(5, 1) },
    });
    const result = getLineOverlayState('L1', pflow, true);
    expect(result.direction).toBe('forward');
    expect(result.p_label).toBeNull();
    expect(result.q_label).toBeNull();
  });
});

describe('getDeviceOverlayState', () => {
  const pflow = makeResult({
    generator_outputs: { '1': { p: 40, q: 30.436, v: 1.03, bus: 2 } },
    load_consumption: { PQ_1: { p: 21.7, q: 12.7, bus: 2 } },
  });

  it('returns neutral when no result', () => {
    const result = getDeviceOverlayState('generator', '1', null);
    expect(result).toEqual({ p_label: null, q_label: null, has_data: false });
  });

  it('returns neutral when not converged', () => {
    const result = getDeviceOverlayState('generator', '1', { ...pflow, converged: false });
    expect(result.has_data).toBe(false);
    expect(result.p_label).toBeNull();
  });

  it('reads a generator from generator_outputs, to one decimal', () => {
    const result = getDeviceOverlayState('generator', '1', pflow);
    expect(result.has_data).toBe(true);
    expect(result.p_label).toBe('40.0 MW');
    expect(result.q_label).toBe('30.4 MVAr');
  });

  it('reads a load from load_consumption, not generator_outputs', () => {
    const result = getDeviceOverlayState('load', 'PQ_1', pflow);
    expect(result.p_label).toBe('21.7 MW');
    expect(result.q_label).toBe('12.7 MVAr');
    // The same key under the other kind is a different (absent) row.
    expect(getDeviceOverlayState('generator', 'PQ_1', pflow).has_data).toBe(false);
    expect(getDeviceOverlayState('load', '1', pflow).has_data).toBe(false);
  });

  it('leaves the reactive label off for a DC power flow, which computes none', () => {
    const dc = makeResult({
      generator_outputs: { '1': { p: 40, q: null, v: 1.0, bus: 2 } },
      load_consumption: { PQ_1: { p: 21.7, q: null, bus: 2 } },
      line_flows: { L1: lineFlow(5, 0, { from: 1, to: 2 }, { q: null, q_to: null }) },
    });
    const gen = getDeviceOverlayState('generator', '1', dc);
    expect(gen.has_data).toBe(true);
    expect(gen.p_label).toBe('40.0 MW');
    expect(gen.q_label).toBeNull();
    expect(getDeviceOverlayState('load', 'PQ_1', dc).q_label).toBeNull();
    const line = getLineOverlayState('L1', dc);
    expect(line.p_label).toBe('5.00 MW');
    expect(line.q_label).toBeNull();
  });

  it('keeps the sign of an absorbing generator', () => {
    const slack = makeResult({
      generator_outputs: { '1': { p: 81.43, q: -21.62, v: 1.03, bus: 1 } },
    });
    expect(getDeviceOverlayState('generator', '1', slack).q_label).toBe('-21.6 MVAr');
  });

  it('never writes a negative zero', () => {
    const tiny = makeResult({
      generator_outputs: { '1': { p: -0.04, q: 0.04, v: 1, bus: 1 } },
    });
    const result = getDeviceOverlayState('generator', '1', tiny);
    expect(result.p_label).toBe('0.0 MW');
    expect(result.q_label).toBe('0.0 MVAr');
  });

  it('returns neutral when the device has no row', () => {
    expect(getDeviceOverlayState('generator', 'GENROU_1', pflow).has_data).toBe(false);
  });

  it('returns neutral for a node that prints no row (null key)', () => {
    expect(getDeviceOverlayState('generator', null, pflow)).toEqual({
      p_label: null,
      q_label: null,
      has_data: false,
    });
  });

  it('tolerates a result without the per-device maps', () => {
    const bare = makeResult();
    delete (bare as { generator_outputs?: unknown }).generator_outputs;
    delete (bare as { load_consumption?: unknown }).load_consumption;
    expect(getDeviceOverlayState('generator', '1', bare).has_data).toBe(false);
    expect(getDeviceOverlayState('load', 'PQ_1', bare).has_data).toBe(false);
  });

  it('drops a non-finite value but keeps the other one', () => {
    const odd = makeResult({
      generator_outputs: { '1': { p: Number.NaN, q: 5, v: 1, bus: 1 } },
    });
    const result = getDeviceOverlayState('generator', '1', odd);
    expect(result.has_data).toBe(true);
    expect(result.p_label).toBeNull();
    expect(result.q_label).toBe('5.0 MVAr');
  });

  it('hides the labels when hideLabels=true', () => {
    const result = getDeviceOverlayState('generator', '1', pflow, true);
    expect(result.has_data).toBe(true);
    expect(result.p_label).toBeNull();
    expect(result.q_label).toBeNull();
  });
});

// ---- frame-driven overlay (v0.2 Unit 5) ---------------------------------

describe('frame-driven helpers are re-exported from frameOverlay.ts', () => {
  it('pickFrameIdx, getFrameBusOverlay and useSldFrameOverlay are the same functions', () => {
    expect(pickFrameIdx).toBe(pickFrameIdxDirect);
    expect(getFrameBusOverlay).toBe(getFrameBusOverlayDirect);
    expect(useSldFrameOverlay).toBe(useSldFrameOverlayDirect);
  });
});

describe('colorClassForBand', () => {
  it('maps each band to its tailwind border class', () => {
    expect(colorClassForBand('success')).toBe('border-success');
    expect(colorClassForBand('warning')).toBe('border-warning');
    expect(colorClassForBand('danger')).toBe('border-danger');
    expect(colorClassForBand('neutral')).toBe('border-border');
  });
});

describe('getLineOverlayState, loading', () => {
  const rated = (loading: number) =>
    makeResult({
      line_flows: { L1: lineFlow(50, 5, undefined, { rate_a: 100, loading_pct: loading }) },
    });

  it('reads the loading band, label and words from the line loading', () => {
    expect(getLineOverlayState('L1', rated(120))).toMatchObject({
      loading_band: 'danger',
      loading_label: '120.0%',
      loading_status: 'Over rating',
    });
    expect(getLineOverlayState('L1', rated(85))).toMatchObject({
      loading_band: 'warning',
      loading_label: '85.0%',
      loading_status: 'Near rating',
    });
    expect(getLineOverlayState('L1', rated(40))).toMatchObject({
      loading_band: 'success',
      loading_label: '40.0%',
      loading_status: null,
    });
  });

  it('has no loading for a line the case gives no rating, nor without a result', () => {
    const unrated = makeResult({ line_flows: { L1: lineFlow(50, 5) } });
    expect(getLineOverlayState('L1', unrated)).toMatchObject({
      has_data: true,
      loading_band: 'neutral',
      loading_label: null,
      loading_status: null,
    });
    expect(getLineOverlayState('L1', null)).toMatchObject({
      has_data: false,
      loading_band: 'neutral',
      loading_label: null,
    });
  });

  it('keeps the loading when the labels are hidden: only the flow figures go', () => {
    const state = getLineOverlayState('L1', rated(120), true);
    expect(state.p_label).toBeNull();
    expect(state.loading_label).toBe('120.0%');
  });
});

describe('lineStrokeStyle', () => {
  it('is muted and thin before there is flow data', () => {
    expect(lineStrokeStyle(null)).toEqual({
      stroke: 'var(--color-muted-foreground)',
      strokeWidth: 1.5,
    });
    expect(lineStrokeStyle(getLineOverlayState('L1', null))).toEqual({
      stroke: 'var(--color-muted-foreground)',
      strokeWidth: 1.5,
    });
  });

  it('is the foreground colour with flow data, amber near the rating and red past it, heavier each step', () => {
    const style = (loading: number | null) =>
      lineStrokeStyle(
        getLineOverlayState(
          'L1',
          makeResult({
            line_flows: {
              L1: lineFlow(50, 5, undefined, {
                rate_a: loading === null ? null : 100,
                loading_pct: loading,
              }),
            },
          }),
        ),
      );
    expect(style(null)).toEqual({ stroke: 'var(--color-foreground)', strokeWidth: 1.8 });
    expect(style(30)).toEqual({ stroke: 'var(--color-foreground)', strokeWidth: 1.8 });
    expect(style(90)).toEqual({ stroke: 'var(--color-warning)', strokeWidth: 2.4 });
    expect(style(110)).toEqual({ stroke: 'var(--color-danger)', strokeWidth: 3 });
  });
});

describe('getGeneratorLimitState', () => {
  const pflow = makeResult({
    generator_outputs: {
      '1': { p: 40, q: 30, v: 1.0, bus: 1, q_min: -40, q_max: 15 },
      '2': { p: 40, q: 5, v: 1.0, bus: 2, q_min: -40, q_max: 15 },
      '3': { p: 0, q: 0, v: 1.0, bus: 3, q_min: null, q_max: null },
    },
  });

  it('reads where the reactive output stands against the limits of the row it prints', () => {
    expect(getGeneratorLimitState('1', pflow)).toBe('above-max');
    expect(getGeneratorLimitState('2', pflow)).toBe('within');
  });

  it('has nothing to say for a row with no limits, a missing row, a node printing no row, or no result', () => {
    expect(getGeneratorLimitState('3', pflow)).toBe('none');
    expect(getGeneratorLimitState('9', pflow)).toBe('none');
    expect(getGeneratorLimitState(null, pflow)).toBe('none');
    expect(getGeneratorLimitState('1', null)).toBe('none');
    expect(getGeneratorLimitState('1', { ...pflow, converged: false })).toBe('none');
  });
});
