/**
 * LinesGrid (v3 Unit 13).
 *
 * Bottom-drawer "Lines" tab. Per F-DESIGN-6 resolution: line rowId is
 * ``line-${idx}`` (extending ``selectedNodeId`` to accept this shape).
 * Click writes both selectedNodeId + selectedElement; the canvas pan
 * effect no-ops for lines (no React Flow node for an edge), but the
 * right inspector still populates because case.selectedElement drives
 * its form data per the F-DESIGN-7 dual-write pattern.
 *
 * Columns mirror the retired v2 LINE_COLUMNS shape (file retired in
 * v3 Unit 15) plus per-end power + loss split per the v3 plan unit-13
 * spec. The server reports the power at both ends of each line, so P_to and
 * Q_to are read, and the loss is the sum of the two P (the active power the
 * line dissipates). The rating (`rate_a`, MVA) and the loading against it
 * (the larger end's apparent power, in percent) follow, with the verdict in
 * words beside them: a line the case gives no rating has none of the three,
 * and reads `—`. The rating is the case's own `rate_a`, so it shows before a
 * power flow and right after an edit too; the loading needs a solved case.
 *
 * The line's own parameters (resistance, reactance and charging susceptance in
 * per unit, whether it is in service, and the rating) stand before the results
 * and can be changed in the table, before the case has been run; a line given a
 * rating there is judged against it by the next power flow.
 */
import { useMemo } from 'react';
import { DataGrid, type ColumnConfig } from './DataGrid';
import { formatParamValue } from './gridCells';
import { useGridEditing, type GridEditTarget } from './useGridEditing';
import { useCurrentTopology } from '@/api/queries';
import { usePflowStore } from '@/store/pflow';
import { __requestRouteEdit, useSldStore } from '@/store/sld';
import { useCaseStore } from '@/store/case';
import { loadingCheckText } from '@/components/sld/loading';
import type { TopologyEntry } from '@/api/types';
import { paramNumber, paramString } from './entryParams';
import { finiteOrNull, isFiniteNumber } from '@/lib/finite';

interface LineRow {
  rowId: string;
  idx: string;
  from_bus: string | null;
  to_bus: string | null;
  r: number | null;
  x: number | null;
  b: number | null;
  u: number | null;
  p_from: number | null;
  q_from: number | null;
  p_to: number | null;
  q_to: number | null;
  loss: number | null;
  rate_a: number | null;
  loading: number | null;
  loading_check: string | null;
}

/** The rating the case sets for a line (`rate_a`, MVA); `null` for a rating of 0, which means none. */
function ratingParam(entry: TopologyEntry): number | null {
  const v = entry.params?.rate_a;
  return isFiniteNumber(v) && v > 0 ? v : null;
}

const PU_TITLE = "Per unit on the line's own voltage and MVA base, as the case gives it";

