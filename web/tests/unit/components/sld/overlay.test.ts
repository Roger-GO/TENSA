/**
 * Tests for `overlay.ts` — the pure helpers that translate a PflowResult
 * into per-bus / per-line visual state.
 *
 * Voltage thresholds (per the plan): green 0.97-1.03 pu, amber
 * 0.95-0.97 + 1.03-1.05, red <0.95 or >1.05.
 */
import { describe, expect, it } from 'vitest';
import { classifyVoltage, getBusOverlayState, getLineOverlayState } from '@/components/sld/overlay';
import type { PflowResult } from '@/api/types';
import { parseRunId } from '@/api/types';

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
