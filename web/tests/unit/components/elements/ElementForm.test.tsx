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
 *   case already has, and follows the case while the form is open.
 * - A battery opens named after its idx.
 * - A model with a `bus` and a `gen` has them tied: the bus list names the
 *   generators, a pick of one sets the other, and a bus without a generator or
 *   a generator already in use is warned about.
 * - An edit tells the caller, so that a refusal of the old values can go.
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
    GENROU: [
      { name: 'idx', kind: 'string', required: true },
      { name: 'name', kind: 'string', required: true },
      { name: 'bus', kind: 'bus_idx', required: true },
      { name: 'gen', kind: 'gen_idx', required: true },
      { name: 'Sn', kind: 'number', required: true, unit: 'MVA' },
    ],
    PV: [
      { name: 'idx', kind: 'string', required: true },
      { name: 'name', kind: 'string', required: true },
      { name: 'bus', kind: 'bus_idx', required: true },
      { name: 'p0', kind: 'number', required: true, unit: 'pu' },
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
        defaultParams={{ Sn: 100, pqflag: 1, pmx: 1 }}
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
    // The limit the form opened with is already worked out.
    expect(inputOf('pmx').value).toBe('1');
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
    await user.clear(inputOf('name'));
    await user.type(inputOf('name'), 'BESS');
    await user.selectOptions(screen.getByTestId('bus-idx-select'), '7');
    await user.selectOptions(screen.getByTestId('gen-idx-select'), 'PV_B');
    await user.clear(inputOf('Sn'));
    await user.type(inputOf('Sn'), '50');
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
    await user.selectOptions(screen.getByTestId('gen-idx-select'), 'PV_B');
    await user.type(inputOf('En'), '20');
    await user.click(screen.getByRole('button', { name: /add esd1/i }));
    expect(screen.getByRole('alert')).toHaveTextContent('idx "ESD1_1" is already taken');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('<ElementForm /> names a battery after its idx', () => {
  beforeEach(() => {
    MOCK_TOPOLOGY = batteryTopology();
  });

  it('opens with the name set to the idx it proposes, which is not an edit', () => {
    const onDirtyChange = vi.fn();
    render(
      withQueryClient(
        <ElementForm
          model="ESD1"
          saving={false}
          serverError={null}
          onSubmit={() => {}}
          onCancel={() => {}}
          onDirtyChange={onDirtyChange}
        />,
      ),
    );
    expect(inputOf('idx').value).toBe('ESD1_1');
    expect(inputOf('name').value).toBe('ESD1_1');
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
  });

  it('keeps the name alike while the idx is typed, until the name is typed over', async () => {
    const user = userEvent.setup();
    renderBatteryForm();
    await user.clear(inputOf('idx'));
    await user.type(inputOf('idx'), 'BESS_A');
    expect(inputOf('name').value).toBe('BESS_A');

    await user.clear(inputOf('name'));
    await user.type(inputOf('name'), 'North battery');
    await user.type(inputOf('idx'), '2');
    expect(inputOf('idx').value).toBe('BESS_A2');
    expect(inputOf('name').value).toBe('North battery');
  });

  it('adds a battery with nothing typed but its generator and its energy', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderBatteryForm(onSubmit);
    await user.selectOptions(screen.getByTestId('gen-idx-select'), 'PV_B');
    await user.type(inputOf('En'), '20');
    await user.click(screen.getByRole('button', { name: /add esd1/i }));
    expect(onSubmit).toHaveBeenCalledWith({
      idx: 'ESD1_1',
      name: 'ESD1_1',
      bus: '7',
      gen: 'PV_B',
      Sn: 100,
      pqflag: 1,
      pmx: 1,
      En: 20,
    });
  });

  it('leaves the name of another model for the user to give', () => {
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
    expect(inputOf('idx').value).toBe('8');
    expect(inputOf('name').value).toBe('');
  });
});

/**
 * Buses 1 to 5: a slack with a machine on bus 1, a PV with a machine on bus 2, a
 * free PV on bus 3, two free PVs on bus 4, nothing on bus 5.
 */
