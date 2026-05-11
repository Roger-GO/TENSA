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
 * Columns mirror ResultsTable.tsx's LINE_COLUMNS plus per-end power
 * + loss split per the v3 plan unit-13 spec. Loss is computed as
 * (P_from + P_to) — line-flow conservation says these two are equal
 * in magnitude and opposite in sign for a lossless line; their sum is
 * the line loss in MW. ``q_to`` and ``p_to`` aren't surfaced by the
 * v0.1 substrate's ``LineFlow`` shape (which carries from-side P/Q
 * only), so those cells render ``—``.
 */
import { useMemo } from 'react';
import { DataGrid, type ColumnConfig } from './DataGrid';
import { useCurrentTopology } from '@/api/queries';
import { usePflowStore } from '@/store/pflow';
import { useSldStore } from '@/store/sld';
import { useCaseStore } from '@/store/case';
import type { TopologyEntry } from '@/api/types';

interface LineRow {
  rowId: string;
  idx: string;
  from_bus: string | null;
  to_bus: string | null;
  p_from: number | null;
  q_from: number | null;
  p_to: number | null;
  q_to: number | null;
  loss: number | null;
}

function paramString(entry: TopologyEntry, key: string): string | null {
  const v = entry.params?.[key];
  if (v === undefined || v === null) return null;
  return String(v);
}

const COLUMNS: ColumnConfig<LineRow>[] = [
  { key: 'idx', label: 'idx', accessor: (r) => r.idx },
  { key: 'from_bus', label: 'from', accessor: (r) => r.from_bus },
  { key: 'to_bus', label: 'to', accessor: (r) => r.to_bus },
  { key: 'p_from', label: 'P_from (MW)', numeric: true, accessor: (r) => r.p_from },
  { key: 'q_from', label: 'Q_from (MVAr)', numeric: true, accessor: (r) => r.q_from },
  { key: 'p_to', label: 'P_to (MW)', numeric: true, accessor: (r) => r.p_to },
  { key: 'q_to', label: 'Q_to (MVAr)', numeric: true, accessor: (r) => r.q_to },
  { key: 'loss', label: 'loss (MW)', numeric: true, accessor: (r) => r.loss },
];

export interface LinesGridProps {
  className?: string;
}

export function LinesGrid({ className }: LinesGridProps) {
  const topology = useCurrentTopology();
  const pflow = usePflowStore((s) => s.lastRun);
  const setSelectedNodeId = useSldStore((s) => s.setSelectedNodeId);
  const selectedNodeId = useSldStore((s) => s.selectedNodeId);
  const setSelectedElement = useCaseStore((s) => s.setSelectedElement);

  const rows = useMemo<LineRow[]>(() => {
    if (!topology) return [];
    return topology.lines.map((line) => {
      const idx = String(line.idx);
      const flow = pflow?.converged ? pflow.line_flows?.[idx] : undefined;
      const p_from = flow?.p ?? null;
      const q_from = flow?.q ?? null;
      // Per-end-of-line P/Q split isn't on the v0.1 substrate's
      // LineFlow shape; loss can't be computed without both ends.
      // Leave as null → renders ``—`` until a future server enhancement.
      return {
        rowId: `line-${idx}`,
        idx,
        from_bus: paramString(line, 'bus1'),
        to_bus: paramString(line, 'bus2'),
        p_from: typeof p_from === 'number' && Number.isFinite(p_from) ? p_from : null,
        q_from: typeof q_from === 'number' && Number.isFinite(q_from) ? q_from : null,
        p_to: null,
        q_to: null,
        loss: null,
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
      className={className}
    />
  );
}
