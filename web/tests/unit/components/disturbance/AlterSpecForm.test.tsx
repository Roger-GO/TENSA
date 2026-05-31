/**
 * AlterSpecForm — model + dev + src (from useAlterableParams) + t +
 * method + amount. ANDES's Alter model has no ``value``; the new value is
 * ``v_current <method> amount``.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { AlterSpecForm } from '@/components/disturbance/AlterSpecForm';
import { blankAlterSpec } from '@/store/disturbance';
import type { AlterSpec, TopologySummary } from '@/api/types';

let MOCK_TOPOLOGY: TopologySummary | null = null;
let MOCK_ALTER_PARAMS = {
  data: { model: '', params: ['p0', 'q0'] as string[] },
  isLoading: false,
};
const useAlterableParamsMock = vi.fn((_model: string | null) => MOCK_ALTER_PARAMS);

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useCurrentTopology: () => MOCK_TOPOLOGY,
    useAlterableParams: (model: string | null) => useAlterableParamsMock(model),
  };
});

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  useAlterableParamsMock.mockClear();
  MOCK_ALTER_PARAMS = {
    data: { model: 'PQ', params: ['p0', 'q0'] },
    isLoading: false,
  };
  MOCK_TOPOLOGY = {
    state: 'pre-setup',
    buses: [],
    lines: [],
    transformers: [],
    generators: [],
    loads: [
      { idx: 'L1', name: 'LOAD1', kind: 'PQ', params: {} },
      { idx: 'L2', name: 'LOAD2', kind: 'PQ', params: {} },
    ],
    shunts: [],
  };
});

describe('<AlterSpecForm />', () => {
  it('renders model + dev + src dropdowns + t + method + amount inputs', () => {
    render(
      withQueryClient(
        <AlterSpecForm
          spec={{ ...blankAlterSpec(), model: 'PQ', dev_idx: 'L1' }}
          onChange={() => {}}
        />,
      ),
    );
    expect(screen.getByTestId('alter-spec-form')).toBeInTheDocument();
    expect(screen.getByTestId('alter-model')).toBeInTheDocument();
    expect(screen.getByTestId('alter-dev-idx')).toBeInTheDocument();
    expect(screen.getByTestId('alter-src')).toBeInTheDocument();
    expect(screen.getByTestId('field-alter-t')).toBeInTheDocument();
    expect(screen.getByTestId('alter-method-select')).toBeInTheDocument();
    // Amount input keeps the old value-input testid for continuity.
    expect(screen.getByTestId('field-alter-value')).toBeInTheDocument();
  });

  it('renders the five method options and binds the select to spec.method', () => {
    render(
      withQueryClient(
        <AlterSpecForm
          spec={{ ...blankAlterSpec(), model: 'PQ', dev_idx: 'L1', method: '*' }}
          onChange={() => {}}
        />,
      ),
    );
    const method = screen.getByTestId('alter-method-select') as HTMLSelectElement;
    const values = Array.from(method.querySelectorAll('option')).map((o) => o.value);
    expect(values).toEqual(['=', '+', '-', '*', '/']);
    expect(method.value).toBe('*');
  });

  it('changing the method writes spec.method', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      withQueryClient(
        <AlterSpecForm
          spec={{ ...blankAlterSpec(), model: 'PQ', dev_idx: 'L1', method: '=' }}
          onChange={onChange}
        />,
      ),
    );
    await user.selectOptions(screen.getByTestId('alter-method-select'), '+');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ method: '+' }));
  });

  it('typing in the amount input writes a finite spec.amount', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      withQueryClient(
        <AlterSpecForm
          spec={{ ...blankAlterSpec(), model: 'PQ', dev_idx: 'L1' }}
          onChange={onChange}
        />,
      ),
    );
    const amount = screen.getByTestId('field-alter-value');
    await user.clear(amount);
    await user.type(amount, '0.2');
    // Last onChange call carries the fully-typed value.
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ amount: 0.2 }));
  });

  it('flags a non-finite amount as required', async () => {
    let validity: Record<string, string> = {};
    render(
      withQueryClient(
        <AlterSpecForm
          spec={{ ...blankAlterSpec(), model: 'PQ', dev_idx: 'L1', amount: Number.NaN }}
          onChange={() => {}}
          onValidityChange={(errs) => {
            validity = errs;
          }}
        />,
      ),
    );
    await waitFor(() => {
      expect(validity.amount).toMatch(/finite/i);
    });
  });

  it('shows the Ppf/Qpf hint for PQ loads only', () => {
    const { rerender } = render(
      withQueryClient(
        <AlterSpecForm spec={{ ...blankAlterSpec(), model: 'PQ' }} onChange={() => {}} />,
      ),
    );
    expect(screen.getByTestId('alter-pq-hint')).toBeInTheDocument();
    rerender(
      withQueryClient(
        <AlterSpecForm spec={{ ...blankAlterSpec(), model: 'GENROU' }} onChange={() => {}} />,
      ),
    );
    expect(screen.queryByTestId('alter-pq-hint')).not.toBeInTheDocument();
  });

  it('passes the chosen model to useAlterableParams + populates src dropdown', () => {
    render(
      withQueryClient(
        <AlterSpecForm spec={{ ...blankAlterSpec(), model: 'PQ' }} onChange={() => {}} />,
      ),
    );
    expect(useAlterableParamsMock).toHaveBeenCalledWith('PQ');
    const src = screen.getByTestId('alter-src') as HTMLSelectElement;
    const options = Array.from(src.querySelectorAll('option'))
      .map((o) => o.value)
      .filter((v) => v.length > 0);
    expect(options).toEqual(['p0', 'q0']);
  });

  it('changing the model resets dev_idx + src and re-fires useAlterableParams', async () => {
    const user = userEvent.setup();
    let current: AlterSpec = { ...blankAlterSpec(), model: 'PQ', dev_idx: 'L1', src: 'p0' };
    const onChange = vi.fn((next: AlterSpec) => {
      current = next;
    });
    render(withQueryClient(<AlterSpecForm spec={current} onChange={onChange} />));
    await user.selectOptions(screen.getByTestId('alter-model'), 'GENROU');
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'GENROU', dev_idx: '', src: '' }),
    );
  });

  it('disables src dropdown while alterable_params is loading', () => {
    MOCK_ALTER_PARAMS = { data: { model: '', params: [] }, isLoading: true };
    render(
      withQueryClient(
        <AlterSpecForm spec={{ ...blankAlterSpec(), model: 'PQ' }} onChange={() => {}} />,
      ),
    );
    const src = screen.getByTestId('alter-src') as HTMLSelectElement;
    expect(src).toBeDisabled();
    expect(src.querySelector('option')?.textContent).toMatch(/Loading/);
  });

  it('exposes Unit 8 dynamic models (IEEEX1, ESDC2A, IEEEG1, TGOV1, IEEEST, SEXS, REGCA1) in the model picker', () => {
    render(
      withQueryClient(
        <AlterSpecForm spec={{ ...blankAlterSpec(), model: 'PQ' }} onChange={() => {}} />,
      ),
    );
    const select = screen.getByTestId('alter-model') as HTMLSelectElement;
    const values = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    for (const m of ['IEEEX1', 'ESDC2A', 'IEEEG1', 'TGOV1', 'IEEEST', 'SEXS', 'REGCA1']) {
      expect(values).toContain(m);
    }
  });

  it('selecting a dynamic model with no devices in topology disables the device picker with explanation', async () => {
    const user = userEvent.setup();
    let current: AlterSpec = { ...blankAlterSpec(), model: 'PQ', dev_idx: 'L1' };
    const onChange = vi.fn((next: AlterSpec) => {
      current = next;
    });
    const { rerender } = render(
      withQueryClient(<AlterSpecForm spec={current} onChange={onChange} />),
    );
    await user.selectOptions(screen.getByTestId('alter-model'), 'IEEEX1');
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'IEEEX1', dev_idx: '', src: '' }),
    );
    // Re-render with the updated spec; topology mock has no IEEEX1 bucket so
    // devicesForModel returns []; the device picker should disable with an
    // empty-state placeholder.
    rerender(withQueryClient(<AlterSpecForm spec={current} onChange={onChange} />));
    const dev = screen.getByTestId('alter-dev-idx') as HTMLSelectElement;
    expect(dev).toBeDisabled();
    expect(dev.querySelector('option')?.textContent).toMatch(/No IEEEX1s in topology/);
  });

  it('Unit 8.1: populates device picker from topology.controllers for dynamic models', () => {
    // Seed the controllers bucket with two IEEEG1 entries + an unrelated
    // TGOV1; the IEEEG1 selection must pull only its kind.
    MOCK_TOPOLOGY = {
      ...(MOCK_TOPOLOGY as TopologySummary),
      controllers: [
        { idx: 'GOV_1', name: 'IEEEG1_1', kind: 'IEEEG1', params: {} },
        { idx: 'GOV_2', name: 'IEEEG1_2', kind: 'IEEEG1', params: {} },
        { idx: 'GOV_T', name: 'TGOV1_1', kind: 'TGOV1', params: {} },
      ],
    };
    render(
      withQueryClient(
        <AlterSpecForm spec={{ ...blankAlterSpec(), model: 'IEEEG1' }} onChange={() => {}} />,
      ),
    );
    const dev = screen.getByTestId('alter-dev-idx') as HTMLSelectElement;
    expect(dev).not.toBeDisabled();
    const options = Array.from(dev.querySelectorAll('option'))
      .map((o) => o.value)
      .filter((v) => v.length > 0);
    expect(options).toEqual(['GOV_1', 'GOV_2']);
  });

  it('Unit 8.1: REGCA1 device picker pulls REGCA1 entries from the controllers bucket', () => {
    MOCK_TOPOLOGY = {
      ...(MOCK_TOPOLOGY as TopologySummary),
      controllers: [{ idx: 'REGCA_1', name: 'REGCA1_1', kind: 'REGCA1', params: {} }],
    };
    render(
      withQueryClient(
        <AlterSpecForm spec={{ ...blankAlterSpec(), model: 'REGCA1' }} onChange={() => {}} />,
      ),
    );
    const dev = screen.getByTestId('alter-dev-idx') as HTMLSelectElement;
    expect(dev).not.toBeDisabled();
    const options = Array.from(dev.querySelectorAll('option'))
      .map((o) => o.value)
      .filter((v) => v.length > 0);
    expect(options).toEqual(['REGCA_1']);
  });

  it('flags missing src as required', async () => {
    let validity: Record<string, string> = {};
    render(
      withQueryClient(
        <AlterSpecForm
          spec={{ ...blankAlterSpec(), model: 'PQ', dev_idx: 'L1', src: '' }}
          onChange={() => {}}
          onValidityChange={(errs) => {
            validity = errs;
          }}
        />,
      ),
    );
    await waitFor(() => {
      expect(validity.src).toBe('Required');
    });
  });
});
