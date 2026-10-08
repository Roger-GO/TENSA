/**
 * AddElementPanel — slide-over for adding new topology elements.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { AddElementPanel } from '@/components/elements/AddElementPanel';
import { ELEMENT_KINDS, groupElementKinds } from '@/components/elements/elementKinds';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { ProblemDetailsError } from '@/api/client';
import { parseSessionId } from '@/api/types';
import type { TopologySchema, TopologySummary } from '@/api/types';

// Schema fixture covering Bus + Line; mirrored from the server's
// _PARAMS_BY_MODEL table.
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
    ],
    PV: [
      { name: 'idx', kind: 'string', required: true },
      { name: 'name', kind: 'string', required: true },
      { name: 'bus', kind: 'bus_idx', required: true },
      { name: 'p0', kind: 'number', required: true, unit: 'pu' },
    ],
    PQ: [
      { name: 'idx', kind: 'string', required: true },
      { name: 'name', kind: 'string', required: true },
      { name: 'bus', kind: 'bus_idx', required: true },
      { name: 'p0', kind: 'number', required: true, unit: 'pu' },
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
      { name: 'SOCinit', kind: 'number', required: false },
    ],
  },
};

const postSpy = vi.fn();
/** What the add answers with: the created element, unless a test says otherwise. */
const created = () =>
  Promise.resolve({
    element: { idx: '1', name: 'BUS1', kind: 'Bus', params: { Vn: 110 } },
  });
let postResult: () => Promise<unknown> = created;

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    andesClient: {
      get: () => Promise.resolve(SCHEMA),
      post: (path: string, opts: { body?: unknown }) => {
        postSpy(path, opts.body);
        return postResult();
      },
      put: vi.fn(),
    },
  };
});

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useTopologySchema: () => ({ data: SCHEMA, isLoading: false, isError: false }),
    useCurrentTopology: () => MOCK_TOPOLOGY,
  };
});

let MOCK_TOPOLOGY: TopologySummary | null = null;

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  postSpy.mockClear();
  postResult = created;
  MOCK_TOPOLOGY = {
    state: 'pre-setup',
    buses: [],
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
    shunts: [],
  };
  useCaseStore.setState({
    addPanelOpen: false,
    addPanelKind: null,
    addPanelDirty: false,
    addPanelBus: null,
  });
  useSessionStore.setState({ sessionId: parseSessionId('test-session-id') });
});

