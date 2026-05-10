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
    nodes: {
      id: string;
      type: string;
      data: Record<string, unknown>;
      className?: string;
    }[];
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
          // Mirror React Flow's behaviour: ``node.className`` and the
          // node-data ``energised`` attribute land on the node wrapper
          // (Unit 17 connectivity overlay needs both for the grey-out
          // assertion in the SldCanvas test).
          const wrapperProps: Record<string, unknown> = {
            key: n.id,
            'data-rf-node-id': n.id,
            'data-energised':
              (n.data as { energised?: boolean }).energised === false ? 'false' : 'true',
            onClick: (e: React.MouseEvent) => onNodeClick?.(e, n),
          };
          if (n.className) wrapperProps.className = n.className;
          return React.createElement(
            'div',
            wrapperProps,
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
    // v3 Unit 6 — pass the props we assert on (variant, color, gap)
    // through to a DOM stub so the dot-grid + chrome tests can read
    // them. The real component renders an SVG; we only need a probe.
    Background: ({
      variant,
      color,
      gap,
    }: {
      variant?: string;
      color?: string;
      gap?: number;
    }) =>
      React.createElement('div', {
        'data-testid': 'sld-canvas-dot-grid',
        'data-variant': variant,
        'data-color': color,
        'data-gap': gap,
      }),
    Controls: ({ className }: { className?: string }) =>
      React.createElement('div', {
        'data-testid': 'sld-canvas-controls',
        className,
      }),
    MiniMap: ({ className }: { className?: string }) =>
      React.createElement('div', {
        'data-testid': 'sld-canvas-minimap',
        className,
      }),
    BackgroundVariant: { Lines: 'lines', Dots: 'dots', Cross: 'cross' },
    BaseEdge: () => null,
    getSmoothStepPath: () => ['M0,0 L1,1', 0, 0, 0, 0],
    Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
    SelectionMode: { Partial: 'partial', Full: 'full' },
    // Unit 11 — `useReactFlow` is consumed by SldCanvas (for
    // `setCenter` panning) and by SldNodeSearch (for `getNodes` +
    // `getZoom`). v3 Unit 5 added `screenToFlowPosition` (consumed by
    // the drop handler that converts a screen-pixel drop into the
    // canvas's flow-coordinate space). The stub returns identity
    // (screen == flow) so the drop tests can assert the exact
    // coordinate flowed through to `openAddPanel(kind, dropCoord)`.
    useReactFlow: () => ({
      setCenter: vi.fn(),
      getZoom: vi.fn(() => 1),
      getNodes: vi.fn(() => []),
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
    }),
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
import { useSessionStore } from '@/store/session';
import { useConnectivityStore } from '@/store/connectivity';
import { __resetCascadeForTests, wireStoreCascade } from '@/store';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
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
// hit the real client. Also stub `useCurrentTopology` so tests can
// drive the canvas's topology via a module-level mutable variable
// (matching the previous `useCaseStore.setState({ topology })` pattern
// before topology moved to a TanStack Query hook).
let mockTopology: TopologySummary | null = null;
// Spy on ``useConnectivity``'s ``refetch`` so the recompute-button test
// can assert it fired without spinning up a real fetch. Each test
// overrides ``mockConnectivityRefetch`` for its scenario.
let mockConnectivityRefetch = vi.fn(() => Promise.resolve({ data: null }));
let mockConnectivityIsFetching = false;
let mockConnectivityIsError = false;
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
    useConnectivity: () => ({
      data: null,
      isLoading: false,
      isFetching: mockConnectivityIsFetching,
      isError: mockConnectivityIsError,
      error: null,
      refetch: mockConnectivityRefetch,
    }),
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
    mockTopology = null;
    mockConnectivityIsFetching = false;
    mockConnectivityIsError = false;
    mockConnectivityRefetch = vi.fn(() => Promise.resolve({ data: null }));
    __resetCascadeForTests();
    wireStoreCascade();
    // Connectivity slice carries across tests because the store is a
    // module-level singleton; reset it explicitly here so the SldCanvas
    // tests that don't exercise connectivity see a clean baseline.
    useConnectivityStore.setState({
      result: null,
      energisedBusIdxes: new Set<string>(),
    });
  });
  afterEach(() => {
    mockTopology = null;
    cleanup();
    __resetCascadeForTests();
    useConnectivityStore.setState({
      result: null,
      energisedBusIdxes: new Set<string>(),
    });
  });

  it('renders nothing when no case is loaded', () => {
    const { container } = render(withQueryClient(<SldCanvas />));
    expect(container.firstChild).toBeNull();
  });

  it('renders the layout-skeleton while ELK is in flight, then the canvas', async () => {
    const topology = makeTopology([bus(1), bus(2)], [line(1, 1, 2)]);
    mockTopology = topology;
    act(() => {
      useCaseStore.setState({
        selection: {
          primaryPath: parseWorkspacePath('synthetic.raw'),
          addfiles: [],
        },
      });
    });
    render(withQueryClient(<SldCanvas />));
    // Skeleton shows synchronously on first render (autoCoords=null).
    expect(screen.getByTestId('sld-layout-skeleton')).toBeInTheDocument();
    // Bus nodes appear after the ELK promise resolves and the layout
    // effect commits. Wrap all three assertions in a single waitFor so
    // we don't race the React commit between the skeleton-gone check
    // and the bus-node check.
    await waitFor(() => {
      expect(screen.queryByTestId('sld-layout-skeleton')).not.toBeInTheDocument();
      expect(screen.getByTestId('bus-node-1')).toBeInTheDocument();
      expect(screen.getByTestId('bus-node-2')).toBeInTheDocument();
      expect(screen.getByTestId('edge-line-1')).toBeInTheDocument();
    });
  });

  it('writes selectedElement to the case store on node click', async () => {
    const user = userEvent.setup();
    const topology = makeTopology([bus(4)]);
    mockTopology = topology;
    act(() => {
      useCaseStore.setState({
        selection: {
          primaryPath: parseWorkspacePath('synthetic.raw'),
          addfiles: [],
        },
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
    mockTopology = makeTopology(buses);
    act(() => {
      useCaseStore.setState({
        selection: {
          primaryPath: parseWorkspacePath('big-synthetic.raw'),
          addfiles: [],
        },
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
    mockTopology = makeTopology(buses);
    act(() => {
      useCaseStore.setState({
        selection: {
          primaryPath: parseWorkspacePath('ieee39.raw'),
          addfiles: [],
        },
      });
    });
    render(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      expect(screen.getByTestId('bus-node-1')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('sld-large-banner')).not.toBeInTheDocument();
  });

  // ---- Unit 17 — connectivity overlay -------------------------------------

  it('greys out de-energised buses when connectivity reports a singleton island', async () => {
    // Toy topology: 3 buses, one isolated. The connectivity store is
    // pre-seeded with a 2-island result mirroring the real
    // ``ConnectivityResult`` shape ANDES emits after a critical line
    // trip (singletons-first ordering per ``_post_process_islands``).
    mockTopology = makeTopology([bus(1), bus(2), bus(3)], [line(10, 1, 2)]);
    act(() => {
      useCaseStore.setState({
        selection: {
          primaryPath: parseWorkspacePath('synthetic.raw'),
          addfiles: [],
        },
      });
      useConnectivityStore.getState().setResult({
        island_count: 2,
        islands: [['3'], ['1', '2']],
        islanded_bus_idxes: ['3'],
      });
    });
    render(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      expect(screen.getByTestId('bus-node-3')).toBeInTheDocument();
    });
    // The de-energised bus's React Flow wrapper carries
    // ``data-energised="false"`` and the ``sld-bus-de-energised``
    // class; the energised buses do not.
    const wrapper3 = screen.getByTestId('bus-node-3').closest('[data-rf-node-id]');
    expect(wrapper3).not.toBeNull();
    expect(wrapper3?.getAttribute('data-energised')).toBe('false');
    expect(wrapper3?.className).toContain('sld-bus-de-energised');

    const wrapper1 = screen.getByTestId('bus-node-1').closest('[data-rf-node-id]');
    expect(wrapper1?.getAttribute('data-energised')).toBe('true');
    expect(wrapper1?.className ?? '').not.toContain('sld-bus-de-energised');
  });

  it('does not grey any bus when no connectivity result is present', async () => {
    mockTopology = makeTopology([bus(1), bus(2)], [line(10, 1, 2)]);
    act(() => {
      useCaseStore.setState({
        selection: {
          primaryPath: parseWorkspacePath('synthetic.raw'),
          addfiles: [],
        },
      });
      // Explicit clear — the beforeEach already does this, but make
      // the test's intent self-evident.
      useConnectivityStore.getState().clear();
    });
    render(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      expect(screen.getByTestId('bus-node-1')).toBeInTheDocument();
    });
    const wrapper1 = screen.getByTestId('bus-node-1').closest('[data-rf-node-id]');
    expect(wrapper1?.getAttribute('data-energised')).toBe('true');
    expect(wrapper1?.className ?? '').not.toContain('sld-bus-de-energised');
  });

  it('renders the Recompute connectivity button and disables it when no session', async () => {
    mockTopology = makeTopology([bus(1)]);
    act(() => {
      useSessionStore.setState({
        sessionId: null,
        recoveryInProgress: false,
        recoveryFailed: false,
        recoveryAttempts: [],
      });
      useCaseStore.setState({
        selection: {
          primaryPath: parseWorkspacePath('synthetic.raw'),
          addfiles: [],
        },
      });
    });
    render(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      expect(screen.getByTestId('sld-recompute-connectivity')).toBeInTheDocument();
    });
    const btn = screen.getByTestId('sld-recompute-connectivity') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('Recompute connectivity button calls refetch when clicked', async () => {
    const user = userEvent.setup();
    mockTopology = makeTopology([bus(1), bus(2)], [line(10, 1, 2)]);
    act(() => {
      useSessionStore.setState({
        sessionId: parseSessionId('test-session'),
        recoveryInProgress: false,
        recoveryFailed: false,
        recoveryAttempts: [],
      });
      useCaseStore.setState({
        selection: {
          primaryPath: parseWorkspacePath('synthetic.raw'),
          addfiles: [],
        },
      });
    });
    render(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      expect(screen.getByTestId('sld-recompute-connectivity')).toBeInTheDocument();
    });
    const btn = screen.getByTestId('sld-recompute-connectivity') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    await user.click(btn);
    expect(mockConnectivityRefetch).toHaveBeenCalledTimes(1);
  });

  // ---- v3 Unit 5 — Component Library drag-and-drop ------------------------

  it('drop with the andes-component-type MIME opens AddElementPanel with the dropCoord', async () => {
    mockTopology = makeTopology([bus(1)]);
    act(() => {
      useCaseStore.setState({
        selection: {
          primaryPath: parseWorkspacePath('synthetic.raw'),
          addfiles: [],
        },
        addPanelOpen: false,
        addPanelKind: null,
        addPanelDropCoord: null,
      });
    });
    render(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      expect(screen.getByTestId('sld-canvas-surface')).toBeInTheDocument();
    });
    const surface = screen.getByTestId('sld-canvas-surface');
    // Synthesise a drop with the andes-component-type MIME. Use
    // `fireEvent.drop` so React's synthetic-event bridge dispatches
    // through the registered onDrop handler.
    const getData = vi.fn((mime: string) =>
      mime === 'application/andes-component-type' ? 'Generator' : '',
    );
    const dataTransfer = {
      getData,
      setData: vi.fn(),
      effectAllowed: 'copy' as DataTransfer['effectAllowed'],
      dropEffect: 'copy' as DataTransfer['dropEffect'],
      types: ['application/andes-component-type'] as ReadonlyArray<string>,
      files: [] as unknown as FileList,
      items: [] as unknown as DataTransferItemList,
      clearData: vi.fn(),
      setDragImage: vi.fn(),
    };
    const { fireEvent, createEvent } = await import('@testing-library/react');
    // jsdom's DragEvent constructor ignores clientX/clientY from the
    // init dict, so we build the event then patch the coords on. The
    // synthetic-event bridge propagates them to e.clientX/e.clientY in
    // the React handler.
    const dropEvent = createEvent.drop(surface, { dataTransfer });
    Object.defineProperty(dropEvent, 'clientX', { value: 150 });
    Object.defineProperty(dropEvent, 'clientY', { value: 250 });
    fireEvent(surface, dropEvent);
    expect(useCaseStore.getState().addPanelOpen).toBe(true);
    expect(useCaseStore.getState().addPanelKind).toBe('Generator');
    expect(useCaseStore.getState().addPanelDropCoord).toEqual({ x: 150, y: 250 });
  });

  it('drop without an andes-component-type MIME is a no-op (some other DnD)', async () => {
    mockTopology = makeTopology([bus(1)]);
    act(() => {
      useCaseStore.setState({
        selection: {
          primaryPath: parseWorkspacePath('synthetic.raw'),
          addfiles: [],
        },
        addPanelOpen: false,
        addPanelKind: null,
        addPanelDropCoord: null,
      });
    });
    render(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      expect(screen.getByTestId('sld-canvas-surface')).toBeInTheDocument();
    });
    const surface = screen.getByTestId('sld-canvas-surface');
    const dataTransfer = {
      getData: vi.fn(() => ''), // no payload at all
      setData: vi.fn(),
      effectAllowed: 'copy' as DataTransfer['effectAllowed'],
      dropEffect: 'copy' as DataTransfer['dropEffect'],
      types: [] as ReadonlyArray<string>,
      files: [] as unknown as FileList,
      items: [] as unknown as DataTransferItemList,
      clearData: vi.fn(),
      setDragImage: vi.fn(),
    };
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.drop(surface, { dataTransfer, clientX: 10, clientY: 10 });
    // Panel state untouched.
    expect(useCaseStore.getState().addPanelOpen).toBe(false);
    expect(useCaseStore.getState().addPanelKind).toBeNull();
    expect(useCaseStore.getState().addPanelDropCoord).toBeNull();
  });

  it('drop of a Bus tile passes the dropCoord through to openAddPanel', async () => {
    mockTopology = makeTopology([bus(1)]);
    act(() => {
      useCaseStore.setState({
        selection: {
          primaryPath: parseWorkspacePath('synthetic.raw'),
          addfiles: [],
        },
        addPanelOpen: false,
        addPanelKind: null,
        addPanelDropCoord: null,
      });
    });
    render(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      expect(screen.getByTestId('sld-canvas-surface')).toBeInTheDocument();
    });
    const surface = screen.getByTestId('sld-canvas-surface');
    const dataTransfer = {
      getData: vi.fn((mime: string) => (mime === 'application/andes-component-type' ? 'Bus' : '')),
      setData: vi.fn(),
      effectAllowed: 'copy' as DataTransfer['effectAllowed'],
      dropEffect: 'copy' as DataTransfer['dropEffect'],
      types: ['application/andes-component-type'] as ReadonlyArray<string>,
      files: [] as unknown as FileList,
      items: [] as unknown as DataTransferItemList,
      clearData: vi.fn(),
      setDragImage: vi.fn(),
    };
    const { fireEvent, createEvent } = await import('@testing-library/react');
    const dropEvent = createEvent.drop(surface, { dataTransfer });
    Object.defineProperty(dropEvent, 'clientX', { value: 42 });
    Object.defineProperty(dropEvent, 'clientY', { value: 99 });
    fireEvent(surface, dropEvent);
    expect(useCaseStore.getState().addPanelKind).toBe('Bus');
    expect(useCaseStore.getState().addPanelDropCoord).toEqual({ x: 42, y: 99 });
  });

  // ---- v3 Unit 6 — dot-grid + IDE chrome ----------------------------------

  it('renders React Flow Background with the dots variant + token-driven color', async () => {
    mockTopology = makeTopology([bus(1), bus(2)], [line(10, 1, 2)]);
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
      expect(screen.getByTestId('sld-canvas-dot-grid')).toBeInTheDocument();
    });
    const grid = screen.getByTestId('sld-canvas-dot-grid');
    expect(grid.getAttribute('data-variant')).toBe('dots');
    // Theme adaptation flows through the CSS variable; assert the
    // token reference rather than a resolved colour value so swapping
    // to .dark on <html> remains a one-line change in tokens.css.
    expect(grid.getAttribute('data-color')).toBe('var(--color-dot-grid)');
    expect(grid.getAttribute('data-gap')).toBe('16');
  });

  it('renders MiniMap with IDE chrome (border, rounded, shadow)', async () => {
    mockTopology = makeTopology([bus(1), bus(2)], [line(10, 1, 2)]);
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
      expect(screen.getByTestId('sld-canvas-minimap')).toBeInTheDocument();
    });
    const minimap = screen.getByTestId('sld-canvas-minimap');
    const className = minimap.getAttribute('class') ?? '';
    expect(className).toContain('border');
    expect(className).toContain('border-border');
    expect(className).toContain('rounded-lg');
    expect(className).toContain('shadow-lg');
  });

  it('renders Controls with the same IDE chrome treatment', async () => {
    mockTopology = makeTopology([bus(1), bus(2)], [line(10, 1, 2)]);
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
      expect(screen.getByTestId('sld-canvas-controls')).toBeInTheDocument();
    });
    const controls = screen.getByTestId('sld-canvas-controls');
    const className = controls.getAttribute('class') ?? '';
    expect(className).toContain('border');
    expect(className).toContain('border-border');
    expect(className).toContain('rounded-lg');
    expect(className).toContain('shadow-lg');
  });

  it('Recompute connectivity button reflects the latest island_count from the store', async () => {
    mockTopology = makeTopology([bus(1), bus(2), bus(3)], [line(10, 1, 2)]);
    act(() => {
      useSessionStore.setState({
        sessionId: parseSessionId('test-session'),
        recoveryInProgress: false,
        recoveryFailed: false,
        recoveryAttempts: [],
      });
      useCaseStore.setState({
        selection: {
          primaryPath: parseWorkspacePath('synthetic.raw'),
          addfiles: [],
        },
      });
      useConnectivityStore.getState().setResult({
        island_count: 2,
        islands: [['3'], ['1', '2']],
        islanded_bus_idxes: ['3'],
      });
    });
    render(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      expect(screen.getByTestId('sld-recompute-connectivity')).toBeInTheDocument();
    });
    const btn = screen.getByTestId('sld-recompute-connectivity');
    expect(btn.getAttribute('data-island-count')).toBe('2');
    expect(btn.textContent).toContain('2 islands');
  });
});
