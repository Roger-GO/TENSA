/**
 * Tests for ``<AnalyzePanel />`` (Unit 6).
 *
 * The panel composes the AnalyzeSubModePicker plus the per-routine
 * sub-mode body. We test the routing layer (sub-mode swap → which
 * subtree mounts) plus the EIG sub-mode's "Run EIG" button gating
 * and the tds-initialized info banner; deeper EIG result-view
 * behaviour is covered by EIGScatter.test / EIGParticipationTable.test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AnalyzePanel } from '@/components/analyze/AnalyzePanel';
import {
  ANALYZE_SUB_MODES,
  DEFAULT_EIG_FILTER,
  useAnalyzeStore,
} from '@/store/analyze';
import { DEFAULT_TDS_CONFIG, useUiStore } from '@/store/ui';
import { usePflowStore } from '@/store/pflow';
import type { EigResult, PflowResult } from '@/api/types';

function withQueryClient(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

function resetStores() {
  useAnalyzeStore.setState({
    subMode: 'pflow',
    eigResult: null,
    selectedModeId: null,
    filter: { ...DEFAULT_EIG_FILTER },
    cpfResult: null,
  });
  useUiStore.setState({
    hideLabels: false,
    activeRightDockTopPanel: 'analyze',
    tdsConfig: { ...DEFAULT_TDS_CONFIG },
  });
  usePflowStore.setState({
    lastRun: null,
    isRunning: false,
    error: null,
  });
}

const FAKE_PFLOW_RESULT: PflowResult = {
  // The narrow shape we need — the EIG sub-mode only checks
  // ``lastRun !== null`` to gate the auto-clear behaviour.
  run_id: 'pf-1',
  converged: true,
  iterations: 4,
  mismatch: 1e-6,
  bus_voltages: {},
  bus_angles: {},
  line_flows: {},
  generator_outputs: {},
  load_consumption: {},
};

const RESULT_WITH_TDS_INIT: EigResult = {
  eigenvalues: [{ real: -0.1, imag: 1.0 }],
  damping_ratios: [0.1],
  frequencies_hz: [0.159],
  mode_count: 1,
  state_count: 1,
  state_names: ['delta_1'],
  tds_initialized: true,
};

describe('<AnalyzePanel />', () => {
  beforeEach(() => {
    resetStores();
  });
  afterEach(() => {
    resetStores();
  });

  it('renders the panel header + sub-mode picker', () => {
    render(withQueryClient(<AnalyzePanel />));
    expect(screen.getByTestId('analyze-panel')).toBeInTheDocument();
    expect(screen.getByTestId('analyze-sub-mode-picker')).toBeInTheDocument();
    for (const mode of ANALYZE_SUB_MODES) {
      expect(
        screen.getByTestId(`analyze-sub-mode-${mode}`),
      ).toBeInTheDocument();
    }
  });

  it('PF sub-mode is active by default and shows the PF placeholder', () => {
    render(withQueryClient(<AnalyzePanel />));
    expect(screen.getByTestId('analyze-sub-mode-pflow')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(
      screen.getByTestId('analyze-sub-mode-pflow-content'),
    ).toBeInTheDocument();
  });

  it('clicking the TDS sub-mode mounts TdsConfigPanel', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<AnalyzePanel />));
    await user.click(screen.getByTestId('analyze-sub-mode-tds'));
    expect(useAnalyzeStore.getState().subMode).toBe('tds');
    expect(screen.getByTestId('tds-config-panel')).toBeInTheDocument();
  });

  it('clicking the EIG sub-mode mounts the EIG views + Run button', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<AnalyzePanel />));
    await user.click(screen.getByTestId('analyze-sub-mode-eig'));
    expect(useAnalyzeStore.getState().subMode).toBe('eig');
    expect(screen.getByTestId('analyze-run-eig')).toBeInTheDocument();
    // Empty-state shown until EIG runs.
    expect(screen.getByTestId('eig-empty')).toBeInTheDocument();
  });

  it('shows the tds-initialized info banner when EIG result has tds_initialized=true', () => {
    // Seed PF (the EIG sub-mode auto-clears the EIG result if PF is
    // null, since a case-change would have wiped PF first).
    usePflowStore.getState().setLastRun(FAKE_PFLOW_RESULT);
    useAnalyzeStore.getState().setSubMode('eig');
    useAnalyzeStore.getState().setEigResult(RESULT_WITH_TDS_INIT);
    render(withQueryClient(<AnalyzePanel />));
    expect(
      screen.getByTestId('eig-info-tds-initialized'),
    ).toBeInTheDocument();
  });

  it('does NOT auto-run EIG on tab open (gated until user clicks Run EIG)', () => {
    useAnalyzeStore.getState().setSubMode('eig');
    render(withQueryClient(<AnalyzePanel />));
    // No result, no info banner, no participation table populated.
    expect(useAnalyzeStore.getState().eigResult).toBeNull();
    expect(
      screen.queryByTestId('eig-info-tds-initialized'),
    ).not.toBeInTheDocument();
  });
});
