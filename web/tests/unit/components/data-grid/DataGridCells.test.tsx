/**
 * Tests for the cell side of ``<DataGrid />``: the filter, the cell cursor and
 * the block of cells under it, copy, the cell editor and paste.
 *
 * The grid does not know where a value goes: it hands the numbers to
 * ``editing.commit``, so these tests hand it a ``GridEditing`` of their own and
 * check what it was asked to write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  DataGrid,
  type CellEdit,
  type ColumnConfig,
  type GridEditing,
} from '@/components/data-grid/DataGrid';
import { cellKey } from '@/components/data-grid/gridCells';
import { captureDownloads, exportAs, readBlob } from '../../helpers/downloads';

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

interface Row {
  id: string;
  name: string;
  kind: string;
  p: number | null;
  q: number | null;
  /** A value shown in a unit the parameter is not held in: kV for per unit. */
  kv: number | null;
}

const ROWS: Row[] = [
  { id: 'a', name: 'Alpha', kind: 'PV', p: 1.5, q: 0.25, kv: 230 },
  { id: 'b', name: 'Beta', kind: 'Slack', p: 2.5, q: 0.5, kv: 115 },
  { id: 'c', name: 'Gamma', kind: 'PV', p: 3.5, q: null, kv: 230 },
];

const COLUMNS: ColumnConfig<Row>[] = [
  { key: 'id', label: 'idx', accessor: (r) => r.id },
  { key: 'name', label: 'name', accessor: (r) => r.name },
  { key: 'kind', label: 'kind', accessor: (r) => r.kind },
  { key: 'p', label: 'P', numeric: true, accessor: (r) => r.p, edit: { param: 'p0' } },
  { key: 'q', label: 'Q', numeric: true, accessor: (r) => r.q, edit: { param: 'q0' } },
  {
    key: 'kv',
    label: 'kV',
    numeric: true,
    accessor: (r) => r.kv,
    // Typed in kV, written per unit on a 230 kV base.
    edit: { param: 'vmax', toParam: (shown) => shown / 230 },
  },
];

interface Harness {
  editing: GridEditing<Row>;
  commit: ReturnType<typeof vi.fn>;
}

function makeEditing(overrides: Partial<GridEditing<Row>> = {}): Harness {
  const commit = vi.fn(async (edits: ReadonlyArray<CellEdit<Row>>) => ({
    applied: edits.length,
    failed: false,
  }));
  const editing: GridEditing<Row> = {
    canEdit: (_row, col) => col.edit !== undefined,
    commit,
    pending: new Set(),
    error: null,
    dismissError: vi.fn(),
    lockedReason: null,
    ...overrides,
  };
  return { editing, commit };
}

function renderGrid(props: Partial<Parameters<typeof DataGrid<Row>>[0]> = {}) {
  return render(
    <DataGrid<Row>
      columns={COLUMNS}
      rows={ROWS}
      rowIdAccessor={(r) => r.id}
      testId="dg"
      ariaLabel="Things"
      {...props}
    />,
  );
}

function cell(rowId: string, key: string): HTMLElement {
  return screen.getByTestId(`dg-cell-${rowId}-${key}`);
}

