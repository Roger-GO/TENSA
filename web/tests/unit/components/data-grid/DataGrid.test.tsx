/**
 * Tests for the generic ``<DataGrid />`` (v3 Unit 12).
 *
 * Coverage:
 *
 *  - Renders rows + numeric / text formatting (null → ``—``).
 *  - Click-to-sort header cycles asc → desc → none.
 *  - Row click fires onRowClick with the rowId.
 *  - Selected row carries data-selected="true" + ring class.
 *  - Empty-state slot renders when rows are empty.
 *  - Virtualization kicks in only above 50 rows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DataGrid, type ColumnConfig } from '@/components/data-grid/DataGrid';

interface FixtureRow {
  id: string;
  name: string;
  v: number | null;
}

const COLUMNS: ColumnConfig<FixtureRow>[] = [
  { key: 'id', label: 'idx', accessor: (r) => r.id },
  { key: 'name', label: 'name', accessor: (r) => r.name },
  { key: 'v', label: 'V', numeric: true, accessor: (r) => r.v },
];

afterEach(() => cleanup());

describe('<DataGrid /> — rendering', () => {
  it('renders header + each row with numeric formatting', () => {
    render(
      <DataGrid<FixtureRow>
        columns={COLUMNS}
        rows={[
          { id: '1', name: 'Bus1', v: 1.025 },
          { id: '2', name: 'Bus2', v: null },
        ]}
        rowIdAccessor={(r) => r.id}
        testId="dg"
      />,
    );
    expect(screen.getByTestId('dg-row-1')).toBeInTheDocument();
    expect(screen.getByTestId('dg-row-2')).toBeInTheDocument();
    // Numeric value formats with toFixed(3).
    expect(screen.getByTestId('dg-row-1').textContent).toContain('1.025');
    // Null value renders em-dash.
    expect(screen.getByTestId('dg-row-2').textContent).toContain('—');
  });

  it('renders the empty-state slot when there are no rows', () => {
    render(
      <DataGrid<FixtureRow>
        columns={COLUMNS}
        rows={[]}
        rowIdAccessor={(r) => r.id}
        emptyState={<span>nothing yet</span>}
        testId="dg"
      />,
    );
    expect(screen.getByTestId('dg-empty')).toBeInTheDocument();
    expect(screen.getByText('nothing yet')).toBeInTheDocument();
  });
});

describe('<DataGrid /> — sort', () => {
  it('cycles asc → desc → none on header click', async () => {
    const user = userEvent.setup();
    render(
      <DataGrid<FixtureRow>
        columns={COLUMNS}
        rows={[
          { id: 'a', name: 'Bus_A', v: 0.95 },
          { id: 'b', name: 'Bus_B', v: 1.10 },
          { id: 'c', name: 'Bus_C', v: 1.00 },
        ]}
        rowIdAccessor={(r) => r.id}
        testId="dg"
      />,
    );

    const header = screen.getByTestId('dg-header-v');
    expect(header).toBeInTheDocument();

    // Initial: no sort. asc on first click.
    await user.click(header);
    let rows = screen.getAllByRole('row').filter((r) => r.getAttribute('data-testid'));
    expect(rows[0]?.getAttribute('data-testid')).toBe('dg-row-a');

    // Second click: desc.
    await user.click(header);
    rows = screen.getAllByRole('row').filter((r) => r.getAttribute('data-testid'));
    expect(rows[0]?.getAttribute('data-testid')).toBe('dg-row-b');

    // Third click: none — restores original input order.
    await user.click(header);
    rows = screen.getAllByRole('row').filter((r) => r.getAttribute('data-testid'));
    expect(rows[0]?.getAttribute('data-testid')).toBe('dg-row-a');
    expect(rows[1]?.getAttribute('data-testid')).toBe('dg-row-b');
    expect(rows[2]?.getAttribute('data-testid')).toBe('dg-row-c');
  });

  it('null values sort to the end regardless of direction', async () => {
    const user = userEvent.setup();
    render(
      <DataGrid<FixtureRow>
        columns={COLUMNS}
        rows={[
          { id: 'a', name: 'Bus_A', v: null },
          { id: 'b', name: 'Bus_B', v: 1.10 },
        ]}
        rowIdAccessor={(r) => r.id}
        testId="dg"
      />,
    );
    const header = screen.getByTestId('dg-header-v');
    await user.click(header); // asc
    const rows = screen.getAllByRole('row').filter((r) => r.getAttribute('data-testid'));
    // Bus_B (1.10) sorts before the null row.
    expect(rows[0]?.getAttribute('data-testid')).toBe('dg-row-b');
    expect(rows[1]?.getAttribute('data-testid')).toBe('dg-row-a');
  });
});

describe('<DataGrid /> — row interaction', () => {
  it('row click fires onRowClick with the row id', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(
      <DataGrid<FixtureRow>
        columns={COLUMNS}
        rows={[{ id: 'x', name: 'Bus_X', v: 1.0 }]}
        rowIdAccessor={(r) => r.id}
        onRowClick={onRowClick}
        testId="dg"
      />,
    );
    await user.click(screen.getByTestId('dg-row-x'));
    expect(onRowClick).toHaveBeenCalledWith('x');
  });

  it('selected row carries data-selected="true"', () => {
    render(
      <DataGrid<FixtureRow>
        columns={COLUMNS}
        rows={[
          { id: 'x', name: 'Bus_X', v: 1.0 },
          { id: 'y', name: 'Bus_Y', v: 1.0 },
        ]}
        rowIdAccessor={(r) => r.id}
        selectedRowId="x"
        testId="dg"
      />,
    );
    expect(screen.getByTestId('dg-row-x')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('dg-row-y')).toHaveAttribute('data-selected', 'false');
  });
});

describe('<DataGrid /> — virtualization threshold', () => {
  it('does NOT virtualize for 50 rows', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      id: `b${i}`,
      name: `Bus_${i}`,
      v: i / 100,
    }));
    render(
      <DataGrid<FixtureRow>
        columns={COLUMNS}
        rows={rows}
        rowIdAccessor={(r) => r.id}
        testId="dg"
      />,
    );
    expect(screen.queryByTestId('dg-virtual')).not.toBeInTheDocument();
  });

  it('virtualizes above 50 rows', () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({
      id: `b${i}`,
      name: `Bus_${i}`,
      v: i / 100,
    }));
    render(
      <DataGrid<FixtureRow>
        columns={COLUMNS}
        rows={rows}
        rowIdAccessor={(r) => r.id}
        testId="dg"
      />,
    );
    expect(screen.getByTestId('dg-virtual')).toBeInTheDocument();
  });
});
