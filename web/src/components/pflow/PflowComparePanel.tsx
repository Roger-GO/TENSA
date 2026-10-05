/**
 * PflowComparePanel: the Analysis tab's "Compare" sub-tab. Two of the power
 * flows kept in the history (``store/pflowHistory.ts``) side by side: what each
 * bus voltage and angle, each line's flow, each generator and load, and the
 * system totals changed by from A, the reference, to B.
 *
 * B follows the latest converged power flow and A is the one before it, so
 * "run, change something, run again" needs no picking; either can be set to any
 * result kept. A result can be named (a named one is not pushed out by newer
 * runs) and deleted. The table is a ``DataGrid``: it sorts, filters, copies and
 * exports as CSV like the element tables, and starts with the largest change
 * first.
 *
 * The numbers come from ``comparePflow``; the HTML report prints the same
 * tables.
 */
import { useMemo, useState } from 'react';
import { DataGrid, type ColumnConfig } from '@/components/data-grid/DataGrid';
import { RenameRunButton, RunRenameInput } from '@/components/plots/RunRename';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import {
  comparePflow,
  comparisonCellText,
  comparisonHeadline,
  comparisonTables,
  type ComparisonColumn,
  type ComparisonRow,
  type ComparisonTableId,
} from '@/lib/pflowCompare';
import { formatTakenAt } from '@/lib/takenAt';
import {
  MAX_PFLOW_SNAPSHOTS,
  resolveComparePair,
  snapshotLabel,
  usePflowHistoryStore,
  type PflowSnapshot,
} from '@/store/pflowHistory';

export interface PflowComparePanelProps {
  className?: string;
}

/** What a result reads as in a picker: its label, its case and when it was solved. */
function optionText(snapshot: PflowSnapshot): string {
  return `${snapshotLabel(snapshot)} · ${snapshot.caseName} · ${formatTakenAt(snapshot.takenAt)}`;
}

function gridColumns(columns: readonly ComparisonColumn[]): ColumnConfig<ComparisonRow>[] {
  return columns.map((column, i) => ({
    key: column.key,
    label: column.label,
    ...(column.title === undefined ? {} : { title: column.title }),
    numeric: column.numeric,
    // Every column has a least width, so the wide tables (a line has sixteen)
    // scroll sideways in a narrow drawer and no heading is cut.
    minWidth: column.numeric ? 104 : column.key === 'name' ? 120 : 72,
    accessor: (row: ComparisonRow) => row.cells[i] ?? null,
    ...(column.numeric
      ? {
          format: (value: string | number | null) => comparisonCellText(value, column) || '—',
        }
      : {}),
  }));
}

interface SidePickerProps {
  side: 'a' | 'b';
  title: string;
  hint: string;
  selected: PflowSnapshot;
  /** The result on the other side, which this picker does not offer. */
  other: PflowSnapshot;
  snapshots: readonly PflowSnapshot[];
  onPick: (id: string) => void;
}

/** One side's picker, with the pencil that names the result and the button that drops it. */
function SidePicker({ side, title, hint, selected, other, snapshots, onPick }: SidePickerProps) {
  const rename = usePflowHistoryStore((s) => s.rename);
  const remove = usePflowHistoryStore((s) => s.remove);
  const [renaming, setRenaming] = useState(false);
  const label = snapshotLabel(selected);
  return (
    <div className="flex min-w-0 items-center gap-1" data-testid={`pflow-compare-side-${side}`}>
      <label
        htmlFor={`pflow-compare-select-${side}`}
        className="text-muted-foreground text-[11px] font-medium whitespace-nowrap"
        title={hint}
      >
        {title}
      </label>
      {renaming ? (
        <RunRenameInput
          initialValue={selected.name ?? ''}
          placeholder={`PF #${selected.ordinal}`}
          onCommit={(next) => {
            setRenaming(false);
            rename(selected.id, next);
          }}
          onCancel={() => setRenaming(false)}
          data-testid={`pflow-compare-name-input-${side}`}
          aria-label={`New name for ${label}`}
          className="w-56"
        />
      ) : (
        <>
          <select
            id={`pflow-compare-select-${side}`}
            data-testid={`pflow-compare-select-${side}`}
            value={selected.id}
            onChange={(e) => onPick(e.target.value)}
            className={cn(
              'border-border bg-background text-foreground h-7 max-w-full min-w-0 rounded border px-1.5 text-xs',
              'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
            )}
          >
            {/* Newest first, as the run history lists its runs. */}
            {[...snapshots].reverse().map((s) => (
              <option key={s.id} value={s.id} disabled={s.id === other.id}>
                {optionText(s)}
              </option>
            ))}
          </select>
          <RenameRunButton
            aria-label={`Rename ${label}`}
            title="Name this result. A named result is kept while newer runs come in."
            onClick={() => setRenaming(true)}
            data-testid={`pflow-compare-rename-${side}`}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => remove(selected.id)}
            title="Delete this result from the kept power flows"
            aria-label={`Delete ${label}`}
            data-testid={`pflow-compare-delete-${side}`}
            className="h-7 px-2"
          >
            Delete
          </Button>
        </>
      )}
    </div>
  );
}

