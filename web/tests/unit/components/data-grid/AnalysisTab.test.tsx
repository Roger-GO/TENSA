/**
 * Tests for ``<AnalysisTab />`` (v3 Unit 14).
 *
 * Coverage:
 *
 *  - Renders all 6 sub-tab triggers + sub-tab routing.
 *  - Click writes via the onSubTabChange callback (caller wires both
 *    layout slice + analyze sub-mode atomically).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';

// Stub the heavy chart components — same pattern as BottomDrawer.test.tsx.
vi.mock('@/components/plots/TimeSeriesPlot', () => ({
  // The real plot draws the toolbar it is given beside its export menu.
  TimeSeriesPlot: ({ toolbar }: { toolbar?: ReactNode }) => (
    <div data-testid="ts-plot-stub">{toolbar}</div>
  ),
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
vi.mock('@/components/pflow/PflowPanel', () => ({
  PflowPanel: () => <div data-testid="pflow-panel-stub" />,
}));

import { AnalysisTab } from '@/components/data-grid/AnalysisTab';
import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layout';
import { usePlotStore } from '@/store/plot';
import { useRunsStore } from '@/store/runs';

beforeEach(() => {
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
  useRunsStore.setState({ runs: {}, activeRunId: null, overlayRunIds: new Set<string>() });
  usePlotStore.setState({ selectedByRun: {} });
});

afterEach(() => {
  cleanup();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
  useRunsStore.setState({ runs: {}, activeRunId: null, overlayRunIds: new Set<string>() });
  usePlotStore.setState({ selectedByRun: {} });
});

describe('<AnalysisTab />', () => {
  it('renders all 6 sub-tab triggers', () => {
    render(<AnalysisTab activeSubTab="eig" onSubTabChange={() => {}} />);
    expect(screen.getByTestId('analysis-tab')).toBeInTheDocument();
    for (const sub of ['plot', 'pf', 'eig', 'cpf', 'se', 'tds']) {
      expect(screen.getByTestId(`analysis-sub-tab-${sub}`)).toBeInTheDocument();
    }
  });

  it('renders the active sub-tab content (EIG)', async () => {
    render(<AnalysisTab activeSubTab="eig" onSubTabChange={() => {}} />);
    // The EIG, CPF and SE views are lazily loaded chunks.
    expect(await screen.findByTestId('analyze-eig-stub')).toBeInTheDocument();
  });

  it('renders the PF sub-tab (options and summary) as a lazily loaded chunk', async () => {
    render(<AnalysisTab activeSubTab="pf" onSubTabChange={() => {}} />);
    expect(screen.getByTestId('analysis-sub-tab-pf')).toHaveTextContent('PF');
    expect(await screen.findByTestId('pflow-panel-stub')).toBeInTheDocument();
  });

  it('puts PF second, after Plot, in the strip', () => {
    render(<AnalysisTab activeSubTab="plot" onSubTabChange={() => {}} />);
    const order = screen
      .getAllByRole('tab')
      .map((tab) => tab.getAttribute('data-testid')?.replace('analysis-sub-tab-', ''));
    expect(order).toEqual(['plot', 'pf', 'eig', 'cpf', 'se', 'tds']);
  });

  it('renders the active sub-tab content (Plot)', async () => {
    const user = userEvent.setup();
    render(<AnalysisTab activeSubTab="plot" onSubTabChange={() => {}} />);
    expect(screen.getByTestId('ts-plot-stub')).toBeInTheDocument();
    expect(screen.getByTestId('scrub-stub')).toBeInTheDocument();
    // The variable tree stays MOUNTED (so its auto-select effect runs) but
    // is collapsed by default — its wrapper carries `hidden` until the user
    // expands the "Variables" toggle, which gives the chart the height.
    expect(screen.getByTestId('var-picker-stub')).toBeInTheDocument();
    const toggle = screen.getByTestId('plot-variables-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const pickerWrap = screen.getByTestId('var-picker-stub').parentElement;
    expect(pickerWrap?.className).toContain('hidden');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('var-picker-stub').parentElement?.className).not.toContain('hidden');
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

  describe('Plot sub-tab controls', () => {
    function seedRun(selected: string[]): void {
      useRunsStore
        .getState()
        .startRun({ runId: 'r1', tf: 10, columnNames: ['Bus_1_v', 'Bus_1_a', 'Gen_1_omega'] });
      usePlotStore.getState().setSelection('r1', new Set(selected));
    }

    it('names the variable tree by what it does and says how many series it plots', async () => {
      const user = userEvent.setup();
      seedRun(['Bus_1_v', 'Gen_1_omega']);
      render(<AnalysisTab activeSubTab="plot" onSubTabChange={() => {}} />);
      const toggle = screen.getByTestId('plot-variables-toggle');
      expect(toggle).toHaveAccessibleName('Choose variables · 2 selected');

      await user.click(screen.getByRole('button', { name: 'Bus angle' }));
      expect(toggle).toHaveAccessibleName('Choose variables · 3 selected');
    });

    it('has no selection to count before a run', () => {
      render(<AnalysisTab activeSubTab="plot" onSubTabChange={() => {}} />);
      expect(screen.getByTestId('plot-variables-toggle')).toHaveAccessibleName(
        'Choose variables · 0 selected',
      );
    });

    it('puts the quantity buttons in the plot toolbar, so the plot can be changed in a click', () => {
      seedRun(['Bus_1_v']);
      render(<AnalysisTab activeSubTab="plot" onSubTabChange={() => {}} />);
      const plot = screen.getByTestId('ts-plot-stub');
      expect(plot).toContainElement(screen.getByTestId('plot-quantity-toggles'));
    });

    it('opens the results view from the Expand plot button, which is there for the shrunken drawer', async () => {
      const user = userEvent.setup();
      render(<AnalysisTab activeSubTab="plot" onSubTabChange={() => {}} />);
      expect(useLayoutStore.getState().resultsViewActive).toBe(false);

      await user.click(screen.getByRole('button', { name: 'Expand plot' }));

      expect(useLayoutStore.getState().resultsViewActive).toBe(true);
    });

    it('does not offer to expand a plot that already has the whole window', () => {
      useLayoutStore.setState({ resultsViewActive: true });
      render(<AnalysisTab activeSubTab="plot" onSubTabChange={() => {}} />);
      expect(screen.queryByRole('button', { name: 'Expand plot' })).toBeNull();
    });
  });
});
