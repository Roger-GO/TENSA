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
 * - What a run was asked for: the caption, a full curve's dashed lower
 *   branch and two-branch readout, the markers where generators reached a
 *   limit, and the banner of a lower branch that broke off.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  CPFCurveChart,
  computeLambdaRange,
  computeViewport,
  interpolateBusVoltage,
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
    '2': [1.045, 1.04, 1.03, 1.02, 1.0, 0.98, 0.94, 0.88, 0.8],
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

// A full curve: up to the nose at step 3, then back down to lambda 0.
const FULL_RESULT: CpfResult = {
  lambdas: [0.0, 0.4, 0.8, 1.0, 0.7, 0.3, 0.0],
  voltages_per_bus: {
    '1': [1.0, 0.98, 0.94, 0.85, 0.7, 0.55, 0.4],
    '2': [1.02, 1.0, 0.97, 0.9, 0.78, 0.6, 0.45],
  },
  bus_idxes: ['1', '2'],
  nose_idx: 3,
  max_lam: 1.0,
  truncated: false,
  done_msg: 'Full curve traced (returned to lambda=0)',
  mode: 'pv',
  direction: 'load-only',
  stop_at: 'full',
  complete: true,
  q_limits_enforced: true,
  generators: [],
  limit_events: [
    { step: 0, lam: 0, idx: '2', model: 'PV', bus: '2', limit: 'qmax', at_nose: false },
    { step: 2, lam: 0.8, idx: '3', model: 'PV', bus: '3', limit: 'qmax', at_nose: false },
    { step: 3, lam: 1.0, idx: '1', model: 'Slack', bus: '1', limit: 'qmax', at_nose: true },
    { step: 5, lam: 0.3, idx: '4', model: 'PV', bus: '4', limit: 'qmin', at_nose: false },
  ],
};

