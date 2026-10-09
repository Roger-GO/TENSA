/**
 * DataGrid (v3 Unit 12).
 *
 * Generic sortable + virtualizable data grid backing the BottomDrawer's
 * per-bucket tabs (Buses / Lines / Generators / Loads / Shunts, the dynamic
 * model tables) in Unit 13.
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
 * With ``exportPanel`` set the grid shows an Export menu (CSV) above its
 * header. The file is the grid as it reads: the rows that pass the filter in
 * their current sort order, one column per column, the cell values at full
 * precision. The bar sits outside the element that owns the arrow-key bindings,
 * so Enter on the menu's button activates the button and does not select the
 * focused row. A ``hint`` puts a line of guidance at the bar's left (what to do
 * with a row, say), and gives the bar to a grid that has no export.
 *
 * ``filterable`` adds a filter box to the bar: a row stays while every word
 * typed is found in one of its cells. ``copyable`` adds a cell cursor (click a
 * cell, or move with the arrow keys; Shift extends it to a block), Ctrl+C
 * copying the block as the tab-separated text spreadsheets paste, and a Copy
 * button for the whole table with its headings.
 *
 * ``editing`` makes the cells with a ``ColumnConfig.edit`` changeable: double-click
 * a cell (or press F2 on it), type, and Enter or leaving the cell writes it, Esc
 * drops it, Tab writes it and moves to the next changeable cell of the row. Ctrl+V
 * pastes a block copied from a spreadsheet from the cursor cell (one value over a
 * selected block fills it). The grid knows nothing of where a value goes: it hands
 * the numbers to ``editing.commit`` and shows what ``editing`` says back (the cells
 * still being written, the failure, the line of guidance, and what unlocks a table
 * that is locked).
 *
 * The grid is a `table` named by `ariaLabel` (`Lines`), so a screen reader or a
 * test driver finds it by name and reads its header row and rows as a table.
 *
 * Generic over the row shape: callers pass ``columns`` (with per-column
 * ``accessor`` / ``numeric`` / ``sortable`` flags) and a ``rowIdAccessor``
 * that produces the stable string id used for selection-sync. The
 * generic ``Row`` type is intentionally ``unknown`` at this layer so
 * each per-bucket grid keeps its own row shape; the ``DataGrid`` only
 * touches rows through the column accessors.
 */
