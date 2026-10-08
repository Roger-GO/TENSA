/**
 * TopologyEdge tests: the line it draws, and the flow arrow and label it
 * carries after a power flow.
 *
 *  - The path runs through the points of the route `connections.ts` gave
 *    the edge, with square corners, and falls back to the two handles when
 *    the edge has no route. The same component draws a line that keeps a
 *    stored route (edge type `routed`).
 *  - Arrow only renders when the line has converged PF flow data.
 *  - Arrow direction follows the sign of P, and lies along the run it is on.
 *  - Arrow size scales with |P|.
 *
 * @xyflow/react primitives are stubbed in the same shape as the
 * sibling TransformerEdge / StubEdge tests so the component logic
 * runs without a real React Flow graph.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';

import { usePflowStore } from '@/store/pflow';
import { useUiStore } from '@/store/ui';
import { parseRunId } from '@/api/types';
import type { LineFlow, PflowResult } from '@/api/types';
import { lineFlow } from '../../../helpers/lineFlow';

vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    BaseEdge: ({
      path,
      style,
    }: {
      path: string;
      markerEnd?: string;
      style: Record<string, unknown>;
    }) =>
      React.createElement('path', {
        'data-testid': 'topology-edge-base',
        'data-path': path,
        'data-stroke': style?.stroke,
        'data-stroke-dasharray': style?.strokeDasharray,
        'data-stroke-width': style?.strokeWidth,
      }),
    EdgeLabelRenderer: ({ children }: { children: ReactNode }) =>
      React.createElement('foreignObject', { 'data-testid': 'edge-label-portal' }, children),
  };
});

import { TopologyEdge } from '@/components/sld/edges/TopologyEdge';
import type { ConnectorRoute, LabelPlace } from '@/components/sld/connections';
import {
  ARROW_MAX_SIZE,
  ARROW_MIN_SIZE,
  arrowSizeFromMw,
} from '@/components/sld/edges/lineFlowArrowMath';

interface RenderEdgeProps {
  id?: string;
  sourceX?: number;
  sourceY?: number;
  targetX?: number;
  targetY?: number;
  data?: {
    idx?: string;
    bucket?: 'line' | 'transformer';
    route?: ConnectorRoute;
    labelAt?: LabelPlace;
    draft?: boolean;
    ready?: boolean;
    active?: boolean;
  };
}

function renderEdge(props: RenderEdgeProps = {}) {
  const allProps = {
    id: props.id ?? 'edge-1',
    source: 'b1',
    target: 'b2',
    sourceX: props.sourceX ?? 0,
    sourceY: props.sourceY ?? 0,
    targetX: props.targetX ?? 100,
    targetY: props.targetY ?? 0,
    sourcePosition: 'right',
    targetPosition: 'left',
    data: props.data ?? { bucket: 'line', idx: 'l-1' },
  } as unknown as ComponentProps<typeof TopologyEdge>;
  return render(
    <svg>
      <TopologyEdge {...allProps} />
    </svg>,
  );
}

function setPflow(linePMw: number, converged = true): void {
  const result: PflowResult = {
    run_id: parseRunId('pf-1'),
    converged,
    iterations: 4,
    mismatch: 1e-6,
    bus_voltages: { '1': 1.0, '2': 1.0 },
    bus_angles: { '1': 0, '2': 0 },
    line_flows: { 'l-1': lineFlow(linePMw, 0, { from: '1', to: '2' }) },
  };
  usePflowStore.setState({ lastRun: result, isRunning: false, error: null });
}

/** A converged PF result whose lines carry the given active powers (MW), by idx. */
function setPflowLines(pByLine: Record<string, number>): void {
  const result: PflowResult = {
    run_id: parseRunId('pf-1'),
    converged: true,
    iterations: 4,
    mismatch: 1e-6,
    bus_voltages: { '1': 1.0, '2': 1.0 },
    bus_angles: { '1': 0, '2': 0 },
    line_flows: Object.fromEntries(
      Object.entries(pByLine).map(([idx, p]) => [idx, lineFlow(p, 0, { from: '1', to: '2' })]),
    ),
  };
  usePflowStore.setState({ lastRun: result, isRunning: false, error: null });
}

