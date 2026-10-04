/**
 * Tests for `voltage.ts`: the bus voltage limits, how a bus entry's `vmin` /
 * `vmax` become the limits it is judged on, and the band and limit side a
 * voltage gets against them.
 */
import { describe, expect, it } from 'vitest';
import type { TopologyEntry, TopologySummary } from '@/api/types';
import {
  DEFAULT_VOLTAGE_LIMITS,
  VOLTAGE_WARNING_MARGIN,
  assessVoltage,
  barClassForBand,
  busLimitsByIdx,
  busVoltageLimits,
  formatVoltageLimits,
  resolveVoltageLimits,
  voltageMarkerLabel,
  voltageStatusText,
} from '@/components/sld/voltage';

function bus(idx: number | string, params: TopologyEntry['params'] = {}): TopologyEntry {
  return { idx, name: `b${idx}`, kind: 'Bus', params };
}

function topology(buses: TopologyEntry[]): TopologySummary {
  return { state: 'pre-setup', buses, lines: [], transformers: [], generators: [], loads: [] };
}

/** The band of a voltage on the default limits. */
function classifyVoltage(v: number): string {
  return assessVoltage(v).band;
}

describe('assessVoltage on the default limits', () => {
  it('returns success for 1.00 pu', () => {
    expect(classifyVoltage(1.0)).toBe('success');
  });

  it('returns success for the band edges (0.97, 1.03)', () => {
    expect(classifyVoltage(0.97)).toBe('success');
    expect(classifyVoltage(1.03)).toBe('success');
  });

  it('returns warning for 0.96 and 1.04', () => {
    expect(classifyVoltage(0.96)).toBe('warning');
    expect(classifyVoltage(1.04)).toBe('warning');
  });

  it('keeps the limits themselves in the warning band, and goes red beyond them', () => {
    expect(classifyVoltage(0.95)).toBe('warning');
    expect(classifyVoltage(1.05)).toBe('warning');
    expect(classifyVoltage(0.9499)).toBe('danger');
    expect(classifyVoltage(1.0501)).toBe('danger');
  });

  it('returns danger for 0.92 and 1.08', () => {
    expect(classifyVoltage(0.92)).toBe('danger');
    expect(classifyVoltage(1.08)).toBe('danger');
  });

  it('returns neutral for non-finite', () => {
    expect(classifyVoltage(NaN)).toBe('neutral');
    expect(classifyVoltage(Infinity)).toBe('neutral');
  });
});

describe('assessVoltage against a bus own limits', () => {
  const wide = { vmin: 0.9, vmax: 1.1 };

  it('moves every band edge with the limits', () => {
    // The same 1.07 pu is red on the default band and green on 0.9 / 1.1.
    expect(assessVoltage(1.07).band).toBe('danger');
    expect(assessVoltage(1.07, wide).band).toBe('success');
    // The amber band is VOLTAGE_WARNING_MARGIN inside each limit.
    expect(assessVoltage(1.1 - VOLTAGE_WARNING_MARGIN + 0.001, wide).band).toBe('warning');
    expect(assessVoltage(0.9 + VOLTAGE_WARNING_MARGIN - 0.001, wide).band).toBe('warning');
    expect(assessVoltage(1.1001, wide).band).toBe('danger');
    expect(assessVoltage(0.8999, wide).band).toBe('danger');
  });

  it('names the limit a voltage is near or past, and none in the clear', () => {
    expect(assessVoltage(1.0, wide)).toEqual({ band: 'success', side: null });
    expect(assessVoltage(0.91, wide)).toEqual({ band: 'warning', side: 'low' });
    expect(assessVoltage(1.09, wide)).toEqual({ band: 'warning', side: 'high' });
    expect(assessVoltage(0.85, wide)).toEqual({ band: 'danger', side: 'low' });
    expect(assessVoltage(1.2, wide)).toEqual({ band: 'danger', side: 'high' });
    expect(assessVoltage(NaN, wide)).toEqual({ band: 'neutral', side: null });
  });

  it('gives a narrow band a clear middle instead of an all-amber one', () => {
    // 0.04 pu wide: the 0.02 margin would take the whole band, so it is
    // capped at a quarter of it.
    const narrow = { vmin: 0.99, vmax: 1.03 };
    expect(assessVoltage(1.01, narrow).band).toBe('success');
    expect(assessVoltage(0.995, narrow)).toEqual({ band: 'warning', side: 'low' });
    expect(assessVoltage(1.025, narrow)).toEqual({ band: 'warning', side: 'high' });
  });
});

