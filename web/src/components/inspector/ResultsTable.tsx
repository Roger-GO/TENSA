import { useMemo, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/shell/EmptyState';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import type { PflowResult, TopologyEntry, TopologySummary } from '@/api/types';
import type { SelectedElement } from '@/store/case';
import { cn } from '@/lib/cn';

/**
 * ResultsTable. Right-dock bottom region; tabbed (Buses / Lines /
 * Generators); sortable + filterable; row-click cross-pane interaction.
 *
 * Per the plan's column tables (lines 838-842):
 *
 * - Buses: idx, name, voltage_mag, voltage_angle, p_inj, q_inj.
 * - Lines: idx, name, from_bus, to_bus, p_flow, q_flow, loading_pct.
 * - Generators: idx, name, bus_idx, p, q, v_setpoint.
 *
 * `loading_pct`, `p_inj`, `q_inj`, `p`, `q` for generators are not
 * directly surfaced by the v0.1 substrate at per-element granularity,
 * so those columns may render `—` when the underlying field is absent.
 * Per the plan: "absent params (None or unavailable on a given model)
 * are omitted." We render an em-dash to keep the column shape stable.
 */

type TabKey = 'buses' | 'lines' | 'generators';

interface SortState {
  column: string;
  direction: 'asc' | 'desc';
}

/** Stable tuple type for table cells: a label + a sort key. */
interface Cell {
  /** Display string. `—` when the value is missing. */
  label: string;
  /** Sortable key. `null` for missing values; sort pushes them last. */
  sortKey: number | string | null;
}

function numCell(v: number | undefined | null, decimals: number, suffix?: string): Cell {
  if (v === undefined || v === null || !Number.isFinite(v)) {
    return { label: '—', sortKey: null };
  }
  return {
    label: suffix ? `${v.toFixed(decimals)} ${suffix}` : v.toFixed(decimals),
    sortKey: v,
  };
}

function strCell(v: string | undefined | null): Cell {
  if (v === undefined || v === null || v === '') {
    return { label: '—', sortKey: null };
  }
  return { label: v, sortKey: v };
}

interface Row {
  /** Stable React key. */
  key: string;
  /** Selected-element handle for the row click. */
  selected: SelectedElement;
  /** Cells in column order. */
  cells: Cell[];
  /** Optional row-level visual flag (e.g., voltage limit violation). */
  flag?: 'danger' | 'warning' | null;
}

interface ColumnDef {
  key: string;
  label: string;
  /** Default sort direction when the user clicks the column header. */
  defaultDirection: 'asc' | 'desc';
}

const BUS_COLUMNS: ColumnDef[] = [
  { key: 'idx', label: 'idx', defaultDirection: 'asc' },
  { key: 'name', label: 'name', defaultDirection: 'asc' },
  { key: 'voltage_mag', label: 'V (pu)', defaultDirection: 'desc' },
  { key: 'voltage_angle', label: 'angle (°)', defaultDirection: 'desc' },
  { key: 'p_inj', label: 'P (MW)', defaultDirection: 'desc' },
  { key: 'q_inj', label: 'Q (MVAr)', defaultDirection: 'desc' },
];

const LINE_COLUMNS: ColumnDef[] = [
  { key: 'idx', label: 'idx', defaultDirection: 'asc' },
  { key: 'name', label: 'name', defaultDirection: 'asc' },
  { key: 'from_bus', label: 'from', defaultDirection: 'asc' },
  { key: 'to_bus', label: 'to', defaultDirection: 'asc' },
  { key: 'p_flow', label: 'P (MW)', defaultDirection: 'desc' },
  { key: 'q_flow', label: 'Q (MVAr)', defaultDirection: 'desc' },
  { key: 'loading_pct', label: 'loading (%)', defaultDirection: 'desc' },
];

const GEN_COLUMNS: ColumnDef[] = [
  { key: 'idx', label: 'idx', defaultDirection: 'asc' },
  { key: 'name', label: 'name', defaultDirection: 'asc' },
  { key: 'bus_idx', label: 'bus', defaultDirection: 'asc' },
  { key: 'p', label: 'P (MW)', defaultDirection: 'desc' },
  { key: 'q', label: 'Q (MVAr)', defaultDirection: 'desc' },
  { key: 'v_setpoint', label: 'V_set (pu)', defaultDirection: 'asc' },
];

/** Voltage band classification — matches `overlay.ts` constants. */
function classifyBusVoltage(v: number | undefined): 'danger' | 'warning' | null {
  if (v === undefined || !Number.isFinite(v)) return null;
  if (v < 0.95 || v > 1.05) return 'danger';
  if (v < 0.97 || v > 1.03) return 'warning';
  return null;
}

function paramNumber(entry: TopologyEntry, key: string): number | undefined {
  const v = entry.params?.[key];
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function paramString(entry: TopologyEntry, key: string): string | undefined {
  const v = entry.params?.[key];
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

// ---- row builders ----------------------------------------------------------

function buildBusRows(topology: TopologySummary, pflow: PflowResult | null): Row[] {
  return topology.buses.map((bus) => {
    const idx = String(bus.idx);
    const v = pflow?.converged ? pflow.bus_voltages[idx] : undefined;
    const a = pflow?.converged ? pflow.bus_angles[idx] : undefined;
    const angleDeg = a !== undefined && Number.isFinite(a) ? (a * 180) / Math.PI : undefined;
    return {
      key: `bus-${idx}`,
      selected: { kind: 'bus', idx },
      cells: [
        strCell(idx),
        strCell(bus.name),
        numCell(v, 4),
        numCell(angleDeg, 2),
        // p_inj / q_inj per bus aren't surfaced by the substrate today.
        numCell(undefined, 2),
        numCell(undefined, 2),
      ],
      flag: classifyBusVoltage(v),
    };
  });
}

function buildLineRows(topology: TopologySummary, pflow: PflowResult | null): Row[] {
  return topology.lines.map((line) => {
    const idx = String(line.idx);
    const flow = pflow?.converged ? pflow.line_flows?.[idx] : undefined;
    const fromBus = paramString(line, 'bus1');
    const toBus = paramString(line, 'bus2');
    return {
      key: `line-${idx}`,
      selected: { kind: 'line', idx },
      cells: [
        strCell(idx),
        strCell(line.name),
        strCell(fromBus),
        strCell(toBus),
        numCell(flow?.p, 2),
        numCell(flow?.q, 2),
        // loading_pct: needs line rating; not exposed by v0.1 substrate.
        numCell(undefined, 1),
      ],
    };
  });
}

function buildGenRows(topology: TopologySummary): Row[] {
  return topology.generators.map((gen) => {
    const idx = String(gen.idx);
    const busIdx = paramString(gen, 'bus');
    // p / q for generators are typically the dispatch params (`p0`, `q0`).
    const p = paramNumber(gen, 'p0') ?? paramNumber(gen, 'p');
    const q = paramNumber(gen, 'q0') ?? paramNumber(gen, 'q');
    const v0 = paramNumber(gen, 'v0') ?? paramNumber(gen, 'vset') ?? paramNumber(gen, 'V0');
    return {
      key: `generator-${idx}`,
      selected: { kind: 'generator', idx },
      cells: [
        strCell(idx),
        strCell(gen.name),
        strCell(busIdx),
        numCell(p, 2),
        numCell(q, 2),
        numCell(v0, 4),
      ],
    };
  });
}

// ---- sort + filter ---------------------------------------------------------

function compareCells(a: Cell, b: Cell, direction: 'asc' | 'desc'): number {
  // Push nulls to the end regardless of direction.
  if (a.sortKey === null && b.sortKey === null) return 0;
  if (a.sortKey === null) return 1;
  if (b.sortKey === null) return -1;
  let cmp: number;
  if (typeof a.sortKey === 'number' && typeof b.sortKey === 'number') {
    cmp = a.sortKey - b.sortKey;
  } else {
    cmp = String(a.sortKey).localeCompare(String(b.sortKey), undefined, {
      numeric: true,
    });
  }
  return direction === 'asc' ? cmp : -cmp;
}

function filterRows(rows: Row[], query: string): Row[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) => {
    // Match on idx (cell 0) + name (cell 1) substrings.
    const idx = String(row.cells[0]?.label ?? '').toLowerCase();
    const name = String(row.cells[1]?.label ?? '').toLowerCase();
    return idx.includes(q) || name.includes(q);
  });
}

function sortRows(rows: Row[], columns: ColumnDef[], sort: SortState): Row[] {
  const colIdx = columns.findIndex((c) => c.key === sort.column);
  if (colIdx < 0) return rows;
  return rows.slice().sort((a, b) => {
    const ac = a.cells[colIdx];
    const bc = b.cells[colIdx];
    if (!ac || !bc) return 0;
    return compareCells(ac, bc, sort.direction);
  });
}

// ---- table ---------------------------------------------------------------

interface TableProps {
  columns: ColumnDef[];
  rows: Row[];
  emptyTabLabel: string;
  prePflowLabel: string | null;
  selectedElement: SelectedElement | null;
  onRowClick: (selected: SelectedElement) => void;
  testId: string;
}

function ResultTable({
  columns,
  rows,
  emptyTabLabel,
  prePflowLabel,
  selectedElement,
  onRowClick,
  testId,
}: TableProps) {
  const [sort, setSort] = useState<SortState>({
    column: columns[0]?.key ?? 'idx',
    direction: 'asc',
  });
  const [query, setQuery] = useState('');

  const visibleRows = useMemo(() => {
    const filtered = filterRows(rows, query);
    return sortRows(filtered, columns, sort);
  }, [rows, columns, query, sort]);

  const onHeaderClick = (column: ColumnDef) => {
    setSort((prev) => {
      if (prev.column !== column.key) {
        return { column: column.key, direction: column.defaultDirection };
      }
      return {
        column: column.key,
        direction: prev.direction === 'asc' ? 'desc' : 'asc',
      };
    });
  };

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No results"
        description={prePflowLabel ?? emptyTabLabel}
        className="py-6"
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid={testId}>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter by idx or name…"
        aria-label="Filter results"
        className={cn(
          'border-border bg-background text-foreground',
          'h-7 rounded-[var(--radius-sm)] border px-2',
          'font-mono text-xs',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        )}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="bg-muted/50 sticky top-0 z-10">
            <tr>
              {columns.map((column) => {
                const active = sort.column === column.key;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={
                      active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'
                    }
                    className={cn(
                      'border-border border-b px-2 py-1 text-left font-medium',
                      'text-muted-foreground select-none',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onHeaderClick(column)}
                      className={cn(
                        'flex w-full items-center gap-1',
                        'hover:text-foreground',
                        'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
                      )}
                    >
                      <span className="font-mono">{column.label}</span>
                      {active ? (
                        <span aria-hidden="true" className="text-foreground">
                          {sort.direction === 'asc' ? '▲' : '▼'}
                        </span>
                      ) : null}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visibleRows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="text-muted-foreground py-6 text-center text-xs"
                >
                  No rows match the current filter.
                </td>
              </tr>
            ) : (
              visibleRows.map((row) => {
                const isSelected =
                  selectedElement !== null &&
                  selectedElement.idx === row.selected.idx &&
                  selectedElement.kind === row.selected.kind;
                return (
                  <tr
                    key={row.key}
                    data-testid={`results-row-${row.selected.kind}-${row.selected.idx}`}
                    aria-selected={isSelected}
                    onClick={() => onRowClick(row.selected)}
                    className={cn(
                      'border-border cursor-pointer border-b',
                      isSelected ? 'bg-muted' : 'hover:bg-muted/50',
                      row.flag === 'danger'
                        ? 'border-l-danger border-l-2'
                        : row.flag === 'warning'
                          ? 'border-l-warning border-l-2'
                          : '',
                    )}
                  >
                    {row.cells.map((cell, idx) => (
                      <td key={idx} className="text-foreground px-2 py-1 font-mono text-xs">
                        {cell.label}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export interface ResultsTableProps {
  className?: string;
}

export function ResultsTable({ className }: ResultsTableProps) {
  const topology = useCaseStore((s) => s.topology);
  const pflowResult = usePflowStore((s) => s.lastRun);
  const selectedElement = useCaseStore((s) => s.selectedElement);
  const setSelectedElement = useCaseStore((s) => s.setSelectedElement);

  const [tab, setTab] = useState<TabKey>('buses');

  const busRows = useMemo(
    () => (topology ? buildBusRows(topology, pflowResult) : []),
    [topology, pflowResult],
  );
  const lineRows = useMemo(
    () => (topology ? buildLineRows(topology, pflowResult) : []),
    [topology, pflowResult],
  );
  const genRows = useMemo(() => (topology ? buildGenRows(topology) : []), [topology]);

  if (!topology) {
    return (
      <div className={cn('flex h-full flex-col', className)}>
        <EmptyState title="No case loaded" description="Load a case to see its elements." />
      </div>
    );
  }

  // Pre-PF copy varies per tab. For Generators we always show params
  // (no PF needed for setpoint), so its empty branch is keyed on the
  // topology bucket being empty rather than PF state.
  const prePflowLabel = pflowResult ? null : 'Run power flow to see results.';

  const onRowClick = (selected: SelectedElement) => setSelectedElement(selected);

  return (
    <div
      data-testid="results-table"
      className={cn('flex h-full min-h-0 flex-col gap-2 p-3', className)}
    >
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as TabKey)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList aria-label="Results tabs">
          <TabsTrigger value="buses">Buses ({busRows.length})</TabsTrigger>
          <TabsTrigger value="lines">Lines ({lineRows.length})</TabsTrigger>
          <TabsTrigger value="generators">Generators ({genRows.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="buses" className="flex min-h-0 flex-1 flex-col">
          <ResultTable
            columns={BUS_COLUMNS}
            rows={busRows}
            emptyTabLabel="No buses in this case."
            prePflowLabel={prePflowLabel}
            selectedElement={selectedElement}
            onRowClick={onRowClick}
            testId="results-table-buses"
          />
        </TabsContent>
        <TabsContent value="lines" className="flex min-h-0 flex-1 flex-col">
          <ResultTable
            columns={LINE_COLUMNS}
            rows={lineRows}
            emptyTabLabel="No lines in this case."
            prePflowLabel={prePflowLabel}
            selectedElement={selectedElement}
            onRowClick={onRowClick}
            testId="results-table-lines"
          />
        </TabsContent>
        <TabsContent value="generators" className="flex min-h-0 flex-1 flex-col">
          <ResultTable
            columns={GEN_COLUMNS}
            rows={genRows}
            emptyTabLabel="No generators in this case."
            prePflowLabel={null}
            selectedElement={selectedElement}
            onRowClick={onRowClick}
            testId="results-table-generators"
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
