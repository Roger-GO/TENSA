/**
 * LoadsGrid (v3 Unit 13).
 *
 * Bottom-drawer "Loads" tab. rowId is ``Load-${idx}`` matching the
 * React Flow node id shape ``buildGraph`` emits — non-bus device
 * nodes use the ``${kind}-${idx}`` convention but the kind here is
 * always the generic "load" SLD node type. The plan calls for
 * ``Load-${idx}`` to "mirror existing convention" — but the actual
 * SLD node id is ``load-${idx}`` (lowercase, mirrored from the
 * ``rawKind`` in ``SldCanvas.onNodeClick``). We use ``load-${idx}``
 * so canvas highlight + inspector both stay in sync.
 *
 * Columns mirror the retired v2 LOAD_COLUMNS shape (file retired in
 * v3 Unit 15) plus a status column. PQ vs ZIP load distinction
 * lives in the kind field but is omitted from the headline columns to
 * keep the grid scannable.
 *
 * P / Q are what the load draws (MW / MVAr) from the last converged power
 * flow, the same figures the diagram and the inspector print, and read
 * ``—`` until power flow has run. The case's own ``p0`` / ``q0`` stand beside
 * them as what they are, per-unit set-points on the system base: labelled MW
 * they read 9.670 where the diagram showed 967.0 MW (Kundur). They can be
 * changed in the table, before the case has been run.
 *
 * The headings say which is which ("set-point", "solved"). With the display
 * units on Actual the only active power that can be typed is still ``p0`` in
 * per unit, beside a "P (MW)" that reads a dash before a run, and a user who
 * meant to set the active power had to guess which of the two to edit.
 */
import { useMemo } from 'react';
import { DataGrid, type ColumnConfig } from './DataGrid';
import { formatParamValue } from './gridCells';
import { useGridEditing, type GridEditTarget } from './useGridEditing';
import { useCurrentTopology } from '@/api/queries';
import { loadBusIdx } from '@/lib/topology';
import { usePflowStore } from '@/store/pflow';
import { useSldStore } from '@/store/sld';
import { useCaseStore } from '@/store/case';
import { paramNumber, paramString } from './entryParams';
import { finiteOrNull } from '@/lib/finite';

interface LoadRow {
  rowId: string;
  idx: string;
  name: string;
  /** The ANDES model of the load (`PQ` or `ZIP`). */
  kind: string;
  bus: string | null;
  p0: number | null;
  q0: number | null;
  p: number | null;
  q: number | null;
  status: string;
}

const CONSUMPTION_TITLE =
  'What the load draws in the last power flow run. Shows a dash until power flow has run.';

const SET_POINT_TITLE =
  'Set-point the case gives, in per unit on the system base: multiply by the system MVA base for MW or MVAr. Type a value to change it before a run; power flow solves what the load draws beside it.';

const COLUMNS: ColumnConfig<LoadRow>[] = [
  { key: 'idx', label: 'idx', minWidth: 72, accessor: (r) => r.idx },
  { key: 'name', label: 'name', minWidth: 96, accessor: (r) => r.name },
  { key: 'bus', label: 'bus', minWidth: 56, accessor: (r) => r.bus },
  {
    key: 'p0',
    label: 'p0 set-point (pu)',
    title: `Active power set-point. ${SET_POINT_TITLE}`,
    minWidth: 148,
    numeric: true,
    format: formatParamValue,
    accessor: (r) => r.p0,
    edit: { param: 'p0' },
  },
  {
    key: 'q0',
    label: 'q0 set-point (pu)',
    title: `Reactive power set-point. ${SET_POINT_TITLE}`,
    minWidth: 148,
    numeric: true,
    format: formatParamValue,
    accessor: (r) => r.q0,
    edit: { param: 'q0' },
  },
  {
    key: 'p',
    label: 'P solved (MW)',
    title: CONSUMPTION_TITLE,
    minWidth: 124,
    numeric: true,
    accessor: (r) => r.p,
  },
  {
    key: 'q',
    label: 'Q solved (MVAr)',
    title: CONSUMPTION_TITLE,
    minWidth: 136,
    numeric: true,
    accessor: (r) => r.q,
  },
  { key: 'status', label: 'status', minWidth: 72, accessor: (r) => r.status },
];

const EDIT_TARGET: GridEditTarget<LoadRow> = { model: (r) => r.kind, idx: (r) => r.idx };

export interface LoadsGridProps {
  className?: string;
}

export function LoadsGrid({ className }: LoadsGridProps) {
  const topology = useCurrentTopology();
  const pflow = usePflowStore((s) => s.lastRun);
  const setSelectedNodeId = useSldStore((s) => s.setSelectedNodeId);
  const selectedNodeId = useSldStore((s) => s.selectedNodeId);
  const setSelectedElement = useCaseStore((s) => s.setSelectedElement);
  const editing = useGridEditing(EDIT_TARGET);

  const rows = useMemo<LoadRow[]>(() => {
    if (!topology) return [];
    const consumption = pflow?.converged ? pflow.load_consumption : undefined;
    return topology.loads.map((load) => {
      const idx = String(load.idx);
      const row = consumption?.[idx];
      return {
        rowId: `load-${idx}`,
        idx,
        name: load.name,
        kind: load.kind,
        bus: loadBusIdx(load, topology.loads),
        p0: paramNumber(load, 'p0'),
        q0: paramNumber(load, 'q0'),
        p: finiteOrNull(row?.p),
        q: finiteOrNull(row?.q),
        status: paramString(load, 'u') === '0' ? 'off' : 'online',
      };
    });
  }, [topology, pflow]);

  const onRowClick = (id: string) => {
    setSelectedNodeId(id);
    const idx = id.replace(/^load-/, '');
    setSelectedElement({ kind: 'load', idx });
  };

  return (
    <DataGrid
      columns={COLUMNS}
      rows={rows}
      rowIdAccessor={(r) => r.rowId}
      onRowClick={onRowClick}
      selectedRowId={selectedNodeId}
      emptyState={topology ? 'No loads in this case.' : 'Load a case to see loads.'}
      testId="loads-grid"
      ariaLabel="Loads"
      exportPanel="loads"
      filterable
      copyable
      editing={editing}
      className={className}
    />
  );
}
