/**
 * The Ybus dialog: closed by default, a confirmation state that says what the
 * read does and fetches nothing until Read matrix is pressed, then loading,
 * error and data states with a filterable, sortable, paged table and the two
 * downloads. Closing forgets the matrix and the table's state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UseQueryResult } from '@tanstack/react-query';
import { ProblemDetailsError } from '@/api/client';
import type { components } from '@/api/generated';
import { YbusDialog } from '@/components/ybus/YbusDialog';
import { ybusToMatlab } from '@/components/ybus/ybusToMatlab';
import { useYbusDialogStore } from '@/store/ybusDialog';
import { toast } from '@/lib/toast';

type YbusResponse = components['schemas']['YbusResponse'];

const refetch = vi.hoisted(() => vi.fn());
const forget = vi.hoisted(() => vi.fn());
const downloadBlob = vi.hoisted(() => vi.fn());
let MOCK_QUERY: UseQueryResult<YbusResponse, Error>;

vi.mock('@/api/queries', () => ({
  useYbus: () => MOCK_QUERY,
  useForgetYbus: () => forget,
}));
vi.mock('@/components/export/downloadBlob', () => ({
  downloadBlob: (...args: unknown[]) => downloadBlob(...args),
}));
vi.mock('@/components/export/useExportCaseName', () => ({
  useExportCaseName: () => 'ieee14',
}));

function queryOf(overrides: Record<string, unknown>): void {
  MOCK_QUERY = {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    refetch,
    ...overrides,
  } as unknown as UseQueryResult<YbusResponse, Error>;
}

/**
 * Bus idx values that are not their positions, and a bus ``1`` beside a bus
 * ``10``: the table must show the idx, not the position, and a filter of
 * ``1`` must keep bus 1 and not bus 10.
 */
const MATRIX: YbusResponse = {
  n_bus: 3,
  base_mva: 100,
  bus_idx: ['10', '1', '9'],
  bus_key: [null, null, null],
  entries: [
    { row: 0, col: 0, re: 10, im: -8.25 },
    { row: 0, col: 1, re: 9, im: 4 },
    { row: 1, col: 1, re: -1, im: 0.1 + 0.2 },
    { row: 1, col: 2, re: 2.5, im: -1 },
    { row: 2, col: 2, re: 3, im: 0.5 },
    { row: 2, col: 0, re: 0.75, im: 2 },
  ],
};

/** A matrix of ``count`` entries over 200 buses, numbered from 1001. */
function wideMatrix(count: number): YbusResponse {
  const n = 200;
  return {
    n_bus: n,
    base_mva: 100,
    bus_idx: Array.from({ length: n }, (_, i) => String(1001 + i)),
    bus_key: Array.from({ length: n }, () => null),
    entries: Array.from({ length: count }, (_, i) => ({
      row: Math.floor(i / n) % n,
      col: i % n,
      re: i,
      im: -i,
    })),
  };
}

