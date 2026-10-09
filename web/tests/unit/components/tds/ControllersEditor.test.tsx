/**
 * <ControllersEditor />: setting the frequency controllers of the next run.
 * The devices a controller can command come from the substrate; the hook is
 * replaced by a stand-in that answers from a fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProblemDetailsError } from '@/api/client';
import type { TdsControllerCatalogue, TdsControllerTarget, TopologySummary } from '@/api/types';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import { ControllersEditor } from '@/components/tds/ControllersEditor';
import { MAX_TDS_CONTROLLERS, type TdsControllerEntry } from '@/lib/tdsControllers';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { DEFAULT_TDS_CONFIG, useUiStore } from '@/store/ui';

type Answer = {
  data?: TdsControllerCatalogue;
  isError: boolean;
  error: Error | null;
  // Set while a fetch that failed is being tried again.
  failureCount?: number;
  failureReason?: Error | null;
};

let answer: Answer;
let asked = 0;
/** The session's topology, which says whether an element can be added now. */
let topology: TopologySummary | null = null;

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useTdsControllers: () => {
      asked += 1;
      return answer;
    },
    useCurrentTopology: () => topology,
  };
});

function caseTopology(state: TopologySummary['state']): TopologySummary {
  return {
    state,
    buses: [],
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
    shunts: [],
  };
}

/** The editor of a case with no device to command, whose button reads the session. */
function renderWithoutDevices() {
  answer = listing([]);
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ControllersEditor />
    </QueryClientProvider>,
  );
}

function battery(idx: number | string, extra: Partial<TdsControllerTarget> = {}) {
  const label = `ESD1 ${idx}`;
  return {
    model: 'ESD1',
    idx,
    name: `ESD1_${idx}`,
    bus: 4,
    in_service: true,
    p_limit: 40,
    fn: 60,
    variables: {
      command: `Pext ${label}`,
      frequency: `fHz ${label}`,
      active_current: `Ipout_y ${label}`,
      soc: `pIG_y ${label}`,
    },
    ...extra,
  } as TdsControllerTarget;
}

function listing(
  targets: TdsControllerTarget[],
  extra: Partial<TdsControllerCatalogue> = {},
): Answer {
  return {
    data: {
      types: ['droop', 'ffr'],
      coi_available: true,
      freq_hz: 60,
      base_mva: 100,
      targets,
      ...extra,
    },
    isError: false,
    error: null,
  };
}

function loadCase() {
  useSessionStore.setState({ sessionId: parseSessionId('sess-1') });
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('ieee14_esd1.xlsx'), addfiles: [] },
  });
}

function controllers(): readonly TdsControllerEntry[] {
  return useUiStore.getState().tdsConfig.controllers;
}

async function typeInto(user: ReturnType<typeof userEvent.setup>, field: string, text: string) {
  const input = screen.getByTestId(`field-tds-controller-${field}`);
  await user.clear(input);
  if (text !== '') await user.type(input, text);
}

beforeEach(() => {
  asked = 0;
  topology = caseTopology('pre-setup');
  answer = listing([battery(1), battery(2)]);
  useUiStore.setState({ tdsConfig: { ...DEFAULT_TDS_CONFIG }, tdsControllerResults: null });
  loadCase();
});

afterEach(() => {
  cleanup();
  useSessionStore.setState({ sessionId: null });
  useCaseStore.setState({ selection: null });
  useCaseStore.getState().closeAddPanel();
});

