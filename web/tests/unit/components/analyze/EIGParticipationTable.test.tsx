/**
 * Tests for ``<EIGParticipationTable />`` (Unit 6).
 *
 * Coverage:
 * - Empty-state branches: no selection (rows undefined + selected=null);
 *   empty rows array.
 * - Renders rows sorted by descending |factor|.
 * - Cap at SORTED_TOP_N=200 with a footer note.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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
    expect(ranked.map((r) => r.state_name)).toEqual([
      'delta_1',
      'delta_2',
      'omega_1',
      'omega_2',
    ]);
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
    // Rows sorted by |factor| descending.
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

  it('shows the truncation footer when more than 200 rows', () => {
    const huge: ParticipationFactor[] = Array.from(
      { length: 250 },
      (_, i) => ({
        state_name: `s_${i}`,
        factor: i,
      }),
    );
    render(withQueryClient(<EIGParticipationTable rows={huge} />));
    expect(
      screen.getByText(/showing top 200 of 250/i),
    ).toBeInTheDocument();
  });
});
