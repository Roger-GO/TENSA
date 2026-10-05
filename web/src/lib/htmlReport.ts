/**
 * The HTML report: one self-contained file of what a study came to, to read,
 * print or send. The Reports dialog shows ANDES's own plain-text reports; this
 * puts the results the UI holds beside them, as tables and charts:
 *
 * - the power flow: how it converged, the system totals, the limits it breaks,
 *   and every bus, line, generator and load;
 * - the comparison of two kept power flows, when two are being compared;
 * - the time-domain runs: the ones kept, and a chart of each quantity plotted;
 * - the eigenvalues, when an eigenvalue analysis has run;
 * - ANDES's plain-text reports, as an appendix.
 *
 * This module is pure: ``buildHtmlReport`` turns data into a string, and
 * ``lib/exportHtmlReport.ts`` gathers the data from the stores and the server.
 *
 * The file needs nothing else to open: its style is inline, its charts are
 * inline SVG, and it carries no script. Everything written into it that came
 * from a case file or from the user (element names, case names, run names) is
 * escaped, and the document's own content policy forbids scripts and network
 * requests besides, since case files are other people's data.
 */
import type { EigResult, PflowResult } from '@/api/types';
import type { ElementNames } from '@/lib/elementNames';
import {
  comparisonCellText,
  comparisonHeadline,
  comparisonTables,
  type PflowComparison,
} from '@/lib/pflowCompare';
import { describeSettings } from '@/lib/pflowOptions';
import { lossShare, summaryRows } from '@/lib/pflowSummary';
import { formatSignificant } from '@/lib/series';
import { radToDeg } from '@/lib/units';
import { summarizeViolations, type ViolationKind, type ViolationReport } from '@/lib/violations';

// ---- what a report is made from ------------------------------------------------

export interface ReportPflow {
  result: PflowResult;
  names: ElementNames;
  /** The limits the result breaks, or ``null`` when they were not checked. */
  violations: ViolationReport | null;
  /**
   * Which power flow this is, when it is not simply the last one run on the
   * open case: ``PF #2, solved on kundur_full at 2026-10-05 04:25``. Set for a
   * result taken from the kept power flows, which is what a report falls back
   * on once a time-domain run has moved the system on, or after a reload.
   */
  origin?: string;
}

/** One side of the comparison, as its heading names it. */
export interface ReportComparisonSide {
  label: string;
  caseName: string;
  /** When it was solved, as text. */
  takenAt: string;
}

export interface ReportComparison {
  a: ReportComparisonSide;
  b: ReportComparisonSide;
  comparison: PflowComparison;
}

export interface ReportSeries {
  name: string;
  t: ArrayLike<number>;
  y: ArrayLike<number>;
}

/** One chart: the series of a run that share a quantity and a unit. */
export interface ReportChart {
  title: string;
  /** The unit of the y axis; ``''`` for an ANDES variable, which has none here. */
  unit: string;
  series: readonly ReportSeries[];
}

export interface ReportRun {
  label: string;
  /** How it ended, in a word or two: ``done``, ``halted early``, ``aborted``. */
  outcome: string;
  /** When it started, as text. */
  startedAt: string;
  tf: number;
  /** The last simulated time it reached. */
  tEnd: number;
  rows: number;
  /** Empty for a run that is listed but not plotted. */
  charts: readonly ReportChart[];
}

export interface ReportAndesText {
  /** ``Power flow``, as the appendix heads it. */
  title: string;
  text: string;
}

export interface HtmlReportData {
  /** The case the report is of: a file name without extension, or ``New system``. */
  caseName: string;
  /** The files the case was opened from. */
  files: readonly string[];
  generatedAt: Date;
  versions: { tensa: string; andes: string } | null;
  pflow: ReportPflow | null;
  comparison: ReportComparison | null;
  runs: readonly ReportRun[];
  eig: EigResult | null;
  andesReports: readonly ReportAndesText[];
}

/** True when there is anything to put in a report. */
export function hasReportContent(
  data: Pick<HtmlReportData, 'pflow' | 'comparison' | 'runs' | 'eig'>,
): boolean {
  return (
    data.pflow !== null || data.comparison !== null || data.runs.length > 0 || data.eig !== null
  );
}

// ---- text ----------------------------------------------------------------------

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Text as it may stand in HTML, in an element or in a quoted attribute. */
export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

