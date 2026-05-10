/**
 * StubEdge — render-smoke + stride-offset honored + dot-render smoke.
 *
 * Edge components are inherently visual (they emit paths inside SVG);
 * these tests stub the @xyflow/react `BaseEdge` to a thin pass-through
 * that exposes the path string + style as DOM attributes so we can
 * assert against them without a real React Flow graph.
 *
 * Per the v0.1.y plan, this file is rendering smoke only — no
 * pixel-level assertions.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';

// Stub BaseEdge to expose the path string for assertion. We keep
// `getStraightPath` deterministic (returns the same shape the real
// implementation does) so the StubEdge logic still runs.
vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    BaseEdge: ({
      path,
      style,
    }: {
      path: string;
      style: Record<string, unknown>;
      children?: ReactNode;
    }) =>
      React.createElement('path', {
        'data-testid': 'stub-edge-base',
        'data-path': path,
        'data-stroke': style?.stroke,
        'data-stroke-dasharray': style?.strokeDasharray,
        'data-stroke-width': style?.strokeWidth,
      }),
    getStraightPath: ({
      sourceX,
      sourceY,
      targetX,
      targetY,
    }: {
      sourceX: number;
      sourceY: number;
      targetX: number;
      targetY: number;
    }) => [`M ${sourceX} ${sourceY} L ${targetX} ${targetY}`, 0, 0],
  };
});

import { StubEdge } from '@/components/sld/edges/StubEdge';

interface RenderEdgeProps {
  sourceX?: number;
  sourceY?: number;
  targetX?: number;
  targetY?: number;
  data?: {
    busSide?: 'north' | 'east' | 'south' | 'west';
    targetStride?: number;
    bucket?: 'generator' | 'load' | 'shunt';
    kind?: string;
  };
}

function renderEdge(props: RenderEdgeProps = {}) {
  // EdgeProps is wide (Position is a string-literal union from
  // @xyflow/react); the runtime stub of the React Flow primitives
  // doesn't actually look at sourcePosition/targetPosition for StubEdge,
  // so we cast through `unknown` rather than reconstruct the full type.
  const allProps = {
    id: 'stub-edge-1',
    source: 'gen-1',
    target: 'bus-1',
    sourceX: props.sourceX ?? 0,
    sourceY: props.sourceY ?? 0,
    targetX: props.targetX ?? 100,
    targetY: props.targetY ?? 0,
    sourcePosition: 'bottom',
    targetPosition: 'top',
    data: props.data ?? {},
  } as unknown as ComponentProps<typeof StubEdge>;
  return render(
    <svg>
      <StubEdge {...allProps} />
    </svg>,
  );
}

describe('<StubEdge />', () => {
  it('renders a BaseEdge path connecting source to target', () => {
    const { getByTestId } = renderEdge();
    const base = getByTestId('stub-edge-base');
    expect(base).toBeInTheDocument();
    expect(base.getAttribute('data-path')).toBe('M 0 0 L 100 0');
  });

  it('renders the connection-dot circle at the target end', () => {
    const { container } = renderEdge();
    // The component emits one foreground circle at the bus end.
    const circles = container.querySelectorAll('circle');
    expect(circles.length).toBe(1);
    // No stride / no shift → the dot lands at (targetX, targetY).
    expect(circles[0]?.getAttribute('cx')).toBe('100');
    expect(circles[0]?.getAttribute('cy')).toBe('0');
  });

  it('uses a dashed muted-foreground stroke for the stub line', () => {
    const { getByTestId } = renderEdge();
    const base = getByTestId('stub-edge-base');
    expect(base.getAttribute('data-stroke')).toBe('var(--color-muted-foreground)');
    expect(base.getAttribute('data-stroke-dasharray')).toBe('4 3');
  });

  it('applies a horizontal stride offset on north/south sides', () => {
    // stride=1, side=north → +14 px on x; the circle should land at
    // (114, 0) not (100, 0).
    const { container } = renderEdge({
      data: { busSide: 'north', targetStride: 1 },
    });
    const circle = container.querySelector('circle');
    expect(circle?.getAttribute('cx')).toBe('114');
    expect(circle?.getAttribute('cy')).toBe('0');
  });

  it('applies a vertical stride offset on east/west sides', () => {
    // stride=1, side=east → +14 px on y; cx unchanged, cy shifts.
    const { container } = renderEdge({
      data: { busSide: 'east', targetStride: 1 },
    });
    const circle = container.querySelector('circle');
    expect(circle?.getAttribute('cx')).toBe('100');
    expect(circle?.getAttribute('cy')).toBe('14');
  });

  it('alternates stride direction (even stride flips sign)', () => {
    // stride=2 → magnitude=ceil(2/2)=1, sign=-1 → -14 px
    const { container } = renderEdge({
      data: { busSide: 'north', targetStride: 2 },
    });
    const circle = container.querySelector('circle');
    expect(circle?.getAttribute('cx')).toBe('86');
  });

  it('skips stride when busSide is undefined', () => {
    // No busSide → no shift even if stride is set.
    const { container } = renderEdge({
      data: { targetStride: 5 },
    });
    const circle = container.querySelector('circle');
    expect(circle?.getAttribute('cx')).toBe('100');
    expect(circle?.getAttribute('cy')).toBe('0');
  });

  it('skips stride when stride is 0 (no shift)', () => {
    const { container } = renderEdge({
      data: { busSide: 'north', targetStride: 0 },
    });
    const circle = container.querySelector('circle');
    expect(circle?.getAttribute('cx')).toBe('100');
  });
});
