/**
 * ShuntsGrid (v3 Unit 13).
 *
 * Bottom-drawer "Shunts" tab. rowId is ``shunt-${idx}`` matching the
 * React Flow node id shape ``buildGraph`` emits for non-bus device
 * nodes. The plan calls for ``Shunt-${idx}`` "mirror existing
 * convention" — the actual SLD shape is lowercase per the legacy
 * v2 results table's ``onRowClick`` mapping (file retired in v3
 * Unit 15). We use lowercase so canvas highlight + inspector stay
 * in sync.
 *
 * Columns: idx, bus, B (susceptance), G (conductance). Mirrors the
 * retired v2 SHUNT_COLUMNS shape (idx, name, bus, g, b, Vn) trimmed
 * to the v3 spec's columns + bus.
 */
import { useMemo } from 'react';
import { DataGrid, type ColumnConfig } from './DataGrid';
import { useCurrentTopology } from '@/api/queries';
import { useSldStore } from '@/store/sld';
import { useCaseStore } from '@/store/case';
import type { TopologyEntry } from '@/api/types';

interface ShuntRow {
  rowId: string;
  idx: string;
  bus: string | null;
  b: number | null;
  g: number | null;
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

const COLUMNS: ColumnConfig<ShuntRow>[] = [
  { key: 'idx', label: 'idx', accessor: (r) => r.idx },
  { key: 'bus', label: 'bus', accessor: (r) => r.bus },
  { key: 'b', label: 'B (pu)', numeric: true, accessor: (r) => r.b },
  { key: 'g', label: 'G (pu)', numeric: true, accessor: (r) => r.g },
];

export interface ShuntsGridProps {
  className?: string;
}

export function ShuntsGrid({ className }: ShuntsGridProps) {
  const topology = useCurrentTopology();
  const setSelectedNodeId = useSldStore((s) => s.setSelectedNodeId);
  const selectedNodeId = useSldStore((s) => s.selectedNodeId);
  const setSelectedElement = useCaseStore((s) => s.setSelectedElement);

  const rows = useMemo<ShuntRow[]>(() => {
    if (!topology) return [];
    const shunts = topology.shunts ?? [];
    return shunts.map((sh) => {
      const idx = String(sh.idx);
      return {
        rowId: `shunt-${idx}`,
        idx,
        bus: paramString(sh, 'bus'),
        b: paramNumber(sh, 'b'),
        g: paramNumber(sh, 'g'),
      };
    });
  }, [topology]);

  const onRowClick = (id: string) => {
    setSelectedNodeId(id);
    const idx = id.replace(/^shunt-/, '');
    setSelectedElement({ kind: 'shunt', idx });
  };

  return (
    <DataGrid
      columns={COLUMNS}
      rows={rows}
      rowIdAccessor={(r) => r.rowId}
      onRowClick={onRowClick}
      selectedRowId={selectedNodeId}
      emptyState={topology ? 'No shunts in this case.' : 'Load a case to see shunts.'}
      testId="shunts-grid"
      className={className}
    />
  );
}
