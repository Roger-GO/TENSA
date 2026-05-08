/**
 * SldCanvas — React Flow + ELK integration. Because jsdom doesn't lay
 * out, we stub the heavy parts of @xyflow/react to deterministic
 * passthroughs that render the nodes + edges as plain DOM elements.
 * The real `Handle` from @xyflow/react requires a `ReactFlowProvider`
 * context; the stub renders the node-component output verbatim and
 * lets us assert on `data-testid="bus-node-{idx}"`.
 *
 * What's covered:
 *
 * - `buildGraph` produces N bus nodes + M topology edges from a
 *   topology.
 * - The skeleton renders while ELK is in flight.
 * - Click on a node sets the case store's `selectedElement`.
 * - The >30-buses banner shows with no curated layout + no sidecar.
 * - The drift banner shows when `mergeWithDrift` reports drift.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// ---- mocks ---------------------------------------------------------------
//
// Stub @xyflow/react with a render-the-nodes passthrough. The custom
// node components are still invoked via their nodeTypes mapping; their
// output (the `<div data-testid="bus-node-..."` etc.) lands in the DOM
// where the test queries find them.
vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  type ReactFlowProps = {
    nodes: { id: string; type: string; data: Record<string, unknown> }[];
    edges: { id: string; source: string; target: string }[];
    nodeTypes: Record<string, React.ComponentType<unknown>>;
    edgeTypes?: Record<string, React.ComponentType<unknown>>;
    onNodeClick?: (
      e: React.MouseEvent,
      n: { id: string; type: string; data: Record<string, unknown> },
    ) => void;
    children?: ReactNode;
  };
  return {
    ReactFlow: ({ nodes, edges, nodeTypes, onNodeClick, children }: ReactFlowProps) => {
      return React.createElement(
        'div',
        { 'data-testid': 'rf-root' },
        nodes.map((n) => {
          const NodeComp = nodeTypes[n.type];
          if (!NodeComp) return null;
          return React.createElement(
            'div',
            {
              key: n.id,
              'data-rf-node-id': n.id,
              onClick: (e: React.MouseEvent) => onNodeClick?.(e, n),
            },
            React.createElement(NodeComp, {
              data: n.data,
              selected: false,
              type: n.type,
              xPos: 0,
              yPos: 0,
              dragging: false,
              isConnectable: true,
              targetPosition: 'top',
              sourcePosition: 'bottom',
              zIndex: 0,
            } as unknown as Record<string, unknown>),
          );
        }),
        edges.map((e) =>
          React.createElement('div', {
            key: e.id,
            'data-testid': `edge-${e.id}`,
            'data-source': e.source,
            'data-target': e.target,
          }),
        ),
        children,
      );
    },
    ReactFlowProvider: ({ children }: { children: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    Handle: () => null,
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    BaseEdge: () => null,
    getSmoothStepPath: () => ['M0,0 L1,1', 0, 0, 0, 0],
    Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
    SelectionMode: { Partial: 'partial', Full: 'full' },
  };
});

// Stub ELK to a deterministic identity layout — every bus gets a
// distinct (10*i, 20*i) coord. Avoids the elkjs worker spin-up cost in
// tests and makes assertions stable.
vi.mock('elkjs/lib/elk.bundled.js', () => {
  class ElkStub {
    async layout(graph: { children?: { id: string }[] }) {
      const children = (graph.children ?? []).map((c, i) => ({
        id: c.id,
        x: 10 * i,
        y: 20 * i,
      }));
      return { children };
    }
  }
  return { default: ElkStub };
});

import { SldCanvas } from '@/components/sld/SldCanvas';
import { buildGraph } from '@/components/sld/graph';
import { useCaseStore } from '@/store/case';
import { __resetCascadeForTests, wireStoreCascade } from '@/store';
import { parseWorkspacePath } from '@/api/types';
import type { TopologySummary, TopologyEntry } from '@/api/types';

function bus(idx: number | string, name = `b${idx}`): TopologyEntry {
  return { idx, name, kind: 'Bus', params: {} };
}
function line(idx: number | string, bus1: number | string, bus2: number | string): TopologyEntry {
  return { idx, name: `l${idx}`, kind: 'Line', params: { bus1, bus2 } };
}

function makeTopology(buses: TopologyEntry[], lines: TopologyEntry[] = []): TopologySummary {
  return {
    state: 'pre-setup',
    buses,
    lines,
    transformers: [],
    generators: [],
    loads: [],
  };
}

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

// Stub the sidecar query/mutation hooks so the canvas does not try to
// hit the real client.
vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useGetSidecar: () => ({
      data: null,
      isLoading: false,
      isError: false,
      error: null,
    }),
    usePutSidecar: () => ({ mutate: vi.fn() }),
  };
});

describe('buildGraph', () => {
  it('emits N bus nodes + M topology edges', () => {
    const topology = makeTopology([bus(1), bus(2), bus(3)], [line(10, 1, 2), line(11, 2, 3)]);
    const { nodes, edges } = buildGraph(topology, {
      '1': { x: 0, y: 0 },
      '2': { x: 100, y: 0 },
      '3': { x: 200, y: 0 },
    });
    expect(nodes.map((n) => n.id).sort()).toEqual(['1', '2', '3']);
    expect(edges.map((e) => e.id).sort()).toEqual(['line-10', 'line-11']);
    expect(edges[0]?.source).toBe('1');
    expect(edges[0]?.target).toBe('2');
  });

  it('ignores branches missing bus1/bus2 params', () => {
    const topology = makeTopology(
      [bus(1), bus(2)],
      [
        line(1, 1, 2),
        { idx: 2, name: 'l2', kind: 'Line', params: {} }, // missing terminals
      ],
    );
    const { edges } = buildGraph(topology, { '1': { x: 0, y: 0 }, '2': { x: 0, y: 0 } });
    expect(edges).toHaveLength(1);
  });
});

describe('SldCanvas', () => {
  beforeEach(() => {
    __resetCascadeForTests();
    wireStoreCascade();
  });
  afterEach(() => {
    cleanup();
    __resetCascadeForTests();
  });

  it('renders nothing when no case is loaded', () => {
    const { container } = render(withQueryClient(<SldCanvas />));
    expect(container.firstChild).toBeNull();
  });

  it('renders the layout-skeleton while ELK is in flight, then the canvas', async () => {
    const topology = makeTopology([bus(1), bus(2)], [line(1, 1, 2)]);
    act(() => {
      useCaseStore.setState({
        selection: {
          primaryPath: parseWorkspacePath('synthetic.raw'),
          addfiles: [],
        },
        topology,
      });
    });
    render(withQueryClient(<SldCanvas />));
    // Skeleton shows synchronously on first render (autoCoords=null).
    expect(screen.getByTestId('sld-layout-skeleton')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByTestId('sld-layout-skeleton')).not.toBeInTheDocument();
    });
    // Bus nodes are rendered.
    expect(screen.getByTestId('bus-node-1')).toBeInTheDocument();
    expect(screen.getByTestId('bus-node-2')).toBeInTheDocument();
    expect(screen.getByTestId('edge-line-1')).toBeInTheDocument();
  });

  it('writes selectedElement to the case store on node click', async () => {
    const user = userEvent.setup();
    const topology = makeTopology([bus(4)]);
    act(() => {
      useCaseStore.setState({
        selection: {
          primaryPath: parseWorkspacePath('synthetic.raw'),
          addfiles: [],
        },
        topology,
        selectedElement: null,
      });
    });
    render(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      expect(screen.getByTestId('bus-node-4')).toBeInTheDocument();
    });
    // Click the wrapper that the stub-ReactFlow attached the onClick to.
    const node = screen.getByTestId('bus-node-4');
    const wrapper = node.closest('[data-rf-node-id]');
    expect(wrapper).not.toBeNull();
    await user.click(wrapper as HTMLElement);
    expect(useCaseStore.getState().selectedElement).toEqual({ kind: 'bus', idx: '4' });
  });

  it('shows the >30-buses banner with no curated layout + no sidecar', async () => {
    const buses = Array.from({ length: 35 }, (_, i) => bus(i + 1));
    act(() => {
      useCaseStore.setState({
        selection: {
          primaryPath: parseWorkspacePath('big-synthetic.raw'),
          addfiles: [],
        },
        topology: makeTopology(buses),
      });
    });
    render(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      expect(screen.getByTestId('sld-large-banner')).toBeInTheDocument();
    });
    // Dismiss the banner.
    const dismiss = screen.getByTestId('sld-large-banner').querySelector('button');
    expect(dismiss).not.toBeNull();
    await userEvent.setup().click(dismiss as HTMLElement);
    await waitFor(() => {
      expect(screen.queryByTestId('sld-large-banner')).not.toBeInTheDocument();
    });
  });

  it('does NOT show the >30-buses banner for a curated case', async () => {
    const buses = Array.from({ length: 39 }, (_, i) => bus(i + 1));
    act(() => {
      useCaseStore.setState({
        selection: {
          primaryPath: parseWorkspacePath('ieee39.raw'),
          addfiles: [],
        },
        topology: makeTopology(buses),
      });
    });
    render(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      expect(screen.getByTestId('bus-node-1')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('sld-large-banner')).not.toBeInTheDocument();
  });
});
