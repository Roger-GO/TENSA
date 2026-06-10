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
 * p_inj / q_inj are computed client-side from the PF result's
 * per-device ``generator_outputs`` / ``load_consumption`` maps:
 * the net bus injection is Σ gen P − Σ load P at the bus (same for
 * Q). Buses with no attached generator or load render ``—``.
 */
import { useMemo } from 'react';
import { DataGrid, type ColumnConfig } from './DataGrid';
import { useCurrentTopology } from '@/api/queries';
import { usePflowStore } from '@/store/pflow';
import { useSldStore } from '@/store/sld';
import { useCaseStore } from '@/store/case';
import type { PflowResult, TopologyEntry } from '@/api/types';

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

interface BusInjection {
  p: number;
  q: number;
}

/**
 * Net per-bus P/Q injection (MW / MVAr) from the last converged PF
 * result: Σ generator output − Σ load consumption at each bus. Buses
 * with neither a generator nor a load are absent from the map, so the
 * grid keeps rendering ``—`` for them.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function computeBusInjections(pflow: PflowResult | null): Map<string, BusInjection> {
  const map = new Map<string, BusInjection>();
  if (!pflow?.converged) return map;
  const accumulate = (bus: string | number, p: number, q: number, sign: 1 | -1) => {
    const key = String(bus);
    const cur = map.get(key) ?? { p: 0, q: 0 };
    map.set(key, { p: cur.p + sign * p, q: cur.q + sign * q });
  };
  for (const gen of Object.values(pflow.generator_outputs ?? {})) {
    accumulate(gen.bus, gen.p, gen.q, 1);
  }
  for (const load of Object.values(pflow.load_consumption ?? {})) {
    accumulate(load.bus, load.p, load.q, -1);
  }
  return map;
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
    const injections = computeBusInjections(pflow);
    return topology.buses.map((bus) => {
      const idx = String(bus.idx);
      const v = pflow?.converged ? (pflow.bus_voltages[idx] ?? null) : null;
      const theta = pflow?.converged ? (pflow.bus_angles[idx] ?? null) : null;
      // Net injection from the per-device PF maps (Σ gen − Σ load at
      // this bus). ``null`` (→ "—") when no generator/load attaches
      // here or PF hasn't converged yet.
      const inj = injections.get(idx) ?? null;
      return {
        idx,
        name: bus.name,
        v: typeof v === 'number' && Number.isFinite(v) ? v : null,
        theta: typeof theta === 'number' && Number.isFinite(theta) ? theta : null,
        p_inj: inj !== null && Number.isFinite(inj.p) ? inj.p : null,
        q_inj: inj !== null && Number.isFinite(inj.q) ? inj.q : null,
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
