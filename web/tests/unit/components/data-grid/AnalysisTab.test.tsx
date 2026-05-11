/**
 * Tests for ``<AnalysisTab />`` (v3 Unit 14).
 *
 * Coverage:
 *
 *  - Renders all 5 sub-tab triggers + sub-tab routing.
 *  - Click writes via the onSubTabChange callback (caller wires both
 *    layout slice + analyze sub-mode atomically).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Stub the heavy chart components — same pattern as BottomDrawer.test.tsx.
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

import { AnalysisTab } from '@/components/data-grid/AnalysisTab';

afterEach(() => cleanup());

describe('<AnalysisTab />', () => {
  it('renders all 5 sub-tab triggers', () => {
    render(<AnalysisTab activeSubTab="eig" onSubTabChange={() => {}} />);
    expect(screen.getByTestId('analysis-tab')).toBeInTheDocument();
    for (const sub of ['plot', 'eig', 'cpf', 'se', 'tds']) {
      expect(screen.getByTestId(`analysis-sub-tab-${sub}`)).toBeInTheDocument();
    }
  });

  it('renders the active sub-tab content (EIG)', () => {
    render(<AnalysisTab activeSubTab="eig" onSubTabChange={() => {}} />);
    expect(screen.getByTestId('analyze-eig-stub')).toBeInTheDocument();
  });

  it('renders the active sub-tab content (Plot)', () => {
    render(<AnalysisTab activeSubTab="plot" onSubTabChange={() => {}} />);
    expect(screen.getByTestId('ts-plot-stub')).toBeInTheDocument();
    expect(screen.getByTestId('scrub-stub')).toBeInTheDocument();
    expect(screen.getByTestId('var-picker-stub')).toBeInTheDocument();
  });

  it('renders TDS sub-tab content (config + status)', () => {
    render(<AnalysisTab activeSubTab="tds" onSubTabChange={() => {}} />);
    expect(screen.getByTestId('tds-config-stub')).toBeInTheDocument();
    expect(screen.getByTestId('tds-status-stub')).toBeInTheDocument();
  });

  it('clicking a sub-tab calls onSubTabChange with the new id', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AnalysisTab activeSubTab="eig" onSubTabChange={onChange} />);
    await user.click(screen.getByTestId('analysis-sub-tab-cpf'));
    expect(onChange).toHaveBeenCalledWith('cpf');
  });
});
