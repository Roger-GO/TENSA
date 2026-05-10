/**
 * ToggleSpecForm — model picker drives the dev_idx dropdown options.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { ToggleSpecForm } from '@/components/disturbance/ToggleSpecForm';
import { blankToggleSpec } from '@/store/disturbance';
import type { ToggleSpec, TopologySummary } from '@/api/types';

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
    buses: [],
    lines: [
      { idx: '7', name: 'LINE7', kind: 'Line', params: {} },
      { idx: '8', name: 'LINE8', kind: 'Line', params: {} },
    ],
    transformers: [],
    generators: [
      { idx: 'G1', name: 'GEN1', kind: 'GENROU', params: {} },
      { idx: 'G2', name: 'GEN2', kind: 'PV', params: {} },
    ],
    loads: [],
    shunts: [],
  };
});

describe('<ToggleSpecForm />', () => {
  it('lists the chosen model devices in the dev_idx dropdown', () => {
    let current: ToggleSpec = { ...blankToggleSpec(), model: 'Line' };
    render(
      withQueryClient(<ToggleSpecForm spec={current} onChange={(next) => (current = next)} />),
    );
    const dev = screen.getByTestId('toggle-dev-idx') as HTMLSelectElement;
    const options = Array.from(dev.querySelectorAll('option'))
      .map((o) => o.value)
      .filter((v) => v.length > 0);
    expect(options).toEqual(['7', '8']);
  });

  it('changing the model resets dev_idx and refilters the dropdown', async () => {
    const user = userEvent.setup();
    let current: ToggleSpec = { ...blankToggleSpec(), model: 'Line', dev_idx: '7' };
    const onChange = vi.fn((next: ToggleSpec) => {
      current = next;
    });
    const { rerender } = render(
      withQueryClient(<ToggleSpecForm spec={current} onChange={onChange} />),
    );
    await user.selectOptions(screen.getByTestId('toggle-model'), 'GENROU');
    // The form fires onChange with model=GENROU and dev_idx reset.
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'GENROU', dev_idx: '' }),
    );
    // Re-render with the new spec; dropdown should now list GENROU devices.
    rerender(withQueryClient(<ToggleSpecForm spec={current} onChange={onChange} />));
    const dev = screen.getByTestId('toggle-dev-idx') as HTMLSelectElement;
    const options = Array.from(dev.querySelectorAll('option'))
      .map((o) => o.value)
      .filter((v) => v.length > 0);
    expect(options).toEqual(['G1']);
  });

  it('flags an empty dev_idx as required', () => {
    let validity: Record<string, string> = {};
    render(
      withQueryClient(
        <ToggleSpecForm
          spec={{ ...blankToggleSpec(), model: 'Line', dev_idx: '' }}
          onChange={() => {}}
          onValidityChange={(errs) => {
            validity = errs;
          }}
        />,
      ),
    );
    expect(validity.dev_idx).toBe('Required');
  });

  it('disables the dev dropdown when the model has no devices in the topology', () => {
    render(
      withQueryClient(
        <ToggleSpecForm spec={{ ...blankToggleSpec(), model: 'Shunt' }} onChange={() => {}} />,
      ),
    );
    const dev = screen.getByTestId('toggle-dev-idx') as HTMLSelectElement;
    expect(dev).toBeDisabled();
    expect(dev.querySelector('option')?.textContent).toMatch(/No Shunts/i);
  });
});
