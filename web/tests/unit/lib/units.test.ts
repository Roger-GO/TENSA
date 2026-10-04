/**
 * Tests for `lib/units.ts`: the angle conversion, which unit a voltage or a
 * speed reads in, and what bases a topology gives.
 */
import { describe, expect, it } from 'vitest';
import {
  PER_UNIT,
  RAD_TO_DEG,
  busBaseKv,
  displayDecimals,
  entryBaseKv,
  formatDisplayed,
  radToDeg,
  speedDisplay,
  unitBasesOf,
  unratedBusIdx,
  voltageDisplay,
} from '@/lib/units';
import type { TopologySummary } from '@/api/types';

function topology(overrides: Partial<TopologySummary> = {}): TopologySummary {
  return {
    state: 'pre-setup',
    buses: [
      { idx: 1, name: 'B1', kind: 'Bus', params: { Vn: 230 } },
      { idx: 'B2', name: 'B2', kind: 'Bus', params: { Vn: 13.8 } },
      { idx: 3, name: 'B3', kind: 'Bus', params: {} },
    ],
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
    freq_hz: 60,
    ...overrides,
  };
}

describe('radToDeg', () => {
  it('converts radians to degrees', () => {
    expect(RAD_TO_DEG).toBeCloseTo(57.29578, 5);
    expect(radToDeg(Math.PI)).toBeCloseTo(180, 10);
    expect(radToDeg(-0.087)).toBeCloseTo(-4.9846, 3);
    expect(radToDeg(0)).toBe(0);
  });

  it('keeps NaN as NaN, so a gap in a series stays a gap', () => {
    expect(radToDeg(Number.NaN)).toBeNaN();
  });
});

describe('voltageDisplay', () => {
  it('is per unit in the pu mode, whatever the base', () => {
    expect(voltageDisplay('pu', 230)).toBe(PER_UNIT);
  });

  it('is kV in the actual mode when the rated voltage is known', () => {
    expect(voltageDisplay('actual', 230)).toEqual({ factor: 230, unit: 'kV' });
  });

  it.each([null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'stays per unit in the actual mode for the unusable base %s',
    (base) => {
      expect(voltageDisplay('actual', base)).toBe(PER_UNIT);
    },
  );
});

describe('speedDisplay', () => {
  it('is per unit in the pu mode and Hz in the actual mode', () => {
    expect(speedDisplay('pu', 60)).toBe(PER_UNIT);
    expect(speedDisplay('actual', 50)).toEqual({ factor: 50, unit: 'Hz' });
  });

  it('stays per unit in the actual mode when the case has no frequency', () => {
    expect(speedDisplay('actual', null)).toBe(PER_UNIT);
    expect(speedDisplay('actual', undefined)).toBe(PER_UNIT);
    expect(speedDisplay('actual', 0)).toBe(PER_UNIT);
  });
});

describe('formatDisplayed', () => {
  it('writes a per-unit value with its decimals and unit', () => {
    expect(formatDisplayed(1.06, PER_UNIT, 3)).toBe('1.060 pu');
  });

  it('writes an actual value with one decimal fewer', () => {
    expect(formatDisplayed(1.06, { factor: 230, unit: 'kV' }, 3)).toBe('243.80 kV');
    expect(formatDisplayed(1.001, { factor: 60, unit: 'Hz' }, 4)).toBe('60.060 Hz');
  });

  it('never asks for negative decimals', () => {
    expect(displayDecimals({ factor: 230, unit: 'kV' }, 0)).toBe(0);
  });
});

describe('unitBasesOf', () => {
  it('has no bases for no topology', () => {
    expect(unitBasesOf(null)).toBeUndefined();
    expect(unitBasesOf(undefined)).toBeUndefined();
  });

  it('collects the rated kV of each bus that has one, by its idx as a string', () => {
    const bases = unitBasesOf(topology());
    expect(bases?.busKv).toEqual({ '1': 230, B2: 13.8 });
    expect(busBaseKv(bases, 1)).toBe(230);
    expect(busBaseKv(bases, 'B2')).toBe(13.8);
    expect(busBaseKv(bases, 3)).toBeNull();
    expect(busBaseKv(bases, 99)).toBeNull();
    expect(busBaseKv(undefined, 1)).toBeNull();
  });

  it('takes the system frequency from the topology', () => {
    expect(unitBasesOf(topology({ freq_hz: 50 }))?.freqHz).toBe(50);
  });

  it.each([null, undefined, 0, -60])('has no frequency when the topology says %s', (freq) => {
    expect(unitBasesOf(topology({ freq_hz: freq }))?.freqHz).toBeNull();
  });

  it('leaves out a bus the case gives no rated voltage, whatever Vn holds for it', () => {
    // ANDES fills in 110 kV for such a bus, and the topology says so.
    const bases = unitBasesOf(
      topology({
        buses: [
          { idx: 1, name: 'B1', kind: 'Bus', params: { Vn: 230 } },
          { idx: 2, name: 'B2', kind: 'Bus', params: { Vn: 110 } },
          { idx: 'B3', name: 'B3', kind: 'Bus', params: { Vn: 110 } },
        ],
        buses_without_vn: [2, 'B3'],
      }),
    );
    expect(bases?.busKv).toEqual({ '1': 230 });
    expect(busBaseKv(bases, 2)).toBeNull();
    expect(busBaseKv(bases, 'B3')).toBeNull();
  });

  it('has no rated voltage for any bus of a case that gives none', () => {
    const buses = [1, 2, 3].map((idx) => ({
      idx,
      name: `B${idx}`,
      kind: 'Bus',
      params: { Vn: 110 },
    }));
    const bases = unitBasesOf(topology({ buses, buses_without_vn: [1, 2, 3] }));
    expect(bases?.busKv).toEqual({});
  });

  it('ignores a rated voltage that is not a positive number', () => {
    const bases = unitBasesOf(
      topology({
        buses: [
          { idx: 1, name: 'B1', kind: 'Bus', params: { Vn: 0 } },
          { idx: 2, name: 'B2', kind: 'Bus', params: { Vn: '230' } },
        ],
      }),
    );
    expect(bases?.busKv).toEqual({});
  });
});

describe('entryBaseKv', () => {
  it('reads a bus entry Vn, or null', () => {
    expect(entryBaseKv({ idx: 1, params: { Vn: 138 } })).toBe(138);
    expect(entryBaseKv({ idx: 1, params: {} })).toBeNull();
  });

  it('is null for a bus whose case gives no Vn, though its params hold one', () => {
    const unrated = new Set(['2']);
    expect(entryBaseKv({ idx: 2, params: { Vn: 110 } }, unrated)).toBeNull();
    expect(entryBaseKv({ idx: 3, params: { Vn: 110 } }, unrated)).toBe(110);
  });
});

describe('unratedBusIdx', () => {
  it('lists the idx of the buses the case gives no rated voltage, as strings', () => {
    expect(unratedBusIdx(topology({ buses_without_vn: [2, 'B3'] }))).toEqual(new Set(['2', 'B3']));
  });

  it('is empty when the topology lists none, or is missing', () => {
    expect(unratedBusIdx(topology()).size).toBe(0);
    expect(unratedBusIdx(null).size).toBe(0);
    expect(unratedBusIdx(undefined).size).toBe(0);
  });
});
