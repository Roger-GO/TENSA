/**
 * ElementForm — polymorphic form generated from `_PARAMS_BY_MODEL`.
 *
 * Tests cover:
 * - Bus form vs. Line form polymorphic rendering (different fields).
 * - Required-field validation gates submit.
 * - idx prefill from next-available logic.
 * - Duplicate-idx client-side rejection.
 * - Defaults injection (kind-pick prefill, e.g., transformer tap=1.05).
 * - Cancel + dirty-change tracking.
 * - Optional fields collapse under "Show advanced".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { ElementForm } from '@/components/elements/ElementForm';
import type { TopologySchema, TopologySummary } from '@/api/types';

const SCHEMA: TopologySchema = {
  models: {
    Bus: [
      { name: 'idx', kind: 'string', required: true },
      { name: 'name', kind: 'string', required: true },
      { name: 'Vn', kind: 'number', required: true, unit: 'kV' },
      { name: 'vmax', kind: 'number', required: false, unit: 'pu' },
    ],
    Line: [
      { name: 'idx', kind: 'string', required: true },
      { name: 'name', kind: 'string', required: true },
      { name: 'bus1', kind: 'bus_idx', required: true },
      { name: 'bus2', kind: 'bus_idx', required: true },
      { name: 'r', kind: 'number', required: true, unit: 'pu' },
      { name: 'x', kind: 'number', required: true, unit: 'pu' },
      { name: 'tap', kind: 'number', required: false },
    ],
  },
};

let MOCK_TOPOLOGY: TopologySummary | null = null;

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useTopologySchema: () => ({ data: SCHEMA, isLoading: false, isError: false }),
    useCurrentTopology: () => MOCK_TOPOLOGY,
  };
});

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function emptyTopology(): TopologySummary {
  return {
    state: 'pre-setup',
    buses: [],
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
    shunts: [],
  };
}

beforeEach(() => {
  MOCK_TOPOLOGY = emptyTopology();
});

describe('<ElementForm />', () => {
  it('renders Bus-specific fields when model="Bus"', () => {
    render(
      withQueryClient(
        <ElementForm
          model="Bus"
          saving={false}
          serverError={null}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
      ),
    );
    expect(screen.getByTestId('element-form-Bus')).toBeInTheDocument();
    expect(screen.getByTestId('field-idx')).toBeInTheDocument();
    expect(screen.getByTestId('field-name')).toBeInTheDocument();
    expect(screen.getByTestId('field-Vn')).toBeInTheDocument();
    // Line-specific fields not present.
    expect(screen.queryByTestId('field-bus1')).toBeNull();
    expect(screen.queryByTestId('field-r')).toBeNull();
    // Submit label uses the model name.
    expect(screen.getByRole('button', { name: /add bus/i })).toBeInTheDocument();
  });

  it('renders Line-specific fields when model="Line" (different polymorphic shape)', () => {
    render(
      withQueryClient(
        <ElementForm
          model="Line"
          saving={false}
          serverError={null}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
      ),
    );
    expect(screen.getByTestId('element-form-Line')).toBeInTheDocument();
    expect(screen.getByTestId('field-bus1')).toBeInTheDocument();
    expect(screen.getByTestId('field-bus2')).toBeInTheDocument();
    expect(screen.getByTestId('field-r')).toBeInTheDocument();
    expect(screen.getByTestId('field-x')).toBeInTheDocument();
    // Bus-only `Vn` field not present.
    expect(screen.queryByTestId('field-Vn')).toBeNull();
  });

  it('prefills the idx field with next-available "1" on an empty topology', () => {
    render(
      withQueryClient(
        <ElementForm
          model="Bus"
          saving={false}
          serverError={null}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
      ),
    );
    const idxInput = screen.getByTestId('field-idx').querySelector('input') as HTMLInputElement;
    expect(idxInput.value).toBe('1');
  });

  it('prefills idx as max+1 when existing buses are numeric', () => {
    MOCK_TOPOLOGY = {
      ...emptyTopology(),
      buses: [
        { idx: 1, name: 'B1', kind: 'Bus', params: {} },
        { idx: 5, name: 'B5', kind: 'Bus', params: {} },
      ],
    };
    render(
      withQueryClient(
        <ElementForm
          model="Bus"
          saving={false}
          serverError={null}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
      ),
    );
    const idxInput = screen.getByTestId('field-idx').querySelector('input') as HTMLInputElement;
    expect(idxInput.value).toBe('6');
  });

  it('rejects submit with required-field error when a required field is empty', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      withQueryClient(
        <ElementForm
          model="Bus"
          saving={false}
          serverError={null}
          onSubmit={onSubmit}
          onCancel={() => {}}
        />,
      ),
    );
    // The Vn field is required and empty by default.
    await user.click(screen.getByRole('button', { name: /add bus/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    const errors = await screen.findAllByText(/required/i);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects submit with duplicate-idx error when idx is already taken', async () => {
    const user = userEvent.setup();
    MOCK_TOPOLOGY = {
      ...emptyTopology(),
      buses: [{ idx: '99', name: 'B99', kind: 'Bus', params: {} }],
    };
    const onSubmit = vi.fn();
    render(
      withQueryClient(
        <ElementForm
          model="Bus"
          saving={false}
          serverError={null}
          onSubmit={onSubmit}
          onCancel={() => {}}
        />,
      ),
    );
    const idxInput = screen.getByTestId('field-idx').querySelector('input') as HTMLInputElement;
    await user.clear(idxInput);
    await user.type(idxInput, '99');
    await user.type(screen.getByTestId('field-name').querySelector('input')!, 'BUS99');
    await user.type(screen.getByTestId('field-Vn').querySelector('input')!, '110');
    await user.click(screen.getByRole('button', { name: /add bus/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByText(/already taken/i)).toBeInTheDocument();
  });

  it('happy path: submits the Bus form with the typed values coerced into the right shapes', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      withQueryClient(
        <ElementForm
          model="Bus"
          saving={false}
          serverError={null}
          onSubmit={onSubmit}
          onCancel={() => {}}
        />,
      ),
    );
    const idxInput = screen.getByTestId('field-idx').querySelector('input') as HTMLInputElement;
    await user.clear(idxInput);
    await user.type(idxInput, '7');
    await user.type(screen.getByTestId('field-name').querySelector('input')!, 'BUS7');
    await user.type(screen.getByTestId('field-Vn').querySelector('input')!, '230');
    await user.click(screen.getByRole('button', { name: /add bus/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith({
      idx: '7',
      name: 'BUS7',
      Vn: 230,
    });
  });

  it('seeds defaultParams (kind-pick prefill like transformer tap=1.05)', async () => {
    render(
      withQueryClient(
        <ElementForm
          model="Line"
          kindHint="Transformer2W"
          defaultParams={{ tap: 1.05 }}
          saving={false}
          serverError={null}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
      ),
    );
    // Optional fields land under the advanced disclosure; expand it.
    await userEvent.click(screen.getByText(/Show advanced/i));
    const tapInput = screen.getByTestId('field-tap').querySelector('input') as HTMLInputElement;
    expect(tapInput.value).toBe('1.05');
  });

  it('Cancel button fires onCancel without invoking onSubmit', async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      withQueryClient(
        <ElementForm
          model="Bus"
          saving={false}
          serverError={null}
          onSubmit={onSubmit}
          onCancel={onCancel}
        />,
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('reports dirty=true via onDirtyChange after the user touches a field', async () => {
    const onDirtyChange = vi.fn();
    render(
      withQueryClient(
        <ElementForm
          model="Bus"
          saving={false}
          serverError={null}
          onSubmit={() => {}}
          onCancel={() => {}}
          onDirtyChange={onDirtyChange}
        />,
      ),
    );
    // The prefilled idx should NOT trip dirty (touched is per user-action).
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    await userEvent.type(screen.getByTestId('field-Vn').querySelector('input')!, '1');
    await waitFor(() => {
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    });
  });

  it('shows the serverError prop when supplied', () => {
    render(
      withQueryClient(
        <ElementForm
          model="Bus"
          saving={false}
          serverError="Substrate said no"
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
      ),
    );
    expect(screen.getByTestId('form-server-error')).toHaveTextContent('Substrate said no');
  });

  it('disables the submit button while saving=true and shows the progress label', () => {
    render(
      withQueryClient(
        <ElementForm
          model="Bus"
          saving={true}
          serverError={null}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
      ),
    );
    const submit = screen.getByRole('button', { name: /Saving/i });
    expect(submit).toBeDisabled();
  });
});
