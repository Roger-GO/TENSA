/**
 * ViolationsGrid.
 *
 * Bottom-drawer "Violations" tab: every limit the last converged power flow
 * breaks, or runs right up to, in one table. A bus voltage outside (or within
 * its margin of) the bus's own `vmin` / `vmax`, a line or transformer loaded
 * past (or near) its `rate_a`, a generator whose reactive output is past (or
 * on) its `qmin` / `qmax`. Base case only: it says where the solved operating
 * point stands, not what an outage would do.
 *
 * The findings come from `collectViolations`, the same judgement the diagram,
 * the Buses, Lines and Generators tables and the Inspector use. A row click
 * selects the element the way a click on its own table does (the diagram pans
 * to a bus or generator, the Inspector opens it). Voltages read in kV under
 * the actual-units display where the bus's rated voltage is known; loading is
 * in percent of the rating and reactive power in MVAr. Violations come before
 * warnings, and the table exports as CSV.
 */
import { useMemo } from 'react';
import { DataGrid, type ColumnConfig } from './DataGrid';
import { useCurrentTopology } from '@/api/queries';
import { useRunFollowedPflow, useViolationReport } from '@/lib/useViolationReport';
import {
  summarizeViolations,
  type Violation,
  type ViolationKind,
  type ViolationReport,
} from '@/lib/violations';
import { busBaseKv, unitBasesOf, voltageDisplay } from '@/lib/units';
import { useCaseStore } from '@/store/case';
import { useSldStore } from '@/store/sld';
import { useUnitsStore } from '@/store/units';

interface ViolationRow {
  rowId: string;
  severity: string;
  type: string;
  name: string;
  idx: string;
  finding: string;
  value: number;
  limit: number;
  unit: string;
}

const TYPE_LABEL: Record<ViolationKind, string> = {
  'bus-voltage': 'Bus voltage',
  'line-loading': 'Line loading',
  'generator-q': 'Generator Q',
};

const COLUMNS: ColumnConfig<ViolationRow>[] = [
  {
    key: 'severity',
    label: 'severity',
    title:
      'A violation is past its limit. A warning is near it: a bus within its margin of vmin or vmax, a line from 80% of its rating, a generator on its Q limit.',
    width: 88,
    accessor: (r) => r.severity,
  },
  { key: 'type', label: 'type', width: 108, accessor: (r) => r.type },
  { key: 'name', label: 'name', accessor: (r) => r.name },
  { key: 'idx', label: 'idx', accessor: (r) => r.idx },
  { key: 'finding', label: 'finding', accessor: (r) => r.finding },
  { key: 'value', label: 'value', numeric: true, accessor: (r) => r.value },
  {
    key: 'limit',
    label: 'limit',
    title: 'The limit the value is past or near: vmin or vmax, the rating, qmin or qmax.',
    numeric: true,
    accessor: (r) => r.limit,
  },
  { key: 'unit', label: 'unit', width: 64, accessor: (r) => r.unit },
];

export interface ViolationsGridProps {
  className?: string;
}

export function ViolationsGrid({ className }: ViolationsGridProps) {
  const topology = useCurrentTopology();
  const report = useViolationReport();
  const afterRun = useRunFollowedPflow();
  const setSelectedNodeId = useSldStore((s) => s.setSelectedNodeId);
  const selectedNodeId = useSldStore((s) => s.selectedNodeId);
  const setSelectedElement = useCaseStore((s) => s.setSelectedElement);
  const unitMode = useUnitsStore((s) => s.mode);
  const bases = useMemo(() => unitBasesOf(topology), [topology]);

  const rows = useMemo<ViolationRow[]>(() => {
    if (report === null) return [];
    return report.items.map((item) => {
      // A voltage is judged in pu; only what is shown changes unit.
      const display =
        item.kind === 'bus-voltage' ? voltageDisplay(unitMode, busBaseKv(bases, item.idx)) : null;
      const factor = display?.factor ?? 1;
      return {
        rowId: item.id,
        severity: item.severity === 'violation' ? 'Violation' : 'Warning',
        type: TYPE_LABEL[item.kind],
        name: item.name,
        idx: item.idx,
        finding: item.finding,
        value: item.value * factor,
        limit: item.limit * factor,
        unit: display?.unit ?? item.unit,
      };
    });
  }, [report, unitMode, bases]);

  const byRowId = useMemo(() => {
    const map = new Map<string, Violation>();
    for (const item of report?.items ?? []) map.set(item.id, item);
    return map;
  }, [report]);

  const onRowClick = (id: string) => {
    const item = byRowId.get(id);
    if (item === undefined) return;
    setSelectedNodeId(item.nodeId);
    setSelectedElement(item.target);
  };

  const selectedRowId =
    selectedNodeId === null
      ? null
      : (report?.items.find((item) => item.nodeId === selectedNodeId)?.id ?? null);

  // After a time-domain run the report is still the power flow's, and says so.
  const summary = report === null ? null : summaryLine(report, afterRun);
  const emptyState =
    topology === null
      ? 'Load a case to check its limits.'
      : summary === null
        ? afterRun
          ? NO_PFLOW_AFTER_RUN
          : 'Run a power flow to check the bus voltages, line loading and generator reactive limits.'
        : summary;

  return (
    <DataGrid
      columns={COLUMNS}
      rows={rows}
      rowIdAccessor={(r) => r.rowId}
      onRowClick={onRowClick}
      selectedRowId={selectedRowId}
      emptyState={emptyState}
      testId="violations-grid"
      ariaLabel="Violations"
      exportPanel="violations"
      hint={summary === null || rows.length === 0 ? undefined : summary}
      className={className}
    />
  );
}

/** What was checked, for the line above the table and the empty state. */
function checkedText(report: ViolationReport): string {
  const { buses, lines, generators } = report.checked;
  const parts = [`${buses} bus${buses === 1 ? '' : 'es'}`];
  parts.push(`${lines} rated line${lines === 1 ? '' : 's'}`);
  parts.push(`${generators} generator${generators === 1 ? '' : 's'}`);
  const checked = `Checked ${parts.join(', ')}.`;
  if (report.unratedLines === 0) return checked;
  const n = report.unratedLines;
  // Say how to bring a line into the check, since a first-time user sees no
  // overload and cannot tell it is because nothing is rated.
  return `${checked} ${n} line${n === 1 ? ' has' : 's have'} no rating (rate_a) and ${n === 1 ? 'is' : 'are'} not checked for overload. Set a line's rate_a in the Inspector to check it.`;
}

/** What the report is of once a time-domain run has gone on from its power flow. */
const AFTER_RUN_NOTE =
  'This is the power flow the time-domain run started from. The run itself is not checked against the limits.';

/** What to do when a time-domain run was made with no power flow to report on. */
const NO_PFLOW_AFTER_RUN =
  'A time-domain run is not checked against the limits. Reset the run and run a power flow to check the bus voltages, line loading and generator reactive limits.';

/** The headline and what was checked, as one sentence pair. */
function summaryLine(report: ViolationReport, afterRun: boolean): string {
  const line = `${summarizeViolations(report)}. ${checkedText(report)}`;
  return afterRun ? `${line} ${AFTER_RUN_NOTE}` : line;
}