function visibleRowIds(): string[] {
  return screen
    .getAllByRole('row')
    .map((r) => r.getAttribute('data-testid'))
    .filter((id): id is string => id !== null && id.startsWith('dg-row-'))
    .map((id) => id.replace('dg-row-', ''));
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('<DataGrid /> filter', () => {
  it('has no filter box unless asked for', () => {
    renderGrid();
    expect(screen.queryByTestId('dg-filter')).not.toBeInTheDocument();
  });

  it('keeps the rows with every word in some cell, and counts them', async () => {
    const user = userEvent.setup();
    renderGrid({ filterable: true });
    expect(visibleRowIds()).toEqual(['a', 'b', 'c']);

    await user.type(screen.getByTestId('dg-filter'), 'pv');
    expect(visibleRowIds()).toEqual(['a', 'c']);
    expect(screen.getByTestId('dg-filter-count')).toHaveTextContent('2 of 3');

    // A second word narrows further, and may be in another column.
    await user.type(screen.getByTestId('dg-filter'), ' gamma');
    expect(visibleRowIds()).toEqual(['c']);
    expect(screen.getByTestId('dg-filter-count')).toHaveTextContent('1 of 3');
  });

  it('matches the value as shown and as held, case aside', async () => {
    const user = userEvent.setup();
    renderGrid({ filterable: true });
    // The cell shows 1.500; the full value is 1.5.
    await user.type(screen.getByTestId('dg-filter'), '1.500');
    expect(visibleRowIds()).toEqual(['a']);
    await user.clear(screen.getByTestId('dg-filter'));
    await user.type(screen.getByTestId('dg-filter'), 'ALPHA');
    expect(visibleRowIds()).toEqual(['a']);
  });

  it('says so when nothing matches, and the clear button brings every row back', async () => {
    const user = userEvent.setup();
    renderGrid({ filterable: true });
    await user.type(screen.getByTestId('dg-filter'), 'nothing like this');
    expect(visibleRowIds()).toEqual([]);
    expect(screen.getByTestId('dg-empty')).toHaveTextContent('No rows match the filter.');
    await user.click(screen.getByTestId('dg-filter-clear'));
    expect(visibleRowIds()).toEqual(['a', 'b', 'c']);
    expect(screen.queryByTestId('dg-filter-count')).not.toBeInTheDocument();
  });

  it('clears on Escape in the box', async () => {
    const user = userEvent.setup();
    renderGrid({ filterable: true });
    await user.type(screen.getByTestId('dg-filter'), 'beta');
    expect(visibleRowIds()).toEqual(['b']);
    await user.keyboard('{Escape}');
    expect(screen.getByTestId('dg-filter')).toHaveValue('');
    expect(visibleRowIds()).toEqual(['a', 'b', 'c']);
  });

  it('sorts and exports only the rows that pass', async () => {
    const user = userEvent.setup();
    const downloads = captureDownloads();
    renderGrid({ filterable: true, exportPanel: 'things' });
    await user.type(screen.getByTestId('dg-filter'), 'pv');
    await user.click(screen.getByTestId('dg-header-p'));
    await user.click(screen.getByTestId('dg-header-p')); // descending
    expect(visibleRowIds()).toEqual(['c', 'a']);

    await exportAs(user, 'csv');
    const blob = downloads.blobs[0];
    expect(blob).toBeDefined();
    const csv = await readBlob(blob as Blob);
    expect(csv.trim().split('\n')).toEqual([
      'idx,name,kind,P,Q,kV',
      'c,Gamma,PV,3.5,,230',
      'a,Alpha,PV,1.5,0.25,230',
    ]);
    downloads.restore();
  });

  it('is not offered with no rows at all', () => {
    renderGrid({ filterable: true, rows: [] });
    expect(screen.queryByTestId('dg-filter')).not.toBeInTheDocument();
  });
});

describe('<DataGrid /> cell cursor', () => {
  it('draws no cursor until a cell is clicked', () => {
    renderGrid({ copyable: true });
    expect(document.querySelector('[data-active-cell]')).toBeNull();
  });

  it('puts the cursor in the clicked cell', async () => {
    const user = userEvent.setup();
    renderGrid({ copyable: true });
    await user.click(cell('b', 'p'));
    expect(cell('b', 'p')).toHaveAttribute('data-active-cell', 'true');
    expect(document.querySelectorAll('[data-active-cell]')).toHaveLength(1);
  });

  it('moves with the arrow keys', async () => {
    const user = userEvent.setup();
    renderGrid({ copyable: true });
    await user.click(cell('a', 'name'));
    await user.keyboard('{ArrowRight}');
    expect(cell('a', 'kind')).toHaveAttribute('data-active-cell', 'true');
    await user.keyboard('{ArrowDown}');
    expect(cell('b', 'kind')).toHaveAttribute('data-active-cell', 'true');
    await user.keyboard('{ArrowLeft}');
    expect(cell('b', 'name')).toHaveAttribute('data-active-cell', 'true');
  });

  it('stops at the edges', async () => {
    const user = userEvent.setup();
    renderGrid({ copyable: true });
    await user.click(cell('a', 'id'));
    await user.keyboard('{ArrowLeft}{ArrowUp}');
    expect(cell('a', 'id')).toHaveAttribute('data-active-cell', 'true');
    await user.click(cell('c', 'kv'));
    await user.keyboard('{ArrowRight}{ArrowDown}');
    expect(cell('c', 'kv')).toHaveAttribute('data-active-cell', 'true');
  });

  it('extends to a block with Shift and the arrows, and with Shift-click', async () => {
    const user = userEvent.setup();
    renderGrid({ copyable: true });
    await user.click(cell('a', 'p'));
    await user.keyboard('{Shift>}{ArrowRight}{ArrowDown}{/Shift}');
    for (const [row, key] of [
      ['a', 'p'],
      ['a', 'q'],
      ['b', 'p'],
      ['b', 'q'],
    ] as const) {
      expect(cell(row, key)).toHaveAttribute('data-in-range', 'true');
    }
    expect(cell('c', 'p')).not.toHaveAttribute('data-in-range');

    // A plain arrow drops the block.
    await user.keyboard('{ArrowDown}');
    expect(document.querySelectorAll('[data-in-range]')).toHaveLength(1);

    await user.click(cell('a', 'name'));
    await user.keyboard('{Shift>}');
    await user.click(cell('b', 'kind'));
    await user.keyboard('{/Shift}');
    expect(document.querySelectorAll('[data-in-range]')).toHaveLength(4);
  });

  it('does not select the row for a Shift-click that extends the block', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    renderGrid({ copyable: true, onRowClick });
    await user.click(cell('a', 'p'));
    expect(onRowClick).toHaveBeenCalledTimes(1);
    await user.keyboard('{Shift>}');
    await user.click(cell('c', 'p'));
    await user.keyboard('{/Shift}');
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  it('selects every cell with Ctrl+A', async () => {
    const user = userEvent.setup();
    renderGrid({ copyable: true });
    await user.click(cell('a', 'id'));
    await user.keyboard('{Control>}a{/Control}');
    expect(document.querySelectorAll('[data-in-range]')).toHaveLength(ROWS.length * COLUMNS.length);
  });

  it('drops the block on Escape, then the cursor', async () => {
    const user = userEvent.setup();
    renderGrid({ copyable: true });
    await user.click(cell('a', 'p'));
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(document.querySelectorAll('[data-in-range]')).toHaveLength(2);
    await user.keyboard('{Escape}');
    expect(document.querySelectorAll('[data-in-range]')).toHaveLength(1);
    await user.keyboard('{Escape}');
    expect(document.querySelector('[data-active-cell]')).toBeNull();
  });

  it('keeps the row bindings: Enter still selects the focused row', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    renderGrid({ copyable: true, onRowClick });
    await user.click(cell('a', 'p'));
    onRowClick.mockClear();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onRowClick).toHaveBeenCalledWith('b');
  });
});

