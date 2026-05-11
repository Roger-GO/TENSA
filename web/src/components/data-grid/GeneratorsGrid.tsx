/**
 * GeneratorsGrid (v3 Unit 13).
 *
 * Bottom-drawer "Generators" tab. rowId is ``${kind}-${idx}`` matching
 * the React Flow node id shape ``buildGraph`` emits for non-bus device
 * nodes (e.g. ``GENROU-0``, ``PV-1``, ``Slack-2``). This means
 * ``setSelectedNodeId`` lights up the matching canvas glyph + drives
 * the pan effect; the inspector form data populates from
 * ``case.selectedElement`` per the F-DESIGN-7 dual-write pattern.
 *
 * Columns mirror ResultsTable.tsx's GEN_COLUMNS plus a kind column
 * (e.g. ``GENROU`` vs. ``PV``) and a status column. Per v0.1 the
 * status is not exposed at per-element granularity; falls back to
 * "online" when the param is absent.
 */
import { useMemo } from 'react';
import { DataGrid, type ColumnConfig } from './DataGrid';
import { useCurrentTopology } from '@/api/queries';
import { useSldStore } from '@/store/sld';
import { useCaseStore } from '@/store/case';
import type { TopologyEntry } from '@/api/types';

interface GeneratorRow {
  rowId: string;
  idx: string;
  name: string;
  bus: string | null;
  kind: string;
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

const COLUMNS: ColumnConfig<GeneratorRow>[] = [
  { key: 'idx', label: 'idx', accessor: (r) => r.idx },
  { key: 'name', label: 'name', accessor: (r) => r.name },
  { key: 'bus', label: 'bus', accessor: (r) => r.bus },
  { key: 'kind', label: 'kind', accessor: (r) => r.kind },
  { key: 'p', label: 'P (MW)', numeric: true, accessor: (r) => r.p },
  { key: 'q', label: 'Q (MVAr)', numeric: true, accessor: (r) => r.q },
  { key: 'status', label: 'status', accessor: (r) => r.status },
];

export interface GeneratorsGridProps {
  className?: string;
}

export function GeneratorsGrid({ className }: GeneratorsGridProps) {
  const topology = useCurrentTopology();
  const setSelectedNodeId = useSldStore((s) => s.setSelectedNodeId);
  const selectedNodeId = useSldStore((s) => s.selectedNodeId);
  const setSelectedElement = useCaseStore((s) => s.setSelectedElement);

  const rows = useMemo<GeneratorRow[]>(() => {
    if (!topology) return [];
    return topology.generators.map((gen) => {
      const idx = String(gen.idx);
      const kind = gen.kind;
      // P / Q for generators are typically the dispatch params (p0/q0).
      const p = paramNumber(gen, 'p0') ?? paramNumber(gen, 'p');
      const q = paramNumber(gen, 'q0') ?? paramNumber(gen, 'q');
      // Per ResultsTable.tsx convention: non-bus devices use
      // `${kind}-${idx}` for their React Flow node id. The canvas's
      // generator nodes are mounted with type "generator" but the
      // node id shape is `generator-${idx}` (per buildGraph). Match
      // that shape here so SLD highlight follows row click.
      return {
        rowId: `generator-${idx}`,
        idx,
        name: gen.name,
        bus: paramString(gen, 'bus'),
        kind,
        p,
        q,
        // Status (online/off) isn't surfaced per-element by the v0.1
        // substrate; render "online" as the practical default — every
        // element loaded from a case file is online unless an explicit
        // ``u`` param flips it. Mirrors how the SLD treats unflagged
        // devices.
        status: paramString(gen, 'u') === '0' ? 'off' : 'online',
      };
    });
  }, [topology]);

  const onRowClick = (id: string) => {
    setSelectedNodeId(id);
    const idx = id.replace(/^generator-/, '');
    setSelectedElement({ kind: 'generator', idx });
  };

  return (
    <DataGrid
      columns={COLUMNS}
      rows={rows}
      rowIdAccessor={(r) => r.rowId}
      onRowClick={onRowClick}
      selectedRowId={selectedNodeId}
      emptyState={
        topology ? 'No generators in this case.' : 'Load a case to see generators.'
      }
      testId="generators-grid"
      className={className}
    />
  );
}
