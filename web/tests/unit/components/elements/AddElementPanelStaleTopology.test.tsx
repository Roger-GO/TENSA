/**
 * AddElementPanel against a topology that is behind the case.
 *
 * The other tests of the panel hand it a topology. Here the topology is the
 * real query, read from a client the test answers for, because what matters
 * is the order of things: an add asks for the topology again and the form is
 * back before the answer, and a form that is open holds what it chose from an
 * earlier read. Neither may end with a second device on a generator that one
 * already took over.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';

import { AddElementPanel } from '@/components/elements/AddElementPanel';
import { makeQueryClient, queryKeys } from '@/api/queries';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { parseSessionId } from '@/api/types';
import type { TopologySchema, TopologySummary } from '@/api/types';

const SCHEMA: TopologySchema = {
  models: {
    ESD1: [
      { name: 'idx', kind: 'string', required: true },
      { name: 'name', kind: 'string', required: true },
      { name: 'bus', kind: 'bus_idx', required: true },
      { name: 'gen', kind: 'gen_idx', required: true },
      { name: 'Sn', kind: 'number', required: true, unit: 'MVA' },
      { name: 'En', kind: 'number', required: true, unit: 'MWh' },
    ],
  },
};

const SESSION = parseSessionId('test-session-id');

/** The case as the server holds it: what a read of the topology answers with. */
let serverTopology: TopologySummary;
/** Set to keep the next read of the topology unanswered until `release()`. */
let holdNextRead = false;
let heldRead: { release: () => void } | null = null;
const postSpy = vi.fn();

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return {
    ...actual,
    andesClient: {
      get: (path: string) => {
        if (path === '/topology/schema') return Promise.resolve(SCHEMA);
        if (!holdNextRead) return Promise.resolve(serverTopology);
        holdNextRead = false;
        return new Promise<TopologySummary>((resolve) => {
          heldRead = { release: () => resolve(serverTopology) };
        });
      },
      post: (path: string, opts: { body?: unknown }) => {
        postSpy(path, opts.body);
        return Promise.resolve({ element: { idx: 'x', name: 'x', kind: 'ESD1', params: {} } });
      },
      put: vi.fn(),
    },
  };
});

/** Bus 4 with a free PV 6 on it, on a 100 MVA base. */
function oneGenerator(): TopologySummary {
  return {
    state: 'pre-setup',
    base_mva: 100,
    buses: [{ idx: 4, name: 'BUS4', kind: 'Bus', params: {} }],
    lines: [],
    transformers: [],
    generators: [{ idx: 6, name: '6', kind: 'PV', params: { bus: 4 } }],
    loads: [],
    shunts: [],
  };
}

/** The same once a battery `idx` has taken PV 6 over. */
function withBattery(idx: string): TopologySummary {
  return {
    ...oneGenerator(),
    controllers: [{ idx, name: idx, kind: 'ESD1', params: { bus: 4, gen: 6 } }],
  };
}

function genSelect(): HTMLSelectElement {
  return screen.getByTestId('gen-idx-select') as HTMLSelectElement;
}

function idxInput(): HTMLInputElement {
  return screen.getByTestId('field-idx').querySelector('input')!;
}

/** The panel on bus 4 with the battery's form, which opens with PV 6 chosen. */
async function openBatteryFormOnBus4() {
  const client = makeQueryClient();
  render(
    <QueryClientProvider client={client}>
      <AddElementPanel />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(genSelect()).toHaveValue('6'));
  return client;
}

beforeEach(() => {
  postSpy.mockClear();
  holdNextRead = false;
  heldRead = null;
  serverTopology = oneGenerator();
  useSessionStore.setState({ sessionId: SESSION, recoveryInProgress: false });
  useCaseStore.setState({
    selection: { primaryPath: null, addfiles: [], blank: true },
    addPanelOpen: true,
    addPanelKind: 'ESD1',
    addPanelDirty: false,
    addPanelBus: '4',
  });
});

