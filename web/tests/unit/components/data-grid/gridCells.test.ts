/**
 * Tests for the pure cell helpers behind ``<DataGrid />``: the block of cells
 * under the cursor, the tab-separated text spreadsheets exchange, what a paste
 * does, and the filter.
 */
import { describe, expect, it } from 'vitest';

import type { CellEdit, ColumnConfig } from '@/components/data-grid/DataGrid';
import {
  cellKey,
  cellText,
  filterTerms,
  formatCellValue,
  formatParamValue,
  parseCellNumber,
  parseTsv,
  planPaste,
  rangeBetween,
  rangeContains,
  rangeSize,
  rowMatches,
  toTsv,
} from '@/components/data-grid/gridCells';

describe('cell ranges', () => {
  it('runs between two corners whichever way round they are given', () => {
    const forward = rangeBetween({ row: 1, col: 2 }, { row: 3, col: 4 });
    const backward = rangeBetween({ row: 3, col: 4 }, { row: 1, col: 2 });
    expect(forward).toEqual({ row0: 1, row1: 3, col0: 2, col1: 4 });
    expect(backward).toEqual(forward);
    expect(rangeSize(forward)).toBe(9);
  });

  it('contains its edges and nothing past them', () => {
    const range = rangeBetween({ row: 1, col: 1 }, { row: 2, col: 3 });
    expect(rangeContains(range, 1, 1)).toBe(true);
    expect(rangeContains(range, 2, 3)).toBe(true);
    expect(rangeContains(range, 0, 1)).toBe(false);
    expect(rangeContains(range, 1, 4)).toBe(false);
  });

  it('keys a cell by its row and column', () => {
    expect(cellKey('r1', 'p0')).not.toBe(cellKey('r', '1p0'));
  });
});

