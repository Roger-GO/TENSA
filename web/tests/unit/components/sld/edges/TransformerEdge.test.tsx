/**
 * TransformerEdge — render-smoke + stride-offset honored + dot-render
 * smoke + flow-overlay smoke.
 *
 * Per the v0.1.y plan, this file is rendering smoke only — no
 * pixel-level assertions. We stub `BaseEdge` + `EdgeLabelRenderer` +
 * `getSmoothStepPath` so the component logic still runs without a
 * React Flow root context.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';

import { usePflowStore } from '@/store/pflow';
import { useUiStore } from '@/store/ui';

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
        'data-testid': 'transformer-edge-base',
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

// Stub the icon manifest so we don't load actual SVG files in jsdom.
vi.mock('@/icons/iec60617/manifest', () => ({
  iconForModel: (model: string) => `mock-icon-${model}.svg`,
}));

import { TransformerEdge } from '@/components/sld/edges/TransformerEdge';

interface RenderEdgeProps {
  id?: string;
  sourceX?: number;
  sourceY?: number;
  targetX?: number;
  targetY?: number;
  data?: {
    idx?: string;
    name?: string;
    sourceSide?: 'north' | 'east' | 'south' | 'west';
    targetSide?: 'north' | 'east' | 'south' | 'west';
    sourceStride?: number;
    targetStride?: number;
    bendPoints?: [number, number][];
    winding?: '2w' | '3w';
  };
}

function renderEdge(props: RenderEdgeProps = {}) {
  // EdgeProps is wide (Position is a string-literal union from
  // @xyflow/react); the runtime stub of the React Flow primitives
  // doesn't actually look at sourcePosition/targetPosition for the smoke
  // tests below, so we cast through `unknown` rather than reconstruct
  // the full type.
  const allProps = {
    id: props.id ?? 'tfm-edge-1',
    source: 'bus-1',
    target: 'bus-2',
    sourceX: props.sourceX ?? 0,
    sourceY: props.sourceY ?? 0,
    targetX: props.targetX ?? 100,
    targetY: props.targetY ?? 0,
    sourcePosition: 'right',
    targetPosition: 'left',
    data: props.data ?? {},
  } as unknown as ComponentProps<typeof TransformerEdge>;
  return render(
    <svg>
      <TransformerEdge {...allProps} />
    </svg>,
  );
}

beforeEach(() => {
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useUiStore.setState({ hideLabels: false });
});

describe('<TransformerEdge />', () => {
  it('renders a BaseEdge path between source and target', () => {
    const { getByTestId } = renderEdge();
    const base = getByTestId('transformer-edge-base');
    expect(base).toBeInTheDocument();
    expect(base.getAttribute('data-path')).toBe('M 0 0 L 100 0');
  });

  it('renders connection-dot circles at both endpoints', () => {
    const { container } = renderEdge();
    const circles = container.querySelectorAll('circle');
    // One dot per terminal = 2 circles.
    expect(circles.length).toBe(2);
  });

  it('renders the icon midpoint container with the 2w default winding', () => {
    const { getByTestId } = renderEdge({ id: 'tfm-1' });
    const icon = getByTestId('transformer-edge-icon-tfm-1');
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute('data-winding', '2w');
  });

  it('renders the 3w winding badge when winding="3w"', () => {
    const { getByTestId, getByText } = renderEdge({
      id: 'tfm-3w',
      data: { winding: '3w' },
    });
    const icon = getByTestId('transformer-edge-icon-tfm-3w');
    expect(icon).toHaveAttribute('data-winding', '3w');
    expect(getByText('3w')).toBeInTheDocument();
  });

  it('honors source/target stride offsets on north/south sides', () => {
    // Both ends shift +14 px on x with stride=1 / north side.
    const { getByTestId, container } = renderEdge({
      data: {
        sourceSide: 'north',
        sourceStride: 1,
        targetSide: 'north',
        targetStride: 1,
      },
    });
    const base = getByTestId('transformer-edge-base');
    // The path passes through the smoothStepPath stub which builds
    // `M sourceX sourceY L targetX targetY` from the shifted endpoints.
    expect(base.getAttribute('data-path')).toBe('M 14 0 L 114 0');
    // Connection-dot circles also land at the shifted positions.
    const circles = container.querySelectorAll('circle');
    expect(circles[0]?.getAttribute('cx')).toBe('14');
    expect(circles[1]?.getAttribute('cx')).toBe('114');
  });

  it('honors stride offsets on east/west sides as vertical shifts', () => {
    const { container } = renderEdge({
      data: {
        sourceSide: 'east',
        sourceStride: 1,
        targetSide: 'east',
        targetStride: 1,
      },
    });
    const circles = container.querySelectorAll('circle');
    // east side stride shifts y by +14.
    expect(circles[0]?.getAttribute('cy')).toBe('14');
    expect(circles[1]?.getAttribute('cy')).toBe('14');
  });

  it('builds a polyline path when bendPoints are supplied', () => {
    const { getByTestId } = renderEdge({
      data: {
        bendPoints: [
          [0, 0],
          [50, 0],
          [50, 50],
          [100, 50],
        ],
      },
    });
    const base = getByTestId('transformer-edge-base');
    // The polyline string assembles M / L commands per the runtime
    // implementation. Asserting on a substring keeps this loosely
    // coupled to the exact spacing.
    const path = base.getAttribute('data-path') ?? '';
    expect(path).toContain('M0,0');
    expect(path).toContain('L50,0');
    expect(path).toContain('L50,50');
    expect(path).toContain('L100,50');
  });

  it('uses the muted border stroke when no PF data exists', () => {
    const { getByTestId } = renderEdge({
      data: { idx: 'L1' },
    });
    const base = getByTestId('transformer-edge-base');
    expect(base.getAttribute('data-stroke')).toBe('var(--color-border)');
    // Stroke width matches the no-data branch (1.5px).
    expect(base.getAttribute('data-stroke-width')).toBe('1.5');
  });

  it('falls back gracefully when data is undefined (default 2w winding)', () => {
    const { getByTestId } = renderEdge({ id: 'tfm-empty' });
    expect(getByTestId('transformer-edge-icon-tfm-empty')).toHaveAttribute('data-winding', '2w');
  });
});