const COLUMNS: ColumnConfig<LineRow>[] = [
  { key: 'idx', label: 'idx', minWidth: 72, accessor: (r) => r.idx },
  { key: 'from_bus', label: 'from', minWidth: 60, accessor: (r) => r.from_bus },
  { key: 'to_bus', label: 'to', minWidth: 60, accessor: (r) => r.to_bus },
  {
    key: 'r',
    label: 'r (pu)',
    title: `Series resistance. ${PU_TITLE}`,
    minWidth: 80,
    numeric: true,
    format: formatParamValue,
    accessor: (r) => r.r,
    edit: { param: 'r' },
  },
  {
    key: 'x',
    label: 'x (pu)',
    title: `Series reactance. ${PU_TITLE}`,
    minWidth: 80,
    numeric: true,
    format: formatParamValue,
    accessor: (r) => r.x,
    edit: { param: 'x' },
  },
  {
    key: 'b',
    label: 'b (pu)',
    title: `Total line charging susceptance. ${PU_TITLE}`,
    minWidth: 80,
    numeric: true,
    format: formatParamValue,
    accessor: (r) => r.b,
    edit: { param: 'b' },
  },
  {
    key: 'u',
    label: 'u',
    title: 'In service: 1. Out of service: 0, and the line carries nothing in the next power flow.',
    minWidth: 56,
    numeric: true,
    format: formatParamValue,
    accessor: (r) => r.u,
    edit: { param: 'u' },
  },
  { key: 'p_from', label: 'P_from (MW)', minWidth: 108, numeric: true, accessor: (r) => r.p_from },
  {
    key: 'q_from',
    label: 'Q_from (MVAr)',
    minWidth: 116,
    numeric: true,
    accessor: (r) => r.q_from,
  },
  { key: 'p_to', label: 'P_to (MW)', minWidth: 100, numeric: true, accessor: (r) => r.p_to },
  { key: 'q_to', label: 'Q_to (MVAr)', minWidth: 108, numeric: true, accessor: (r) => r.q_to },
  {
    key: 'loss',
    label: 'loss (MW)',
    title: 'Active power the line dissipates: P_from + P_to',
    minWidth: 96,
    numeric: true,
    accessor: (r) => r.loss,
  },
  {
    key: 'rate_a',
    label: 'rating (MVA)',
    title:
      'The line rating the case sets (rate_a). A line with none reads a dash and is not checked for overload. Type a rating to set one, or 0 to remove it.',
    minWidth: 108,
    numeric: true,
    format: formatParamValue,
    accessor: (r) => r.rate_a,
    edit: { param: 'rate_a' },
  },
  {
    key: 'loading',
    label: 'loading (%)',
    title: 'The larger of the apparent powers at the two ends, in percent of the rating',
    minWidth: 100,
    numeric: true,
    accessor: (r) => r.loading,
  },
  {
    key: 'loading_check',
    label: 'Loading check',
    title: 'Over the rating, or near it (from 80%). Filled in once a power flow has run.',
    minWidth: 116,
    accessor: (r) => r.loading_check,
  },
];

const EDIT_TARGET: GridEditTarget<LineRow> = { model: () => 'Line', idx: (r) => r.idx };

export interface LinesGridProps {
  className?: string;
}

export function LinesGrid({ className }: LinesGridProps) {
  const topology = useCurrentTopology();
  const pflow = usePflowStore((s) => s.lastRun);
  const setSelectedNodeId = useSldStore((s) => s.setSelectedNodeId);
  const selectedNodeId = useSldStore((s) => s.selectedNodeId);
  const setSelectedElement = useCaseStore((s) => s.setSelectedElement);
  const editing = useGridEditing(EDIT_TARGET);

  const rows = useMemo<LineRow[]>(() => {
    if (!topology) return [];
    return topology.lines.map((line) => {
      const idx = String(line.idx);
      const flow = pflow?.converged ? pflow.line_flows?.[idx] : undefined;
      const loading = finiteOrNull(flow?.loading_pct);
      return {
        rowId: `line-${idx}`,
        idx,
        from_bus: paramString(line, 'bus1'),
        to_bus: paramString(line, 'bus2'),
        r: paramNumber(line, 'r'),
        x: paramNumber(line, 'x'),
        b: paramNumber(line, 'b'),
        u: paramNumber(line, 'u'),
        p_from: finiteOrNull(flow?.p),
        q_from: finiteOrNull(flow?.q),
        p_to: finiteOrNull(flow?.p_to),
        q_to: finiteOrNull(flow?.q_to),
        loss: finiteOrNull(flow?.loss),
        rate_a: finiteOrNull(flow?.rate_a) ?? ratingParam(line),
        loading,
        loading_check: loadingCheckText(loading),
      };
    });
  }, [topology, pflow]);

  const onRowClick = (id: string) => {
    // Per F-DESIGN-6: writing this id is fine — the canvas pan effect
    // accepts the shape and just no-ops because there's no matching
    // React Flow node for an edge. The inspector populates via
    // case.selectedElement.
    setSelectedNodeId(id);
    const idx = id.replace(/^line-/, '');
    setSelectedElement({ kind: 'line', idx });
    // The diagram picks the line as a click on it does: it comes into view
    // with the handles its route is moved by.
    __requestRouteEdit(idx);
  };

  return (
    <DataGrid
      columns={COLUMNS}
      rows={rows}
      rowIdAccessor={(r) => r.rowId}
      onRowClick={onRowClick}
      selectedRowId={selectedNodeId}
      emptyState={topology ? 'No lines in this case.' : 'Load a case to see lines.'}
      testId="lines-grid"
      ariaLabel="Lines"
      exportPanel="lines"
      filterable
      copyable
      editing={editing}
      className={className}
    />
  );
}
