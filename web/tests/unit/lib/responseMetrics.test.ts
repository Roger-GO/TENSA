/**
 * What the response-metrics table asks the substrate about: the window the
 * cursors mark, the plotted series in the units the charts show, and a request
 * that fits the substrate's limits. The metrics themselves are computed (and
 * tested) on the server.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_METRIC_SAMPLES,
  MAX_METRIC_SERIES,
  MAX_METRIC_SAMPLES_TOTAL,
  ROCOF_WINDOW_S,
  SETTLING_BAND,
  displayedSeries,
  metricsLimits,
  metricsRequest,
  metricsWindow,
} from '@/lib/responseMetrics';
import type { DisplayedSeries } from '@/lib/responseMetrics';
import { useRunsStore } from '@/store/runs';
import type { RunRecord } from '@/store/runs';
import type { UnitBases } from '@/lib/units';

const BASES: UnitBases = { busKv: { '1': 230 }, freqHz: 60 };

function seed(columns: Record<string, number[]>, t: number[], bases?: UnitBases): RunRecord {
  useRunsStore.setState({ runs: {}, activeRunId: null, overlayRunIds: new Set(), runCount: 0 });
  useRunsStore.getState().startRun({
    runId: 'r1',
    tf: 10,
    columnNames: Object.keys(columns),
    ...(bases === undefined ? {} : { bases }),
  });
  useRunsStore.getState().appendFrame('r1', {
    t: new Float64Array(t),
    columns: Object.fromEntries(
      Object.entries(columns).map(([name, values]) => [name, new Float64Array(values)]),
    ),
  });
  return useRunsStore.getState().runs['r1']!;
}

beforeEach(() => {
  useRunsStore.setState({ runs: {}, activeRunId: null, overlayRunIds: new Set(), runCount: 0 });
});

describe('metricsWindow', () => {
  it('is the whole run until both cursors are placed', () => {
    expect(metricsWindow(undefined)).toEqual({ tStart: null, tEnd: null });
    expect(metricsWindow({ a: 1, b: null })).toEqual({ tStart: null, tEnd: null });
    expect(metricsWindow({ a: null, b: 2 })).toEqual({ tStart: null, tEnd: null });
  });

  it('is the stretch between the cursors, whichever was placed first', () => {
    expect(metricsWindow({ a: 1, b: 3 })).toEqual({ tStart: 1, tEnd: 3 });
    expect(metricsWindow({ a: 3, b: 1 })).toEqual({ tStart: 1, tEnd: 3 });
  });
});

describe('displayedSeries', () => {
  it('returns the selected series that the run has, in the run column order', () => {
    const run = seed({ Bus_1_v: [1, 1, 1], Bus_2_v: [1, 1, 1], Gen_1_omega: [1, 1, 1] }, [0, 1, 2]);

    const series = displayedSeries(run, new Set(['Gen_1_omega', 'Bus_1_v', 'Bus_9_v']), 'pu');

    expect(series.map((s) => s.name)).toEqual(['Bus_1_v', 'Gen_1_omega']);
  });

  it('covers the rows the run has and not the over-allocated typed arrays', () => {
    const run = seed({ Bus_1_v: [1, 0.9, 0.8] }, [0, 1, 2]);

    const [series] = displayedSeries(run, new Set(['Bus_1_v']), 'pu');

    expect(Array.from(series!.t)).toEqual([0, 1, 2]);
    expect(Array.from(series!.y)).toEqual([1, 0.9, 0.8]);
  });

  it('keeps per-unit values per unit and says so', () => {
    const run = seed({ Bus_1_v: [1.0, 0.95], Gen_1_omega: [1, 0.999] }, [0, 1], BASES);

    const series = displayedSeries(run, new Set(['Bus_1_v', 'Gen_1_omega']), 'pu');

    expect(series.map((s) => [s.name, s.unit])).toEqual([
      ['Bus_1_v', 'pu'],
      ['Gen_1_omega', 'pu'],
    ]);
    expect(Array.from(series[0]!.y)).toEqual([1.0, 0.95]);
  });

  it('shows kV and Hz, as the chart does, where the case gives the base', () => {
    const run = seed({ Bus_1_v: [1.0, 0.95], Gen_1_omega: [1, 0.999] }, [0, 1], BASES);

    const [bus, gen] = displayedSeries(run, new Set(['Bus_1_v', 'Gen_1_omega']), 'actual');

    expect(bus!.unit).toBe('kV');
    expect(Array.from(bus!.y)).toEqual([230, 218.5]);
    expect(gen!.unit).toBe('Hz');
    expect(gen!.y[1]).toBeCloseTo(59.94);
  });

  it('keeps a quantity per unit when one of its series has no base, as the chart does', () => {
    // Bus 2 has no rated voltage: the chart shows both voltages in pu.
    const run = seed({ Bus_1_v: [1, 1], Bus_2_v: [1, 1] }, [0, 1], BASES);

    const series = displayedSeries(run, new Set(['Bus_1_v', 'Bus_2_v']), 'actual');

    expect(series.map((s) => s.unit)).toEqual(['pu', 'pu']);
    expect(Array.from(series[0]!.y)).toEqual([1, 1]);
  });

  it('shows an angle in degrees and a power in MW or MVAr', () => {
    const run = seed({ Bus_1_a: [0, Math.PI / 2], Line_1_p: [10, 20], Line_1_q: [1, 2] }, [0, 1]);

    const series = displayedSeries(run, new Set(['Bus_1_a', 'Line_1_p', 'Line_1_q']), 'pu');

    const byName = Object.fromEntries(series.map((s) => [s.name, s]));
    expect(byName['Bus_1_a']!.unit).toBe('°');
    expect(byName['Bus_1_a']!.y[1]).toBeCloseTo(90);
    expect(byName['Line_1_p']!.unit).toBe('MW');
    expect(byName['Line_1_q']!.unit).toBe('MVAr');
  });

  it('gives an ANDES variable as ANDES holds it, with no unit', () => {
    const run = seed({ 'omega GENROU 1': [1, 1.001] }, [0, 1], BASES);

    const [series] = displayedSeries(run, new Set(['omega GENROU 1']), 'actual');

    expect(series!.unit).toBe('');
    expect(Array.from(series!.y)).toEqual([1, 1.001]);
  });

  it('returns nothing for a selection that names none of the columns of the run', () => {
    const run = seed({ Bus_1_v: [1, 1] }, [0, 1]);

    expect(displayedSeries(run, new Set(), 'pu')).toEqual([]);
    expect(displayedSeries(run, new Set(['Bus_7_v']), 'pu')).toEqual([]);
  });
});

function series(name: string, n: number, y = 1): DisplayedSeries {
  return {
    name,
    unit: 'pu',
    t: Float64Array.from({ length: n }, (_, i) => i / 30),
    y: new Float64Array(n).fill(y),
  };
}

describe('metricsLimits', () => {
  it('lets a short run carry as many series as one request takes', () => {
    expect(metricsLimits(900)).toEqual({ series: MAX_METRIC_SERIES, stride: 1 });
  });

  it('takes fewer series of a run so long that they would pass the total', () => {
    const { series: count, stride } = metricsLimits(50_000);
    expect(stride).toBe(1);
    expect(count).toBe(Math.floor(MAX_METRIC_SAMPLES_TOTAL / 50_000));
    expect(count).toBeLessThan(MAX_METRIC_SERIES);
  });

  it('thins a run longer than one series can be to every nth sample', () => {
    const { series: count, stride } = metricsLimits(2.5 * MAX_METRIC_SAMPLES);
    expect(stride).toBe(3);
    expect(Math.ceil((2.5 * MAX_METRIC_SAMPLES) / stride)).toBeLessThanOrEqual(MAX_METRIC_SAMPLES);
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

describe('metricsRequest', () => {
  it('sends the series as lists with the settings the table states', () => {
    const plan = metricsRequest([series('a', 3), series('b', 3, 2)], { tStart: null, tEnd: null });

    expect(plan.request.settling_band).toBe(SETTLING_BAND);
    expect(plan.request.rocof_window).toBe(ROCOF_WINDOW_S);
    expect(plan.request.series.map((s) => s.name)).toEqual(['a', 'b']);
    expect(plan.request.series[1]).toEqual({
      name: 'b',
      t: [0, 1 / 30, 2 / 30],
      y: [2, 2, 2],
    });
    expect(plan.skipped).toBe(0);
    expect(plan.stride).toBe(1);
  });

  it('leaves the window out for the whole run and carries it between the cursors', () => {
    const whole = metricsRequest([series('a', 3)], { tStart: null, tEnd: null }).request;
    expect(whole).not.toHaveProperty('t_start');
    expect(whole).not.toHaveProperty('t_end');

    const cut = metricsRequest([series('a', 3)], { tStart: 0.5, tEnd: 2 }).request;
    expect(cut.t_start).toBe(0.5);
    expect(cut.t_end).toBe(2);
  });

  it('sends a value that is not a number as null, and no sample with a time that is not one', () => {
    const s = series('a', 4);
    s.y[1] = Number.NaN;
    s.y[2] = Number.POSITIVE_INFINITY;
    s.t[3] = Number.NaN;

    const [sent] = metricsRequest([s], { tStart: null, tEnd: null }).request.series;

    expect(sent!.y).toEqual([1, null, null]);
    expect(sent!.t).toHaveLength(3);
  });

  it('asks about no more series than a request takes, and says how many it left out', () => {
    const many = Array.from({ length: MAX_METRIC_SERIES + 5 }, (_, i) => series(`s${i}`, 10));

    const plan = metricsRequest(many, { tStart: null, tEnd: null });

    expect(plan.request.series).toHaveLength(MAX_METRIC_SERIES);
    expect(plan.asked).toHaveLength(MAX_METRIC_SERIES);
    expect(plan.skipped).toBe(5);
  });

  it('thins a run that is longer than one series can be', () => {
    const plan = metricsRequest([series('a', MAX_METRIC_SAMPLES + 10)], {
      tStart: null,
      tEnd: null,
    });

    expect(plan.stride).toBe(2);
    expect(plan.request.series[0]!.t.length).toBeLessThanOrEqual(MAX_METRIC_SAMPLES);
    // Every second sample: the first is at 0 and the next at 2/30 s.
    expect(plan.request.series[0]!.t[1]).toBeCloseTo(2 / 30);
  });

  it('is an empty request for no series', () => {
    const plan = metricsRequest([], { tStart: null, tEnd: null });

    expect(plan.request.series).toEqual([]);
    expect(plan.skipped).toBe(0);
  });
});