describe('<AddElementPanel />', () => {
  it('renders nothing when closed', () => {
    render(withQueryClient(<AddElementPanel />));
    expect(screen.queryByTestId('add-element-panel')).toBeNull();
  });

  it('opens when addPanelOpen=true and shows the kind picker', () => {
    useCaseStore.setState({ addPanelOpen: true, addPanelKind: null });
    render(withQueryClient(<AddElementPanel />));
    expect(screen.getByTestId('add-element-panel')).toBeInTheDocument();
    expect(screen.getByTestId('add-element-kind')).toBeInTheDocument();
  });

  it('renders the Bus form with required fields when kind=Bus', async () => {
    useCaseStore.setState({ addPanelOpen: true, addPanelKind: 'Bus' });
    render(withQueryClient(<AddElementPanel />));
    await waitFor(() => {
      expect(screen.getByTestId('element-form-Bus')).toBeInTheDocument();
    });
    expect(screen.getByTestId('field-Vn')).toBeInTheDocument();
    expect(screen.getByTestId('field-idx')).toBeInTheDocument();
    expect(screen.getByTestId('field-name')).toBeInTheDocument();
    // Optional field is collapsed under "Show advanced".
    expect(screen.getByTestId('form-advanced-disclosure')).toBeInTheDocument();
  });

  it('submits the Bus form happy path', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({ addPanelOpen: true, addPanelKind: 'Bus' });
    render(withQueryClient(<AddElementPanel />));
    await waitFor(() => screen.getByTestId('element-form-Bus'));
    // idx is prefilled to "1" since the topology has no buses; clear
    // before typing so we don't end up with "11".
    const idxInput = screen.getByTestId('field-idx').querySelector('input')!;
    await user.clear(idxInput);
    await user.type(idxInput, '1');
    await user.type(screen.getByTestId('field-name').querySelector('input')!, 'BUS1');
    await user.type(screen.getByTestId('field-Vn').querySelector('input')!, '110');
    await user.click(screen.getByRole('button', { name: /add bus/i }));
    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    const [path, body] = postSpy.mock.calls[0] ?? [];
    expect(path).toContain('/sessions/test-session-id/elements');
    expect(body).toEqual({
      model: 'Bus',
      params: { idx: '1', name: 'BUS1', Vn: 110 },
    });
    // The panel now stays OPEN after a successful add (so the user can add the
    // next element without re-opening it) and shows a confirmation.
    expect(useCaseStore.getState().addPanelOpen).toBe(true);
    await waitFor(() => expect(screen.getByTestId('add-element-success')).toBeInTheDocument());
  });

  it('confirms an add by name, and says that the panel stays open for the next one', async () => {
    const user = userEvent.setup();
    MOCK_TOPOLOGY = {
      ...(MOCK_TOPOLOGY as TopologySummary),
      buses: [{ idx: 4, name: 'BUS4', kind: 'Bus', params: {} }],
    };
    useCaseStore.setState({ addPanelOpen: true, addPanelKind: 'Generator' });
    const view = render(withQueryClient(<AddElementPanel />));
    await waitFor(() => screen.getByTestId('element-form-PV'));
    expect(screen.queryByTestId('add-element-success')).toBeNull();
    await user.selectOptions(screen.getByTestId('bus-idx-select'), '4');
    await user.type(screen.getByTestId('field-p0').querySelector('input')!, '0.4');
    await user.click(screen.getByRole('button', { name: /add pv/i }));

    const confirmation = await screen.findByTestId('add-element-success');
    expect(confirmation).toHaveAttribute('role', 'status');
    expect(confirmation).toHaveTextContent(
      'Added PV generator PV_1 on bus 4. The panel stays open for the next element: pick another Kind above, or close the panel when you are done.',
    );
    // It stays while another kind is picked: it is what the panel last did.
    await user.selectOptions(screen.getByTestId('add-element-kind'), 'Bus');
    expect(screen.getByTestId('add-element-success')).toBeInTheDocument();

    // The next visit to the panel starts without it.
    await user.click(screen.getByTestId('add-element-close'));
    expect(screen.queryByTestId('add-element-panel')).toBeNull();
    useCaseStore.getState().openAddPanel('Bus');
    view.rerender(withQueryClient(<AddElementPanel />));
    await waitFor(() => screen.getByTestId('element-form-Bus'));
    expect(screen.queryByTestId('add-element-success')).toBeNull();
  });

  it('rejects submit when a required field is empty', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({ addPanelOpen: true, addPanelKind: 'Bus' });
    render(withQueryClient(<AddElementPanel />));
    await waitFor(() => screen.getByTestId('element-form-Bus'));
    await user.click(screen.getByRole('button', { name: /add bus/i }));
    expect(postSpy).not.toHaveBeenCalled();
    // The form's per-field error rendered.
    const errors = await screen.findAllByText(/required/i);
    expect(errors.length).toBeGreaterThan(0);
    // And the line above the buttons names the fields.
    expect(screen.getByTestId('form-problems')).toHaveTextContent(
      'Nothing was added: name and Vn are required and empty.',
    );
  });

  it('shows "Add a Bus first" empty state on bus_idx field with no buses', async () => {
    useCaseStore.setState({ addPanelOpen: true, addPanelKind: 'Line' });
    render(withQueryClient(<AddElementPanel />));
    await waitFor(() => screen.getByTestId('element-form-Line'));
    expect(screen.getAllByText(/add a bus first/i).length).toBeGreaterThan(0);
  });

  it('cancel on a clean form closes silently (no confirm dialog)', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({ addPanelOpen: true, addPanelKind: 'Bus' });
    render(withQueryClient(<AddElementPanel />));
    await waitFor(() => screen.getByTestId('element-form-Bus'));
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(useCaseStore.getState().addPanelOpen).toBe(false);
    expect(screen.queryByTestId('add-element-cancel-confirm')).toBeNull();
  });

  // ---- the kinds of the Components palette -------------------------------

  it('offers in the Kind picker what the Components palette lists, in the same groups and order', () => {
    useCaseStore.setState({ addPanelOpen: true, addPanelKind: null });
    render(withQueryClient(<AddElementPanel />));
    const picker = screen.getByTestId('add-element-kind') as HTMLSelectElement;
    const offered = Array.from(picker.querySelectorAll('optgroup')).map((group) => [
      group.label,
      Array.from(group.querySelectorAll('option')).map((o) => [o.value, o.text]),
    ]);
    expect(offered).toEqual(
      groupElementKinds(ELEMENT_KINDS).map(({ group, kinds }) => [
        group,
        kinds.map((k) => [k.value, k.label]),
      ]),
    );
  });

  it.each([
    ['PQ', 'PQ load', 'PQ'],
    ['Transformer2W', 'Transformer (2W)', 'Line'],
    ['ESD1', 'ESD1 battery', 'ESD1'],
  ])(
    'opens on the model a row of the palette names (%s), with the picker on it and its form shown',
    async (kind, pickerLabel, formModel) => {
      useCaseStore.setState({ addPanelOpen: true, addPanelKind: kind });
      render(withQueryClient(<AddElementPanel />));
      const picker = screen.getByTestId('add-element-kind') as HTMLSelectElement;
      expect(picker.value).toBe(kind);
      expect(picker.options[picker.selectedIndex]?.text).toBe(pickerLabel);
      await waitFor(() => {
        expect(screen.getByTestId(`element-form-${formModel}`)).toBeInTheDocument();
      });
      expect(screen.queryByText(/No schema for model/)).toBeNull();
    },
  );

  // ---- families, which a caller may name instead of a model ---------------

  it.each([
    ['Generator', 'PV', 'PV generator', 'PV'],
    ['Load', 'PQ', 'PQ load', 'PQ'],
    ['Transformer', 'Transformer2W', 'Transformer (2W)', 'Line'],
    ['Battery', 'ESD1', 'ESD1 battery', 'ESD1'],
  ])(
    'opens the %s tile on its most common model, with the picker on it and its form shown',
    async (family, pickerValue, pickerLabel, formModel) => {
      useCaseStore.setState({ addPanelOpen: true, addPanelKind: family });
      render(withQueryClient(<AddElementPanel />));
      const picker = screen.getByTestId('add-element-kind') as HTMLSelectElement;
      expect(picker.value).toBe(pickerValue);
      expect(picker.options[picker.selectedIndex]?.text).toBe(pickerLabel);
      await waitFor(() => {
        expect(screen.getByTestId(`element-form-${formModel}`)).toBeInTheDocument();
      });
      expect(screen.queryByText(/No schema for model/)).toBeNull();
    },
  );

  it('lets the user move off the family default through the picker', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({ addPanelOpen: true, addPanelKind: 'Load' });
    render(withQueryClient(<AddElementPanel />));
    await user.selectOptions(screen.getByTestId('add-element-kind'), 'Bus');
    expect(useCaseStore.getState().addPanelKind).toBe('Bus');
    await waitFor(() => expect(screen.getByTestId('element-form-Bus')).toBeInTheDocument());
  });

  // ---- the ESD1 battery ---------------------------------------------------

  it('offers the battery under Storage in the kind picker', () => {
    useCaseStore.setState({ addPanelOpen: true, addPanelKind: null });
    render(withQueryClient(<AddElementPanel />));
    const picker = screen.getByTestId('add-element-kind') as HTMLSelectElement;
    const storage = Array.from(picker.querySelectorAll('optgroup')).find(
      (group) => group.label === 'Storage',
    );
    expect(storage).toBeDefined();
    expect(Array.from(storage!.querySelectorAll('option')).map((o) => [o.value, o.text])).toEqual([
      ['ESD1', 'ESD1 battery'],
    ]);
  });

  it("opens the battery form rated on the case's system base, with its help", async () => {
    MOCK_TOPOLOGY = {
      ...(MOCK_TOPOLOGY as TopologySummary),
      base_mva: 250,
      buses: [{ idx: 7, name: 'B7', kind: 'Bus', params: {} }],
      generators: [{ idx: 'PV_B', name: 'PV_B', kind: 'PV', params: {} }],
    };
    useCaseStore.setState({ addPanelOpen: true, addPanelKind: 'ESD1' });
    render(withQueryClient(<AddElementPanel />));
    await waitFor(() => expect(screen.getByTestId('element-form-ESD1')).toBeInTheDocument());
    expect(screen.getByTestId('field-Sn').querySelector('input')).toHaveValue(250);
    expect(screen.getByTestId('field-pqflag').querySelector('input')).toHaveValue(1);
    // Limited to its rating and named after its idx: neither has to be typed.
    expect(screen.getByTestId('field-pmx').querySelector('input')).toHaveValue(1);
    expect(screen.getByTestId('field-name').querySelector('input')).toHaveValue('ESD1_1');
    // One hour at the rating, so the form has no empty required number.
    expect(screen.getByTestId('field-En').querySelector('input')).toHaveValue(250);
    expect(screen.getByRole('note')).toHaveTextContent(
      'Keep Sn equal to the system base (250 MVA).',
    );
    // Opening on the base is not a change the user made: closing asks nothing.
    expect(useCaseStore.getState().addPanelDirty).toBe(false);
  });

  it('submits the battery with the rating and the priority the form opened with', async () => {
    const user = userEvent.setup();
    MOCK_TOPOLOGY = {
      ...(MOCK_TOPOLOGY as TopologySummary),
      base_mva: 100,
      buses: [{ idx: 7, name: 'B7', kind: 'Bus', params: {} }],
      generators: [{ idx: 'PV_B', name: 'PV_B', kind: 'PV', params: {} }],
    };
    useCaseStore.setState({ addPanelOpen: true, addPanelKind: 'ESD1' });
    render(withQueryClient(<AddElementPanel />));
    await waitFor(() => screen.getByTestId('element-form-ESD1'));
    const name = screen.getByTestId('field-name').querySelector('input')!;
    await user.clear(name);
    await user.type(name, 'BESS');
    await user.selectOptions(screen.getByTestId('bus-idx-select'), '7');
    await user.selectOptions(screen.getByTestId('gen-idx-select'), 'PV_B');
    const pmx = screen.getByTestId('field-pmx').querySelector('input')!;
    await user.clear(pmx);
    await user.type(pmx, '0.4');
    const energy = screen.getByTestId('field-En').querySelector('input')!;
    await user.clear(energy);
    await user.type(energy, '80');
    await user.click(screen.getByRole('button', { name: /add esd1/i }));
    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    const [path, body] = postSpy.mock.calls[0] ?? [];
    expect(path).toContain('/sessions/test-session-id/elements');
    expect(body).toEqual({
      model: 'ESD1',
      params: {
        idx: 'ESD1_1',
        name: 'BESS',
        bus: '7',
        gen: 'PV_B',
        Sn: 100,
        pqflag: 1,
        pmx: 0.4,
        En: 80,
      },
    });
  });

  it('adds a battery from its tile with the generator alone', async () => {
    const user = userEvent.setup();
    MOCK_TOPOLOGY = {
      ...(MOCK_TOPOLOGY as TopologySummary),
      base_mva: 100,
      buses: [{ idx: 7, name: 'B7', kind: 'Bus', params: {} }],
      generators: [{ idx: 'PV_B', name: 'PV_B', kind: 'PV', params: { bus: 7 } }],
    };
    useCaseStore.setState({ addPanelOpen: true, addPanelKind: 'Battery' });
    render(withQueryClient(<AddElementPanel />));
    await waitFor(() => screen.getByTestId('element-form-ESD1'));
    await user.selectOptions(screen.getByTestId('gen-idx-select'), 'PV_B');
    await user.click(screen.getByRole('button', { name: /add esd1/i }));
    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    expect(postSpy.mock.calls[0]?.[1]).toEqual({
      model: 'ESD1',
      params: {
        idx: 'ESD1_1',
        name: 'ESD1_1',
        bus: '7',
        gen: 'PV_B',
        Sn: 100,
        pqflag: 1,
        pmx: 1,
        En: 100,
      },
    });
    expect(await screen.findByTestId('add-element-success')).toHaveTextContent(
      'Added ESD1 battery ESD1_1 on bus 7.',
    );
  });

  it('takes a refusal of the server away once the form is edited', async () => {
    const user = userEvent.setup();
    MOCK_TOPOLOGY = {
      ...(MOCK_TOPOLOGY as TopologySummary),
      base_mva: 100,
      buses: [{ idx: 7, name: 'B7', kind: 'Bus', params: {} }],
      generators: [{ idx: 'PV_B', name: 'PV_B', kind: 'PV', params: { bus: 7 } }],
    };
    postResult = () =>
      Promise.reject(
        new ProblemDetailsError({
          type: 'about:blank',
          status: 422,
          title: 'Unprocessable Entity',
          detail: 'ESD1 SOCinit must lie between SOCmin and SOCmax; got SOCinit=1.5',
        }),
      );
    useCaseStore.setState({ addPanelOpen: true, addPanelKind: 'ESD1' });
    render(withQueryClient(<AddElementPanel />));
    await waitFor(() => screen.getByTestId('element-form-ESD1'));
    await user.selectOptions(screen.getByTestId('gen-idx-select'), 'PV_B');
    await user.click(screen.getByText(/show advanced/i));
    const soc = screen.getByTestId('field-SOCinit').querySelector('input')!;
    await user.type(soc, '1.5');
    // Said under the field before anything is sent, and by the server after.
    expect(screen.getByTestId('field-warning-SOCinit')).toHaveTextContent(
      '1.5 is outside SOCmin to SOCmax (0 to 1)',
    );
    await user.click(screen.getByRole('button', { name: /add esd1/i }));
    expect(await screen.findByTestId('form-server-error')).toHaveTextContent(
      'SOCinit must lie between SOCmin and SOCmax',
    );
    expect(useCaseStore.getState().addPanelOpen).toBe(true);

    await user.clear(soc);
    await user.type(soc, '0.5');
    expect(screen.queryByTestId('form-server-error')).toBeNull();
    expect(screen.queryByTestId('field-warning-SOCinit')).toBeNull();
  });

  it('takes a refusal of the server away with the form it was about', async () => {
    const user = userEvent.setup();
    postResult = () =>
      Promise.reject(
        new ProblemDetailsError({
          type: 'about:blank',
          status: 422,
          title: 'Unprocessable Entity',
          detail: 'Bus Vn must be above zero',
        }),
      );
    useCaseStore.setState({ addPanelOpen: true, addPanelKind: 'Bus' });
    render(withQueryClient(<AddElementPanel />));
    await waitFor(() => screen.getByTestId('element-form-Bus'));
    await user.type(screen.getByTestId('field-name').querySelector('input')!, 'BUS1');
    await user.type(screen.getByTestId('field-Vn').querySelector('input')!, '0');
    await user.click(screen.getByRole('button', { name: /add bus/i }));
    expect(await screen.findByTestId('form-server-error')).toHaveTextContent('Vn must be above');

    await user.selectOptions(screen.getByTestId('add-element-kind'), 'Line');
    await waitFor(() => screen.getByTestId('element-form-Line'));
    expect(screen.queryByTestId('form-server-error')).toBeNull();
  });

  // ---- opened from a bus of the diagram -----------------------------------

  /** Buses 4 and 5, a free PV on bus 4, nothing on bus 5, a 100 MVA base. */
  function twoBusTopology(): TopologySummary {
    return {
      ...(MOCK_TOPOLOGY as TopologySummary),
      base_mva: 100,
      buses: [
        { idx: 4, name: 'BUS4', kind: 'Bus', params: {} },
        { idx: 5, name: '5', kind: 'Bus', params: {} },
      ],
      generators: [{ idx: 6, name: '6', kind: 'PV', params: { bus: 4 } }],
    };
  }

  it('says which bus it was opened from, and opens each form on it', async () => {
    const user = userEvent.setup();
    MOCK_TOPOLOGY = twoBusTopology();
    useCaseStore.getState().openAddPanelOnBus('4');
    render(withQueryClient(<AddElementPanel />));
    // No kind yet: the bus is kept for whichever is picked.
    expect(screen.getByTestId('add-element-seed-bus')).toHaveTextContent(
      'Adding on bus BUS4 (idx 4): a form that has a bus opens with it chosen.',
    );
    await user.selectOptions(screen.getByTestId('add-element-kind'), 'PQ');
    await waitFor(() => screen.getByTestId('element-form-PQ'));
    expect(screen.getByTestId('bus-idx-select')).toHaveValue('4');
    // Opening on the bus is not an edit: closing asks nothing.
    expect(useCaseStore.getState().addPanelDirty).toBe(false);

    await user.selectOptions(screen.getByTestId('add-element-kind'), 'ESD1');
    await waitFor(() => screen.getByTestId('element-form-ESD1'));
    expect(screen.getByTestId('bus-idx-select')).toHaveValue('4');
    expect(screen.getByTestId('gen-idx-select')).toHaveValue('6');
  });

  it('names a bus by its idx alone when that is its name, and says nothing otherwise', () => {
    MOCK_TOPOLOGY = twoBusTopology();
    useCaseStore.getState().openAddPanelOnBus('5');
    const view = render(withQueryClient(<AddElementPanel />));
    expect(screen.getByTestId('add-element-seed-bus')).toHaveTextContent('Adding on bus 5:');
    view.unmount();

    // A bus the case no longer has is not named, and nothing is seeded.
    useCaseStore.getState().openAddPanelOnBus('99');
    render(withQueryClient(<AddElementPanel />));
    expect(screen.queryByTestId('add-element-seed-bus')).toBeNull();
    view.unmount();

    useCaseStore.getState().openAddPanel('PQ');
    render(withQueryClient(<AddElementPanel />));
    expect(screen.queryByTestId('add-element-seed-bus')).toBeNull();
  });

  it('keeps the bus after an add, so the next element is built on it too', async () => {
    const user = userEvent.setup();
    MOCK_TOPOLOGY = twoBusTopology();
    useCaseStore.getState().openAddPanelOnBus('5');
    render(withQueryClient(<AddElementPanel />));
    await user.selectOptions(screen.getByTestId('add-element-kind'), 'PQ');
    await waitFor(() => screen.getByTestId('element-form-PQ'));
    await user.type(screen.getByTestId('field-name').querySelector('input')!, 'LOAD5');
    await user.type(screen.getByTestId('field-p0').querySelector('input')!, '0.1');
    await user.click(screen.getByRole('button', { name: /add pq/i }));
    await screen.findByTestId('add-element-success');
    expect(postSpy.mock.calls[0]?.[1]).toMatchObject({ model: 'PQ', params: { bus: '5' } });
    expect(screen.getByTestId('bus-idx-select')).toHaveValue('5');
    expect(useCaseStore.getState().addPanelBus).toBe('5');
  });

  it('asks for a generator after a battery took the one on the bus, and adds no second one on it', async () => {
    const user = userEvent.setup();
    MOCK_TOPOLOGY = twoBusTopology();
    useCaseStore.getState().openAddPanelOnBus('4');
    const view = render(withQueryClient(<AddElementPanel />));
    await user.selectOptions(screen.getByTestId('add-element-kind'), 'ESD1');
    await waitFor(() => screen.getByTestId('element-form-ESD1'));
    // On a bus with a free generator the form is complete as it opens.
    await user.click(screen.getByRole('button', { name: /add esd1/i }));
    await screen.findByTestId('add-element-success');
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0]?.[1]).toMatchObject({
      model: 'ESD1',
      params: { idx: 'ESD1_1', bus: '4', gen: '6' },
    });

    // The form is back on the bus. The case has the battery a moment later,
    // and with it the generator is no longer one to open the next form with.
    MOCK_TOPOLOGY = {
      ...twoBusTopology(),
      controllers: [{ idx: 'ESD1_1', name: 'ESD1_1', kind: 'ESD1', params: { bus: 4, gen: 6 } }],
    };
    view.rerender(withQueryClient(<AddElementPanel />));
    expect(screen.getByTestId('bus-idx-select')).toHaveValue('4');
    expect(screen.getByTestId('gen-idx-select')).toHaveValue('');
    expect(screen.queryByTestId('field-note-gen')).toBeNull();
    expect(screen.getByTestId('field-idx').querySelector('input')).toHaveValue('ESD1_2');

    await user.click(screen.getByRole('button', { name: /add esd1/i }));
    expect(screen.getByTestId('form-problems')).toHaveTextContent(
      'Nothing was added: gen is required and empty.',
    );
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it('goes from a battery on a bus without a generator to the PV form on that bus', async () => {
    const user = userEvent.setup();
    MOCK_TOPOLOGY = twoBusTopology();
    useCaseStore.setState({ addPanelOpen: true, addPanelKind: 'Battery' });
    render(withQueryClient(<AddElementPanel />));
    await waitFor(() => screen.getByTestId('element-form-ESD1'));
    await user.selectOptions(screen.getByTestId('bus-idx-select'), '5');
    await user.click(screen.getByRole('button', { name: 'Add a PV generator on bus 5' }));

    await waitFor(() => screen.getByTestId('element-form-PV'));
    expect(useCaseStore.getState().addPanelKind).toBe('PV');
    expect(useCaseStore.getState().addPanelBus).toBe('5');
    expect(screen.getByTestId('bus-idx-select')).toHaveValue('5');
    // Named after its idx: the set-point is all the short form asks for.
    expect(screen.getByTestId('field-name').querySelector('input')).toHaveValue('7');
    await user.type(screen.getByTestId('field-p0').querySelector('input')!, '0');
    await user.click(screen.getByRole('button', { name: /add pv/i }));
    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    expect(postSpy.mock.calls[0]?.[1]).toEqual({
      model: 'PV',
      params: { idx: '7', name: '7', bus: '5', p0: 0 },
    });
  });

  it('cancel on a dirty form opens the confirm dialog; Discard closes', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({ addPanelOpen: true, addPanelKind: 'Bus' });
    render(withQueryClient(<AddElementPanel />));
    await waitFor(() => screen.getByTestId('element-form-Bus'));
    await user.type(screen.getByTestId('field-Vn').querySelector('input')!, '99');
    expect(useCaseStore.getState().addPanelDirty).toBe(true);
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.getByTestId('add-element-cancel-confirm')).toBeInTheDocument();
    expect(useCaseStore.getState().addPanelOpen).toBe(true);
    await user.click(screen.getByTestId('confirm-discard'));
    expect(useCaseStore.getState().addPanelOpen).toBe(false);
  });
});