function linkedTopology(): TopologySummary {
  return {
    ...emptyTopology(),
    base_mva: 100,
    buses: [1, 2, 3, 4, 5].map((n) => ({ idx: n, name: `BUS${n}`, kind: 'Bus', params: {} })),
    generators: [
      { idx: 2, name: 'G2', kind: 'PV', params: { bus: 2 } },
      { idx: 'PV_B', name: 'PV_B', kind: 'PV', params: { bus: 3 } },
      { idx: 6, name: 'G6', kind: 'PV', params: { bus: 4 } },
      { idx: 7, name: 'G7', kind: 'PV', params: { bus: 4 } },
      { idx: 1, name: 'G1', kind: 'Slack', params: { bus: 1 } },
      { idx: 'GENROU_1', name: 'GENROU_1', kind: 'GENROU', params: { bus: 1, gen: 1 } },
      { idx: 'GENROU_2', name: 'GENROU_2', kind: 'GENROU', params: { bus: 2, gen: 2 } },
    ],
  };
}

function optionTexts(testId: string): string[] {
  return Array.from(screen.getByTestId(testId).querySelectorAll('option'))
    .slice(1)
    .map((o) => o.text);
}

function busSelect(): HTMLSelectElement {
  return screen.getByTestId('bus-idx-select') as HTMLSelectElement;
}

function genSelect(): HTMLSelectElement {
  return screen.getByTestId('gen-idx-select') as HTMLSelectElement;
}

describe('<ElementForm /> ties the bus and the static generator of a device', () => {
  beforeEach(() => {
    MOCK_TOPOLOGY = linkedTopology();
  });

  it('names the generators on each bus, and the bus and the user of each generator', () => {
    renderBatteryForm();
    expect(optionTexts('bus-idx-select')).toEqual([
      '1 — BUS1 (generator: Slack 1 used by GENROU_1)',
      '2 — BUS2 (generator: PV 2 used by GENROU_2)',
      '3 — BUS3 (generator: PV_B)',
      '4 — BUS4 (generators: PV 6, PV 7)',
      '5 — BUS5',
    ]);
    expect(optionTexts('gen-idx-select')).toEqual([
      'PV-2 — G2 (bus 2, used by GENROU_2)',
      'PV-PV_B — PV_B (bus 3)',
      'PV-6 — G6 (bus 4)',
      'PV-7 — G7 (bus 4)',
      'Slack-1 — G1 (bus 1, used by GENROU_1)',
    ]);
    expect(screen.getByTestId('field-help-bus')).toHaveTextContent(
      'picking the generator below sets the bus',
    );
  });

  it('says nothing about generators in the bus list of a model that names none', () => {
    render(
      withQueryClient(
        <ElementForm
          model="PV"
          saving={false}
          serverError={null}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
      ),
    );
    expect(optionTexts('bus-idx-select')).toEqual([
      '1 — BUS1',
      '2 — BUS2',
      '3 — BUS3',
      '4 — BUS4',
      '5 — BUS5',
    ]);
  });

  it('sets the bus when a generator is picked, and says so under the bus', async () => {
    const user = userEvent.setup();
    renderBatteryForm();
    await user.selectOptions(genSelect(), 'PV_B');
    expect(busSelect().value).toBe('3');
    const note = screen.getByTestId('field-note-bus');
    expect(note).toHaveAttribute('role', 'status');
    expect(note).toHaveTextContent('Set to bus 3, where PV_B is.');
    expect(busSelect().getAttribute('aria-describedby')).toBe(
      `${screen.getByTestId('field-help-bus').id} ${note.id}`,
    );
    expect(screen.queryByTestId('field-warning-bus')).toBeNull();
    expect(screen.queryByTestId('field-warning-gen')).toBeNull();
  });

  it('sets the generator when a bus with one generator is picked, and says so', async () => {
    const user = userEvent.setup();
    renderBatteryForm();
    await user.selectOptions(busSelect(), '3');
    expect(genSelect().value).toBe('PV_B');
    expect(screen.getByTestId('field-note-gen')).toHaveTextContent(
      'Set to PV_B, the static generator on bus 3.',
    );
    expect(screen.queryByTestId('field-note-bus')).toBeNull();
  });

  it('leaves the generator to pick on a bus that has two', async () => {
    const user = userEvent.setup();
    renderBatteryForm();
    await user.selectOptions(busSelect(), '4');
    expect(genSelect().value).toBe('');
    expect(screen.queryByTestId('field-note-gen')).toBeNull();
    expect(screen.queryByTestId('field-warning-bus')).toBeNull();
    await user.selectOptions(genSelect(), '7');
    expect(busSelect().value).toBe('4');
    expect(screen.queryByTestId('field-note-bus')).toBeNull();
  });

  it('warns under a bus with no generator, and drops a generator picked for another bus', async () => {
    const user = userEvent.setup();
    renderBatteryForm();
    await user.selectOptions(genSelect(), 'PV_B');
    await user.selectOptions(busSelect(), '5');
    expect(genSelect().value).toBe('');
    const warning = screen.getByTestId('field-warning-bus');
    expect(warning).toHaveTextContent('Bus 5 has no PV or Slack generator.');
    expect(warning).toHaveTextContent('Add one there first (Kind: PV generator)');
    // The line about the earlier pick has gone with it.
    expect(screen.queryByTestId('field-note-bus')).toBeNull();
  });

  it('warns under a generator a machine already takes over, and adds all the same', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderBatteryForm(onSubmit);
    await user.selectOptions(busSelect(), '2');
    expect(genSelect().value).toBe('2');
    const warning = screen.getByTestId('field-warning-gen');
    expect(warning).toHaveTextContent('GENROU_2 already takes over PV 2.');
    expect(warning).toHaveTextContent('the time-domain run does not initialize');
    await user.type(inputOf('En'), '20');
    await user.click(screen.getByRole('button', { name: /add esd1/i }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ bus: '2', gen: '2' }));
  });

  it('ties them for a machine as well, which has no help of its own', async () => {
    const user = userEvent.setup();
    render(
      withQueryClient(
        <ElementForm
          model="GENROU"
          saving={false}
          serverError={null}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
      ),
    );
    expect(optionTexts('bus-idx-select')[2]).toBe('3 — BUS3 (generator: PV_B)');
    await user.selectOptions(genSelect(), '1');
    expect(busSelect().value).toBe('1');
    expect(screen.getByTestId('field-note-bus')).toHaveTextContent('Set to bus 1');
    expect(screen.getByTestId('field-warning-gen')).toHaveTextContent(
      'GENROU_1 already takes over Slack 1.',
    );
  });

  it('keeps a field in place when a line turns up under it', async () => {
    const user = userEvent.setup();
    render(
      withQueryClient(
        <ElementForm
          model="GENROU"
          saving={false}
          serverError={null}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
      ),
    );
    const before = busSelect();
    before.focus();
    await user.selectOptions(before, '5');
    expect(screen.getByTestId('field-warning-bus')).toBeInTheDocument();
    // The same element, still focused: arrowing through the list is not cut short.
    expect(busSelect()).toBe(before);
    expect(document.activeElement).toBe(before);
  });
});

