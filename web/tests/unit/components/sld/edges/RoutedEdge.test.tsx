/**
 * RoutedEdge tests, focused on the size of its line-flow arrow. The arrow is
 * sized against the largest branch flow of the case, exactly as TopologyEdge's
 * is (see TopologyEdge.test.tsx); this edge draws the polyline ELK routed.
 *
 * @xyflow/react primitives are stubbed like the sibling edge tests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';

import { usePflowStore } from '@/store/pflow';
import { useUiStore } from '@/store/ui';
import { parseRunId } from '@/api/types';
import type { LineFlow, PflowResult } from '@/api/types';
import { lineFlow } from '../../../helpers/lineFlow';

vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    BaseEdge: ({ path, style }: { path: string; style?: Record<string, unknown> }) =>
      React.createElement('path', {
        'data-testid': 'routed-edge-base',
        'data-path': path,
        'data-stroke': style?.stroke,
        'data-stroke-width': style?.strokeWidth,
      }),
    EdgeLabelRenderer: ({ children }: { children: ReactNode }) =>
      React.createElement('foreignObject', null, children),
  };
});

import { RoutedEdge } from '@/components/sld/edges/RoutedEdge';
import { ARROW_MAX_SIZE, arrowSizeFromMw } from '@/components/sld/edges/lineFlowArrowMath';

function renderEdge() {
  const props = {
    id: 'edge-1',
    source: 'b1',
    target: 'b2',
    sourceX: 0,
    sourceY: 0,
    targetX: 100,
    targetY: 0,
    data: {
      bucket: 'line',
      idx: 'l-1',
      bendPoints: [
        [0, 0],
        [50, 0],
        [100, 0],
      ],
    },
  } as unknown as ComponentProps<typeof RoutedEdge>;
  return render(
    <svg>
      <RoutedEdge {...props} />
    </svg>,
  );
}

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

describe('<RoutedEdge /> line-flow arrow', () => {
  beforeEach(() => {
    cleanup();
    usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
    useUiStore.setState({ hideLabels: false });
  });

  it('has no arrow before a power flow has run', () => {
    const { queryByTestId } = renderEdge();
    expect(queryByTestId('line-flow-arrow-edge-1')).toBeNull();
  });

  it('draws the case largest flow at the maximum size, however small the case is', () => {
    setPflowLines({ 'l-1': 150, 'l-2': 60 });
    const { getByTestId } = renderEdge();
    expect(getByTestId('line-flow-arrow-edge-1').getAttribute('data-arrow-size')).toBe(
      ARROW_MAX_SIZE.toFixed(2),
    );
  });

  it('draws a smaller flow in proportion to the case largest', () => {
    setPflowLines({ 'l-1': 40, 'l-2': -160 });
    const { getByTestId } = renderEdge();
    expect(getByTestId('line-flow-arrow-edge-1').getAttribute('data-arrow-size')).toBe(
      arrowSizeFromMw(40, 160).toFixed(2),
    );
  });
});

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

describe('<RoutedEdge /> line loading', () => {
  beforeEach(() => {
    cleanup();
    usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
    useUiStore.setState({ hideLabels: false });
  });

  it('draws a line over its rating red and heavy, with its loading on the label', () => {
    setPflowFlow(lineFlow(112, 8, undefined, { rate_a: 100, loading_pct: 112.4 }));
    const { getByTestId } = renderEdge();
    const base = getByTestId('routed-edge-base');
    expect(base.getAttribute('data-stroke')).toBe('var(--color-danger)');
    expect(base.getAttribute('data-stroke-width')).toBe('3');
    expect(getByTestId('line-flow-label-edge-1').getAttribute('data-loading-band')).toBe('danger');
    expect(getByTestId('line-loading-edge-1').textContent).toBe('112.4%');
  });

  it('draws a line near its rating amber and an unrated line in the normal colour', () => {
    setPflowFlow(lineFlow(85, 5, undefined, { rate_a: 100, loading_pct: 85 }));
    const warned = renderEdge();
    expect(warned.getByTestId('routed-edge-base').getAttribute('data-stroke')).toBe(
      'var(--color-warning)',
    );
    cleanup();

    setPflowFlow(lineFlow(500, 5));
    const unrated = renderEdge();
    expect(unrated.getByTestId('routed-edge-base').getAttribute('data-stroke')).toBe(
      'var(--color-foreground)',
    );
    expect(unrated.queryByTestId('line-loading-edge-1')).toBeNull();
  });
});