describe('<ControllersEditor />', () => {
  it('says what a controller is and offers to add one', () => {
    render(<ControllersEditor />);

    expect(screen.getByTestId('tds-config-controllers')).toHaveTextContent(
      'A controller reads the frequency while the run goes and sets the power of a battery',
    );
    expect(screen.getByTestId('tds-controllers-add')).toBeEnabled();
    expect(screen.queryByTestId('tds-controller-form')).toBeNull();
  });

  it('opens a droop on the first device, sized from its limit', async () => {
    const user = userEvent.setup();
    render(<ControllersEditor />);

    await user.click(screen.getByTestId('tds-controllers-add'));

    expect(screen.getByTestId('tds-controller-type-droop')).toBeChecked();
    const device = screen.getByTestId('tds-controller-target') as HTMLSelectElement;
    expect(device.selectedOptions[0]).toHaveTextContent('ESD1 1 (bus 4, up to 40 MW)');
    expect(screen.getByTestId('tds-controller-frequency-coi')).toBeChecked();
    expect(screen.getByTestId('field-tds-controller-gain')).toHaveValue('80');
    expect(screen.getByTestId('field-tds-controller-deadband')).toHaveValue('0.02');
    expect(screen.getByTestId('field-tds-controller-pMax')).toHaveValue('');
    expect(screen.getByTestId('tds-controller-form')).toHaveTextContent(
      "Leave blank for the device's own limit, 40 MW.",
    );
  });

  it('adds the droop to the run, with the variables that show it at work', async () => {
    const user = userEvent.setup();
    render(<ControllersEditor />);

    await user.click(screen.getByTestId('tds-controllers-add'));
    await user.selectOptions(
      screen.getByTestId('tds-controller-target'),
      'ESD1 2 (bus 4, up to 40 MW)',
    );
    await typeInto(user, 'gain', '100');
    await typeInto(user, 'pMax', '25');
    await user.click(screen.getByTestId('tds-controller-save'));

    expect(controllers()).toEqual([
      {
        spec: {
          type: 'droop',
          model: 'ESD1',
          idx: 2,
          frequency: 'coi',
          period: 0.1,
          t_start: 0,
          ramp: null,
          gain: 100,
          deadband: 0.02,
          p_max: 25,
        },
        record: ['Pext ESD1 2', 'Ipout_y ESD1 2', 'pIG_y ESD1 2'],
      },
    ]);
    // The form closes and the controller is listed in words.
    expect(screen.queryByTestId('tds-controller-form')).toBeNull();
    const row = screen.getByTestId('tds-controller-0');
    expect(row).toHaveTextContent('Droop on ESD1 2');
    expect(row).toHaveTextContent(
      '100 MW per Hz of the system frequency beyond ±0.02 Hz, up to 25 MW',
    );
  });

  it('adds a fast frequency response with its triggers, timing and ramp', async () => {
    const user = userEvent.setup();
    render(<ControllersEditor />);

    await user.click(screen.getByTestId('tds-controllers-add'));
    await user.click(screen.getByTestId('tds-controller-type-ffr'));
    // The power starts from the device's limit, the trigger at 0.1 Hz for 10 s.
    expect(screen.getByTestId('field-tds-controller-power')).toHaveValue('40');
    expect(screen.getByTestId('field-tds-controller-triggerDeviation')).toHaveValue('0.1');
    expect(screen.getByTestId('field-tds-controller-hold')).toHaveValue('10');
    expect(screen.queryByTestId('field-tds-controller-gain')).toBeNull();

    await typeInto(user, 'power', '30');
    await typeInto(user, 'triggerRocof', '0.5');
    await typeInto(user, 'hold', '5');
    await user.click(screen.getByTestId('tds-controller-frequency-bus'));
    await typeInto(user, 'period', '0.05');
    await typeInto(user, 'tStart', '1');
    await typeInto(user, 'ramp', '60');
    await user.click(screen.getByTestId('tds-controller-save'));

    expect(controllers()[0]?.spec).toEqual({
      type: 'ffr',
      model: 'ESD1',
      idx: 1,
      frequency: 'bus',
      period: 0.05,
      t_start: 1,
      ramp: 60,
      power: 30,
      trigger_deviation: 0.1,
      trigger_rocof: 0.5,
      hold: 5,
    });
    expect(screen.getByTestId('tds-controller-0')).toHaveTextContent(
      'Fast frequency response on ESD1 1',
    );
  });

  it('says which way a negative power waits for the frequency to go', async () => {
    const user = userEvent.setup();
    render(<ControllersEditor />);
    await user.click(screen.getByTestId('tds-controllers-add'));
    await user.click(screen.getByTestId('tds-controller-type-ffr'));
    const form = screen.getByTestId('tds-controller-form');
    expect(form).toHaveTextContent('this far below nominal');

    await typeInto(user, 'power', '-30');

    expect(form).toHaveTextContent('this far above nominal');
    expect(form).toHaveTextContent('when the frequency rises this fast');
  });

  it('says what is wrong beside the field, and adds nothing until it is put right', async () => {
    const user = userEvent.setup();
    render(<ControllersEditor />);
    await user.click(screen.getByTestId('tds-controllers-add'));
    await typeInto(user, 'gain', '');
    // No error before the first attempt to add.
    expect(screen.queryByTestId('error-tds-controller-gain')).toBeNull();

    await user.click(screen.getByTestId('tds-controller-save'));

    expect(screen.getByTestId('error-tds-controller-gain')).toHaveTextContent('Required');
    expect(screen.getByTestId('field-tds-controller-gain')).toHaveAttribute('aria-invalid', 'true');
    expect(controllers()).toEqual([]);

    // The message follows the typing, and the controller is added once it is gone.
    await typeInto(user, 'gain', '-3');
    expect(screen.getByTestId('error-tds-controller-gain')).toHaveTextContent('Must be above 0');
    await typeInto(user, 'gain', '50');
    expect(screen.queryByTestId('error-tds-controller-gain')).toBeNull();
    await user.click(screen.getByTestId('tds-controller-save'));
    expect(controllers()).toHaveLength(1);
  });

  it('Cancel adds nothing', async () => {
    const user = userEvent.setup();
    render(<ControllersEditor />);
    await user.click(screen.getByTestId('tds-controllers-add'));

    await user.click(screen.getByTestId('tds-controller-cancel'));

    expect(screen.queryByTestId('tds-controller-form')).toBeNull();
    expect(controllers()).toEqual([]);
  });

  it('edits a controller in place and removes one', async () => {
    const user = userEvent.setup();
    render(<ControllersEditor />);
    for (const gain of ['50', '60']) {
      await user.click(screen.getByTestId('tds-controllers-add'));
      await typeInto(user, 'gain', gain);
      await user.click(screen.getByTestId('tds-controller-save'));
    }

    await user.click(screen.getByTestId('tds-controller-1-edit'));
    // The form opens on what the controller holds.
    expect(screen.getByTestId('field-tds-controller-gain')).toHaveValue('60');
    await typeInto(user, 'gain', '75');
    await user.click(screen.getByTestId('tds-controller-save'));

    expect(controllers().map((c) => (c.spec.type === 'droop' ? c.spec.gain : null))).toEqual([
      50, 75,
    ]);

    await user.click(screen.getByTestId('tds-controller-0-remove'));

    expect(controllers()).toHaveLength(1);
    expect(screen.getByTestId('tds-controller-0')).toHaveTextContent('75 MW per Hz');
    expect(screen.queryByTestId('tds-controller-1')).toBeNull();
  });

  it('asks for a device again when the one a controller names has left the case', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ControllersEditor />);
    await user.click(screen.getByTestId('tds-controllers-add'));
    await user.selectOptions(
      screen.getByTestId('tds-controller-target'),
      'ESD1 2 (bus 4, up to 40 MW)',
    );
    await user.click(screen.getByTestId('tds-controller-save'));

    // Battery 2 is deleted from the case; its controller is still in the list.
    answer = listing([battery(1)]);
    rerender(<ControllersEditor />);
    await user.click(screen.getByTestId('tds-controller-0-edit'));
    await user.click(screen.getByTestId('tds-controller-save'));

    expect(screen.getByTestId('error-tds-controller-target')).toHaveTextContent('Pick a device');
    expect(controllers()[0]?.spec.idx).toBe(2);

    await user.selectOptions(
      screen.getByTestId('tds-controller-target'),
      'ESD1 1 (bus 4, up to 40 MW)',
    );
    await user.click(screen.getByTestId('tds-controller-save'));
    expect(controllers()[0]?.spec.idx).toBe(1);
    expect(controllers()[0]?.record).toContain('Pext ESD1 1');
  });

  it('says what each controller did in the last run, beside it', async () => {
    const user = userEvent.setup();
    render(<ControllersEditor />);
    await user.click(screen.getByTestId('tds-controllers-add'));
    await user.click(screen.getByTestId('tds-controller-save'));
    expect(screen.queryByTestId('tds-controller-0-result')).toBeNull();

    act(() => {
      useUiStore.getState().setTdsControllerResults([
        {
          type: 'droop',
          model: 'ESD1',
          idx: 1,
          samples: 60,
          first_action_t: 1.1001,
          released_t: null,
          peak_command: 15.9,
          final_command: 15.5,
        },
      ]);
    });

    expect(screen.getByTestId('tds-controller-0-result')).toHaveTextContent(
      'In the last run it acted from t = 1.1 s, peaked at 15.9 MW, 15.5 MW at the end.',
    );

    // A list that changed is no longer the one the results are of.
    await user.click(screen.getByTestId('tds-controller-0-remove'));
    expect(useUiStore.getState().tdsControllerResults).toBeNull();
  });

  it('tells a case without such a device where to get one', () => {
    renderWithoutDevices();

    expect(screen.getByTestId('tds-controllers-status')).toHaveTextContent(
      'This case has no device a controller can command. Add a battery (ESD1 battery, under Storage in the Add element panel)',
    );
    expect(screen.queryByTestId('tds-controllers-add')).toBeNull();
  });

  it("has the button that opens the battery's form, right where it says a battery is missing", async () => {
    const user = userEvent.setup();
    renderWithoutDevices();

    const button = screen.getByRole('button', { name: 'Add a battery' });
    expect(button).toBeEnabled();
    expect(screen.queryByTestId('tds-controllers-add-battery-blocked')).toBeNull();
    await user.click(button);
    // The Battery tile's own way in: the panel opens on the ESD1 form.
    expect(useCaseStore.getState()).toMatchObject({ addPanelOpen: true, addPanelKind: 'Battery' });
  });

  it('greys the button out and says why once a run has locked the system', () => {
    topology = caseTopology('committed');
    renderWithoutDevices();

    const button = screen.getByTestId('tds-controllers-add-battery');
    expect(button).toBeDisabled();
    const reason = screen.getByTestId('tds-controllers-add-battery-blocked');
    expect(reason).toHaveTextContent('A run has fixed the system.');
    expect(reason).toHaveTextContent('Reset run');
    expect(button).toHaveAttribute('aria-describedby', reason.id);
    expect(useCaseStore.getState().addPanelOpen).toBe(false);
  });

  it('has no such button on a case that has a device, or while the list is not in', () => {
    render(<ControllersEditor />);
    expect(screen.queryByTestId('tds-controllers-add-battery')).toBeNull();
    cleanup();

    answer = { isError: false, error: null };
    render(<ControllersEditor />);
    expect(screen.getByTestId('tds-controllers-status')).toHaveTextContent('Looking for devices');
    expect(screen.queryByTestId('tds-controllers-add-battery')).toBeNull();
  });

  it('only offers the bus frequency on a case with no synchronous machine', async () => {
    const user = userEvent.setup();
    answer = listing([battery(1)], { coi_available: false });
    render(<ControllersEditor />);

    await user.click(screen.getByTestId('tds-controllers-add'));

    expect(screen.getByTestId('tds-controller-frequency-coi')).toBeDisabled();
    expect(screen.getByTestId('tds-controller-frequency-bus')).toBeChecked();
    expect(screen.getByTestId('tds-controller-form')).toHaveTextContent(
      'this case has no synchronous machine to read it from',
    );
  });

  it('flags a device that is out of service and leaves an unlimited one unsized', async () => {
    const user = userEvent.setup();
    answer = listing([battery(1, { in_service: false, p_limit: null })]);
    render(<ControllersEditor />);

    await user.click(screen.getByTestId('tds-controllers-add'));

    const form = screen.getByTestId('tds-controller-form');
    expect(
      within(form).getByRole('option', { name: 'ESD1 1 (bus 4, out of service)' }),
    ).toBeInTheDocument();
    expect(form).toHaveTextContent('This device is out of service');
    expect(screen.getByTestId('field-tds-controller-gain')).toHaveValue('');
  });

  it('says so while a run holds the session, and when the list cannot be read', () => {
    const busy = new ProblemDetailsError({
      type: 'about:blank',
      status: 409,
      title: 'Conflict',
      detail: 'busy',
    });
    // The list is asked for again for as long as the run refuses it, so there
    // is no answer and no error all the while, only the refusals counted.
    answer = { isError: false, error: null, failureCount: 4, failureReason: busy };
    const { rerender, unmount } = render(<ControllersEditor />);
    expect(screen.getByTestId('tds-controllers-status')).toHaveTextContent(
      'The session is busy with a run. Controllers can be added when the run ends.',
    );
    // Refused again two seconds on: the same message, not "Looking for devices".
    answer = { ...answer, failureCount: 5 };
    rerender(<ControllersEditor />);
    expect(screen.getByTestId('tds-controllers-status')).toHaveTextContent(
      'The session is busy with a run.',
    );
    // A fetch given up while refused says the same.
    answer = { isError: true, error: busy };
    rerender(<ControllersEditor />);
    expect(screen.getByTestId('tds-controllers-status')).toHaveTextContent(
      'The session is busy with a run.',
    );
    unmount();

    answer = { isError: true, error: new Error('boom') };
    render(<ControllersEditor />);
    expect(screen.getByTestId('tds-controllers-status')).toHaveTextContent(
      'Could not list the devices a controller can command: boom',
    );
  });

  it('is still looking through a refusal or two, which another list asked for at once explains', () => {
    answer = {
      isError: false,
      error: null,
      failureCount: 2,
      failureReason: new ProblemDetailsError({
        type: 'about:blank',
        status: 409,
        title: 'Conflict',
        detail: 'busy',
      }),
    };
    render(<ControllersEditor />);
    expect(screen.getByTestId('tds-controllers-status')).toHaveTextContent(
      'Looking for devices a controller can command',
    );
  });

  it('asks for nothing and says why without a case', () => {
    useCaseStore.setState({ selection: null });
    render(<ControllersEditor />);

    expect(screen.getByTestId('tds-controllers-status')).toHaveTextContent(
      'Load a case to add a controller.',
    );
    expect(asked).toBe(0);
  });

  it('stops offering more at the most a run takes', () => {
    const entry: TdsControllerEntry = {
      spec: {
        type: 'droop',
        model: 'ESD1',
        idx: 1,
        frequency: 'coi',
        period: 0.1,
        t_start: 0,
        ramp: null,
        gain: 1,
        deadband: 0,
        p_max: null,
      },
      record: [],
    };
    useUiStore.getState().setTdsConfig({ controllers: Array(MAX_TDS_CONTROLLERS).fill(entry) });
    render(<ControllersEditor />);

    expect(screen.getByTestId('tds-controllers-add')).toBeDisabled();
    expect(screen.getByTestId('tds-config-controllers')).toHaveTextContent(
      `A run takes at most ${MAX_TDS_CONTROLLERS} controllers.`,
    );
  });
});
