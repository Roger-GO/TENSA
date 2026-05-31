/**
 * Tests for `<ResultsView />` (v3.1).
 *
 * The full-space results page reuses ``<AnalysisTab />`` (Plot | EIG |
 * CPF | SE | TDS) driven by ``activeAnalysisSubTab`` and renders an
 * EmptyState until some routine has produced output.
 *
 * Coverage:
 *
 *  - With no results, renders the "No results yet" EmptyState (not the
 *    AnalysisTab).
 *  - With a result present (e.g. a PF run), mounts the AnalysisTab.
 *  - The Exit button calls setResultsViewActive(false).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

// Stub the heavy chart components AnalysisTab mounts — same pattern as
// BottomDrawer.test.tsx / AnalysisTab.test.tsx so the ResultsView test
// stays focused on the page chassis rather than uPlot / query plumbing.
vi.mock('@/components/plots/TimeSeriesPlot', () => ({
  TimeSeriesPlot: () => <div data-testid="ts-plot-stub" />,
}));
vi.mock('@/components/plots/ScrubControl', () => ({
  ScrubControl: () => <div data-testid="scrub-stub" />,
}));
vi.mock('@/components/plots/VariableTreePicker', () => ({
  VariableTreePicker: () => <div data-testid="var-picker-stub" />,
}));
vi.mock('@/components/analyze/AnalyzePanel', () => ({
  AnalyzeEigSubMode: () => <div data-testid="analyze-eig-stub" />,
  AnalyzeCpfSubMode: () => <div data-testid="analyze-cpf-stub" />,
  AnalyzeSeSubMode: () => <div data-testid="analyze-se-stub" />,
}));
vi.mock('@/components/tds/TdsConfigPanel', () => ({
  TdsConfigPanel: () => <div data-testid="tds-config-stub" />,
}));
vi.mock('@/components/tds/RunStatusBadge', () => ({
  RunStatusBadge: () => <div data-testid="tds-status-stub" />,
}));

import { ResultsView } from '@/components/shell/ResultsView';
import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layout';
import { useAnalyzeStore } from '@/store/analyze';
import { usePflowStore } from '@/store/pflow';
import { useRunsStore } from '@/store/runs';
import type { PflowResult } from '@/api/types';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return React.createElement(QueryClientProvider, { client }, children);
}

function resetResultStores(): void {
  useAnalyzeStore.setState({
    subMode: 'eig',
    eigResult: null,
    cpfResult: null,
    seResult: null,
  });
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useRunsStore.setState({ runs: {}, activeRunId: null, overlayRunIds: new Set<string>() });
}

beforeEach(() => {
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT, resultsViewActive: true });
  resetResultStores();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
  resetResultStores();
});

describe('<ResultsView />', () => {
  it('renders the header + exit affordance', () => {
    render(<ResultsView />, { wrapper });
    expect(screen.getByTestId('results-view')).toBeInTheDocument();
    expect(screen.getByTestId('results-view-header')).toBeInTheDocument();
    expect(screen.getByTestId('results-view-exit')).toBeInTheDocument();
  });

  it('renders the EmptyState (not the AnalysisTab) when no results exist', () => {
    render(<ResultsView />, { wrapper });
    expect(screen.getByText('No results yet')).toBeInTheDocument();
    expect(screen.queryByTestId('analysis-tab')).not.toBeInTheDocument();
  });

  it('mounts the AnalysisTab once a PF result exists', () => {
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
    render(<ResultsView />, { wrapper });
    expect(screen.getByTestId('analysis-tab')).toBeInTheDocument();
    expect(screen.queryByText('No results yet')).not.toBeInTheDocument();
  });

  it('renders the AnalysisTab driven by activeAnalysisSubTab', () => {
    useLayoutStore.setState({ resultsViewActive: true, activeAnalysisSubTab: 'eig' });
    useAnalyzeStore.setState({
      eigResult: { modes: [] } as unknown as never,
    });
    render(<ResultsView />, { wrapper });
    // EIG sub-tab content mounts (stubbed) since eig is the active sub-tab.
    expect(screen.getByTestId('analyze-eig-stub')).toBeInTheDocument();
  });

  it('Exit button calls setResultsViewActive(false)', async () => {
    const user = userEvent.setup();
    render(<ResultsView />, { wrapper });
    expect(useLayoutStore.getState().resultsViewActive).toBe(true);
    await user.click(screen.getByTestId('results-view-exit'));
    expect(useLayoutStore.getState().resultsViewActive).toBe(false);
  });
});