describe('<AddElementPanel /> while the topology is behind the case', () => {
  it('opens the form after a battery without its generator, before the case is read again and after', async () => {
    const user = userEvent.setup();
    const client = await openBatteryFormOnBus4();
    // An idx of the user's own: the one the form proposes next is then no
    // repeat of it, which the server would refuse.
    await user.clear(idxInput());
    await user.type(idxInput(), 'BESS_7');

    holdNextRead = true;
    await user.click(screen.getByRole('button', { name: /add esd1/i }));
    await screen.findByTestId('add-element-success');
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0]?.[1]).toMatchObject({
      model: 'ESD1',
      params: { idx: 'BESS_7', bus: '4', gen: '6' },
    });
    serverTopology = withBattery('BESS_7');

    // The form is back and the read is not: what the form has still calls
    // PV 6 free, and it does not choose from that.
    expect(heldRead).not.toBeNull();
    expect(client.isFetching({ queryKey: queryKeys.topology(SESSION) })).toBe(1);
    expect(screen.getByTestId('bus-idx-select')).toHaveValue('4');
    expect(genSelect()).toHaveValue('');
    expect(idxInput()).toHaveValue('ESD1_1');
    await user.click(screen.getByRole('button', { name: /add esd1/i }));
    expect(screen.getByTestId('form-problems')).toHaveTextContent(
      'Nothing was added: gen is required and empty.',
    );
    expect(postSpy).toHaveBeenCalledTimes(1);

    // The read is in: the bus names who has its generator, and the form
    // goes on asking for one.
    await act(async () => {
      heldRead?.release();
      await Promise.resolve();
    });
    await waitFor(() => expect(idxInput()).toHaveValue('BESS_8'));
    const bus = screen.getByTestId('bus-idx-select') as HTMLSelectElement;
    expect(bus.options[bus.selectedIndex]?.text).toBe(
      '4 — BUS4 (generator: PV 6 used by ESD1 BESS_7)',
    );
    expect(genSelect()).toHaveValue('');
    await user.click(screen.getByRole('button', { name: /add esd1/i }));
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it('chooses the generator once the read is in, when no device took it', async () => {
    const user = userEvent.setup();
    const client = await openBatteryFormOnBus4();
    // The panel is sent to another bus and back while a read is on its way.
    holdNextRead = true;
    void client.invalidateQueries({ queryKey: queryKeys.topology(SESSION) });
    await waitFor(() => expect(heldRead).not.toBeNull());
    act(() => useCaseStore.getState().openAddPanelOnBus('99'));
    act(() => useCaseStore.getState().openAddPanelOnBus('4'));
    expect(genSelect()).toHaveValue('');

    await act(async () => {
      heldRead?.release();
      await Promise.resolve();
    });
    await waitFor(() => expect(genSelect()).toHaveValue('6'));
    expect(screen.getByTestId('field-note-gen')).toHaveTextContent(
      'Set to PV 6, the static generator on bus 4.',
    );
    await user.click(screen.getByRole('button', { name: /add esd1/i }));
    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
  });

  it('gives up the generator it chose when the case turns out to have a device on it', async () => {
    const user = userEvent.setup();
    const client = await openBatteryFormOnBus4();
    // Another client of the session (a script, an agent) adds a battery there.
    serverTopology = withBattery('ESD1_1');
    await act(async () => {
      await client.invalidateQueries({ queryKey: queryKeys.topology(SESSION) });
    });
    await waitFor(() => expect(genSelect()).toHaveValue(''));
    expect(screen.queryByTestId('field-note-gen')).toBeNull();
    expect(idxInput()).toHaveValue('ESD1_2');
    await user.click(screen.getByRole('button', { name: /add esd1/i }));
    expect(screen.getByTestId('form-problems')).toHaveTextContent(
      'Nothing was added: gen is required and empty.',
    );
    expect(postSpy).not.toHaveBeenCalled();
  });
});