function fixed(value: number | null | undefined, digits: number): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** ``3 rated lines``, ``1 rated line``. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** A local date and time to the minute: ``2026-10-05 14:02``. */
export function formatReportTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---- tables ----------------------------------------------------------------------

interface Column {
  label: string;
  numeric?: boolean;
}

/** A table of cells that are already text. Every cell is escaped here. */
function table(columns: readonly Column[], rows: ReadonlyArray<readonly string[]>): string {
  const head = columns
    .map((c) => `<th${c.numeric ? ' class="n"' : ''} scope="col">${escapeHtml(c.label)}</th>`)
    .join('');
  const body = rows
    .map(
      (row) =>
        `<tr>${row
          .map(
            (cell, i) => `<td${columns[i]?.numeric ? ' class="n"' : ''}>${escapeHtml(cell)}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('\n');
  return `<div class="scroll"><table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table></div>`;
}

function nameOf(names: Record<string, string>, idx: string): string {
  return names[idx] ?? idx;
}

// ---- charts ----------------------------------------------------------------------

/** Colours for the series of a chart, chosen to tell apart on screen and in print. */
const SERIES_COLORS = [
  '#1f77b4',
  '#d62728',
  '#2ca02c',
  '#ff7f0e',
  '#9467bd',
  '#8c564b',
  '#e377c2',
  '#17becf',
  '#7f7f7f',
  '#bcbd22',
] as const;

/** The most series one chart draws; a chart with more says how many it left out. */
export const MAX_CHART_SERIES = 20;
/** The most points one series is drawn with. */
const MAX_CHART_POINTS = 800;

const CHART = { width: 760, height: 250, left: 64, right: 14, top: 10, bottom: 32 } as const;

/** The significant digits a tick value is rounded to. */
const TICK_DIGITS = 12;

/**
 * A signal whose range is within this share of its size is drawn as flat: its
 * values differ only in the last digits a tick holds or past them, which is
 * too little for an axis of round ticks that differ.
 */
const FLAT_SPAN = 10 ** (2 - TICK_DIGITS);

/**
 * Round tick values covering ``min..max``: about ``count`` of them, each a
 * multiple of 1, 2 or 5 times a power of ten. A range too narrow for its ticks
 * to differ in ``TICK_DIGITS`` digits gets one tick, and a range whose step a
 * number cannot hold gets none.
 */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const span = max - min;
  const wanted = Math.max(1, count);
  const raw = span / wanted;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
  // The span overflowed, or its step underflowed to nothing.
  if (!Number.isFinite(step) || step <= 0) return [];
  const first = Math.ceil(min / step - 1e-9) * step;
  // The ticks are counted, not added up until one passes ``max``: in a range
  // only a rounding error or two wide the step is too small to change the
  // value it is added to, and such a loop never ends. The step is at least
  // ``span / wanted``, so there are never more than about ``wanted`` of them;
  // the cap holds whatever the rounding does.
  const last = Math.min(Math.floor((max - first) / step + 1e-9), 2 * wanted);
  const ticks: number[] = [];
  for (let i = 0; i <= last; i += 1) {
    // Snap away the rounding of the arithmetic (0.30000000000000004).
    const tick = Number((first + i * step).toPrecision(TICK_DIGITS));
    // Ticks the snap cannot tell apart are one tick.
    if (tick !== ticks[ticks.length - 1]) ticks.push(tick);
  }
  return ticks;
}

/**
 * The points a series is drawn through: all of them when they are few, else
 * the lowest and the highest of each stretch of samples, in time order, so a
 * spike between two drawn points is not lost.
 */
