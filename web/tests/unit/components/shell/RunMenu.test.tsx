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
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { RunMenu } from '@/components/shell/RunMenu';
import { useRunModeStore } from '@/store/runMode';
import { useAnalyzeStore } from '@/store/analyze';
import { useUiStore, DEFAULT_TDS_CONFIG } from '@/store/ui';
import { useLayoutStore } from '@/store/layout';
import { usePflowStore } from '@/store/pflow';
import type { PflowResult } from '@/api/types';

function withProviders(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
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
  // Unit 9: the registry gates "Run EIG" on PF having converged. Seed
  // a converged PF result so every routine surfaces in the menu by
  // default; the EIG-gating contract itself is exercised in
  // `tests/unit/components/shell/CommandPalette.test.tsx`.
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

describe('<RunMenu /> — selection effects', () => {
  it('selecting PFlow updates `activeRoutine` and does not change the analysis sub-tab', async () => {
    const user = userEvent.setup();
    useRunModeStore.setState({ activeRoutine: 'tds' });
    const beforeSubTab = useLayoutStore.getState().activeAnalysisSubTab;
    render(withProviders(<RunMenu />));
    await user.click(screen.getByTestId('topbar-menu-run-trigger'));
    await user.click(await screen.findByTestId('topbar-menu-run-pflow'));
    expect(useRunModeStore.getState().activeRoutine).toBe('pflow');
    // PFlow has no analysis sub-tab (F-FEAS-3); ``activeAnalysisSubTab``
    // is left alone — only the drawer's outer tab is set to ``analysis``.
    expect(useLayoutStore.getState().activeAnalysisSubTab).toBe(beforeSubTab);
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
