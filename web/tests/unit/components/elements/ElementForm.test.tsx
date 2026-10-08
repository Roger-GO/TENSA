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
 * - A submit that cannot go says so itself (the browser's own validation is
 *   off): under each field, in one line that names the fields, and by moving
 *   to the first of them.
 * - A static generator opens named after its idx, with a line under its numbers.
 * - A form opened on a bus starts there, with the free generator of that bus.
 * - A generator the form chose is given up once a device takes it, and none is
 *   chosen while the case is being read again.
 * - A bus without a generator offers to add one there.
 * - The form of a draft (`live`): it is checked as it is typed, opens with the
 *   values that were kept for it, reports every field that is set, cannot be
 *   sent while anything is missing, and says why.
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
    TGOV1: [
      { name: 'idx', kind: 'string', required: true },
      { name: 'name', kind: 'string', required: true },
      { name: 'syn', kind: 'syn_idx', required: true },
    ],
  },
};

let MOCK_TOPOLOGY: TopologySummary | null = null;
/** The topology is being read again: what `MOCK_TOPOLOGY` holds may be behind the case. */
let MOCK_REFETCHING = false;

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useTopologySchema: () => ({ data: SCHEMA, isLoading: false, isError: false }),
    useCurrentTopology: () => MOCK_TOPOLOGY,
    useTopologyRefetching: () => MOCK_REFETCHING,
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
  MOCK_REFETCHING = false;
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

  /** `linkedTopology()` once a PV has been added on bus 5, which had no generator. */
  function withGeneratorOnBus5(): TopologySummary {
    const base = linkedTopology();
    return {
      ...base,
      generators: [
        ...(base.generators ?? []),
        { idx: 8, name: '8', kind: 'PV', params: { bus: 5 } },
      ],
    };
  }

  function batteryFormOn(seedBus: string) {
    return withQueryClient(
      <ElementForm
        model="ESD1"
        defaultParams={{ Sn: 100, pqflag: 1, pmx: 1, En: 100 }}
        saving={false}
        serverError={null}
        onSubmit={() => {}}
        onCancel={() => {}}
        seedBus={seedBus}
      />,
    );
  }

  it('takes the generator of its bus once the case has it, and says so', () => {
    MOCK_TOPOLOGY = linkedTopology();
    const view = render(batteryFormOn('5'));
    expect(genSelect().value).toBe('');
    expect(screen.getByTestId('field-warning-bus')).toBeInTheDocument();

    // The PV that was added for this battery reaches the case a moment later.
    MOCK_TOPOLOGY = withGeneratorOnBus5();
    view.rerender(batteryFormOn('5'));
    expect(genSelect().value).toBe('8');
    expect(screen.getByTestId('field-note-gen')).toHaveTextContent(
      'Set to PV 8, the static generator on bus 5.',
    );
    expect(screen.queryByTestId('field-warning-bus')).toBeNull();
  });

  it('does the same for a bus picked by hand before its generator was there', async () => {
    const user = userEvent.setup();
    MOCK_TOPOLOGY = linkedTopology();
    const view = render(batteryForm());
    await user.selectOptions(busSelect(), '5');
    MOCK_TOPOLOGY = withGeneratorOnBus5();
    view.rerender(batteryForm());
    expect(genSelect().value).toBe('8');
  });

  it('leaves a generator the user picked, and one a device already takes over', async () => {
    const user = userEvent.setup();
    MOCK_TOPOLOGY = linkedTopology();
    const view = render(batteryFormOn('4'));
    // Two generators on bus 4: the user picks one, and the case changing leaves it.
    await user.selectOptions(genSelect(), '7');
    MOCK_TOPOLOGY = withGeneratorOnBus5();
    view.rerender(batteryFormOn('4'));
    expect(genSelect().value).toBe('7');
    view.unmount();

    // On bus 2 the one generator is GENROU_2's, before and after.
    MOCK_TOPOLOGY = linkedTopology();
    const taken = render(batteryFormOn('2'));
    MOCK_TOPOLOGY = withGeneratorOnBus5();
    taken.rerender(batteryFormOn('2'));
    expect(genSelect().value).toBe('');
  });

  /** `topology` once a battery has been added on the static generator `gen` of `bus`. */
  function withBatteryOn(topology: TopologySummary, bus: number, gen: number | string) {
    return {
      ...topology,
      controllers: [{ idx: 'ESD1_1', name: 'ESD1_1', kind: 'ESD1', params: { bus, gen } }],
    };
  }

  it('gives up the generator it chose once a device has taken it, and asks for one', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const form = () =>
      withQueryClient(
        <ElementForm
          model="ESD1"
          defaultParams={{ Sn: 100, pqflag: 1, pmx: 1, En: 100 }}
          saving={false}
          serverError={null}
          onSubmit={onSubmit}
          onCancel={() => {}}
          seedBus="3"
        />,
      );
    MOCK_TOPOLOGY = linkedTopology();
    const view = render(form());
    expect(genSelect().value).toBe('PV_B');
    expect(screen.getByTestId('field-note-gen')).toBeInTheDocument();

    // The form is back after an add before the case has the battery: once it
    // has, the generator the form opened with is the first battery's.
    MOCK_TOPOLOGY = withBatteryOn(linkedTopology(), 3, 'PV_B');
    view.rerender(form());
    expect(busSelect().value).toBe('3');
    expect(genSelect().value).toBe('');
    expect(screen.queryByTestId('field-note-gen')).toBeNull();
    expect(screen.queryByTestId('field-warning-gen')).toBeNull();
    expect(inputOf('idx').value).toBe('ESD1_2');

    await user.click(screen.getByRole('button', { name: /add esd1/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId('form-problems')).toHaveTextContent(
      'Nothing was added: gen is required and empty.',
    );
  });

  it('gives up one it chose for a bus that gained its generator, too', () => {
    MOCK_TOPOLOGY = linkedTopology();
    const view = render(batteryFormOn('5'));
    MOCK_TOPOLOGY = withGeneratorOnBus5();
    view.rerender(batteryFormOn('5'));
    expect(genSelect().value).toBe('8');

    MOCK_TOPOLOGY = withBatteryOn(withGeneratorOnBus5(), 5, 8);
    view.rerender(batteryFormOn('5'));
    expect(genSelect().value).toBe('');
    expect(screen.queryByTestId('field-note-gen')).toBeNull();
  });

  it('keeps a generator the user picked, with its bus or by itself, and warns', async () => {
    const user = userEvent.setup();
    MOCK_TOPOLOGY = linkedTopology();
    // Picking bus 3 brings its generator along: that is the user's choice.
    const picked = render(batteryForm());
    await user.selectOptions(busSelect(), '3');
    expect(genSelect().value).toBe('PV_B');
    MOCK_TOPOLOGY = withBatteryOn(linkedTopology(), 3, 'PV_B');
    picked.rerender(batteryForm());
    expect(genSelect().value).toBe('PV_B');
    expect(screen.getByTestId('field-warning-gen')).toHaveTextContent(
      'ESD1_1 already takes over PV_B.',
    );
    picked.unmount();

    // So is the bus the form opened on, once the user has picked it again.
    MOCK_TOPOLOGY = linkedTopology();
    const seeded = render(batteryFormOn('3'));
    await user.selectOptions(busSelect(), '2');
    await user.selectOptions(busSelect(), '3');
    MOCK_TOPOLOGY = withBatteryOn(linkedTopology(), 3, 'PV_B');
    seeded.rerender(batteryFormOn('3'));
    expect(genSelect().value).toBe('PV_B');
    expect(screen.getByTestId('field-warning-gen')).toBeInTheDocument();
  });

  it('chooses no generator while the case is being read again, and does once it is in', () => {
    // The form that comes back after an add: the topology it has is the one
    // from before the add, which may call a generator free that is not.
    MOCK_TOPOLOGY = linkedTopology();
    MOCK_REFETCHING = true;
    const view = render(batteryFormOn('3'));
    expect(busSelect().value).toBe('3');
    expect(genSelect().value).toBe('');
    expect(screen.queryByTestId('field-note-gen')).toBeNull();

    // The read is in and the generator is still free.
    MOCK_REFETCHING = false;
    view.rerender(batteryFormOn('3'));
    expect(genSelect().value).toBe('PV_B');
    expect(screen.getByTestId('field-note-gen')).toHaveTextContent(
      'Set to PV_B, the static generator on bus 3.',
    );
    view.unmount();

    // The read is in and a device has it: the generator is left to pick.
    MOCK_TOPOLOGY = linkedTopology();
    MOCK_REFETCHING = true;
    const taken = render(batteryFormOn('3'));
    MOCK_TOPOLOGY = withBatteryOn(linkedTopology(), 3, 'PV_B');
    MOCK_REFETCHING = false;
    taken.rerender(batteryFormOn('3'));
    expect(genSelect().value).toBe('');
  });

  it('keeps the generator it chose through a read that leaves it free', () => {
    MOCK_TOPOLOGY = linkedTopology();
    const view = render(batteryFormOn('3'));
    MOCK_REFETCHING = true;
    view.rerender(batteryFormOn('3'));
    expect(genSelect().value).toBe('PV_B');
    MOCK_TOPOLOGY = withGeneratorOnBus5();
    MOCK_REFETCHING = false;
    view.rerender(batteryFormOn('3'));
    expect(genSelect().value).toBe('PV_B');
    expect(screen.getByTestId('field-note-gen')).toBeInTheDocument();
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

describe('<ElementForm /> says what stopped a submit', () => {
  beforeEach(() => {
    MOCK_TOPOLOGY = linkedTopology();
  });

  function renderForm(model: string, onSubmit: () => void = () => {}) {
    return render(
      withQueryClient(
        <ElementForm
          model={model}
          saving={false}
          serverError={null}
          onSubmit={onSubmit}
          onCancel={() => {}}
        />,
      ),
    );
  }

  it("does the checking itself: the browser's bubble names one field and is gone on a click", () => {
    renderForm('PV');
    expect(screen.getByTestId('element-form-PV')).toHaveAttribute('novalidate');
    // The fields still say they are required to a screen reader.
    expect(busSelect()).toBeRequired();
    expect(inputOf('p0')).toBeRequired();
    expect(screen.queryByTestId('form-problems')).toBeNull();
  });

  it('says Required under each empty field, names them in one line and moves to the first', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderForm('PV', onSubmit);
    await user.click(screen.getByRole('button', { name: /add pv/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    const summary = screen.getByTestId('form-problems');
    expect(summary).toHaveAttribute('role', 'status');
    expect(summary).toHaveTextContent('Nothing was added: bus and p0 are required and empty.');

    const busError = screen.getByTestId('field-error-bus');
    expect(busError).toHaveAttribute('role', 'alert');
    expect(busError).toHaveTextContent('Required. Pick one from the list.');
    expect(busSelect()).toHaveAttribute('aria-invalid', 'true');
    expect(busSelect().getAttribute('aria-describedby')).toBe(busError.id);
    // It describes the field and is no part of its name: the label is still "bus".
    expect(screen.getByTestId('field-bus')).not.toContainElement(busError);
    expect(screen.getByRole('combobox', { name: 'bus' })).toBe(busSelect());
    expect(screen.getByTestId('field-error-p0')).toHaveTextContent('Required. Enter a value.');
    expect(inputOf('p0')).toHaveAttribute('aria-invalid', 'true');
    // The line under p0 that says what it is comes before what is wrong with it.
    expect(inputOf('p0').getAttribute('aria-describedby')).toBe(
      `${screen.getByTestId('field-help-p0').id} ${screen.getByTestId('field-error-p0').id}`,
    );
    // The fields that hold a value are left alone.
    expect(inputOf('idx')).not.toHaveAttribute('aria-invalid');
    // The cursor is in the first of them, which also scrolls it into view.
    expect(document.activeElement).toBe(busSelect());
  });

  it('takes a field out of the line as it is filled in, and the line away with the last', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderForm('PV', onSubmit);
    await user.click(screen.getByRole('button', { name: /add pv/i }));

    await user.selectOptions(busSelect(), '3');
    expect(screen.getByTestId('form-problems')).toHaveTextContent(
      'Nothing was added: p0 is required and empty.',
    );
    expect(busSelect()).not.toHaveAttribute('aria-invalid');
    await user.type(inputOf('p0'), '0.4');
    expect(screen.queryByTestId('form-problems')).toBeNull();

    await user.click(screen.getByRole('button', { name: /add pv/i }));
    expect(onSubmit).toHaveBeenCalledWith({ idx: 'PV_5', name: 'PV_5', bus: '3', p0: 0.4 });
  });

  it('tells a value it refuses from a field left empty', async () => {
    const user = userEvent.setup();
    MOCK_TOPOLOGY = {
      ...emptyTopology(),
      buses: [{ idx: '99', name: 'B99', kind: 'Bus', params: {} }],
    };
    renderForm('Bus');
    await user.clear(inputOf('idx'));
    await user.type(inputOf('idx'), '99');
    await user.click(screen.getByRole('button', { name: /add bus/i }));
    expect(screen.getByTestId('form-problems')).toHaveTextContent(
      'Nothing was added: name and Vn are required and empty, and idx holds a value that cannot be used.',
    );
    // In the order of the form: the idx comes first.
    expect(document.activeElement).toBe(inputOf('idx'));
  });

  it('marks an unpicked generator and an unpicked machine the same way', async () => {
    const user = userEvent.setup();
    const battery = render(
      withQueryClient(
        <ElementForm
          model="ESD1"
          defaultParams={{ Sn: 100, pqflag: 1, pmx: 1, En: 100 }}
          saving={false}
          serverError={null}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
      ),
    );
    await user.selectOptions(busSelect(), '5');
    await user.click(screen.getByRole('button', { name: /add esd1/i }));
    expect(screen.getByTestId('form-problems')).toHaveTextContent(
      'Nothing was added: gen is required and empty.',
    );
    expect(genSelect()).toHaveAttribute('aria-invalid', 'true');
    expect(document.activeElement).toBe(genSelect());
    battery.unmount();

    renderForm('TGOV1');
    await user.click(screen.getByRole('button', { name: /add tgov1/i }));
    expect(screen.getByTestId('form-problems')).toHaveTextContent(
      'Nothing was added: name and syn are required and empty.',
    );
    const machine = screen.getByTestId('syn-idx-select');
    expect(machine).toHaveAttribute('aria-invalid', 'true');
    expect(machine).toHaveClass('border-danger');
    expect(screen.getByTestId('field-error-syn')).toHaveTextContent(
      'Required. Pick one from the list.',
    );
    await user.selectOptions(machine, 'GENROU_1');
    expect(screen.getByTestId('syn-idx-select')).not.toHaveAttribute('aria-invalid');
  });

  it('moves back to the field when the same submit is refused again', async () => {
    const user = userEvent.setup();
    renderForm('PV');
    await user.click(screen.getByRole('button', { name: /add pv/i }));
    inputOf('idx').focus();
    await user.click(screen.getByRole('button', { name: /add pv/i }));
    expect(document.activeElement).toBe(busSelect());
  });

  it('opens the advanced fields when the first problem is among them', async () => {
    const user = userEvent.setup();
    MOCK_TOPOLOGY = emptyTopology();
    // A number box takes no text, so only a caller's opening value can be one.
    render(
      withQueryClient(
        <ElementForm
          model="Bus"
          defaultParams={{ vmax: 'high' }}
          saving={false}
          serverError={null}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
      ),
    );
    await user.type(inputOf('name'), 'BUS1');
    await user.type(inputOf('Vn'), '110');
    expect(screen.getByTestId('form-advanced-disclosure')).not.toHaveAttribute('open');

    await user.click(screen.getByRole('button', { name: /add bus/i }));
    expect(screen.getByTestId('form-problems')).toHaveTextContent(
      'Nothing was added: vmax holds a value that cannot be used.',
    );
    expect(screen.getByTestId('form-advanced-disclosure')).toHaveAttribute('open');
    expect(document.activeElement).toBe(inputOf('vmax'));
  });
});

describe('<ElementForm /> for a static generator', () => {
  beforeEach(() => {
    MOCK_TOPOLOGY = linkedTopology();
  });

  function renderPv(props: Partial<React.ComponentProps<typeof ElementForm>> = {}) {
    return render(
      withQueryClient(
        <ElementForm
          model="PV"
          saving={false}
          serverError={null}
          onSubmit={() => {}}
          onCancel={() => {}}
          {...props}
        />,
      ),
    );
  }

  it('opens named after the idx it proposes, like the generators of a case', () => {
    renderPv();
    expect(inputOf('idx').value).toBe('PV_5');
    expect(inputOf('name').value).toBe('PV_5');
  });

  it('explains its numbers under them, and has no note above the fields', () => {
    renderPv();
    expect(screen.queryByTestId('element-form-note')).toBeNull();
    const help = screen.getByTestId('field-help-p0');
    expect(help).toHaveTextContent('per unit of the system base (100 MVA): 0.4 is 40 MW');
    expect(inputOf('p0').getAttribute('aria-describedby')).toBe(help.id);
  });
});

describe('<ElementForm /> opened on a bus', () => {
  beforeEach(() => {
    MOCK_TOPOLOGY = linkedTopology();
  });

  function renderOn(model: string, seedBus: string, onDirtyChange?: (dirty: boolean) => void) {
    return render(
      withQueryClient(
        <ElementForm
          model={model}
          defaultParams={model === 'ESD1' ? { Sn: 100, pqflag: 1, pmx: 1, En: 100 } : undefined}
          saving={false}
          serverError={null}
          onSubmit={() => {}}
          onCancel={() => {}}
          onDirtyChange={onDirtyChange}
          seedBus={seedBus}
        />,
      ),
    );
  }

  it('starts a device on that bus, which is not an edit', () => {
    const onDirtyChange = vi.fn();
    renderOn('PV', '5', onDirtyChange);
    expect(busSelect().value).toBe('5');
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
  });

  it('starts a line at that bus and leaves the far end to pick', () => {
    renderOn('Line', '3');
    const [from, to] = screen.getAllByTestId('bus-idx-select') as HTMLSelectElement[];
    expect(from?.value).toBe('3');
    expect(to?.value).toBe('');
  });

  it('ignores a bus the case does not have', () => {
    renderOn('PV', '99');
    expect(busSelect().value).toBe('');
  });

  it('has nothing to start in a form without a bus', async () => {
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
          seedBus="3"
        />,
      ),
    );
    await user.type(inputOf('name'), 'BUS6');
    await user.type(inputOf('Vn'), '69');
    await user.click(screen.getByRole('button', { name: /add bus/i }));
    expect(onSubmit).toHaveBeenCalledWith({ idx: '6', name: 'BUS6', Vn: 69 });
  });

  it('gives a battery the free generator of that bus, and says so under it', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      withQueryClient(
        <ElementForm
          model="ESD1"
          defaultParams={{ Sn: 100, pqflag: 1, pmx: 1, En: 100 }}
          saving={false}
          serverError={null}
          onSubmit={onSubmit}
          onCancel={() => {}}
          seedBus="3"
        />,
      ),
    );
    expect(busSelect().value).toBe('3');
    expect(genSelect().value).toBe('PV_B');
    expect(screen.getByTestId('field-note-gen')).toHaveTextContent(
      'Set to PV_B, the static generator on bus 3.',
    );
    // Nothing is left to type: the form can be sent as it opened.
    await user.click(screen.getByRole('button', { name: /add esd1/i }));
    expect(onSubmit).toHaveBeenCalledWith({
      idx: 'ESD1_1',
      name: 'ESD1_1',
      bus: '3',
      gen: 'PV_B',
      Sn: 100,
      pqflag: 1,
      pmx: 1,
      En: 100,
    });
  });

  it('leaves the generator to pick where a device already takes the one on that bus', () => {
    renderOn('ESD1', '2');
    expect(busSelect().value).toBe('2');
    expect(genSelect().value).toBe('');
    expect(screen.queryByTestId('field-note-gen')).toBeNull();
    expect(screen.queryByTestId('field-warning-gen')).toBeNull();
  });

  it('leaves the generator to pick on a bus that has two, and warns on one that has none', () => {
    const view = renderOn('ESD1', '4');
    expect(genSelect().value).toBe('');
    view.unmount();
    renderOn('ESD1', '5');
    expect(busSelect().value).toBe('5');
    expect(screen.getByTestId('field-warning-bus')).toHaveTextContent(
      'Bus 5 has no PV or Slack generator.',
    );
  });
});

