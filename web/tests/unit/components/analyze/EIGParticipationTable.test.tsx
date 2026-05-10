/**
 * Tests for ``<EIGParticipationTable />`` (Unit 6 + Unit 16).
 *
 * Unit 6 coverage:
 * - Empty-state branches: no selection (rows undefined + selected=null);
 *   empty rows array.
 * - Renders rows sorted by descending |factor|.
 *
 * Unit 16 coverage:
 * - Click column header → rows reorder; cycle through asc/desc/none.
 * - Filter input narrows visible rows; clearing restores full view.
 * - 334-row synthetic input → renders virtualized list (DOM-row count
 *   stays well below the row count).
 * - Filter with no matches → ``participation-empty-filter`` state.
 * - Sort survives filter changes.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  EIGParticipationTable,
  rankParticipation,
} from '@/components/analyze/EIGParticipationTable';
import type { ParticipationFactor } from '@/api/types';

function withQueryClient(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

const ROWS: ParticipationFactor[] = [
  { state_name: 'omega_2', factor: 0.05 },
  { state_name: 'delta_1', factor: 0.92 },
  { state_name: 'omega_1', factor: 0.41 },
  { state_name: 'delta_2', factor: -0.6 },
];

describe('rankParticipation (pure helper)', () => {
  it('sorts by descending |factor|', () => {
    const { ranked, total } = rankParticipation(ROWS);
    expect(total).toBe(4);
    expect(ranked.map((r) => r.state_name)).toEqual(['delta_1', 'delta_2', 'omega_1', 'omega_2']);
  });

  it('caps to maxRows', () => {
    const huge: ParticipationFactor[] = Array.from({ length: 500 }, (_, i) => ({
      state_name: `s_${i}`,
      factor: i,
    }));
    const { ranked, total } = rankParticipation(huge, 100);
    expect(total).toBe(500);
    expect(ranked.length).toBe(100);
    expect(ranked[0]?.state_name).toBe('s_499');
  });
});

describe('<EIGParticipationTable />', () => {
  it('renders the empty-state when rows prop is undefined and no selection', () => {
    render(withQueryClient(<EIGParticipationTable />));
    const tbl = screen.getByTestId('eig-participation-table');
    expect(tbl.textContent).toMatch(/click an eigenvalue/i);
  });

  it('renders rows when given an explicit prop', () => {
    render(withQueryClient(<EIGParticipationTable rows={ROWS} />));
    const tbl = screen.getByTestId('eig-participation-table');
    // Default ordering: descending |factor|.
    const row0 = within(tbl).getByTestId('eig-participation-row-0');
    expect(row0.textContent).toMatch(/delta_1/);
    const row1 = within(tbl).getByTestId('eig-participation-row-1');
    expect(row1.textContent).toMatch(/delta_2/);
  });

  it('renders the empty rows message when rows is an empty array', () => {
    render(withQueryClient(<EIGParticipationTable rows={[]} />));
    const tbl = screen.getByTestId('eig-participation-table');
    expect(tbl.textContent).toMatch(/no participation factors/i);
  });
});

describe('<EIGParticipationTable /> sort', () => {
  it('reorders rows when the State header is clicked (asc → desc → none)', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<EIGParticipationTable rows={ROWS} />));
    const stateHeader = screen.getByTestId('participation-header-state');

    // Initial: |factor|-desc → delta_1, delta_2, omega_1, omega_2.
    expect(screen.getByTestId('eig-participation-row-0').textContent).toMatch(/delta_1/);

    // Click 1 → ascending lexicographic.
    await user.click(stateHeader);
    expect(screen.getByTestId('eig-participation-row-0').textContent).toMatch(/delta_1/);
    expect(screen.getByTestId('eig-participation-row-3').textContent).toMatch(/omega_2/);

    // Click 2 → descending lexicographic.
    await user.click(stateHeader);
    expect(screen.getByTestId('eig-participation-row-0').textContent).toMatch(/omega_2/);

    // Click 3 → back to default (|factor| desc).
    await user.click(stateHeader);
    expect(screen.getByTestId('eig-participation-row-0').textContent).toMatch(/delta_1/);
  });

  it('reorders rows when the Factor header is clicked', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<EIGParticipationTable rows={ROWS} />));
    const factorHeader = screen.getByTestId('participation-header-factor');

    // Click 1 → ascending signed factor → delta_2 (-0.6) first.
    await user.click(factorHeader);
    expect(screen.getByTestId('eig-participation-row-0').textContent).toMatch(/delta_2/);

    // Click 2 → descending signed factor → delta_1 (0.92) first.
    await user.click(factorHeader);
    expect(screen.getByTestId('eig-participation-row-0').textContent).toMatch(/delta_1/);
  });
});

describe('<EIGParticipationTable /> filter', () => {
  it('narrows rows by case-insensitive substring on state name', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<EIGParticipationTable rows={ROWS} />));
    const input = screen.getByTestId('participation-filter-input') as HTMLInputElement;

    await user.type(input, 'delta');
    // Only delta rows should appear.
    expect(screen.getByTestId('eig-participation-row-0').textContent).toMatch(/delta/);
    expect(screen.getByTestId('eig-participation-row-1').textContent).toMatch(/delta/);
    expect(screen.queryByTestId('eig-participation-row-2')).toBeNull();
  });

  it('shows the empty-filter state when no rows match', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<EIGParticipationTable rows={ROWS} />));
    const input = screen.getByTestId('participation-filter-input') as HTMLInputElement;

    await user.type(input, 'no_such_state');
    expect(screen.getByTestId('participation-empty-filter')).toBeInTheDocument();
    expect(screen.queryByTestId('eig-participation-row-0')).toBeNull();
  });

  it('restores full sorted view when the filter is cleared', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<EIGParticipationTable rows={ROWS} />));
    const stateHeader = screen.getByTestId('participation-header-state');
    const input = screen.getByTestId('participation-filter-input') as HTMLInputElement;

    // Sort by state ascending, then filter, then clear.
    await user.click(stateHeader);
    await user.type(input, 'delta');
    expect(screen.getByTestId('eig-participation-row-0').textContent).toMatch(/delta_1/);
    await user.clear(input);
    // All four rows back, still sorted ascending by state.
    expect(screen.getByTestId('eig-participation-row-0').textContent).toMatch(/delta_1/);
    expect(screen.getByTestId('eig-participation-row-3').textContent).toMatch(/omega_2/);
  });
});

describe('<EIGParticipationTable /> virtualization', () => {
  it('uses react-window when row count exceeds the threshold', () => {
    // 334-row synthetic input — matches the NPCC 140-bus participation
    // table size. With virtualization the rendered DOM-row count stays
    // far below the data row count regardless of scroll position.
    const huge: ParticipationFactor[] = Array.from({ length: 334 }, (_, i) => ({
      state_name: `s_${i.toString().padStart(3, '0')}`,
      factor: (i % 7) * 0.13,
    }));
    render(withQueryClient(<EIGParticipationTable rows={huge} />));

    // Sanity: the table shell rendered.
    const tbl = screen.getByTestId('eig-participation-table');
    expect(tbl).toBeInTheDocument();

    // Virtualized path renders <div role="row"/> headers + a
    // react-window container. Below the fold rows aren't in the DOM.
    const renderedRows = tbl.querySelectorAll('[data-testid^="eig-participation-row-"]');
    expect(renderedRows.length).toBeLessThan(60);
    // And we definitely rendered SOME rows (not the empty-filter state).
    expect(renderedRows.length).toBeGreaterThan(0);
  });

  it('renders a regular table at or below the virtualization threshold', () => {
    const small: ParticipationFactor[] = Array.from({ length: 50 }, (_, i) => ({
      state_name: `s_${i}`,
      factor: i,
    }));
    render(withQueryClient(<EIGParticipationTable rows={small} />));
    const tbl = screen.getByTestId('eig-participation-table');
    // <table> path means all 50 rows are present.
    const renderedRows = tbl.querySelectorAll('[data-testid^="eig-participation-row-"]');
    expect(renderedRows.length).toBe(50);
  });
});
