/**
 * The CSV export on ``<DataGrid />`` and the five grids built on it.
 *
 * Coverage:
 * - No menu unless the grid is given an ``exportPanel``.
 * - The file is named for the case and the panel; its header is the column
 *   labels, its rows are in the order the grid shows, its numbers are the raw
 *   values (not the 3-decimal ones on screen), and a missing value is empty.
 * - A sort the user picked is the order of the file.
 * - An empty grid keeps its empty state and has the menu off.
 * - The menu sits outside the keyboard-scoped grid: Enter on its button opens
 *   it and does not select the focused row.
 * - Each bucket grid offers it under its own panel name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

let mockTopology: TopologySummary | null = null;
vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return { ...actual, useCurrentTopology: () => mockTopology };
});

import { BusesGrid } from '@/components/data-grid/BusesGrid';
import { DataGrid, type ColumnConfig } from '@/components/data-grid/DataGrid';
import { GeneratorsGrid } from '@/components/data-grid/GeneratorsGrid';
import { LinesGrid } from '@/components/data-grid/LinesGrid';
import { LoadsGrid } from '@/components/data-grid/LoadsGrid';
import { ShuntsGrid } from '@/components/data-grid/ShuntsGrid';
import { useCaseStore } from '@/store/case';
import { parseWorkspacePath } from '@/api/types';
import type { TopologySummary } from '@/api/types';
import {
  captureDownloads,
  exportAs,
  readBlob,
  type DownloadCapture,
} from '../../helpers/downloads';

interface Row {
  id: string;
  name: string;
  v: number | null;
}

const COLUMNS: ColumnConfig<Row>[] = [
  { key: 'id', label: 'idx', accessor: (r) => r.id },
  { key: 'name', label: 'name', accessor: (r) => r.name },
  { key: 'v', label: 'V (pu)', numeric: true, accessor: (r) => r.v },
];

const ROWS: Row[] = [
  { id: '1', name: 'Bus 1', v: 1.0612345 },
  { id: '2', name: 'Bus, 2', v: null },
  { id: '3', name: 'Bus 3', v: 0.98 },
];

let downloads: DownloadCapture;

beforeEach(() => {
  downloads = captureDownloads();
  mockTopology = null;
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('cases/ieee14.raw'), addfiles: [] },
  });
});

afterEach(() => {
  downloads.restore();
  cleanup();
  useCaseStore.setState({ selection: null });
});

function renderGrid(props: { exportPanel?: string; rows?: Row[]; onRowClick?: () => void } = {}) {
  return render(
    <DataGrid<Row>
      columns={COLUMNS}
      rows={props.rows ?? ROWS}
      rowIdAccessor={(r) => r.id}
      onRowClick={props.onRowClick}
      testId="dg"
      exportPanel={props.exportPanel}
    />,
  );
}

describe('<DataGrid /> export', () => {
  it('has no menu unless it is given an export panel', () => {
    renderGrid();
    expect(screen.queryByTestId('export-menu-trigger')).toBeNull();
  });

  it('offers CSV only', async () => {
    const user = userEvent.setup();
    renderGrid({ exportPanel: 'buses' });
    await user.click(screen.getByTestId('export-menu-trigger'));
    expect(await screen.findByTestId('export-menu-csv')).toBeEnabled();
    expect(screen.queryByTestId('export-menu-png')).toBeNull();
    expect(screen.queryByTestId('export-menu-mat')).toBeNull();
  });

  it('writes the column labels, then the rows at full precision, in grid order', async () => {
    const user = userEvent.setup();
    renderGrid({ exportPanel: 'buses' });
    await exportAs(user, 'csv');
    expect(downloads.filenames[0]).toMatch(
      /^ieee14_buses_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.csv$/,
    );
    expect(await readBlob(downloads.blobs[0]!)).toBe(
      'idx,name,V (pu)\n1,Bus 1,1.0612345\n2,"Bus, 2",\n3,Bus 3,0.98\n',
    );
  });

  it('writes the rows in the order of the sort the user picked', async () => {
    const user = userEvent.setup();
    renderGrid({ exportPanel: 'buses' });
    // First click on a header sorts ascending; the missing value goes last.
    await user.click(screen.getByTestId('dg-header-v'));
    await exportAs(user, 'csv');
    const lines = (await readBlob(downloads.blobs[0]!)).split('\n');
    expect(lines.slice(1, 4).map((l) => l.split(',')[0])).toEqual(['3', '1', '2']);
  });

  it('keeps the empty state and turns the menu off when there are no rows', () => {
    renderGrid({ exportPanel: 'buses', rows: [] });
    expect(screen.getByTestId('dg-empty')).toBeInTheDocument();
    expect(screen.getByTestId('export-menu-trigger')).toBeDisabled();
  });

  it('opens on Enter without selecting the focused row', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    renderGrid({ exportPanel: 'buses', onRowClick });

    // Control: Enter on the grid itself selects the focused row.
    screen.getByTestId('dg').focus();
    await user.keyboard('{Enter}');
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).toHaveBeenCalledWith('1');
    onRowClick.mockClear();

    // Enter on the menu's button opens the menu and leaves the rows alone.
    screen.getByTestId('export-menu-trigger').focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByTestId('export-menu-csv')).toBeInTheDocument();
    expect(onRowClick).not.toHaveBeenCalled();
  });
});

describe('bucket grids export', () => {
  const TOPOLOGY: TopologySummary = {
    state: 'pre-setup',
    buses: [{ idx: 1, name: 'Bus1', kind: 'Bus', params: { Vn: 138, area: 1, zone: 1 } }],
    lines: [
      {
        idx: 'L1',
        name: 'Line1',
        kind: 'Line',
        params: { bus1: 1, bus2: 1, r: 0.01, x: 0.1, b: 0 },
      },
    ],
    transformers: [],
    generators: [{ idx: 'G1', name: 'Gen1', kind: 'PV', params: { bus: 1, p0: 1, v0: 1 } }],
    loads: [{ idx: 'D1', name: 'Load1', kind: 'PQ', params: { bus: 1, p0: 1, q0: 0.1 } }],
    shunts: [{ idx: 'S1', name: 'Shunt1', kind: 'Shunt', params: { bus: 1, g: 0, b: 0.1 } }],
  } as unknown as TopologySummary;

  const CASES: ReadonlyArray<[string, () => React.ReactElement, string]> = [
    ['BusesGrid', () => <BusesGrid />, 'buses'],
    ['LinesGrid', () => <LinesGrid />, 'lines'],
    ['GeneratorsGrid', () => <GeneratorsGrid />, 'generators'],
    ['LoadsGrid', () => <LoadsGrid />, 'loads'],
    ['ShuntsGrid', () => <ShuntsGrid />, 'shunts'],
  ];

  it.each(CASES)('%s exports under its own panel name', async (_name, grid, panel) => {
    const user = userEvent.setup();
    mockTopology = TOPOLOGY;
    render(grid());
    await exportAs(user, 'csv');
    expect(downloads.filenames[0]).toMatch(new RegExp(`^ieee14_${panel}_.*\\.csv$`));
    const header = (await readBlob(downloads.blobs[0]!)).split('\n')[0];
    expect(header).toContain('idx');
  });
});