describe('<ElementForm /> offers the generator a device lacks', () => {
  beforeEach(() => {
    MOCK_TOPOLOGY = linkedTopology();
  });

  function renderBattery(onAddGenerator?: (bus: string) => void) {
    return render(
      withQueryClient(
        <ElementForm
          model="ESD1"
          defaultParams={{ Sn: 100, pqflag: 1, pmx: 1 }}
          saving={false}
          serverError={null}
          onSubmit={() => {}}
          onCancel={() => {}}
          onAddGenerator={onAddGenerator}
        />,
      ),
    );
  }

  it('puts a button under the warning of a bus without a generator, which names the bus', async () => {
    const user = userEvent.setup();
    const onAddGenerator = vi.fn();
    renderBattery(onAddGenerator);
    expect(screen.queryByTestId('field-action-add-generator')).toBeNull();

    await user.selectOptions(busSelect(), '5');
    const button = screen.getByRole('button', { name: 'Add a PV generator on bus 5' });
    expect(button).toHaveAttribute('data-testid', 'field-action-add-generator');
    await user.click(button);
    expect(onAddGenerator).toHaveBeenCalledWith('5');
  });

  it('has no button on a bus that has a generator, or with no caller to go to', async () => {
    const user = userEvent.setup();
    const view = renderBattery(vi.fn());
    await user.selectOptions(busSelect(), '3');
    expect(screen.queryByTestId('field-action-add-generator')).toBeNull();
    view.unmount();

    renderBattery();
    await user.selectOptions(busSelect(), '5');
    expect(screen.getByTestId('field-warning-bus')).toBeInTheDocument();
    expect(screen.queryByTestId('field-action-add-generator')).toBeNull();
  });
});