export function thinSeries(
  t: ArrayLike<number>,
  y: ArrayLike<number>,
  maxPoints = MAX_CHART_POINTS,
): Array<[number, number]> {
  const length = Math.min(t.length, y.length);
  const points: Array<[number, number]> = [];
  const push = (i: number) => {
    const ti = t[i]!;
    const yi = y[i]!;
    if (Number.isFinite(ti) && Number.isFinite(yi)) points.push([ti, yi]);
  };
  if (length <= maxPoints) {
    for (let i = 0; i < length; i += 1) push(i);
    return points;
  }
  const buckets = Math.max(1, Math.floor(maxPoints / 2));
  const size = length / buckets;
  for (let b = 0; b < buckets; b += 1) {
    const start = Math.floor(b * size);
    const end = Math.min(length, Math.floor((b + 1) * size));
    let lo = -1;
    let hi = -1;
    for (let i = start; i < end; i += 1) {
      const yi = y[i]!;
      if (!Number.isFinite(yi)) continue;
      if (lo === -1 || yi < y[lo]!) lo = i;
      if (hi === -1 || yi > y[hi]!) hi = i;
    }
    if (lo === -1) continue;
    if (lo === hi) push(lo);
    else {
      push(Math.min(lo, hi));
      push(Math.max(lo, hi));
    }
  }
  return points;
}

function tickText(value: number): string {
  return formatSignificant(value, 5).replace('–', '');
}

/** A chart as inline SVG: the series as lines over time, with a legend under it. */
export function svgLineChart(chart: ReportChart): string {
  const drawn = chart.series.slice(0, MAX_CHART_SERIES);
  const lines = drawn.map((s) => thinSeries(s.t, s.y));
  let tMin = Infinity;
  let tMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const points of lines) {
    for (const [t, y] of points) {
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }
  const title = chart.unit === '' ? chart.title : `${chart.title} (${chart.unit})`;
  if (!Number.isFinite(tMin) || !Number.isFinite(yMin)) {
    return `<figure><figcaption>${escapeHtml(title)}</figcaption><p class="meta">No samples to draw.</p></figure>`;
  }
  // A flat signal still needs a band to be drawn in. So does one that is flat
  // but for its last digits (a steady state as the solver left it): its range
  // is narrower than the axis has ticks for, and a margin of a twentieth of
  // it would not widen it.
  const scale = Math.max(Math.abs(yMin), Math.abs(yMax));
  if (yMax - yMin <= scale * FLAT_SPAN) {
    const margin = scale > 0 ? scale * 0.01 : 1;
    yMin -= margin;
    yMax += margin;
  } else {
    const margin = (yMax - yMin) * 0.05;
    yMin -= margin;
    yMax += margin;
  }
  if (tMin === tMax) tMax = tMin + 1;

  const { width, height, left, right, top, bottom } = CHART;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const px = (t: number) => left + ((t - tMin) / (tMax - tMin)) * plotW;
  const py = (y: number) => top + (1 - (y - yMin) / (yMax - yMin)) * plotH;

  const parts: string[] = [];
  parts.push(
    `<rect x="${left}" y="${top}" width="${plotW}" height="${plotH}" fill="none" stroke="#8c959f" stroke-width="1"/>`,
  );
  for (const tick of niceTicks(yMin, yMax, 5)) {
    const y = py(tick).toFixed(1);
    parts.push(
      `<line x1="${left}" y1="${y}" x2="${left + plotW}" y2="${y}" stroke="#e3e8ee" stroke-width="1"/>`,
      `<text x="${left - 6}" y="${y}" dy="0.32em" text-anchor="end">${escapeHtml(tickText(tick))}</text>`,
    );
  }
  for (const tick of niceTicks(tMin, tMax, 8)) {
    const x = px(tick).toFixed(1);
    parts.push(
      `<line x1="${x}" y1="${top + plotH}" x2="${x}" y2="${top + plotH + 4}" stroke="#8c959f" stroke-width="1"/>`,
      `<text x="${x}" y="${top + plotH + 16}" text-anchor="middle">${escapeHtml(tickText(tick))}</text>`,
    );
  }
  parts.push(`<text x="${left + plotW}" y="${height - 2}" text-anchor="end">time (s)</text>`);
  lines.forEach((points, i) => {
    if (points.length === 0) return;
    const color = SERIES_COLORS[i % SERIES_COLORS.length]!;
    const path = points.map(([t, y]) => `${px(t).toFixed(1)},${py(y).toFixed(1)}`).join(' ');
    // A second pass through the palette is dashed, so twenty series stay apart.
    const dash = i >= SERIES_COLORS.length ? ' stroke-dasharray="5 3"' : '';
    parts.push(
      `<polyline points="${path}" fill="none" stroke="${color}" stroke-width="1.3" stroke-linejoin="round"${dash}/>`,
    );
  });

  const legend = drawn
    .map((s, i) => {
      const color = SERIES_COLORS[i % SERIES_COLORS.length]!;
      const style = i >= SERIES_COLORS.length ? 'dashed' : 'solid';
      return `<span><i style="border-top:2px ${style} ${color}"></i>${escapeHtml(s.name)}</span>`;
    })
    .join('');
  const left_out = chart.series.length - drawn.length;
  const more =
    left_out > 0
      ? `<p class="meta">The first ${drawn.length} of ${chart.series.length} series are drawn.</p>`
      : '';
  return [
    '<figure>',
    `<figcaption>${escapeHtml(title)}</figcaption>`,
    `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeHtml(title)} over time" xmlns="http://www.w3.org/2000/svg">`,
    parts.join('\n'),
    '</svg>',
    `<div class="legend">${legend}</div>`,
    more,
    '</figure>',
  ].join('\n');
}

