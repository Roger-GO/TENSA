/**
 * BusIdxSelect — dropdown of existing buses for ElementForm `bus_idx`
 * fields.
 *
 * Tests stub `useCurrentTopology()` to drive the empty-state vs.
 * populated-state branch and assert the onChange callback fires with
 * the selected bus idx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { BusIdxSelect } from '@/components/elements/BusIdxSelect';
import type { TopologyEntry, TopologySummary } from '@/api/types';

let MOCK_TOPOLOGY: TopologySummary | null = null;

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useCurrentTopology: () => MOCK_TOPOLOGY,
  };
});

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function bus(idx: number | string, name: string): TopologyEntry {
  return { idx, name, kind: 'Bus', params: {} };
}

function topology(buses: TopologyEntry[]): TopologySummary {
  return {
    state: 'pre-setup',
    buses,
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
    shunts: [],
  };
}

beforeEach(() => {
  MOCK_TOPOLOGY = null;
});

describe('<BusIdxSelect />', () => {
  it('renders the empty-state placeholder when topology has no buses', () => {
    MOCK_TOPOLOGY = topology([]);
    render(withQueryClient(<BusIdxSelect value="" onChange={() => {}} />));
    expect(screen.getByText(/Add a Bus first\./i)).toBeInTheDocument();
    // The select itself is disabled in the empty state.
    const selects = screen.getAllByRole('combobox');
    expect(selects[0]).toBeDisabled();
    // No bus-idx-select test id (that is the populated-state element).
    expect(screen.queryByTestId('bus-idx-select')).toBeNull();
  });

  it('renders the empty-state when topology is null', () => {
    MOCK_TOPOLOGY = null;
    render(withQueryClient(<BusIdxSelect value="" onChange={() => {}} />));
    expect(screen.getByText(/Add a Bus first\./i)).toBeInTheDocument();
  });

  it('renders one option per bus, each as `<idx> — <name>`', () => {
    MOCK_TOPOLOGY = topology([bus(1, 'BUS1'), bus(2, 'BUS2'), bus('9', 'BUS9')]);
    render(withQueryClient(<BusIdxSelect value="" onChange={() => {}} />));
    const select = screen.getByTestId('bus-idx-select');
    expect(select).toBeInTheDocument();
    expect(select).not.toBeDisabled();
    // Placeholder + 3 bus options = 4 options.
    const options = Array.from(select.querySelectorAll('option'));
    expect(options.length).toBe(4);
    expect(options[0]?.textContent).toMatch(/Pick a bus/i);
    expect(options[1]?.textContent).toContain('1 — BUS1');
    expect(options[2]?.textContent).toContain('2 — BUS2');
    expect(options[3]?.textContent).toContain('9 — BUS9');
  });

  it('reflects the controlled `value` prop in the select', () => {
    MOCK_TOPOLOGY = topology([bus(1, 'BUS1'), bus(2, 'BUS2')]);
    render(withQueryClient(<BusIdxSelect value="2" onChange={() => {}} />));
    const select = screen.getByTestId('bus-idx-select') as HTMLSelectElement;
    expect(select.value).toBe('2');
  });

  it('fires onChange with the selected idx string when the user picks a bus', async () => {
    MOCK_TOPOLOGY = topology([bus(1, 'BUS1'), bus(2, 'BUS2')]);
    const onChange = vi.fn();
    render(withQueryClient(<BusIdxSelect value="" onChange={onChange} />));
    const select = screen.getByTestId('bus-idx-select') as HTMLSelectElement;
    await userEvent.selectOptions(select, '2');
    expect(onChange).toHaveBeenCalledWith('2');
  });

  it('forwards the `id` and `aria-describedby` props to the select', () => {
    MOCK_TOPOLOGY = topology([bus(1, 'BUS1')]);
    render(
      withQueryClient(
        <BusIdxSelect
          id="test-bus-id"
          aria-describedby="error-id"
          value=""
          onChange={() => {}}
        />,
      ),
    );
    const select = screen.getByTestId('bus-idx-select');
    expect(select).toHaveAttribute('id', 'test-bus-id');
    expect(select).toHaveAttribute('aria-describedby', 'error-id');
  });

  it('honors the `required` flag on the select (form-level required gate)', () => {
    MOCK_TOPOLOGY = topology([bus(1, 'BUS1')]);
    render(withQueryClient(<BusIdxSelect value="" required onChange={() => {}} />));
    const select = screen.getByTestId('bus-idx-select');
    expect(select).toBeRequired();
  });
});