describe('<DataGrid /> copy', () => {
  function copyEvent() {
    const setData = vi.fn();
    return { setData, event: { clipboardData: { setData } } };
  }

  it('copies the cell under the cursor at full precision', async () => {
    const user = userEvent.setup();
    renderGrid({ copyable: true });
    await user.click(cell('a', 'p'));
    const { setData, event } = copyEvent();
    fireEvent.copy(screen.getByTestId('dg'), event);
    expect(setData).toHaveBeenCalledWith('text/plain', '1.5');
  });

  it('copies a block as tab-separated rows, in the order shown', async () => {
    const user = userEvent.setup();
    renderGrid({ copyable: true });
    await user.click(screen.getByTestId('dg-header-p'));
    await user.click(screen.getByTestId('dg-header-p')); // descending: c, b, a
    await user.click(cell('c', 'name'));
    await user.keyboard('{Shift>}{ArrowRight}{ArrowRight}{ArrowDown}{/Shift}');
    const { setData, event } = copyEvent();
    fireEvent.copy(screen.getByTestId('dg'), event);
    expect(setData).toHaveBeenCalledWith('text/plain', 'Gamma\tPV\t3.5\nBeta\tSlack\t2.5');
  });

  it('leaves a missing value empty', async () => {
    const user = userEvent.setup();
    renderGrid({ copyable: true });
    await user.click(cell('b', 'q'));
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}');
    const { setData, event } = copyEvent();
    fireEvent.copy(screen.getByTestId('dg'), event);
    expect(setData).toHaveBeenCalledWith('text/plain', '0.5\n');
  });

  it('is left to the browser while the cursor has not been put anywhere', () => {
    renderGrid({ copyable: true });
    const { setData, event } = copyEvent();
    fireEvent.copy(screen.getByTestId('dg'), event);
    expect(setData).not.toHaveBeenCalled();
  });

  it('is left to the browser inside the cell editor', async () => {
    const user = userEvent.setup();
    const { editing } = makeEditing();
    renderGrid({ editing });
    await user.dblClick(cell('a', 'p'));
    const { setData, event } = copyEvent();
    fireEvent.copy(screen.getByTestId('dg-editor'), event);
    expect(setData).not.toHaveBeenCalled();
  });

  it('copies the whole table with its headings from the Copy button', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderGrid({ copyable: true, filterable: true });
    await user.type(screen.getByTestId('dg-filter'), 'pv');
    await user.click(screen.getByTestId('dg-copy'));
    expect(writeText).toHaveBeenCalledWith(
      'idx\tname\tkind\tP\tQ\tkV\na\tAlpha\tPV\t1.5\t0.25\t230\nc\tGamma\tPV\t3.5\t\t230',
    );
    expect(toastMock.success).toHaveBeenCalledWith('Copied 2 rows, with the column headings.');
  });

  it('says so when the browser will not copy', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    renderGrid({ copyable: true });
    await user.click(screen.getByTestId('dg-copy'));
    expect(toastMock.error).toHaveBeenCalledWith('The browser did not let the table be copied.');
  });
});