function reset(): void {
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useUiStore.setState({ hideLabels: false });
  cleanup();
}

/** A route down from one bar, across, and down onto another. */
const STEPPED: ConnectorRoute = {
  points: [
    [89, 3],
    [89, 103],
    [153, 103],
    [153, 203],
  ],
  sourceSide: 'south',
  targetSide: 'north',
};

describe('<TopologyEdge /> the line', () => {
  beforeEach(reset);

  it('draws through the points of its route, with square corners', () => {
    const { getByTestId } = renderEdge({ data: { bucket: 'line', idx: 'l-1', route: STEPPED } });
    expect(getByTestId('topology-edge-base').getAttribute('data-path')).toBe(
      'M89,3 L89,103 L153,103 L153,203',
    );
  });

  it('falls back to a line between the two handles when it has no route', () => {
    const { getByTestId } = renderEdge({ sourceX: 5, sourceY: 6, targetX: 70, targetY: 80 });
    expect(getByTestId('topology-edge-base').getAttribute('data-path')).toBe('M5,6 L70,80');
  });

  it('draws no dot of its own: the bar marks every tap', () => {
    const { container } = renderEdge({ data: { bucket: 'line', idx: 'l-1', route: STEPPED } });
    expect(container.querySelectorAll('circle')).toHaveLength(0);
  });

  it('puts the flow label half way along the route', () => {
    setPflow(120);
    const { getByTestId } = renderEdge({ data: { bucket: 'line', idx: 'l-1', route: STEPPED } });
    // 100 down, 64 across, 100 down: half way is the middle of the run across.
    expect(getByTestId('line-flow-label-edge-1').style.transform).toContain(
      'translate(121px, 103px)',
    );
  });

  it('puts the flow label and the arrow where the canvas found room for them, when it says where', () => {
    setPflow(120);
    const { getByTestId } = renderEdge({
      data: {
        bucket: 'line',
        idx: 'l-1',
        route: STEPPED,
        // On the first run down, clear of the bend half way along.
        labelAt: { x: 89, y: 40, angleDeg: 90 },
      },
    });
    expect(getByTestId('line-flow-label-edge-1').style.transform).toContain(
      'translate(89px, 40px)',
    );
    expect(getByTestId('line-flow-arrow-edge-1').style.transform).toBe(
      'translate(89px, 40px) rotate(90deg)',
    );
  });

  it('stands the flow label beside the line where the canvas found no room on it, and leaves the arrow on the line', () => {
    setPflow(120);
    const beside = (side: 'left' | 'right' | 'above' | 'below', x: number, y: number) =>
      renderEdge({
        data: {
          bucket: 'line',
          idx: 'l-1',
          route: STEPPED,
          labelAt: { x: 89, y: 40, angleDeg: 90, label: { x, y, side } },
        },
      });
    // Left of the run down: hung by its right edge, 6 from the line.
    const left = beside('left', 83, 40);
    const label = left.getByTestId('line-flow-label-edge-1');
    expect(label).toHaveAttribute('data-beside', 'left');
    expect(label.style.transform).toBe('translate(-100%, -50%) translate(83px, 40px)');
    expect(left.getByTestId('line-flow-arrow-edge-1').style.transform).toBe(
      'translate(89px, 40px) rotate(90deg)',
    );
    cleanup();
    expect(beside('right', 95, 40).getByTestId('line-flow-label-edge-1').style.transform).toBe(
      'translate(0, -50%) translate(95px, 40px)',
    );
    cleanup();
    expect(beside('above', 121, 97).getByTestId('line-flow-label-edge-1').style.transform).toBe(
      'translate(-50%, -100%) translate(121px, 97px)',
    );
    cleanup();
    expect(beside('below', 121, 109).getByTestId('line-flow-label-edge-1').style.transform).toBe(
      'translate(-50%, 0) translate(121px, 109px)',
    );
    cleanup();
    // On the line it is hung by its middle, and says nothing of a side.
    const on = renderEdge({
      data: { bucket: 'line', idx: 'l-1', route: STEPPED, labelAt: { x: 89, y: 40, angleDeg: 90 } },
    }).getByTestId('line-flow-label-edge-1');
    expect(on).not.toHaveAttribute('data-beside');
    expect(on.style.transform).toBe('translate(-50%, -50%) translate(89px, 40px)');
  });

  it('lays the arrow along the run it sits on, pointing the way the power flows', () => {
    const down: ConnectorRoute = {
      points: [
        [46, 3],
        [46, 203],
      ],
      sourceSide: 'south',
      targetSide: 'north',
    };
    setPflow(120);
    const forward = renderEdge({ data: { bucket: 'line', idx: 'l-1', route: down } });
    expect(forward.getByTestId('line-flow-arrow-edge-1').style.transform).toContain(
      'translate(46px, 103px) rotate(90deg)',
    );
    cleanup();
    setPflow(-120);
    const reverse = renderEdge({ data: { bucket: 'line', idx: 'l-1', route: down } });
    expect(reverse.getByTestId('line-flow-arrow-edge-1').style.transform).toContain(
      'rotate(270deg)',
    );
  });
});

