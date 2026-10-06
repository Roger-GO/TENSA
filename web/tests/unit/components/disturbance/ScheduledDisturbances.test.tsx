/**
 * <ScheduledDisturbances />: the sidebar's list of what the next TDS run does
 * to the system, and the way to add a fault to it. Besides the user's own
 * disturbances it lists, read-only, the events the case defines.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { ScheduledDisturbances } from '@/components/disturbance/ScheduledDisturbances';
import {
  __setUuidFactoryForTests,
  blankFaultSpec,
  blankToggleSpec,
  useDisturbanceStore,
} from '@/store/disturbance';
import { useCaseStore } from '@/store/case';
import { useLayoutStore } from '@/store/layout';
import { useUiStore } from '@/store/ui';
import type { CaseEvent, TopologySummary } from '@/api/types';

let MOCK_TOPOLOGY: TopologySummary | null = null;

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useCurrentTopology: () => MOCK_TOPOLOGY,
    useAlterableParams: () => ({ data: { model: '', params: [] }, isLoading: false }),
  };
});

// The dialog's chunk is imported and transformed the first time a test opens
// it, which on a loaded machine takes longer than the default wait.
const COLD_LOAD_MS = 15_000;

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

let counter = 0;
beforeEach(() => {
  counter = 0;
  __setUuidFactoryForTests(() => `id-${++counter}`);
  useDisturbanceStore.setState({ disturbances: [], dirty: false, committed: false });
  useUiStore.getState().resetTdsConfig();
  // Kundur numbers its buses 1 to 10 and names them differently: idx 7 is bus "3".
  MOCK_TOPOLOGY = {
    state: 'pre-setup',
    buses: [
      { idx: '1', name: '1', kind: 'Bus', params: {} },
      { idx: '7', name: '3', kind: 'Bus', params: {} },
    ],
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
    shunts: [],
  };
  useCaseStore.setState({ topology: MOCK_TOPOLOGY });
});

afterEach(() => {
  cleanup();
  __setUuidFactoryForTests(null);
  useCaseStore.setState({ topology: null });
});

describe('<ScheduledDisturbances />', () => {
  it('says that no fault is set, and what that means for the run', () => {
    render(withQueryClient(<ScheduledDisturbances />));
    const empty = screen.getByTestId('scheduled-disturbances-empty');
    expect(empty).toHaveTextContent(
      /No fault is set.*Neither this list nor the case schedules.*nothing to disturb the system/s,
    );
    // It makes no claim about the curves: only that nothing is scheduled.
    expect(empty).not.toHaveTextContent(/flat/);
    // The diagram's menu is the other way to a fault, and nothing else says so.
    expect(empty).toHaveTextContent(/right-click a bus on the diagram and choose Fault here/);
    expect(screen.getByRole('button', { name: 'Add fault' })).toBeInTheDocument();
    expect(screen.queryByTestId('scheduled-disturbances-list')).toBeNull();
  });

  it('adds a fault through the dialog: pick the bus, times prefilled, and it shows in the list', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<ScheduledDisturbances />));

    await user.click(screen.getByRole('button', { name: 'Add fault' }));
    // The dialog is a chunk of its own, fetched when it is first opened.
    const dialog = await screen.findByTestId('add-event-dialog', undefined, {
      timeout: COLD_LOAD_MS,
    });
    // A fault, by default, with the times a first fault wants already in.
    expect(within(dialog).getByTestId('fault-spec-form')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Fault applied at (s)')).toHaveValue('1');
    expect(within(dialog).getByLabelText('Fault cleared at (s)')).toHaveValue('1.1');
    // It cannot be saved before a bus is picked.
    expect(within(dialog).getByTestId('add-event-save')).toBeDisabled();

    await user.selectOptions(within(dialog).getByLabelText('Bus'), '7');
    await user.click(within(dialog).getByTestId('add-event-save'));

    expect(screen.queryByTestId('add-event-dialog')).toBeNull();
    const stored = useDisturbanceStore.getState().disturbances;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.spec).toMatchObject({ kind: 'fault', bus_idx: 7, tf: 1, tc: 1.1 });
    const list = screen.getByTestId('scheduled-disturbances-list');
    expect(within(list).getByText('Fault on bus 3 (idx 7)')).toBeInTheDocument();
    expect(within(list).getByText('Applied at 1 s, cleared at 1.1 s')).toBeInTheDocument();
    expect(screen.queryByTestId('scheduled-disturbances-empty')).toBeNull();
    expect(screen.getByText('Applied the next time you run TDS.')).toBeInTheDocument();
  });

  it('says when the run ends, with or without a disturbance, and follows the TDS tab', () => {
    render(withQueryClient(<ScheduledDisturbances />));
    const line = screen.getByTestId('scheduled-disturbances-run-end');
    expect(line).toHaveTextContent('A TDS run ends at 10 s.');

    act(() => useUiStore.getState().setTdsConfig({ tf: 2 }));
    expect(line).toHaveTextContent('A TDS run ends at 2 s.');

    act(() => {
      useDisturbanceStore.getState().addDisturbance({ ...blankFaultSpec(), bus_idx: '7' });
    });
    expect(screen.getByText('Applied the next time you run TDS.')).toBeInTheDocument();
    expect(screen.getByTestId('scheduled-disturbances-run-end')).toHaveTextContent(
      'A TDS run ends at 2 s.',
    );
  });

  it('says so when the end time field is empty or not a time, and prints neither', () => {
    useUiStore.getState().setTdsConfig({ tf: Number.NaN });
    render(withQueryClient(<ScheduledDisturbances />));
    const line = screen.getByTestId('scheduled-disturbances-run-end');
    expect(line).toHaveTextContent('A TDS run has no valid end time.');
    expect(line).not.toHaveTextContent('NaN');

    act(() => useUiStore.getState().setTdsConfig({ tf: -1 }));
    expect(line).toHaveTextContent('A TDS run has no valid end time.');
    expect(line).not.toHaveTextContent('-1');
    // The way to the field that needs fixing is still there.
    expect(screen.getByRole('button', { name: 'Change the end time' })).toBeInTheDocument();
  });

  it('opens the TDS tab, where the end time is set, from the line that states it', async () => {
    const user = userEvent.setup();
    useLayoutStore.setState({
      activeBottomDrawerTab: 'buses',
      activeAnalysisSubTab: 'plot',
      bottomDrawerCollapsed: true,
    });
    try {
      render(withQueryClient(<ScheduledDisturbances />));

      await user.click(screen.getByRole('button', { name: 'Change the end time' }));

      const layout = useLayoutStore.getState();
      expect(layout.activeBottomDrawerTab).toBe('analysis');
      expect(layout.activeAnalysisSubTab).toBe('tds');
      expect(layout.bottomDrawerCollapsed).toBe(false);
    } finally {
      useLayoutStore.setState({
        activeBottomDrawerTab: 'buses',
        activeAnalysisSubTab: 'plot',
        bottomDrawerCollapsed: false,
      });
    }
  });

  it('names a bus once, when its name is its idx', () => {
    useDisturbanceStore.getState().addDisturbance({ ...blankFaultSpec(), bus_idx: '1' });
    render(withQueryClient(<ScheduledDisturbances />));
    expect(screen.getByText('Fault on bus 1')).toBeInTheDocument();
  });

  it('falls back to the idx for a bus the topology does not list', () => {
    useDisturbanceStore.getState().addDisturbance({ ...blankFaultSpec(), bus_idx: '99' });
    render(withQueryClient(<ScheduledDisturbances />));
    expect(screen.getByText('Fault on bus 99')).toBeInTheDocument();
  });

  it('lists the disturbances in time order, whatever kind they are', () => {
    const later = useDisturbanceStore
      .getState()
      .addDisturbance({ ...blankToggleSpec(), model: 'Line', dev_idx: '4', t: 2.5 });
    const earlier = useDisturbanceStore
      .getState()
      .addDisturbance({ ...blankFaultSpec(), bus_idx: '7', tf: 1.0, tc: 1.1 });
    render(withQueryClient(<ScheduledDisturbances />));
    const rows = within(screen.getByTestId('scheduled-disturbances-list')).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      `scheduled-disturbance-${earlier.id}`,
      `scheduled-disturbance-${later.id}`,
    ]);
    expect(rows[1]).toHaveTextContent('Toggle Line 4');
  });

  it('opens a disturbance for editing, and saves the change in place', async () => {
    const user = userEvent.setup();
    const created = useDisturbanceStore
      .getState()
      .addDisturbance({ ...blankFaultSpec(), bus_idx: '7', tf: 1.0, tc: 1.1 });
    render(withQueryClient(<ScheduledDisturbances />));

    await user.click(screen.getByTestId(`scheduled-disturbance-edit-${created.id}`));
    const dialog = await screen.findByTestId('add-event-dialog', undefined, {
      timeout: COLD_LOAD_MS,
    });
    expect(within(dialog).getByText('Edit disturbance')).toBeInTheDocument();
    const clear = within(dialog).getByLabelText('Fault cleared at (s)');
    await user.clear(clear);
    await user.type(clear, '1.3');
    await user.click(within(dialog).getByTestId('add-event-save'));

    const stored = useDisturbanceStore.getState().disturbances;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(created.id);
    expect(stored[0]?.spec).toMatchObject({ kind: 'fault', tc: 1.3 });
    expect(screen.getByText('Applied at 1 s, cleared at 1.3 s')).toBeInTheDocument();
  });

  it('deletes a disturbance, and goes back to saying that no fault is set', async () => {
    const user = userEvent.setup();
    const created = useDisturbanceStore
      .getState()
      .addDisturbance({ ...blankFaultSpec(), bus_idx: '7' });
    render(withQueryClient(<ScheduledDisturbances />));

    await user.click(screen.getByTestId(`scheduled-disturbance-delete-${created.id}`));

    expect(useDisturbanceStore.getState().disturbances).toEqual([]);
    expect(screen.getByTestId('scheduled-disturbances-empty')).toBeInTheDocument();
  });

  it('offers another disturbance once there is one', async () => {
    const user = userEvent.setup();
    useDisturbanceStore.getState().addDisturbance({ ...blankFaultSpec(), bus_idx: '7' });
    render(withQueryClient(<ScheduledDisturbances />));

    await user.click(screen.getByRole('button', { name: 'Add disturbance' }));
    const dialog = await screen.findByTestId('add-event-dialog', undefined, {
      timeout: COLD_LOAD_MS,
    });
    // A new one, not the existing one.
    expect(within(dialog).getByText('Add disturbance', { selector: 'h2' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Bus')).toHaveValue('');
  });

  describe('events the case defines', () => {
    const kundurTrip: CaseEvent = {
      source: 'case',
      kind: 'toggle',
      name: 'Toggler_1',
      t: 2,
      model: 'Line',
      dev_idx: 'Line_8',
    };

    function withEvents(events: CaseEvent[]) {
      useCaseStore.setState({ topology: { ...MOCK_TOPOLOGY!, events } });
    }

    it('lists the line trip the case file sets, read-only, instead of saying nothing is set', () => {
      withEvents([kundurTrip]);
      render(withQueryClient(<ScheduledDisturbances />));

      expect(screen.queryByTestId('scheduled-disturbances-empty')).toBeNull();
      const row = screen.getByTestId('scheduled-case-event-0');
      expect(row).toHaveTextContent('Toggle Line Line_8');
      expect(row).toHaveTextContent('At 2 s');
      expect(row).toHaveTextContent('Set by the case (Toggler_1)');
      // The user cannot edit or delete what the file defines.
      expect(within(row).queryByRole('button')).toBeNull();
      expect(screen.getByText('Applied the next time you run TDS.')).toBeInTheDocument();
    });

    it('still offers Add fault while only the case sets events', () => {
      withEvents([kundurTrip]);
      render(withQueryClient(<ScheduledDisturbances />));
      expect(screen.getByRole('button', { name: 'Add fault' })).toBeInTheDocument();
    });

    it('shows the case events and the user own ones together, in time order', () => {
      withEvents([kundurTrip]);
      const early = useDisturbanceStore
        .getState()
        .addDisturbance({ ...blankFaultSpec(), bus_idx: '7', tf: 1.0, tc: 1.1 });
      render(withQueryClient(<ScheduledDisturbances />));

      const rows = within(screen.getByTestId('scheduled-disturbances-list')).getAllByRole(
        'listitem',
      );
      expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
        `scheduled-disturbance-${early.id}`,
        'scheduled-case-event-0',
      ]);
      expect(screen.getByRole('button', { name: 'Add disturbance' })).toBeInTheDocument();
    });

    it('names the bus of a fault the case sets, and says when it is never cleared', () => {
      withEvents([
        {
          source: 'case',
          kind: 'fault',
          name: 'Fault_1',
          t: 1,
          tc: null,
          model: 'Bus',
          dev_idx: 7,
        },
        { source: 'case', kind: 'fault', t: 3, tc: 3.1, model: 'Bus', dev_idx: 1 },
      ]);
      render(withQueryClient(<ScheduledDisturbances />));

      const first = screen.getByTestId('scheduled-case-event-0');
      expect(first).toHaveTextContent('Fault on bus 3 (idx 7)');
      expect(first).toHaveTextContent('Applied at 1 s, not cleared');
      const second = screen.getByTestId('scheduled-case-event-1');
      expect(second).toHaveTextContent('Fault on bus 1');
      expect(second).toHaveTextContent('Applied at 3 s, cleared at 3.1 s');
      // No name in the file: it still says where the event comes from.
      expect(second).toHaveTextContent('Set by the case');
      expect(second).not.toHaveTextContent('(');
    });

    it('says what an alteration of the case changes', () => {
      withEvents([
        {
          source: 'case',
          kind: 'alter',
          name: 'Alter_1',
          t: 2.5,
          model: 'PQ',
          dev_idx: 'PQ_1',
          src: 'Ppf',
          method: '*',
          amount: 1.2,
        },
      ]);
      render(withQueryClient(<ScheduledDisturbances />));
      const row = screen.getByTestId('scheduled-case-event-0');
      expect(row).toHaveTextContent('Alter PQ PQ_1: Ppf * 1.2');
      expect(row).toHaveTextContent('At 2.5 s');
    });

    it('says a replayed disturbance came from the bundle or snapshot', () => {
      withEvents([{ source: 'restored', kind: 'fault', t: 1, tc: 1.1, model: 'Bus', dev_idx: 7 }]);
      render(withQueryClient(<ScheduledDisturbances />));
      const row = screen.getByTestId('scheduled-case-event-0');
      expect(row).toHaveTextContent('Fault on bus 3 (idx 7)');
      expect(row).toHaveTextContent('Replayed from a bundle or snapshot');
    });
  });
});
