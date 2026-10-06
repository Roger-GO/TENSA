/**
 * The difference between two solved power flows, A and B: what each bus
 * voltage and angle, each branch flow, each generator's and load's power and
 * the system totals moved by. Pure (no React, no stores), so the Compare tab
 * and the HTML report read one set of numbers.
 *
 * Every difference is B minus A, so A is the reference and a positive ΔV is a
 * voltage that rose from A to B. Voltages are per unit, angles in degrees (the
 * substrate sends radians) with their difference brought into -180..180, powers
 * in MW and MVAr, loading in percent of the rating, so its difference is in
 * percentage points.
 *
 * The two results need not be of one case: an element is matched by its idx,
 * and one that only A or only B has (a line added between the runs, another
 * case's bus) is listed with no difference and marked as being in one result
 * only.
 */
import type { PflowResult } from '@/api/types';
import type { ElementNames } from '@/lib/elementNames';
import { summaryRows } from '@/lib/pflowSummary';
import { radToDeg } from '@/lib/units';
import { finiteOrNull } from '@/lib/finite';

/** One side of a comparison: a converged result and the names of its elements. */
export interface PflowSide {
  result: PflowResult;
  names: ElementNames;
}

/** Which of the two results an element is missing from: it is only in the other. */
export type OnlyIn = 'A' | 'B' | null;

export interface BusDelta {
  idx: string;
  name: string;
  onlyIn: OnlyIn;
  /** Voltage magnitude, per unit. */
  vA: number | null;
  vB: number | null;
  dV: number | null;
  /** Voltage angle, degrees. */
  angleA: number | null;
  angleB: number | null;
  dAngle: number | null;
}

export interface LineDelta {
  idx: string;
  name: string;
  fromIdx: string;
  toIdx: string;
  onlyIn: OnlyIn;
  /** Active power leaving the from bus into the line, MW. */
  pA: number | null;
  pB: number | null;
  dP: number | null;
  /** Reactive power leaving the from bus into the line, MVAr. */
  qA: number | null;
  qB: number | null;
  dQ: number | null;
  /** Change of the power leaving the to bus into the line. */
  dPTo: number | null;
  dQTo: number | null;
  dLoss: number | null;
  /** Loading in percent of the rating; `null` for a line with none. */
  loadingA: number | null;
  loadingB: number | null;
  dLoading: number | null;
}

/** A generator's output or a load's draw. */
export interface InjectionDelta {
  idx: string;
  name: string;
  bus: string;
  onlyIn: OnlyIn;
  pA: number | null;
  pB: number | null;
  dP: number | null;
  qA: number | null;
  qB: number | null;
  dQ: number | null;
}

export interface TotalDelta {
  id: string;
  label: string;
  pA: number | null;
  pB: number | null;
  dP: number | null;
  qA: number | null;
  qB: number | null;
  dQ: number | null;
}

/** The element a quantity changed most on, with the signed change. */
export interface Extreme {
  idx: string;
  name: string;
  value: number;
}

export interface PflowComparison {
  /** Each list has the largest change first; equal changes keep B's order. */
  buses: BusDelta[];
  lines: LineDelta[];
  generators: InjectionDelta[];
  loads: InjectionDelta[];
  /** Empty when either result carries no system summary. */
  totals: TotalDelta[];
  maxDV: Extreme | null;
  maxDAngle: Extreme | null;
  /** The branch whose from-side active power changed most. */
  maxDP: Extreme | null;
  /** How many elements are in one result only. */
  unmatched: number;
  /** True when nothing differs: every element is in both and no value moved. */
  identical: boolean;
}

/** A change below this is rounding, not a difference. */
export const SAME_TOLERANCE = 1e-9;

function delta(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : b - a;
}

/** A difference of two angles in degrees, brought into -180..180. */
export function wrapDegrees(degrees: number): number {
  const wrapped = ((((degrees + 180) % 360) + 360) % 360) - 180;
  // 180 and -180 are one angle; keep the sign the difference came with.
  return wrapped === -180 && degrees > 0 ? 180 : wrapped;
}

function onlyIn(inA: boolean, inB: boolean): OnlyIn {
  if (inA && inB) return null;
  return inA ? 'A' : 'B';
}

