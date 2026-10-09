/**
 * Tests for `<RunMenu />` (Unit 8 of the v2.0 polish plan).
 *
 * Covers:
 *
 * - Each routine entry is selectable.
 * - The active routine appears at the top with a check glyph.
 * - Selecting EIG / CPF / SE flips both the active routine AND the
 *   right-dock Analyze sub-mode.
 * - Selecting Sweep opens the SweepDialog (verified by the dialog
 *   wrapper appearing in the DOM).
 * - Keyboard nav: ArrowDown / ArrowUp / Enter close + activate.
 * - Escape closes the menu.
 * - Run history, under the routines, opens the History drawer on its runs,
 *   and says what to do first while there is nothing to list.
 * - The eigenvalue analysis is listed before a power flow has converged,
 *   greyed out with the reason, where it used to be left out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { RunMenu } from '@/components/shell/RunMenu';
import { useRunModeStore } from '@/store/runMode';
import { useAnalyzeStore } from '@/store/analyze';
import { useUiStore, DEFAULT_TDS_CONFIG } from '@/store/ui';
import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layout';
import { usePflowStore } from '@/store/pflow';
import { useRunsStore } from '@/store/runs';
import { useCaseStore } from '@/store/case';
import { useHistoryStore } from '@/store/history';
import { useSessionStore } from '@/store/session';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { PflowResult, TopologySummary } from '@/api/types';

// The topology the registry reads, which says whether a case has dynamic-model
// data. `null`, as while a case is still being read, unless a test sets one.
let MOCK_TOPOLOGY: TopologySummary | null = null;
vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useCurrentTopology: () => MOCK_TOPOLOGY,
  };
});

function topologyWith(generators: TopologySummary['generators']): TopologySummary {
  return {
    state: 'pre-setup',
    buses: [],
    lines: [],
    transformers: [],
    generators,
    loads: [],
    shunts: [],
  };
}

function withProviders(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  MOCK_TOPOLOGY = null;
  useRunModeStore.setState({ activeRoutine: 'pflow' });
  useAnalyzeStore.setState({
    subMode: 'pflow',
    eigResult: null,
    selectedModeId: null,
    cpfResult: null,
    seResult: null,
    seMeasurementsCount: null,
  });
  useUiStore.setState({
    hideLabels: false,
    tdsConfig: { ...DEFAULT_TDS_CONFIG },
  });
  // The registry gates "Run EIG" on PF having converged. Seed a converged
  // PF result so every routine can be chosen by default; what the menu
  // shows without one is in the "eigenvalue entry" block below.
  usePflowStore.setState({
    lastRun: {
      converged: true,
      iterations: 4,
      max_mismatch: 1e-9,
      buses: [],
    } as unknown as PflowResult,
    isRunning: false,
    error: null,
  });
});

afterEach(() => {
  cleanup();
});

describe('<RunMenu /> — render', () => {
  it('renders the trigger with the right testid', () => {
    render(withProviders(<RunMenu />));
    expect(screen.getByTestId('topbar-menu-run-trigger')).toBeInTheDocument();
  });

  it('opens the menu on click and lists every routine', async () => {
    const user = userEvent.setup();
    render(withProviders(<RunMenu />));
    await user.click(screen.getByTestId('topbar-menu-run-trigger'));
    await screen.findByTestId('topbar-menu-run-content');
    expect(screen.getByTestId('topbar-menu-run-pflow')).toBeInTheDocument();
    expect(screen.getByTestId('topbar-menu-run-tds')).toBeInTheDocument();
    expect(screen.getByTestId('topbar-menu-run-eig')).toBeInTheDocument();
    expect(screen.getByTestId('topbar-menu-run-cpf')).toBeInTheDocument();
    expect(screen.getByTestId('topbar-menu-run-se')).toBeInTheDocument();
    expect(screen.getByTestId('topbar-menu-run-sweep')).toBeInTheDocument();
  });

  it('does not list Abort run among the routines while a run streams', async () => {
    const user = userEvent.setup();
    useRunsStore.getState().startRun({ runId: 'streaming', tf: 5, columnNames: [] });
    try {
      render(withProviders(<RunMenu />));
      await user.click(screen.getByTestId('topbar-menu-run-trigger'));
      const content = await screen.findByTestId('topbar-menu-run-content');
      expect(screen.queryByTestId('topbar-menu-run-abort')).toBeNull();
      expect(within(content).queryByText(/abort/i)).toBeNull();
    } finally {
      useRunsStore.getState().clearRuns();
    }
  });

  it('marks the active routine with `data-routine-position="active"`', async () => {
    const user = userEvent.setup();
    useRunModeStore.setState({ activeRoutine: 'eig' });
    render(withProviders(<RunMenu />));
    await user.click(screen.getByTestId('topbar-menu-run-trigger'));
    const activeItem = await screen.findByTestId('topbar-menu-run-eig');
    expect(activeItem).toHaveAttribute('data-routine-position', 'active');
    // Active item appears first in the popover content.
    const content = screen.getByTestId('topbar-menu-run-content');
    const items = content.querySelectorAll('[role="menuitem"]');
    expect(items[0]).toBe(activeItem);
  });

  it('renders a check glyph next to the active routine only', async () => {
    const user = userEvent.setup();
    useRunModeStore.setState({ activeRoutine: 'tds' });
    render(withProviders(<RunMenu />));
    await user.click(screen.getByTestId('topbar-menu-run-trigger'));
    const tds = await screen.findByTestId('topbar-menu-run-tds');
    const pflow = screen.getByTestId('topbar-menu-run-pflow');
    expect(tds.querySelector('svg')).not.toBeNull();
    expect(pflow.querySelector('svg')).toBeNull();
  });
});

describe('<RunMenu /> — what an entry says and does', () => {
  it('heads the routines "Run now", and names each for what choosing it does', async () => {
    const user = userEvent.setup();
    render(withProviders(<RunMenu />));
    await user.click(screen.getByTestId('topbar-menu-run-trigger'));
    const content = await screen.findByTestId('topbar-menu-run-content');
    expect(within(content).getByText('Run now')).toBeInTheDocument();
    expect(within(content).queryByText('Active routine')).toBeNull();
    expect(screen.getByTestId('topbar-menu-run-pflow')).toHaveTextContent('Run power flow (PF)');
    expect(screen.getByTestId('topbar-menu-run-tds')).toHaveTextContent(
      'Run time-domain simulation (TDS)',
    );
    // The sweep needs its values chosen first: it does not say Run.
    expect(screen.getByTestId('topbar-menu-run-sweep')).toHaveTextContent('Parameter sweep…');
  });

  it('an entry that says Run asks for the run, where it used to pick the routine and stop', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
      topology: null,
    });
    useSessionStore.setState({ sessionId: parseSessionId('s1') });
    useRunModeStore.setState({ activeRoutine: 'tds', runRequest: null });
    try {
      render(withProviders(<RunMenu />));
      await user.click(screen.getByTestId('topbar-menu-run-trigger'));
      await user.click(await screen.findByTestId('topbar-menu-run-pflow'));
      expect(useRunModeStore.getState().runRequest).toEqual({ routine: 'pflow' });
    } finally {
      useCaseStore.setState({ selection: null });
      useSessionStore.setState({ sessionId: null });
      useRunModeStore.setState({ runRequest: null });
    }
  });
});

describe('<RunMenu /> — selection effects', () => {
  it('selecting PFlow updates `activeRoutine` and opens the PF sub-tab', async () => {
    const user = userEvent.setup();
    useRunModeStore.setState({ activeRoutine: 'tds' });
    render(withProviders(<RunMenu />));
    await user.click(screen.getByTestId('topbar-menu-run-trigger'));
    await user.click(await screen.findByTestId('topbar-menu-run-pflow'));
    expect(useRunModeStore.getState().activeRoutine).toBe('pflow');
    // The PF sub-tab holds the power-flow options and the system summary.
    expect(useLayoutStore.getState().activeBottomDrawerTab).toBe('analysis');
    expect(useLayoutStore.getState().activeAnalysisSubTab).toBe('pf');
  });

  it('selecting EIG flips activeRoutine + analyze.subMode + opens the Analyze sub-tab', async () => {
    const user = userEvent.setup();
    render(withProviders(<RunMenu />));
    await user.click(screen.getByTestId('topbar-menu-run-trigger'));
    await user.click(await screen.findByTestId('topbar-menu-run-eig'));
    expect(useRunModeStore.getState().activeRoutine).toBe('eig');
    expect(useAnalyzeStore.getState().subMode).toBe('eig');
    expect(useLayoutStore.getState().activeBottomDrawerTab).toBe('analysis');
    expect(useLayoutStore.getState().activeAnalysisSubTab).toBe('eig');
  });

  it('selecting CPF routes to the CPF Analyze sub-mode', async () => {
    const user = userEvent.setup();
    render(withProviders(<RunMenu />));
    await user.click(screen.getByTestId('topbar-menu-run-trigger'));
    await user.click(await screen.findByTestId('topbar-menu-run-cpf'));
    expect(useAnalyzeStore.getState().subMode).toBe('cpf');
    expect(useLayoutStore.getState().activeBottomDrawerTab).toBe('analysis');
    expect(useLayoutStore.getState().activeAnalysisSubTab).toBe('cpf');
  });

  it('selecting SE routes to the SE Analyze sub-mode', async () => {
    const user = userEvent.setup();
    render(withProviders(<RunMenu />));
    await user.click(screen.getByTestId('topbar-menu-run-trigger'));
    await user.click(await screen.findByTestId('topbar-menu-run-se'));
    expect(useAnalyzeStore.getState().subMode).toBe('se');
  });

  it('selecting Sweep mounts the SweepDialog (open state)', async () => {
    const user = userEvent.setup();
    render(withProviders(<RunMenu />));
    await user.click(screen.getByTestId('topbar-menu-run-trigger'));
    await user.click(await screen.findByTestId('topbar-menu-run-sweep'));
    // The Radix Dialog renders into a portal; finding the dialog
    // role anywhere in the document confirms the dialog mounted.
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    expect(useRunModeStore.getState().activeRoutine).toBe('sweep');
  });
});

describe('<RunMenu /> — the eigenvalue entry before it can run', () => {
  // The entry was left out until a power flow had converged, so the menu of a
  // freshly opened dynamic case had no eigenvalue analysis in it at all.
  const DYNAMIC = topologyWith([{ idx: 'GENROU_1', name: 'G1', kind: 'GENROU', params: {} }]);
  const openMenu = async () => {
    const user = userEvent.setup();
    render(withProviders(<RunMenu />));
    await user.click(screen.getByTestId('topbar-menu-run-trigger'));
    await screen.findByTestId('topbar-menu-run-content');
    return user;
  };

  beforeEach(() => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('kundur_full.xlsx'), addfiles: [] },
    });
  });
  afterEach(() => {
    useCaseStore.setState({ selection: null });
  });

  it('lists it greyed out with the reason before a power flow has converged', async () => {
    MOCK_TOPOLOGY = DYNAMIC;
    usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
    const user = await openMenu();

    const item = screen.getByTestId('topbar-menu-run-eig');
    expect(item).toHaveTextContent('Run eigenvalue analysis (EIG)');
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('topbar-menu-run-eig-reason')).toHaveTextContent(
      'Run a power flow first: eigenvalues are of the solved operating point.',
    );
    // It keeps its place among the routines, and a press does nothing.
    const order = [...screen.getByTestId('topbar-menu-run-content').querySelectorAll('button')].map(
      (button) => button.getAttribute('data-testid'),
    );
    expect(order.slice(0, 3)).toEqual([
      'topbar-menu-run-pflow',
      'topbar-menu-run-tds',
      'topbar-menu-run-eig',
    ]);
    await user.click(item);
    expect(useRunModeStore.getState().activeRoutine).toBe('pflow');
    expect(screen.getByTestId('topbar-menu-run-content')).toBeInTheDocument();
    // The other routines say why on a press, as before: they are not greyed.
    for (const id of ['pflow', 'tds', 'cpf', 'se', 'sweep']) {
      expect(screen.getByTestId(`topbar-menu-run-${id}`)).not.toHaveAttribute('aria-disabled');
    }
  });

  it('can be chosen once a power flow has converged', async () => {
    MOCK_TOPOLOGY = DYNAMIC;
    await openMenu();
    expect(screen.getByTestId('topbar-menu-run-eig')).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByTestId('topbar-menu-run-eig-reason')).not.toBeInTheDocument();
  });

  it('tells a static-only case that it needs dynamic-model data, power flow or not', async () => {
    MOCK_TOPOLOGY = topologyWith([{ idx: 1, name: 'PV 1', kind: 'PV', params: {} }]);
    await openMenu();
    expect(screen.getByTestId('topbar-menu-run-eig')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('topbar-menu-run-eig-reason')).toHaveTextContent(
      'Needs dynamic-model data, and this case has none. Open it with a .dyr file, or add a GENROU or GENCLS generator.',
    );
  });

  it('says to open a case first with none open', async () => {
    useCaseStore.setState({ selection: null });
    usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
    await openMenu();
    expect(screen.getByTestId('topbar-menu-run-eig-reason')).toHaveTextContent(
      'Open a case first.',
    );
  });
});

describe('<RunMenu /> — keyboard interaction', () => {
  it('ArrowDown then Enter activates the next routine', async () => {
    const user = userEvent.setup();
    useRunModeStore.setState({ activeRoutine: 'pflow' });
    render(withProviders(<RunMenu />));
    await user.click(screen.getByTestId('topbar-menu-run-trigger'));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('topbar-menu-run-pflow'));
    });
    await user.keyboard('{ArrowDown}');
    // After PFlow (active, first) comes TDS in the declared order.
    expect(document.activeElement).toBe(screen.getByTestId('topbar-menu-run-tds'));
    await user.keyboard('{Enter}');
    expect(useRunModeStore.getState().activeRoutine).toBe('tds');
    await waitFor(() => {
      expect(screen.queryByTestId('topbar-menu-run-content')).not.toBeInTheDocument();
    });
  });

  it('Escape closes the menu without changing state', async () => {
    const user = userEvent.setup();
    render(withProviders(<RunMenu />));
    await user.click(screen.getByTestId('topbar-menu-run-trigger'));
    await screen.findByTestId('topbar-menu-run-content');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('topbar-menu-run-content')).not.toBeInTheDocument();
    });
    expect(useRunModeStore.getState().activeRoutine).toBe('pflow');
  });
});

describe('<RunMenu /> — run history', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessionId: parseSessionId('s1') });
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('kundur_full.xlsx'), addfiles: [] },
    });
    useLayoutStore.setState({ ...DEFAULT_LAYOUT });
    useHistoryStore.getState().reset();
    useRunsStore.getState().clearRuns();
  });

  afterEach(() => {
    useSessionStore.setState({ sessionId: null });
    useCaseStore.setState({ selection: null });
    useLayoutStore.setState({ ...DEFAULT_LAYOUT });
    useHistoryStore.getState().reset();
    useRunsStore.getState().clearRuns();
  });

  /** A finished run that is no longer the active one, as a reload brings it back. */
  function seedKeptRun(runId: string): void {
    useRunsStore.getState().startRun({ runId, tf: 1, columnNames: ['Bus_1_v'] });
    useRunsStore.getState().markRunDone(runId, 1, true);
    useRunsStore.getState().clearActiveRun();
  }

  it('lists Run history last, after the routines', async () => {
    const user = userEvent.setup();
    render(withProviders(<RunMenu />));
    await user.click(screen.getByTestId('topbar-menu-run-trigger'));
    const content = await screen.findByTestId('topbar-menu-run-content');
    const items = [...content.querySelectorAll('[role="menuitem"]')];
    expect(items[items.length - 1]).toBe(screen.getByTestId('topbar-menu-run-history'));
    expect(screen.getByTestId('topbar-menu-run-history')).toHaveTextContent('Run history');
    expect(within(content).getByRole('separator')).toBeInTheDocument();
  });

  it('names how many runs there are and opens the drawer on them', async () => {
    const user = userEvent.setup();
    seedKeptRun('kept-1');
    seedKeptRun('kept-2');
    // The drawer was last left on the job list, which a reload empties.
    useLayoutStore.setState({ historyKindFilter: 'all' });
    render(withProviders(<RunMenu />));
    await user.click(screen.getByTestId('topbar-menu-run-trigger'));
    const item = await screen.findByTestId('topbar-menu-run-history');
    expect(item).toHaveTextContent('Run history (2)');
    await user.click(item);
    expect(useHistoryStore.getState().drawerOpen).toBe(true);
    expect(useLayoutStore.getState().historyKindFilter).toBe('runs');
    await waitFor(() => {
      expect(screen.queryByTestId('topbar-menu-run-content')).not.toBeInTheDocument();
    });
  });

  it('is on with no case open when runs were kept, as after a reload', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({ selection: null });
    seedKeptRun('kept-1');
    render(withProviders(<RunMenu />));
    await user.click(screen.getByTestId('topbar-menu-run-trigger'));
    const item = await screen.findByTestId('topbar-menu-run-history');
    expect(item).not.toHaveAttribute('aria-disabled');
    expect(item).toHaveTextContent('Run history (1)');
  });

  it('is off with no case and no runs, and says what to do first', async () => {
    const user = userEvent.setup();
    useCaseStore.setState({ selection: null });
    render(withProviders(<RunMenu />));
    await user.click(screen.getByTestId('topbar-menu-run-trigger'));
    const item = await screen.findByTestId('topbar-menu-run-history');
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('topbar-menu-run-history-reason')).toHaveTextContent(
      'No runs yet. Load a case and run a time-domain simulation first.',
    );
    await user.click(item);
    expect(useHistoryStore.getState().drawerOpen).toBe(false);
  });
});
