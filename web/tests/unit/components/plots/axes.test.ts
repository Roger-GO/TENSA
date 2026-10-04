/**
 * Tests for `axes.ts`: which axes a stacked chart gets, in which unit, and
 * how each series is scaled onto them. These are the rules that keep a bus's
 * angle (tens of degrees) off the axis of its voltage (about 1 pu), and a
 * machine's speed (1 +/- 0.001 pu) off the axis of its rotor angle.
 */
import { describe, expect, it } from 'vitest';
import { planGroupAxes, scaleColumn, seriesQuantity } from '@/components/plots/axes';
import type { PlannedSeries } from '@/components/plots/axes';
import { parseColumnName } from '@/store/plot';
import type { UnitBases } from '@/lib/units';

const BASES: UnitBases = { busKv: { '1': 230, '2': 13.8 }, freqHz: 60 };

/** A series of ``name`` from a run with ``bases`` (``null``: a run that carries none). */
function planned(name: string, bases: UnitBases | null = BASES): PlannedSeries {
  const series = parseColumnName(name);
  if (!series) throw new Error(`not a column: ${name}`);
  return { series, bases: bases ?? undefined };
}

describe('seriesQuantity', () => {
  it('tells a bus voltage from a bus angle', () => {
    expect(seriesQuantity({ group: 'bus_v', field: 'v' })).toBe('voltage');
    expect(seriesQuantity({ group: 'bus_v', field: 'a' })).toBe('angle');
  });

  it('tells a machine speed from a rotor angle', () => {
    expect(seriesQuantity({ group: 'gen_state', field: 'omega' })).toBe('speed');
    expect(seriesQuantity({ group: 'gen_state', field: 'delta' })).toBe('angle');
  });

  it('calls every power group power', () => {
    for (const group of ['gen_power', 'line_flow', 'load_pq'] as const) {
      expect(seriesQuantity({ group, field: 'p' })).toBe('power');
    }
  });
});

