/**
 * Tests for ``<CPFCurveChart />`` (Unit 12).
 *
 * Coverage:
 * - Empty-state branches: result=null + result with empty lambdas.
 * - Renders one polyline per visible bus + the nose marker.
 * - Truncated runs render the truncation banner and skip the nose marker.
 * - Legend toggles bus visibility.
 * - QV mode relabels the X-axis and renders only the requested bus.
 * - pickDefaultVisibleBuses ranks by voltage swing.
 * - computeViewport returns sane defaults on degenerate inputs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  CPFCurveChart,
  computeViewport,
  pickDefaultVisibleBuses,
} from '@/components/analyze/CPFCurveChart';
import { DEFAULT_EIG_FILTER, useAnalyzeStore } from '@/store/analyze';
import type { CpfResult } from '@/api/types';

function resetAnalyzeStore() {
  useAnalyzeStore.setState({
    subMode: 'pflow',
    eigResult: null,
    selectedModeId: null,
    filter: { ...DEFAULT_EIG_FILTER },
    cpfResult: null,
  });
}

const PV_RESULT: CpfResult = {
  lambdas: [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.25, 3.1],
  voltages_per_bus: {
    '1': [1.06, 1.05, 1.04, 1.03, 1.02, 1.0, 0.97, 0.92, 0.85],
    '2': [1.045, 1.04, 1.03, 1.02, 1.0, 0.98, 0.94, 0.88, 0.80],
    '3': [1.01, 1.005, 1.0, 0.995, 0.99, 0.98, 0.96, 0.92, 0.85],
  },
  bus_idxes: ['1', '2', '3'],
  nose_idx: 7,
  max_lam: 3.25,
  truncated: false,
  done_msg: 'Nose point at lambda=3.250000',
  mode: 'pv',
};

const TRUNCATED_RESULT: CpfResult = {
  lambdas: [0.0, 0.1, 0.2, 0.3],
  voltages_per_bus: {
    '1': [1.06, 1.05, 1.04, 1.03],
  },
  bus_idxes: ['1'],
  nose_idx: -1,
  max_lam: 0.3,
  truncated: true,
  done_msg: 'Reached max steps (3)',
  mode: 'pv',
};

const QV_RESULT: CpfResult = {
  lambdas: [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 4.8],
  voltages_per_bus: {
    '5': [1.0, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7],
  },
  bus_idxes: ['5'],
  nose_idx: 5,
  max_lam: 5.0,
  truncated: false,
  done_msg: 'Nose point at q=5.000000',
  mode: 'qv',
};

describe('<CPFCurveChart />', () => {
  beforeEach(() => {
    resetAnalyzeStore();
  });
  afterEach(() => {
    resetAnalyzeStore();
  });

  it('renders the empty-state when no result is set', () => {
    render(<CPFCurveChart />);
    expect(screen.getByTestId('cpf-empty')).toBeInTheDocument();
  });

  it('renders the empty-state when lambdas is empty', () => {
    const empty: CpfResult = {
      ...PV_RESULT,
      lambdas: [],
      voltages_per_bus: {},
      bus_idxes: [],
      nose_idx: -1,
      max_lam: 0,
      truncated: true,
      done_msg: 'No steps',
    };
    render(<CPFCurveChart result={empty} />);
    expect(screen.getByTestId('cpf-empty')).toBeInTheDocument();
  });

  it('renders the chart with one polyline per visible bus', () => {
    render(<CPFCurveChart result={PV_RESULT} />);
    expect(screen.getByTestId('cpf-curve')).toBeInTheDocument();
    expect(screen.getByTestId('cpf-curve-line-1')).toBeInTheDocument();
    expect(screen.getByTestId('cpf-curve-line-2')).toBeInTheDocument();
    expect(screen.getByTestId('cpf-curve-line-3')).toBeInTheDocument();
  });

  it('marks the nose point on a happy-path PV-curve', () => {
    render(<CPFCurveChart result={PV_RESULT} />);
    expect(screen.getByTestId('cpf-nose-marker')).toBeInTheDocument();
    expect(screen.queryByTestId('cpf-truncated-banner')).not.toBeInTheDocument();
  });

  it('renders the truncated banner and skips the nose marker', () => {
    render(<CPFCurveChart result={TRUNCATED_RESULT} />);
    expect(screen.getByTestId('cpf-truncated-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('cpf-nose-marker')).not.toBeInTheDocument();
    expect(screen.getByTestId('cpf-truncated-banner').textContent).toMatch(
      /Reached max steps/,
    );
  });

  it('legend toggles bus visibility', async () => {
    render(<CPFCurveChart result={PV_RESULT} />);
    const user = userEvent.setup();
    expect(screen.getByTestId('cpf-curve-line-2')).toBeInTheDocument();
    await user.click(screen.getByTestId('cpf-curve-legend-2'));
    expect(screen.queryByTestId('cpf-curve-line-2')).not.toBeInTheDocument();
    // Legend buttons themselves remain present.
    expect(screen.getByTestId('cpf-curve-legend-2')).toBeInTheDocument();
  });

  it('legend re-shows a hidden bus on second click', async () => {
    render(<CPFCurveChart result={PV_RESULT} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('cpf-curve-legend-2'));
    expect(screen.queryByTestId('cpf-curve-line-2')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('cpf-curve-legend-2'));
    expect(screen.getByTestId('cpf-curve-line-2')).toBeInTheDocument();
  });

  it('relabels the X-axis when mode is qv', () => {
    render(<CPFCurveChart result={QV_RESULT} />);
    const chart = screen.getByTestId('cpf-curve');
    expect(chart.getAttribute('data-mode')).toBe('qv');
    expect(chart.textContent).toMatch(/Q injection/);
    expect(screen.getByTestId('cpf-curve-line-5')).toBeInTheDocument();
  });

  it('prefers the store-provided result when no override is given', () => {
    useAnalyzeStore.getState().setCpfResult(PV_RESULT);
    render(<CPFCurveChart />);
    expect(screen.getByTestId('cpf-curve')).toBeInTheDocument();
    expect(screen.getByTestId('cpf-curve-line-1')).toBeInTheDocument();
  });
});

describe('pickDefaultVisibleBuses', () => {
  it('returns all buses when total ≤ maxBuses', () => {
    const visible = pickDefaultVisibleBuses(PV_RESULT, 8);
    expect(visible.sort()).toEqual(['1', '2', '3'].sort());
  });

  it('ranks by voltage swing when total > maxBuses', () => {
    // Build a result where bus "big" has the largest swing.
    const result: CpfResult = {
      lambdas: [0, 1, 2],
      voltages_per_bus: {
        big: [1.0, 0.5, 0.0], // swing 1.0
        med: [1.0, 0.9, 0.8], // swing 0.2
        sml: [1.0, 1.0, 1.0], // swing 0.0
      },
      bus_idxes: ['sml', 'med', 'big'],
      nose_idx: 2,
      max_lam: 2,
      truncated: false,
      done_msg: '',
      mode: 'pv',
    };
    const visible = pickDefaultVisibleBuses(result, 2);
    expect(visible).toEqual(['big', 'med']);
  });
});

describe('computeViewport', () => {
  it('returns a sensible Y-range for the visible buses', () => {
    const vp = computeViewport(PV_RESULT, ['1']);
    // Bus 1 voltages: 1.06 .. 0.85
    expect(vp.yMin).toBeLessThan(0.85);
    expect(vp.yMax).toBeGreaterThan(1.06);
  });

  it('handles a degenerate single-value bus (pads symmetrically)', () => {
    const flat: CpfResult = {
      lambdas: [0, 1, 2],
      voltages_per_bus: { '1': [1.0, 1.0, 1.0] },
      bus_idxes: ['1'],
      nose_idx: -1,
      max_lam: 2,
      truncated: false,
      done_msg: '',
      mode: 'pv',
    };
    const vp = computeViewport(flat, ['1']);
    expect(vp.yMin).toBeLessThan(1.0);
    expect(vp.yMax).toBeGreaterThan(1.0);
  });

  it('returns defaults when no buses are visible', () => {
    const vp = computeViewport(PV_RESULT, []);
    // computeViewport falls back to [0,1] when no buses contribute and
    // takes lambda extremes from the result.
    expect(vp.xMin).toBeCloseTo(0);
    expect(vp.xMax).toBeCloseTo(3.25);
  });
});