export function PflowComparePanel({ className }: PflowComparePanelProps) {
  const snapshots = usePflowHistoryStore((s) => s.snapshots);
  const baselineId = usePflowHistoryStore((s) => s.baselineId);
  const comparedId = usePflowHistoryStore((s) => s.comparedId);
  const setBaseline = usePflowHistoryStore((s) => s.setBaseline);
  const setCompared = usePflowHistoryStore((s) => s.setCompared);
  const [tableId, setTableId] = useState<ComparisonTableId>('buses');

  const { a, b } = useMemo(
    () => resolveComparePair({ snapshots, baselineId, comparedId }),
    [snapshots, baselineId, comparedId],
  );
  const comparison = useMemo(() => (a !== null && b !== null ? comparePflow(a, b) : null), [a, b]);
  const tables = useMemo(
    () => (comparison === null ? [] : comparisonTables(comparison)),
    [comparison],
  );
  const table = tables.find((t) => t.id === tableId) ?? tables[0];
  const columns = useMemo(() => (table === undefined ? [] : gridColumns(table.columns)), [table]);

  if (a === null || b === null || comparison === null || table === undefined) {
    return (
      <section
        data-testid="pflow-compare"
        aria-label="Compare power flows"
        className={cn('flex min-h-0 flex-1 flex-col gap-2 p-3', className)}
      >
        <h2 className="text-foreground text-sm font-semibold">Compare power flows</h2>
        <p data-testid="pflow-compare-empty" className="text-muted-foreground max-w-prose text-xs">
          {snapshots.length === 0
            ? 'No power flow has converged yet. Run one, change the system (a load, a line out of service, another case) and run it again: the two results are set side by side here, with what each bus voltage, angle and line flow changed by.'
            : `One power flow is kept so far (${optionText(snapshots[0]!)}). Change the system (a load, a line out of service, another case) and run a power flow again to compare the two.`}
        </p>
      </section>
    );
  }

  const swap = () => {
    setBaseline(b.id);
    setCompared(a.id);
  };

  return (
    <section
      data-testid="pflow-compare"
      aria-label="Compare power flows"
      className={cn('flex min-h-0 flex-1 flex-col gap-2 p-3', className)}
    >
      {/* Kept to a few short rows: in the drawer the table has what is left. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <h2 className="text-foreground text-sm font-semibold">Compare power flows</h2>
        <SidePicker
          side="a"
          title="A (reference)"
          hint="The result the differences are measured from."
          selected={a}
          other={b}
          snapshots={snapshots}
          onPick={setBaseline}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={swap}
          title="Make B the reference and A the result compared with it"
          data-testid="pflow-compare-swap"
          className="h-7 px-2"
        >
          Swap A and B
        </Button>
        <SidePicker
          side="b"
          title="B"
          hint="The result compared with the reference."
          selected={b}
          other={a}
          snapshots={snapshots}
          onPick={setCompared}
        />
      </div>
      <p
        data-testid="pflow-compare-about"
        className="text-muted-foreground text-[11px] leading-snug"
      >
        Every difference is B minus A. B follows the latest power flow unless another is picked. The
        last {MAX_PFLOW_SNAPSHOTS} converged results are kept; a named one stays while newer runs
        come in. Time-domain runs are compared on the Plot tab, by pinning them in History.
      </p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div
          role="group"
          aria-label="What to compare"
          className="flex flex-wrap items-center gap-1.5"
        >
          {tables.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={t.id === table.id}
              onClick={() => setTableId(t.id)}
              data-testid={`pflow-compare-table-${t.id}`}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
                t.id === table.id
                  ? 'border-primary/50 bg-primary/15 text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {t.title} <span className="text-muted-foreground">{t.rows.length}</span>
            </button>
          ))}
        </div>
        <p data-testid="pflow-compare-headline" className="text-foreground text-xs">
          {comparisonHeadline(comparison)}
        </p>
      </div>

      <div className="border-border flex min-h-40 flex-1 flex-col overflow-hidden rounded border">
        <DataGrid
          // A grid per table: the sort and the filter of one do not carry to another.
          key={table.id}
          columns={columns}
          rows={table.rows}
          rowIdAccessor={(row) => row.id}
          emptyState={
            table.id === 'totals'
              ? 'One of the two results has no system totals.'
              : 'Neither result has any.'
          }
          testId="pflow-compare-grid"
          ariaLabel={`${table.title}: B compared with A`}
          exportPanel={`pf-compare-${table.id}`}
          hint="Largest change first. Click a heading to sort by it."
          filterable
          copyable
        />
      </div>
    </section>
  );
}