/** B's keys in B's order, then the keys only A has, in A's order. */
function unionKeys(a: object | undefined, b: object | undefined): string[] {
  const keys = Object.keys(b ?? {});
  const seen = new Set(keys);
  for (const key of Object.keys(a ?? {})) {
    if (!seen.has(key)) keys.push(key);
  }
  return keys;
}

/**
 * Largest change first. An element in one result only has changed more than
 * any number says, so it leads. The sort is stable: rows that changed by the
 * same amount (a comparison of a result with itself) stay in B's order.
 */
function byChange<Row extends { onlyIn: OnlyIn }>(
  rows: Row[],
  ...magnitudes: Array<(row: Row) => number | null>
): Row[] {
  const rank = (row: Row, of: (row: Row) => number | null): number => {
    if (row.onlyIn !== null) return Number.POSITIVE_INFINITY;
    return Math.abs(of(row) ?? 0);
  };
  return [...rows].sort((x, y) => {
    for (const of of magnitudes) {
      const diff = rank(y, of) - rank(x, of);
      if (diff !== 0 && !Number.isNaN(diff)) return diff;
    }
    return 0;
  });
}

function extremeOf<Row extends { idx: string; name: string }>(
  rows: readonly Row[],
  of: (row: Row) => number | null,
): Extreme | null {
  let best: Extreme | null = null;
  for (const row of rows) {
    const value = of(row);
    if (value === null) continue;
    if (best === null || Math.abs(value) > Math.abs(best.value)) {
      best = { idx: row.idx, name: row.name, value };
    }
  }
  return best;
}

function nameOf(key: string, b: Record<string, string>, a: Record<string, string>): string {
  return b[key] ?? a[key] ?? key;
}

function compareBuses(a: PflowSide, b: PflowSide): BusDelta[] {
  const rows = unionKeys(a.result.bus_voltages, b.result.bus_voltages).map((idx): BusDelta => {
    const vA = finiteOrNull(a.result.bus_voltages[idx]);
    const vB = finiteOrNull(b.result.bus_voltages[idx]);
    const radA = finiteOrNull(a.result.bus_angles[idx]);
    const radB = finiteOrNull(b.result.bus_angles[idx]);
    const angleA = radA === null ? null : radToDeg(radA);
    const angleB = radB === null ? null : radToDeg(radB);
    const dAngle = delta(angleA, angleB);
    return {
      idx,
      name: nameOf(idx, b.names.buses, a.names.buses),
      onlyIn: onlyIn(idx in a.result.bus_voltages, idx in b.result.bus_voltages),
      vA,
      vB,
      dV: delta(vA, vB),
      angleA,
      angleB,
      dAngle: dAngle === null ? null : wrapDegrees(dAngle),
    };
  });
  return byChange(
    rows,
    (r) => r.dV,
    (r) => r.dAngle,
  );
}

function compareLines(a: PflowSide, b: PflowSide): LineDelta[] {
  const flowsA = a.result.line_flows ?? {};
  const flowsB = b.result.line_flows ?? {};
  const rows = unionKeys(flowsA, flowsB).map((idx): LineDelta => {
    const fa = flowsA[idx];
    const fb = flowsB[idx];
    const ends = fb ?? fa;
    const pA = finiteOrNull(fa?.p);
    const pB = finiteOrNull(fb?.p);
    const qA = finiteOrNull(fa?.q);
    const qB = finiteOrNull(fb?.q);
    const loadingA = finiteOrNull(fa?.loading_pct);
    const loadingB = finiteOrNull(fb?.loading_pct);
    return {
      idx,
      name: nameOf(idx, b.names.lines, a.names.lines),
      fromIdx: ends === undefined ? '' : String(ends.from_idx),
      toIdx: ends === undefined ? '' : String(ends.to_idx),
      onlyIn: onlyIn(fa !== undefined, fb !== undefined),
      pA,
      pB,
      dP: delta(pA, pB),
      qA,
      qB,
      dQ: delta(qA, qB),
      dPTo: delta(finiteOrNull(fa?.p_to), finiteOrNull(fb?.p_to)),
      dQTo: delta(finiteOrNull(fa?.q_to), finiteOrNull(fb?.q_to)),
      dLoss: delta(finiteOrNull(fa?.loss), finiteOrNull(fb?.loss)),
      loadingA,
      loadingB,
      dLoading: delta(loadingA, loadingB),
    };
  });
  return byChange(
    rows,
    (r) => r.dP,
    (r) => r.dQ,
  );
}