import {
  useMemo,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { FixedSizeList, type ListChildComponentProps } from 'react-window';
import { clamp } from '@/lib/clamp';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';
import { isEditableTarget, useHotkeys } from '@/lib/useHotkeys';
import { Button } from '@/components/ui/button';
import { ClampedText } from '@/components/ui/ClampedText';
import { Input } from '@/components/ui/Input';
import { ExportMenu } from '@/components/export/ExportMenu';
import { recordsToCsv } from '@/components/export/exportToCsv';
import { useExportCaseName } from '@/components/export/useExportCaseName';
import {
  cellKey,
  cellText,
  filterTerms,
  formatCellValue,
  parseCellNumber,
  parseTsv,
  planPaste,
  rangeBetween,
  rangeContains,
  rowMatches,
  toTsv,
  type CellPosition,
  type CellRange,
} from './gridCells';

const VIRTUALIZE_THRESHOLD = 50;
const NO_PENDING: ReadonlySet<string> = new Set();
const ROW_HEIGHT = 28;
const VIRTUAL_VIEWPORT_HEIGHT = 480;

export type SortDirection = 'asc' | 'desc' | 'none';

export interface SortState {
  column: string | null;
  direction: SortDirection;
}

/** What a cell of a changeable column writes. */
export interface ColumnEdit<Row = unknown> {
  /** The ANDES parameter the cell sets. */
  param: string;
  /**
   * Turns the number typed in the cell, in the unit the column shows, into the
   * parameter's own value (a bus limit shown in kV back to per unit). The value
   * written is the number as typed when this is not set.
   */
  toParam?: (shown: number, row: Row) => number;
}

export interface ColumnConfig<Row = unknown> {
  /** Stable column key. Used as the React key and the sort-state cursor. */
  key: string;
  /** Header label rendered in the column heading. */
  label: string;
  /** Hover text for the heading, for a column whose values need a word of context. */
  title?: string;
  /** Pure projection from the row to a sortable / displayable value. */
  accessor: (row: Row) => string | number | null;
  /** Numeric cells get monospace + right-aligned styling. */
  numeric?: boolean;
  /** Optional fixed pixel width (column flexes by default). */
  width?: number;
  /**
   * The narrowest the column gets: it grows to share the width left over, and the
   * table scrolls sideways before the column goes below this. For a table with more
   * columns than a narrow panel holds, so no heading is cut.
   */
  minWidth?: number;
  /** Defaults to ``true``; pass ``false`` to lock the column out of sort. */
  sortable?: boolean;
  /** How the cell reads, in place of three decimals for a number: a parameter that is small. */
  format?: (value: string | number | null) => string;
  /** Set on a column whose cells can be changed (see ``DataGridProps.editing``). */
  edit?: ColumnEdit<Row>;
}

/** One value to write: the cell it was typed or pasted into, and the number for the parameter. */
export interface CellEdit<Row = unknown> {
  rowId: string;
  row: Row;
  column: ColumnConfig<Row>;
  value: number;
}

/** What a batch of edits came to. */
export interface CommitResult {
  /** Values written before the batch ended. */
  applied: number;
  /** True when one was refused, which ended the batch. */
  failed: boolean;
}

/**
 * What the grid needs to let its cells be changed, and what it shows of the
 * change. A hook such as ``useGridEditing`` builds it; a test can hand one in.
 */
export interface GridEditing<Row = unknown> {
  /** Whether this cell can be changed now: it has an ``edit``, and the case is open to it. */
  canEdit: (row: Row, column: ColumnConfig<Row>) => boolean;
  /** Writes the values, in order, and resolves once they are in or one is refused. */
  commit: (edits: ReadonlyArray<CellEdit<Row>>) => Promise<CommitResult>;
  /**
   * Says that a value typed into a cell is in, once it is. A paste the grid
   * announces itself, with its counts.
   */
  confirmTyped?: (edit: CellEdit<Row>) => void;
  /** The cells being written, as ``cellKey(rowId, columnKey)``. */
  pending: ReadonlySet<string>;
  /** Why the last write was refused, until it is dismissed. */
  error: string | null;
  dismissError: () => void;
  /** Why no cell can be changed at all right now; `null` when some can. */
  lockedReason: string | null;
  /** What to say above the table, when the grid has no ``hint`` of its own. */
  hint?: string;
  /** Goes at the bar's right: the way to unlock a locked table, or the switch that decides how it is written. */
  barExtra?: ReactNode;
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
  /** Accessible name of the table (`Lines`), for assistive tech and role queries. */
  ariaLabel?: string;
  /**
   * Panel slug for the exported file's name (`buses`, `lines`). Setting it
   * adds the Export menu above the header; without it the grid has none.
   */
  exportPanel?: string;
  /**
   * One line of guidance shown above the header, at the left of the Export
   * menu, for what a first-time user would not guess from the table alone.
   */
  hint?: string;
  /** Adds the filter box above the header. */
  filterable?: boolean;
  /** Adds the cell cursor, Ctrl+C on a block of cells, and the Copy button. */
  copyable?: boolean;
  /** Makes the cells of columns with an ``edit`` changeable; implies the cell cursor. */
  editing?: GridEditing<Row>;
}

/** A cell as it reads: the column's own format when it has one. */
function displayOf<Row>(col: ColumnConfig<Row>, raw: string | number | null): string {
  return col.format ? col.format(raw) : formatCellValue(raw, col.numeric === true);
}

/** The width a column takes: fixed, or from its minimum up, or its share of what is left. */
function columnStyle<Row>(col: ColumnConfig<Row>): CSSProperties | undefined {
  if (col.width) return { width: col.width, flex: '0 0 auto' };
  if (col.minWidth) return { flex: `1 1 ${col.minWidth}px`, minWidth: col.minWidth };
  return undefined;
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

/** The cell being typed into. */
interface EditorState {
  rowId: string;
  colKey: string;
  draft: string;
  /** The text the cell started from, so a draft left as it was writes nothing. */
  original: string;
}

/** What the rows need to draw the cell cursor and the editor; `null` for a grid without cells. */
interface CellView<Row> {
  active: boolean;
  cursor: CellPosition;
  range: CellRange | null;
  editor: EditorState | null;
  pending: ReadonlySet<string>;
  canEdit: (row: Row, col: ColumnConfig<Row>) => boolean;
  onCellClick: (rowIndex: number, colIndex: number, extend: boolean) => void;
  onCellDoubleClick: (rowIndex: number, colIndex: number) => void;
  onDraftChange: (draft: string) => void;
  onEditorKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  onEditorBlur: () => void;
}

interface RowShared<Row> {
  columns: ReadonlyArray<ColumnConfig<Row>>;
  rowIdAccessor: (row: Row) => string;
  onRowClick?: (id: string) => void;
  selectedRowId?: string | null;
  focusedRowIndex: number;
  testId?: string;
  cells: CellView<Row> | null;
}

interface VirtualRowData<Row> {
  rows: ReadonlyArray<Row>;
  shared: RowShared<Row>;
}

/** Puts the cursor in a cell editor as it opens, with its text selected to type over. */
function focusEditor(el: HTMLInputElement | null) {
  if (el) {
    el.focus();
    el.select();
  }
}

interface GridRowProps<Row> {
  row: Row;
  index: number;
  style: CSSProperties;
  shared: RowShared<Row>;
}

/** One row, drawn the same whether the list is virtualized or not. */
function GridRow<Row>({ row, index, style, shared }: GridRowProps<Row>) {
  const { columns, rowIdAccessor, onRowClick, selectedRowId, focusedRowIndex, testId, cells } =
    shared;
  const id = rowIdAccessor(row);
  const isSelected = selectedRowId === id;
  const isFocused = focusedRowIndex === index;
  return (
    <div
      role="row"
      style={style}
      data-testid={testId ? `${testId}-row-${id}` : undefined}
      data-selected={isSelected ? 'true' : 'false'}
      data-focused={isFocused ? 'true' : undefined}
      aria-selected={isSelected}
      // A Shift-click extends the block of cells and leaves the selected row be.
      onClick={
        onRowClick
          ? (e) => {
              if (cells !== null && e.shiftKey) return;
              onRowClick(id);
            }
          : undefined
      }
      className={cn(
        'border-border/60 flex items-center border-b text-xs',
        onRowClick ? 'cursor-pointer' : '',
        // Selected: 2px primary left-rail (IDE pattern) + tinted bg.
        // Reads at a glance even when the user is scanning long grids.
        isSelected
          ? 'bg-primary/[0.07] shadow-[inset_2px_0_0_0_var(--color-primary)]'
          : 'hover:bg-muted/50',
        isFocused && !isSelected ? 'bg-muted/30' : '',
      )}
    >
      {columns.map((col, c) => {
        const display = displayOf(col, col.accessor(row));
        const isEditing = cells?.editor?.rowId === id && cells.editor.colKey === col.key;
        const editable = cells !== null && cells.canEdit(row, col);
        const isCursor =
          cells !== null && cells.active && cells.cursor.row === index && cells.cursor.col === c;
        const inRange =
          cells !== null &&
          cells.active &&
          cells.range !== null &&
          rangeContains(cells.range, index, c);
        const isPending = cells?.pending.has(cellKey(id, col.key)) === true;
        return (
          <div
            key={col.key}
            role="cell"
            data-testid={testId ? `${testId}-cell-${id}-${col.key}` : undefined}
            data-editable={editable ? 'true' : undefined}
            data-active-cell={isCursor ? 'true' : undefined}
            data-in-range={inRange ? 'true' : undefined}
            data-pending={isPending ? 'true' : undefined}
            style={columnStyle(col)}
            onClick={cells ? (e) => cells.onCellClick(index, c, e.shiftKey) : undefined}
            onDoubleClick={editable ? () => cells?.onCellDoubleClick(index, c) : undefined}
            className={cn(
              'truncate px-2 py-1',
              col.numeric
                ? 'text-foreground text-right font-mono tabular-nums'
                : 'text-foreground font-mono',
              !col.width && !col.minWidth ? 'flex-1' : '',
              editable ? 'cursor-text' : '',
              inRange ? 'bg-primary/10' : '',
              isCursor ? 'shadow-[inset_0_0_0_2px_var(--color-primary)]' : '',
              isPending ? 'opacity-50' : '',
            )}
          >
            {isEditing && cells?.editor ? (
              <Input
                ref={focusEditor}
                value={cells.editor.draft}
                onChange={cells.onDraftChange}
                onKeyDown={cells.onEditorKeyDown}
                onBlur={cells.onEditorBlur}
                inputMode="decimal"
                aria-label={`${col.label} of ${id}`}
                data-testid={testId ? `${testId}-editor` : undefined}
                className="h-5 w-full px-1 py-0 text-right font-mono text-xs"
              />
            ) : (
              display
            )}
          </div>
        );
      })}
    </div>
  );
}

function VirtualRow<Row>({ index, style, data }: ListChildComponentProps<VirtualRowData<Row>>) {
  const row = data.rows[index];
  if (row === undefined) return null;
  return <GridRow row={row} index={index} style={style} shared={data.shared} />;
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
  ariaLabel,
  exportPanel,
  hint,
  filterable = false,
  copyable = false,
  editing,
}: DataGridProps<Row>) {
  const [sort, setSort] = useState<SortState>({ column: null, direction: 'none' });
  const [query, setQuery] = useState('');
  // Keyboard-nav cursor. Separate from `selectedRowId` so the user can
  // scan rows without committing a selection; Enter writes the
  // selection. Tracked by index (rather than rowId) so a re-sort moves
  // the cursor to "the row at this position" rather than chasing a
  // particular row through sort flips.
  const [focusedRowIndex, setFocusedRowIndex] = useState<number>(0);
  // The cell cursor's column, the far corner of a block of cells (`anchor` is
  // the near one, null for the cursor cell alone), and whether the cursor has
  // been put anywhere yet: until it has, there is no cell to draw or to copy.
  const [focusedColIndex, setFocusedColIndex] = useState<number>(0);
  const [anchor, setAnchor] = useState<CellPosition | null>(null);
  const [cursorActive, setCursorActive] = useState(false);
  const [editor, setEditorState] = useState<EditorState | null>(null);
  // The editor is also kept in a ref: a blur that follows the Enter or Esc that
  // closed it must find it gone, and state would still hold it until the render.
  const editorRef = useRef<EditorState | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const containerEl = useRef<HTMLDivElement | null>(null);

  const cellsEnabled = copyable || editing !== undefined;

  const setEditor = useCallback((next: EditorState | null) => {
    editorRef.current = next;
    setEditorState(next);
  }, []);

  const terms = useMemo(() => filterTerms(query), [query]);

  const filteredRows = useMemo(() => {
    if (terms.length === 0) return rows;
    return rows.filter((row) =>
      rowMatches(
        columns.flatMap((col) => {
          const raw = col.accessor(row);
          return [cellText(raw), displayOf(col, raw)];
        }),
        terms,
      ),
    );
  }, [rows, columns, terms]);

  const sortedRows = useMemo(() => {
    if (sort.column === null || sort.direction === 'none') return filteredRows;
    const col = columns.find((c) => c.key === sort.column);
    if (!col) return filteredRows;
    const direction = sort.direction;
    return [...filteredRows].sort((a, b) =>
      compareValues(col.accessor(a), col.accessor(b), direction),
    );
  }, [filteredRows, columns, sort]);

  // CSV export: the rows in the order shown, the column labels as headers.
  const caseName = useExportCaseName();
  const onExportCsv = useCallback(
    () =>
      sortedRows.length === 0
        ? null
        : recordsToCsv({
            columns: columns.map((c) => c.label),
            rows: sortedRows.map((row) => columns.map((c) => c.accessor(row))),
          }),
    [sortedRows, columns],
  );

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

  useEffect(() => {
    setFocusedColIndex((prev) => clamp(prev, 0, Math.max(columns.length - 1, 0)));
  }, [columns.length]);

  const onHeaderClick = useCallback((columnKey: string) => {
    setSort((prev) => nextSortState(prev, columnKey));
  }, []);

  /** The block of cells selected, or `null` before the cursor has been put anywhere. */
  const currentRange = useCallback((): CellRange | null => {
    if (!cellsEnabled || !cursorActive || sortedRows.length === 0) return null;
    const lastRow = sortedRows.length - 1;
    const lastCol = Math.max(columns.length - 1, 0);
    const from = anchor ?? { row: focusedRowIndex, col: focusedColIndex };
    return rangeBetween(
      { row: clamp(from.row, 0, lastRow), col: clamp(from.col, 0, lastCol) },
      { row: focusedRowIndex, col: focusedColIndex },
    );
  }, [
    cellsEnabled,
    cursorActive,
    sortedRows.length,
    columns.length,
    anchor,
    focusedRowIndex,
    focusedColIndex,
  ]);

  // ---- keyboard nav ---------------------------------------------------
  // The hotkey ref returned below scopes each binding to the container
  // element (or its descendants). Mirrors the Phase 3 Unit 16
  // ``EIGParticipationTable`` pattern: the ref is attached to the
  // grid's outer div + ``tabIndex={0}`` makes the container focusable.
  // ``enabled`` is left to react-hotkeys-hook's element-scope check
  // (the ref attachment) — we never need to fire these arrows globally.
  const advanceFocus = useCallback(
    (delta: number) => {
      setAnchor(null);
      if (cellsEnabled) setCursorActive(true);
      setFocusedRowIndex((prev) => {
        if (sortedRows.length === 0) return 0;
        const next = prev + delta;
        if (next < 0) return 0;
        if (next >= sortedRows.length) return sortedRows.length - 1;
        return next;
      });
    },
    [sortedRows.length, cellsEnabled],
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
      setAnchor(null);
      if (cellsEnabled) setCursorActive(true);
      setFocusedRowIndex(0);
    },
    {},
    [cellsEnabled],
  );

  const endRef = useHotkeys<HTMLDivElement>(
    'end',
    (e) => {
      e.preventDefault();
      setAnchor(null);
      if (cellsEnabled) setCursorActive(true);
      if (sortedRows.length > 0) setFocusedRowIndex(sortedRows.length - 1);
    },
    {},
    [sortedRows.length, cellsEnabled],
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
      containerEl.current = el;
      arrowDownRef(el);
      arrowUpRef(el);
      homeRef(el);
      endRef(el);
      enterRef(el);
    },
    [arrowDownRef, arrowUpRef, homeRef, endRef, enterRef],
  );

  // ---- cells: cursor, block, edit, copy, paste ------------------------------

  const moveCursor = (dRow: number, dCol: number, extend: boolean) => {
    if (sortedRows.length === 0) return;
    if (extend) {
      if (anchor === null) setAnchor({ row: focusedRowIndex, col: focusedColIndex });
    } else {
      setAnchor(null);
    }
    setFocusedRowIndex(clamp(focusedRowIndex + dRow, 0, sortedRows.length - 1));
    setFocusedColIndex(clamp(focusedColIndex + dCol, 0, columns.length - 1));
    setCursorActive(true);
  };

  const onCellClick = (rowIndex: number, colIndex: number, extend: boolean) => {
    if (extend && cursorActive) {
      if (anchor === null) setAnchor({ row: focusedRowIndex, col: focusedColIndex });
    } else {
      setAnchor(null);
    }
    setFocusedRowIndex(rowIndex);
    setFocusedColIndex(colIndex);
    setCursorActive(true);
  };

  const startEdit = (rowIndex: number, colIndex: number) => {
    const row = sortedRows[rowIndex];
    const col = columns[colIndex];
    if (row === undefined || col === undefined || !editing || !editing.canEdit(row, col)) return;
    const original = cellText(col.accessor(row));
    setFocusedRowIndex(rowIndex);
    setFocusedColIndex(colIndex);
    setAnchor(null);
    setCursorActive(true);
    setLocalError(null);
    setEditor({ rowId: rowIdAccessor(row), colKey: col.key, draft: original, original });
  };

  /**
   * Writes the editor's text and closes it. `move` carries Tab on to the next
   * changeable cell of the row. Text that is no number leaves the editor open
   * with the reason, rather than lose what was typed.
   */
  const submitEditor = (move: -1 | 0 | 1) => {
    const ed = editorRef.current;
    if (ed === null || !editing) return;
    const rowIndex = sortedRows.findIndex((r) => rowIdAccessor(r) === ed.rowId);
    const colIndex = columns.findIndex((c) => c.key === ed.colKey);
    const row = sortedRows[rowIndex];
    const col = columns[colIndex];
    if (row === undefined || col === undefined) {
      setEditor(null);
      return;
    }
    const text = ed.draft.trim();
    if (text !== '' && text !== ed.original) {
      const shown = parseCellNumber(text);
      if (shown === null) {
        setLocalError(`${col.label} takes a number, and "${text}" is not one.`);
        return;
      }
      const value = col.edit?.toParam ? col.edit.toParam(shown, row) : shown;
      const typed: CellEdit<Row> = { rowId: ed.rowId, row, column: col, value };
      void editing.commit([typed]).then((result) => {
        if (!result.failed) editing.confirmTyped?.(typed);
      });
    }
    setLocalError(null);
    setEditor(null);
    if (move !== 0) {
      for (let c = colIndex + move; c >= 0 && c < columns.length; c += move) {
        const next = columns[c];
        if (next !== undefined && editing.canEdit(row, next)) {
          startEdit(rowIndex, c);
          return;
        }
      }
    }
    containerEl.current?.focus();
  };

  const onEditorKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitEditor(0);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setLocalError(null);
      setEditor(null);
      containerEl.current?.focus();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      submitEditor(e.shiftKey ? -1 : 1);
    }
  };

  const onEditorBlur = () => {
    if (editorRef.current !== null) submitEditor(0);
  };

  const onDraftChange = (draft: string) => {
    const ed = editorRef.current;
    if (ed !== null) setEditor({ ...ed, draft });
  };

  const onGridKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!cellsEnabled || isEditableTarget(e.target as Element)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      moveCursor(0, e.key === 'ArrowRight' ? 1 : -1, e.shiftKey);
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.shiftKey) {
      // Plain up and down are the row bindings above; Shift extends the block.
      e.preventDefault();
      moveCursor(e.key === 'ArrowDown' ? 1 : -1, 0, true);
    } else if (e.key === 'F2') {
      e.preventDefault();
      if (cursorActive) startEdit(focusedRowIndex, focusedColIndex);
    } else if (e.key === 'Escape') {
      if (anchor !== null) setAnchor(null);
      else setCursorActive(false);
    } else if (mod && (e.key === 'a' || e.key === 'A') && sortedRows.length > 0) {
      e.preventDefault();
      setAnchor({ row: 0, col: 0 });
      setFocusedRowIndex(sortedRows.length - 1);
      setFocusedColIndex(columns.length - 1);
      setCursorActive(true);
    }
  };

  const onCopy = (e: ClipboardEvent<HTMLDivElement>) => {
    if (!cellsEnabled || isEditableTarget(e.target as Element)) return;
    const range = currentRange();
    if (range === null) return;
    const matrix: string[][] = [];
    for (let r = range.row0; r <= range.row1; r++) {
      const row = sortedRows[r];
      if (row === undefined) continue;
      matrix.push(
        columns.slice(range.col0, range.col1 + 1).map((col) => cellText(col.accessor(row))),
      );
    }
    e.clipboardData.setData('text/plain', toTsv(matrix));
    e.preventDefault();
  };

  const pasteText = async (text: string) => {
    if (!editing) return;
    const matrix = parseTsv(text);
    if (matrix.length === 0) return;
    if (!cursorActive || sortedRows.length === 0) {
      toast.info('Click the cell to paste into, then paste.');
      return;
    }
    const plan = planPaste({
      matrix,
      start: { row: focusedRowIndex, col: focusedColIndex },
      range: currentRange(),
      rows: sortedRows,
      columns,
      rowIdAccessor,
      canEdit: editing.canEdit,
    });
    if (plan.invalid !== null) {
      setLocalError(
        `${plan.invalid.label} of ${plan.invalid.rowId} takes a number, and "${plan.invalid.text}" is not one. Nothing was pasted.`,
      );
      return;
    }
    if (plan.edits.length === 0) {
      toast.info(
        editing.lockedReason !== null
          ? `Nothing was pasted. ${editing.lockedReason}`
          : plan.readOnly > 0
            ? 'Nothing was pasted: the cells there cannot be changed.'
            : 'Nothing to paste.',
      );
      return;
    }
    setLocalError(null);
    const result = await editing.commit(plan.edits);
    if (result.failed) return;
    const n = plan.edits.length;
    toast.success(
      [
        `Pasted ${n} value${n === 1 ? '' : 's'}.`,
        plan.readOnly > 0
          ? `${plan.readOnly} cell${plan.readOnly === 1 ? '' : 's'} that cannot be changed ${plan.readOnly === 1 ? 'was' : 'were'} left as ${plan.readOnly === 1 ? 'it was' : 'they were'}.`
          : '',
        plan.clipped > 0
          ? `${plan.clipped} value${plan.clipped === 1 ? '' : 's'} fell past the end of the table.`
          : '',
      ]
        .filter((part) => part !== '')
        .join(' '),
    );
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (!editing || isEditableTarget(e.target as Element)) return;
    e.preventDefault();
    void pasteText(e.clipboardData.getData('text/plain'));
  };

  /** The table as the clipboard takes it: the rows on screen with their headings. */
  const copyTable = async () => {
    const text = toTsv([
      columns.map((col) => col.label),
      ...sortedRows.map((row) => columns.map((col) => cellText(col.accessor(row)))),
    ]);
    try {
      await navigator.clipboard.writeText(text);
      const n = sortedRows.length;
      toast.success(`Copied ${n} row${n === 1 ? '' : 's'}, with the column headings.`);
    } catch {
      toast.error('The browser did not let the table be copied.');
    }
  };

  const cells: CellView<Row> | null = cellsEnabled
    ? {
        active: cursorActive,
        cursor: { row: focusedRowIndex, col: focusedColIndex },
        range: currentRange(),
        editor,
        pending: editing?.pending ?? NO_PENDING,
        canEdit: editing ? editing.canEdit : () => false,
        onCellClick,
        onCellDoubleClick: startEdit,
        onDraftChange,
        onEditorKeyDown,
        onEditorBlur,
      }
    : null;

  const shared: RowShared<Row> = {
    columns,
    rowIdAccessor,
    onRowClick,
    selectedRowId,
    focusedRowIndex,
    testId,
    cells,
  };

  // What to do with the cells means nothing in a table with no rows.
  const hintText = hint ?? (rows.length > 0 ? editing?.hint : undefined);
  const showFilter = filterable && rows.length > 0;
  const showBar =
    exportPanel !== undefined ||
    hintText !== undefined ||
    showFilter ||
    copyable ||
    editing !== undefined;
  const message = localError ?? editing?.error ?? null;

  // The bar goes beside the keyboard-scoped grid element, not inside it (see
  // the header note), so each return below wraps the grid in `withExportBar`.
  const withExportBar = (grid: React.ReactElement) =>
    !showBar ? (
      grid
    ) : (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-border bg-muted/20 flex shrink-0 items-center gap-2 border-b px-1">
          {showFilter ? (
            <div className="flex shrink-0 items-center gap-1">
              <Input
                type="text"
                value={query}
                onChange={setQuery}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && query !== '') {
                    e.preventDefault();
                    setQuery('');
                  }
                }}
                placeholder="Filter rows"
                aria-label="Filter rows"
                data-testid={testId ? `${testId}-filter` : undefined}
                className="my-0.5 h-6 w-36 px-1.5 py-0 text-xs"
              />
              {query !== '' ? (
                <>
                  <span
                    data-testid={testId ? `${testId}-filter-count` : undefined}
                    className="text-muted-foreground text-[11px] whitespace-nowrap"
                  >
                    {sortedRows.length} of {rows.length}
                  </span>
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    aria-label="Clear the filter"
                    data-testid={testId ? `${testId}-filter-clear` : undefined}
                    className="text-muted-foreground hover:text-foreground rounded px-1 text-xs focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none"
                  >
                    ×
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
          {hintText !== undefined ? (
            // One line, with the rest of a hint that does not fit behind More.
            <ClampedText
              testId={testId ? `${testId}-hint` : undefined}
              text={hintText}
              moreLabel="Show the whole note"
              rowClassName="items-center"
              className="text-muted-foreground truncate px-1 text-[11px]"
            />
          ) : (
            <span className="flex-1" />
          )}
          {editing?.barExtra}
          {copyable || editing !== undefined ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={sortedRows.length === 0}
              onClick={() => void copyTable()}
              title="Copy the table as it reads, with its filter and sort and its column headings, ready to paste into a spreadsheet"
              data-testid={testId ? `${testId}-copy` : undefined}
              className="h-6 px-2"
            >
              Copy
            </Button>
          ) : null}
          {exportPanel !== undefined ? (
            <ExportMenu
              formats={['csv']}
              disabled={sortedRows.length === 0}
              disabledTooltip="No rows to export"
              panel={exportPanel}
              caseName={caseName}
              onExportCsv={onExportCsv}
              className="h-6 px-2"
            />
          ) : null}
        </div>
        {message !== null ? (
          <div
            role="alert"
            data-testid={testId ? `${testId}-edit-error` : undefined}
            className="border-danger/30 bg-danger/10 text-danger flex shrink-0 items-start gap-2 border-b px-2 py-1 text-xs"
          >
            <span className="min-w-0 flex-1">{message}</span>
            <button
              type="button"
              onClick={() => {
                setLocalError(null);
                editing?.dismissError();
              }}
              aria-label="Dismiss"
              className="hover:text-foreground rounded px-1 focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none"
            >
              ×
            </button>
          </div>
        ) : null}
        {grid}
      </div>
    );

  // A table whose columns all have a width (or a least width) is as wide as they
  // add up to at the least, and scrolls sideways in a narrower panel; the rest
  // share the width there is.
  const columnsWidth =
    columns.length > 0 && columns.every((col) => (col.width ?? col.minWidth) !== undefined)
      ? columns.reduce((sum, col) => sum + (col.width ?? col.minWidth ?? 0), 0)
      : undefined;

  const frame = (body: React.ReactNode) => (
    <div
      data-testid={testId}
      role="table"
      aria-label={ariaLabel}
      ref={containerRefCallback}
      tabIndex={0}
      onKeyDown={cellsEnabled ? onGridKeyDown : undefined}
      onCopy={cellsEnabled ? onCopy : undefined}
      onPaste={editing ? onPaste : undefined}
      className={cn(
        'flex min-h-0 flex-1 flex-col',
        // A table as wide as its columns scrolls as one in the container, the
        // heading row sticking at the top, so its two scrollbars are not two.
        columnsWidth !== undefined ? 'overflow-auto' : 'overflow-hidden',
        'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        className,
      )}
    >
      <div
        className={cn('flex flex-col', columnsWidth !== undefined ? 'flex-auto' : 'min-h-0 flex-1')}
        style={columnsWidth !== undefined ? { minWidth: columnsWidth } : undefined}
      >
        <Header columns={columns} sort={sort} onHeaderClick={onHeaderClick} testId={testId} />
        {body}
      </div>
    </div>
  );

  if (sortedRows.length === 0) {
    return withExportBar(
      frame(
        <div
          data-testid={testId ? `${testId}-empty` : undefined}
          className="text-muted-foreground flex flex-1 items-center justify-center p-3 text-xs"
        >
          {rows.length === 0 ? (emptyState ?? 'No rows.') : 'No rows match the filter.'}
        </div>,
      ),
    );
  }

  const useVirtualization = sortedRows.length > VIRTUALIZE_THRESHOLD;

  return withExportBar(
    frame(
      useVirtualization ? (
        <div data-testid={testId ? `${testId}-virtual` : undefined} className="min-h-0 flex-1">
          <FixedSizeList<VirtualRowData<Row>>
            height={Math.min(VIRTUAL_VIEWPORT_HEIGHT, sortedRows.length * ROW_HEIGHT)}
            itemCount={sortedRows.length}
            itemSize={ROW_HEIGHT}
            width="100%"
            itemData={{ rows: sortedRows, shared }}
            overscanCount={4}
          >
            {VirtualRow}
          </FixedSizeList>
        </div>
      ) : (
        <div
          role="rowgroup"
          className={columnsWidth !== undefined ? 'flex-1' : 'min-h-0 flex-1 overflow-auto'}
        >
          {sortedRows.map((row, index) => (
            <GridRow
              key={rowIdAccessor(row)}
              row={row}
              index={index}
              style={{ height: ROW_HEIGHT }}
              shared={shared}
            />
          ))}
        </div>
      ),
    ),
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
            style={columnStyle(col)}
            className={cn(
              'px-2 py-1 select-none',
              col.numeric ? 'text-right' : 'text-left',
              !col.width && !col.minWidth ? 'flex-1' : '',
            )}
          >
            {sortable ? (
              <button
                type="button"
                onClick={() => onHeaderClick(col.key)}
                data-testid={testId ? `${testId}-header-${col.key}` : undefined}
                title={col.title}
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
              <span className="font-mono" title={col.title}>
                {col.label}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