/** Where each plotted series started, its lowest and highest value, and where it ended. */
function seriesStats(chart: ReportChart): string {
  const rows = chart.series.map((s) => {
    const length = Math.min(s.t.length, s.y.length);
    let first: number | null = null;
    let last: number | null = null;
    let lo: number | null = null;
    let hi: number | null = null;
    let tLo = 0;
    let tHi = 0;
    for (let i = 0; i < length; i += 1) {
      const y = s.y[i]!;
      if (!Number.isFinite(y)) continue;
      if (first === null) first = y;
      last = y;
      if (lo === null || y < lo) {
        lo = y;
        tLo = s.t[i]!;
      }
      if (hi === null || y > hi) {
        hi = y;
        tHi = s.t[i]!;
      }
    }
    const value = (v: number | null) => (v === null ? '' : formatSignificant(v, 6));
    return [
      s.name,
      value(first),
      value(lo),
      lo === null ? '' : fixed(tLo, 3),
      value(hi),
      hi === null ? '' : fixed(tHi, 3),
      value(last),
    ];
  });
  const unit = chart.unit === '' ? '' : ` (${chart.unit})`;
  return table(
    [
      { label: 'series' },
      { label: `initial${unit}`, numeric: true },
      { label: `lowest${unit}`, numeric: true },
      { label: 'at t (s)', numeric: true },
      { label: `highest${unit}`, numeric: true },
      { label: 'at t (s)', numeric: true },
      { label: `final${unit}`, numeric: true },
    ],
    rows,
  );
}

// ---- sections ----------------------------------------------------------------------

interface Section {
  id: string;
  title: string;
  html: string;
}

const VIOLATION_TYPE: Record<ViolationKind, string> = {
  'bus-voltage': 'Bus voltage',
  'line-loading': 'Line loading',
  'generator-q': 'Generator Q',
};

