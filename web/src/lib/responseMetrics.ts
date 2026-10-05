/**
 * Preparing the plotted signals of a run for ``POST /response-metrics`` and
 * reading its answer. Pure, so what is sent (the values as the charts show them,
 * inside the window the cursors mark) is testable without a chart or a server.
 *
 * The metrics are computed by the substrate (``tensa.core.response_metrics``);
 * this module only decides what to ask about.
 */
import type { MetricsSeries, ResponseMetricsRequest } from '@/api/types';
import type { RunRecord } from '@/store/runs';
import { chartKeyOf, parseColumnName } from '@/store/plot';
import type { DeltaCursors, ParsedSeries, VarGroup } from '@/store/plot';
import { planGroupAxes, scaleColumn } from '@/components/plots/axes';
import type { PlannedSeries } from '@/components/plots/axes';
import type { UnitMode } from '@/lib/units';

/**
 * The settings the table asks for: a settling band of 2 % of the largest
 * distance from the final value, and the rate of change measured over 0.5 s.
 * They are the substrate's defaults, sent explicitly so the table's header and
 * what was computed cannot drift apart.
 */
export const SETTLING_BAND = 0.02;
export const ROCOF_WINDOW_S = 0.5;

/** The substrate's bounds on one request (``api/schemas.py``). */
export const MAX_METRIC_SERIES = 64;
export const MAX_METRIC_SAMPLES = 200_000;
export const MAX_METRIC_SAMPLES_TOTAL = 1_000_000;

/** One plotted series as the charts show it, in its display unit. */
export interface DisplayedSeries {
  /** The run's column name. */
  name: string;
  /** The unit its values are in (``pu``, ``kV``, ``Hz``, ``°``, ``MW``, ``MVAr``), ``''`` for an ANDES variable. */
  unit: string;
  /** The run's times, and the series' values in ``unit``; both cover the rows the run has. */
  t: Float64Array;
  y: Float64Array;
}

/**
 * The window the metrics are read over: between the two cursors when both are
 * placed (whichever is earlier first), otherwise the whole run, expressed as
 * ``null`` bounds the substrate takes as the ends of the signal.
 */
export interface MetricsWindow {
  tStart: number | null;
  tEnd: number | null;
}

export function metricsWindow(cursors: DeltaCursors | undefined): MetricsWindow {
  if (cursors === undefined || cursors.a === null || cursors.b === null) {
    return { tStart: null, tEnd: null };
  }
  return { tStart: Math.min(cursors.a, cursors.b), tEnd: Math.max(cursors.a, cursors.b) };
}

/** What a series is measured in, from its axis: a power axis holds MW and MVAr both. */
function unitOf(series: ParsedSeries, axisUnit: string, quantity: string): string {
  if (quantity !== 'power') return axisUnit;
  return series.field === 'q' || series.field === 'Qe' ? 'MVAr' : 'MW';
}

/**
 * The selected series of ``run`` in the units the plot shows them in. Each is
 * scaled the way its chart scales it (kV and Hz where the plot is in actual
 * units and the case gives the base, degrees for an angle), so a metric read off
 * the table matches what the chart's axis says.
 */
export function displayedSeries(
  run: RunRecord,
  selected: ReadonlySet<string>,
  mode: UnitMode,
): DisplayedSeries[] {
  const length = run.seqCount;
  const t = run.t.subarray(0, length);
  // The charts: one per chart key, planned over every series on it, as the plot does.
  const charts = new Map<string, { group: VarGroup; series: ParsedSeries[] }>();
  for (const name of run.columnNames) {
    if (!selected.has(name) || run.columns[name] === undefined) continue;
    const parsed = parseColumnName(name);
    if (parsed === null) continue;
    const key = chartKeyOf(parsed);
    const chart = charts.get(key);
    if (chart) chart.series.push(parsed);
    else charts.set(key, { group: parsed.group, series: [parsed] });
  }
  const out: DisplayedSeries[] = [];
  for (const { group, series } of charts.values()) {
    const planned: PlannedSeries[] = series.map((s) => ({ series: s, bases: run.bases }));
    const plan = planGroupAxes(group, planned, mode);
    for (const s of series) {
      const { scale, factor } = plan.place({ series: s, bases: run.bases });
      const axis = plan.axes.find((a) => a.scale === scale);
      out.push({
        name: s.name,
        unit: unitOf(s, axis?.unit ?? '', axis?.quantity ?? ''),
        t,
        y: scaleColumn(run.columns[s.name]!.subarray(0, length), factor),
      });
    }
  }
  return out;
}

/** How many series and how many samples of each a request can carry. */
export function metricsLimits(samples: number): { series: number; stride: number } {
  const stride = Math.max(1, Math.ceil(samples / MAX_METRIC_SAMPLES));
  const each = Math.max(1, Math.ceil(samples / stride));
  return {
    series: Math.max(1, Math.min(MAX_METRIC_SERIES, Math.floor(MAX_METRIC_SAMPLES_TOTAL / each))),
    stride,
  };
}

/** A series as the request carries it: every ``stride``-th sample, a value that is not a number as ``null``. */
function toRequestSeries(series: DisplayedSeries, stride: number): MetricsSeries {
  const t: number[] = [];
  const y: (number | null)[] = [];
  for (let i = 0; i < series.t.length; i += stride) {
    const time = series.t[i]!;
    if (!Number.isFinite(time)) continue;
    const value = series.y[i]!;
    t.push(time);
    y.push(Number.isFinite(value) ? value : null);
  }
  return { name: series.name, t, y };
}

export interface MetricsRequestPlan {
  request: ResponseMetricsRequest;
  /** The series asked about, in order (the request's own are in this order). */
  asked: readonly DisplayedSeries[];
  /** How many selected series the request left out for being over its limits. */
  skipped: number;
  /** Whether the run was thinned to every nth sample to fit the request's limits. */
  stride: number;
}

/**
 * The request for ``series`` over ``window``, within the substrate's limits: no
 * more series than a request takes for the run's length, and every nth sample
 * when the run is longer than one series can be (a two-hour run at 30 Hz).
 */
export function metricsRequest(
  series: readonly DisplayedSeries[],
  window: MetricsWindow,
): MetricsRequestPlan {
  const samples = series[0]?.t.length ?? 0;
  const { series: maxSeries, stride } = metricsLimits(samples);
  const asked = series.slice(0, maxSeries);
  return {
    request: {
      series: asked.map((s) => toRequestSeries(s, stride)),
      settling_band: SETTLING_BAND,
      rocof_window: ROCOF_WINDOW_S,
      ...(window.tStart === null ? {} : { t_start: window.tStart }),
      ...(window.tEnd === null ? {} : { t_end: window.tEnd }),
    },
    asked,
    skipped: series.length - asked.length,
    stride,
  };
}