describe('cell text', () => {
  it('gives a number at full precision and nothing for a missing value', () => {
    expect(cellText(0.123456789)).toBe('0.123456789');
    expect(cellText(100)).toBe('100');
    expect(cellText('PV')).toBe('PV');
    expect(cellText(null)).toBe('');
    expect(cellText(Number.NaN)).toBe('');
  });

  it('reads a number out of text, and nothing out of the rest', () => {
    expect(parseCellNumber(' 1.5 ')).toBe(1.5);
    expect(parseCellNumber('-2e-3')).toBe(-0.002);
    expect(parseCellNumber('')).toBeNull();
    expect(parseCellNumber('abc')).toBeNull();
    expect(parseCellNumber('Infinity')).toBeNull();
    expect(parseCellNumber('1,5')).toBeNull();
  });

  it('shows a result column to three decimals and a parameter to what it holds', () => {
    expect(formatCellValue(0.00043, true)).toBe('0.000');
    expect(formatParamValue(0.00043)).toBe('0.00043');
    expect(formatParamValue(100)).toBe('100');
    expect(formatParamValue(1.06)).toBe('1.06');
    expect(formatParamValue(0.1234567891)).toBe('0.123457');
    expect(formatParamValue(null)).toBe('—');
    expect(formatParamValue(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatParamValue('x')).toBe('x');
  });
});

describe('the plain-text table', () => {
  it('joins cells with tabs and rows with newlines', () => {
    expect(
      toTsv([
        ['a', 'b'],
        ['1', '2'],
      ]),
    ).toBe('a\tb\n1\t2');
  });

  it('reads it back, with either kind of newline and a trailing one', () => {
    expect(parseTsv('1\t2\r\n3\t4\r\n')).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
    expect(parseTsv('5\n')).toEqual([['5']]);
    expect(parseTsv('')).toEqual([]);
  });

  it('keeps an empty cell in the middle of a row', () => {
    expect(parseTsv('1\t\t3')).toEqual([['1', '', '3']]);
  });
});

interface Row {
  id: string;
  a: number | null;
  b: number | null;
  name: string;
}

function column(key: string, edit: boolean, toParam?: (n: number) => number): ColumnConfig<Row> {
  return {
    key,
    label: key,
    accessor: (r) => r[key as keyof Row] as string | number | null,
    ...(edit ? { edit: { param: key, ...(toParam ? { toParam } : {}) } } : {}),
  };
}

const COLUMNS = [column('name', false), column('a', true), column('b', true)];
const ROWS: Row[] = [
  { id: 'r0', a: 1, b: 2, name: 'x' },
  { id: 'r1', a: 3, b: 4, name: 'y' },
  { id: 'r2', a: 5, b: 6, name: 'z' },
];

function plan(
  matrix: string[][],
  start: { row: number; col: number },
  range: ReturnType<typeof rangeBetween> | null = null,
  columns = COLUMNS,
  canEdit: (row: Row, col: ColumnConfig<Row>) => boolean = (_r, c) => c.edit !== undefined,
) {
  return planPaste<Row>({
    matrix,
    start,
    range,
    rows: ROWS,
    columns,
    rowIdAccessor: (r) => r.id,
    canEdit,
  });
}

function summary(edits: CellEdit<Row>[]) {
  return edits.map((e) => `${e.rowId}.${e.column.key}=${e.value}`);
}

describe('planning a paste', () => {
  it('lays a block over the cells from the cursor, right and down', () => {
    const p = plan(
      [
        ['10', '20'],
        ['30', '40'],
      ],
      { row: 1, col: 1 },
    );
    expect(summary(p.edits)).toEqual(['r1.a=10', 'r1.b=20', 'r2.a=30', 'r2.b=40']);
    expect(p.readOnly).toBe(0);
    expect(p.clipped).toBe(0);
    expect(p.invalid).toBeNull();
  });

  it('leaves a blank cell as it was', () => {
    const p = plan([['10', '', '5']], { row: 0, col: 1 });
    expect(summary(p.edits)).toEqual(['r0.a=10']);
    // the third cell fell past the last column
    expect(p.clipped).toBe(1);
  });

  it('counts a cell that cannot be changed and skips it', () => {
    const p = plan([['q', '7', '8']], { row: 0, col: 0 });
    // `q` heads for the name column, which has no edit: skipped, not an error.
    expect(summary(p.edits)).toEqual(['r0.a=7', 'r0.b=8']);
    expect(p.readOnly).toBe(1);
    expect(p.invalid).toBeNull();
  });

  it('counts the cells past the end of the table', () => {
    const p = plan([['1'], ['2'], ['3'], ['4'], ['5']], { row: 1, col: 1 });
    expect(summary(p.edits)).toEqual(['r1.a=1', 'r2.a=2']);
    expect(p.clipped).toBe(3);
  });

  it('refuses everything when one text is no number, naming it', () => {
    const p = plan(
      [
        ['10', 'ten'],
        ['30', '40'],
      ],
      { row: 0, col: 1 },
    );
    expect(p.edits).toEqual([]);
    expect(p.invalid).toEqual({ text: 'ten', label: 'b', rowId: 'r0' });
  });

  it('drops a first row that is the column headings', () => {
    const p = plan(
      [
        ['a', 'b'],
        ['10', '20'],
      ],
      { row: 0, col: 1 },
    );
    expect(summary(p.edits)).toEqual(['r0.a=10', 'r0.b=20']);
    expect(p.invalid).toBeNull();
  });

  it('does not take a row of text for headings when it does not match them', () => {
    const p = plan(
      [
        ['x', 'y'],
        ['10', '20'],
      ],
      { row: 0, col: 1 },
    );
    expect(p.invalid).not.toBeNull();
    expect(p.edits).toEqual([]);
  });

  it('fills a selected block with one pasted value', () => {
    const p = plan(
      [['9']],
      { row: 0, col: 1 },
      rangeBetween({ row: 0, col: 1 }, { row: 2, col: 2 }),
    );
    expect(summary(p.edits)).toEqual(['r0.a=9', 'r0.b=9', 'r1.a=9', 'r1.b=9', 'r2.a=9', 'r2.b=9']);
  });

  it('pastes a block from the cursor when a block is selected too', () => {
    const p = plan(
      [['1', '2']],
      { row: 0, col: 1 },
      rangeBetween({ row: 0, col: 1 }, { row: 2, col: 2 }),
    );
    expect(summary(p.edits)).toEqual(['r0.a=1', 'r0.b=2']);
  });

  it("writes a value in the parameter's own unit", () => {
    const columns = [column('name', false), column('a', true, (n) => n / 10), column('b', true)];
    const p = plan([['50', '5']], { row: 0, col: 1 }, null, columns);
    expect(summary(p.edits)).toEqual(['r0.a=5', 'r0.b=5']);
  });

  it('writes nothing where the grid says no cell can be changed', () => {
    const p = plan([['1', '2']], { row: 0, col: 1 }, null, COLUMNS, () => false);
    expect(p.edits).toEqual([]);
    expect(p.readOnly).toBe(2);
  });
});

describe('filter', () => {
  it('splits what is typed into lower-case words', () => {
    expect(filterTerms('  PV   1 ')).toEqual(['pv', '1']);
    expect(filterTerms('')).toEqual([]);
  });

  it('keeps a row where every word is in some cell, case aside', () => {
    const cells = ['1', 'Bus_1', 'PV'];
    expect(rowMatches(cells, [])).toBe(true);
    expect(rowMatches(cells, ['pv'])).toBe(true);
    expect(rowMatches(cells, ['pv', 'bus'])).toBe(true);
    expect(rowMatches(cells, ['pv', 'slack'])).toBe(false);
  });

  it('does not let a word run across two cells', () => {
    expect(rowMatches(['ab', 'cd'], ['bc'])).toBe(false);
  });
});
