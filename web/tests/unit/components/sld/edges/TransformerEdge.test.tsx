/**
 * TransformerEdge: the path through the points of its route, the icon half
 * way along it, and the loading outline.
 *
 * Per the v0.1.y plan, this file is rendering smoke only — no
 * pixel-level assertions. We stub `BaseEdge` + `EdgeLabelRenderer` so the
 * component logic still runs without a React Flow root context.
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
        'data-stroke-dasharray': style?.strokeDasharray,
        'data-stroke-width': style?.strokeWidth,
      }),
    EdgeLabelRenderer: ({ children }: { children: ReactNode }) =>
      React.createElement('foreignObject', { 'data-testid': 'edge-label-portal' }, children),
  };
});

// Stub the icon manifest so we don't load actual SVG files in jsdom.
vi.mock('@/icons/iec60617/manifest', () => ({
  iconForModel: (model: string) => `mock-icon-${model}.svg`,
}));

import { TransformerEdge } from '@/components/sld/edges/TransformerEdge';
import type { ConnectorRoute } from '@/components/sld/connections';

interface RenderEdgeProps {
  id?: string;
  sourceX?: number;
  sourceY?: number;
  targetX?: number;
  targetY?: number;
  data?: {
    idx?: string;
    name?: string;
    route?: ConnectorRoute;
    labelAt?: { x: number; y: number; angleDeg: number };
    winding?: '2w' | '3w';
    draft?: boolean;
    ready?: boolean;
    active?: boolean;
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

/** A route out of the end of one bar, down, and into the end of another. */
const STEPPED: ConnectorRoute = {
  points: [
    [0, 3],
    [50, 3],
    [50, 53],
    [100, 53],
  ],
  sourceSide: 'east',
  targetSide: 'west',
};

beforeEach(() => {
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useUiStore.setState({ hideLabels: false });
});

describe('<TransformerEdge />', () => {
  it('falls back to a line between the two handles when it has no route', () => {
    const { getByTestId } = renderEdge();
    const base = getByTestId('transformer-edge-base');
    expect(base).toBeInTheDocument();
    expect(base.getAttribute('data-path')).toBe('M0,0 L100,0');
  });

  it('draws no dot of its own: the bar marks every tap', () => {
    const { container } = renderEdge({ data: { route: STEPPED } });
    expect(container.querySelectorAll('circle')).toHaveLength(0);
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

  it('draws through the points of its route, with square corners', () => {
    const { getByTestId } = renderEdge({ data: { route: STEPPED } });
    expect(getByTestId('transformer-edge-base').getAttribute('data-path')).toBe(
      'M0,3 L50,3 L50,53 L100,53',
    );
  });

  it('puts the icon half way along the route', () => {
    // 50 across, 50 down, 50 across: half way is the middle of the run down.
    const { getByTestId } = renderEdge({ id: 'tfm-1', data: { route: STEPPED } });
    expect(getByTestId('transformer-edge-icon-tfm-1').style.transform).toContain(
      'translate(50px, 28px)',
    );
  });

  it('puts the icon where the canvas found room for it, when it says where', () => {
    const { getByTestId } = renderEdge({
      id: 'tfm-1',
      data: { route: STEPPED, labelAt: { x: 20, y: 3, angleDeg: 0 } },
    });
    expect(getByTestId('transformer-edge-icon-tfm-1').style.transform).toContain(
      'translate(20px, 3px)',
    );
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

describe('<TransformerEdge /> for a draft', () => {
  it('is dashed, and so is the ring of its symbol, in the colour of the badge of its draft', () => {
    const { getByTestId } = renderEdge({ data: { draft: true, ready: false, winding: '2w' } });
    const base = getByTestId('transformer-edge-base');
    expect(base.getAttribute('data-stroke')).toBe('var(--color-warning)');
    expect(base.getAttribute('data-stroke-dasharray')).toBe('6 4');
    const icon = getByTestId('transformer-edge-icon-tfm-edge-1');
    expect(icon).toHaveAttribute('data-draft', 'true');
    expect(icon.className).toContain('border-dashed');
    expect(icon.className).toContain('border-warning');
    expect(icon).toHaveAttribute('title', 'A draft: not in the system yet.');
  });

  it('turns to the colour of a draft that can be added', () => {
    const { getByTestId } = renderEdge({ data: { draft: true, ready: true } });
    expect(getByTestId('transformer-edge-base').getAttribute('data-stroke')).toBe(
      'var(--color-success)',
    );
    expect(getByTestId('transformer-edge-icon-tfm-edge-1').className).toContain('border-success');
  });

  it('is solid, with no mark of a draft, for a transformer of the system', () => {
    const { getByTestId } = renderEdge({ data: { idx: 'T1' } });
    expect(getByTestId('transformer-edge-base').getAttribute('data-stroke-dasharray')).toBeNull();
    expect(getByTestId('transformer-edge-icon-tfm-edge-1')).not.toHaveAttribute('data-draft');
  });
});
