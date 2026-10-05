/**
 * Tables of the dynamic models: the machines (GENROU, GENCLS), the exciters and
 * the governors, one table to a model.
 *
 * The static tables hold what power flow needs; these hold what the time-domain
 * run needs, and every parameter the model takes is a column, read from the
 * topology schema the add and edit forms use, in the order they list it, with its
 * unit in the heading. A case with more than one model of a kind (IEEEX1 and
 * ESDC2A exciters, say) has a chip per model above the table, since the models
 * have different parameters and cannot share columns.
 *
 * The values are the case's own and can be changed in the table, like those of the
 * static tables, by the same route and with the same locks (see
 * ``useGridEditing``). A machine can be changed before a run only. An exciter or a
 * governor can also be changed after one with Edit mode on, which writes it to a copy
 * of the case file: the switch is in the bar.
 *
 * ANDES holds a GENROU's inertia as ``M`` (= 2H), and engineers think in ``H``, so
 * a GENROU has both columns: ``H`` is ``M`` over two, and typing one sets ``M``.
 *
 * Row click selects the device in the diagram and the Inspector as a click on it
 * there does: a machine as the generator at its idx (the Generators table does the
 * same), a controller by its model class and idx.
 */
import { useMemo, useState } from 'react';
import { DataGrid, type ColumnConfig } from './DataGrid';
import { formatParamValue } from './gridCells';
import { useGridEditing, type GridEditTarget } from './useGridEditing';
import { useCurrentTopology, useTopologySchema } from '@/api/queries';
import type { ParamValue, TopologyEntry, TopologyParamMeta, TopologySummary } from '@/api/types';
import { cn } from '@/lib/cn';
import { subKindForControllerClass } from '@/lib/controllers';
import { DYNAMIC_GENERATOR_KINDS } from '@/lib/topology';
import { useCaseStore } from '@/store/case';
import { useSldStore } from '@/store/sld';

export type ModelFamily = 'machines' | 'exciters' | 'governors';

interface ModelRow {
  rowId: string;
  idx: string;
  name: string;
  /** The ANDES model class (`GENROU`, `IEEEX1`). */
  kind: string;
  params: Readonly<Record<string, ParamValue>>;
}

interface FamilySpec {
  /** Names the table for assistive tech and its test ids. */
  label: string;
  testId: string;
  noun: string;
  /** What to say when the case has none. */
  emptyHint: string;
  controllers: boolean;
  /** The topology entries of the family. */
  entries: (topology: TopologySummary) => TopologyEntry[];
}

const FAMILIES: Record<ModelFamily, FamilySpec> = {
  machines: {
    label: 'Machines',
    testId: 'machines-grid',
    noun: 'machines',
    emptyHint: 'Open the case with its .dyr file, or an .xlsx that has them.',
    controllers: false,
    entries: (t) => t.generators.filter((g) => DYNAMIC_GENERATOR_KINDS.has(g.kind)),
  },
  exciters: {
    label: 'Exciters',
    testId: 'exciters-grid',
    noun: 'exciters',
    emptyHint: 'Open the case with its .dyr file, or an .xlsx that has them.',
    controllers: true,
    entries: (t) =>
      (t.controllers ?? []).filter((c) => subKindForControllerClass(c.kind) === 'exciter'),
  },
  governors: {
    label: 'Governors',
    testId: 'governors-grid',
    noun: 'governors',
    emptyHint: 'Open the case with its .dyr file, or an .xlsx that has them.',
    controllers: true,
    entries: (t) =>
      (t.controllers ?? []).filter((c) => subKindForControllerClass(c.kind) === 'governor'),
  },
};

const MACHINE_TARGET: GridEditTarget<ModelRow> = { model: (r) => r.kind, idx: (r) => r.idx };
const CONTROLLER_TARGET: GridEditTarget<ModelRow> = { ...MACHINE_TARGET, controllers: true };

/**
 * A parameter the schema lists that the model has no attribute of: its value comes
 * from others. ANDES holds a GENROU's inertia as ``M`` (= 2H); the schema lists the
 * ``H`` that the add form takes and that an edit converts the same way.
 */
const DERIVED: Record<
  string,
  Record<string, (params: Readonly<Record<string, ParamValue>>) => number | null>
> = {
  GENROU: {
    H: (p) => (typeof p.M === 'number' && Number.isFinite(p.M) ? p.M / 2 : null),
  },
};

/** What a model's table has columns for: the schema's parameters, or the entries' own when it knows none. */
function metasFor(
  schema: ReadonlyArray<TopologyParamMeta> | undefined,
  rows: ReadonlyArray<ModelRow>,
): TopologyParamMeta[] {
  if (schema !== undefined) return schema.filter((m) => m.name !== 'idx' && m.name !== 'name');
  const names: string[] = [];
  for (const row of rows) {
    for (const name of Object.keys(row.params)) if (!names.includes(name)) names.push(name);
  }
  return names.map((name) => ({
    name,
    kind:
      typeof rows.find((r) => name in r.params)?.params[name] === 'number' ? 'number' : 'string',
    required: false,
    unit: null,
  }));
}

