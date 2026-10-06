/**
 * StubEdge: the connector of a device to its bus, drawn through the points
 * of the route `connections.ts` gave the edge.
 *
 * Edge components are inherently visual (they emit paths inside SVG);
 * these tests stub the @xyflow/react `BaseEdge` to a thin pass-through
 * that exposes the path string + style as DOM attributes so we can
 * assert against them without a real React Flow graph.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';

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
  };
});

import { StubEdge } from '@/components/sld/edges/StubEdge';
import type { ConnectorRoute } from '@/components/sld/connections';
import { lineStrokeStyle } from '@/components/sld/overlay';

interface RenderEdgeProps {
  sourceX?: number;
  sourceY?: number;
  targetX?: number;
  targetY?: number;
  data?: {
    route?: ConnectorRoute;
    bucket?: 'generator' | 'load' | 'shunt';
    kind?: string;
  };
}

function renderEdge(props: RenderEdgeProps = {}) {
  // EdgeProps is wide (Position is a string-literal union from
  // @xyflow/react); StubEdge reads none of it, so we cast through
  // `unknown` rather than reconstruct the full type.
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
  it('draws a straight connector from the port of the device to the tap', () => {
    const { getByTestId } = renderEdge({
      data: {
        route: {
          points: [
            [46, 70],
            [46, 103],
          ],
          sourceSide: 'south',
          targetSide: 'north',
        },
      },
    });
    expect(getByTestId('stub-edge-base').getAttribute('data-path')).toBe('M46,70 L46,103');
  });

  it('draws a connector with a right angle through its corner', () => {
    const { getByTestId } = renderEdge({
      data: {
        route: {
          points: [
            [130, 50],
            [89, 50],
            [89, 103],
          ],
          sourceSide: 'west',
          targetSide: 'north',
        },
      },
    });
    expect(getByTestId('stub-edge-base').getAttribute('data-path')).toBe('M130,50 L89,50 L89,103');
  });

  it('falls back to a line between the two handles when it has no route', () => {
    const { getByTestId } = renderEdge({ sourceX: 5, sourceY: 6, targetX: 70, targetY: 80 });
    expect(getByTestId('stub-edge-base').getAttribute('data-path')).toBe('M5,6 L70,80');
  });

  it('is drawn solid, with the stroke of a branch that has no flow to show', () => {
    const { getByTestId } = renderEdge();
    const base = getByTestId('stub-edge-base');
    const branch = lineStrokeStyle(null);
    expect(base.getAttribute('data-stroke')).toBe(branch.stroke);
    expect(base.getAttribute('data-stroke-width')).toBe(String(branch.strokeWidth));
    expect(base.getAttribute('data-stroke-dasharray')).toBeNull();
  });

  it('draws no dot of its own: the bar marks every tap', () => {
    const { container } = renderEdge();
    expect(container.querySelectorAll('circle')).toHaveLength(0);
  });
});