describe('<TopologyEdge /> — Unit 19 line-flow arrow integration', () => {
  beforeEach(reset);

  it('does not render the arrow when there is no PF result', () => {
    const { queryByTestId } = renderEdge();
    expect(queryByTestId('line-flow-arrow-edge-1')).toBeNull();
  });

  it('does not render the arrow for non-line buckets (transformer routes through TransformerEdge)', () => {
    setPflow(120);
    const { queryByTestId } = renderEdge({
      data: { bucket: 'transformer', idx: 'l-1' },
    });
    expect(queryByTestId('line-flow-arrow-edge-1')).toBeNull();
  });

  it('renders an arrow with forward direction when P > 0', () => {
    setPflow(120);
    const { getByTestId } = renderEdge();
    const arrow = getByTestId('line-flow-arrow-edge-1');
    expect(arrow.getAttribute('data-direction')).toBe('forward');
  });

  it('renders an arrow with reverse direction when P < 0', () => {
    setPflow(-80);
    const { getByTestId } = renderEdge();
    const arrow = getByTestId('line-flow-arrow-edge-1');
    expect(arrow.getAttribute('data-direction')).toBe('reverse');
  });

  it('does not render the arrow when P is exactly zero (neutral)', () => {
    setPflow(0);
    const { queryByTestId } = renderEdge();
    expect(queryByTestId('line-flow-arrow-edge-1')).toBeNull();
  });

  it('does not render the arrow when the PF run did not converge', () => {
    setPflow(150, false);
    const { queryByTestId } = renderEdge();
    expect(queryByTestId('line-flow-arrow-edge-1')).toBeNull();
  });

  it('arrow size scales with |P| via the arrowSizeFromMw mapping, against the case maximum', () => {
    // Two lines: this one carries 500 MW, the other (not drawn here) 1000 MW.
    setPflowLines({ 'l-1': 500, 'l-2': 1000 });
    const { getByTestId } = renderEdge();
    const arrow = getByTestId('line-flow-arrow-edge-1');
    expect(arrow.getAttribute('data-arrow-size')).toBe(arrowSizeFromMw(500, 1000).toFixed(2));
  });

  it('draws the case largest flow at the maximum size, however small the case is', () => {
    // A 100 MVA case: its biggest flow is 150 MW. Against a fixed 1000 MW scale this
    // arrow was 8.2 px, barely bigger than the 7 px of a line with no flow at all.
    setPflowLines({ 'l-1': 150, 'l-2': 60 });
    const { getByTestId } = renderEdge();
    expect(getByTestId('line-flow-arrow-edge-1').getAttribute('data-arrow-size')).toBe(
      ARROW_MAX_SIZE.toFixed(2),
    );
  });

  it('draws a flow in proportion to the case largest, so a smaller one gets a smaller arrow', () => {
    setPflowLines({ 'l-1': 75, 'l-2': -150 });
    const { getByTestId } = renderEdge();
    expect(getByTestId('line-flow-arrow-edge-1').getAttribute('data-arrow-size')).toBe(
      ((ARROW_MIN_SIZE + ARROW_MAX_SIZE) / 2).toFixed(2),
    );
  });

  it('clamps arrow size at the minimum for small |P|', () => {
    setPflow(0.0001);
    const { getByTestId } = renderEdge();
    const arrow = getByTestId('line-flow-arrow-edge-1');
    const reported = parseFloat(arrow.getAttribute('data-arrow-size') ?? '0');
    expect(reported).toBeGreaterThanOrEqual(ARROW_MIN_SIZE);
  });

  it('arrow direction does not flip on a magnitude-only re-render (sign preserved)', () => {
    // Plan's "rapid TDS streaming → animations don't pile up" scenario
    // for the line edge: if only the magnitude ticks, the direction
    // attribute stays put so CSS doesn't re-trigger the rotation.
    setPflow(100);
    const { getByTestId, rerender } = renderEdge();
    const arrow = getByTestId('line-flow-arrow-edge-1');
    expect(arrow.getAttribute('data-direction')).toBe('forward');

    act(() => {
      setPflow(150);
    });
    rerender(
      <svg>
        <TopologyEdge
          {...({
            id: 'edge-1',
            source: 'b1',
            target: 'b2',
            sourceX: 0,
            sourceY: 0,
            targetX: 100,
            targetY: 0,
            sourcePosition: 'right',
            targetPosition: 'left',
            data: { bucket: 'line', idx: 'l-1' },
          } as unknown as ComponentProps<typeof TopologyEdge>)}
        />
      </svg>,
    );
    const arrowAfter = getByTestId('line-flow-arrow-edge-1');
    expect(arrowAfter.getAttribute('data-direction')).toBe('forward');
  });
});