function columnsFor(
  kind: string,
  metas: ReadonlyArray<TopologyParamMeta>,
): ColumnConfig<ModelRow>[] {
  const derived = DERIVED[kind] ?? {};
  const columns: ColumnConfig<ModelRow>[] = [
    { key: 'idx', label: 'idx', minWidth: 80, accessor: (r) => r.idx },
    { key: 'name', label: 'name', minWidth: 120, accessor: (r) => r.name },
  ];
  for (const meta of metas) {
    const label = meta.unit ? `${meta.name} (${meta.unit})` : meta.name;
    const minWidth = Math.max(80, label.length * 8 + 36);
    const derive = derived[meta.name];
    if (meta.kind === 'number') {
      columns.push({
        key: meta.name,
        label,
        title: derive ? `${meta.name} is M divided by two. Typing it sets M.` : undefined,
        minWidth,
        numeric: true,
        format: formatParamValue,
        accessor: (r) => {
          if (derive) return derive(r.params);
          const v = r.params[meta.name];
          return typeof v === 'number' && Number.isFinite(v) ? v : null;
        },
        edit: { param: meta.name },
      });
    } else {
      columns.push({
        key: meta.name,
        label,
        title: meta.kind === 'string' ? undefined : `Links to a ${meta.kind.replace('_idx', '')}`,
        minWidth,
        accessor: (r) => {
          const v = r.params[meta.name];
          return v === undefined ? null : String(v);
        },
      });
    }
  }
  return columns;
}

export interface ModelParamsGridProps {
  family: ModelFamily;
  className?: string;
}

export function ModelParamsGrid({ family, className }: ModelParamsGridProps) {
  const spec = FAMILIES[family];
  const topology = useCurrentTopology();
  const schema = useTopologySchema();
  const setSelectedNodeId = useSldStore((s) => s.setSelectedNodeId);
  const selectedNodeId = useSldStore((s) => s.selectedNodeId);
  const setSelectedElement = useCaseStore((s) => s.setSelectedElement);
  const editing = useGridEditing(spec.controllers ? CONTROLLER_TARGET : MACHINE_TARGET);
  const [chosen, setChosen] = useState<string | null>(null);

  const rowsByKind = useMemo(() => {
    const byKind = new Map<string, ModelRow[]>();
    if (!topology) return byKind;
    for (const entry of spec.entries(topology)) {
      const idx = String(entry.idx);
      const row: ModelRow = {
        rowId: `${entry.kind}-${idx}`,
        idx,
        name: entry.name,
        kind: entry.kind,
        params: entry.params ?? {},
      };
      byKind.set(entry.kind, [...(byKind.get(entry.kind) ?? []), row]);
    }
    return byKind;
  }, [topology, spec]);

  const kinds = [...rowsByKind.keys()];
  const kind = chosen !== null && rowsByKind.has(chosen) ? chosen : (kinds[0] ?? null);
  const rows = useMemo(
    () => (kind === null ? [] : (rowsByKind.get(kind) ?? [])),
    [rowsByKind, kind],
  );
  const schemaMetas = kind === null ? undefined : schema.data?.models[kind];
  const columns = useMemo(
    () => (kind === null ? [] : columnsFor(kind, metasFor(schemaMetas, rows))),
    [kind, schemaMetas, rows],
  );

  const onRowClick = (id: string) => {
    const row = rows.find((r) => r.rowId === id);
    if (row === undefined) return;
    if (spec.controllers) {
      setSelectedElement({
        kind: 'controller',
        subKind: subKindForControllerClass(row.kind),
        modelClass: row.kind,
        idx: row.idx,
      });
      setSelectedNodeId(`controller-${row.kind}-${row.idx}`);
    } else {
      // The diagram has one node per bus's generators, named for the idx.
      setSelectedNodeId(`generator-${row.idx}`);
      setSelectedElement({ kind: 'generator', idx: row.idx, modelClass: row.kind });
    }
  };

  let selectedRowId: string | null = null;
  if (spec.controllers) {
    if (selectedNodeId?.startsWith('controller-')) {
      selectedRowId = selectedNodeId.replace(/^controller-/, '');
    }
  } else if (selectedNodeId?.startsWith('generator-')) {
    const selectedIdx = selectedNodeId.replace(/^generator-/, '');
    selectedRowId = rows.find((r) => r.idx === selectedIdx)?.rowId ?? null;
  }

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      {kinds.length > 0 ? (
        <div
          role="group"
          aria-label="Model"
          data-testid={`${spec.testId}-models`}
          className="border-border bg-muted/10 flex shrink-0 flex-wrap items-center gap-1 border-b px-1 py-0.5"
        >
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={k === kind}
              data-testid={`${spec.testId}-model-${k}`}
              onClick={() => setChosen(k)}
              className={cn(
                'rounded-[var(--radius-sm)] border px-2 py-0.5 font-mono text-[11px]',
                'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
                k === kind
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {k} <span className="text-muted-foreground">{rowsByKind.get(k)?.length ?? 0}</span>
            </button>
          ))}
        </div>
      ) : null}
      <DataGrid<ModelRow>
        columns={columns}
        rows={rows}
        rowIdAccessor={(r) => r.rowId}
        onRowClick={onRowClick}
        selectedRowId={selectedRowId}
        emptyState={
          topology
            ? `No ${spec.noun} in this case. ${spec.emptyHint}`
            : `Load a case to see ${spec.noun}.`
        }
        testId={spec.testId}
        ariaLabel={spec.label}
        exportPanel={kind === null ? family : `${family}-${kind.toLowerCase()}`}
        filterable
        copyable
        editing={editing}
      />
    </div>
  );
}

export function MachinesGrid({ className }: { className?: string }) {
  return <ModelParamsGrid family="machines" className={className} />;
}

export function ExcitersGrid({ className }: { className?: string }) {
  return <ModelParamsGrid family="exciters" className={className} />;
}

export function GovernorsGrid({ className }: { className?: string }) {
  return <ModelParamsGrid family="governors" className={className} />;
}