beforeEach(() => {
  refetch.mockReset();
  forget.mockReset();
  downloadBlob.mockReset();
  queryOf({});
  useYbusDialogStore.setState({ open: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useYbusDialogStore.setState({ open: false });
});

function openDialog() {
  useYbusDialogStore.setState({ open: true });
  return render(<YbusDialog />);
}

const rowIds = () =>
  screen.getAllByTestId(/^ybus-row-/).map((r) => r.getAttribute('data-testid') ?? '');

/** The bus idx of the row and column of each row shown. */
const rowBuses = () =>
  screen.getAllByTestId(/^ybus-row-/).map((r) => {
    const cells = within(r).getAllByRole('cell');
    return [cells[0]!.textContent, cells[1]!.textContent];
  });

describe('YbusDialog: before the read', () => {
  it('renders nothing while the store flag is false', () => {
    render(<YbusDialog />);
    expect(screen.queryByTestId('ybus-dialog')).not.toBeInTheDocument();
  });

  it('opens on the confirmation state, says what the read does, and fetches nothing yet', () => {
    openDialog();
    expect(screen.getByRole('dialog', { name: 'Admittance matrix (Ybus)' })).toBeInTheDocument();
    expect(screen.getByTestId('ybus-setup-note').textContent).toBe(
      'Reading the matrix sets the system up if it is not, as the connectivity check does: ' +
        'after that no disturbance can be added until the case is reloaded.',
    );
    expect(screen.queryByTestId('ybus-table')).not.toBeInTheDocument();
    expect(refetch).not.toHaveBeenCalled();
  });

  it('fetches once when Read matrix is clicked', async () => {
    openDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Read matrix' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows the loading panel while fetching, and no stale error with it', () => {
    queryOf({ isFetching: true, isError: true, error: new Error('earlier failure') });
    openDialog();
    expect(screen.getByTestId('ybus-loading')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ybus-setup-note')).not.toBeInTheDocument();
  });
});

describe('YbusDialog: a refusal', () => {
  it.each([
    [409, 'Conflict', 'No case has been loaded into this session yet.'],
    [
      422,
      'Unprocessable Entity',
      'The bus admittance matrix has 612345 nonzero entries, more than the 500000 one answer carries.',
    ],
    [
      422,
      'Unprocessable Entity',
      'ANDES setup() failed: reload the case (POST /api/sessions/{id}/reload) and try again.',
    ],
  ])(
    'shows the server detail of a %i and retries from the button',
    async (status, title, detail) => {
      const err = new ProblemDetailsError({
        type: 'about:blank',
        title,
        status,
        detail,
        instance: null,
      });
      queryOf({ isError: true, error: err });
      openDialog();
      expect(screen.getByRole('alert').textContent).toBe(detail);
      expect(screen.queryByTestId('ybus-setup-note')).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(refetch).toHaveBeenCalledTimes(1);
    },
  );

  it('shows the message of an error that is not the server refusing', () => {
    queryOf({ isError: true, error: new Error('Network error: the server did not answer') });
    openDialog();
    expect(screen.getByRole('alert').textContent).toBe('Network error: the server did not answer');
  });
});

describe('YbusDialog: the matrix', () => {
  it('summarises the matrix with its size, nonzeros and base', () => {
    queryOf({ data: MATRIX });
    openDialog();
    expect(screen.getByTestId('ybus-summary').textContent).toBe(
      '3 buses · 6 nonzeros · base 100 MVA',
    );
  });

  it('says there is no system base when base_mva is null', () => {
    queryOf({ data: { ...MATRIX, base_mva: null } });
    openDialog();
    expect(screen.getByTestId('ybus-summary').textContent).toBe(
      '3 buses · 6 nonzeros · no system base',
    );
  });

  it('lists one row per entry with the bus idx of row and column and G and B at full precision', () => {
    queryOf({ data: MATRIX });
    openDialog();
    expect(rowIds()).toEqual([
      'ybus-row-0-0',
      'ybus-row-0-1',
      'ybus-row-1-1',
      'ybus-row-1-2',
      'ybus-row-2-2',
      'ybus-row-2-0',
    ]);
    const cells = (id: string) =>
      within(screen.getByTestId(id))
        .getAllByRole('cell')
        .map((c) => c.textContent);
    expect(cells('ybus-row-0-1')).toEqual(['10', '1', '9', '4']);
    expect(cells('ybus-row-1-1')).toEqual(['1', '1', '-1', '0.30000000000000004']);
    expect(cells('ybus-row-2-0')).toEqual(['9', '10', '0.75', '2']);
  });

  it('filters by a bus: every entry with that bus as its row or its column, and no other', async () => {
    queryOf({ data: MATRIX });
    openDialog();
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Filter by bus idx' }), '1');
    // Bus 1 is the row of two entries and the column of a third; bus 10 is not bus 1.
    expect(rowIds()).toEqual(['ybus-row-0-1', 'ybus-row-1-1', 'ybus-row-1-2']);
    for (const [r, c] of rowBuses()) expect(r === '1' || c === '1').toBe(true);
    await user.clear(screen.getByTestId('ybus-filter'));
    expect(rowIds()).toHaveLength(6);
  });

  it('filters by part of an idx when no bus has the text as its whole idx', async () => {
    queryOf({ data: { ...MATRIX, bus_idx: ['Bus10', 'Bus1', 'Gen9'] } });
    openDialog();
    const user = userEvent.setup();
    await user.type(screen.getByTestId('ybus-filter'), 'bus');
    // Every entry that touches Bus10 or Bus1, the column side included.
    expect(rowIds()).toEqual([
      'ybus-row-0-0',
      'ybus-row-0-1',
      'ybus-row-1-1',
      'ybus-row-1-2',
      'ybus-row-2-0',
    ]);
    expect(screen.getByTestId('ybus-page').textContent).toBe('Page 1 of 1, 5 of 6 entries shown');
  });

  it('sorts G as a number: ascending on one click, descending on the next, server order on the third', async () => {
    queryOf({ data: MATRIX });
    openDialog();
    const user = userEvent.setup();
    const header = screen.getByRole('columnheader', { name: /G \(pu\)/ });
    await user.click(screen.getByRole('button', { name: /G \(pu\)/ }));
    // As text, 10 would come before 2.5 and 9.
    expect(rowIds()).toEqual([
      'ybus-row-1-1',
      'ybus-row-2-0',
      'ybus-row-1-2',
      'ybus-row-2-2',
      'ybus-row-0-1',
      'ybus-row-0-0',
    ]);
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    await user.click(screen.getByRole('button', { name: /G \(pu\)/ }));
    expect(rowIds()).toEqual([
      'ybus-row-0-0',
      'ybus-row-0-1',
      'ybus-row-2-2',
      'ybus-row-1-2',
      'ybus-row-2-0',
      'ybus-row-1-1',
    ]);
    expect(header).toHaveAttribute('aria-sort', 'descending');
    await user.click(screen.getByRole('button', { name: /G \(pu\)/ }));
    expect(rowIds()[0]).toBe('ybus-row-0-0');
    expect(header).toHaveAttribute('aria-sort', 'none');
  });

  it('sorts B as a number', async () => {
    queryOf({ data: MATRIX });
    openDialog();
    await userEvent.click(screen.getByTestId('ybus-sort-im'));
    const bs = screen
      .getAllByTestId(/^ybus-row-/)
      .map((r) => Number(within(r).getAllByRole('cell')[3]!.textContent));
    expect(bs).toEqual([-8.25, -1, 0.30000000000000004, 0.5, 2, 4]);
  });

  it('sorts the buses by their idx with the digits read as numbers (9 before 10)', async () => {
    queryOf({ data: MATRIX });
    openDialog();
    await userEvent.click(screen.getByRole('button', { name: /Row bus/ }));
    expect(rowBuses().map(([r]) => r)).toEqual(['1', '1', '9', '9', '10', '10']);
    await userEvent.click(screen.getByRole('button', { name: /Col bus/ }));
    expect(rowBuses().map(([, c]) => c)).toEqual(['1', '1', '9', '9', '10', '10']);
  });

  it('holds one page of 500 rows of a matrix of 20 000 entries in the document', async () => {
    const data = wideMatrix(20_000);
    queryOf({ data });
    openDialog();
    expect(screen.getAllByRole('row')).toHaveLength(501); // the header row and 500
    expect(screen.getByTestId('ybus-page').textContent).toBe('Page 1 of 40');
    expect(screen.getByTestId('ybus-prev')).toBeDisabled();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByTestId('ybus-page').textContent).toBe('Page 2 of 40');
    const ids = rowIds();
    expect(ids).toHaveLength(500);
    // Page 2 starts at entry 500 and ends at entry 999.
    expect(ids[0]).toBe('ybus-row-2-100');
    expect(ids[499]).toBe('ybus-row-4-199');
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(rowIds()[0]).toBe('ybus-row-0-0');
    // A filter goes back to the first page of what it keeps: bus 1001 is the
    // row of 200 entries and the column of 99 more.
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByTestId('ybus-filter'), '1001');
    expect(screen.getByTestId('ybus-page').textContent).toBe(
      'Page 1 of 1, 299 of 20000 entries shown',
    );
    expect(rowIds()).toHaveLength(299);
  });

  it('puts the 501st entry alone on a second page', async () => {
    queryOf({ data: wideMatrix(501) });
    openDialog();
    expect(rowIds()).toHaveLength(500);
    expect(screen.getByTestId('ybus-page').textContent).toBe('Page 1 of 2');
    await userEvent.click(screen.getByTestId('ybus-next'));
    expect(rowIds()).toEqual(['ybus-row-2-100']);
    expect(screen.getByTestId('ybus-next')).toBeDisabled();
  });

  it('keeps a matrix of exactly 500 entries on one page', () => {
    queryOf({ data: wideMatrix(500) });
    openDialog();
    expect(rowIds()).toHaveLength(500);
    expect(screen.getByTestId('ybus-page').textContent).toBe('Page 1 of 1');
    expect(screen.getByTestId('ybus-next')).toBeDisabled();
  });
});

describe('YbusDialog: downloads', () => {
  it('downloads the CSV of the rows as shown, filtered and sorted, and toasts the filename', async () => {
    const success = vi.spyOn(toast, 'success').mockReturnValue('id');
    queryOf({ data: MATRIX });
    openDialog();
    const user = userEvent.setup();
    await user.type(screen.getByTestId('ybus-filter'), '9');
    await user.click(screen.getByTestId('ybus-sort-re'));
    await user.click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, filename] = downloadBlob.mock.calls[0]! as [Blob, string];
    expect(filename).toMatch(/^ieee14_ybus_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.csv$/);
    expect(await blob.text()).toBe(
      'row_idx,col_idx,g_pu,b_pu\n9,10,0.75,2\n1,9,2.5,-1\n9,9,3,0.5\n',
    );
    expect(success).toHaveBeenCalledWith(`Exported ${filename}`);
  });

  it('downloads the whole matrix as MATLAB, whatever the table shows, under a name MATLAB can run', async () => {
    const success = vi.spyOn(toast, 'success').mockReturnValue('id');
    queryOf({ data: MATRIX });
    openDialog();
    const user = userEvent.setup();
    await user.type(screen.getByTestId('ybus-filter'), '9');
    await user.click(screen.getByRole('button', { name: 'Download MATLAB (.m)' }));
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, filename] = downloadBlob.mock.calls[0]! as [Blob, string];
    expect(filename).toMatch(/^ieee14_ybus_\d{4}_\d{2}_\d{2}T\d{2}_\d{2}_\d{2}\.m$/);
    expect(await blob.text()).toBe(await ybusToMatlab(MATRIX).text());
    expect(success).toHaveBeenCalledWith(`Exported ${filename}`);
  });
});

describe('YbusDialog: closing', () => {
  it('forgets the matrix and the filter on Escape, so it opens afresh', async () => {
    queryOf({ data: MATRIX });
    const user = userEvent.setup();
    openDialog();
    await user.type(screen.getByTestId('ybus-filter'), '9');
    await user.click(screen.getByTestId('ybus-sort-re'));
    await user.keyboard('{Escape}');
    expect(useYbusDialogStore.getState().open).toBe(false);
    expect(forget).toHaveBeenCalledTimes(1);
    // The dialog stays mounted once loaded (LazyMount), so open it again in place.
    useYbusDialogStore.setState({ open: true });
    expect(await screen.findByTestId('ybus-filter')).toHaveValue('');
    expect(rowIds()[0]).toBe('ybus-row-0-0');
    expect(screen.getByRole('columnheader', { name: /G \(pu\)/ })).toHaveAttribute(
      'aria-sort',
      'none',
    );
  });

  it('forgets the matrix when Cancel is pressed', async () => {
    openDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useYbusDialogStore.getState().open).toBe(false);
    expect(forget).toHaveBeenCalledTimes(1);
    expect(refetch).not.toHaveBeenCalled();
  });
});
