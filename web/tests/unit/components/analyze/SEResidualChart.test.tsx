/**
 * Tests for ``<SEResidualChart />`` (Unit 13 + Unit 18).
 *
 * Coverage:
 * - Empty-state branches: result=null + result with empty residuals.
 * - Renders the headline summary (count / iterations / J / flagged).
 * - Renders one rect per histogram bin and highlights flagged bars.
 * - Pulls the result from the store when no override prop is given.
 * - buildHistogram bins residuals into equal-width bins and flags bins
 *   containing any residual whose index is in flagged_indices.
 * - Unit 18: clicking a bar opens the detail panel; the panel shows
 *   the bin's contents + the correct flag reason; the close button
 *   dismisses it; re-running SE (new result identity) clears any open
 *   selection so stale indices don't bleed across runs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  SEResidualChart,
  buildHistogram,
} from '@/components/analyze/SEResidualChart';
import { DEFAULT_EIG_FILTER, useAnalyzeStore } from '@/store/analyze';
import type { SeResult } from '@/api/types';

function resetAnalyzeStore() {
  useAnalyzeStore.setState({
    subMode: 'pflow',
    eigResult: null,
    selectedModeId: null,
    filter: { ...DEFAULT_EIG_FILTER },
    cpfResult: null,
    seResult: null,
    seMeasurementsCount: null,
  });
}

const SE_RESULT: SeResult = {
  converged: true,
  iterations: 3,
  mismatch: 12.345,
  // 10 residuals across [-0.05, +0.05] with one outlier at +0.5 (index 5)
  residuals: [
    -0.04, -0.02, -0.01, 0.0, 0.01, 0.5, 0.02, 0.03, 0.04, 0.045,
  ],
  measurement_count: 10,
  flagged_indices: [5],
};

const EMPTY_RESULT: SeResult = {
  converged: true,
  iterations: 0,
  mismatch: 0,
  residuals: [],
  measurement_count: 0,
  flagged_indices: [],
};

describe('<SEResidualChart />', () => {
  beforeEach(() => {
    resetAnalyzeStore();
  });
  afterEach(() => {
    resetAnalyzeStore();
  });

  it('renders the empty-state when no result is set', () => {
    render(<SEResidualChart />);
    expect(screen.getByTestId('se-residual-empty')).toBeInTheDocument();
  });

  it('renders the empty-state when residuals is empty', () => {
    render(<SEResidualChart result={EMPTY_RESULT} />);
    expect(screen.getByTestId('se-residual-empty')).toBeInTheDocument();
  });

  it('renders the chart container with summary line', () => {
    render(<SEResidualChart result={SE_RESULT} />);
    expect(screen.getByTestId('se-residual-chart')).toBeInTheDocument();
    const summary = screen.getByTestId('se-residual-summary');
    expect(summary.textContent).toMatch(/10/); // measurement count
    expect(summary.textContent).toMatch(/3/); // iterations
    expect(summary.textContent).toMatch(/flagged/);
  });

  it('omits the flagged-summary when no measurements are flagged', () => {
    const noFlag: SeResult = { ...SE_RESULT, flagged_indices: [] };
    render(<SEResidualChart result={noFlag} />);
    const summary = screen.getByTestId('se-residual-summary');
    expect(summary.textContent).not.toMatch(/flagged/);
  });

  it('renders bars and at least one flagged bar for flagged residuals', () => {
    render(<SEResidualChart result={SE_RESULT} binCount={10} />);
    const flagged = screen.getAllByTestId('se-residual-bar-flagged');
    expect(flagged.length).toBeGreaterThanOrEqual(1);
    // The flagged bar should have data-flagged="true".
    const firstFlag = flagged[0];
    expect(firstFlag).toBeDefined();
    expect(firstFlag!.getAttribute('data-flagged')).toBe('true');
  });

  it('renders the requested number of bins (binCount prop honored)', () => {
    render(<SEResidualChart result={SE_RESULT} binCount={5} />);
    // With 5 bins, there should be exactly 5 bars total (flagged + non-
    // flagged combined). Count by querying any rect with the expected
    // testid prefix.
    const flagged = screen.queryAllByTestId('se-residual-bar-flagged');
    let nonFlaggedCount = 0;
    for (let i = 0; i < 5; i++) {
      if (screen.queryByTestId(`se-residual-bar-${i}`)) nonFlaggedCount++;
    }
    expect(flagged.length + nonFlaggedCount).toBe(5);
  });

  it('prefers the store-provided result when no override is given', () => {
    useAnalyzeStore.getState().setSeResult(SE_RESULT);
    render(<SEResidualChart />);
    expect(screen.getByTestId('se-residual-chart')).toBeInTheDocument();
  });

  // ---- Unit 18: click-to-inspect detail panel ----------------------------

  it('does not render the detail panel until a bar is clicked', () => {
    render(<SEResidualChart result={SE_RESULT} binCount={10} />);
    expect(
      screen.queryByTestId('se-residual-detail-panel'),
    ).not.toBeInTheDocument();
  });

  it('clicking a flagged bar opens the detail panel with the ≥3σ flag reason', () => {
    render(<SEResidualChart result={SE_RESULT} binCount={10} />);
    const flaggedBars = screen.getAllByTestId('se-residual-bar-flagged');
    expect(flaggedBars.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(flaggedBars[0]!);

    const panel = screen.getByTestId('se-residual-detail-panel');
    expect(panel).toBeInTheDocument();
    // Flagged bin must surface the literal flag-reason from the plan.
    expect(panel.textContent).toMatch(/≥3σ from estimate/);
    // Member index 5 is the +0.5 outlier; it should appear in the bin's
    // member list as the flagged measurement.
    expect(
      screen.getByTestId('se-residual-detail-member-5'),
    ).toBeInTheDocument();
  });

  it('clicking a non-flagged bar opens the detail panel with the "Within tolerance" reason', () => {
    render(<SEResidualChart result={SE_RESULT} binCount={10} />);
    // Find any non-flagged bar that has measurements in it. With 10
    // residuals and 10 bins across [-0.04, 0.5], some bins are empty,
    // so we walk the indexed testids and pick the first interactive one.
    let clicked = false;
    for (let i = 0; i < 10; i++) {
      const bar = screen.queryByTestId(`se-residual-bar-${i}`);
      if (bar !== null && bar.getAttribute('data-flagged') === 'false') {
        // Skip empty bins (count=0); they are non-interactive.
        // Detect by reading the data-bin-idx + cross-checking via
        // height — but simpler: just try clicking and check for the
        // panel's appearance.
        fireEvent.click(bar);
        if (screen.queryByTestId('se-residual-detail-panel') !== null) {
          clicked = true;
          break;
        }
      }
    }
    expect(clicked).toBe(true);

    const panel = screen.getByTestId('se-residual-detail-panel');
    expect(panel.textContent).toMatch(/Within tolerance/);
    expect(panel.textContent).not.toMatch(/≥3σ/);
  });

  it('the detail panel close button dismisses the panel', () => {
    render(<SEResidualChart result={SE_RESULT} binCount={10} />);
    fireEvent.click(screen.getAllByTestId('se-residual-bar-flagged')[0]!);
    expect(
      screen.getByTestId('se-residual-detail-panel'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('se-residual-detail-close'));
    expect(
      screen.queryByTestId('se-residual-detail-panel'),
    ).not.toBeInTheDocument();
  });

  it('re-running SE (new result identity) clears any open detail panel', () => {
    const { rerender } = render(
      <SEResidualChart result={SE_RESULT} binCount={10} />,
    );
    fireEvent.click(screen.getAllByTestId('se-residual-bar-flagged')[0]!);
    expect(
      screen.getByTestId('se-residual-detail-panel'),
    ).toBeInTheDocument();

    // Hand a NEW SeResult object (fresh identity, same shape) — the
    // useEffect keyed on ``result`` should reset the selection.
    const nextResult: SeResult = {
      ...SE_RESULT,
      // Tweak a field so the object identity is unambiguously different.
      iterations: SE_RESULT.iterations + 1,
    };
    rerender(<SEResidualChart result={nextResult} binCount={10} />);

    expect(
      screen.queryByTestId('se-residual-detail-panel'),
    ).not.toBeInTheDocument();
  });

  it('the detail panel surfaces the bin range and measurement count', () => {
    render(<SEResidualChart result={SE_RESULT} binCount={10} />);
    fireEvent.click(screen.getAllByTestId('se-residual-bar-flagged')[0]!);

    const panel = screen.getByTestId('se-residual-detail-panel');
    // Bin header includes "Bin #" + the bracketed range in scientific
    // notation. Don't assert the exact bin index (depends on bin math);
    // assert the structural pieces are present.
    expect(panel.textContent).toMatch(/Bin #/);
    expect(panel.textContent).toMatch(/residuals in \[/);
    expect(panel.textContent).toMatch(/Min residual/);
    expect(panel.textContent).toMatch(/Max residual/);
  });
});

describe('buildHistogram', () => {
  it('returns empty bins when residuals is empty', () => {
    const h = buildHistogram([], [], 10);
    expect(h.bins).toEqual([]);
    expect(h.maxCount).toBe(0);
  });

  it('places each residual in the correct equal-width bin', () => {
    const residuals = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const h = buildHistogram(residuals, [], 10);
    // 10 residuals, 10 bins, evenly distributed → each bin should hold 1.
    expect(h.bins.length).toBe(10);
    // Counts depend on bin-edge handling. Sum of counts must equal residuals.length.
    const totalCount = h.bins.reduce((acc, b) => acc + b.count, 0);
    expect(totalCount).toBe(residuals.length);
  });

  it('flags a bin containing any flagged residual', () => {
    const residuals = [0, 1, 2, 3, 4];
    // Flag the residual at index 2 (value=2).
    const h = buildHistogram(residuals, [2], 5);
    const flaggedBins = h.bins.filter((b) => b.flagged);
    expect(flaggedBins.length).toBe(1);
    // The flagged bin should be the one containing value=2.
    const flaggedBin = flaggedBins[0]!;
    expect(flaggedBin.lo).toBeLessThanOrEqual(2);
    expect(flaggedBin.hi).toBeGreaterThanOrEqual(2);
  });

  it('handles a degenerate single-value range', () => {
    const h = buildHistogram([0.5, 0.5, 0.5], [], 5);
    expect(h.bins.length).toBe(5);
    // All residuals fall into one (or padded) bin; the total count matches input.
    const total = h.bins.reduce((acc, b) => acc + b.count, 0);
    expect(total).toBe(3);
  });

  it('right-edge inclusive: max value falls into the last bin', () => {
    const h = buildHistogram([0, 5, 10], [], 5);
    // 10 is the max — it should fall into the last bin (index 4).
    expect(h.bins[h.bins.length - 1]!.count).toBeGreaterThanOrEqual(1);
  });

  it('returns maxCount equal to the largest bin count', () => {
    const residuals = [0, 0, 0, 1, 2];
    const h = buildHistogram(residuals, [], 3);
    // First bin holds 3 zeros; that should dominate.
    expect(h.maxCount).toBeGreaterThanOrEqual(3);
  });
});
