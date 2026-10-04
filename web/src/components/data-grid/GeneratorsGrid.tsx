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
 *
 * P / Q are the solved output (MW / MVAr) from the last converged power
 * flow, the same figures the diagram and the inspector print, and read
 * ``—`` until power flow has run. The case's own ``p0`` / ``q0`` are not
 * shown: they are per-unit setpoints, a dynamic machine has none, and a
 * PV generator has no ``q0``. The reactive limits (``qmin`` / ``qmax``, in
 * MVAr) sit beside Q with the verdict in words, since the power flow does not
 * hold a generator to them: an output can lie past one.
 */
import { useMemo } from 'react';
import { DataGrid, type ColumnConfig } from './DataGrid';
import { useCurrentTopology } from '@/api/queries';
import { usePflowStore } from '@/store/pflow';
import { useSldStore } from '@/store/sld';
import { useCaseStore } from '@/store/case';
import { generatorRowKey } from '@/lib/topology';
import { assessQLimit, qLimitText } from '@/components/sld/qLimit';
import type { TopologyEntry } from '@/api/types';

interface GeneratorRow {
  rowId: string;
  idx: string;
  name: string;
  bus: string | null;
  kind: string;
  p: number | null;
  q: number | null;
  q_min: number | null;
  q_max: number | null;
  q_check: string | null;
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

const OUTPUT_TITLE = 'Output from the last power flow run. Shows a dash until power flow has run.';

const Q_LIMIT_TITLE =
  'The reactive power limit the case sets. Power flow does not enforce it, so Q can lie past it. A dash for a generator that is switched off, and until power flow has run.';

const COLUMNS: ColumnConfig<GeneratorRow>[] = [
  { key: 'idx', label: 'idx', accessor: (r) => r.idx },
  { key: 'name', label: 'name', accessor: (r) => r.name },
  { key: 'bus', label: 'bus', accessor: (r) => r.bus },
  { key: 'kind', label: 'kind', accessor: (r) => r.kind },
  {
    key: 'p',
    label: 'P (MW)',
    title: OUTPUT_TITLE,
    numeric: true,
    accessor: (r) => r.p,
  },
  {
    key: 'q',
    label: 'Q (MVAr)',
    title: OUTPUT_TITLE,
    numeric: true,
    accessor: (r) => r.q,
  },
  {
    key: 'q_min',
    label: 'Qmin (MVAr)',
    title: Q_LIMIT_TITLE,
    numeric: true,
    accessor: (r) => r.q_min,
  },
  {
    key: 'q_max',
    label: 'Qmax (MVAr)',
    title: Q_LIMIT_TITLE,
    numeric: true,
    accessor: (r) => r.q_max,
  },
  {
    key: 'q_check',
    label: 'Q check',
    title:
      'Where Q stands against Qmin and Qmax: within them, on one, or past one. Filled in once a power flow has run.',
    width: 104,
    accessor: (r) => r.q_check,
  },
  { key: 'status', label: 'status', accessor: (r) => r.status },
];

export interface GeneratorsGridProps {
  className?: string;
}

export function GeneratorsGrid({ className }: GeneratorsGridProps) {
  const topology = useCurrentTopology();
  const pflow = usePflowStore((s) => s.lastRun);
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
    const outputs = pflow?.converged ? pflow.generator_outputs : undefined;
    return topology.generators.map((gen) => {
      const idx = String(gen.idx);
      const kind = gen.kind;
      // The PF result has a row per static generator (PV, Slack) only. A
      // dynamic machine (GENROU, GENCLS) reads the row of the static
      // generator it names, so both of the pair show the same output.
      const output = outputs?.[generatorRowKey(gen)];
      const p = finiteOrNull(output?.p);
      const q = finiteOrNull(output?.q);
      const qMin = finiteOrNull(output?.q_min ?? undefined);
      const qMax = finiteOrNull(output?.q_max ?? undefined);
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
        q_min: qMin,
        q_max: qMax,
        q_check: qLimitText(assessQLimit(q, qMin, qMax)),
        // Status (online/off) isn't surfaced per-element by the v0.1
        // substrate; render "online" as the practical default — every
        // element loaded from a case file is online unless an explicit
        // ``u`` param flips it. Mirrors how the SLD treats unflagged
        // devices.
        status: paramString(gen, 'u') === '0' ? 'off' : 'online',
      };
    });
  }, [topology, pflow]);

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
      emptyState={topology ? 'No generators in this case.' : 'Load a case to see generators.'}
      testId="generators-grid"
      exportPanel="generators"
      className={className}
    />
  );
}