interface Injection {
  p: number;
  q: number;
  bus: number | string;
}

function compareInjections(
  rowsA: Record<string, Injection> | undefined,
  rowsB: Record<string, Injection> | undefined,
  namesA: Record<string, string>,
  namesB: Record<string, string>,
): InjectionDelta[] {
  const inA = rowsA ?? {};
  const inB = rowsB ?? {};
  const rows = unionKeys(inA, inB).map((idx): InjectionDelta => {
    const ra = inA[idx];
    const rb = inB[idx];
    const pA = finiteOrNull(ra?.p);
    const pB = finiteOrNull(rb?.p);
    const qA = finiteOrNull(ra?.q);
    const qB = finiteOrNull(rb?.q);
    const bus = (rb ?? ra)?.bus;
    return {
      idx,
      name: nameOf(idx, namesB, namesA),
      bus: bus === undefined ? '' : String(bus),
      onlyIn: onlyIn(ra !== undefined, rb !== undefined),
      pA,
      pB,
      dP: delta(pA, pB),
      qA,
      qB,
      dQ: delta(qA, qB),
    };
  });
  return byChange(
    rows,
    (r) => r.dP,
    (r) => r.dQ,
  );
}

function compareTotals(a: PflowSide, b: PflowSide): TotalDelta[] {
  const sa = a.result.summary;
  const sb = b.result.summary;
  if (!sa || !sb) return [];
  const rowsA = summaryRows(sa);
  return summaryRows(sb).map((rowB, i): TotalDelta => {
    const rowA = rowsA[i]!;
    return {
      id: rowB.id,
      label: rowB.label,
      pA: rowA.p,
      pB: rowB.p,
      dP: delta(rowA.p, rowB.p),
      qA: rowA.q,
      qB: rowB.q,
      dQ: delta(rowA.q, rowB.q),
    };
  });
}

function moved(value: number | null): boolean {
  return value !== null && Math.abs(value) > SAME_TOLERANCE;
}

/** What changed from `a` (the reference) to `b`. */
export function comparePflow(a: PflowSide, b: PflowSide): PflowComparison {
  const buses = compareBuses(a, b);
  const lines = compareLines(a, b);
  const generators = compareInjections(
    a.result.generator_outputs,
    b.result.generator_outputs,
    a.names.generators,
    b.names.generators,
  );
  const loads = compareInjections(
    a.result.load_consumption,
    b.result.load_consumption,
    a.names.loads,
    b.names.loads,
  );
  const totals = compareTotals(a, b);
  const all: ReadonlyArray<{ onlyIn: OnlyIn }> = [...buses, ...lines, ...generators, ...loads];
  const unmatched = all.filter((row) => row.onlyIn !== null).length;
  const identical =
    unmatched === 0 &&
    !buses.some((r) => moved(r.dV) || moved(r.dAngle)) &&
    !lines.some(
      (r) =>
        moved(r.dP) ||
        moved(r.dQ) ||
        moved(r.dPTo) ||
        moved(r.dQTo) ||
        moved(r.dLoss) ||
        moved(r.dLoading),
    ) &&
    ![...generators, ...loads].some((r) => moved(r.dP) || moved(r.dQ)) &&
    !totals.some((r) => moved(r.dP) || moved(r.dQ));
  return {
    buses,
    lines,
    generators,
    loads,
    totals,
    maxDV: extremeOf(buses, (r) => r.dV),
    maxDAngle: extremeOf(buses, (r) => r.dAngle),
    maxDP: extremeOf(lines, (r) => r.dP),
    unmatched,
    identical,
  };
}

// ---- the comparison as tables ------------------------------------------------

export type ComparisonTableId = 'buses' | 'lines' | 'generators' | 'loads' | 'totals';

export const COMPARISON_TABLE_IDS: readonly ComparisonTableId[] = [
  'buses',
  'lines',
  'generators',
  'loads',
  'totals',
] as const;

export type ComparisonCell = string | number | null;

export interface ComparisonColumn {
  key: string;
  label: string;
  /** What the column holds, for its heading's hover text. */
  title?: string;
  numeric: boolean;
  /** Decimals a number of the column is shown with. */
  digits: number;
  /** A difference (B minus A), which reads with its sign. */
  change: boolean;
}