describe('planGroupAxes', () => {
  it('gives a bus voltage and angle an axis each: volts on the left, degrees on the right', () => {
    const series = [planned('Bus_1_v'), planned('Bus_1_a')];
    const plan = planGroupAxes('bus_v', series, 'pu');
    expect(plan.axes).toEqual([
      { quantity: 'voltage', scale: 'y', side: 'left', unit: 'pu', label: 'V (pu)' },
      { quantity: 'angle', scale: 'y2', side: 'right', unit: '°', label: 'θ (°)' },
    ]);
    expect(plan.place(series[0]!)).toEqual({ scale: 'y', factor: 1 });
    expect(plan.place(series[1]!)).toEqual({ scale: 'y2', factor: 180 / Math.PI });
  });

  it('gives a machine speed and rotor angle an axis each', () => {
    const series = [planned('Gen_1_omega'), planned('Gen_1_delta')];
    const plan = planGroupAxes('gen_state', series, 'pu');
    expect(plan.axes.map((a) => [a.label, a.scale, a.side])).toEqual([
      ['ω (pu)', 'y', 'left'],
      ['δ (°)', 'y2', 'right'],
    ]);
  });

  it('draws a lone angle on the main axis, since there is nothing to share with', () => {
    const series = [planned('Bus_1_a')];
    const plan = planGroupAxes('bus_v', series, 'pu');
    expect(plan.axes).toEqual([
      { quantity: 'angle', scale: 'y', side: 'left', unit: '°', label: 'θ (°)' },
    ]);
    expect(plan.place(series[0]!).scale).toBe('y');
  });

  it('draws only the axes of the quantities selected', () => {
    expect(planGroupAxes('bus_v', [planned('Bus_1_v')], 'pu').axes).toHaveLength(1);
    expect(planGroupAxes('gen_state', [planned('Gen_1_omega')], 'pu').axes).toHaveLength(1);
  });

  it('keeps powers on one axis', () => {
    const series = [planned('Line_1_p'), planned('Line_1_q')];
    const plan = planGroupAxes('line_flow', series, 'actual');
    expect(plan.axes).toEqual([
      { quantity: 'power', scale: 'y', side: 'left', unit: 'MW', label: 'P (MW) / Q (MVar)' },
    ]);
    expect(plan.place(series[0]!).factor).toBe(1);
  });

  it('reads voltage in kV, each bus times its own rated voltage, in the actual mode', () => {
    const series = [planned('Bus_1_v'), planned('Bus_2_v')];
    const plan = planGroupAxes('bus_v', series, 'actual');
    expect(plan.axes[0]).toMatchObject({ unit: 'kV', label: 'V (kV)' });
    expect(plan.place(series[0]!).factor).toBe(230);
    expect(plan.place(series[1]!).factor).toBe(13.8);
  });

  it('reads speed in Hz in the actual mode', () => {
    const series = [planned('Gen_1_omega')];
    const plan = planGroupAxes('gen_state', series, 'actual');
    expect(plan.axes[0]).toMatchObject({ unit: 'Hz', label: 'f (Hz)' });
    expect(plan.place(series[0]!).factor).toBe(60);
    expect(
      planGroupAxes('gen_state', [planned('Gen_1_omega', { busKv: {}, freqHz: 50 })], 'actual')
        .axes[0]?.label,
    ).toBe('f (Hz)');
  });

  it('leaves the angle in degrees in either mode', () => {
    for (const mode of ['pu', 'actual'] as const) {
      const series = [planned('Bus_1_v'), planned('Bus_1_a')];
      const plan = planGroupAxes('bus_v', series, mode);
      expect(plan.axes[1]?.unit).toBe('°');
      expect(plan.place(series[1]!).factor).toBeCloseTo(57.29578, 5);
    }
  });

  it('keeps the whole voltage axis per unit when one bus has no rated voltage', () => {
    // One axis cannot read in two units, so a single unknown base keeps every voltage per unit.
    const series = [planned('Bus_1_v'), planned('Bus_9_v')];
    const plan = planGroupAxes('bus_v', series, 'actual');
    expect(plan.axes[0]).toMatchObject({ unit: 'pu', label: 'V (pu)' });
    expect(plan.place(series[0]!).factor).toBe(1);
    expect(plan.place(series[1]!).factor).toBe(1);
  });

  it('keeps speed per unit when the case has no frequency, and says so', () => {
    const series = [planned('Gen_1_omega', { busKv: {}, freqHz: null })];
    const plan = planGroupAxes('gen_state', series, 'actual');
    expect(plan.axes[0]).toMatchObject({ unit: 'pu', label: 'ω (pu)' });
    expect(plan.place(series[0]!).factor).toBe(1);
  });

  it('keeps a run with no bases per unit', () => {
    const series = [planned('Bus_1_v', null), planned('Gen_1_omega', null)];
    expect(planGroupAxes('bus_v', [series[0]!], 'actual').axes[0]?.unit).toBe('pu');
    expect(planGroupAxes('gen_state', [series[1]!], 'actual').axes[0]?.unit).toBe('pu');
  });

  it('converts each run with its own bases when runs of different cases are overlaid', () => {
    const older = planned('Bus_1_v', { busKv: { '1': 115 }, freqHz: 50 });
    const newer = planned('Bus_1_v', { busKv: { '1': 230 }, freqHz: 60 });
    const plan = planGroupAxes('bus_v', [older, newer], 'actual');
    expect(plan.axes[0]?.unit).toBe('kV');
    expect(plan.place(older).factor).toBe(115);
    expect(plan.place(newer).factor).toBe(230);
  });
});

describe('scaleColumn', () => {
  it('hands back the same view when the factor is 1', () => {
    const values = new Float64Array([1, 2, 3]);
    expect(scaleColumn(values, 1)).toBe(values);
  });

  it('scales into a copy and leaves the stored column alone', () => {
    const values = new Float64Array([1, 2, Number.NaN]);
    const scaled = scaleColumn(values, 10);
    expect(Array.from(scaled.slice(0, 2))).toEqual([10, 20]);
    expect(scaled[2]).toBeNaN();
    expect(Array.from(values.slice(0, 2))).toEqual([1, 2]);
  });
});