describe('<ElementForm /> checked as it is typed (the form of a draft)', () => {
  function busTopology(): TopologySummary {
    return {
      ...emptyTopology(),
      buses: [
        { idx: 3, name: 'BUS3', kind: 'Bus' },
        { idx: 5, name: 'BUS5', kind: 'Bus' },
      ],
      generators: [{ idx: 'PV_1', name: 'PV_1', kind: 'PV', params: { bus: 3 } }],
    };
  }

  function renderDraft(
    props: Partial<Parameters<typeof ElementForm>[0]> = {},
    model = 'PV',
  ): ReturnType<typeof render> {
    return render(
      withQueryClient(
        <ElementForm
          model={model}
          live
          submitLabel="Add to system"
          cancelLabel="Delete draft"
          saving={false}
          serverError={null}
          onSubmit={() => {}}
          onCancel={() => {}}
          {...props}
        />,
      ),
    );
  }

  beforeEach(() => {
    MOCK_TOPOLOGY = busTopology();
  });

  it('says what is missing from the start, and keeps the submit off until nothing is', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderDraft({ onSubmit });
    // Nothing was sent or even tried, and the empty required fields say so.
    expect(screen.getByTestId('field-error-bus')).toHaveTextContent('Required. Pick one');
    expect(screen.getByTestId('field-error-p0')).toHaveTextContent('Required. Enter a value');
    expect(screen.queryByTestId('field-error-idx')).toBeNull();
    const problems = screen.getByTestId('form-problems');
    expect(problems).toHaveTextContent('Not ready to add: bus and p0 are required and empty.');
    const submit = screen.getByRole('button', { name: 'Add to system' });
    expect(submit).toBeDisabled();
    // The reason is tied to the button for a reader that does not see the page.
    expect(submit.getAttribute('aria-describedby')).toBe(problems.id);
    // The lines of a form that was never sent are not read out as alerts.
    expect(screen.getByTestId('field-error-bus')).not.toHaveAttribute('role');

    await user.selectOptions(screen.getByTestId('bus-idx-select'), '5');
    expect(screen.queryByTestId('field-error-bus')).toBeNull();
    expect(screen.getByTestId('form-problems')).toHaveTextContent(
      'Not ready to add: p0 is required and empty.',
    );
    await user.type(screen.getByLabelText(/^p0/), '0.4');
    expect(screen.queryByTestId('form-problems')).toBeNull();
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({ idx: 'PV_2', name: 'PV_2', bus: '5', p0: 0.4 });
  });

  it('refuses a value as it is typed, and an idx the case already has', async () => {
    const user = userEvent.setup();
    renderDraft({ heldValues: { bus: '5', p0: '0.4' } });
    expect(screen.getByRole('button', { name: 'Add to system' })).toBeEnabled();
    const idx = screen.getByLabelText(/^idx/);
    await user.clear(idx);
    await user.type(idx, 'PV_1');
    expect(screen.getByTestId('field-error-idx')).toHaveTextContent('idx "PV_1" is already taken');
    expect(screen.getByTestId('form-problems')).toHaveTextContent(
      'Not ready to add: idx holds a value that cannot be used.',
    );
    expect(screen.getByRole('button', { name: 'Add to system' })).toBeDisabled();
  });

  it('opens with the values that were kept, over what a form opens with', () => {
    renderDraft({ heldValues: { idx: 'G9', bus: '5' } });
    expect(screen.getByLabelText(/^idx/)).toHaveValue('G9');
    // A static generator is named after its idx until it is given a name.
    expect(screen.getByLabelText(/^name/)).toHaveValue('G9');
    expect(screen.getByTestId('bus-idx-select')).toHaveValue('5');
    expect(screen.getByTestId('form-problems')).toHaveTextContent('p0 is required and empty');
  });

  it('reports every field that is set, and not the name that only followed the idx', async () => {
    const user = userEvent.setup();
    const onFieldsChange = vi.fn();
    renderDraft({ onFieldsChange });
    await user.selectOptions(screen.getByTestId('bus-idx-select'), '5');
    expect(onFieldsChange).toHaveBeenLastCalledWith({ bus: '5' });
    await user.type(screen.getByLabelText(/^idx/), 'x');
    expect(onFieldsChange).toHaveBeenLastCalledWith({ idx: 'PV_2x' });
    expect(screen.getByLabelText(/^name/)).toHaveValue('PV_2x');
    await user.type(screen.getByLabelText(/^name/), 'y');
    expect(onFieldsChange).toHaveBeenLastCalledWith({ name: 'PV_2xy' });
  });

  it('reports the generator a pick of the bus brought along, and the one it gave up', async () => {
    const user = userEvent.setup();
    const onFieldsChange = vi.fn();
    renderDraft({ onFieldsChange }, 'GENROU');
    await user.selectOptions(screen.getByTestId('bus-idx-select'), '3');
    expect(onFieldsChange).toHaveBeenLastCalledWith({ bus: '3', gen: 'PV_1' });
    // A bus without a generator empties the field, which nobody then set.
    await user.selectOptions(screen.getByTestId('bus-idx-select'), '5');
    expect(onFieldsChange).toHaveBeenLastCalledWith({ bus: '5', gen: null });
  });

  it('refuses a kept pick the case no longer has', () => {
    renderDraft({ heldValues: { bus: '9', p0: '0.4' } });
    expect(screen.getByTestId('field-error-bus')).toHaveTextContent(
      'Bus 9 is not in the system. Pick one from the list.',
    );
    expect(screen.getByRole('button', { name: 'Add to system' })).toBeDisabled();
  });

  it('cannot be sent while the system takes no element, and says why', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderDraft({
      onSubmit,
      heldValues: { bus: '5', p0: '0.4' },
      blockedReason: 'A run has set the system up.',
    });
    const blocked = screen.getByTestId('form-blocked');
    expect(blocked).toHaveTextContent('A run has set the system up.');
    const submit = screen.getByRole('button', { name: 'Add to system' });
    expect(submit).toBeDisabled();
    expect(submit.getAttribute('aria-describedby')).toBe(blocked.id);
    await user.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('opens on the next free idx past the ones that are reserved, and follows them', () => {
    const { rerender } = renderDraft({ reservedIdxs: ['PV_2', 'PV_3'] });
    expect(screen.getByLabelText(/^idx/)).toHaveValue('PV_4');
    expect(screen.getByLabelText(/^name/)).toHaveValue('PV_4');
    // The draft before it was added or deleted: its idx is free again.
    rerender(
      withQueryClient(
        <ElementForm
          model="PV"
          live
          reservedIdxs={['PV_2']}
          saving={false}
          serverError={null}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
      ),
    );
    expect(screen.getByLabelText(/^idx/)).toHaveValue('PV_3');
  });

  it('keeps an idx that was typed, whatever is reserved', () => {
    renderDraft({ heldValues: { idx: 'PV_2' }, reservedIdxs: ['PV_2'] });
    expect(screen.getByLabelText(/^idx/)).toHaveValue('PV_2');
  });

  it('opens the advanced fields of a form that was kept with one of them set', () => {
    const { unmount } = renderDraft({ heldValues: { name: 'B9' } }, 'Bus');
    expect(screen.getByTestId('form-advanced-disclosure')).not.toHaveAttribute('open');
    unmount();
    // A value in there that cannot be used is in view, with what is wrong with it.
    renderDraft({ heldValues: { name: 'B9', Vn: '110', vmax: 'abc' } }, 'Bus');
    expect(screen.getByTestId('form-advanced-disclosure')).toHaveAttribute('open');
    expect(screen.getByTestId('field-error-vmax')).toHaveTextContent('Enter a finite number');
    expect(screen.getByTestId('form-problems')).toHaveTextContent(
      'Not ready to add: vmax holds a value that cannot be used.',
    );
  });

  it('names its buttons as the caller asks', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderDraft({ onCancel });
    await user.click(screen.getByRole('button', { name: 'Delete draft' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /^cancel$/i })).toBeNull();
  });
});
