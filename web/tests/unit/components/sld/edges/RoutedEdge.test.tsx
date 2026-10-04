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
import type { PflowResult } from '@/api/types';

vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    BaseEdge: ({ path }: { path: string }) =>
      React.createElement('path', { 'data-testid': 'routed-edge-base', 'data-path': path }),
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
      Object.entries(pByLine).map(([idx, p]) => [idx, { p, q: 0, from_idx: '1', to_idx: '2' }]),
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
