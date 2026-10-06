/**
 * Tests for ``<LazyAnalysisTab />``: the Analysis tab (plot, EIG, CPF, SE) is a
 * chunk of its own, and the EIG, CPF and SE views inside it are further chunks.
 *
 * This file is the only one that renders the tab from a cold start (a loaded
 * chunk stays loaded for the life of the module registry, and each test file
 * has its own), so it is where the order of events is pinned: a placeholder
 * while the tab loads, the tab with the Plot view as soon as it has, and the
 * heavier views only once their sub-tab is chosen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

vi.mock('@/components/plots/TimeSeriesPlot', () => ({
  TimeSeriesPlot: () => <div data-testid="ts-plot-stub" />,
}));
vi.mock('@/components/plots/ScrubControl', () => ({
  ScrubControl: () => <div data-testid="scrub-stub" />,
}));
vi.mock('@/components/plots/VariableTreePicker', () => ({
  VariableTreePicker: () => <div data-testid="var-picker-stub" />,
}));
const analyzeLoaded = vi.fn();
vi.mock('@/components/analyze/AnalyzePanel', () => {
  analyzeLoaded();
  return {
    AnalyzeEigSubMode: () => <div data-testid="analyze-eig-stub" />,
    AnalyzeCpfSubMode: () => <div data-testid="analyze-cpf-stub" />,
    AnalyzeSeSubMode: () => <div data-testid="analyze-se-stub" />,
  };
});
vi.mock('@/components/tds/TdsConfigPanel', () => ({
  TdsConfigPanel: () => <div data-testid="tds-config-stub" />,
}));
vi.mock('@/components/tds/RunStatusBadge', () => ({
  RunStatusBadge: () => <div data-testid="tds-status-stub" />,
}));

import { LazyAnalysisTab } from '@/components/data-grid/LazyAnalysisTab';
import type { AnalysisSubTab } from '@/store/layout';

afterEach(() => cleanup());

/**
 * How long the first render may take to load the tab's chunk. The module is
 * transformed on its first import, which on a busy machine takes longer than
 * the second `findBy` waits by default; the test then failed now and then.
 */
const COLD_LOAD_MS = 15_000;
vi.setConfig({ testTimeout: 2 * COLD_LOAD_MS });

function Harness() {
  const [sub, setSub] = useState<AnalysisSubTab>('plot');
  return <LazyAnalysisTab activeSubTab={sub} onSubTabChange={setSub} />;
}

describe('<LazyAnalysisTab />', () => {
  it('shows a placeholder while the tab loads, then the tab with the Plot view', async () => {
    render(<Harness />);
    expect(screen.getByTestId('lazy-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('analysis-tab')).not.toBeInTheDocument();

    expect(
      await screen.findByTestId('analysis-tab', undefined, { timeout: COLD_LOAD_MS }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('ts-plot-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('lazy-loading')).not.toBeInTheDocument();
  });

  it('does not load the EIG, CPF and SE views until one of their sub-tabs opens', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await screen.findByTestId('analysis-tab');
    // The Plot view is up and the Analyze module has not been fetched.
    expect(analyzeLoaded).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('analysis-sub-tab-eig'));
    expect(await screen.findByTestId('analyze-eig-stub')).toBeInTheDocument();
    expect(analyzeLoaded).toHaveBeenCalledTimes(1);

    // CPF and SE come from the module that is already loaded.
    await user.click(screen.getByTestId('analysis-sub-tab-cpf'));
    expect(await screen.findByTestId('analyze-cpf-stub')).toBeInTheDocument();
    await user.click(screen.getByTestId('analysis-sub-tab-se'));
    expect(await screen.findByTestId('analyze-se-stub')).toBeInTheDocument();
    expect(analyzeLoaded).toHaveBeenCalledTimes(1);
  });
});
