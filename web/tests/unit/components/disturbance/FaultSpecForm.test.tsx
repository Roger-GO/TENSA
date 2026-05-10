/**
 * FaultSpecForm — bus_idx / tf / tc / xf / rf with substrate-shape
 * field names; validation enforces tc > tf and finite numerics.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { FaultSpecForm } from '@/components/disturbance/FaultSpecForm';
import { blankFaultSpec } from '@/store/disturbance';
import type { FaultSpec, TopologySummary } from '@/api/types';

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

beforeEach(() => {
  MOCK_TOPOLOGY = {
    state: 'pre-setup',
    buses: [
      { idx: '1', name: 'BUS1', kind: 'Bus', params: {} },
      { idx: '5', name: 'BUS5', kind: 'Bus', params: {} },
    ],
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
    shunts: [],
  };
});

describe('<FaultSpecForm />', () => {
  it('renders bus / tf / tc / xf / rf fields', () => {
    const onChange = vi.fn();
    render(
      withQueryClient(
        <FaultSpecForm spec={{ ...blankFaultSpec(), bus_idx: '1' }} onChange={onChange} />,
      ),
    );
    expect(screen.getByTestId('fault-spec-form')).toBeInTheDocument();
    expect(screen.getByTestId('field-fault-tf')).toBeInTheDocument();
    expect(screen.getByTestId('field-fault-tc')).toBeInTheDocument();
    expect(screen.getByTestId('field-fault-xf')).toBeInTheDocument();
    expect(screen.getByTestId('field-fault-rf')).toBeInTheDocument();
    // BusIdxSelect is rendered inside.
    expect(screen.getByTestId('bus-idx-select')).toBeInTheDocument();
  });

  it('reports an error when tc <= tf and clears it when tc > tf', () => {
    let validity: Record<string, string> = {};
    const onValidityChange = vi.fn((errs: Record<string, string>) => {
      validity = errs;
    });
    const { rerender } = render(
      withQueryClient(
        <FaultSpecForm
          spec={{ ...blankFaultSpec(), bus_idx: '1', tf: 1.0, tc: 0.5 }}
          onChange={() => {}}
          onValidityChange={onValidityChange}
        />,
      ),
    );
    expect(validity.tc).toBeDefined();
    expect(screen.getByTestId('error-fault-tc')).toBeInTheDocument();

    // Bump tc above tf — error should clear.
    rerender(
      withQueryClient(
        <FaultSpecForm
          spec={{ ...blankFaultSpec(), bus_idx: '1', tf: 1.0, tc: 1.5 }}
          onChange={() => {}}
          onValidityChange={onValidityChange}
        />,
      ),
    );
    expect(validity.tc).toBeUndefined();
    expect(screen.queryByTestId('error-fault-tc')).toBeNull();
  });

  it('flags missing bus_idx as required', () => {
    let validity: Record<string, string> = {};
    render(
      withQueryClient(
        <FaultSpecForm
          spec={{ ...blankFaultSpec(), bus_idx: '' }}
          onChange={() => {}}
          onValidityChange={(errs) => {
            validity = errs;
          }}
        />,
      ),
    );
    expect(validity.bus_idx).toBe('Required');
  });

  it('updates the spec when the user edits tf', async () => {
    const user = userEvent.setup();
    let current: FaultSpec = { ...blankFaultSpec(), bus_idx: '1' };
    const onChange = vi.fn((next: FaultSpec) => {
      current = next;
    });
    render(withQueryClient(<FaultSpecForm spec={current} onChange={onChange} />));
    const input = screen.getByTestId('field-fault-tf') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '2.5');
    // Final onChange call should have tf=2.5.
    expect(onChange).toHaveBeenCalled();
    expect(current.tf).toBe(2.5);
  });
});
