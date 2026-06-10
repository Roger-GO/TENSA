/**
 * DataGrid (v3 Unit 12).
 *
 * Generic sortable + virtualizable data grid backing the BottomDrawer's
 * per-bucket tabs (Buses / Lines / Generators / Loads / Shunts) in
 * Unit 13.
 *
 * Ergonomics mirror Phase 3 Unit 16's ``EIGParticipationTable``:
 *
 *  - Click-to-sort header. Cycle ``none → asc → desc → none``. Glyph
 *    is ↑ / ↓ when active, ↕ (subtle) when inactive.
 *  - Virtualization via ``react-window``'s ``FixedSizeList`` only when
 *    ``rows.length > 50`` (small grids render a normal table for
 *    cleaner copy-paste / a11y defaults).
 *  - Numeric cells: ``font-mono tabular-nums text-right``.
 *  - Row click → ``onRowClick(rowId)`` + ``data-selected="true"`` ring
 *    on the matching row (resolved via ``selectedRowId``).
 *  - Empty-state slot for "no rows" branches owned by callers.
 *
 * Generic over the row shape: callers pass ``columns`` (with per-column
 * ``accessor`` / ``numeric`` / ``sortable`` flags) and a ``rowIdAccessor``
 * that produces the stable string id used for selection-sync. The
 * generic ``Row`` type is intentionally ``unknown`` at this layer so
 * each per-bucket grid keeps its own row shape; the ``DataGrid`` only
 * touches rows through the column accessors.
 */
import { useMemo, useState, useCallback, useEffect } from 'react';
import { FixedSizeList, type ListChildComponentProps } from 'react-window';
import { cn } from '@/lib/cn';
import { useHotkeys } from '@/lib/useHotkeys';

const VIRTUALIZE_THRESHOLD = 50;
const ROW_HEIGHT = 28;
const VIRTUAL_VIEWPORT_HEIGHT = 480;

export type SortDirection = 'asc' | 'desc' | 'none';

export interface SortState {
  column: string | null;
  direction: SortDirection;
}

export interface ColumnConfig<Row = unknown> {
  /** Stable column key. Used as the React key and the sort-state cursor. */
  key: string;
  /** Header label rendered in the column heading. */
  label: string;
  /** Pure projection from the row to a sortable / displayable value. */
  accessor: (row: Row) => string | number | null;
  /** Numeric cells get monospace + right-aligned styling. */
  numeric?: boolean;
  /** Optional fixed pixel width (column flexes by default). */
  width?: number;
  /** Defaults to ``true``; pass ``false`` to lock the column out of sort. */
  sortable?: boolean;
}

export interface DataGridProps<Row = unknown> {
  columns: ReadonlyArray<ColumnConfig<Row>>;
  rows: ReadonlyArray<Row>;
  rowIdAccessor: (row: Row) => string;
  onRowClick?: (id: string) => void;
  selectedRowId?: string | null;
  emptyState?: React.ReactNode;
  className?: string;
  /** testid scope; child cells/rows/headers nest off this. */
  testId?: string;
}

/** Format a value for display. ``null``/``undefined``/``NaN`` → ``—``. */
function formatCell(value: string | number | null, numeric: boolean): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—';
    return numeric ? value.toFixed(3) : String(value);
  }
  return value === '' ? '—' : value;
}

function compareValues(
  a: string | number | null,
  b: string | number | null,
  direction: 'asc' | 'desc',
): number {
  // Push nulls / non-finite to the end regardless of direction.
  const aNull = a === null || a === undefined || (typeof a === 'number' && !Number.isFinite(a));
  const bNull = b === null || b === undefined || (typeof b === 'number' && !Number.isFinite(b));
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  let cmp: number;
  if (typeof a === 'number' && typeof b === 'number') {
    cmp = a - b;
  } else {
    cmp = String(a).localeCompare(String(b), undefined, { numeric: true });
  }
  return direction === 'asc' ? cmp : -cmp;
}

