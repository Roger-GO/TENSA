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
import { parseRunId } from '@/api/types';
import type { PflowResult } from '@/api/types';

function nodeProps(idx: string, name = `b${idx}`): Parameters<typeof BusNode>[0] {
  // Minimal NodeProps shape; the component only reads `data` + `selected`.
  return {
    id: idx,
    data: { idx, name, kind: 'Bus' },
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
      .setBusOverlayForRun('run-x', new Map([['7', { band: 'danger', voltage: 0.92 }]]));
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
      .setBusOverlayForRun('run-x', new Map([['3', { band: 'danger', voltage: 0.85 }]]));
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
      .setBusOverlayForRun('run-x', new Map([['1', { band: 'success', voltage: 1.0 }]]));
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
      .setBusOverlayForRun('run-x', new Map([['4', { band: 'warning', voltage: 0.96 }]]));
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
      .setBusOverlayForRun('run-x', new Map([['8', { band: 'danger', voltage: 0.85 }]]));
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
      .setBusOverlayForRun('run-x', new Map([['1', { band: 'success', voltage: 1.0 }]]));
    const ref1 = useAnimationStore.getState().busOverlayByRun['run-x'];

    const { getByTestId } = render(<BusNode {...nodeProps('1')} />);
    expect(getByTestId('bus-node-1')).toHaveAttribute('data-band', 'success');

    useAnimationStore
      .getState()
      .setBusOverlayForRun('run-x', new Map([['1', { band: 'success', voltage: 1.001 }]]));
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
      .setBusOverlayForRun('run-x', new Map([['9', { band: 'success', voltage: 1.0 }]]));
    const { getByTestId, rerender } = render(<BusNode {...nodeProps('9')} />);
    expect(getByTestId('bus-node-9')).toHaveAttribute('data-band', 'success');

    act(() => {
      useAnimationStore
        .getState()
        .setBusOverlayForRun('run-x', new Map([['9', { band: 'warning', voltage: 0.96 }]]));
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
      .setBusOverlayForRun('run-x', new Map([['1', { band: 'success', voltage: 1.0 }]]));
    const { getByTestId, rerender } = render(<BusNode {...nodeProps('1')} />);
    const transitionBefore = getByTestId('bus-bar-1').style.transition;

    act(() => {
      useAnimationStore
        .getState()
        .setBusOverlayForRun('run-x', new Map([['1', { band: 'danger', voltage: 0.85 }]]));
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
      .setBusOverlayForRun('run-y', new Map([['1', { band: 'danger', voltage: 0.85 }]]));
    const { getByTestId } = render(<BusNode {...nodeProps('1')} />);
    const node = getByTestId('bus-node-1');
    expect(node).toHaveAttribute('data-band', 'neutral');
    expect(node).not.toHaveAttribute('data-streaming');
  });

  it('no active run → no streaming overlay regardless of map contents', () => {
    useRunsStore.setState({ runs: {}, activeRunId: null });
    useAnimationStore
      .getState()
      .setBusOverlayForRun('run-x', new Map([['1', { band: 'danger', voltage: 0.85 }]]));
    const { getByTestId } = render(<BusNode {...nodeProps('1')} />);
    const node = getByTestId('bus-node-1');
    expect(node).toHaveAttribute('data-band', 'neutral');
    expect(node).not.toHaveAttribute('data-streaming');
  });
});
