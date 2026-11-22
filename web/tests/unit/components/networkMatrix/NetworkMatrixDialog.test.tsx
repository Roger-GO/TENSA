/**
 * The Network matrices dialog: opened through its store flag, the kind picker
 * re-issuing the query, the loading, error and data states, the windowed
 * sticky-header table labelled by key, the search, and the CSV download.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UseQueryResult } from '@tanstack/react-query';
import { ProblemDetailsError } from '@/api/client';
import type { NetworkMatrixResponse } from '@/api/queries';
import { NetworkMatrixDialog, WINDOW_ROWS } from '@/components/networkMatrix/NetworkMatrixDialog';
import { useNetworkMatrixStore } from '@/store/networkMatrix';
import { toast } from '@/lib/toast';

const refetch = vi.hoisted(() => vi.fn());
const downloadBlob = vi.hoisted(() => vi.fn());
const useNetworkMatrix = vi.hoisted(() => vi.fn());
let MOCK_QUERY: UseQueryResult<NetworkMatrixResponse, Error>;

vi.mock('@/api/queries', () => ({
  useNetworkMatrix: (kind: string, enabled: boolean) => useNetworkMatrix(kind, enabled),
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
  } as unknown as UseQueryResult<NetworkMatrixResponse, Error>;
  useNetworkMatrix.mockReturnValue(MOCK_QUERY);
}

/** A 3x3 PTDF: arcs on the rows (one with two parallel circuits), buses on the columns. */
const PTDF: NetworkMatrixResponse = {
  kind: 'ptdf',
  n_rows: 3,
  n_cols: 3,
  n_entries: 9,
  complex: false,
  base_mva: 100,
  rows: [
    { from: 1, to: 2, keys: ['branch:1-2-1'] },
    { from: 2, to: 3, keys: ['branch:2-3-1', 'branch:2-3-2'] },
    { from: 1, to: 3, keys: [] },
  ],
  cols: [
    { bus: 1, key: 'bus:1' },
    { bus: 2, key: 'bus:2' },
    { bus: 3, key: 'bus:3' },
  ],
  ref_buses: ['bus:1'],
  distributed_slack: false,
  values: [
    [0.1, -0.2, 0.3],
    [0.4, 0.5, -0.6],
    [-0.7, 0.8, 0.9],
  ],
};

const YBUS: NetworkMatrixResponse = {
  kind: 'ybus',
  n_rows: 2,
  n_cols: 2,
  n_entries: 3,
  complex: true,
  base_mva: 100,
  rows: [
    { bus: 1, key: 'bus:1' },
    { bus: 2, key: 'bus:2' },
  ],
  cols: [
    { bus: 1, key: 'bus:1' },
    { bus: 2, key: 'bus:2' },
  ],
  distributed_slack: false,
  entries: [
    { row: 0, col: 0, re: 1.5, im: -8.25 },
    { row: 0, col: 1, re: -1, im: 4 },
    { row: 1, col: 1, re: 2, im: 0.5 },
  ],
};

/** A dense matrix of `rows` x 2, the value of cell (i, j) being i + j / 10. */
function tallMatrix(rows: number): NetworkMatrixResponse {
  return {
    kind: 'ptdf',
    n_rows: rows,
    n_cols: 2,
    n_entries: rows * 2,
    complex: false,
    base_mva: 100,
    rows: Array.from({ length: rows }, (_, i) => ({
      from: i + 1,
      to: i + 2,
      keys: [`branch:${i + 1}`],
    })),
    cols: [
      { bus: 1, key: 'bus:1' },
      { bus: 2, key: 'bus:2' },
    ],
    ref_buses: ['bus:1'],
    distributed_slack: false,
    values: Array.from({ length: rows }, (_, i) => [i, i + 0.1]),
  };
}

