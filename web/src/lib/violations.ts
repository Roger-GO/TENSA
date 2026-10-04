/**
 * The limits a solved power flow breaks or runs against, gathered in one list:
 * a bus voltage outside (or near) the bus's own `vmin` / `vmax`, a line or
 * transformer loaded past (or near) its rating, a generator whose reactive
 * output is past (or on) its `qmin` / `qmax`. Pure (no React, no stores), so
 * the Violations table, its count in the drawer and the run toast all read one
 * judgement; each kind is judged by its own module (`voltage.ts`, `loading.ts`,
 * `qLimit.ts`), the same rules the diagram and the other tables use.
 *
 * Base case only: the list says where the solved operating point stands, not
 * what an outage would do.
 */
import type { PflowResult, TopologyEntry, TopologySummary } from '@/api/types';
import { assessLoading, loadingStatusText, LOADING_LIMIT_PCT } from '@/components/sld/loading';
import { assessQLimit, qLimitText } from '@/components/sld/qLimit';
import { assessVoltage, busVoltageLimits, voltageStatusText } from '@/components/sld/voltage';
import type { StaticElementKind } from '@/store/case';
import { DYNAMIC_GENERATOR_KINDS, generatorRowKey } from '@/lib/topology';

export type ViolationKind = 'bus-voltage' | 'line-loading' | 'generator-q';

/** A limit broken, or one run right up to (a bus within its margin, a line near its rating, a generator on its limit). */
export type ViolationSeverity = 'violation' | 'warning';

/** The unit a finding's value and limit are in. Bus voltage is per unit; the table converts. */
export type ViolationUnit = 'pu' | '%' | 'MVAr';

export interface Violation {
  /** Unique within a report; the id of the finding's table row. */
  id: string;
  kind: ViolationKind;
  severity: ViolationSeverity;
  /** The element, as a selection of it. */
  target: { kind: StaticElementKind; idx: string };
  /** The id the diagram and the tables use to highlight the element. */
  nodeId: string;
  idx: string;
  name: string;
  /** In words: `Below vmin`, `Over rating`, `Above Qmax`. */
  finding: string;
  value: number;
  /** The limit the value is past or near. */
  limit: number;
  unit: ViolationUnit;
  /** How far the value is past its limit, in `unit` (negative: short of it). Orders findings of one kind. */
  excess: number;
}

export interface ViolationReport {
  /** Violations first, then warnings; each kind together, the worst first. */
  items: readonly Violation[];
  violationCount: number;
  warningCount: number;
  /** How many of each element the check covered. */
  checked: { buses: number; lines: number; generators: number };
  /** Lines the case gives no rating: they are not checked for overload. */
  unratedLines: number;
}

const KIND_ORDER: Record<ViolationKind, number> = {
  'bus-voltage': 0,
  'line-loading': 1,
  'generator-q': 2,
};

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The id of the diagram node that prints a generator's row of the PF result.
 * A dynamic machine prints the row of the static generator it names, so it,
 * not that generator, is the node to light; a generator no machine names
 * prints its own (the rule `buildGraph` draws the readouts by).
 */
export function generatorNodeId(
  generators: readonly TopologyEntry[],
  rowKey: string,
): `generator-${string}` {
  const machine = generators.find(
    (entry) => DYNAMIC_GENERATOR_KINDS.has(entry.kind) && generatorRowKey(entry) === rowKey,
  );
  return `generator-${machine === undefined ? rowKey : String(machine.idx)}`;
}

function compare(a: Violation, b: Violation): number {
  if (a.severity !== b.severity) return a.severity === 'violation' ? -1 : 1;
  if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  return b.excess - a.excess;
}

/**
 * Check a converged power flow against the limits the case sets. `null` when
 * there is nothing to check: no result, or one that did not converge.
 */
