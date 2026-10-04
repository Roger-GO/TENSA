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
import { useViolationReport } from '@/lib/useViolationReport';
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

  const emptyState =
    topology === null
      ? 'Load a case to check its limits.'
      : report === null
        ? 'Run a power flow to check the bus voltages, line loading and generator reactive limits.'
        : summaryLine(report);

  return (
    <DataGrid
      columns={COLUMNS}
      rows={rows}
      rowIdAccessor={(r) => r.rowId}
      onRowClick={onRowClick}
      selectedRowId={selectedRowId}
      emptyState={emptyState}
      testId="violations-grid"
      exportPanel="violations"
      hint={report === null || rows.length === 0 ? undefined : summaryLine(report)}
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
  return report.unratedLines === 0
    ? checked
    : `${checked} ${report.unratedLines} line${report.unratedLines === 1 ? ' has' : 's have'} no rating (rate_a) and ${report.unratedLines === 1 ? 'is' : 'are'} not checked for overload.`;
}

/** The headline and what was checked, as one sentence pair. */
function summaryLine(report: ViolationReport): string {
  return `${summarizeViolations(report)}. ${checkedText(report)}`;
}
