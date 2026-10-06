/**
 * Pure helpers for the cell side of ``DataGrid``: the cursor and its range,
 * the plain-text table spreadsheets exchange, what a pasted block does to the
 * cells under it, and the filter. No React, so the rules read and test on
 * their own.
 */
import type { CellEdit, ColumnConfig } from './DataGrid';

/** A cell by its place among the rows on screen (after filter and sort) and the columns. */
export interface CellPosition {
  row: number;
  col: number;
}

/** A block of cells, both ends included. */
export interface CellRange {
  row0: number;
  row1: number;
  col0: number;
  col1: number;
}

/** The block of cells between two corners, whichever way round they are given. */
export function rangeBetween(a: CellPosition, b: CellPosition): CellRange {
  return {
    row0: Math.min(a.row, b.row),
    row1: Math.max(a.row, b.row),
    col0: Math.min(a.col, b.col),
    col1: Math.max(a.col, b.col),
  };
}

export function rangeContains(range: CellRange, row: number, col: number): boolean {
  return row >= range.row0 && row <= range.row1 && col >= range.col0 && col <= range.col1;
}

export function rangeSize(range: CellRange): number {
  return (range.row1 - range.row0 + 1) * (range.col1 - range.col0 + 1);
}

/** The key of one cell among the rows: what a grid's pending set holds. */
export function cellKey(rowId: string, columnKey: string): string {
  return `${rowId}\u0000${columnKey}`;
}

// ---- text of a cell ---------------------------------------------------------

/** Format a value for display. ``null``/``undefined``/``NaN`` → ``—``. */
export function formatCellValue(value: string | number | null, numeric: boolean): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—';
    return numeric ? value.toFixed(3) : String(value);
  }
  return value === '' ? '—' : value;
}

/**
 * A cell value as plain text at full precision, empty for a missing value:
 * what a copy carries and what an edit starts from. The grid shows three
 * decimals, which is no basis to edit or paste from.
 */
export function cellText(value: string | number | null): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return value;
}

/** The number a text means, or `null` when it is empty or not a finite number. */
export function parseCellNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * A parameter value for a cell: up to six significant digits, no trailing
 * zeros, so `0.00281` and `100` and `1.06` read as they are. The three decimals
 * a result column shows would turn a line's `r` of 0.00043 into 0.000.
 */
export function formatParamValue(value: string | number | null): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value === '' ? '—' : value;
  if (!Number.isFinite(value)) return '—';
  return String(Number(value.toPrecision(6)));
}

// ---- the plain-text table ---------------------------------------------------

/** Rows of cells as the text a spreadsheet pastes: tabs between cells, a newline after each row. */
export function toTsv(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  return rows.map((row) => row.join('\t')).join('\n');
}

/**
 * The cells of copied spreadsheet text. A trailing newline (spreadsheets end
 * every copy with one) does not make an extra empty row.
 */
export function parseTsv(text: string): string[][] {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  if (normalized === '') return [];
  return normalized.split('\n').map((line) => line.split('\t'));
}

// ---- paste ------------------------------------------------------------------

export interface PasteBlock<Row> {
  /** The cells copied, row by row. */
  matrix: ReadonlyArray<ReadonlyArray<string>>;
  /** Where the block lands: the cursor cell. */
  start: CellPosition;
  /** The cells selected, when more than the cursor cell is. */
  range: CellRange | null;
  /** The rows on screen. */
  rows: ReadonlyArray<Row>;
  columns: ReadonlyArray<ColumnConfig<Row>>;
  rowIdAccessor: (row: Row) => string;
  canEdit: (row: Row, column: ColumnConfig<Row>) => boolean;
}

export interface PastePlan<Row> {
  /** The values to write, in row order. */
  edits: CellEdit<Row>[];
  /** Cells the block reached that cannot be changed (a result column, a locked case). */
  readOnly: number;
  /** Cells that fell off the table's end. */
  clipped: number;
  /** The first text that is no number, with where it was headed; nothing is written when there is one. */
  invalid: { text: string; label: string; rowId: string } | null;
}

/** Whether the first row of a block is the column headings of the cells it lands on. */
function startsWithHeadings<Row>(
  matrix: ReadonlyArray<ReadonlyArray<string>>,
  startCol: number,
  columns: ReadonlyArray<ColumnConfig<Row>>,
): boolean {
  const first = matrix[0];
  if (first === undefined || first.length === 0) return false;
  return first.every((cell, j) => cell.trim() === columns[startCol + j]?.label);
}

/**
 * What pasting a block does. A block goes from the cursor cell to the right
 * and down, one pasted cell per grid cell; one value pasted over a selection
 * of several cells fills them all. A blank cell leaves its target as it was, a
 * cell that cannot be changed is left alone and counted, and a first row that
 * is the column headings (a copy of the table with them) is dropped. A text
 * that is no number refuses the whole paste, so a block pasted a column off
 * does not write half of itself.
 */
export function planPaste<Row>(block: PasteBlock<Row>): PastePlan<Row> {
  const { rows, columns, rowIdAccessor, canEdit } = block;
  const plan: PastePlan<Row> = { edits: [], readOnly: 0, clipped: 0, invalid: null };
  const fill = block.range !== null && rangeSize(block.range) > 1;
  let matrix = block.matrix;
  if (!fill && startsWithHeadings(matrix, block.start.col, columns)) matrix = matrix.slice(1);

  // One value over several cells: the block is that value repeated over the range.
  const single = matrix.length === 1 && matrix[0]?.length === 1 ? (matrix[0]?.[0] ?? '') : null;
  let height = matrix.length;
  let width = Math.max(0, ...matrix.map((row) => row.length));
  let origin = block.start;
  if (fill && single !== null && block.range !== null) {
    origin = { row: block.range.row0, col: block.range.col0 };
    height = block.range.row1 - block.range.row0 + 1;
    width = block.range.col1 - block.range.col0 + 1;
  }

  for (let i = 0; i < height; i++) {
    for (let j = 0; j < width; j++) {
      const text = (single !== null && fill ? single : (matrix[i]?.[j] ?? '')).trim();
      const row = rows[origin.row + i];
      const column = columns[origin.col + j];
      if (row === undefined || column === undefined) {
        if (text !== '') plan.clipped += 1;
        continue;
      }
      if (text === '') continue;
      if (!canEdit(row, column)) {
        plan.readOnly += 1;
        continue;
      }
      const shown = parseCellNumber(text);
      const rowId = rowIdAccessor(row);
      if (shown === null) {
        plan.invalid ??= { text, label: column.label, rowId };
        continue;
      }
      plan.edits.push({
        rowId,
        row,
        column,
        value: column.edit?.toParam ? column.edit.toParam(shown, row) : shown,
      });
    }
  }
  if (plan.invalid !== null) plan.edits = [];
  return plan;
}

// ---- filter -----------------------------------------------------------------

/** The words of a filter: split on spaces, lower-cased, none empty. */
export function filterTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== '');
}

/**
 * Whether a row passes a filter: every word is found in the text of at least
 * one of its cells (case aside), as shown or as stored, so `pv 1` finds the
 * generator of kind PV at idx 1 and `0.95` finds a limit the cell shows as
 * `0.950`.
 */
export function rowMatches(
  cellTexts: ReadonlyArray<string>,
  terms: ReadonlyArray<string>,
): boolean {
  if (terms.length === 0) return true;
  const haystack = cellTexts.join('\u0001').toLowerCase();
  return terms.every((term) => haystack.includes(term));
}