describe('resolveVoltageLimits', () => {
  it('takes a bus vmin and vmax as they are', () => {
    expect(resolveVoltageLimits(0.9, 1.1)).toEqual({ vmin: 0.9, vmax: 1.1 });
    expect(resolveVoltageLimits(0.5, 1.5)).toEqual({ vmin: 0.5, vmax: 1.5 });
  });

  it('falls back to 0.95 / 1.05 when both are missing', () => {
    expect(resolveVoltageLimits(undefined, undefined)).toBe(DEFAULT_VOLTAGE_LIMITS);
    expect(DEFAULT_VOLTAGE_LIMITS).toEqual({ vmin: 0.95, vmax: 1.05 });
  });

  it('falls back limit by limit when only one is usable', () => {
    expect(resolveVoltageLimits(0.9, undefined)).toEqual({ vmin: 0.9, vmax: 1.05 });
    expect(resolveVoltageLimits(undefined, 1.1)).toEqual({ vmin: 0.95, vmax: 1.1 });
  });

  it('treats a value that is not a finite positive number as missing', () => {
    expect(resolveVoltageLimits(NaN, Infinity)).toBe(DEFAULT_VOLTAGE_LIMITS);
    expect(resolveVoltageLimits(0, -1)).toBe(DEFAULT_VOLTAGE_LIMITS);
    expect(resolveVoltageLimits('0.9', true)).toBe(DEFAULT_VOLTAGE_LIMITS);
    expect(resolveVoltageLimits(null, undefined)).toBe(DEFAULT_VOLTAGE_LIMITS);
  });

  it('ignores a pair that leaves no band between them', () => {
    expect(resolveVoltageLimits(1.1, 0.9)).toBe(DEFAULT_VOLTAGE_LIMITS);
    expect(resolveVoltageLimits(1.0, 1.0)).toBe(DEFAULT_VOLTAGE_LIMITS);
    // A usable vmin above the default vmax collides with the fallback too.
    expect(resolveVoltageLimits(1.08, undefined)).toBe(DEFAULT_VOLTAGE_LIMITS);
  });
});

describe('busVoltageLimits and busLimitsByIdx', () => {
  it("reads a bus entry's vmin and vmax params", () => {
    expect(busVoltageLimits(bus(1, { vmin: 0.9, vmax: 1.1 }))).toEqual({ vmin: 0.9, vmax: 1.1 });
    expect(busVoltageLimits(bus(2, { Vn: 69 }))).toBe(DEFAULT_VOLTAGE_LIMITS);
    expect(busVoltageLimits({ params: undefined })).toBe(DEFAULT_VOLTAGE_LIMITS);
  });

  it('keys every bus of a topology by its idx as a string', () => {
    const limits = busLimitsByIdx(
      topology([bus(1, { vmin: 0.9, vmax: 1.1 }), bus('B2', { vmin: 0.97, vmax: 1.03 }), bus(3)]),
    );
    expect(limits.get('1')).toEqual({ vmin: 0.9, vmax: 1.1 });
    expect(limits.get('B2')).toEqual({ vmin: 0.97, vmax: 1.03 });
    expect(limits.get('3')).toBe(DEFAULT_VOLTAGE_LIMITS);
    expect(limits.get('99')).toBeUndefined();
  });

  it('builds the map once per topology object and again for a new one', () => {
    const first = topology([bus(1, { vmin: 0.9, vmax: 1.1 })]);
    expect(busLimitsByIdx(first)).toBe(busLimitsByIdx(first));
    const edited = topology([bus(1, { vmin: 0.92, vmax: 1.08 })]);
    expect(busLimitsByIdx(edited).get('1')).toEqual({ vmin: 0.92, vmax: 1.08 });
    expect(busLimitsByIdx(first).get('1')).toEqual({ vmin: 0.9, vmax: 1.1 });
  });
});

describe('voltageMarkerLabel', () => {
  it('says beyond for danger and near for warning, with the limit end', () => {
    expect(voltageMarkerLabel('danger', 'high')).toBe('Voltage beyond its upper limit');
    expect(voltageMarkerLabel('danger', 'low')).toBe('Voltage beyond its lower limit');
    expect(voltageMarkerLabel('warning', 'high')).toBe('Voltage near its upper limit');
    expect(voltageMarkerLabel('warning', 'low')).toBe('Voltage near its lower limit');
  });

  it('has no words for a bus in the clear or without a reading', () => {
    expect(voltageMarkerLabel('success', null)).toBeNull();
    expect(voltageMarkerLabel('neutral', null)).toBeNull();
    expect(voltageMarkerLabel('danger', null)).toBeNull();
    expect(voltageMarkerLabel('success', 'high')).toBeNull();
  });
});

describe('voltageStatusText', () => {
  const limits = { vmin: 0.9, vmax: 1.1 };

  it('reads each standing against the limits as the words the legend uses', () => {
    expect(voltageStatusText(assessVoltage(1.0, limits))).toBe('Within limits');
    expect(voltageStatusText(assessVoltage(0.91, limits))).toBe('Near vmin');
    expect(voltageStatusText(assessVoltage(1.09, limits))).toBe('Near vmax');
    expect(voltageStatusText(assessVoltage(0.85, limits))).toBe('Below vmin');
    expect(voltageStatusText(assessVoltage(1.2, limits))).toBe('Above vmax');
  });

  it('has no words when there is no voltage to judge', () => {
    expect(voltageStatusText(assessVoltage(Number.NaN, limits))).toBeNull();
  });
});

describe('formatVoltageLimits', () => {
  it('writes both limits as one phrase without trailing zeros', () => {
    expect(formatVoltageLimits({ vmin: 0.9, vmax: 1.1 })).toBe('0.9 to 1.1 pu');
    expect(formatVoltageLimits({ vmin: 0.95, vmax: 1.05 })).toBe('0.95 to 1.05 pu');
    expect(formatVoltageLimits({ vmin: 0.9125, vmax: 1.0875 })).toBe('0.9125 to 1.0875 pu');
  });
});

describe('barClassForBand', () => {
  it('tints the bar only near and beyond a limit', () => {
    expect(barClassForBand('danger')).toContain('--color-danger');
    expect(barClassForBand('warning')).toContain('--color-warning');
    expect(barClassForBand('success')).toBe('bg-foreground');
    expect(barClassForBand('neutral')).toBe('bg-foreground');
  });
});