describe('<ElementForm /> follows the case while it is open', () => {
  beforeEach(() => {
    MOCK_TOPOLOGY = batteryTopology();
  });

  function batteryForm() {
    return withQueryClient(
      <ElementForm
        model="ESD1"
        defaultParams={{ Sn: 100, pqflag: 1, pmx: 1 }}
        saving={false}
        serverError={null}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
  }

  /** The case as it is once the battery the form proposed has been added. */
  function withBattery(): TopologySummary {
    return {
      ...batteryTopology(),
      controllers: [
        { idx: 'ESD1_1', name: 'ESD1_1', kind: 'ESD1', params: { bus: 7, gen: 'PV_B' } },
      ],
    };
  }

  it('proposes the next idx, and the name with it, once the case has the one it proposed', () => {
    const view = render(batteryForm());
    expect(inputOf('idx').value).toBe('ESD1_1');
    MOCK_TOPOLOGY = withBattery();
    view.rerender(batteryForm());
    expect(inputOf('idx').value).toBe('ESD1_2');
    expect(inputOf('name').value).toBe('ESD1_2');
  });

  it('leaves an idx the user typed, and a name the user typed', async () => {
    const user = userEvent.setup();
    const view = render(batteryForm());
    await user.clear(inputOf('name'));
    await user.type(inputOf('name'), 'North battery');
    MOCK_TOPOLOGY = withBattery();
    view.rerender(batteryForm());
    expect(inputOf('idx').value).toBe('ESD1_2');
    expect(inputOf('name').value).toBe('North battery');

    await user.clear(inputOf('idx'));
    await user.type(inputOf('idx'), 'BESS_A');
    MOCK_TOPOLOGY = batteryTopology();
    view.rerender(batteryForm());
    expect(inputOf('idx').value).toBe('BESS_A');
  });
});

describe('<ElementForm /> tells its caller of an edit', () => {
  it('calls onEdit when a field changes, and not before', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(
      withQueryClient(
        <ElementForm
          model="Bus"
          saving={false}
          serverError="Vn must be above zero"
          onSubmit={() => {}}
          onCancel={() => {}}
          onEdit={onEdit}
        />,
      ),
    );
    expect(onEdit).not.toHaveBeenCalled();
    await user.type(inputOf('Vn'), '1');
    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});