function nextSortState(current: SortState, columnKey: string): SortState {
  if (current.column !== columnKey) {
    return { column: columnKey, direction: 'asc' };
  }
  if (current.direction === 'none') return { column: columnKey, direction: 'asc' };
  if (current.direction === 'asc') return { column: columnKey, direction: 'desc' };
  return { column: null, direction: 'none' };
}

interface VirtualRowData<Row> {
  rows: ReadonlyArray<Row>;
  columns: ReadonlyArray<ColumnConfig<Row>>;
  rowIdAccessor: (row: Row) => string;
  onRowClick?: (id: string) => void;
  selectedRowId?: string | null;
  focusedRowIndex: number;
  testId?: string;
}

function VirtualRow<Row>({ index, style, data }: ListChildComponentProps<VirtualRowData<Row>>) {
  const row = data.rows[index];
  if (row === undefined) return null;
  const id = data.rowIdAccessor(row);
  const isSelected = data.selectedRowId === id;
  const isFocused = data.focusedRowIndex === index;
  return (
    <div
      role="row"
      style={style}
      data-testid={data.testId ? `${data.testId}-row-${id}` : undefined}
      data-selected={isSelected ? 'true' : 'false'}
      data-focused={isFocused ? 'true' : undefined}
      aria-selected={isSelected}
      onClick={data.onRowClick ? () => data.onRowClick?.(id) : undefined}
      className={cn(
        'border-border/60 flex items-center border-b text-xs',
        data.onRowClick ? 'cursor-pointer' : '',
        // Selected: 2px primary left-rail (IDE pattern) + tinted bg.
        // Reads at a glance even when the user is scanning long grids.
        isSelected
          ? 'bg-primary/[0.07] shadow-[inset_2px_0_0_0_var(--color-primary)]'
          : 'hover:bg-muted/50',
        isFocused && !isSelected ? 'bg-muted/30' : '',
      )}
    >
      {data.columns.map((col) => {
        const raw = col.accessor(row);
        const display = formatCell(raw, col.numeric === true);
        return (
          <div
            key={col.key}
            role="cell"
            style={col.width ? { width: col.width, flex: '0 0 auto' } : undefined}
            className={cn(
              'truncate px-2 py-1',
              col.numeric
                ? 'text-foreground text-right font-mono tabular-nums'
                : 'text-foreground font-mono',
              !col.width ? 'flex-1' : '',
            )}
          >
            {display}
          </div>
        );
      })}
    </div>
  );
}

