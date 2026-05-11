/**
 * BusesGrid (v3 Unit 13).
 *
 * Bottom-drawer "Buses" tab. Reads topology from the TanStack Query
 * cache + per-bus PF result from ``usePflowStore.lastRun``. Row click
 * writes both ``useSldStore.selectedNodeId`` (drives canvas pan +
 * highlight) AND ``useCaseStore.selectedElement`` (drives the right
 * inspector form data) per the F-DESIGN-7 dual-write pattern. Bus
 * rowId is the bare ``idx`` string — bus React Flow nodes use the
 * bare idx as their node id.
 *
 * Columns mirror the retired v2 BUS_COLUMNS shape verbatim (the
 * canonical pattern from Phase 2 Unit 11; v2 file retired in v3
 * Unit 15) plus area + zone (per the v3 plan unit-13 spec).
 * p_inj / q_inj per-bus injections aren't surfaced by the v0.1
 * substrate at per-element granularity, so those cells render as
 * ``—`` until a future server-side enhancement lands.
 */
import { useMemo } from 'react';
import { DataGrid, type ColumnConfig } from './DataGrid';
import { useCurrentTopology } from '@/api/queries';
import { usePflowStore } from '@/store/pflow';
import { useSldStore } from '@/store/sld';
import { useCaseStore } from '@/store/case';
import type { TopologyEntry } from '@/api/types';

interface BusRow {
  idx: string;
  name: string;
  v: number | null;
  theta: number | null;
  p_inj: number | null;
  q_inj: number | null;
  area: string | null;
  zone: string | null;
}

function paramOf(entry: TopologyEntry, key: string): string | number | null {
  const v = entry.params?.[key];
  if (v === undefined || v === null) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  return null;
}

function paramString(entry: TopologyEntry, key: string): string | null {
  const v = paramOf(entry, key);
  if (v === null) return null;
  return String(v);
}

const COLUMNS: ColumnConfig<BusRow>[] = [
  { key: 'idx', label: 'idx', accessor: (r) => r.idx },
  { key: 'name', label: 'name', accessor: (r) => r.name },
  { key: 'v', label: 'V (pu)', numeric: true, accessor: (r) => r.v },
  { key: 'theta', label: 'θ (rad)', numeric: true, accessor: (r) => r.theta },
  { key: 'p_inj', label: 'P (MW)', numeric: true, accessor: (r) => r.p_inj },
  { key: 'q_inj', label: 'Q (MVAr)', numeric: true, accessor: (r) => r.q_inj },
  { key: 'area', label: 'area', accessor: (r) => r.area },
  { key: 'zone', label: 'zone', accessor: (r) => r.zone },
];

export interface BusesGridProps {
  className?: string;
}

export function BusesGrid({ className }: BusesGridProps) {
  const topology = useCurrentTopology();
  const pflow = usePflowStore((s) => s.lastRun);
  const setSelectedNodeId = useSldStore((s) => s.setSelectedNodeId);
  const selectedNodeId = useSldStore((s) => s.selectedNodeId);
  const setSelectedElement = useCaseStore((s) => s.setSelectedElement);

  const rows = useMemo<BusRow[]>(() => {
    if (!topology) return [];
    return topology.buses.map((bus) => {
      const idx = String(bus.idx);
      const v = pflow?.converged ? (pflow.bus_voltages[idx] ?? null) : null;
      const theta = pflow?.converged ? (pflow.bus_angles[idx] ?? null) : null;
      return {
        idx,
        name: bus.name,
        v: typeof v === 'number' && Number.isFinite(v) ? v : null,
        theta: typeof theta === 'number' && Number.isFinite(theta) ? theta : null,
        // Per-bus injection isn't surfaced at per-element granularity
        // by the v0.1 substrate — leaves the cells as em-dashes until
        // a future enhancement adds them. Mirrors the retired v2
        // results-table's "—" branch for these columns.
        p_inj: null,
        q_inj: null,
        area: paramString(bus, 'area'),
        zone: paramString(bus, 'zone'),
      };
    });
  }, [topology, pflow]);

  const onRowClick = (id: string) => {
    setSelectedNodeId(id);
    setSelectedElement({ kind: 'bus', idx: id });
  };

  return (
    <DataGrid
      columns={COLUMNS}
      rows={rows}
      rowIdAccessor={(r) => r.idx}
      onRowClick={onRowClick}
      selectedRowId={selectedNodeId}
      emptyState={topology ? 'No buses in this case.' : 'Load a case to see buses.'}
      testId="buses-grid"
      className={className}
    />
  );
}
