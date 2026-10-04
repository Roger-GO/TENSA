/**
 * SldVoltageLegend: the on-canvas key to the bus colours and limit markers.
 * It appears once the diagram has voltages to colour (a converged power
 * flow, or a streaming run) and says what each band and marker means.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { SldVoltageLegend } from '@/components/sld/SldVoltageLegend';
import { useAnimationStore } from '@/store/animation';
import { usePflowStore } from '@/store/pflow';
import { useRunsStore } from '@/store/runs';
import { parseRunId } from '@/api/types';
import type { PflowResult } from '@/api/types';

function pflow(converged: boolean): PflowResult {
  return {
    run_id: parseRunId('pf-1'),
    converged,
    iterations: 3,
    mismatch: 1e-9,
    bus_voltages: { '1': 1.0 },
    bus_angles: { '1': 0 },
    line_flows: {},
  };
}

function reset(): void {
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useRunsStore.setState({ runs: {}, activeRunId: null });
  useAnimationStore.setState({ busOverlayByRun: {} });
}

describe('SldVoltageLegend', () => {
  beforeEach(reset);
  afterEach(() => {
    cleanup();
    reset();
  });

  it('draws nothing before there are bus voltages to colour', () => {
    const { container } = render(<SldVoltageLegend />);
    expect(container.firstChild).toBeNull();
  });

  it('draws nothing after a power flow that did not converge', () => {
    usePflowStore.setState({ lastRun: pflow(false) });
    const { container } = render(<SldVoltageLegend />);
    expect(container.firstChild).toBeNull();
  });

  it('appears when a power flow converges', () => {
    render(<SldVoltageLegend />);
    expect(screen.queryByTestId('sld-voltage-legend')).not.toBeInTheDocument();
    act(() => {
      usePflowStore.setState({ lastRun: pflow(true) });
    });
    expect(screen.getByRole('group', { name: 'Bus voltage legend' })).toBeInTheDocument();
  });

  it('appears while a streaming run puts bands on the buses', () => {
    useRunsStore.setState({ runs: {}, activeRunId: 'run-x' });
    render(<SldVoltageLegend />);
    expect(screen.queryByTestId('sld-voltage-legend')).not.toBeInTheDocument();
    act(() => {
      useAnimationStore
        .getState()
        .setBusOverlayForRun(
          'run-x',
          new Map([['1', { band: 'success', side: null, voltage: 1 }]]),
        );
    });
    expect(screen.getByTestId('sld-voltage-legend')).toBeInTheDocument();
  });

  it('ignores an overlay that belongs to a run that is not the active one', () => {
    useRunsStore.setState({ runs: {}, activeRunId: 'run-x' });
    useAnimationStore
      .getState()
      .setBusOverlayForRun('run-y', new Map([['1', { band: 'success', side: null, voltage: 1 }]]));
    const { container } = render(<SldVoltageLegend />);
    expect(container.firstChild).toBeNull();
  });

  it('keys the three bands and the markers that go with the two out-of-band ones', () => {
    usePflowStore.setState({ lastRun: pflow(true) });
    render(<SldVoltageLegend />);
    const clear = screen.getByTestId('sld-voltage-legend-success');
    const near = screen.getByTestId('sld-voltage-legend-warning');
    const beyond = screen.getByTestId('sld-voltage-legend-danger');
    expect(clear).toHaveTextContent('Within limits');
    expect(near).toHaveTextContent('Within 0.02 pu of a limit');
    expect(beyond).toHaveTextContent('Beyond a limit');
    // A bus in the clear has no marker; the other two show both directions.
    expect(within(clear).queryAllByRole('img')).toHaveLength(0);
    expect(within(near).getAllByRole('img')).toHaveLength(2);
    expect(within(beyond).getAllByRole('img')).toHaveLength(2);
    expect(
      within(beyond).getByRole('img', { name: 'Voltage beyond its upper limit' }),
    ).toBeVisible();
    expect(within(near).getByRole('img', { name: 'Voltage near its lower limit' })).toBeVisible();
  });

  it('says which limits are meant and what the default is', () => {
    usePflowStore.setState({ lastRun: pflow(true) });
    render(<SldVoltageLegend />);
    const legend = screen.getByTestId('sld-voltage-legend');
    expect(legend).toHaveTextContent('Up: above vmax. Down: below vmin.');
    expect(legend).toHaveTextContent('Each bus uses its own limits');
    expect(legend).toHaveTextContent('0.95 and 1.05 pu if it has none');
  });

  it('points to where a bus limits are seen and changed', () => {
    usePflowStore.setState({ lastRun: pflow(true) });
    render(<SldVoltageLegend />);
    expect(screen.getByTestId('sld-voltage-legend')).toHaveTextContent(
      'Select a bus to see its limits and how to change them.',
    );
  });

  it('takes the class it is given, so the canvas can place it', () => {
    usePflowStore.setState({ lastRun: pflow(true) });
    render(<SldVoltageLegend className="absolute top-2 left-2" />);
    expect(screen.getByTestId('sld-voltage-legend').className).toContain('absolute');
  });
});