beforeEach(() => {
  refetch.mockReset();
  downloadBlob.mockReset();
  useNetworkMatrix.mockReset();
  queryOf({});
  useNetworkMatrixStore.setState({ dialogOpen: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useNetworkMatrixStore.setState({ dialogOpen: false });
});

function openDialog() {
  useNetworkMatrixStore.setState({ dialogOpen: true });
  return render(<NetworkMatrixDialog />);
}

const rowIds = () =>
  screen.getAllByTestId(/^network-matrix-row-/).map((r) => r.getAttribute('data-testid') ?? '');

describe('NetworkMatrixDialog: states', () => {
  it('renders nothing while the store flag is false', () => {
    render(<NetworkMatrixDialog />);
    expect(screen.queryByTestId('network-matrix-dialog')).not.toBeInTheDocument();
  });

  it('opens on the store flag and says the matrix is being built while the query is pending', () => {
    queryOf({ isFetching: true });
    openDialog();
    expect(screen.getByTestId('network-matrix-dialog')).toBeInTheDocument();
    expect(screen.getByText('Building the matrix…')).toBeInTheDocument();
    expect(useNetworkMatrix).toHaveBeenCalledWith('ptdf', true);
  });

  it('shows the server detail of a refusal and no table', () => {
    const err = new ProblemDetailsError({
      type: 'about:blank',
      title: 'Unprocessable Entity',
      status: 422,
      detail: 'The PTDF matrix has 612345 entries, more than the 500000 one answer carries.',
      instance: null,
    });
    queryOf({ isError: true, error: err });
    openDialog();
    expect(screen.getByTestId('network-matrix-error')).toHaveTextContent(
      'The PTDF matrix has 612345 entries, more than the 500000 one answer carries.',
    );
    expect(screen.queryByTestId('network-matrix-table')).not.toBeInTheDocument();
  });
});

describe('NetworkMatrixDialog: the kind picker', () => {
  it('lists the four kinds and re-issues the query with the picked kind, resetting the search', async () => {
    queryOf({ data: PTDF });
    const user = userEvent.setup();
    openDialog();
    for (const kind of ['ptdf', 'lodf', 'ybus', 'incidence']) {
      expect(screen.getByTestId(`network-matrix-kind-${kind}`)).toBeInTheDocument();
    }
    await user.type(screen.getByTestId('network-matrix-search'), 'bus');
    await user.click(screen.getByTestId('network-matrix-kind-ybus'));
    expect(useNetworkMatrix).toHaveBeenLastCalledWith('ybus', true);
    expect(screen.getByTestId('network-matrix-search')).toHaveValue('');
  });
});

describe('NetworkMatrixDialog: the table', () => {
  it('labels rows and columns by key, an arc by its branch keys joined, and summarises the matrix', () => {
    queryOf({ data: PTDF });
    openDialog();
    expect(screen.getByTestId('network-matrix-meta').textContent).toBe(
      '3 × 3, 9 entries, base 100 MVA, reference bus:1',
    );
    const header = within(screen.getByTestId('network-matrix-table')).getAllByRole('columnheader');
    expect(header.map((h) => h.textContent)).toEqual(['', 'bus:1', 'bus:2', 'bus:3']);
    const rowHeader = (id: string) =>
      within(screen.getByTestId(id)).getAllByRole('rowheader')[0]!.textContent;
    expect(rowHeader('network-matrix-row-0')).toBe('branch:1-2-1');
    // Parallel circuits share an arc: their keys are joined.
    expect(rowHeader('network-matrix-row-1')).toBe('branch:2-3-1, branch:2-3-2');
    // An arc with no key is labelled by its bus numbers.
    expect(rowHeader('network-matrix-row-2')).toBe('1-3');
    // Sticky headers: the column row sticks to the top, the row headers to the left.
    expect(header[1]!.className).toContain('sticky');
    expect(header[1]!.className).toContain('top-0');
    const firstRowHeader = within(screen.getByTestId('network-matrix-row-0')).getAllByRole(
      'rowheader',
    )[0]!;
    expect(firstRowHeader.className).toContain('sticky');
    expect(firstRowHeader.className).toContain('left-0');
    // Dense cells at six significant digits.
    const cells = within(screen.getByTestId('network-matrix-row-0')).getAllByRole('cell');
    expect(cells.map((c) => c.textContent)).toEqual(['0.100000', '-0.200000', '0.300000']);
  });

  it('renders a ybus from its entries as complex cells, empty where there is no entry', () => {
    queryOf({ data: YBUS });
    openDialog();
    expect(screen.getByTestId('network-matrix-meta').textContent).toBe(
      '2 × 2, 3 entries, base 100 MVA',
    );
    const row0 = within(screen.getByTestId('network-matrix-row-0')).getAllByRole('cell');
    expect(row0.map((c) => c.textContent)).toEqual(['1.500-8.250j', '-1.000+4.000j']);
    const row1 = within(screen.getByTestId('network-matrix-row-1')).getAllByRole('cell');
    expect(row1.map((c) => c.textContent)).toEqual(['', '2.000+0.5000j']);
  });

  it('windows a tall matrix and steps through it', async () => {
    queryOf({ data: tallMatrix(250) });
    const user = userEvent.setup();
    openDialog();
    expect(rowIds()).toHaveLength(WINDOW_ROWS);
    expect(screen.getByTestId('network-matrix-window').textContent).toBe(
      'Showing rows 1–100 of 250.',
    );
    expect(screen.getByTestId('network-matrix-prev')).toBeDisabled();
    await user.click(screen.getByTestId('network-matrix-next'));
    expect(screen.getByTestId('network-matrix-window').textContent).toBe(
      'Showing rows 101–200 of 250.',
    );
    expect(rowIds()[0]).toBe('network-matrix-row-100');
    await user.click(screen.getByTestId('network-matrix-next'));
    expect(screen.getByTestId('network-matrix-window').textContent).toBe(
      'Showing rows 201–250 of 250.',
    );
    expect(screen.getByTestId('network-matrix-next')).toBeDisabled();
    await user.click(screen.getByTestId('network-matrix-prev'));
    expect(screen.getByTestId('network-matrix-window').textContent).toBe(
      'Showing rows 101–200 of 250.',
    );
  });
});

describe('NetworkMatrixDialog: the search', () => {
  it('scrolls the hit into view and marks it', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    queryOf({ data: PTDF });
    const user = userEvent.setup();
    openDialog();
    await user.type(screen.getByTestId('network-matrix-search'), 'bus:3');
    expect(screen.getByTestId('network-matrix-hit')).toHaveTextContent('bus:3');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(screen.queryByTestId('network-matrix-no-match')).not.toBeInTheDocument();
  });

  it('matches an arc by its bus numbers when it has no key', async () => {
    queryOf({ data: PTDF });
    const user = userEvent.setup();
    openDialog();
    await user.type(screen.getByTestId('network-matrix-search'), '1-3');
    expect(screen.getByTestId('network-matrix-hit')).toHaveTextContent('1-3');
  });

  it('brings a hit outside the window into view', async () => {
    queryOf({ data: tallMatrix(250) });
    const user = userEvent.setup();
    openDialog();
    await user.type(screen.getByTestId('network-matrix-search'), 'branch:150');
    expect(screen.getByTestId('network-matrix-hit')).toHaveTextContent('branch:150');
    expect(screen.getByTestId('network-matrix-window').textContent).toBe(
      'Showing rows 101–200 of 250.',
    );
  });

  it('says when nothing matches', async () => {
    queryOf({ data: PTDF });
    const user = userEvent.setup();
    openDialog();
    await user.type(screen.getByTestId('network-matrix-search'), 'no such key');
    expect(screen.getByTestId('network-matrix-no-match')).toHaveTextContent(
      'No row or column key matches.',
    );
  });
});

describe('NetworkMatrixDialog: the CSV', () => {
  it('downloads a CSV whose header row is the column keys and whose first column is the row keys', async () => {
    const success = vi.spyOn(toast, 'success').mockReturnValue('id');
    queryOf({ data: PTDF });
    const user = userEvent.setup();
    openDialog();
    await user.click(screen.getByTestId('network-matrix-csv'));
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, filename] = downloadBlob.mock.calls[0]! as [Blob, string];
    expect(filename).toBe('ieee14-ptdf.csv');
    expect(await blob.text()).toBe(
      ',bus:1,bus:2,bus:3\n' +
        'branch:1-2-1,0.1,-0.2,0.3\n' +
        '"branch:2-3-1, branch:2-3-2",0.4,0.5,-0.6\n' +
        '1-3,-0.7,0.8,0.9\n',
    );
    expect(success).toHaveBeenCalledWith('Exported ieee14-ptdf.csv');
  });

  it('writes a ybus with a real and an imaginary column per column key', async () => {
    queryOf({ data: YBUS });
    const user = userEvent.setup();
    openDialog();
    await user.click(screen.getByTestId('network-matrix-csv'));
    const [blob, filename] = downloadBlob.mock.calls[0]! as [Blob, string];
    expect(filename).toBe('ieee14-ybus.csv');
    expect(await blob.text()).toBe(
      ',bus:1 re,bus:1 im,bus:2 re,bus:2 im\n' + 'bus:1,1.5,-8.25,-1,4\n' + 'bus:2,,,2,0.5\n',
    );
  });
});
