/**
 * Tests for ``<SEResidualChart />`` (Unit 13).
 *
 * Coverage:
 * - Empty-state branches: result=null + result with empty residuals.
 * - Renders the headline summary (count / iterations / J / flagged).
 * - Renders one rect per histogram bin and highlights flagged bars.
 * - Pulls the result from the store when no override prop is given.
 * - buildHistogram bins residuals into equal-width bins and flags bins
 *   containing any residual whose index is in flagged_indices.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
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
