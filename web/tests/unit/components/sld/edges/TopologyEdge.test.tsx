/**
 * Unit 19 — TopologyEdge tests, focused on the LineFlowArrow integration.
 *
 * The repo previously didn't have a TopologyEdge test (smoke for the
 * stride / dot logic ran via SldCanvas integration). For Unit 19 we
 * add focused coverage of:
 *
 *  - Arrow only renders when the line has converged PF flow data.
 *  - Arrow direction follows the sign of P.
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
import type { PflowResult } from '@/api/types';

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
        'data-stroke-width': style?.strokeWidth,
      }),
    EdgeLabelRenderer: ({ children }: { children: ReactNode }) =>
      React.createElement('foreignObject', { 'data-testid': 'edge-label-portal' }, children),
    getSmoothStepPath: ({
      sourceX,
      sourceY,
      targetX,
      targetY,
    }: {
      sourceX: number;
      sourceY: number;
      targetX: number;
      targetY: number;
      sourcePosition?: string;
      targetPosition?: string;
      borderRadius?: number;
    }) => [
      `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`,
      (sourceX + targetX) / 2,
      (sourceY + targetY) / 2,
    ],
  };
});

import { TopologyEdge } from '@/components/sld/edges/TopologyEdge';
import { ARROW_MIN_SIZE, arrowSizeFromMw } from '@/components/sld/edges/lineFlowArrowMath';

interface RenderEdgeProps {
  id?: string;
  sourceX?: number;
  sourceY?: number;
  targetX?: number;
  targetY?: number;
  data?: {
    idx?: string;
    bucket?: 'line' | 'transformer';
    sourceSide?: 'north' | 'east' | 'south' | 'west';
    targetSide?: 'north' | 'east' | 'south' | 'west';
    sourceStride?: number;
    targetStride?: number;
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
    line_flows: { 'l-1': { p: linePMw, q: 0, from_idx: '1', to_idx: '2' } },
  };
  usePflowStore.setState({ lastRun: result, isRunning: false, error: null });
}

function reset(): void {
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useUiStore.setState({ hideLabels: false });
  cleanup();
}

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

  it('arrow size scales with |P| via the arrowSizeFromMw mapping', () => {
    setPflow(500);
    const { getByTestId } = renderEdge();
    const arrow = getByTestId('line-flow-arrow-edge-1');
    expect(arrow.getAttribute('data-arrow-size')).toBe(arrowSizeFromMw(500).toFixed(2));
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
