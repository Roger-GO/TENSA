/**
 * SldLimitsLegend: the on-canvas key to the line loading colours and the
 * generator reactive-limit markers. Each part appears only when the diagram
 * shows what it explains.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { SldLimitsLegend } from '@/components/sld/SldLimitsLegend';
import { usePflowStore } from '@/store/pflow';
import { parseRunId } from '@/api/types';
import type { PflowResult } from '@/api/types';
import { lineFlow } from '../../helpers/lineFlow';

function pflow(overrides: Partial<PflowResult> = {}): PflowResult {
  return {
    run_id: parseRunId('pf-1'),
    converged: true,
    iterations: 3,
    mismatch: 1e-9,
    bus_voltages: { '1': 1.0 },
    bus_angles: { '1': 0 },
    line_flows: {},
    generator_outputs: {},
    ...overrides,
  };
}

const RATED = { L1: lineFlow(50, 5, undefined, { rate_a: 100, loading_pct: 50 }) };
const AT_LIMIT = { '1': { p: 40, q: 30, v: 1.0, bus: 1, q_min: -10, q_max: 15 } };

function reset(): void {
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
}

describe('SldLimitsLegend', () => {
  beforeEach(reset);
  afterEach(() => {
    cleanup();
    reset();
  });

  it('draws nothing before a power flow, or after one that did not converge', () => {
    const { container } = render(<SldLimitsLegend />);
    expect(container.firstChild).toBeNull();
    act(() => {
      usePflowStore.setState({
        lastRun: pflow({ converged: false, line_flows: RATED, generator_outputs: AT_LIMIT }),
      });
    });
    expect(container.firstChild).toBeNull();
  });

  it('draws nothing for a case with no rated line and no generator on a limit', () => {
    usePflowStore.setState({
      lastRun: pflow({
        line_flows: { L1: lineFlow(50, 5) },
        generator_outputs: { '1': { p: 40, q: 5, v: 1.0, bus: 1, q_min: -10, q_max: 15 } },
      }),
    });
    const { container } = render(<SldLimitsLegend />);
    expect(container.firstChild).toBeNull();
  });

  it('explains the line colours once a line has a rating', () => {
    usePflowStore.setState({ lastRun: pflow({ line_flows: RATED }) });
    render(<SldLimitsLegend />);
    expect(screen.getByRole('group', { name: /line loading/i })).toBeInTheDocument();
    expect(screen.getByTestId('sld-limits-legend-loading')).toHaveTextContent(
      '80% to 100% of the rating',
    );
    expect(screen.getByTestId('sld-limits-legend-loading')).toHaveTextContent('Over the rating');
    expect(screen.queryByTestId('sld-limits-legend-reactive')).not.toBeInTheDocument();
  });

  it('explains the generator markers once a generator is on or past a limit', () => {
    usePflowStore.setState({ lastRun: pflow({ generator_outputs: AT_LIMIT }) });
    render(<SldLimitsLegend />);
    const reactive = screen.getByTestId('sld-limits-legend-reactive');
    expect(reactive).toHaveTextContent('Past a Q limit');
    expect(reactive).toHaveTextContent('Up: Qmax. Down: Qmin.');
    expect(screen.queryByTestId('sld-limits-legend-loading')).not.toBeInTheDocument();
  });

  it('shows both parts when both apply, and follows the result as it changes', () => {
    render(<SldLimitsLegend />);
    act(() => {
      usePflowStore.setState({
        lastRun: pflow({ line_flows: RATED, generator_outputs: AT_LIMIT }),
      });
    });
    expect(screen.getByTestId('sld-limits-legend-loading')).toBeInTheDocument();
    expect(screen.getByTestId('sld-limits-legend-reactive')).toBeInTheDocument();
    act(() => {
      usePflowStore.setState({ lastRun: null });
    });
    expect(screen.queryByTestId('sld-limits-legend')).not.toBeInTheDocument();
  });

  it('leaves the sentences under its rows out when it is asked to be compact', () => {
    usePflowStore.setState({ lastRun: pflow({ line_flows: RATED, generator_outputs: AT_LIMIT }) });
    const { rerender } = render(<SldLimitsLegend />);
    const legend = screen.getByTestId('sld-limits-legend');
    expect(legend).toHaveTextContent('A line with no rating is not coloured.');
    expect(legend).toHaveTextContent('Up: Qmax. Down: Qmin.');
    rerender(<SldLimitsLegend compact />);
    expect(legend).not.toHaveTextContent('A line with no rating is not coloured.');
    expect(legend).not.toHaveTextContent('Up: Qmax. Down: Qmin.');
    expect(legend).toHaveTextContent('Over the rating');
    expect(legend).toHaveTextContent('Past a Q limit');
  });
});