describe('<DataGrid /> cell editor', () => {
  it('opens on a double-click of a cell that can be changed, holding its full value', async () => {
    const user = userEvent.setup();
    const { editing } = makeEditing();
    renderGrid({ editing });
    await user.dblClick(cell('a', 'p'));
    const input = screen.getByTestId('dg-editor');
    expect(input).toHaveValue('1.5');
    expect(input).toHaveFocus();
    expect(cell('a', 'p')).toContainElement(input);
  });

  it('does not open on a cell that cannot be changed', async () => {
    const user = userEvent.setup();
    const { editing } = makeEditing();
    renderGrid({ editing });
    await user.dblClick(cell('a', 'name'));
    expect(screen.queryByTestId('dg-editor')).not.toBeInTheDocument();
  });

  it('does not open when the grid says the cell is locked', async () => {
    const user = userEvent.setup();
    const { editing } = makeEditing({ canEdit: () => false });
    renderGrid({ editing });
    await user.dblClick(cell('a', 'p'));
    expect(screen.queryByTestId('dg-editor')).not.toBeInTheDocument();
  });

  it('marks the cells that can be changed', () => {
    const { editing } = makeEditing();
    renderGrid({ editing });
    expect(cell('a', 'p')).toHaveAttribute('data-editable', 'true');
    expect(cell('a', 'name')).not.toHaveAttribute('data-editable');
  });

  it('writes the typed number on Enter and closes', async () => {
    const user = userEvent.setup();
    const { editing, commit } = makeEditing();
    renderGrid({ editing });
    await user.dblClick(cell('b', 'q'));
    await user.keyboard('0.75{Enter}');
    expect(commit).toHaveBeenCalledTimes(1);
    const edits = commit.mock.calls[0]?.[0] as CellEdit<Row>[];
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ rowId: 'b', value: 0.75 });
    expect(edits[0]?.column.edit?.param).toBe('q0');
    expect(screen.queryByTestId('dg-editor')).not.toBeInTheDocument();
    expect(screen.getByTestId('dg')).toHaveFocus();
  });

  it('writes a value in the unit the parameter is held in', async () => {
    const user = userEvent.setup();
    const { editing, commit } = makeEditing();
    renderGrid({ editing });
    await user.dblClick(cell('a', 'kv'));
    await user.keyboard('241.5{Enter}');
    const edits = commit.mock.calls[0]?.[0] as CellEdit<Row>[];
    expect(edits[0]?.value).toBeCloseTo(1.05, 10);
  });

  it('opens on F2 for the cell under the cursor', async () => {
    const user = userEvent.setup();
    const { editing } = makeEditing();
    renderGrid({ editing });
    await user.click(cell('a', 'p'));
    await user.keyboard('{F2}');
    expect(screen.getByTestId('dg-editor')).toHaveValue('1.5');
  });

  it('drops the draft on Escape', async () => {
    const user = userEvent.setup();
    const { editing, commit } = makeEditing();
    renderGrid({ editing });
    await user.dblClick(cell('a', 'p'));
    await user.keyboard('99{Escape}');
    expect(commit).not.toHaveBeenCalled();
    expect(screen.queryByTestId('dg-editor')).not.toBeInTheDocument();
    expect(cell('a', 'p')).toHaveTextContent('1.500');
  });

  it('writes nothing for a draft left as it was or emptied', async () => {
    const user = userEvent.setup();
    const { editing, commit } = makeEditing();
    renderGrid({ editing });
    await user.dblClick(cell('a', 'p'));
    await user.keyboard('{Enter}');
    await user.dblClick(cell('a', 'p'));
    await user.clear(screen.getByTestId('dg-editor'));
    await user.keyboard('{Enter}');
    expect(commit).not.toHaveBeenCalled();
    expect(screen.queryByTestId('dg-editor')).not.toBeInTheDocument();
  });

  it('writes on leaving the cell', async () => {
    const user = userEvent.setup();
    const { editing, commit } = makeEditing();
    renderGrid({ editing });
    await user.dblClick(cell('a', 'p'));
    await user.keyboard('7');
    await user.click(screen.getByTestId('dg-header-id'));
    expect(commit).toHaveBeenCalledTimes(1);
    expect((commit.mock.calls[0]?.[0] as CellEdit<Row>[])[0]).toMatchObject({
      rowId: 'a',
      value: 7,
    });
  });

  it('writes only once when Enter is followed by the blur of the closing editor', async () => {
    const user = userEvent.setup();
    const { editing, commit } = makeEditing();
    renderGrid({ editing });
    await user.dblClick(cell('a', 'p'));
    await user.keyboard('8{Enter}');
    await user.click(document.body);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('keeps the editor open, with the reason, for text that is no number', async () => {
    const user = userEvent.setup();
    const { editing, commit } = makeEditing();
    renderGrid({ editing, testId: 'dg' });
    await user.dblClick(cell('a', 'p'));
    await user.clear(screen.getByTestId('dg-editor'));
    await user.keyboard('abc{Enter}');
    expect(commit).not.toHaveBeenCalled();
    expect(screen.getByTestId('dg-editor')).toHaveValue('abc');
    expect(screen.getByTestId('dg-edit-error')).toHaveTextContent(
      'P takes a number, and "abc" is not one.',
    );
    // Fixing it clears the reason.
    await user.clear(screen.getByTestId('dg-editor'));
    await user.keyboard('4{Enter}');
    expect(commit).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('dg-edit-error')).not.toBeInTheDocument();
  });

  it('writes on Tab and opens the next cell of the row that can be changed', async () => {
    const user = userEvent.setup();
    const { editing, commit } = makeEditing();
    renderGrid({ editing });
    await user.dblClick(cell('a', 'p'));
    await user.keyboard('2{Tab}');
    expect(commit).toHaveBeenCalledTimes(1);
    expect(cell('a', 'q')).toContainElement(screen.getByTestId('dg-editor'));
    expect(screen.getByTestId('dg-editor')).toHaveValue('0.25');
    // Shift+Tab goes back.
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(cell('a', 'p')).toContainElement(screen.getByTestId('dg-editor'));
  });

  it('closes on Tab past the last cell that can be changed', async () => {
    const user = userEvent.setup();
    const { editing } = makeEditing();
    renderGrid({ editing });
    await user.dblClick(cell('a', 'kv'));
    await user.keyboard('{Tab}');
    expect(screen.queryByTestId('dg-editor')).not.toBeInTheDocument();
  });

  it('shows a cell being written dimmed', () => {
    const { editing } = makeEditing({ pending: new Set([cellKey('a', 'p')]) });
    renderGrid({ editing });
    expect(cell('a', 'p')).toHaveAttribute('data-pending', 'true');
    expect(cell('a', 'q')).not.toHaveAttribute('data-pending');
  });

  it('shows why a write was refused, until dismissed', async () => {
    const user = userEvent.setup();
    const dismissError = vi.fn();
    const { editing } = makeEditing({ error: 'xd1 is out of order', dismissError });
    renderGrid({ editing });
    const alert = screen.getByTestId('dg-edit-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('xd1 is out of order');
    await user.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(dismissError).toHaveBeenCalled();
  });

  it("shows the hint of the editing and what it puts at the bar's right", () => {
    const { editing } = makeEditing({
      hint: 'Double-click a value to change it.',
      barExtra: <button type="button">Unlock</button>,
    });
    renderGrid({ editing });
    expect(screen.getByTestId('dg-hint')).toHaveTextContent('Double-click a value to change it.');
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeInTheDocument();
  });

  it('says nothing about what to do with cells when there are no rows', () => {
    const { editing } = makeEditing({ hint: 'Double-click a value to change it.' });
    renderGrid({ editing, rows: [] });
    expect(screen.queryByTestId('dg-hint')).not.toBeInTheDocument();
  });

  it('keeps a hint of its own over the one of the editing', () => {
    const { editing } = makeEditing({ hint: 'from editing' });
    renderGrid({ editing, hint: 'from the grid' });
    expect(screen.getByTestId('dg-hint')).toHaveTextContent('from the grid');
  });
});