/** A converged PF result with the one line `l-1` carrying `flow`. */
function setPflowFlow(flow: LineFlow): void {
  const result: PflowResult = {
    run_id: parseRunId('pf-1'),
    converged: true,
    iterations: 4,
    mismatch: 1e-6,
    bus_voltages: { '1': 1.0, '2': 1.0 },
    bus_angles: { '1': 0, '2': 0 },
    line_flows: { 'l-1': flow },
  };
  usePflowStore.setState({ lastRun: result, isRunning: false, error: null });
}

describe('<TopologyEdge /> line loading', () => {
  beforeEach(reset);

  it('draws a line over its rating red and heavy, with its loading on the label', () => {
    setPflowFlow(lineFlow(112, 8, undefined, { rate_a: 100, loading_pct: 112.4 }));
    const { getByTestId } = renderEdge();
    const base = getByTestId('topology-edge-base');
    expect(base.getAttribute('data-stroke')).toBe('var(--color-danger)');
    expect(base.getAttribute('data-stroke-width')).toBe('3');
    const label = getByTestId('line-flow-label-edge-1');
    expect(label.getAttribute('data-loading-band')).toBe('danger');
    expect(label.className).toContain('border-danger');
    expect(getByTestId('line-loading-edge-1').textContent).toBe('112.4%');
  });

  it('draws a line near its rating amber', () => {
    setPflowFlow(lineFlow(85, 5, undefined, { rate_a: 100, loading_pct: 85 }));
    const { getByTestId } = renderEdge();
    expect(getByTestId('topology-edge-base').getAttribute('data-stroke')).toBe(
      'var(--color-warning)',
    );
    expect(getByTestId('line-flow-label-edge-1').getAttribute('data-loading-band')).toBe('warning');
    expect(getByTestId('line-loading-edge-1').textContent).toBe('85.0%');
  });

  it('keeps a lightly loaded rated line in the normal colour and still shows its loading', () => {
    setPflowFlow(lineFlow(20, 2, undefined, { rate_a: 100, loading_pct: 20.2 }));
    const { getByTestId } = renderEdge();
    const base = getByTestId('topology-edge-base');
    expect(base.getAttribute('data-stroke')).toBe('var(--color-foreground)');
    expect(base.getAttribute('data-stroke-width')).toBe('1.8');
    expect(getByTestId('line-loading-edge-1').textContent).toBe('20.2%');
  });

  it('shows no loading and no colour for a line the case gives no rating', () => {
    setPflowFlow(lineFlow(500, 5));
    const { getByTestId, queryByTestId } = renderEdge();
    expect(getByTestId('topology-edge-base').getAttribute('data-stroke')).toBe(
      'var(--color-foreground)',
    );
    expect(queryByTestId('line-loading-edge-1')).toBeNull();
    expect(getByTestId('line-flow-label-edge-1').getAttribute('data-loading-band')).toBe('neutral');
  });

  it('turns the label to read along an upright run when the canvas found it room only that way', () => {
    setPflowFlow(lineFlow(120, 10));
    const route: ConnectorRoute = {
      points: [
        [50, 0],
        [50, 200],
      ],
      sourceSide: 'south',
      targetSide: 'north',
    };
    const upright = renderEdge({
      data: {
        bucket: 'line',
        idx: 'l-1',
        route,
        labelAt: { x: 50, y: 100, angleDeg: 90, turned: true },
      },
    });
    const turned = upright.getByTestId('line-flow-label-edge-1');
    expect(turned).toHaveAttribute('data-turned', 'true');
    expect(turned.style.transform).toContain('translate(50px, 100px)');
    expect(turned.style.transform).toMatch(/rotate\(-90deg\)$/);
    cleanup();

    const level = renderEdge({
      data: { bucket: 'line', idx: 'l-1', route, labelAt: { x: 50, y: 100, angleDeg: 90 } },
    });
    const plain = level.getByTestId('line-flow-label-edge-1');
    expect(plain).not.toHaveAttribute('data-turned');
    expect(plain.style.transform).not.toContain('rotate');
  });

  it('leaves the label off where the canvas found it no place, and keeps the arrow and the colour', () => {
    setPflowFlow(lineFlow(112, 8, undefined, { rate_a: 100, loading_pct: 112.4 }));
    const { queryByTestId, getByTestId } = renderEdge({
      data: { bucket: 'line', idx: 'l-1', labelAt: { x: 50, y: 0, angleDeg: 0, hidden: true } },
    });
    expect(queryByTestId('line-flow-label-edge-1')).toBeNull();
    // The line still shows that it is over its rating.
    expect(getByTestId('topology-edge-base').getAttribute('data-stroke')).not.toBe(
      'var(--color-foreground)',
    );
  });

  it('keeps the loading of a flagged line when the labels are hidden, and drops the rest', () => {
    useUiStore.setState({ hideLabels: true });
    setPflowFlow(lineFlow(112, 8, undefined, { rate_a: 100, loading_pct: 112.4 }));
    const flagged = renderEdge();
    expect(flagged.getByTestId('line-loading-edge-1').textContent).toBe('112.4%');
    expect(flagged.container.textContent).not.toContain('MW');
    cleanup();

    setPflowFlow(lineFlow(20, 2, undefined, { rate_a: 100, loading_pct: 20.2 }));
    const quiet = renderEdge();
    expect(quiet.queryByTestId('line-flow-label-edge-1')).toBeNull();
  });
});

