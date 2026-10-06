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
 * to the v3 spec's columns + bus. B and G are the case's own values and can be
 * changed in the table, before the case has been run.
 */
import { useMemo } from 'react';
import { DataGrid, type ColumnConfig } from './DataGrid';
import { formatParamValue } from './gridCells';
import { useGridEditing, type GridEditTarget } from './useGridEditing';
import { useCurrentTopology } from '@/api/queries';
import { useSldStore } from '@/store/sld';
import { useCaseStore } from '@/store/case';
import type { TopologyEntry } from '@/api/types';
import { paramString } from './entryParams';
import { isFiniteNumber } from '@/lib/finite';

interface ShuntRow {
  rowId: string;
  idx: string;
  bus: string | null;
  b: number | null;
  g: number | null;
}

/** A shunt's `b` or `g`, which unlike the other tables' numbers may come as text. */
function numberOrNumeral(entry: TopologyEntry, key: string): number | null {
  const v = entry.params?.[key];
  if (isFiniteNumber(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const COLUMNS: ColumnConfig<ShuntRow>[] = [
  { key: 'idx', label: 'idx', minWidth: 72, accessor: (r) => r.idx },
  { key: 'bus', label: 'bus', minWidth: 56, accessor: (r) => r.bus },
  {
    key: 'b',
    label: 'B (pu)',
    minWidth: 88,
    numeric: true,
    format: formatParamValue,
    accessor: (r) => r.b,
    edit: { param: 'b' },
  },
  {
    key: 'g',
    label: 'G (pu)',
    minWidth: 88,
    numeric: true,
    format: formatParamValue,
    accessor: (r) => r.g,
    edit: { param: 'g' },
  },
];

const EDIT_TARGET: GridEditTarget<ShuntRow> = { model: () => 'Shunt', idx: (r) => r.idx };

export interface ShuntsGridProps {
  className?: string;
}

export function ShuntsGrid({ className }: ShuntsGridProps) {
  const topology = useCurrentTopology();
  const setSelectedNodeId = useSldStore((s) => s.setSelectedNodeId);
  const selectedNodeId = useSldStore((s) => s.selectedNodeId);
  const setSelectedElement = useCaseStore((s) => s.setSelectedElement);
  const editing = useGridEditing(EDIT_TARGET);

  const rows = useMemo<ShuntRow[]>(() => {
    if (!topology) return [];
    const shunts = topology.shunts ?? [];
    return shunts.map((sh) => {
      const idx = String(sh.idx);
      return {
        rowId: `shunt-${idx}`,
        idx,
        bus: paramString(sh, 'bus'),
        b: numberOrNumeral(sh, 'b'),
        g: numberOrNumeral(sh, 'g'),
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
      ariaLabel="Shunts"
      exportPanel="shunts"
      filterable
      copyable
      editing={editing}
      className={className}
    />
  );
}
