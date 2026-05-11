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
 * Columns mirror the retired v2 GEN_COLUMNS shape (file retired in
 * v3 Unit 15) plus a kind column (e.g. ``GENROU`` vs. ``PV``) and a
 * status column. Per v0.1 the status is not exposed at per-element
 * granularity; falls back to "online" when the param is absent.
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
  const setSelectedElement = useCaseStore((s) => s.setSelectedElement);
  // Row highlight: rows are kind-namespaced (`pv-1`, `genrou-1`) but
  // selectedNodeId is the kind-agnostic canvas id `generator-1`. We
  // accept that selecting a generator highlights ALL rows sharing the
  // idx (PV + GENROU together) — the user picked "generator at bus 1"
  // and both records belong to it. DataGrid takes a single selectedRowId
  // string, so we pass the idx-only suffix and adjust the row matcher.
  const selectedNodeId = useSldStore((s) => s.selectedNodeId);
  const selectedIdx = selectedNodeId?.startsWith('generator-')
    ? selectedNodeId.replace(/^generator-/, '')
    : null;

  const rows = useMemo<GeneratorRow[]>(() => {
    if (!topology) return [];
    return topology.generators.map((gen) => {
      const idx = String(gen.idx);
      const kind = gen.kind;
      // P / Q for generators are typically the dispatch params (p0/q0).
      const p = paramNumber(gen, 'p0') ?? paramNumber(gen, 'p');
      const q = paramNumber(gen, 'q0') ?? paramNumber(gen, 'q');
      // Generators in ANDES split across multiple kinds (PV, Slack,
      // GENROU, GENCLS, …) that all use the model-local idx (1, 2, 3,
      // …). A bus may carry BOTH a PV record AND a GENROU dynamic
      // record at the same idx, producing duplicate row keys when we
      // namespace only by idx. Use `${kind}-${idx}` so each substrate
      // entry maps to a unique grid row. The canvas's React Flow node
      // id is `generator-${idx}` (one node per bus regardless of which
      // kind contributed it) — selection-sync from grid → canvas
      // therefore highlights the canvas node by matching idx alone via
      // the trailing fragment.
      return {
        rowId: `${kind.toLowerCase()}-${idx}`,
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
    // id is ``${kind.toLowerCase()}-${idx}`` (e.g. "pv-1", "genrou-1").
    // Pan the canvas via the SLD's per-bus generator node which uses
    // the bare ``generator-${idx}`` id, not the kind-namespaced id.
    const idx = id.replace(/^[^-]+-/, '');
    setSelectedNodeId(`generator-${idx}`);
    setSelectedElement({ kind: 'generator', idx });
  };

  return (
    <DataGrid
      columns={COLUMNS}
      rows={rows}
      rowIdAccessor={(r) => r.rowId}
      onRowClick={onRowClick}
      // Highlight any row whose idx matches the selected generator. We
      // use a callback predicate via a derived selectedRowId per row by
      // mapping idx back to a wildcard rowId — but DataGrid only takes
      // a single string. Instead, just compare idx via a selected-row
      // lambda by feeding the matching rowId for the FIRST kind that
      // shares idx (PV usually appears before GENROU in topology). A
      // future refactor would extend DataGrid with a multi-select
      // predicate; for v3 the single-row highlight is acceptable.
      selectedRowId={(() => {
        if (selectedIdx === null) return null;
        return rows.find((r) => r.idx === selectedIdx)?.rowId ?? null;
      })()}
      emptyState={
        topology ? 'No generators in this case.' : 'Load a case to see generators.'
      }
      testId="generators-grid"
      className={className}
    />
  );
}