export function collectViolations(
  pflow: PflowResult | null,
  topology: TopologySummary | null,
): ViolationReport | null {
  if (pflow === null || !pflow.converged || topology === null) return null;
  const items: Violation[] = [];
  const checked = { buses: 0, lines: 0, generators: 0 };
  let unratedLines = 0;

  for (const bus of topology.buses) {
    const idx = String(bus.idx);
    const v = pflow.bus_voltages[idx];
    if (!finiteNumber(v)) continue;
    checked.buses += 1;
    const limits = busVoltageLimits(bus);
    const status = assessVoltage(v, limits);
    if (status.band !== 'danger' && status.band !== 'warning') continue;
    const limit = status.side === 'low' ? limits.vmin : limits.vmax;
    const finding = voltageStatusText(status);
    if (finding === null) continue;
    items.push({
      id: `bus-${idx}`,
      kind: 'bus-voltage',
      severity: status.band === 'danger' ? 'violation' : 'warning',
      target: { kind: 'bus', idx },
      nodeId: idx,
      idx,
      name: bus.name,
      finding,
      value: v,
      limit,
      unit: 'pu',
      excess: status.side === 'low' ? limit - v : v - limit,
    });
  }

  const branches: ReadonlyArray<readonly [TopologyEntry, 'line' | 'transformer']> = [
    ...topology.lines.map((entry) => [entry, 'line'] as const),
    ...topology.transformers.map((entry) => [entry, 'transformer'] as const),
  ];
  for (const [entry, kind] of branches) {
    const idx = String(entry.idx);
    const flow = pflow.line_flows?.[idx];
    if (flow === undefined) continue;
    const loading = flow.loading_pct;
    if (!finiteNumber(loading)) {
      unratedLines += 1;
      continue;
    }
    checked.lines += 1;
    const band = assessLoading(loading);
    const finding = loadingStatusText(band);
    if (finding === null) continue;
    items.push({
      id: `${kind}-${idx}`,
      kind: 'line-loading',
      severity: band === 'danger' ? 'violation' : 'warning',
      target: { kind, idx },
      nodeId: `${kind}-${idx}`,
      idx,
      name: entry.name,
      finding,
      value: loading,
      limit: LOADING_LIMIT_PCT,
      unit: '%',
      excess: loading - LOADING_LIMIT_PCT,
    });
  }

  const statics = new Map<string, TopologyEntry>();
  for (const entry of topology.generators) {
    if (!DYNAMIC_GENERATOR_KINDS.has(entry.kind)) statics.set(String(entry.idx), entry);
  }
  for (const [key, out] of Object.entries(pflow.generator_outputs ?? {})) {
    const state = assessQLimit(out.q, out.q_min, out.q_max);
    if (state === 'none') continue;
    checked.generators += 1;
    const finding = qLimitText(state);
    if (finding === null || state === 'within') continue;
    const atMax = state === 'above-max' || state === 'at-max';
    const limit = atMax ? out.q_max : out.q_min;
    if (!finiteNumber(limit)) continue;
    items.push({
      id: `generator-${key}`,
      kind: 'generator-q',
      severity: state === 'above-max' || state === 'below-min' ? 'violation' : 'warning',
      target: { kind: 'generator', idx: key },
      nodeId: generatorNodeId(topology.generators, key),
      idx: key,
      name: statics.get(key)?.name ?? key,
      finding,
      value: out.q,
      limit,
      unit: 'MVAr',
      excess: atMax ? out.q - limit : limit - out.q,
    });
  }

  items.sort(compare);
  const violationCount = items.filter((item) => item.severity === 'violation').length;
  return {
    items,
    violationCount,
    warningCount: items.length - violationCount,
    checked,
    unratedLines,
  };
}

/** The headline of a report in words: `2 violations and 1 warning`, or that nothing is past a limit. */
export function summarizeViolations(report: ViolationReport): string {
  const { violationCount, warningCount } = report;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (violationCount === 0 && warningCount === 0) return 'No limit is violated';
  if (violationCount === 0) return plural(warningCount, 'warning');
  if (warningCount === 0) return plural(violationCount, 'violation');
  return `${plural(violationCount, 'violation')} and ${plural(warningCount, 'warning')}`;
}
