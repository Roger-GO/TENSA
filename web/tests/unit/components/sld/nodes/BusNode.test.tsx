/**
 * BusNode tests covering the v0.1 PF-result coloring path AND the v0.2
 * streaming-overlay layer. The streaming overlay is fed via the
 * animation slice (per Unit 5's design — a SINGLE rAF loop writes the
 * derived overlay there; BusNode subscribes to its own slot via
 * ``useFrameBusOverlay``). These tests drive the animation slice
 * directly so they don't have to spin up the rAF loop.
 *
 * jsdom-canvas note: BusNode renders an ``<img>`` (the IEC 60617 bus
 * icon) and the @xyflow/react ``Handle`` components — neither needs
 * canvas, but Handle requires a ReactFlowProvider context. We stub the
 * @xyflow/react module the same way the SldCanvas test does so we can
 * render the node component standalone.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import type { ReactNode } from 'react';

// Stub @xyflow/react before importing BusNode (Vitest hoists vi.mock
// calls to the top of the file).
vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    Handle: () => null,
    Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
    ReactFlowProvider: ({ children }: { children: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

// Icon manifest is a static map; the real one is fine in jsdom.
import { BusNode } from '@/components/sld/nodes/BusNode';
import { useAnimationStore } from '@/store/animation';
import { usePflowStore } from '@/store/pflow';
import { useRunsStore } from '@/store/runs';
import { useUiStore } from '@/store/ui';
import { useUnitsStore } from '@/store/units';
import { parseRunId } from '@/api/types';
import type { PflowResult } from '@/api/types';

function nodeProps(
  idx: string,
  name = `b${idx}`,
  voltageLimits?: { vmin: number; vmax: number },
  baseKv?: number,
): Parameters<typeof BusNode>[0] {
  // Minimal NodeProps shape; the component only reads `data` + `selected`.
  return {
    id: idx,
    data: {
      idx,
      name,
      kind: 'Bus',
      ...(voltageLimits ? { voltageLimits } : {}),
      ...(baseKv === undefined ? {} : { baseKv }),
    },
    selected: false,
    type: 'bus',
    isConnectable: true,
    xPos: 0,
    yPos: 0,
    dragging: false,
    targetPosition: 'top',
    sourcePosition: 'bottom',
    zIndex: 0,
  } as unknown as Parameters<typeof BusNode>[0];
}

function makePflow(overrides: Partial<PflowResult> = {}): PflowResult {
  return {
    run_id: parseRunId('pf-1'),
    converged: true,
    iterations: 4,
    mismatch: 1e-6,
    bus_voltages: {},
    bus_angles: {},
    line_flows: {},
    ...overrides,
  };
}

function resetStores(): void {
  useAnimationStore.setState({ busOverlayByRun: {} });
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useRunsStore.setState({ runs: {}, activeRunId: null });
  useUiStore.setState({ hideLabels: false });
  useUnitsStore.setState({ mode: 'pu' });
}

describe('BusNode — v0.1 PF-result coloring path (no active run)', () => {
  beforeEach(resetStores);
  afterEach(() => {
    cleanup();
    resetStores();
  });

  it('renders neutral border + no labels with no PF result', () => {
    const { getByTestId, queryByTestId } = render(<BusNode {...nodeProps('1')} />);
    const node = getByTestId('bus-node-1');
    expect(node).toHaveAttribute('data-band', 'neutral');
    expect(node).not.toHaveAttribute('data-streaming');
    expect(node.className).toContain('border-border');
    expect(queryByTestId('bus-voltage-1')).toBeNull();
    expect(queryByTestId('bus-angle-1')).toBeNull();
  });

  it('renders the success band + labels for an in-band PF voltage', () => {
    usePflowStore.setState({
      lastRun: makePflow({ bus_voltages: { '1': 1.0 }, bus_angles: { '1': 0 } }),
      isRunning: false,
      error: null,
    });
    const { getByTestId } = render(<BusNode {...nodeProps('1')} />);
    const node = getByTestId('bus-node-1');
    expect(node).toHaveAttribute('data-band', 'success');
    expect(node.className).toContain('border-success');
    expect(getByTestId('bus-voltage-1')).toHaveTextContent('1.000 pu');
  });

  it('renders the danger band for an out-of-limit PF voltage', () => {
    usePflowStore.setState({
      lastRun: makePflow({ bus_voltages: { '5': 0.91 }, bus_angles: { '5': 0 } }),
      isRunning: false,
      error: null,
    });
    const { getByTestId } = render(<BusNode {...nodeProps('5')} />);
    const node = getByTestId('bus-node-5');
    expect(node).toHaveAttribute('data-band', 'danger');
    expect(node.className).toContain('border-danger');
  });
});

describe('BusNode, display units', () => {
  beforeEach(resetStores);
  afterEach(() => {
    cleanup();
    resetStores();
  });

  function solved(): void {
    usePflowStore.setState({
      lastRun: makePflow({ bus_voltages: { '1': 1.06 }, bus_angles: { '1': -0.087 } }),
      isRunning: false,
      error: null,
    });
  }

  it('labels the voltage in pu by default, with a rated voltage on the node or not', () => {
    solved();
    const { getByTestId } = render(<BusNode {...nodeProps('1', 'b1', undefined, 230)} />);
    expect(getByTestId('bus-voltage-1')).toHaveTextContent('1.060 pu');
  });

  it('labels the voltage in kV under the actual-units display', () => {
    solved();
    useUnitsStore.setState({ mode: 'actual' });
    const { getByTestId } = render(<BusNode {...nodeProps('1', 'b1', undefined, 230)} />);
    expect(getByTestId('bus-voltage-1')).toHaveTextContent('243.80 kV');
    // The angle reads in degrees either way.
    expect(getByTestId('bus-angle-1')).toHaveTextContent('-4.98°');
  });

  it('keeps the label in pu under the actual-units display when the bus has no rated voltage', () => {
    solved();
    useUnitsStore.setState({ mode: 'actual' });
    const { getByTestId } = render(<BusNode {...nodeProps('1')} />);
    expect(getByTestId('bus-voltage-1')).toHaveTextContent('1.060 pu');
  });

  it('follows a change of the display units without a new power flow', () => {
    solved();
    const { getByTestId } = render(<BusNode {...nodeProps('1', 'b1', undefined, 230)} />);
    expect(getByTestId('bus-voltage-1')).toHaveTextContent('1.060 pu');
    act(() => useUnitsStore.getState().setMode('actual'));
    expect(getByTestId('bus-voltage-1')).toHaveTextContent('243.80 kV');
  });
});

describe('BusNode, the bus own voltage limits', () => {
  beforeEach(resetStores);
  afterEach(() => {
    cleanup();
    resetStores();
  });

  function solvedAt(idx: string, v: number): void {
    usePflowStore.setState({
      lastRun: makePflow({ bus_voltages: { [idx]: v }, bus_angles: { [idx]: 0 } }),
      isRunning: false,
      error: null,
    });
  }

  it('judges the bus on the limits stamped on its node data', () => {
    solvedAt('1', 1.07);
    const wide = { vmin: 0.9, vmax: 1.1 };
    // Past the default 1.05, inside the bus's own 1.10.
    const own = render(<BusNode {...nodeProps('1', 'b1', wide)} />);
    expect(own.getByTestId('bus-node-1')).toHaveAttribute('data-band', 'success');
    own.unmount();
    const fallback = render(<BusNode {...nodeProps('1')} />);
    expect(fallback.getByTestId('bus-node-1')).toHaveAttribute('data-band', 'danger');
  });

  it('names the limits in the tooltip of its label, the default when it has none', () => {
    const own = render(<BusNode {...nodeProps('1', 'BUS1', { vmin: 0.9, vmax: 1.1 })} />);
    expect(own.getByTitle('BUS1: voltage limits 0.9 to 1.1 pu')).toBeInTheDocument();
    own.unmount();
    const fallback = render(<BusNode {...nodeProps('2', 'BUS2')} />);
    expect(fallback.getByTitle('BUS2: voltage limits 0.95 to 1.05 pu')).toBeInTheDocument();
  });

  it('flags a bus a tighter limit puts out of band', () => {
    solvedAt('2', 1.0);
    const { getByTestId } = render(
      <BusNode {...nodeProps('2', 'b2', { vmin: 1.01, vmax: 1.04 })} />,
    );
    expect(getByTestId('bus-node-2')).toHaveAttribute('data-band', 'danger');
    expect(getByTestId('bus-node-2')).toHaveAttribute('data-limit-side', 'low');
  });
});

describe('BusNode, limit marker (a sign that does not rest on colour)', () => {
  beforeEach(resetStores);
  afterEach(() => {
    cleanup();
    resetStores();
  });

  function solvedAt(idx: string, v: number): void {
    usePflowStore.setState({
      lastRun: makePflow({ bus_voltages: { [idx]: v }, bus_angles: { [idx]: 0 } }),
      isRunning: false,
      error: null,
    });
  }

  it('draws no marker before a power flow or for a bus in the clear', () => {
    const before = render(<BusNode {...nodeProps('1')} />);
    expect(before.queryByTestId('bus-limit-marker-1')).toBeNull();
    expect(before.getByTestId('bus-node-1')).not.toHaveAttribute('data-limit-side');
    before.unmount();
    solvedAt('1', 1.0);
    const clear = render(<BusNode {...nodeProps('1')} />);
    expect(clear.queryByTestId('bus-limit-marker-1')).toBeNull();
  });

  it('marks a bus beyond its upper limit with a filled up triangle', () => {
    solvedAt('5', 1.08);
    const { getByTestId, getByRole } = render(<BusNode {...nodeProps('5')} />);
    const marker = getByTestId('bus-limit-marker-5');
    expect(marker).toHaveAttribute('data-band', 'danger');
    expect(marker).toHaveAttribute('data-side', 'high');
    expect(getByRole('img', { name: 'Voltage beyond its upper limit' })).toBe(marker);
    expect(getByTestId('bus-node-5')).toHaveAttribute('data-limit-side', 'high');
  });

  it('marks a bus beyond its lower limit with a down triangle', () => {
    solvedAt('6', 0.91);
    const { getByTestId } = render(<BusNode {...nodeProps('6')} />);
    expect(getByTestId('bus-limit-marker-6')).toHaveAttribute('data-side', 'low');
    expect(getByTestId('bus-limit-marker-6')).toHaveAttribute(
      'aria-label',
      'Voltage beyond its lower limit',
    );
  });

  it('tells a bus near a limit from one beyond it by the shape, not the colour', () => {
    solvedAt('7', 0.96);
    const near = render(<BusNode {...nodeProps('7')} />);
    const nearMarker = near.getByTestId('bus-limit-marker-7');
    expect(nearMarker).toHaveAttribute('data-band', 'warning');
    expect(nearMarker).toHaveAttribute('aria-label', 'Voltage near its lower limit');
    const nearFill = nearMarker.querySelector('polygon')!.getAttribute('class');
    near.unmount();
    solvedAt('7', 0.92);
    const beyond = render(<BusNode {...nodeProps('7')} />);
    const beyondFill = beyond
      .getByTestId('bus-limit-marker-7')
      .querySelector('polygon')!
      .getAttribute('class');
    expect(nearFill).toContain('fill-transparent');
    expect(beyondFill).toContain('fill-danger');
  });

  it('keeps the marker when "Hide labels" removes the value labels', () => {
    solvedAt('8', 1.09);
    useUiStore.setState({ hideLabels: true });
    const { getByTestId, queryByTestId } = render(<BusNode {...nodeProps('8')} />);
    expect(queryByTestId('bus-voltage-8')).toBeNull();
    expect(getByTestId('bus-limit-marker-8')).toHaveAttribute('data-side', 'high');
  });

  it('follows the bus own limits: a wide band takes the marker away', () => {
    solvedAt('9', 1.07);
    const { queryByTestId } = render(
      <BusNode {...nodeProps('9', 'b9', { vmin: 0.9, vmax: 1.1 })} />,
    );
    expect(queryByTestId('bus-limit-marker-9')).toBeNull();
  });

  it('takes the marker from the streaming overlay and turns it with the side', () => {
    solvedAt('3', 1.0);
    useRunsStore.setState({ runs: {}, activeRunId: 'run-x' });
    useAnimationStore
      .getState()
      .setBusOverlayForRun(
        'run-x',
        new Map([['3', { band: 'danger', side: 'low', voltage: 0.8 }]]),
      );
    const { getByTestId } = render(<BusNode {...nodeProps('3')} />);
    expect(getByTestId('bus-limit-marker-3')).toHaveAttribute('data-side', 'low');

    act(() => {
      useAnimationStore
        .getState()
        .setBusOverlayForRun(
          'run-x',
          new Map([['3', { band: 'danger', side: 'high', voltage: 1.3 }]]),
        );
    });
    expect(getByTestId('bus-limit-marker-3')).toHaveAttribute('data-side', 'high');
    expect(getByTestId('bus-node-3')).toHaveAttribute('data-limit-side', 'high');

    act(() => {
      useAnimationStore
        .getState()
        .setBusOverlayForRun(
          'run-x',
          new Map([['3', { band: 'success', side: null, voltage: 1.0 }]]),
        );
    });
    expect(
      getByTestId('bus-node-3').querySelector('[data-testid="bus-limit-marker-3"]'),
    ).toBeNull();
  });
});

describe('BusNode — v0.2 streaming overlay (active run)', () => {
  beforeEach(resetStores);
  afterEach(() => {
    cleanup();
    resetStores();
  });

  it('uses the animation slice band when an active run has an overlay for this bus', () => {
    useRunsStore.setState({
      runs: {},
      activeRunId: 'run-x',
    });
    useAnimationStore
      .getState()
      .setBusOverlayForRun(
        'run-x',
        new Map([['7', { band: 'danger', side: 'low', voltage: 0.92 }]]),
      );
    const { getByTestId } = render(<BusNode {...nodeProps('7')} />);
    const node = getByTestId('bus-node-7');
    expect(node).toHaveAttribute('data-band', 'danger');
    expect(node).toHaveAttribute('data-streaming', 'true');
    expect(node.className).toContain('border-danger');
  });

  it('streaming overlay overrides the v0.1 PF-result band when both are present', () => {
    // Bus 3 was at success steady-state (PF), but mid-fault the streaming
    // overlay paints it red. The streaming layer wins.
    usePflowStore.setState({
      lastRun: makePflow({ bus_voltages: { '3': 1.0 }, bus_angles: { '3': 0 } }),
      isRunning: false,
      error: null,
    });
    useRunsStore.setState({ runs: {}, activeRunId: 'run-x' });
    useAnimationStore
      .getState()
      .setBusOverlayForRun(
        'run-x',
        new Map([['3', { band: 'danger', side: 'low', voltage: 0.85 }]]),
      );
    const { getByTestId } = render(<BusNode {...nodeProps('3')} />);
    const node = getByTestId('bus-node-3');
    expect(node).toHaveAttribute('data-band', 'danger');
    expect(node).toHaveAttribute('data-streaming', 'true');
    expect(node.className).toContain('border-danger');
  });

  it('falls back to PF-result coloring when active run has NO entry for this bus', () => {
    // Active run, but the overlay map only covers bus 1 — bus 2 should
    // render via the PF path (not via a stale streaming entry).
    usePflowStore.setState({
      lastRun: makePflow({
        bus_voltages: { '2': 0.94 },
        bus_angles: { '2': 0 },
      }),
      isRunning: false,
      error: null,
    });
    useRunsStore.setState({ runs: {}, activeRunId: 'run-x' });
    useAnimationStore
      .getState()
      .setBusOverlayForRun(
        'run-x',
        new Map([['1', { band: 'success', side: null, voltage: 1.0 }]]),
      );
    const { getByTestId } = render(<BusNode {...nodeProps('2')} />);
    const node = getByTestId('bus-node-2');
    expect(node).toHaveAttribute('data-band', 'danger');
    expect(node).not.toHaveAttribute('data-streaming');
    expect(node.className).toContain('border-danger');
  });

  it('reverts to the v0.1 path when the streaming overlay is cleared', () => {
    usePflowStore.setState({
      lastRun: makePflow({ bus_voltages: { '4': 1.0 }, bus_angles: { '4': 0 } }),
      isRunning: false,
      error: null,
    });
    useRunsStore.setState({ runs: {}, activeRunId: 'run-x' });
    useAnimationStore
      .getState()
      .setBusOverlayForRun(
        'run-x',
        new Map([['4', { band: 'warning', side: 'low', voltage: 0.96 }]]),
      );
    const { getByTestId, rerender } = render(<BusNode {...nodeProps('4')} />);
    expect(getByTestId('bus-node-4')).toHaveAttribute('data-band', 'warning');

    // Run finishes → overlay cleared.
    act(() => {
      useAnimationStore.getState().clearOverlayForRun('run-x');
    });
    rerender(<BusNode {...nodeProps('4')} />);
    const node = getByTestId('bus-node-4');
    expect(node).toHaveAttribute('data-band', 'success');
    expect(node).not.toHaveAttribute('data-streaming');
  });

  it('shows the v0.1 PF voltage label even when streaming overlay is active', () => {
    // The streaming layer paints color, but the PF labels (steady-state
    // numerical reading) remain visible. Numeric streaming labels are
    // deferred per the BusNode comment.
    usePflowStore.setState({
      lastRun: makePflow({ bus_voltages: { '8': 1.0 }, bus_angles: { '8': 0 } }),
      isRunning: false,
      error: null,
    });
    useRunsStore.setState({ runs: {}, activeRunId: 'run-x' });
    useAnimationStore
      .getState()
      .setBusOverlayForRun(
        'run-x',
        new Map([['8', { band: 'danger', side: 'low', voltage: 0.85 }]]),
      );
    const { getByTestId } = render(<BusNode {...nodeProps('8')} />);
    expect(getByTestId('bus-voltage-8')).toHaveTextContent('1.000 pu');
  });

  it('selective redraw: same band on next overlay → identical map ref → no setState', () => {
    // Verifies the slice's ``bandsEqual`` short-circuit. Render once,
    // capture the map ref, push an "equivalent" overlay (same bands,
    // different voltage), and assert the stored ref didn't change.
    useRunsStore.setState({ runs: {}, activeRunId: 'run-x' });
    useAnimationStore
      .getState()
      .setBusOverlayForRun(
        'run-x',
        new Map([['1', { band: 'success', side: null, voltage: 1.0 }]]),
      );
    const ref1 = useAnimationStore.getState().busOverlayByRun['run-x'];

    const { getByTestId } = render(<BusNode {...nodeProps('1')} />);
    expect(getByTestId('bus-node-1')).toHaveAttribute('data-band', 'success');

    useAnimationStore
      .getState()
      .setBusOverlayForRun(
        'run-x',
        new Map([['1', { band: 'success', side: null, voltage: 1.001 }]]),
      );
    const ref2 = useAnimationStore.getState().busOverlayByRun['run-x'];
    // No setState fired → BusNode subscriber didn't see a change → no
    // re-render. We assert the upstream invariant (no ref change) which
    // is what the React subscription depends on.
    expect(ref2).toBe(ref1);
  });

  it('re-renders to the new band when the band actually crosses a threshold', () => {
    useRunsStore.setState({ runs: {}, activeRunId: 'run-x' });
    useAnimationStore
      .getState()
      .setBusOverlayForRun(
        'run-x',
        new Map([['9', { band: 'success', side: null, voltage: 1.0 }]]),
      );
    const { getByTestId, rerender } = render(<BusNode {...nodeProps('9')} />);
    expect(getByTestId('bus-node-9')).toHaveAttribute('data-band', 'success');

    act(() => {
      useAnimationStore
        .getState()
        .setBusOverlayForRun(
          'run-x',
          new Map([['9', { band: 'warning', side: 'low', voltage: 0.96 }]]),
        );
    });
    rerender(<BusNode {...nodeProps('9')} />);
    expect(getByTestId('bus-node-9')).toHaveAttribute('data-band', 'warning');
    expect(getByTestId('bus-node-9').className).toContain('border-warning');
  });
});

describe('BusNode — Unit 19 voltage transition easing', () => {
  beforeEach(resetStores);
  afterEach(() => {
    cleanup();
    resetStores();
  });

  it('applies a CSS transition on the busbar fill with the cubic-out easing token', () => {
    // The band colour now lives on the busbar fill (background-color), so
    // the transition that carries the voltage-band change sits on the bar.
    const { getByTestId } = render(<BusNode {...nodeProps('1')} />);
    const transition = getByTestId('bus-bar-1').style.transition;
    expect(transition).toContain('background-color');
    expect(transition).toContain('var(--duration-base)');
    expect(transition).toContain('var(--ease-out-quart)');
  });

  it('keeps the transition style stable across band changes (so CSS interpolates it)', () => {
    // The transition CSS must not be re-keyed on band change — otherwise
    // the new value would land instantly without easing. We verify by
    // flipping the band and confirming the inline style string is the
    // same (the className mutates, the transition does not).
    useRunsStore.setState({ runs: {}, activeRunId: 'run-x' });
    useAnimationStore
      .getState()
      .setBusOverlayForRun(
        'run-x',
        new Map([['1', { band: 'success', side: null, voltage: 1.0 }]]),
      );
    const { getByTestId, rerender } = render(<BusNode {...nodeProps('1')} />);
    const transitionBefore = getByTestId('bus-bar-1').style.transition;

    act(() => {
      useAnimationStore
        .getState()
        .setBusOverlayForRun(
          'run-x',
          new Map([['1', { band: 'danger', side: 'low', voltage: 0.85 }]]),
        );
    });
    rerender(<BusNode {...nodeProps('1')} />);
    expect(getByTestId('bus-bar-1').style.transition).toBe(transitionBefore);
    expect(getByTestId('bus-node-1')).toHaveAttribute('data-band', 'danger');
  });
});

describe('BusNode — edge cases', () => {
  beforeEach(resetStores);
  afterEach(() => {
    cleanup();
    resetStores();
  });

  it('streaming overlay for a different runId does not bleed in', () => {
    // Active run is "run-x", but only "run-y" has an overlay. Bus
    // should render via PF path (or neutral if no PF).
    useRunsStore.setState({ runs: {}, activeRunId: 'run-x' });
    useAnimationStore
      .getState()
      .setBusOverlayForRun(
        'run-y',
        new Map([['1', { band: 'danger', side: 'low', voltage: 0.85 }]]),
      );
    const { getByTestId } = render(<BusNode {...nodeProps('1')} />);
    const node = getByTestId('bus-node-1');
    expect(node).toHaveAttribute('data-band', 'neutral');
    expect(node).not.toHaveAttribute('data-streaming');
  });

  it('no active run → no streaming overlay regardless of map contents', () => {
    useRunsStore.setState({ runs: {}, activeRunId: null });
    useAnimationStore
      .getState()
      .setBusOverlayForRun(
        'run-x',
        new Map([['1', { band: 'danger', side: 'low', voltage: 0.85 }]]),
      );
    const { getByTestId } = render(<BusNode {...nodeProps('1')} />);
    const node = getByTestId('bus-node-1');
    expect(node).toHaveAttribute('data-band', 'neutral');
    expect(node).not.toHaveAttribute('data-streaming');
  });
});

describe('BusNode, the bar and its taps', () => {
  beforeEach(resetStores);
  afterEach(() => {
    cleanup();
    resetStores();
  });

  /** The node's props with the bar the connection pass worked out for it. */
  function withBar(bar: {
    start: number;
    end: number;
    taps: { x: number; side: 'north' | 'east' | 'south' | 'west' }[];
  }): Parameters<typeof BusNode>[0] {
    const props = nodeProps('1', 'BUS1');
    return { ...props, data: { ...props.data, bar } } as Parameters<typeof BusNode>[0];
  }

  it('draws a bar of the default length, with no taps, when it is given none', () => {
    const { getByTestId, queryAllByTestId } = render(<BusNode {...nodeProps('1')} />);
    const bar = getByTestId('bus-bar-1');
    expect(bar.style.left).toBe('0px');
    expect(bar.style.width).toBe('92px');
    expect(bar).toHaveAttribute('data-bar-length', '92');
    expect(queryAllByTestId('bus-tap-1')).toHaveLength(0);
  });

  it('draws the bar as long as its taps need, out of both sides of the node', () => {
    const { getByTestId } = render(<BusNode {...withBar({ start: -6, end: 98, taps: [] })} />);
    const bar = getByTestId('bus-bar-1');
    expect(bar.style.left).toBe('-6px');
    expect(bar.style.width).toBe('104px');
    // The node's own box stays the width the layout knows.
    expect(getByTestId('bus-node-1').className).toContain('w-[92px]');
  });

  it('draws a dot on the bar at every tap, centred on its line', () => {
    const { getAllByTestId } = render(
      <BusNode
        {...withBar({
          start: 0,
          end: 92,
          taps: [
            { x: 13, side: 'north' },
            { x: 46, side: 'south' },
            { x: 89, side: 'east' },
          ],
        })}
      />,
    );
    const dots = getAllByTestId('bus-tap-1');
    expect(dots.map((dot) => dot.getAttribute('data-tap-x'))).toEqual(['13', '46', '89']);
    // 8 across, on the 6 thick bar: one pixel shows either side of it.
    const first = dots[0]!;
    expect(first.style.left).toBe('9px');
    expect(first.style.top).toBe('-1px');
    expect(first.style.width).toBe('8px');
    expect(first.style.height).toBe('8px');
  });

  it('draws one dot where a feeder above the bar and one below it share a tap', () => {
    const { getAllByTestId } = render(
      <BusNode
        {...withBar({
          start: 0,
          end: 92,
          taps: [
            { x: 46, side: 'north' },
            { x: 46, side: 'south' },
          ],
        })}
      />,
    );
    expect(getAllByTestId('bus-tap-1')).toHaveLength(1);
  });

  it('hangs the label under the middle of the bar while no feeder comes up through it', () => {
    const { getByTestId } = render(
      <BusNode {...withBar({ start: 0, end: 92, taps: [{ x: 46, side: 'north' }] })} />,
    );
    expect(getByTestId('bus-label-1').style.left).toBe('');
  });

  it('moves the label beside a feeder that lands under the middle of the bar', () => {
    const { getByTestId } = render(
      <BusNode {...withBar({ start: 0, end: 92, taps: [{ x: 46, side: 'south' }] })} />,
    );
    // "BUS1" with room for a limit marker beside it is taken as 6 characters,
    // 44 wide (`busLabelWidth`): its middle keeps 26 from the feeder.
    expect(getByTestId('bus-label-1').style.left).toBe('-26px');
  });

  it('hangs the label where the canvas says, along the bar', () => {
    const bare = withBar({ start: 0, end: 92, taps: [] });
    const { getByTestId } = render(
      <BusNode {...bare} data={{ ...bare.data, labelAt: { offset: 20, side: 'below' } }} />,
    );
    // 26 left of the middle of the bar, as beside a feeder of its own.
    const label = getByTestId('bus-label-1');
    expect(label.style.left).toBe('-26px');
    expect(label).not.toHaveAttribute('data-label-side');
  });

  it('stands the label over the bar when the canvas has no place for it under the bar', () => {
    const bare = withBar({ start: 0, end: 92, taps: [] });
    const { getByTestId } = render(
      <BusNode {...bare} data={{ ...bare.data, labelAt: { offset: 46, side: 'above' } }} />,
    );
    const label = getByTestId('bus-label-1');
    expect(label).toHaveAttribute('data-label-side', 'above');
    expect(label.className).toContain('bottom-full');
    // About the middle of the bar.
    expect(label.style.left).toBe('46px');
  });

  it('stands the label beside a tip of the bar, level with it', () => {
    const long = withBar({ start: -8, end: 100, taps: [] });
    const east = render(
      <BusNode {...long} data={{ ...long.data, labelAt: { offset: 140, side: 'east' } }} />,
    ).getByTestId('bus-label-1');
    expect(east).toHaveAttribute('data-label-side', 'east');
    // Its left edge a gap right of the tip, its middle at the height of the bar.
    expect(east.style.left).toBe('106px');
    expect(east.style.top).toBe('3px');
    expect(east.className).toContain('-translate-y-1/2');
    east.remove();
    const west = render(
      <BusNode {...long} data={{ ...long.data, labelAt: { offset: -50, side: 'west' } }} />,
    ).getAllByTestId('bus-label-1')[0]!;
    expect(west).toHaveAttribute('data-label-side', 'west');
    expect(west.style.left).toBe('-14px');
    expect(west.className).toContain('-translate-x-full');
  });

  it('stands the label away from the bar where the canvas found the nearest clear place', () => {
    const bare = withBar({ start: 0, end: 92, taps: [] });
    const { getByTestId } = render(
      <BusNode
        {...bare}
        data={{ ...bare.data, labelAt: { offset: 150, side: 'away', top: 54 } }}
      />,
    );
    const label = getByTestId('bus-label-1');
    expect(label).toHaveAttribute('data-label-side', 'away');
    // Its middle at the offset, its top edge where it was put.
    expect(label.style.left).toBe('150px');
    expect(label.style.top).toBe('54px');
    expect(label.className).toContain('-translate-x-1/2');
  });

  it('draws a dot for every tap: no two connections land at one place', () => {
    const { getAllByTestId } = render(
      <BusNode
        {...withBar({
          start: 0,
          end: 92,
          taps: [
            { x: 32, side: 'north' },
            { x: 46, side: 'south' },
            { x: 60, side: 'north' },
          ],
        })}
      />,
    );
    expect(getAllByTestId('bus-tap-1').map((dot) => dot.dataset.tapX)).toEqual(['32', '46', '60']);
  });

  it('makes room for the values a power flow adds to the label', () => {
    usePflowStore.setState({
      lastRun: makePflow({ bus_voltages: { '1': 1.0 }, bus_angles: { '1': 0 } }),
      isRunning: false,
      error: null,
    });
    const { getByTestId } = render(
      <BusNode {...withBar({ start: 0, end: 92, taps: [{ x: 46, side: 'south' }] })} />,
    );
    // With values the label is taken as 9 characters, 62 wide, whatever the
    // values are: its middle keeps 35 from the feeder.
    expect(getByTestId('bus-voltage-1').textContent).toBe('1.000 pu');
    expect(getByTestId('bus-label-1').style.left).toBe('-35px');
  });
});