function pflowSection({ result, names, violations, origin }: ReportPflow): Section {
  const parts: string[] = [];
  if (!result.converged) {
    parts.push(
      `<p>The power flow did not converge in ${result.iterations} iterations (last mismatch ${escapeHtml(result.mismatch.toExponential(2))}), so it has no results to report.</p>`,
    );
    return { id: 'power-flow', title: 'Power flow', html: parts.join('\n') };
  }
  const summary = result.summary ?? null;
  // A result with no totals and no line flows is the operating point read back
  // after a time-domain run: where that run ended, voltages only.
  const operatingPoint = summary === null && Object.keys(result.line_flows ?? {}).length === 0;
  const title = operatingPoint ? 'Operating point' : 'Power flow';
  if (origin !== undefined) {
    parts.push(`<p class="meta">The last power flow solved: ${escapeHtml(origin)}.</p>`);
  }
  if (operatingPoint) {
    parts.push(
      '<p>This operating point was read after a time-domain run: it is where that run ended, not a solved power flow, and has bus voltages only.</p>',
    );
  }
  if (summary !== null) {
    const settings = result.settings ? ` It ran with ${describeSettings(result.settings)}.` : '';
    parts.push(
      `<p>Converged in ${result.iterations} iterations, final mismatch ${escapeHtml(result.mismatch.toExponential(2))}.${escapeHtml(settings)}</p>`,
    );
    const share = lossShare(summary);
    parts.push(
      '<h3>System totals</h3>',
      table(
        [
          { label: 'quantity' },
          { label: 'P (MW)', numeric: true },
          { label: 'Q (MVAr)', numeric: true },
        ],
        summaryRows(summary).map((r) => [r.label, fixed(r.p, 2), fixed(r.q, 2)]),
      ),
      `<p class="meta">Generation equals load plus bus shunts plus line losses${share === null ? '' : `; the lines lose ${share.toFixed(2)}% of the active generation`}. A negative Q is reactive power supplied.</p>`,
    );
  }

  if (violations !== null) {
    const { buses, lines, generators } = violations.checked;
    const unrated = violations.unratedLines;
    const unratedText =
      unrated === 0
        ? ''
        : `; ${unrated === 1 ? '1 line has' : `${unrated} lines have`} no rating and ${unrated === 1 ? 'is' : 'are'} not checked for overload`;
    parts.push(
      '<h3>Limits</h3>',
      `<p>${escapeHtml(summarizeViolations(violations))}. Checked ${count(buses, 'bus voltage')}, ${count(lines, 'rated line')} and ${count(generators, 'generator')}${unratedText}.</p>`,
    );
    if (violations.items.length > 0) {
      parts.push(
        table(
          [
            { label: 'severity' },
            { label: 'type' },
            { label: 'name' },
            { label: 'idx' },
            { label: 'finding' },
            { label: 'value', numeric: true },
            { label: 'limit', numeric: true },
            { label: 'unit' },
          ],
          violations.items.map((item) => [
            item.severity === 'violation' ? 'Violation' : 'Warning',
            VIOLATION_TYPE[item.kind],
            item.name,
            item.idx,
            item.finding,
            fixed(item.value, 3),
            fixed(item.limit, 3),
            item.unit,
          ]),
        ),
      );
    }
  }

  const busIds = Object.keys(result.bus_voltages);
  parts.push(
    `<h3>Buses (${busIds.length})</h3>`,
    table(
      [
        { label: 'idx' },
        { label: 'name' },
        { label: 'V (pu)', numeric: true },
        { label: 'angle (deg)', numeric: true },
      ],
      busIds.map((idx) => {
        const angle = result.bus_angles[idx];
        return [
          idx,
          nameOf(names.buses, idx),
          fixed(result.bus_voltages[idx], 4),
          typeof angle === 'number' ? fixed(radToDeg(angle), 3) : '',
        ];
      }),
    ),
  );

  const flows = Object.entries(result.line_flows ?? {});
  if (flows.length > 0) {
    parts.push(
      `<h3>Lines and transformers (${flows.length})</h3>`,
      table(
        [
          { label: 'idx' },
          { label: 'name' },
          { label: 'from' },
          { label: 'to' },
          { label: 'P from (MW)', numeric: true },
          { label: 'Q from (MVAr)', numeric: true },
          { label: 'P to (MW)', numeric: true },
          { label: 'Q to (MVAr)', numeric: true },
          { label: 'loss (MW)', numeric: true },
          { label: 'loading (%)', numeric: true },
        ],
        flows.map(([idx, f]) => [
          idx,
          nameOf(names.lines, idx),
          String(f.from_idx),
          String(f.to_idx),
          fixed(f.p, 2),
          fixed(f.q, 2),
          fixed(f.p_to, 2),
          fixed(f.q_to, 2),
          fixed(f.loss, 3),
          fixed(f.loading_pct, 1),
        ]),
      ),
      '<p class="meta">Power is counted leaving the bus into the line at each end. A line with no rating has no loading.</p>',
    );
  }

  const generators = Object.entries(result.generator_outputs ?? {});
  if (generators.length > 0) {
    parts.push(
      `<h3>Generators (${generators.length})</h3>`,
      table(
        [
          { label: 'idx' },
          { label: 'name' },
          { label: 'bus' },
          { label: 'P (MW)', numeric: true },
          { label: 'Q (MVAr)', numeric: true },
          { label: 'V (pu)', numeric: true },
          { label: 'Qmin (MVAr)', numeric: true },
          { label: 'Qmax (MVAr)', numeric: true },
        ],
        generators.map(([idx, g]) => [
          idx,
          nameOf(names.generators, idx),
          String(g.bus),
          fixed(g.p, 2),
          fixed(g.q, 2),
          fixed(g.v, 4),
          fixed(g.q_min, 2),
          fixed(g.q_max, 2),
        ]),
      ),
    );
  }

  const loads = Object.entries(result.load_consumption ?? {});
  if (loads.length > 0) {
    parts.push(
      `<h3>Loads (${loads.length})</h3>`,
      table(
        [
          { label: 'idx' },
          { label: 'name' },
          { label: 'bus' },
          { label: 'P (MW)', numeric: true },
          { label: 'Q (MVAr)', numeric: true },
        ],
        loads.map(([idx, l]) => [
          idx,
          nameOf(names.loads, idx),
          String(l.bus),
          fixed(l.p, 2),
          fixed(l.q, 2),
        ]),
      ),
    );
  }
  return { id: 'power-flow', title, html: parts.join('\n') };
}