export interface ComparisonRow {
  id: string;
  cells: readonly ComparisonCell[];
}

export interface ComparisonTable {
  id: ComparisonTableId;
  /** `Buses`, as a tab and a heading name it. */
  title: string;
  columns: readonly ComparisonColumn[];
  rows: readonly ComparisonRow[];
}

function column(
  key: string,
  label: string,
  kind: { numeric: boolean; digits: number; change: boolean },
  title: string | undefined,
): ComparisonColumn {
  return { key, label, ...kind, ...(title === undefined ? {} : { title }) };
}

function text(key: string, label: string, title?: string): ComparisonColumn {
  return column(key, label, { numeric: false, digits: 0, change: false }, title);
}

/** A value of A or of B. */
function num(key: string, label: string, digits: number, title?: string): ComparisonColumn {
  return column(key, label, { numeric: true, digits, change: false }, title);
}

/** A difference, B minus A. */
function change(key: string, label: string, digits: number, title: string): ComparisonColumn {
  return column(key, label, { numeric: true, digits, change: true }, title);
}

const ONLY_IN_TITLE =
  'Set when only one of the two results has the element (it was added, removed, or belongs to another case), so there is nothing to subtract.';

/** `A` or `B` for an element one result lacks, empty for one in both. */
function onlyInColumn(): ComparisonColumn {
  return text('onlyIn', 'only in', ONLY_IN_TITLE);
}

/** P and Q of both results and their change, for a generator, a load or a total. */
function powerColumns(): ComparisonColumn[] {
  return [
    num('pA', 'P A (MW)', 2),
    num('pB', 'P B (MW)', 2),
    change('dP', 'ΔP (MW)', 3, 'B minus A.'),
    num('qA', 'Q A (MVAr)', 2),
    num('qB', 'Q B (MVAr)', 2),
    change('dQ', 'ΔQ (MVAr)', 3, 'B minus A.'),
  ];
}

function powerCells(row: InjectionDelta | TotalDelta): ComparisonCell[] {
  return [row.pA, row.pB, row.dP, row.qA, row.qB, row.dQ];
}

function injectionTable(
  id: 'generators' | 'loads',
  title: string,
  rows: readonly InjectionDelta[],
  withOnlyIn: boolean,
): ComparisonTable {
  return {
    id,
    title,
    columns: [
      text('idx', 'idx'),
      text('name', 'name'),
      text('bus', 'bus'),
      ...(withOnlyIn ? [onlyInColumn()] : []),
      ...powerColumns(),
    ],
    rows: rows.map((r) => ({
      id: r.idx,
      cells: [r.idx, r.name, r.bus, ...(withOnlyIn ? [r.onlyIn ?? ''] : []), ...powerCells(r)],
    })),
  };
}

/**
 * The comparison as tables of plain cells, one per kind of element and one of
 * the system totals. The "only in" column is there only when some element is in
 * one result only, since it is empty otherwise.
 */