describe('<CPFCurveChart /> what the run was asked for', () => {
  beforeEach(() => {
    resetAnalyzeStore();
  });

  it('says the direction, what lambda is, and whether limits were enforced', () => {
    render(<CPFCurveChart result={FULL_RESULT} />);
    expect(screen.getByTestId('cpf-run-caption')).toHaveTextContent(
      'Loads only · λ = 1 is twice the base load · Q limits enforced · full curve',
    );
    expect(screen.getByText('lambda (load scale, generation fixed)')).toBeInTheDocument();
  });

  it('has no caption for a result that does not say what was run', () => {
    render(<CPFCurveChart result={PV_RESULT} />);
    expect(screen.queryByTestId('cpf-run-caption')).not.toBeInTheDocument();
    expect(screen.getByText('lambda (load scale)')).toBeInTheDocument();
  });

  it('a QV curve says only whether limits were enforced', () => {
    render(<CPFCurveChart result={{ ...QV_RESULT, q_limits_enforced: false }} />);
    expect(screen.getByTestId('cpf-run-caption')).toHaveTextContent(/^Q limits not enforced$/);
  });

  it('draws the lower branch of a full curve as its own dashed line, joined at the nose', () => {
    render(<CPFCurveChart result={FULL_RESULT} />);
    const upper = screen.getByTestId('cpf-curve-line-1').getAttribute('points')!.split(' ');
    const lower = screen.getByTestId('cpf-curve-lower-1');
    const lowerPoints = lower.getAttribute('points')!.split(' ');
    // Steps 0 to 3 up, steps 3 to 6 down: the nose point is on both.
    expect(upper).toHaveLength(4);
    expect(lowerPoints).toHaveLength(4);
    expect(lowerPoints[0]).toBe(upper[3]);
    expect(lower).toHaveAttribute('stroke-dasharray');
    expect(lower.getAttribute('stroke')).toBe(
      screen.getByTestId('cpf-curve-line-1').getAttribute('stroke'),
    );
  });

  it('a run that stops at the nose is one line, as before', () => {
    render(<CPFCurveChart result={PV_RESULT} />);
    expect(screen.getByTestId('cpf-curve-line-1').getAttribute('points')!.split(' ')).toHaveLength(
      9,
    );
    expect(screen.queryByTestId('cpf-curve-lower-1')).not.toBeInTheDocument();
  });

  it('marks where each generator reached a limit along the path, not those held from the start', () => {
    render(<CPFCurveChart result={FULL_RESULT} />);
    expect(screen.queryByTestId('cpf-limit-marker-PV-2')).not.toBeInTheDocument();
    expect(screen.getByTestId('cpf-limit-marker-PV-3')).toHaveTextContent(
      'PV 3 reached Qmax at λ = 0.8000',
    );
    // The one the nose is due to stands out, and one on the way down says so.
    expect(screen.getByTestId('cpf-limit-marker-Slack-1')).toHaveClass('fill-danger');
    expect(screen.getByTestId('cpf-limit-marker-PV-3')).toHaveClass('fill-warning');
    expect(screen.getByTestId('cpf-limit-marker-PV-4')).toHaveTextContent(
      'PV 4 reached Qmin at λ = 0.3000 (lower branch)',
    );
  });

  it('reads both branches at the sampled lambda of a full curve', async () => {
    render(<CPFCurveChart result={FULL_RESULT} />);
    const slider = screen.getByTestId('cpf-lambda-slider') as HTMLInputElement;
    await act(async () => {
      // React tracks the value through the native setter.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        slider,
        '0.4',
      );
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const row = screen.getByTestId('cpf-lambda-readout-row-1');
    // 0.98 on the way up; on the way down, a quarter of the way from 0.7 to 0.3.
    expect(row).toHaveTextContent('0.980 pu');
    expect(screen.getByTestId('cpf-lambda-readout-lower-1')).toHaveTextContent('0.588 pu');
  });

  it('says when a lower branch broke off, and that the nose stands', () => {
    render(
      <CPFCurveChart
        result={{ ...FULL_RESULT, complete: false, done_msg: 'Corrector failed at lambda=0.3' }}
      />,
    );
    expect(screen.getByTestId('cpf-incomplete-banner')).toHaveTextContent(
      'The lower branch stops before it is back at the base load. Reason: Corrector failed at lambda=0.3.',
    );
    expect(screen.queryByTestId('cpf-truncated-banner')).not.toBeInTheDocument();
    expect(screen.getByTestId('cpf-nose-marker')).toBeInTheDocument();
  });

  it('a truncated run has the truncation banner, not the lower-branch one', () => {
    render(<CPFCurveChart result={{ ...TRUNCATED_RESULT, complete: false }} />);
    expect(screen.getByTestId('cpf-truncated-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('cpf-incomplete-banner')).not.toBeInTheDocument();
  });
});

describe('interpolateBusVoltage on one branch', () => {
  it('reads the upper branch up to the nose and the lower branch from it', () => {
    expect(interpolateBusVoltage(FULL_RESULT, '1', 0.4, 'upper')).toBeCloseTo(0.98, 6);
    expect(interpolateBusVoltage(FULL_RESULT, '1', 0.4, 'lower')).toBeCloseTo(0.5875, 6);
    // The whole trace gives the later of the two, as it always did.
    expect(interpolateBusVoltage(FULL_RESULT, '1', 0.4)).toBeCloseTo(0.5875, 6);
    expect(interpolateBusVoltage(FULL_RESULT, '1', 1.0, 'upper')).toBeCloseTo(0.85, 6);
    expect(interpolateBusVoltage(FULL_RESULT, '1', 1.0, 'lower')).toBeCloseTo(0.85, 6);
  });

  it('gives null where the branch has no point, not its nearest end', () => {
    const partial: CpfResult = {
      ...FULL_RESULT,
      lambdas: [0.0, 0.4, 0.8, 1.0, 0.7],
      voltages_per_bus: { '1': [1.0, 0.98, 0.94, 0.85, 0.7] },
      bus_idxes: ['1'],
    };
    expect(interpolateBusVoltage(partial, '1', 0.4, 'lower')).toBeNull();
    expect(interpolateBusVoltage(partial, '1', 0.4, 'upper')).toBeCloseTo(0.98, 6);
  });
});

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
    expect(screen.getByTestId('cpf-truncated-banner').textContent).toMatch(/Reached max steps/);
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

describe('<CPFCurveChart /> Unit 17 polish', () => {
  beforeEach(() => {
    resetAnalyzeStore();
  });
  afterEach(() => {
    resetAnalyzeStore();
  });

  it('renders the nose annotation label with lambda + V_min copy', () => {
    render(<CPFCurveChart result={PV_RESULT} />);
    const label = screen.getByTestId('cpf-nose-label');
    expect(label).toBeInTheDocument();
    // PV_RESULT.lambdas[7] === 3.25; min bus voltage at idx 7 is 0.88.
    expect(label.textContent).toMatch(/Nose:/);
    expect(label.textContent).toMatch(/3\.25/);
    expect(label.textContent).toMatch(/V_min=0\.88/);
  });

  it('renders the truncated annotation label with lambda_max copy', () => {
    render(<CPFCurveChart result={TRUNCATED_RESULT} />);
    const label = screen.getByTestId('cpf-truncated-label');
    expect(label).toBeInTheDocument();
    expect(label.textContent).toMatch(/Truncated/);
    expect(label.textContent).toMatch(/0\.30/);
    expect(label.textContent).toMatch(/no nose found/);
    // The happy-path nose label must NOT render on a truncated curve.
    expect(screen.queryByTestId('cpf-nose-label')).not.toBeInTheDocument();
  });

  it('renders the lambda slider + readout below the chart', () => {
    render(<CPFCurveChart result={PV_RESULT} />);
    const slider = screen.getByTestId('cpf-lambda-slider');
    expect(slider).toBeInTheDocument();
    expect(slider).toHaveAttribute('type', 'range');
    expect(slider.getAttribute('min')).toBe('0');
    // max should be max_lam (3.25 from PV_RESULT).
    expect(Number(slider.getAttribute('max'))).toBeCloseTo(3.25);
    expect(screen.getByTestId('cpf-lambda-readout')).toBeInTheDocument();
    // Vertical marker is rendered when the slider is initialised.
    expect(screen.getByTestId('cpf-lambda-marker')).toBeInTheDocument();
  });

  it('readout lists every visible bus sorted by V ascending', () => {
    render(<CPFCurveChart result={PV_RESULT} />);
    const readout = screen.getByTestId('cpf-lambda-readout');
    const rows = Array.from(readout.querySelectorAll('[data-testid^="cpf-lambda-readout-row-"]'));
    expect(rows.length).toBe(3);
    // Default lambda is the nose (index 7, lambda=3.25). Voltages at idx 7:
    // bus 1 = 0.92, bus 2 = 0.88, bus 3 = 0.92. So sorted ascending: 2, then
    // (1 or 3), then (3 or 1). The most-stressed bus must come first.
    const firstBusIdx = rows[0]?.getAttribute('data-testid');
    expect(firstBusIdx).toBe('cpf-lambda-readout-row-2');
  });

  it('drag slider updates the readout + vertical marker position', async () => {
    const user = userEvent.setup();
    render(<CPFCurveChart result={PV_RESULT} />);
    const slider = screen.getByTestId('cpf-lambda-slider') as HTMLInputElement;
    const before = screen.getByTestId('cpf-lambda-value').textContent;
    // userEvent doesn't drive type=range natively; use fireEvent-style
    // value set, which jsdom flushes through React's controlled input.
    await user.click(slider);
    slider.focus();
    // Drive the slider via a direct value change. Use the React-friendly
    // setter dance so React picks up the change synthetically.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(slider, '0.5');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const after = screen.getByTestId('cpf-lambda-value').textContent;
    expect(after).not.toBe(before);
    expect(after).toMatch(/0\.5/);
  });

  it('hovering a bus polyline highlights matching legend entry', async () => {
    const user = userEvent.setup();
    render(<CPFCurveChart result={PV_RESULT} />);
    const line = screen.getByTestId('cpf-curve-line-2');
    expect(line.getAttribute('data-hovered')).toBe('false');
    await user.hover(line);
    expect(line.getAttribute('data-hovered')).toBe('true');
    expect(screen.getByTestId('cpf-curve-legend-2').getAttribute('data-hovered')).toBe('true');
    await user.unhover(line);
    expect(line.getAttribute('data-hovered')).toBe('false');
    expect(screen.getByTestId('cpf-curve-legend-2').getAttribute('data-hovered')).toBe('false');
  });

  it('truncated CPF: slider max equals last computed lambda', () => {
    render(<CPFCurveChart result={TRUNCATED_RESULT} />);
    const slider = screen.getByTestId('cpf-lambda-slider');
    // TRUNCATED_RESULT.max_lam === 0.3 and the last lambda is also 0.3.
    expect(Number(slider.getAttribute('max'))).toBeCloseTo(0.3);
  });
});

describe('interpolateBusVoltage', () => {
  it('linearly interpolates between two computed points', () => {
    // Bus 1 trace at lambdas [0.0, 0.5, 1.0, ...] is [1.06, 1.05, 1.04, ...].
    // Sampling at lambda=0.25 -> halfway between 1.06 and 1.05 -> 1.055.
    const v = interpolateBusVoltage(PV_RESULT, '1', 0.25);
    expect(v).not.toBeNull();
    expect(v).toBeCloseTo(1.055, 3);
  });

  it('returns the post-nose branch voltage when lambda exists on both branches', () => {
    // PV_RESULT folds back: lambdas[7]=3.25, lambdas[8]=3.10.
    // Lambda=3.10 is the last entry exactly, so interpolation should
    // pick the rightmost matching segment which terminates at 3.10
    // (post-nose branch).
    const v = interpolateBusVoltage(PV_RESULT, '1', 3.1);
    // Bus 1 voltage at idx 8 (post-nose) is 0.85.
    expect(v).toBeCloseTo(0.85, 3);
  });

  it('returns the only voltage when the trace has length 1', () => {
    const single: CpfResult = {
      lambdas: [0.5],
      voltages_per_bus: { '1': [0.99] },
      bus_idxes: ['1'],
      nose_idx: -1,
      max_lam: 0.5,
      truncated: true,
      done_msg: '',
      mode: 'pv',
    };
    expect(interpolateBusVoltage(single, '1', 0.5)).toBeCloseTo(0.99, 5);
  });

  it('returns null for an unknown bus', () => {
    expect(interpolateBusVoltage(PV_RESULT, 'nonexistent', 1.0)).toBeNull();
  });

  it('clamps to nearest endpoint when lambda is outside the trace', () => {
    // Bus 1 trace covers lambdas [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.25, 3.10].
    // Querying lambda=10 (outside) clamps to the nearest endpoint.
    const v = interpolateBusVoltage(PV_RESULT, '1', 10.0);
    expect(v).not.toBeNull();
    // Nearest lambda to 10 is 3.25 (index 7) — voltage there is 0.92.
    expect(v).toBeCloseTo(0.92, 3);
  });
});

describe('computeLambdaRange', () => {
  it('returns min + max from the lambdas array', () => {
    const range = computeLambdaRange(PV_RESULT);
    expect(range.min).toBeCloseTo(0);
    expect(range.max).toBeCloseTo(3.25);
  });

  it('returns zero range when lambdas is empty', () => {
    const empty: CpfResult = {
      ...PV_RESULT,
      lambdas: [],
      voltages_per_bus: {},
      bus_idxes: [],
      nose_idx: -1,
      max_lam: 0,
      truncated: true,
    };
    const range = computeLambdaRange(empty);
    expect(range.min).toBe(0);
    expect(range.max).toBe(0);
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