function comparisonSection({ a, b, comparison }: ReportComparison): Section {
  const side = (letter: string, s: ReportComparisonSide) =>
    `<li><strong>${letter}</strong>: ${escapeHtml(s.label)}, ${escapeHtml(s.caseName)}, solved ${escapeHtml(s.takenAt)}</li>`;
  const parts: string[] = [
    `<ul>${side('A (reference)', a)}${side('B', b)}</ul>`,
    `<p>${escapeHtml(comparisonHeadline(comparison))} Every difference is B minus A.</p>`,
  ];
  for (const t of comparisonTables(comparison)) {
    if (t.rows.length === 0) continue;
    parts.push(
      `<h3>${escapeHtml(t.title)} (${t.rows.length})</h3>`,
      table(
        t.columns.map((c) => ({ label: c.label, numeric: c.numeric })),
        t.rows.map((row) => row.cells.map((cell, i) => comparisonCellText(cell, t.columns[i]!))),
      ),
    );
  }
  return { id: 'comparison', title: 'Power flow comparison', html: parts.join('\n') };
}

function runsSection(runs: readonly ReportRun[]): Section {
  const parts: string[] = [
    table(
      [
        { label: 'run' },
        { label: 'started' },
        { label: 'outcome' },
        { label: 'tf (s)', numeric: true },
        { label: 'reached t (s)', numeric: true },
        { label: 'rows', numeric: true },
      ],
      runs.map((r) => [
        r.label,
        r.startedAt,
        r.outcome,
        fixed(r.tf, 3),
        fixed(r.tEnd, 3),
        String(r.rows),
      ]),
    ),
  ];
  for (const run of runs) {
    if (run.charts.length === 0) continue;
    parts.push(`<h3>${escapeHtml(run.label)}</h3>`);
    for (const chart of run.charts) {
      parts.push(svgLineChart(chart), seriesStats(chart));
    }
  }
  if (!runs.some((r) => r.charts.length > 0)) {
    parts.push(
      '<p class="meta">No run was on the plot when the report was made, so none is charted. Pin a run in History and pick variables on the Plot tab to chart it.</p>',
    );
  }
  return { id: 'time-domain', title: 'Time-domain runs', html: parts.join('\n') };
}

function eigSection(eig: EigResult): Section {
  const modes = eig.eigenvalues.map((value, i) => ({
    mode: i + 1,
    real: value.real,
    imag: value.imag,
    damping: eig.damping_ratios[i],
    frequency: eig.frequencies_hz[i],
  }));
  const unstable = modes.filter((m) => m.real > 0).length;
  // The least damped first: they are the ones a reader looks for.
  modes.sort(
    (x, y) => (x.damping ?? Number.POSITIVE_INFINITY) - (y.damping ?? Number.POSITIVE_INFINITY),
  );
  const html = [
    `<p>${eig.mode_count} modes of ${eig.state_count} states. ${unstable === 0 ? 'None has a positive real part.' : `${unstable} ${unstable === 1 ? 'has' : 'have'} a positive real part.`} Least damped first.</p>`,
    table(
      [
        { label: 'mode', numeric: true },
        { label: 'real (1/s)', numeric: true },
        { label: 'imaginary (rad/s)', numeric: true },
        { label: 'damping ratio (%)', numeric: true },
        { label: 'frequency (Hz)', numeric: true },
      ],
      modes.map((m) => [
        String(m.mode),
        fixed(m.real, 4),
        fixed(m.imag, 4),
        typeof m.damping === 'number' ? fixed(m.damping * 100, 2) : '',
        fixed(m.frequency, 4),
      ]),
    ),
  ].join('\n');
  return { id: 'eigenvalues', title: 'Eigenvalues', html };
}

