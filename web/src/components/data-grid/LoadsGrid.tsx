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
 * ``—`` until power flow has run. The case's own ``p0`` / ``q0`` are not
 * shown: they are per-unit setpoints on the system base, so labelling them
 * MW read 9.670 where the diagram showed 967.0 MW (Kundur).
 */
import { useMemo } from 'react';
import { DataGrid, type ColumnConfig } from './DataGrid';
import { useCurrentTopology } from '@/api/queries';
import { usePflowStore } from '@/store/pflow';
import { useSldStore } from '@/store/sld';
import { useCaseStore } from '@/store/case';
import type { TopologyEntry } from '@/api/types';

interface LoadRow {
  rowId: string;
  idx: string;
  name: string;
  bus: string | null;
  p: number | null;
  q: number | null;
  status: string;
}

function paramString(entry: TopologyEntry, key: string): string | null {
  const v = entry.params?.[key];
  if (v === undefined || v === null) return null;
  return String(v);
}

function finiteOrNull(v: number | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

const CONSUMPTION_TITLE =
  'What the load draws in the last power flow run. Shows a dash until power flow has run.';

const COLUMNS: ColumnConfig<LoadRow>[] = [
  { key: 'idx', label: 'idx', accessor: (r) => r.idx },
  { key: 'name', label: 'name', accessor: (r) => r.name },
  { key: 'bus', label: 'bus', accessor: (r) => r.bus },
  {
    key: 'p',
    label: 'P (MW)',
    title: CONSUMPTION_TITLE,
    numeric: true,
    accessor: (r) => r.p,
  },
  {
    key: 'q',
    label: 'Q (MVAr)',
    title: CONSUMPTION_TITLE,
    numeric: true,
    accessor: (r) => r.q,
  },
  { key: 'status', label: 'status', accessor: (r) => r.status },
];

export interface LoadsGridProps {
  className?: string;
}

export function LoadsGrid({ className }: LoadsGridProps) {
  const topology = useCurrentTopology();
  const pflow = usePflowStore((s) => s.lastRun);
  const setSelectedNodeId = useSldStore((s) => s.setSelectedNodeId);
  const selectedNodeId = useSldStore((s) => s.selectedNodeId);
  const setSelectedElement = useCaseStore((s) => s.setSelectedElement);

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
        bus: paramString(load, 'bus'),
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
      className={className}
    />
  );
}
