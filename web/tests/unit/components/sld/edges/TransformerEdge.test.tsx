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
import { parseRunId } from '@/api/types';
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

  it('fans east/west stride offsets INWARD along the bar (keeps taps on the busbar)', () => {
    const { container } = renderEdge({
      data: {
        sourceSide: 'east',
        sourceStride: 1,
        targetSide: 'east',
        targetStride: 1,
      },
    });
    const circles = container.querySelectorAll('circle');
    // east side fans inward (−14 px on x); y stays on the bar so the
    // endpoint doesn't float off a 7px-tall busbar.
    expect(circles[0]?.getAttribute('cx')).toBe('-14');
    expect(circles[0]?.getAttribute('cy')).toBe('0');
    expect(circles[1]?.getAttribute('cx')).toBe('86');
    expect(circles[1]?.getAttribute('cy')).toBe('0');
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
    expect(base.getAttribute('data-stroke')).toBe('var(--color-muted-foreground)');
    // Stroke width matches the no-data branch (1.5px).
    expect(base.getAttribute('data-stroke-width')).toBe('1.5');
  });

  it('falls back gracefully when data is undefined (default 2w winding)', () => {
    const { getByTestId } = renderEdge({ id: 'tfm-empty' });
    expect(getByTestId('transformer-edge-icon-tfm-empty')).toHaveAttribute('data-winding', '2w');
  });
});

describe('<TransformerEdge /> loading', () => {
  function setFlow(loading: number | null): void {
    usePflowStore.setState({
      lastRun: {
        run_id: parseRunId('pf-1'),
        converged: true,
        iterations: 4,
        mismatch: 1e-6,
        bus_voltages: {},
        bus_angles: {},
        line_flows: {
          T1: lineFlow(26, 2, undefined, {
            rate_a: loading === null ? null : 20,
            loading_pct: loading,
          }),
        },
      },
      isRunning: false,
      error: null,
    });
  }

  it('outlines the icon red and heavy past the rating, and says so on hover', () => {
    setFlow(130);
    const { getByTestId } = renderEdge({ id: 'tfm-1', data: { idx: 'T1' } });
    const icon = getByTestId('transformer-edge-icon-tfm-1');
    expect(icon).toHaveAttribute('data-loading-band', 'danger');
    expect(icon.className).toContain('border-danger');
    expect(icon).toHaveAttribute('title', 'Over rating: 130.0% of its rating');
    expect(getByTestId('transformer-edge-base').getAttribute('data-stroke')).toBe(
      'var(--color-danger)',
    );
  });

  it('outlines the icon amber near the rating', () => {
    setFlow(85);
    const { getByTestId } = renderEdge({ id: 'tfm-1', data: { idx: 'T1' } });
    expect(getByTestId('transformer-edge-icon-tfm-1')).toHaveAttribute(
      'data-loading-band',
      'warning',
    );
    expect(getByTestId('transformer-edge-icon-tfm-1').className).toContain('border-warning');
  });

  it('leaves the icon alone for a lightly loaded or an unrated transformer', () => {
    setFlow(30);
    const light = renderEdge({ id: 'tfm-1', data: { idx: 'T1' } });
    const icon = light.getByTestId('transformer-edge-icon-tfm-1');
    expect(icon).toHaveAttribute('data-loading-band', 'success');
    expect(icon.className).toContain('border-border');
    expect(icon).not.toHaveAttribute('title');
    light.unmount();

    setFlow(null);
    const unrated = renderEdge({ id: 'tfm-1', data: { idx: 'T1' } });
    expect(unrated.getByTestId('transformer-edge-icon-tfm-1')).toHaveAttribute(
      'data-loading-band',
      'neutral',
    );
  });
});
