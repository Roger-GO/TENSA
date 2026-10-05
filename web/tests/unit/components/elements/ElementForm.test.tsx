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
 * - A model with help (the ESD1 battery) gets a note, a line under the fields it
 *   explains, and a warning under a rating that is not the system base.
 * - A controller's idx is prefilled and checked against the controllers the
 *   case already has.
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
    ESD1: [
      { name: 'idx', kind: 'string', required: true },
      { name: 'name', kind: 'string', required: true },
      { name: 'bus', kind: 'bus_idx', required: true },
      { name: 'gen', kind: 'gen_idx', required: true },
      { name: 'Sn', kind: 'number', required: true, unit: 'MVA' },
      { name: 'pqflag', kind: 'number', required: true },
      { name: 'pmx', kind: 'number', required: true, unit: 'pu' },
      { name: 'En', kind: 'number', required: true, unit: 'MWh' },
      { name: 'xc', kind: 'number', required: false, unit: 'pu' },
      { name: 'SOCinit', kind: 'number', required: false },
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

/** A case with a bus, a static generator on it, and a 100 MVA base. */
function batteryTopology(): TopologySummary {
  return {
    ...emptyTopology(),
    base_mva: 100,
    buses: [{ idx: 7, name: 'B7', kind: 'Bus', params: { Vn: 230 } }],
    generators: [{ idx: 'PV_B', name: 'PV_B', kind: 'PV', params: { bus: 7 } }],
  };
}

function renderBatteryForm(onSubmit: (params: Record<string, unknown>) => void = () => {}) {
  return render(
    withQueryClient(
      <ElementForm
        model="ESD1"
        defaultParams={{ Sn: 100, pqflag: 1 }}
        saving={false}
        serverError={null}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    ),
  );
}

function inputOf(name: string): HTMLInputElement {
  return screen.getByTestId(`field-${name}`).querySelector('input') as HTMLInputElement;
}

describe('<ElementForm /> for a model with help (the ESD1 battery)', () => {
  beforeEach(() => {
    MOCK_TOPOLOGY = batteryTopology();
  });

  it('has no note, field help or warning for a model without help', () => {
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
    expect(screen.queryByTestId('element-form-note')).toBeNull();
    expect(screen.queryByTestId('field-help-Vn')).toBeNull();
    expect(inputOf('Vn')).not.toHaveAttribute('aria-describedby');
  });

  it("says above the fields to keep Sn on the system base, with the case's base", () => {
    renderBatteryForm();
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('Keep Sn equal to the system base (100 MVA).');
    expect(note).toHaveTextContent('add a PV generator there first');
    expect(note).toHaveTextContent('pIG_y');
  });

  it('puts a line under the fields it explains, tied to the input and not to its name', () => {
    renderBatteryForm();
    const help = screen.getByTestId('field-help-Sn');
    expect(help).toHaveTextContent('keep Sn equal to it so the two read alike');
    expect(inputOf('Sn').getAttribute('aria-describedby')).toBe(help.id);
    // The label still names the field by its parameter name alone.
    expect(screen.getByTestId('field-Sn')).not.toContainElement(help);
    expect(screen.getByTestId('field-help-En')).toHaveTextContent('delivered MW over En');
    // A field with nothing to explain has no line.
    expect(screen.queryByTestId('field-help-idx')).toBeNull();
    expect(screen.queryByTestId('field-help-xc')).toBeNull();
  });

  it('describes the static-generator picker with its help too', () => {
    renderBatteryForm();
    const help = screen.getByTestId('field-help-gen');
    expect(help).toHaveTextContent('static generator');
    expect(screen.getByTestId('gen-idx-select').getAttribute('aria-describedby')).toBe(help.id);
  });

  it('opens rated on the system base and warns once Sn is another number', async () => {
    const user = userEvent.setup();
    renderBatteryForm();
    expect(inputOf('Sn').value).toBe('100');
    expect(inputOf('pqflag').value).toBe('1');
    expect(screen.queryByTestId('field-warning-Sn')).toBeNull();

    await user.clear(inputOf('Sn'));
    await user.type(inputOf('Sn'), '50');
    await user.type(inputOf('pmx'), '1');
    const warning = screen.getByTestId('field-warning-Sn');
    expect(warning).toHaveAttribute('role', 'status');
    expect(warning).toHaveTextContent('Sn is not the system base (100 MVA)');
    expect(warning).toHaveTextContent('at most 0.5 pu on the system base (50 MW)');
    expect(inputOf('Sn').getAttribute('aria-describedby')).toBe(
      `${screen.getByTestId('field-help-Sn').id} ${warning.id}`,
    );

    await user.clear(inputOf('Sn'));
    await user.type(inputOf('Sn'), '100');
    expect(screen.queryByTestId('field-warning-Sn')).toBeNull();
  });

  it('adds a battery rated off the system base all the same: the warning does not block', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderBatteryForm(onSubmit);
    await user.type(inputOf('name'), 'BESS');
    await user.selectOptions(screen.getByTestId('bus-idx-select'), '7');
    await user.selectOptions(screen.getByTestId('gen-idx-select'), 'PV_B');
    await user.clear(inputOf('Sn'));
    await user.type(inputOf('Sn'), '50');
    await user.type(inputOf('pmx'), '1');
    await user.type(inputOf('En'), '20');
    await user.click(screen.getByRole('button', { name: /add esd1/i }));
    expect(onSubmit).toHaveBeenCalledWith({
      idx: 'ESD1_1',
      name: 'BESS',
      bus: '7',
      gen: 'PV_B',
      Sn: 50,
      pqflag: 1,
      pmx: 1,
      En: 20,
    });
  });

  it('prefills the idx after the batteries the case already has, and refuses one that is taken', async () => {
    const user = userEvent.setup();
    MOCK_TOPOLOGY = {
      ...batteryTopology(),
      controllers: [
        { idx: 'ESD1_1', name: 'ESD1_1', kind: 'ESD1', params: {} },
        // Another model's idx does not count, whatever it is.
        { idx: 'ESD1_7', name: 'odd', kind: 'TGOV1', params: {} },
      ],
    };
    const onSubmit = vi.fn();
    renderBatteryForm(onSubmit);
    expect(inputOf('idx').value).toBe('ESD1_2');

    await user.clear(inputOf('idx'));
    await user.type(inputOf('idx'), 'ESD1_1');
    await user.type(inputOf('name'), 'BESS');
    await user.selectOptions(screen.getByTestId('bus-idx-select'), '7');
    await user.selectOptions(screen.getByTestId('gen-idx-select'), 'PV_B');
    await user.type(inputOf('pmx'), '1');
    await user.type(inputOf('En'), '20');
    await user.click(screen.getByRole('button', { name: /add esd1/i }));
    expect(screen.getByRole('alert')).toHaveTextContent('idx "ESD1_1" is already taken');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
