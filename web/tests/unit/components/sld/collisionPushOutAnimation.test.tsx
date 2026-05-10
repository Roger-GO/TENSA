/**
 * Animation gating for collision push-out (Unit 3, v0.1.y).
 *
 * Verifies SldCanvas's prior-position-ref bookkeeping:
 *
 * - A node whose post-push-out position differs from the prior render
 *   is rendered with `style.transition: 'transform var(--duration-base) ease-out'`
 *   so React Flow's `transform: translate(...)` animates the move.
 * - A newly-emitted node (no prior position) renders without the
 *   transition style so it appears in place.
 * - A node moved by a user drag does NOT carry the transition style
 *   (push-out's `dragOverrides` skip path handles that case).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// ---- mocks ---------------------------------------------------------------

type RFNode = {
  id: string;
  type: string;
  position: { x: number; y: number };
  style?: Record<string, unknown>;
  data: Record<string, unknown>;
};

// Capture every render's `nodes` prop so the test can inspect the
// post-push-out + post-prior-diff output.
const rfRenders: RFNode[][] = [];

vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  type ReactFlowProps = {
    nodes: RFNode[];
    edges: { id: string; source: string; target: string }[];
    nodeTypes: Record<string, React.ComponentType<unknown>>;
    children?: ReactNode;
  };
  return {
    ReactFlow: ({ nodes, children }: ReactFlowProps) => {
      rfRenders.push(nodes);
      return React.createElement(
        'div',
        { 'data-testid': 'rf-root' },
        nodes.map((n) =>
          React.createElement('div', {
            key: n.id,
            'data-testid': `rf-node-${n.id}`,
            'data-node-style-transition': (n.style?.transition as string | undefined) ?? '',
            'data-pos-x': String(n.position.x),
            'data-pos-y': String(n.position.y),
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
    // Unit 11 — `useReactFlow` is consumed by SldCanvas and the search
    // popover. Animation tests don't exercise it, but the hook must
    // resolve to something callable so the canvas mounts.
    useReactFlow: () => ({
      setCenter: vi.fn(),
      getZoom: vi.fn(() => 1),
      getNodes: vi.fn(() => []),
    }),
  };
});

// ELK identity stub — every bus gets a deterministic (10*i, 20*i)
// position. Avoids elkjs spin-up + makes coords predictable.
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
import { useCaseStore } from '@/store/case';
import { __resetCascadeForTests, wireStoreCascade } from '@/store';
import { parseWorkspacePath } from '@/api/types';
import type { TopologySummary, TopologyEntry } from '@/api/types';

// Mutable topology + sidecar for the test harness.
let mockTopology: TopologySummary | null = null;

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
    useCurrentTopology: () => mockTopology,
  };
});

// ---- topology builders ---------------------------------------------------

function bus(idx: number | string, name = `b${idx}`): TopologyEntry {
  return { idx, name, kind: 'Bus', params: {} };
}

function gen(idx: number | string, busIdx: number | string): TopologyEntry {
  return {
    idx,
    name: `gen-${idx}`,
    kind: 'PV',
    params: { bus: busIdx, Sn: 100, Vn: 100, p0: 1, v0: 1 },
  };
}

function load(idx: number | string, busIdx: number | string): TopologyEntry {
  return {
    idx,
    name: `load-${idx}`,
    kind: 'PQ',
    params: { bus: busIdx, Vn: 100, p0: 0.5, q0: 0.1 },
  };
}

function makeTopology(opts: Partial<TopologySummary>): TopologySummary {
  return {
    state: 'pre-setup',
    buses: opts.buses ?? [],
    lines: opts.lines ?? [],
    transformers: opts.transformers ?? [],
    generators: opts.generators ?? [],
    loads: opts.loads ?? [],
    shunts: opts.shunts ?? [],
  };
}

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

// ---- tests ---------------------------------------------------------------

describe('SldCanvas — push-out animation gating', () => {
  beforeEach(() => {
    rfRenders.length = 0;
    mockTopology = null;
    __resetCascadeForTests();
    wireStoreCascade();
  });
  afterEach(() => {
    rfRenders.length = 0;
    mockTopology = null;
    cleanup();
    __resetCascadeForTests();
  });

  it('does NOT apply transition to newly-emitted nodes (first render)', async () => {
    // Arrange: a single bus + generator. First render — no prior
    // positions, so no animation.
    mockTopology = makeTopology({
      buses: [bus(1)],
      generators: [gen('G1', 1)],
    });
    act(() => {
      useCaseStore.setState({
        selection: {
          primaryPath: parseWorkspacePath('synthetic.raw'),
          addfiles: [],
        },
      });
    });
    render(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      const last = rfRenders.at(-1);
      expect(last).toBeDefined();
      expect(last?.find((n) => n.type === 'generator')).toBeDefined();
    });
    const last = rfRenders.at(-1)!;
    const genNode = last.find((n) => n.type === 'generator')!;
    // First render — no prior position, no animation.
    expect(genNode.style?.transition).toBeUndefined();
  });

  it('applies transition: transform 200ms when push-out relocates a node between renders', async () => {
    // First render: bus-1 alone with one generator.
    mockTopology = makeTopology({
      buses: [bus(1)],
      generators: [gen('G1', 1)],
    });
    act(() => {
      useCaseStore.setState({
        selection: {
          primaryPath: parseWorkspacePath('synthetic.raw'),
          addfiles: [],
        },
      });
    });
    const { rerender } = render(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      const last = rfRenders.at(-1);
      expect(last?.find((n) => n.type === 'generator')).toBeDefined();
    });

    // First, snapshot the generator's natural position emitted on
    // render-1 so the second-render scenario knows where to put the
    // colliding load.
    const firstRenderGen = rfRenders.at(-1)!.find((n) => n.type === 'generator')!;
    const genX = firstRenderGen.position.x;
    const genY = firstRenderGen.position.y;

    // Second render: add a load on the same bus and drag-override it
    // to the generator's natural position. Push-out pre-applies the
    // override (the load is locked) and shifts the generator off,
    // registering a position change vs. the prior render → the
    // animation flag fires on the generator.
    const renderCountBeforeUpdate = rfRenders.length;
    act(() => {
      mockTopology = makeTopology({
        buses: [bus(1)],
        generators: [gen('G1', 1)],
        loads: [load('L1', 1)],
      });
      // Bump selection to a new object reference so the Outer
      // SldCanvas component re-renders and re-evaluates
      // `useCurrentTopology()` (which is mocked at module level).
      useCaseStore.setState({
        selection: {
          primaryPath: parseWorkspacePath('synthetic.raw'),
          addfiles: [],
        },
        dragOverrides: {
          'load-L1': { x: genX, y: genY }, // overlap the generator
        },
      });
    });
    rerender(withQueryClient(<SldCanvas />));
    // Wait for the relocation to land in at least one render frame.
    await waitFor(() => {
      expect(rfRenders.length).toBeGreaterThan(renderCountBeforeUpdate);
      const lastFrame = rfRenders.at(-1)!;
      const g = lastFrame.find((n) => n.type === 'generator');
      expect(g).toBeDefined();
      expect(g!.position.y).not.toBe(genY);
    });
    // The transition style is sticky across renders once a node has
    // been relocated by push-out — see SldCanvas's `relocatedIdsRef`.
    // The last render therefore still carries the style.
    const last = rfRenders.at(-1)!;
    const finalGen = last.find((n) => n.type === 'generator')!;
    expect(typeof finalGen.style?.transition).toBe('string');
    expect(finalGen.style?.transition as string).toContain('transform');
  });

  it('does NOT apply transition to a user-dragged node (drag override skip path)', async () => {
    mockTopology = makeTopology({
      buses: [bus(1)],
      generators: [gen('G1', 1)],
    });
    act(() => {
      useCaseStore.setState({
        selection: {
          primaryPath: parseWorkspacePath('synthetic.raw'),
          addfiles: [],
        },
      });
    });
    const { rerender } = render(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      const last = rfRenders.at(-1);
      expect(last?.find((n) => n.type === 'generator')).toBeDefined();
    });

    // Simulate a user drag by setting dragOverrides directly.
    const before = rfRenders.length;
    act(() => {
      useCaseStore.setState({
        dragOverrides: {
          'generator-G1': { x: 999, y: 999 },
        },
      });
    });
    rerender(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      expect(rfRenders.length).toBeGreaterThan(before);
      const last = rfRenders.at(-1)!;
      const g = last.find((n) => n.id === 'generator-G1')!;
      expect(g.position.x).toBe(999);
    });
    const last = rfRenders.at(-1)!;
    const draggedGen = last.find((n) => n.id === 'generator-G1')!;
    // The user explicitly moved it — no transition.
    expect(draggedGen.style?.transition).toBeUndefined();
  });
});