function andesSection(reports: readonly ReportAndesText[]): Section {
  const html = reports
    .map((r) => `<h3>${escapeHtml(r.title)}</h3>\n<pre>${escapeHtml(r.text)}</pre>`)
    .join('\n');
  return { id: 'andes-reports', title: 'ANDES reports', html };
}

// ---- the document ----------------------------------------------------------------

const STYLE = `
:root { color-scheme: light; }
body { margin: 0; background: #fff; color: #1b1f24; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
main { max-width: 1120px; margin: 0 auto; padding: 32px 24px 64px; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 40px 0 10px; padding-bottom: 4px; border-bottom: 1px solid #d0d7de; }
h3 { font-size: 14px; margin: 22px 0 6px; }
p { margin: 6px 0; }
ul { margin: 6px 0; padding-left: 20px; }
.meta { color: #57606a; font-size: 12px; }
nav { margin: 14px 0 0; font-size: 13px; }
nav a { color: #0969da; text-decoration: none; margin-right: 14px; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; margin: 6px 0 12px; font-size: 12px; }
th, td { padding: 3px 7px; text-align: left; white-space: nowrap; border-bottom: 1px solid #e3e8ee; }
thead th { background: #f6f8fa; border-bottom: 1px solid #8c959f; font-weight: 600; }
.n { text-align: right; font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
figure { margin: 12px 0 6px; }
figcaption { font-size: 12px; font-weight: 600; margin-bottom: 4px; }
svg { max-width: 100%; height: auto; }
svg text { font: 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; fill: #57606a; }
.legend { display: flex; flex-wrap: wrap; gap: 2px 14px; font-size: 11px; color: #57606a; }
.legend i { display: inline-block; width: 16px; margin-right: 5px; vertical-align: middle; }
pre { margin: 6px 0 14px; padding: 10px 12px; overflow-x: auto; background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 4px; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
footer { margin-top: 48px; padding-top: 10px; border-top: 1px solid #d0d7de; }
@media print {
  main { max-width: none; padding: 0; }
  nav { display: none; }
  h2, h3, figcaption { break-after: avoid; }
  tr, figure { break-inside: avoid; }
  .scroll { overflow: visible; }
  th, td { white-space: normal; }
}
`.trim();

/** The report as one HTML document. */
export function buildHtmlReport(data: HtmlReportData): string {
  const sections: Section[] = [];
  if (data.pflow !== null) sections.push(pflowSection(data.pflow));
  if (data.comparison !== null) sections.push(comparisonSection(data.comparison));
  if (data.runs.length > 0) sections.push(runsSection(data.runs));
  if (data.eig !== null) sections.push(eigSection(data.eig));
  if (data.andesReports.length > 0) sections.push(andesSection(data.andesReports));

  const made = formatReportTime(data.generatedAt);
  const versions =
    data.versions === null
      ? 'TENSA'
      : `TENSA ${data.versions.tensa} with ANDES ${data.versions.andes}`;
  const files =
    data.files.length === 0 ? '' : ` Case files: ${data.files.map(escapeHtml).join(', ')}.`;
  const title = `TENSA report: ${data.caseName}`;
  const nav = sections.map((s) => `<a href="#${s.id}">${escapeHtml(s.title)}</a>`).join('');
  const body =
    sections.length === 0
      ? '<p>There are no results to report yet. Run a power flow or a time-domain simulation first.</p>'
      : sections
          .map(
            (s) => `<section id="${s.id}">\n<h2>${escapeHtml(s.title)}</h2>\n${s.html}\n</section>`,
          )
          .join('\n');

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    // No script runs and nothing is fetched, whatever a case file's names hold.
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="TENSA">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    '<header>',
    `<h1>${escapeHtml(data.caseName)}</h1>`,
    `<p class="meta">Report made ${escapeHtml(made)} by ${escapeHtml(versions)}.${files}</p>`,
    sections.length > 1 ? `<nav aria-label="Sections">${nav}</nav>` : '',
    '</header>',
    body,
    `<footer class="meta">Voltages are per unit and angles in degrees unless a heading says otherwise; powers are in MW and MVAr. Made by TENSA from the results held in the browser at ${escapeHtml(made)}.</footer>`,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
