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
 * v3 Unit 15) verbatim plus a status column. PQ vs ZIP load distinction
 * lives in the kind field but is omitted from the headline columns to
 * keep the grid scannable.
 */
import { useMemo } from 'react';
import { DataGrid, type ColumnConfig } from './DataGrid';
import { useCurrentTopology } from '@/api/queries';
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

function paramNumber(entry: TopologyEntry, key: string): number | null {
  const v = entry.params?.[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const COLUMNS: ColumnConfig<LoadRow>[] = [
  { key: 'idx', label: 'idx', accessor: (r) => r.idx },
  { key: 'name', label: 'name', accessor: (r) => r.name },
  { key: 'bus', label: 'bus', accessor: (r) => r.bus },
  { key: 'p', label: 'P (MW)', numeric: true, accessor: (r) => r.p },
  { key: 'q', label: 'Q (MVAr)', numeric: true, accessor: (r) => r.q },
  { key: 'status', label: 'status', accessor: (r) => r.status },
];

export interface LoadsGridProps {
  className?: string;
}

export function LoadsGrid({ className }: LoadsGridProps) {
  const topology = useCurrentTopology();
  const setSelectedNodeId = useSldStore((s) => s.setSelectedNodeId);
  const selectedNodeId = useSldStore((s) => s.selectedNodeId);
  const setSelectedElement = useCaseStore((s) => s.setSelectedElement);

  const rows = useMemo<LoadRow[]>(() => {
    if (!topology) return [];
    return topology.loads.map((load) => {
      const idx = String(load.idx);
      return {
        rowId: `load-${idx}`,
        idx,
        name: load.name,
        bus: paramString(load, 'bus'),
        p: paramNumber(load, 'p0'),
        q: paramNumber(load, 'q0'),
        status: paramString(load, 'u') === '0' ? 'off' : 'online',
      };
    });
  }, [topology]);

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
      className={className}
    />
  );
}