export function comparisonTables(comparison: PflowComparison): ComparisonTable[] {
  const withOnlyIn = comparison.unmatched > 0;
  const only = withOnlyIn ? [onlyInColumn()] : [];
  const onlyCell = (row: { onlyIn: OnlyIn }): ComparisonCell[] =>
    withOnlyIn ? [row.onlyIn ?? ''] : [];
  return [
    {
      id: 'buses',
      title: 'Buses',
      columns: [
        text('idx', 'idx'),
        text('name', 'name'),
        ...only,
        num('vA', 'V A (pu)', 4),
        num('vB', 'V B (pu)', 4),
        change('dV', 'ΔV (pu)', 5, 'B minus A.'),
        num('angleA', 'θ A (deg)', 3),
        num('angleB', 'θ B (deg)', 3),
        change('dAngle', 'Δθ (deg)', 4, 'B minus A, brought into -180 to 180 degrees.'),
      ],
      rows: comparison.buses.map((r) => ({
        id: r.idx,
        cells: [r.idx, r.name, ...onlyCell(r), r.vA, r.vB, r.dV, r.angleA, r.angleB, r.dAngle],
      })),
    },
    {
      id: 'lines',
      title: 'Lines',
      columns: [
        text('idx', 'idx'),
        text('name', 'name'),
        text('from', 'from'),
        text('to', 'to'),
        ...only,
        num('pA', 'P A (MW)', 2, 'Active power leaving the from bus into the line.'),
        num('pB', 'P B (MW)', 2, 'Active power leaving the from bus into the line.'),
        change('dP', 'ΔP (MW)', 3, 'B minus A, at the from bus.'),
        num('qA', 'Q A (MVAr)', 2, 'Reactive power leaving the from bus into the line.'),
        num('qB', 'Q B (MVAr)', 2, 'Reactive power leaving the from bus into the line.'),
        change('dQ', 'ΔQ (MVAr)', 3, 'B minus A, at the from bus.'),
        change('dPTo', 'ΔP to (MW)', 3, 'Change of the active power leaving the to bus.'),
        change('dQTo', 'ΔQ to (MVAr)', 3, 'Change of the reactive power leaving the to bus.'),
        change('dLoss', 'Δloss (MW)', 4, 'Change of what the line dissipates.'),
        num('loadingA', 'loading A (%)', 1, 'Percent of the rating; empty for a line with none.'),
        num('loadingB', 'loading B (%)', 1, 'Percent of the rating; empty for a line with none.'),
        change('dLoading', 'Δloading (pp)', 2, 'B minus A, in percentage points of the rating.'),
      ],
      rows: comparison.lines.map((r) => ({
        id: r.idx,
        cells: [
          r.idx,
          r.name,
          r.fromIdx,
          r.toIdx,
          ...onlyCell(r),
          r.pA,
          r.pB,
          r.dP,
          r.qA,
          r.qB,
          r.dQ,
          r.dPTo,
          r.dQTo,
          r.dLoss,
          r.loadingA,
          r.loadingB,
          r.dLoading,
        ],
      })),
    },
    injectionTable('generators', 'Generators', comparison.generators, withOnlyIn),
    injectionTable('loads', 'Loads', comparison.loads, withOnlyIn),
    {
      id: 'totals',
      title: 'Totals',
      columns: [text('quantity', 'quantity'), ...powerColumns()],
      rows: comparison.totals.map((r) => ({ id: r.id, cells: [r.label, ...powerCells(r)] })),
    },
  ];
}

/** A number with its sign, so a change reads as one: `+0.012`, `-3.40`, `0.000`. */
export function signed(value: number, digits: number): string {
  const fixed = value.toFixed(digits);
  // A change that rounds to zero is shown without a sign, whichever side it is on.
  if (Number(fixed) === 0) return (0).toFixed(digits);
  return value > 0 ? `+${fixed}` : fixed;
}

/** A cell of a comparison table as it reads; empty for a value there is none of. */
export function comparisonCellText(cell: ComparisonCell, column: ComparisonColumn): string {
  if (cell === null) return '';
  if (typeof cell === 'string') return cell;
  if (!Number.isFinite(cell)) return '';
  // The differences carry their sign; the values of A and B read as they are.
  return column.change ? signed(cell, column.digits) : cell.toFixed(column.digits);
}

function extremeText(label: string, unit: string, digits: number, extreme: Extreme): string {
  const where = extreme.name === extreme.idx ? extreme.idx : `${extreme.name} (${extreme.idx})`;
  return `${label} ${signed(extreme.value, digits)} ${unit} at ${where}`;
}

/**
 * The comparison in a sentence or two: the largest change of each kind and
 * where it is, or that the two results are the same.
 */
export function comparisonHeadline(comparison: PflowComparison): string {
  if (comparison.identical) return 'The two results are the same.';
  const parts: string[] = [];
  if (comparison.maxDV !== null && moved(comparison.maxDV.value)) {
    parts.push(extremeText('ΔV', 'pu', 4, comparison.maxDV));
  }
  if (comparison.maxDAngle !== null && moved(comparison.maxDAngle.value)) {
    parts.push(extremeText('Δθ', 'deg', 3, comparison.maxDAngle));
  }
  if (comparison.maxDP !== null && moved(comparison.maxDP.value)) {
    parts.push(extremeText('ΔP', 'MW', 2, comparison.maxDP));
  }
  const n = comparison.unmatched;
  const unmatched =
    n === 0 ? '' : `${n} element${n === 1 ? ' is' : 's are'} in one of the two results only.`;
  if (parts.length === 0) return unmatched || 'The two results differ.';
  return `Largest change: ${parts.join('; ')}.${unmatched ? ` ${unmatched}` : ''}`;
}