export function DataGrid<Row>({
  columns,
  rows,
  rowIdAccessor,
  onRowClick,
  selectedRowId = null,
  emptyState,
  className,
  testId,
}: DataGridProps<Row>) {
  const [sort, setSort] = useState<SortState>({ column: null, direction: 'none' });
  // Keyboard-nav cursor. Separate from `selectedRowId` so the user can
  // scan rows without committing a selection; Enter writes the
  // selection. Tracked by index (rather than rowId) so a re-sort moves
  // the cursor to "the row at this position" rather than chasing a
  // particular row through sort flips.
  const [focusedRowIndex, setFocusedRowIndex] = useState<number>(0);

  const sortedRows = useMemo(() => {
    if (sort.column === null || sort.direction === 'none') return rows;
    const col = columns.find((c) => c.key === sort.column);
    if (!col) return rows;
    const direction = sort.direction;
    return [...rows].sort((a, b) => compareValues(col.accessor(a), col.accessor(b), direction));
  }, [rows, columns, sort]);

  // Clamp the cursor to the current row range. Without this, a row
  // count drop (case reload, filter narrowing) could leave the cursor
  // pointing past the end of the array.
  useEffect(() => {
    setFocusedRowIndex((prev) => {
      if (sortedRows.length === 0) return 0;
      if (prev >= sortedRows.length) return sortedRows.length - 1;
      return prev;
    });
  }, [sortedRows.length]);

  const onHeaderClick = useCallback((columnKey: string) => {
    setSort((prev) => nextSortState(prev, columnKey));
  }, []);

  // ---- keyboard nav ---------------------------------------------------
  // The hotkey ref returned below scopes each binding to the container
  // element (or its descendants). Mirrors the Phase 3 Unit 16
  // ``EIGParticipationTable`` pattern: the ref is attached to the
  // grid's outer div + ``tabIndex={0}`` makes the container focusable.
  // ``enabled`` is left to react-hotkeys-hook's element-scope check
  // (the ref attachment) — we never need to fire these arrows globally.
  const advanceFocus = useCallback(
    (delta: number) => {
      setFocusedRowIndex((prev) => {
        if (sortedRows.length === 0) return 0;
        const next = prev + delta;
        if (next < 0) return 0;
        if (next >= sortedRows.length) return sortedRows.length - 1;
        return next;
      });
    },
    [sortedRows.length],
  );

  const arrowDownRef = useHotkeys<HTMLDivElement>(
    'down',
    (e) => {
      e.preventDefault();
      advanceFocus(1);
    },
    {},
    [advanceFocus],
  );

  const arrowUpRef = useHotkeys<HTMLDivElement>(
    'up',
    (e) => {
      e.preventDefault();
      advanceFocus(-1);
    },
    {},
    [advanceFocus],
  );

  const homeRef = useHotkeys<HTMLDivElement>(
    'home',
    (e) => {
      e.preventDefault();
      setFocusedRowIndex(0);
    },
    {},
    [],
  );

  const endRef = useHotkeys<HTMLDivElement>(
    'end',
    (e) => {
      e.preventDefault();
      if (sortedRows.length > 0) setFocusedRowIndex(sortedRows.length - 1);
    },
    {},
    [sortedRows.length],
  );

  const enterRef = useHotkeys<HTMLDivElement>(
    'enter',
    (e) => {
      e.preventDefault();
      if (sortedRows.length === 0 || !onRowClick) return;
      const row = sortedRows[focusedRowIndex];
      if (row === undefined) return;
      onRowClick(rowIdAccessor(row));
    },
    {},
    [sortedRows, focusedRowIndex, onRowClick, rowIdAccessor],
  );

  // Combine the per-binding refs into one ref callback so the container
  // gets all five attachments. Each ``useHotkeys`` call returns its own
  // ref; merging here keeps the JSX clean.
  const containerRefCallback = useCallback(
    (el: HTMLDivElement | null) => {
      arrowDownRef(el);
      arrowUpRef(el);
      homeRef(el);
      endRef(el);
      enterRef(el);
    },
    [arrowDownRef, arrowUpRef, homeRef, endRef, enterRef],
  );

  if (rows.length === 0) {
    return (
      <div
        data-testid={testId}
        ref={containerRefCallback}
        tabIndex={0}
        className={cn(
          'flex min-h-0 flex-1 flex-col overflow-hidden',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          className,
        )}
      >
        <Header columns={columns} sort={sort} onHeaderClick={onHeaderClick} testId={testId} />
        <div
          data-testid={testId ? `${testId}-empty` : undefined}
          className="text-muted-foreground flex flex-1 items-center justify-center p-3 text-xs"
        >
          {emptyState ?? 'No rows.'}
        </div>
      </div>
    );
  }

  const useVirtualization = sortedRows.length > VIRTUALIZE_THRESHOLD;

  return (
    <div
      data-testid={testId}
      ref={containerRefCallback}
      tabIndex={0}
      className={cn(
        'flex min-h-0 flex-1 flex-col overflow-hidden',
        'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        className,
      )}
    >
      <Header columns={columns} sort={sort} onHeaderClick={onHeaderClick} testId={testId} />
      {useVirtualization ? (
        <div data-testid={testId ? `${testId}-virtual` : undefined} className="min-h-0 flex-1">
          <FixedSizeList<VirtualRowData<Row>>
            height={Math.min(VIRTUAL_VIEWPORT_HEIGHT, sortedRows.length * ROW_HEIGHT)}
            itemCount={sortedRows.length}
            itemSize={ROW_HEIGHT}
            width="100%"
            itemData={{
              rows: sortedRows,
              columns,
              rowIdAccessor,
              onRowClick,
              selectedRowId,
              focusedRowIndex,
              testId,
            }}
            overscanCount={4}
          >
            {VirtualRow}
          </FixedSizeList>
        </div>
      ) : (
        <div role="rowgroup" className="min-h-0 flex-1 overflow-auto">
          {sortedRows.map((row, index) => {
            const id = rowIdAccessor(row);
            const isSelected = selectedRowId === id;
            const isFocused = focusedRowIndex === index;
            return (
              <div
                key={id}
                role="row"
                data-testid={testId ? `${testId}-row-${id}` : undefined}
                data-selected={isSelected ? 'true' : 'false'}
                data-focused={isFocused ? 'true' : undefined}
                aria-selected={isSelected}
                onClick={onRowClick ? () => onRowClick(id) : undefined}
                className={cn(
                  'border-border/60 flex items-center border-b text-xs',
                  onRowClick ? 'cursor-pointer' : '',
                  isSelected
                    ? 'bg-primary/[0.07] shadow-[inset_2px_0_0_0_var(--color-primary)]'
                    : 'hover:bg-muted/50',
                  isFocused && !isSelected ? 'bg-muted/30' : '',
                )}
                style={{ height: ROW_HEIGHT }}
              >
                {columns.map((col) => {
                  const raw = col.accessor(row);
                  const display = formatCell(raw, col.numeric === true);
                  return (
                    <div
                      key={col.key}
                      role="cell"
                      style={col.width ? { width: col.width, flex: '0 0 auto' } : undefined}
                      className={cn(
                        'truncate px-2 py-1',
                        col.numeric
                          ? 'text-foreground text-right font-mono tabular-nums'
                          : 'text-foreground font-mono',
                        !col.width ? 'flex-1' : '',
                      )}
                    >
                      {display}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface HeaderProps<Row> {
  columns: ReadonlyArray<ColumnConfig<Row>>;
  sort: SortState;
  onHeaderClick: (columnKey: string) => void;
  testId?: string;
}

function Header<Row>({ columns, sort, onHeaderClick, testId }: HeaderProps<Row>) {
  return (
    <div
      role="row"
      className={cn(
        'border-border bg-muted/40 text-muted-foreground sticky top-0 z-10',
        'flex items-center border-b text-[11px] font-medium',
      )}
    >
      {columns.map((col) => {
        const sortable = col.sortable !== false;
        const active = sort.column === col.key && sort.direction !== 'none';
        // Inactive: subtle dotted dash (•) so the header doesn't look
        // crowded at small sizes. Active: bold up/down arrow.
        const glyph = !active ? '·' : sort.direction === 'asc' ? '▲' : '▼';
        const aria =
          active && sort.direction === 'asc'
            ? 'ascending'
            : active && sort.direction === 'desc'
              ? 'descending'
              : 'none';
        return (
          <div
            key={col.key}
            role="columnheader"
            aria-sort={aria}
            style={col.width ? { width: col.width, flex: '0 0 auto' } : undefined}
            className={cn(
              'px-2 py-1 select-none',
              col.numeric ? 'text-right' : 'text-left',
              !col.width ? 'flex-1' : '',
            )}
          >
            {sortable ? (
              <button
                type="button"
                onClick={() => onHeaderClick(col.key)}
                data-testid={testId ? `${testId}-header-${col.key}` : undefined}
                className={cn(
                  'inline-flex w-full items-center gap-1',
                  col.numeric ? 'justify-end' : 'justify-start',
                  'hover:text-foreground',
                  'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
                )}
              >
                <span className="font-mono">{col.label}</span>
                <span
                  aria-hidden
                  className={cn(
                    active
                      ? 'text-primary text-[8px] font-bold'
                      : 'text-muted-foreground/50 text-[12px] leading-none',
                  )}
                >
                  {glyph}
                </span>
              </button>
            ) : (
              <span className="font-mono">{col.label}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