describe('<DataGrid /> paste', () => {
  function paste(text: string) {
    fireEvent.paste(screen.getByTestId('dg'), {
      clipboardData: { getData: () => text },
    });
  }

  it('writes a copied block from the cursor cell, right and down', async () => {
    const user = userEvent.setup();
    const { editing, commit } = makeEditing();
    renderGrid({ editing });
    await user.click(cell('a', 'p'));
    paste('10\t20\n30\t40\n');
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    const edits = commit.mock.calls[0]?.[0] as CellEdit<Row>[];
    expect(edits.map((e) => `${e.rowId}.${e.column.key}=${e.value}`)).toEqual([
      'a.p=10',
      'a.q=20',
      'b.p=30',
      'b.q=40',
    ]);
    await vi.waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Pasted 4 values.'));
  });

  it('follows the order on screen, not the order of the rows', async () => {
    const user = userEvent.setup();
    const { editing, commit } = makeEditing();
    renderGrid({ editing });
    await user.click(screen.getByTestId('dg-header-name'));
    await user.click(screen.getByTestId('dg-header-name')); // descending: Gamma, Beta, Alpha
    await user.click(cell('c', 'p'));
    paste('1\n2');
    await vi.waitFor(() => expect(commit).toHaveBeenCalled());
    const edits = commit.mock.calls[0]?.[0] as CellEdit<Row>[];
    expect(edits.map((e) => e.rowId)).toEqual(['c', 'b']);
  });

  it('fills a selected block with one value', async () => {
    const user = userEvent.setup();
    const { editing, commit } = makeEditing();
    renderGrid({ editing });
    await user.click(cell('a', 'p'));
    await user.keyboard('{Shift>}{ArrowRight}{ArrowDown}{/Shift}');
    paste('5');
    await vi.waitFor(() => expect(commit).toHaveBeenCalled());
    const edits = commit.mock.calls[0]?.[0] as CellEdit<Row>[];
    expect(edits.map((e) => e.value)).toEqual([5, 5, 5, 5]);
  });

  it('drops the headings of a copy of the table', async () => {
    const user = userEvent.setup();
    const { editing, commit } = makeEditing();
    renderGrid({ editing });
    await user.click(cell('a', 'p'));
    paste('P\tQ\n11\t12');
    await vi.waitFor(() => expect(commit).toHaveBeenCalled());
    const edits = commit.mock.calls[0]?.[0] as CellEdit<Row>[];
    expect(edits.map((e) => e.value)).toEqual([11, 12]);
  });

  it('writes nothing, and says which text is no number', async () => {
    const user = userEvent.setup();
    const { editing, commit } = makeEditing();
    renderGrid({ editing });
    await user.click(cell('a', 'p'));
    paste('10\toops');
    await vi.waitFor(() =>
      expect(screen.getByTestId('dg-edit-error')).toHaveTextContent(
        'Q of a takes a number, and "oops" is not one. Nothing was pasted.',
      ),
    );
    expect(commit).not.toHaveBeenCalled();
  });

  it('leaves the cells that cannot be changed and says how many', async () => {
    const user = userEvent.setup();
    const { editing, commit } = makeEditing();
    renderGrid({ editing });
    await user.click(cell('a', 'kind'));
    paste('PV\t8\t9');
    await vi.waitFor(() => expect(commit).toHaveBeenCalled());
    const edits = commit.mock.calls[0]?.[0] as CellEdit<Row>[];
    expect(edits.map((e) => e.value)).toEqual([8, 9]);
    await vi.waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        'Pasted 2 values. 1 cell that cannot be changed was left as it was.',
      ),
    );
  });

  it('says why nothing was pasted when the grid is locked', async () => {
    const user = userEvent.setup();
    const { editing, commit } = makeEditing({
      canEdit: () => false,
      lockedReason: 'A run has locked this case.',
    });
    renderGrid({ editing });
    await user.click(cell('a', 'p'));
    paste('10');
    await vi.waitFor(() =>
      expect(toastMock.info).toHaveBeenCalledWith(
        'Nothing was pasted. A run has locked this case.',
      ),
    );
    expect(commit).not.toHaveBeenCalled();
  });

  it('asks for a cell to paste into when the cursor is nowhere', async () => {
    const { editing, commit } = makeEditing();
    renderGrid({ editing });
    paste('10');
    await vi.waitFor(() =>
      expect(toastMock.info).toHaveBeenCalledWith('Click the cell to paste into, then paste.'),
    );
    expect(commit).not.toHaveBeenCalled();
  });

  it('leaves pasting to the browser inside the cell editor', async () => {
    const user = userEvent.setup();
    const { editing, commit } = makeEditing();
    renderGrid({ editing });
    await user.dblClick(cell('a', 'p'));
    fireEvent.paste(screen.getByTestId('dg-editor'), { clipboardData: { getData: () => '77' } });
    expect(commit).not.toHaveBeenCalled();
  });

  it('is not taken by a grid with no editing', async () => {
    const user = userEvent.setup();
    renderGrid({ copyable: true });
    await user.click(cell('a', 'p'));
    const event = fireEvent.paste(screen.getByTestId('dg'), {
      clipboardData: { getData: () => '10' },
    });
    // Not cancelled: nothing here would use it.
    expect(event).toBe(true);
    expect(toastMock.info).not.toHaveBeenCalled();
  });

  it('does not report a paste that a write refused', async () => {
    const user = userEvent.setup();
    const { editing, commit } = makeEditing();
    commit.mockResolvedValueOnce({ applied: 0, failed: true });
    renderGrid({ editing });
    await user.click(cell('a', 'p'));
    paste('10');
    await vi.waitFor(() => expect(commit).toHaveBeenCalled());
    await Promise.resolve();
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});

