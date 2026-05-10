/**
 * DisturbancePanel — empty state, list rendering, edit + delete flows.
 *
 * The dialog opens on Add / Edit clicks; this test file uses Radix's
 * non-modal-portal default which renders into the body during jsdom.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { DisturbancePanel } from '@/components/disturbance/DisturbancePanel';
import {
  __setUuidFactoryForTests,
  blankFaultSpec,
  blankToggleSpec,
  useDisturbanceStore,
} from '@/store/disturbance';
import type { TopologySummary } from '@/api/types';

let MOCK_TOPOLOGY: TopologySummary | null = null;

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useCurrentTopology: () => MOCK_TOPOLOGY,
    useAlterableParams: () => ({ data: { model: '', params: [] }, isLoading: false }),
  };
});

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

afterEach(() => {
  __setUuidFactoryForTests(null);
});

describe('<DisturbancePanel />', () => {
  it('renders the empty state when no disturbances are scheduled', () => {
    render(withQueryClient(<DisturbancePanel />));
    expect(screen.getByTestId('disturbance-empty-state')).toBeInTheDocument();
    expect(screen.getByText(/No disturbances scheduled/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Add one to define a fault, line trip, or parameter change/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('disturbance-list')).toBeNull();
  });

  it('shows the Add disturbance button + the timeline strip', () => {
    render(withQueryClient(<DisturbancePanel />));
    expect(screen.getByTestId('add-disturbance-button')).toBeInTheDocument();
    expect(screen.getByTestId('disturbance-timeline')).toBeInTheDocument();
  });

  it('renders a row per disturbance with the kind summary', () => {
    useDisturbanceStore
      .getState()
      .addDisturbance({ ...blankFaultSpec(), bus_idx: '5', tf: 1.0, tc: 1.1 });
    useDisturbanceStore
      .getState()
      .addDisturbance({ ...blankToggleSpec(), model: 'Line', dev_idx: '7', t: 2.5 });
    render(withQueryClient(<DisturbancePanel />));
    const list = screen.getByTestId('disturbance-list');
    expect(within(list).getByText(/Fault on Bus 5/)).toBeInTheDocument();
    expect(within(list).getByText(/Toggle Line 7/)).toBeInTheDocument();
  });

  it('clicking the Add button opens the AddEventDialog', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<DisturbancePanel />));
    expect(screen.queryByTestId('add-event-dialog')).toBeNull();
    await user.click(screen.getByTestId('add-disturbance-button'));
    expect(screen.getByTestId('add-event-dialog')).toBeInTheDocument();
  });

  it('clicking a row opens the dialog pre-filled (edit mode)', async () => {
    const user = userEvent.setup();
    const created = useDisturbanceStore
      .getState()
      .addDisturbance({ ...blankFaultSpec(), bus_idx: '5', tf: 1.0, tc: 1.1 });
    render(withQueryClient(<DisturbancePanel />));
    await user.click(screen.getByTestId(`disturbance-edit-${created.id}`));
    const dialog = screen.getByTestId('add-event-dialog');
    expect(dialog).toBeInTheDocument();
    // Edit mode hides the kind picker (it's a Fault — can't change kind).
    expect(within(dialog).queryByTestId('disturbance-kind')).toBeNull();
    // Dialog title is "Edit disturbance" in edit mode.
    expect(within(dialog).getByText(/Edit disturbance/i)).toBeInTheDocument();
  });

  it('clicking the trash icon removes the disturbance', async () => {
    const user = userEvent.setup();
    const created = useDisturbanceStore
      .getState()
      .addDisturbance({ ...blankFaultSpec(), bus_idx: '5', tf: 1.0, tc: 1.1 });
    render(withQueryClient(<DisturbancePanel />));
    await user.click(screen.getByTestId(`disturbance-delete-${created.id}`));
    expect(useDisturbanceStore.getState().disturbances).toHaveLength(0);
  });
});