describe('<TopologyEdge /> for a draft', () => {
  beforeEach(() => {
    usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  });

  it('is dashed, in the colour of the badge of its draft, where a line of the system is solid', () => {
    const plain = renderEdge();
    expect(
      plain.getByTestId('topology-edge-base').getAttribute('data-stroke-dasharray'),
    ).toBeNull();
    plain.unmount();
    const draft = renderEdge({ data: { draft: true, ready: false } });
    const base = draft.getByTestId('topology-edge-base');
    expect(base.getAttribute('data-stroke')).toBe('var(--color-warning)');
    expect(base.getAttribute('data-stroke-dasharray')).toBe('6 4');
    draft.unmount();
    const ready = renderEdge({ data: { draft: true, ready: true } });
    expect(ready.getByTestId('topology-edge-base').getAttribute('data-stroke')).toBe(
      'var(--color-success)',
    );
    ready.unmount();
    const picked = renderEdge({ data: { draft: true, ready: true, active: true } });
    expect(picked.getByTestId('topology-edge-base').getAttribute('data-stroke')).toBe(
      'var(--color-primary)',
    );
  });

  it('carries no flow: it is not in the system the power flow ran on', () => {
    setPflow(40);
    const { queryByTestId } = renderEdge({ id: 'draft-line-draft-1', data: { draft: true } });
    expect(queryByTestId('line-flow-label-draft-line-draft-1')).toBeNull();
    expect(queryByTestId('line-flow-arrow-draft-line-draft-1')).toBeNull();
  });
});
