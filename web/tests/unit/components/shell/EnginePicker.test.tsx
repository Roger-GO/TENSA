/**
 * `<EnginePicker />`: the top-bar control that shows the engine and switches
 * it. Setup follows `TopBar.test.tsx` (a QueryClientProvider with retries off)
 * and the menu tests (userEvent). The API client is mocked and the rest is
 * real: `startSessionOver` sends its DELETE through it, and the store cascade
 * closes the case. Sienna is made available here with a stand-in list, since
 * the server does not have it yet; the switch path is the same.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client');
  return { ...actual, andesClient: { post: vi.fn(), delete: vi.fn(), get: vi.fn() } };
});

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { EnginePicker } from '@/components/shell/EnginePicker';
import { andesClient } from '@/api/client';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { EngineList } from '@/api/types';
import { toast } from '@/lib/toast';
import { __resetCascadeForTests, wireStoreCascade } from '@/store';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useRunsStore } from '@/store/runs';
import { useEditJournalStore } from '@/store/editJournal';

const del = vi.mocked(andesClient.delete);

// The confirm is a chunk of its own, fetched when it first opens. Fetched here,
// so a test waits for its mount and not for a cold import that takes longer
// than a wait while the whole suite runs.
beforeAll(async () => {
  await import('@/components/shell/SwitchEngineConfirmDialog');
});

const FRESH_SESSION = {
  sessionId: null,
  engine: null,
  previousEngine: null,
  engines: null,
  recoveryInProgress: false,
  recoveryFailed: false,
  recoveryAttempts: [],
  recoveryStuckSince: null,
};

const ANDES = {
  name: 'andes',
  available: true,
  unavailable_reason: null,
  versions: {},
  formats: { read: [], write: [] },
  routines: ['pflow', 'tds', 'eig', 'cpf', 'se'],
  ops: [],
  editing: true,
};

const SIENNA_UNAVAILABLE = {
  name: 'sienna',
  available: false,
  unavailable_reason: 'Julia was not found on this computer.',
  versions: {},
  formats: { read: [], write: [] },
  routines: [],
  ops: [],
  editing: false,
};

const SIENNA = {
  ...SIENNA_UNAVAILABLE,
  available: true,
  unavailable_reason: null,
  routines: ['pflow', 'tds'],
};

function list(...entries: unknown[]): EngineList {
  return { engines: entries } as EngineList;
}

const CASE = { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] };

function renderPicker() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <EnginePicker />
    </QueryClientProvider>,
  );
}

function live(engines: EngineList | null = list(ANDES, SIENNA)) {
  useSessionStore.setState({ sessionId: parseSessionId('sess-1'), engine: 'andes', engines });
}

const trigger = () => screen.getByTestId('engine-picker-trigger');
const option = (name: string) => screen.getByTestId(`engine-picker-option-${name}`);

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(trigger());
  return screen.findByTestId('engine-picker-content');
}

beforeEach(() => {
  wireStoreCascade();
  useSessionStore.setState(FRESH_SESSION);
  del.mockReset();
  del.mockResolvedValue(undefined as never);
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  cleanup();
  __resetCascadeForTests();
  useSessionStore.setState(FRESH_SESSION);
  useEditJournalStore.getState().reset();
  usePflowStore.setState({ isRunning: false });
  window.sessionStorage.clear();
});

describe('<EnginePicker /> trigger', () => {
  it('shows the engine of the session, and is named for what it is', () => {
    live();
    renderPicker();
    expect(trigger()).toHaveTextContent('ANDES');
    expect(trigger()).toHaveAccessibleName('Engine: ANDES');
    expect(trigger()).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('shows the default engine before the first session has answered', () => {
    renderPicker();
    expect(trigger()).toHaveTextContent('ANDES');
  });

  it('with no list of engines, opens to one line that says so, and nothing throws', async () => {
    const user = userEvent.setup();
    live(null);
    renderPicker();
    const menu = await openMenu(user);
    expect(within(menu).getByTestId('engine-picker-no-list')).toHaveTextContent(
      'The list of engines is not available.',
    );
    expect(within(menu).queryAllByRole('menuitem')).toHaveLength(0);
  });
});

describe('<EnginePicker /> the list', () => {
  it('lists every engine with its routines, the current one marked', async () => {
    const user = userEvent.setup();
    live(list(ANDES, SIENNA_UNAVAILABLE));
    renderPicker();
    const menu = await openMenu(user);
    expect(menu).toHaveAttribute('role', 'menu');
    expect(menu).toHaveAccessibleName('Engine');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('ANDES'),
      expect.stringContaining('Sienna'),
    ]);
    expect(option('andes')).toHaveTextContent('pflow, tds, eig, cpf, se');
    expect(option('andes')).toHaveAttribute('aria-current', 'true');
    expect(option('sienna')).not.toHaveAttribute('aria-current');
  });

  it('an unavailable engine is aria-disabled with the reason as its description', async () => {
    const user = userEvent.setup();
    live(list(ANDES, SIENNA_UNAVAILABLE));
    renderPicker();
    await openMenu(user);
    const sienna = option('sienna');
    expect(sienna).toHaveAttribute('aria-disabled', 'true');
    expect(sienna).toHaveAccessibleName('Sienna');
    expect(sienna).toHaveAccessibleDescription('Julia was not found on this computer.');
    expect(screen.getByTestId('engine-picker-option-sienna-reason')).toBeVisible();
  });

  it('an unavailable engine cannot be chosen', async () => {
    const user = userEvent.setup();
    live(list(ANDES, SIENNA_UNAVAILABLE));
    renderPicker();
    await openMenu(user);
    await user.click(option('sienna'));
    expect(del).not.toHaveBeenCalled();
    expect(useSessionStore.getState()).toMatchObject({ sessionId: 'sess-1', engine: 'andes' });
    // The menu stays open, as for any entry that cannot be used now.
    expect(screen.getByTestId('engine-picker-content')).toBeInTheDocument();
  });

  it('works from the keyboard: arrows, Enter, Escape, focus back on the trigger', async () => {
    const user = userEvent.setup();
    live();
    renderPicker();
    trigger().focus();
    await user.keyboard('{Enter}');
    await screen.findByTestId('engine-picker-content');
    await waitFor(() => expect(option('andes')).toHaveFocus());
    await user.keyboard('{ArrowDown}');
    expect(option('sienna')).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('engine-picker-content')).toBeNull());
    expect(trigger()).toHaveFocus();
    expect(del).not.toHaveBeenCalled();

    await user.keyboard('{Enter}');
    await waitFor(() => expect(option('andes')).toHaveFocus());
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
  });

  it('a change of the list while the menu is open is shown at once', async () => {
    const user = userEvent.setup();
    live(list(ANDES, SIENNA));
    renderPicker();
    await openMenu(user);
    expect(option('sienna')).not.toHaveAttribute('aria-disabled');
    act(() => useSessionStore.setState({ engines: list(ANDES, SIENNA_UNAVAILABLE) }));
    expect(option('sienna')).toHaveAttribute('aria-disabled', 'true');
    await user.click(option('sienna'));
    expect(del).not.toHaveBeenCalled();
  });
});

describe('<EnginePicker /> engine versions', () => {
  const ANDES_VERSIONED = { ...ANDES, versions: { andes: '1.9.3' } };
  const SIENNA_VERSIONED = {
    ...SIENNA,
    versions: {
      julia: '1.11.3',
      PowerSystems: '5.12.5',
      PowerFlows: '0.16.4',
      PowerNetworkMatrices: '0.15.2',
      PowerSimulationsDynamics: '0.18.1',
    },
  };
  // Written out by hand: julia first, then the packages alphabetically.
  const SIENNA_LINE =
    'julia 1.11.3, PowerFlows 0.16.4, PowerNetworkMatrices 0.15.2, ' +
    'PowerSimulationsDynamics 0.18.1, PowerSystems 5.12.5';

  it('shows the versions line under the routines of each engine in the opened list', async () => {
    const user = userEvent.setup();
    live(list(ANDES_VERSIONED, SIENNA_VERSIONED));
    renderPicker();
    await openMenu(user);
    expect(option('andes')).toHaveTextContent('pflow, tds, eig, cpf, se');
    expect(option('andes')).toHaveTextContent('andes 1.9.3');
    expect(screen.getByTestId('engine-picker-option-andes-detail')).toHaveTextContent(
      'andes 1.9.3',
    );
    expect(option('sienna')).toHaveTextContent('pflow, tds');
    expect(screen.getByTestId('engine-picker-option-sienna-detail')).toHaveTextContent(SIENNA_LINE);
  });

  it('an engine with an empty versions map shows no versions line', async () => {
    const user = userEvent.setup();
    live(list(ANDES, SIENNA_VERSIONED));
    renderPicker();
    await openMenu(user);
    expect(option('andes')).toHaveTextContent('pflow, tds, eig, cpf, se');
    expect(screen.queryByTestId('engine-picker-option-andes-detail')).toBeNull();
    expect(option('andes').textContent).not.toMatch(/\d+\.\d+/);
  });

  it('the trigger is unchanged: no versions leak into the top bar', async () => {
    const user = userEvent.setup();
    live(list(ANDES_VERSIONED, SIENNA_VERSIONED));
    renderPicker();
    expect(trigger()).toHaveTextContent('ANDES');
    expect(trigger().textContent).toBe('ANDES');
    expect(trigger()).toHaveAccessibleName('Engine: ANDES');
    await openMenu(user);
    expect(trigger().textContent).toBe('ANDES');
  });
});

describe('<EnginePicker /> switching with no case open', () => {
  it('switches with no confirm: DELETE, then the new engine with no session', async () => {
    const user = userEvent.setup();
    live();
    renderPicker();
    await openMenu(user);
    await user.click(option('sienna'));
    expect(screen.queryByTestId('switch-engine-confirm')).toBeNull();
    await waitFor(() =>
      expect(useSessionStore.getState()).toMatchObject({
        sessionId: null,
        engine: 'sienna',
        previousEngine: 'andes',
      }),
    );
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0]?.[0]).toBe('/sessions/sess-1');
    expect(trigger()).toHaveAccessibleName('Engine: Sienna');
  });

  it('choosing the current engine does nothing', async () => {
    const user = userEvent.setup();
    live();
    renderPicker();
    await openMenu(user);
    await user.click(option('andes'));
    expect(del).not.toHaveBeenCalled();
    expect(screen.queryByTestId('switch-engine-confirm')).toBeNull();
    expect(useSessionStore.getState()).toMatchObject({ sessionId: 'sess-1', engine: 'andes' });
  });

  it('a double click sends one DELETE', async () => {
    const user = userEvent.setup();
    live();
    let answer: () => void = () => {};
    del.mockReturnValue(new Promise<void>((resolve) => (answer = resolve)) as never);
    renderPicker();
    await openMenu(user);
    const sienna = option('sienna');
    await user.dblClick(sienna);
    await act(async () => answer());
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('a DELETE that fails leaves the old engine shown and says why', async () => {
    const user = userEvent.setup();
    live();
    del.mockRejectedValue(new Error('Failed to fetch'));
    renderPicker();
    await openMenu(user);
    await user.click(option('sienna'));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toBe(
      'Could not switch to Sienna: Failed to fetch',
    );
    expect(useSessionStore.getState()).toMatchObject({ sessionId: 'sess-1', engine: 'andes' });
    expect(trigger()).toHaveAccessibleName('Engine: ANDES');
  });

  it('while a power flow runs, the other engines say why they cannot be chosen', async () => {
    const user = userEvent.setup();
    live();
    usePflowStore.setState({ isRunning: true });
    renderPicker();
    await openMenu(user);
    expect(option('sienna')).toHaveAttribute('aria-disabled', 'true');
    expect(option('sienna')).toHaveAccessibleDescription('Wait for power flow to finish.');
    await user.click(option('sienna'));
    expect(del).not.toHaveBeenCalled();
  });

  it('with no live session, no engine can be chosen', async () => {
    const user = userEvent.setup();
    useSessionStore.setState({ engines: list(ANDES, SIENNA) });
    renderPicker();
    await openMenu(user);
    expect(option('sienna')).toHaveAccessibleDescription('Waiting for a session to start.');
    await user.click(option('sienna'));
    expect(del).not.toHaveBeenCalled();
    expect(useSessionStore.getState().engine).toBeNull();
  });
});

describe('<EnginePicker /> switching with a case open', () => {
  function openCase() {
    live();
    act(() => useCaseStore.getState().setCase(CASE));
  }

  it('the confirm loads on first open: nothing of it is mounted until a switch asks', async () => {
    const user = userEvent.setup();
    openCase();
    renderPicker();
    expect(screen.queryByTestId('switch-engine-confirm')).toBeNull();
    await openMenu(user);
    expect(screen.queryByTestId('switch-engine-confirm')).toBeNull();
    await user.click(option('sienna'));
    expect(await screen.findByTestId('switch-engine-confirm')).toBeInTheDocument();
  });

  it('asks first, and says the case will be closed', async () => {
    const user = userEvent.setup();
    openCase();
    renderPicker();
    await openMenu(user);
    await user.click(option('sienna'));
    const dialog = await screen.findByTestId('switch-engine-confirm');
    expect(within(dialog).getByRole('heading')).toHaveTextContent('Switch to Sienna?');
    expect(dialog).toHaveTextContent(
      'A session belongs to one engine, so switching starts a new session. The open case will be closed.',
    );
    expect(dialog).not.toHaveTextContent('unsaved edits');
    expect(dialog).not.toHaveTextContent('run under way');
    // Nothing has happened yet.
    expect(del).not.toHaveBeenCalled();
    expect(useSessionStore.getState()).toMatchObject({ sessionId: 'sess-1', engine: 'andes' });
  });

  it('says the unsaved edits will be lost when there are any', async () => {
    const user = userEvent.setup();
    openCase();
    act(() =>
      useEditJournalStore.getState().record({ op: 'add', model: 'Bus', params: { idx: 9 } }),
    );
    renderPicker();
    await openMenu(user);
    await user.click(option('sienna'));
    expect(await screen.findByTestId('switch-engine-confirm')).toHaveTextContent(
      'Its unsaved edits will be lost.',
    );
  });

  it('says a run under way will be stopped', async () => {
    const user = userEvent.setup();
    openCase();
    act(() =>
      useRunsStore.setState({ runs: { r1: { runId: 'r1', state: 'streaming' } as never } }),
    );
    renderPicker();
    await openMenu(user);
    await user.click(option('sienna'));
    expect(await screen.findByTestId('switch-engine-confirm')).toHaveTextContent(
      'The run under way will be stopped.',
    );
  });

  it('Cancel changes nothing, and the focus goes back to the picker', async () => {
    const user = userEvent.setup();
    openCase();
    renderPicker();
    await openMenu(user);
    await user.click(option('sienna'));
    await user.click(await screen.findByTestId('switch-engine-confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('switch-engine-confirm')).toBeNull());
    expect(del).not.toHaveBeenCalled();
    expect(useSessionStore.getState()).toMatchObject({
      sessionId: 'sess-1',
      engine: 'andes',
      previousEngine: null,
    });
    expect(useCaseStore.getState().selection).toEqual(CASE);
    await waitFor(() => expect(trigger()).toHaveFocus());
  });

  it('Switch engine releases the session and closes the case', async () => {
    const user = userEvent.setup();
    openCase();
    renderPicker();
    await openMenu(user);
    await user.click(option('sienna'));
    await user.click(await screen.findByTestId('switch-engine-confirm-accept'));
    await waitFor(() =>
      expect(useSessionStore.getState()).toMatchObject({ sessionId: null, engine: 'sienna' }),
    );
    expect(del).toHaveBeenCalledTimes(1);
    expect(useCaseStore.getState().selection).toBeNull();
    expect(screen.queryByTestId('switch-engine-confirm')).toBeNull();
  });

  it('an engine that went away while the confirm was open is not switched to', async () => {
    const user = userEvent.setup();
    openCase();
    renderPicker();
    await openMenu(user);
    await user.click(option('sienna'));
    await screen.findByTestId('switch-engine-confirm');
    act(() => useSessionStore.setState({ engines: list(ANDES, SIENNA_UNAVAILABLE) }));
    await user.click(screen.getByTestId('switch-engine-confirm-accept'));
    expect(del).not.toHaveBeenCalled();
    expect(useCaseStore.getState().selection).toEqual(CASE);
    expect(toast.error).toHaveBeenCalledWith(
      'Could not switch to Sienna',
      expect.objectContaining({ description: 'Julia was not found on this computer.' }),
    );
  });
});