describe('<DataGrid /> cells on the virtualized path', () => {
  // More than 50 rows (an IEEE 118 or 300 case) are drawn by a windowed list, and the
  // editor lives inside one of its rows.
  const MANY: Row[] = Array.from({ length: 60 }, (_, i) => ({
    id: `r${i}`,
    name: `Row ${i}`,
    kind: 'PV',
    p: i + 0.5,
    q: 0.25,
    kv: 230,
  }));

  it('is the windowed list that is drawn', () => {
    const { editing } = makeEditing();
    renderGrid({ editing, rows: MANY });
    expect(screen.getByTestId('dg-virtual')).toBeInTheDocument();
  });

  it('edits a cell, carries Tab on to the next one in the row, and writes both', async () => {
    const user = userEvent.setup();
    const { editing, commit } = makeEditing();
    renderGrid({ editing, rows: MANY });
    await user.dblClick(cell('r3', 'p'));
    expect(cell('r3', 'p')).toContainElement(screen.getByTestId('dg-editor'));
    await user.keyboard('9.5{Tab}');
    expect(cell('r3', 'q')).toContainElement(screen.getByTestId('dg-editor'));
    await user.keyboard('1.25{Enter}');
    const written = commit.mock.calls.map((call) =>
      (call[0] as CellEdit<Row>[]).map((e) => `${e.rowId}.${e.column.key}=${e.value}`),
    );
    expect(written).toEqual([['r3.p=9.5'], ['r3.q=1.25']]);
    expect(screen.queryByTestId('dg-editor')).not.toBeInTheDocument();
  });

  it('pastes a block down the rows from the cursor cell', async () => {
    const user = userEvent.setup();
    const { editing, commit } = makeEditing();
    renderGrid({ editing, rows: MANY });
    await user.click(cell('r2', 'p'));
    fireEvent.paste(screen.getByTestId('dg'), {
      clipboardData: { getData: () => '10\t20\n30\t40\n' },
    });
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    const edits = commit.mock.calls[0]?.[0] as CellEdit<Row>[];
    expect(edits.map((e) => `${e.rowId}.${e.column.key}=${e.value}`)).toEqual([
      'r2.p=10',
      'r2.q=20',
      'r3.p=30',
      'r3.q=40',
    ]);
  });
});

describe('<DataGrid /> width', () => {
  it('scrolls sideways when every column has a width, and the table is as wide as they add up to', () => {
    const wide: ColumnConfig<Row>[] = COLUMNS.map((c) => ({ ...c, width: 100 }));
    renderGrid({ columns: wide });
    const inner = screen.getByTestId('dg').firstElementChild as HTMLElement;
    expect(inner.style.minWidth).toBe('600px');
    expect(screen.getByTestId('dg')).toHaveClass('overflow-auto');
  });

  it('shares the width when a column flexes', () => {
    renderGrid();
    const inner = screen.getByTestId('dg').firstElementChild as HTMLElement;
    expect(inner.style.minWidth).toBe('');
    expect(screen.getByTestId('dg')).not.toHaveClass('overflow-auto');
  });
});
