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
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, cleanup, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Spies the mocks below hand out, shared with the tests that assert on them.
const { fitViewSpy, putSidecarSpy } = vi.hoisted(() => ({
  fitViewSpy: vi.fn(),
  putSidecarSpy: vi.fn(),
}));

// jsdom 25 ships without ``window.PointerEvent``, and testing-library's
// ``fireEvent.pointerDown`` then falls back to a generic Event that drops
// ``pointerType`` (the long-press tests need it) and the coordinates. Polyfill it
// as a thin MouseEvent subclass, as the other pointer tests do.
beforeAll(() => {
  if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === 'undefined') {
    class PointerEventPolyfill extends MouseEvent {
      readonly pointerId: number;
      readonly pointerType: string;
      readonly isPrimary: boolean;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
        this.pointerType = init.pointerType ?? 'mouse';
        this.isPrimary = init.isPrimary ?? true;
      }
    }
    (globalThis as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent =
      PointerEventPolyfill;
    (window as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent =
      PointerEventPolyfill;
  }
});

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
      selected?: boolean;
    }[];
    edges: {
      id: string;
      source: string;
      target: string;
      type?: string;
      data?: Record<string, unknown>;
    }[];
    nodeTypes: Record<string, React.ComponentType<unknown>>;
    edgeTypes?: Record<string, React.ComponentType<unknown>>;
    minZoom?: number;
    nodeDragThreshold?: number;
    ariaLabelConfig?: Record<string, string>;
    onNodeClick?: (
      e: React.MouseEvent,
      n: { id: string; type: string; data: Record<string, unknown> },
    ) => void;
    onNodeContextMenu?: (
      e: React.MouseEvent,
      n: { id: string; type: string; data: Record<string, unknown> },
    ) => void;
    onEdgeContextMenu?: (
      e: React.MouseEvent,
      edge: { id: string; type?: string; data?: Record<string, unknown> },
    ) => void;
    children?: ReactNode;
  };
  return {
    ReactFlow: ({
      nodes,
      edges,
      nodeTypes,
      minZoom,
      nodeDragThreshold,
      ariaLabelConfig,
      onNodeClick,
      onNodeContextMenu,
      onEdgeContextMenu,
      children,
    }: ReactFlowProps) => {
      return React.createElement(
        'div',
        {
          'data-testid': 'rf-root',
          'data-min-zoom': minZoom,
          'data-drag-threshold': nodeDragThreshold,
          'data-lock-label': ariaLabelConfig?.['controls.interactive.ariaLabel'],
        },
        nodes.map((n) => {
          const NodeComp = nodeTypes[n.type];
          if (!NodeComp) return null;
          // Mirror React Flow's behaviour: ``node.className`` and the
          // node-data ``energised`` attribute land on the node wrapper
          // (Unit 17 connectivity overlay needs both for the grey-out
          // assertion in the SldCanvas test).
          // The wrapper's class and ``data-id`` are the ones the real one has: the
          // right-click menu finds a pressed node from them.
          const wrapperProps: Record<string, unknown> = {
            key: n.id,
            'data-rf-node-id': n.id,
            'data-id': n.id,
            className: 'react-flow__node',
            'data-energised':
              (n.data as { energised?: boolean }).energised === false ? 'false' : 'true',
            onClick: (e: React.MouseEvent) => onNodeClick?.(e, n),
            // React Flow calls this from the node wrapper's own contextmenu handler.
            onContextMenu: (e: React.MouseEvent) => onNodeContextMenu?.(e, n),
          };
          if (n.className) wrapperProps.className = `react-flow__node ${n.className}`;
          return React.createElement(
            'div',
            wrapperProps,
            React.createElement(NodeComp, {
              data: n.data,
              // The canvas says which node is picked out; React Flow hands it on.
              selected: n.selected === true,
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
            className: 'react-flow__edge',
            'data-id': e.id,
            'data-testid': `edge-${e.id}`,
            'data-source': e.source,
            'data-target': e.target,
            onContextMenu: (ev: React.MouseEvent) => onEdgeContextMenu?.(ev, e),
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
    Background: ({ variant, color, gap }: { variant?: string; color?: string; gap?: number }) =>
      React.createElement('div', {
        'data-testid': 'sld-canvas-dot-grid',
        'data-variant': variant,
        'data-color': color,
        'data-gap': gap,
      }),
    // The lock button of the real controls reports each press through
    // `onInteractiveChange`; the stand-in has one that turns the lock on and off.
    // Its Fit View button does what the real one does: it asks React Flow for
    // a fit with the options the controls were given, and then calls `onFitView`.
    Controls: ({
      className,
      onInteractiveChange,
      fitViewOptions,
      onFitView,
    }: {
      className?: string;
      onInteractiveChange?: (interactive: boolean) => void;
      fitViewOptions?: Record<string, unknown>;
      onFitView?: () => void;
    }) => {
      const [interactive, setInteractive] = React.useState(true);
      return React.createElement(
        'div',
        { 'data-testid': 'sld-canvas-controls', className },
        React.createElement('button', {
          type: 'button',
          'data-testid': 'sld-canvas-controls-fit',
          onClick: () => {
            fitViewSpy(fitViewOptions);
            onFitView?.();
          },
        }),
        React.createElement('button', {
          type: 'button',
          'data-testid': 'sld-canvas-lock',
          onClick: () => {
            setInteractive(!interactive);
            onInteractiveChange?.(!interactive);
          },
        }),
      );
    },
    MiniMap: ({ className }: { className?: string }) =>
      React.createElement('div', {
        'data-testid': 'sld-canvas-minimap',
        className,
      }),
    BackgroundVariant: { Lines: 'lines', Dots: 'dots', Cross: 'cross' },
    BaseEdge: () => null,
    Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
    SelectionMode: { Partial: 'partial', Full: 'full' },
    // The generator / load nodes read the zoom to decide whether to draw
    // their P / Q labels (`useDeviceLabelsVisible`). 1x: labels allowed.
    useStore: (selector: (s: { transform: [number, number, number] }) => unknown) =>
      selector({ transform: [0, 0, 1] }),
    // Unit 11 — `useReactFlow` is consumed by SldCanvas (for
    // `setCenter` panning) and by SldNodeSearch (for `getNodes` +
    // `getZoom`). v3 Unit 5 added `screenToFlowPosition` (consumed by
    // the drop handler that converts a screen-pixel drop into the
    // canvas's flow-coordinate space). The stub returns identity
    // (screen == flow) so the drop tests can assert where the draft
    // that was dropped comes to stand.
    useReactFlow: () => ({
      setCenter: vi.fn(),
      getZoom: vi.fn(() => 1),
      getNodes: vi.fn(() => []),
      fitView: fitViewSpy,
      // What Fit view measures the diagram with, to leave room for what
      // floats over its corners.
      getNodesBounds: () => ({ x: 0, y: 0, width: 800, height: 400 }),
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
    }),
  };
});

// Stub the ELK worker client to a deterministic identity layout — every
// bus gets a distinct (10*i, 20*i) coord. Avoids a real worker (jsdom has
// none) and makes assertions stable. `vi.fn` so tests can count the passes.
vi.mock('@/components/sld/elkClient', () => ({
  elkLayout: vi.fn(async (graph: { children?: { id: string }[] }) => {
    const children = (graph.children ?? []).map((c, i) => ({
      id: c.id,
      x: 10 * i,
      y: 20 * i,
    }));
    return { children };
  }),
}));

import { SldCanvas } from '@/components/sld/SldCanvas';
import { buildGraph } from '@/components/sld/graph';
import { elkLayout } from '@/components/sld/elkClient';
import { useCaseStore } from '@/store/case';
import { DRAFT_NODE_SIZE, useDraftsStore } from '@/store/drafts';
import { __requestSldCommand, useSldStore } from '@/store/sld';
import { toast } from '@/lib/toast';
import { useSessionStore } from '@/store/session';
import { useConnectivityStore } from '@/store/connectivity';
import { usePflowStore } from '@/store/pflow';
import { useUiStore } from '@/store/ui';
import { __resetCascadeForTests, wireStoreCascade } from '@/store';
import { parseRunId, parseSessionId, parseWorkspacePath } from '@/api/types';
import type { TopologySummary, TopologyEntry, SidecarLayout } from '@/api/types';

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
// The stored layout sidecar the canvas reads (null: none saved for the case).
let mockSidecar: SidecarLayout | null = null;
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
      data: mockSidecar,
      isLoading: false,
      isError: false,
      error: null,
    }),
    usePutSidecar: () => ({ mutate: putSidecarSpy }),
    useCurrentTopology: () => mockTopology,
    // The fields of each model: only a draft on the diagram is checked against them.
    useTopologySchema: () => ({ data: undefined }),
    useEditElements: () => ({ mutate: vi.fn(), isPending: false }),
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

  it('stamps each bus node with the limits from its vmin and vmax, or the default when it has none', () => {
    const topology = makeTopology([
      { idx: 1, name: 'b1', kind: 'Bus', params: { vmin: 0.9, vmax: 1.1 } },
      bus(2),
      { idx: 3, name: 'b3', kind: 'Bus', params: { vmin: 1.2, vmax: 0.8 } },
    ]);
    const { nodes } = buildGraph(topology, {
      '1': { x: 0, y: 0 },
      '2': { x: 100, y: 0 },
      '3': { x: 200, y: 0 },
    });
    const limitsOf = (id: string) => nodes.find((n) => n.id === id)?.data.voltageLimits;
    expect(limitsOf('1')).toEqual({ vmin: 0.9, vmax: 1.1 });
    expect(limitsOf('2')).toEqual({ vmin: 0.95, vmax: 1.05 });
    // A pair with no band between them is not a limit.
    expect(limitsOf('3')).toEqual({ vmin: 0.95, vmax: 1.05 });
  });

  it('stamps each bus node with its rated voltage, and nothing when it has none', () => {
    const topology = makeTopology([
      { idx: 1, name: 'b1', kind: 'Bus', params: { Vn: 230 } },
      { idx: 2, name: 'b2', kind: 'Bus', params: {} },
      { idx: 3, name: 'b3', kind: 'Bus', params: { Vn: 0 } },
    ]);
    const { nodes } = buildGraph(topology, {
      '1': { x: 0, y: 0 },
      '2': { x: 100, y: 0 },
      '3': { x: 200, y: 0 },
    });
    const dataOf = (id: string) => nodes.find((n) => n.id === id)?.data;
    expect(dataOf('1')?.baseKv).toBe(230);
    expect(dataOf('2')).not.toHaveProperty('baseKv');
    expect(dataOf('3')).not.toHaveProperty('baseKv');
  });

  it('leaves a bus unstamped when the case gives it no rated voltage, whatever Vn holds', () => {
    // ANDES fills in 110 kV for such a bus, and the topology lists it.
    const topology = {
      ...makeTopology([
        { idx: 1, name: 'b1', kind: 'Bus', params: { Vn: 230 } },
        { idx: 2, name: 'b2', kind: 'Bus', params: { Vn: 110 } },
      ]),
      buses_without_vn: [2],
    };
    const { nodes } = buildGraph(topology, { '1': { x: 0, y: 0 }, '2': { x: 100, y: 0 } });
    const dataOf = (id: string) => nodes.find((n) => n.id === id)?.data;
    expect(dataOf('1')?.baseKv).toBe(230);
    expect(dataOf('2')).not.toHaveProperty('baseKv');
  });

  it('names each element for assistive technology and for tools that find it by name', () => {
    const topology: TopologySummary = {
      ...makeTopology([bus(1, 'BUS1'), bus(2, '2')], [line(10, 1, 2)]),
      transformers: [{ idx: 11, name: 'T1', kind: 'Line', params: { bus1: 1, bus2: 2 } }],
      generators: [{ idx: 'GENROU_1', name: 'GENROU_1', kind: 'GENROU', params: { bus: 1 } }],
    };
    const { nodes, edges } = buildGraph(topology, { '1': { x: 0, y: 0 }, '2': { x: 100, y: 0 } });
    const labelOf = (list: { id: string; ariaLabel?: string | null }[], id: string) =>
      list.find((x) => x.id === id)?.ariaLabel;
    // The idx follows when the diagram's name differs from it.
    expect(labelOf(nodes, '1')).toBe('Bus BUS1 (idx 1)');
    expect(labelOf(nodes, '2')).toBe('Bus 2');
    expect(labelOf(nodes, 'generator-GENROU_1')).toBe('Generator GENROU_1');
    expect(labelOf(edges, 'line-10')).toBe('Line l10 (idx 10), bus 1 to bus 2');
    expect(labelOf(edges, 'transformer-11')).toBe('Transformer T1 (idx 11), bus 1 to bus 2');
    expect(labelOf(edges, 'stub-generator-GENROU_1')).toBe(
      'Generator GENROU_1, connection to bus 1',
    );
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
    mockSidecar = null;
    fitViewSpy.mockReset();
    putSidecarSpy.mockReset();
    act(() => useCaseStore.setState({ dragOverrides: {}, routeOverrides: {}, unitExpansion: {} }));
    act(() => useSldStore.getState().clearSelectedNodeId());
    act(() => useSldStore.setState({ pickedNodeIds: [], diagramLocked: false }));
    vi.mocked(elkLayout).mockClear();
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
    mockSidecar = null;
    cleanup();
    usePflowStore.getState().clearPflow();
    useUiStore.setState({ hideLabels: false });
    useDraftsStore.setState({ byCase: {}, placements: {}, routes: {} });
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

  it('renders the badge of a controller that acts on a bus and selects it (with sub-kind) on click', async () => {
    const user = userEvent.setup();
    const topology: TopologySummary = {
      ...makeTopology([bus(1)]),
      controllers: [{ idx: 'PMU_1', name: 'PMU 1', kind: 'PMU', params: { bus: 1 } }],
    };
    mockTopology = topology;
    act(() => {
      useCaseStore.setState({
        selection: { primaryPath: parseWorkspacePath('synthetic.raw'), addfiles: [] },
        selectedElement: null,
      });
    });
    render(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      expect(screen.getByTestId('controller-node-PMU_1')).toBeInTheDocument();
    });
    const wrapper = screen.getByTestId('controller-node-PMU_1').closest('[data-rf-node-id]');
    expect(wrapper).not.toBeNull();
    await user.click(wrapper as HTMLElement);
    expect(useCaseStore.getState().selectedElement).toEqual({
      kind: 'controller',
      subKind: 'measurement',
      modelClass: 'PMU',
      idx: 'PMU_1',
    });
  });

  // ---- a generating unit: one symbol for the generator, its machine and their controllers ----

  /** ieee14_full's shape: PV 2 on bus 1, GENROU_2 that names it, an exciter and a governor. */
  function loadUnitCase(saved: Partial<SidecarLayout> | null = null) {
    mockTopology = {
      ...makeTopology([bus(1), bus(2)], [line(10, 1, 2)]),
      generators: [
        { idx: 2, name: '2', kind: 'PV', params: { bus: 1 } },
        { idx: 'GENROU_2', name: 'GENROU_2', kind: 'GENROU', params: { bus: 1, gen: 2 } },
      ],
      controllers: [
        { idx: 'EXST1_1', name: 'EXST1_1', kind: 'EXST1', params: { syn: 'GENROU_2' } },
        { idx: 'TGOV1_2', name: 'TGOV1_2', kind: 'TGOV1', params: { syn: 'GENROU_2' } },
      ],
    };
    mockSidecar =
      saved === null
        ? null
        : {
            schema_version: '2',
            andes_version: '2.0.0',
            last_modified: '2026-10-01T00:00:00Z',
            coordinates: { '1': { x: 500, y: 40 }, '2': { x: 900, y: 80 } },
            ...saved,
          };
    act(() => {
      useCaseStore.setState({
        selection: { primaryPath: parseWorkspacePath('synthetic.raw'), addfiles: [] },
        selectedElement: null,
      });
    });
  }

  async function renderUnit() {
    render(withQueryClient(<SldCanvas />));
    await waitFor(() => expect(screen.getByTestId('generator-node-2')).toBeInTheDocument());
    return screen.getByTestId('generator-node-2');
  }

  it('draws a generator, its machine and their controllers as one symbol that names each model', async () => {
    loadUnitCase();
    const unit = await renderUnit();
    // One symbol, and no badge beside it.
    expect(screen.getAllByTestId(/^generator-node-/)).toHaveLength(1);
    expect(screen.queryByTestId(/^controller-node-/)).not.toBeInTheDocument();
    // A chip per model after the generator itself, by what it is to the unit.
    const chips = within(unit).getAllByTestId(/^unit-chip-/);
    expect(chips.map((chip) => chip.textContent)).toEqual(['SG', 'AVR', 'GOV']);
    expect(within(unit).getByTestId('unit-chip-EXST1-EXST1_1')).toHaveAccessibleName(
      'Exciter: EXST1 EXST1_1',
    );
    // Folded until asked.
    expect(unit).toHaveAttribute('data-unit-expanded', 'false');
    expect(screen.queryByTestId('unit-chain-2')).not.toBeInTheDocument();
  });

  it('shows the generator in the Inspector on a click on the symbol, and a model on a press of its chip', async () => {
    const user = userEvent.setup();
    loadUnitCase();
    const unit = await renderUnit();

    await user.click(unit.closest('[data-rf-node-id]') as HTMLElement);
    expect(useCaseStore.getState().selectedElement).toEqual({
      kind: 'generator',
      idx: '2',
      modelClass: 'PV',
    });
    expect(useSldStore.getState().selectedNodeId).toBe('generator-2');

    await user.click(within(unit).getByTestId('unit-chip-EXST1-EXST1_1'));
    // The press stays on the chip: the node under it does not take the selection back.
    expect(useCaseStore.getState().selectedElement).toEqual({
      kind: 'controller',
      subKind: 'exciter',
      modelClass: 'EXST1',
      idx: 'EXST1_1',
    });
    expect(useSldStore.getState().selectedNodeId).toBe('controller-EXST1-EXST1_1');
    // The chip is marked, and the symbol of its unit stays picked out.
    expect(within(unit).getByTestId('unit-chip-EXST1-EXST1_1')).toHaveAttribute(
      'data-selected',
      'true',
    );
    expect(within(unit).getByTestId('unit-chip-TGOV1-TGOV1_2')).not.toHaveAttribute(
      'data-selected',
    );
    expect(screen.getByTestId('generator-node-2')).toHaveAttribute('data-selected', 'true');

    await user.click(within(unit).getByTestId('unit-chip-GENROU-GENROU_2'));
    expect(useCaseStore.getState().selectedElement).toEqual({
      kind: 'generator',
      idx: 'GENROU_2',
      modelClass: 'GENROU',
    });
  });

  it('picks out the symbol of the unit when one of its models is picked in a table or the search', async () => {
    loadUnitCase();
    await renderUnit();
    expect(screen.getByTestId('generator-node-2')).not.toHaveAttribute('data-selected');
    // What a row of the Machines table writes, and what a row of a controller table writes.
    for (const id of ['generator-GENROU_2', 'controller-TGOV1-TGOV1_2']) {
      act(() => useSldStore.getState().setSelectedNodeId(id));
      expect(screen.getByTestId('generator-node-2')).toHaveAttribute('data-selected', 'true');
      act(() => useSldStore.getState().setSelectedNodeId('1'));
      expect(screen.getByTestId('generator-node-2')).not.toHaveAttribute('data-selected');
    }
    // The governor picked by its id alone has its chip marked.
    act(() => useSldStore.getState().setSelectedNodeId('controller-TGOV1-TGOV1_2'));
    expect(screen.getByTestId('unit-chip-TGOV1-TGOV1_2')).toHaveAttribute('data-selected', 'true');
  });

  it('draws the control chain of a unit out on a press of its control, and folds it away again', async () => {
    const user = userEvent.setup();
    loadUnitCase();
    const unit = await renderUnit();
    const toggle = within(unit).getByRole('button', {
      name: 'Show the control chain of generator 2',
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);
    // The press does not select the unit.
    expect(useCaseStore.getState().selectedElement).toBeNull();
    const chain = await screen.findByTestId('unit-chain-2');
    expect(screen.getByTestId('generator-node-2')).toHaveAttribute('data-unit-expanded', 'true');
    // Every model, each under the one it refers to.
    const rows = within(chain).getAllByTestId(/^unit-chain-row-/);
    expect(rows.map((row) => `${row.getAttribute('data-depth')} ${row.textContent}`)).toEqual([
      '0 PV2',
      '1 └GENROUGENROU_2SG',
      '2 └EXST1EXST1_1AVR',
      '2 └TGOV1TGOV1_2GOV',
    ]);
    expect(useCaseStore.getState().unitExpansion).toEqual({ '2': true });

    // A row shows its model in the Inspector, like a chip.
    await user.click(within(chain).getByTestId('unit-chain-row-TGOV1-TGOV1_2'));
    expect(useCaseStore.getState().selectedElement).toMatchObject({
      kind: 'controller',
      modelClass: 'TGOV1',
      idx: 'TGOV1_2',
    });

    await user.click(screen.getByRole('button', { name: 'Hide the control chain of generator 2' }));
    await waitFor(() => expect(screen.queryByTestId('unit-chain-2')).not.toBeInTheDocument());
    expect(useCaseStore.getState().unitExpansion).toEqual({ '2': false });
  });

  it('writes a chain that is drawn out beside the case, and draws it out again from there', async () => {
    const user = userEvent.setup();
    loadUnitCase({});
    const unit = await renderUnit();
    await user.click(within(unit).getByTestId('unit-toggle-2'));
    await waitFor(() => expect(putSidecarSpy).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const [vars] = putSidecarSpy.mock.calls[0] ?? [];
    expect(vars.casePath).toBe('synthetic.raw');
    // With the bus the unit is on, which is what the entry is good for.
    expect(vars.layout.units).toEqual({ '2': { expanded: true, bus: '1' } });
    // And with the diagram as it stands, like any write of the layout.
    expect(Object.keys(vars.layout.coordinates)).toEqual(['1', '2']);
    // The save paths send the same.
    expect(useCaseStore.getState().diagramLayout?.units).toEqual({
      '2': { expanded: true, bus: '1' },
    });

    // The case opened again, with that layout on disk and nothing chosen yet.
    cleanup();
    act(() => useCaseStore.setState({ unitExpansion: {} }));
    mockSidecar = vars.layout as SidecarLayout;
    await renderUnit();
    expect(screen.getByTestId('unit-chain-2')).toBeInTheDocument();
  });

  it('folds a chain a saved layout draws out for a unit of another bus', async () => {
    // The idx has come to name another generator: the entry is not for it.
    loadUnitCase({ units: { '2': { expanded: true, bus: '9' } } });
    await renderUnit();
    expect(screen.queryByTestId('unit-chain-2')).not.toBeInTheDocument();
    // And the next layout written does not hold it any more.
    expect(useCaseStore.getState().diagramLayout?.units).toEqual({});
  });

  it('draws a chain out away from the bus, and beside the symbol where a bar stands in the way there', async () => {
    // The unit stands over bus 1, so its chain goes above it: but bus 2 is
    // right there, and the line from it comes down through the same place.
    const placed: Partial<SidecarLayout> = {
      coordinates: { '1': { x: 500, y: 300 }, '2': { x: 500, y: 150 } },
      non_bus_coordinates: { generator: { '2': { x: 510, y: 230, bus: '1' } } },
      units: { '2': { expanded: true, bus: '1' } },
    };
    loadUnitCase(placed);
    await renderUnit();
    expect(screen.getByTestId('unit-chain-2')).toHaveAttribute('data-side', 'right');
    expect(screen.getByTestId('unit-toggle-2')).toHaveAttribute('aria-expanded', 'true');
    cleanup();

    // With bus 2 and its line elsewhere, nothing is in the way above.
    loadUnitCase({ ...placed, coordinates: { '1': { x: 500, y: 300 }, '2': { x: 900, y: 600 } } });
    mockTopology = { ...mockTopology!, lines: [] };
    await renderUnit();
    expect(screen.getByTestId('unit-chain-2')).toHaveAttribute('data-side', 'above');
  });

  it('offers the chain of a unit from its right-click menu', async () => {
    loadUnitCase();
    const unit = await renderUnit();
    const wrapper = unit.closest('[data-rf-node-id]') as HTMLElement;
    fireEvent.contextMenu(wrapper);
    let menu = await screen.findByTestId('sld-context-menu');
    expect(within(menu).getByTestId('sld-context-menu-title')).toHaveTextContent('Generator 2');
    const show = within(menu).getByTestId('sld-context-unit-chain');
    expect(show).toHaveTextContent('Show control chain');
    fireEvent.click(show);
    await screen.findByTestId('unit-chain-2');
    await waitFor(() => expect(screen.queryByTestId('sld-context-menu')).toBeNull());

    fireEvent.contextMenu(wrapper);
    menu = await screen.findByTestId('sld-context-menu');
    expect(within(menu).getByTestId('sld-context-unit-chain')).toHaveTextContent(
      'Hide control chain',
    );
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('sld-context-menu')).toBeNull());

    // A bus, or a generator of one model, has no chain to offer.
    fireEvent.contextMenu(screen.getByTestId('bus-node-1').closest('[data-rf-node-id]')!);
    menu = await screen.findByTestId('sld-context-menu');
    expect(within(menu).queryByTestId('sld-context-unit-chain')).toBeNull();
  });

  it('Reset to auto-layout folds the chains drawn out, in this visit and in the file, and Undo draws them out again', async () => {
    const saved: Partial<SidecarLayout> = { units: { '2': { expanded: true, bus: '1' } } };
    loadUnitCase(saved);
    const success = vi.spyOn(toast, 'success').mockReturnValue('id');
    await renderUnit();
    expect(screen.getByTestId('unit-chain-2')).toBeInTheDocument();
    act(() => useCaseStore.setState({ unitExpansion: { '2': true } }));

    act(() => __requestSldCommand('reset-layout'));
    expect(useCaseStore.getState().unitExpansion).toEqual({});
    const [vars, callbacks] = putSidecarSpy.mock.calls[0] ?? [];
    expect(vars.layout.units).toEqual({});
    act(() => callbacks.onSuccess());
    act(() => success.mock.calls[0]?.[1]?.action?.onClick());
    expect(useCaseStore.getState().unitExpansion).toEqual({ '2': true });
    expect(putSidecarSpy.mock.calls[1]?.[0].layout.units).toEqual(saved.units);
  });

  it('Reset to auto-layout folds a chain drawn out in a system that has no file', async () => {
    loadUnitCase();
    act(() => {
      useCaseStore.setState({
        selection: { primaryPath: null, addfiles: [], blank: true },
        unitExpansion: { '2': true },
      });
    });
    const success = vi.spyOn(toast, 'success').mockReturnValue('id');
    await renderUnit();
    expect(screen.getByTestId('unit-chain-2')).toBeInTheDocument();
    act(() => __requestSldCommand('reset-layout'));
    await waitFor(() => expect(screen.queryByTestId('unit-chain-2')).not.toBeInTheDocument());
    expect(putSidecarSpy).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledTimes(1);
  });

  const PF_ROWS = {
    run_id: parseRunId('pf-1'),
    converged: true,
    iterations: 3,
    mismatch: 1e-9,
    bus_voltages: { '1': 1.03 },
    bus_angles: { '1': 0 },
    line_flows: {},
    generator_outputs: { '1': { p: 81.43, q: -21.62, v: 1.03, bus: 1 } },
    load_consumption: { PQ_1: { p: 21.7, q: 12.7, bus: 1 } },
  };

  function seedSyntheticSelection() {
    act(() => {
      useCaseStore.setState({
        selection: { primaryPath: parseWorkspacePath('synthetic.raw'), addfiles: [] },
        selectedElement: null,
      });
    });
  }

  it('writes the PF P / Q onto generator and load nodes, once per row', async () => {
    // ieee14_full's shape: the machine has an idx of its own. It and the
    // static generator it names are one node, which prints the row once.
    mockTopology = {
      ...makeTopology([bus(1)]),
      generators: [
        { idx: 1, name: 'slack', kind: 'Slack', params: { bus: 1 } },
        { idx: 'GENROU_1', name: 'm1', kind: 'GENROU', params: { bus: 1, gen: 1 } },
      ],
      loads: [{ idx: 'PQ_1', name: 'pq1', kind: 'PQ', params: { bus: 1 } }],
    };
    seedSyntheticSelection();
    render(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      expect(screen.getByTestId('load-node-PQ_1')).toBeInTheDocument();
    });
    expect(screen.getAllByTestId(/^generator-node-/)).toHaveLength(1);
    expect(screen.getByTestId('generator-node-1')).toBeInTheDocument();
    // No PF yet: names only.
    expect(screen.queryByTestId(/-values-/)).not.toBeInTheDocument();

    act(() => {
      usePflowStore.getState().setLastRun(PF_ROWS);
    });
    expect(screen.getByTestId('generator-p-1')).toHaveTextContent('81.4 MW');
    expect(screen.getByTestId('generator-q-1')).toHaveTextContent('-21.6 MVAr');
    expect(screen.getByTestId('load-p-PQ_1')).toHaveTextContent('21.7 MW');
    expect(screen.getByTestId('load-q-PQ_1')).toHaveTextContent('12.7 MVAr');
    // As many readouts as rows.
    expect(screen.getAllByTestId(/^generator-values-/)).toHaveLength(
      Object.keys(PF_ROWS.generator_outputs).length,
    );
    expect(screen.getAllByTestId(/^load-values-/)).toHaveLength(
      Object.keys(PF_ROWS.load_consumption).length,
    );

    // "Hide labels" clears the readouts together with the bus labels.
    act(() => {
      useUiStore.getState().setHideLabels(true);
    });
    expect(screen.queryByTestId(/-values-/)).not.toBeInTheDocument();
  });

  it('judges each bus on its own limits after a power flow, marks the ones out of band, and shows the legend', async () => {
    // 1.07 pu is past the 0.95 / 1.05 default but inside bus 1's own 0.9 / 1.1.
    mockTopology = makeTopology([
      { idx: 1, name: 'b1', kind: 'Bus', params: { vmin: 0.9, vmax: 1.1 } },
      bus(2),
    ]);
    seedSyntheticSelection();
    render(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      expect(screen.getByTestId('bus-node-2')).toBeInTheDocument();
    });
    // Nothing is coloured before a power flow, so there is nothing to key.
    expect(screen.queryByTestId('sld-voltage-legend')).not.toBeInTheDocument();

    act(() => {
      usePflowStore.getState().setLastRun({
        ...PF_ROWS,
        bus_voltages: { '1': 1.07, '2': 1.07 },
        bus_angles: { '1': 0, '2': 0 },
      });
    });
    expect(screen.getByTestId('bus-node-1')).toHaveAttribute('data-band', 'success');
    expect(screen.queryByTestId('bus-limit-marker-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('bus-node-2')).toHaveAttribute('data-band', 'danger');
    expect(screen.getByTestId('bus-limit-marker-2')).toHaveAttribute('data-side', 'high');
    expect(screen.getByTestId('sld-voltage-legend')).toBeInTheDocument();

    // Hide labels keeps the marker: it is the colour-free sign of the violation.
    act(() => {
      useUiStore.getState().setHideLabels(true);
    });
    expect(screen.queryByTestId('bus-voltage-2')).not.toBeInTheDocument();
    expect(screen.getByTestId('bus-limit-marker-2')).toBeInTheDocument();
  });

  it('writes the PF P / Q onto the one node of a machine that shares its idx with its generator', async () => {
    // kundur_full's shape: PV/Slack and GENROU are numbered alike, so the pair
    // is one node, which reads the static row under that idx.
    mockTopology = {
      ...makeTopology([bus(1)]),
      generators: [
        { idx: 1, name: 'slack', kind: 'Slack', params: { bus: 1 } },
        { idx: 1, name: 'm1', kind: 'GENROU', params: { bus: 1, gen: 1 } },
      ],
      loads: [{ idx: 'PQ_1', name: 'pq1', kind: 'PQ', params: { bus: 1 } }],
    };
    seedSyntheticSelection();
    render(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      expect(screen.getByTestId('load-node-PQ_1')).toBeInTheDocument();
    });
    act(() => {
      usePflowStore.getState().setLastRun(PF_ROWS);
    });
    expect(screen.getByTestId('generator-p-1')).toHaveTextContent('81.4 MW');
    expect(screen.getAllByTestId(/^generator-values-/)).toHaveLength(1);
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

  // ---- ELK runs only when it can change the drawing -------------------------

  /** ELK passes per layout: one, for the places of the buses. The routes are made here. */
  const ELK_PASSES = 1;

  function selectCase(path: string) {
    act(() => {
      useCaseStore.setState({
        selection: { primaryPath: parseWorkspacePath(path), addfiles: [] },
      });
    });
  }

  function sidecarFor(busIdxs: number[]): SidecarLayout {
    return {
      schema_version: '1',
      andes_version: '2.0.0',
      last_modified: '2026-01-01T00:00:00Z',
      coordinates: Object.fromEntries(busIdxs.map((i) => [String(i), { x: 100 * i, y: 50 }])),
      non_bus_coordinates: {},
    };
  }

  it('does not lay out again when the topology refetches with the same shape', async () => {
    mockTopology = makeTopology([bus(1), bus(2)], [line(1, 1, 2)]);
    selectCase('synthetic.raw');
    const view = render(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      expect(screen.getByTestId('bus-node-1')).toBeInTheDocument();
    });
    expect(elkLayout).toHaveBeenCalledTimes(ELK_PASSES);

    // What a power-flow run or a parameter edit does: a new topology object,
    // another state, the same buses and branch terminals.
    mockTopology = { ...makeTopology([bus(1), bus(2)], [line(1, 1, 2)]), state: 'committed' };
    view.rerender(withQueryClient(<SldCanvas />));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.queryByTestId('sld-layout-skeleton')).not.toBeInTheDocument();
    expect(screen.getByTestId('bus-node-2')).toBeInTheDocument();
    expect(elkLayout).toHaveBeenCalledTimes(ELK_PASSES);
  });

  it('lays out again when a bus is added to the case', async () => {
    mockTopology = makeTopology([bus(1), bus(2)], [line(1, 1, 2)]);
    selectCase('synthetic.raw');
    const view = render(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      expect(screen.getByTestId('bus-node-2')).toBeInTheDocument();
    });

    mockTopology = makeTopology([bus(1), bus(2), bus(3)], [line(1, 1, 2), line(2, 2, 3)]);
    view.rerender(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      expect(screen.getByTestId('bus-node-3')).toBeInTheDocument();
    });
    expect(elkLayout).toHaveBeenCalledTimes(2 * ELK_PASSES);
  });

  it('skips ELK when the saved layout places every bus', async () => {
    mockTopology = makeTopology([bus(1), bus(2)], [line(1, 1, 2)]);
    mockSidecar = sidecarFor([1, 2]);
    selectCase('synthetic.raw');
    render(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      expect(screen.getByTestId('bus-node-1')).toBeInTheDocument();
      expect(screen.getByTestId('bus-node-2')).toBeInTheDocument();
    });
    expect(elkLayout).not.toHaveBeenCalled();
    expect(screen.queryByTestId('sld-drift-banner')).not.toBeInTheDocument();
  });

  it('runs ELK, and shows the drift banner, when the saved layout misses a bus', async () => {
    mockTopology = makeTopology([bus(1), bus(2), bus(3)], [line(1, 1, 2)]);
    mockSidecar = sidecarFor([1, 2]);
    selectCase('synthetic.raw');
    render(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      expect(screen.getByTestId('bus-node-3')).toBeInTheDocument();
    });
    expect(elkLayout).toHaveBeenCalled();
    expect(screen.getByTestId('sld-drift-banner')).toBeInTheDocument();
  });

  it('skips ELK for a curated case whose layout places every bus', async () => {
    mockTopology = makeTopology(Array.from({ length: 39 }, (_, i) => bus(i + 1)));
    selectCase('ieee39.raw');
    render(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      expect(screen.getByTestId('bus-node-39')).toBeInTheDocument();
    });
    expect(elkLayout).not.toHaveBeenCalled();
  });

  it('runs ELK for a curated case that has a bus the curated layout lacks', async () => {
    mockTopology = makeTopology(Array.from({ length: 40 }, (_, i) => bus(i + 1)));
    selectCase('ieee39.raw');
    render(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      expect(screen.getByTestId('bus-node-40')).toBeInTheDocument();
    });
    expect(elkLayout).toHaveBeenCalled();
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

  // ---- Dropping a row of the Components palette ---------------------------
  //
  // What the drop does to the diagram (the draft it draws, its connector,
  // its form) is held in `SldCanvasDrafts.test.tsx`; here, that the surface
  // takes the drop.

  /** Drop `kind` on the diagram's surface with the pointer at `x`, `y`. */
  async function dropOnSurface(kind: string, x: number, y: number): Promise<void> {
    act(() => {
      useCaseStore.setState({
        selection: { primaryPath: parseWorkspacePath('synthetic.raw'), addfiles: [] },
        addPanelOpen: false,
        addPanelKind: null,
      });
    });
    render(withQueryClient(<SldCanvas />));
    await waitFor(() => {
      expect(screen.getByTestId('sld-canvas-surface')).toBeInTheDocument();
    });
    const surface = screen.getByTestId('sld-canvas-surface');
    const dataTransfer = {
      getData: vi.fn((mime: string) => (mime === 'application/andes-component-type' ? kind : '')),
      setData: vi.fn(),
      effectAllowed: 'copy' as DataTransfer['effectAllowed'],
      dropEffect: 'copy' as DataTransfer['dropEffect'],
      types: (kind === '' ? [] : ['application/andes-component-type']) as ReadonlyArray<string>,
      files: [] as unknown as FileList,
      items: [] as unknown as DataTransferItemList,
      clearData: vi.fn(),
      setDragImage: vi.fn(),
    };
    const { createEvent } = await import('@testing-library/react');
    // jsdom's DragEvent constructor ignores clientX/clientY from the
    // init dict, so we build the event then patch the coords on. The
    // synthetic-event bridge propagates them to e.clientX/e.clientY in
    // the React handler.
    const dropEvent = createEvent.drop(surface, { dataTransfer });
    Object.defineProperty(dropEvent, 'clientX', { value: x });
    Object.defineProperty(dropEvent, 'clientY', { value: y });
    act(() => {
      fireEvent(surface, dropEvent);
    });
  }

  it('drop with the andes-component-type MIME places a draft of that kind, and opens no form', async () => {
    mockTopology = makeTopology([bus(1)]);
    await dropOnSurface('PV', 600, 400);
    const drafts = useDraftsStore.getState().byCase['synthetic.raw'] ?? [];
    expect(drafts.map((d) => d.kind)).toEqual(['PV']);
    // The middle of its box is where the pointer was let go (the stub of
    // React Flow maps the screen to the diagram one to one).
    expect(drafts[0]?.position).toEqual({
      x: 600 - DRAFT_NODE_SIZE.width / 2,
      y: 400 - DRAFT_NODE_SIZE.height / 2,
    });
    // It is picked, which is what opens its form in the Inspector.
    expect(useSldStore.getState().selectedNodeId).toBe(drafts[0]?.id);
    expect(useCaseStore.getState().addPanelOpen).toBe(false);
  });

  it('drop without an andes-component-type MIME is a no-op (some other DnD)', async () => {
    mockTopology = makeTopology([bus(1)]);
    await dropOnSurface('', 10, 10);
    expect(useDraftsStore.getState().byCase['synthetic.raw']).toBeUndefined();
    expect(useCaseStore.getState().addPanelOpen).toBe(false);
    expect(useCaseStore.getState().addPanelKind).toBeNull();
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

  it('lets the diagram zoom out past half size, so a tall case fits a short pane', async () => {
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
    await waitFor(() => expect(screen.getByTestId('rf-root')).toBeInTheDocument());
    // React Flow's own floor is 0.5, which stops the fit short and leaves the top
    // and bottom of a tall diagram outside the pane. The mock leaves the attribute
    // off when no floor is passed, so check it is there before reading its value.
    const floor = screen.getByTestId('rf-root').getAttribute('data-min-zoom');
    expect(floor).not.toBeNull();
    expect(Number(floor)).toBeGreaterThan(0);
    expect(Number(floor)).toBeLessThan(0.5);
  });

  it('says what the lock button locks, and what the diagram answers to', async () => {
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
    await waitFor(() => expect(screen.getByTestId('rf-root')).toBeInTheDocument());
    expect(screen.getByTestId('rf-root').getAttribute('data-lock-label')).toMatch(
      /^Lock the diagram.*dragging/,
    );
    expect(screen.getByTestId('sld-canvas-hint')).toHaveTextContent(
      /Drag a bus.*Right-click a bus, a line or the background/,
    );
    // The rest is one press away, where no line of it is cut: the way to
    // move something without a drag, how a component is connected and a
    // line drawn, that a line can be moved too, how to pick several and take
    // a move back, and that an arrangement is kept.
    await userEvent.click(
      screen.getByRole('button', { name: 'Show everything that can be done on the diagram' }),
    );
    const whole = await screen.findByTestId('sld-canvas-hint-full');
    for (const line of [
      'or click it and press the arrow keys.',
      'Drop a device from the Components tab on the bar or the name of a bus to connect it there. Draw line (top left) joins two buses.',
      'Click a line or a device connector to move its route by hand',
      'A line can also be picked by its row in the Lines table.',
      'Shift+drag a box to pick several',
      'Undo (Ctrl+Z or Edit > Undo) takes a move back.',
      'Your layout is saved with the case.',
    ]) {
      expect(whole).toHaveTextContent(line);
    }
  });

  it('starts a drag on the press, so that a drag made of one pointer move moves the node', async () => {
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
    await waitFor(() => expect(screen.getByTestId('rf-root')).toBeInTheDocument());
    expect(screen.getByTestId('rf-root').getAttribute('data-drag-threshold')).toBe('0');
  });

  it('says that the diagram is locked, and how to unlock it, while the lock is on', async () => {
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
    await waitFor(() => expect(screen.getByTestId('rf-root')).toBeInTheDocument());
    expect(screen.queryByTestId('sld-canvas-locked')).toBeNull();

    fireEvent.click(screen.getByTestId('sld-canvas-lock'));
    // In place of the hint, which would promise a drag that does nothing.
    expect(screen.queryByTestId('sld-canvas-hint')).toBeNull();
    const notice = screen.getByRole('status');
    expect(notice).toBe(screen.getByTestId('sld-canvas-locked'));
    expect(notice).toHaveTextContent(
      'The diagram is locked. Nothing can be dragged or selected until you press the padlock button',
    );
    // The button's name says what the next press does.
    expect(screen.getByTestId('rf-root').getAttribute('data-lock-label')).toMatch(
      /^Unlock the diagram/,
    );
    // And the right-click menu does not offer a move that cannot happen.
    fireEvent.contextMenu(screen.getByTestId('bus-node-1'));
    expect(await screen.findByTestId('sld-context-move')).toHaveAttribute('aria-disabled', 'true');
    fireEvent.keyDown(screen.getByTestId('sld-context-menu'), { key: 'Escape' });

    fireEvent.click(screen.getByTestId('sld-canvas-lock'));
    expect(screen.queryByTestId('sld-canvas-locked')).toBeNull();
    expect(screen.getByTestId('sld-canvas-hint')).toBeInTheDocument();
    expect(screen.getByTestId('rf-root').getAttribute('data-lock-label')).toMatch(
      /^Lock the diagram/,
    );
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
  // ---- Fit view, Reset to auto-layout and the right-click menu -------------

  /** A loaded case with a saved layout for its buses (and drags of this visit, if asked). */
  function loadSavedCase(opts: { drags?: boolean } = {}) {
    const layout: SidecarLayout = {
      schema_version: '1',
      andes_version: '2.0.0',
      last_modified: '2026-10-01T00:00:00Z',
      coordinates: { '1': { x: 500, y: 40 }, '2': { x: 900, y: 80 } },
      non_bus_coordinates: {},
    };
    mockTopology = makeTopology([bus(1), bus(2)], [line(10, 1, 2)]);
    mockSidecar = layout;
    act(() => {
      useCaseStore.setState({
        selection: { primaryPath: parseWorkspacePath('synthetic.raw'), addfiles: [] },
        dragOverrides: opts.drags ? { '1': { x: 500, y: 40 }, '2': { x: 900, y: 80 } } : {},
      });
    });
    return layout;
  }

  async function renderLoaded() {
    render(withQueryClient(<SldCanvas />));
    await waitFor(() => expect(screen.getByTestId('bus-node-1')).toBeInTheDocument());
  }

  it('Fit view fits the viewport', async () => {
    loadSavedCase();
    await renderLoaded();
    act(() => __requestSldCommand('fit-view'));
    expect(fitViewSpy).toHaveBeenCalledTimes(1);
    // With room left on every side: the minimap and the zoom controls float
    // over the bottom corners (`fitPadding`).
    expect(fitViewSpy.mock.calls[0]?.[0]).toMatchObject({
      duration: expect.any(Number),
      padding: {
        top: expect.stringMatching(/^\d+px$/),
        right: expect.stringMatching(/^\d+px$/),
        bottom: expect.stringMatching(/^\d+px$/),
        left: expect.stringMatching(/^\d+px$/),
      },
    });
  });

  it('the Fit View button of the zoom controls fits as the command does', async () => {
    loadSavedCase();
    await renderLoaded();
    act(() => __requestSldCommand('fit-view'));
    const asTheCommand = fitViewSpy.mock.lastCall?.[0];
    expect(asTheCommand).toMatchObject({ padding: { bottom: expect.stringMatching(/^\d+px$/) } });

    fitViewSpy.mockClear();
    fireEvent.click(screen.getByTestId('sld-canvas-controls-fit'));
    // React Flow's button asks for its own fit, to the edges of the pane,
    // before it calls the canvas. A fit is made when the nodes are next
    // applied, with what was asked for last, so the last request is the fit.
    expect(fitViewSpy).toHaveBeenCalledTimes(2);
    expect(fitViewSpy.mock.lastCall?.[0]).toEqual(asTheCommand);
  });

  it('Reset to auto-layout forgets the drags, replaces the saved layout with an empty one, and offers Undo', async () => {
    const saved = loadSavedCase({ drags: true });
    const success = vi.spyOn(toast, 'success').mockReturnValue('id');
    await renderLoaded();
    act(() => __requestSldCommand('reset-layout'));

    // The drags are forgotten at once; the saved layout is replaced.
    expect(useCaseStore.getState().dragOverrides).toEqual({});
    expect(putSidecarSpy).toHaveBeenCalledTimes(1);
    const [vars, callbacks] = putSidecarSpy.mock.calls[0] ?? [];
    expect(vars.casePath).toBe('synthetic.raw');
    expect(vars.layout.coordinates).toEqual({});
    expect(vars.layout.non_bus_coordinates).toEqual({});
    // Said once the write has gone through, not before.
    expect(success).not.toHaveBeenCalled();
    act(() => callbacks.onSuccess());
    expect(success).toHaveBeenCalledWith(
      expect.stringMatching(/reset/i),
      expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }),
    );

    // Undo puts the drags and the saved layout back.
    const undo = success.mock.calls[0]?.[1]?.action?.onClick;
    act(() => undo?.());
    expect(useCaseStore.getState().dragOverrides).toEqual({
      '1': { x: 500, y: 40 },
      '2': { x: 900, y: 80 },
    });
    expect(putSidecarSpy).toHaveBeenCalledTimes(2);
    expect(putSidecarSpy.mock.calls[1]?.[0]).toEqual({ casePath: 'synthetic.raw', layout: saved });
  });

  it('Reset to auto-layout puts the drags back and says so when the layout cannot be replaced', async () => {
    loadSavedCase({ drags: true });
    const error = vi.spyOn(toast, 'error').mockReturnValue('id');
    await renderLoaded();
    act(() => __requestSldCommand('reset-layout'));
    expect(useCaseStore.getState().dragOverrides).toEqual({});
    const [, callbacks] = putSidecarSpy.mock.calls[0] ?? [];
    act(() => callbacks.onError(new Error('workspace is read-only')));
    expect(Object.keys(useCaseStore.getState().dragOverrides)).toEqual(['1', '2']);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('workspace is read-only'));
  });

  it('Reset to auto-layout with only drags of this visit writes nothing, and Undo restores them', async () => {
    mockTopology = makeTopology([bus(1), bus(2)], [line(10, 1, 2)]);
    const success = vi.spyOn(toast, 'success').mockReturnValue('id');
    act(() => {
      useCaseStore.setState({
        selection: { primaryPath: null, addfiles: [], blank: true },
        dragOverrides: { '1': { x: 7, y: 8 } },
      });
    });
    await renderLoaded();
    act(() => __requestSldCommand('reset-layout'));
    expect(useCaseStore.getState().dragOverrides).toEqual({});
    expect(putSidecarSpy).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledTimes(1);
    act(() => success.mock.calls[0]?.[1]?.action?.onClick());
    expect(useCaseStore.getState().dragOverrides).toEqual({ '1': { x: 7, y: 8 } });
  });

  it('Reset to auto-layout says so when there is nothing to reset', async () => {
    mockTopology = makeTopology([bus(1), bus(2)], [line(10, 1, 2)]);
    const info = vi.spyOn(toast, 'info').mockReturnValue('id');
    act(() => {
      useCaseStore.setState({
        selection: { primaryPath: parseWorkspacePath('synthetic.raw'), addfiles: [] },
      });
    });
    await renderLoaded();
    act(() => __requestSldCommand('reset-layout'));
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/already/i));
    expect(putSidecarSpy).not.toHaveBeenCalled();
  });

  it('reads a saved layout with no position in it as none: the diagram is laid out again, with no drift banner', async () => {
    mockTopology = makeTopology([bus(1), bus(2)], [line(10, 1, 2)]);
    mockSidecar = {
      schema_version: '1',
      andes_version: 'unknown',
      last_modified: '2026-10-01T00:00:00Z',
      coordinates: {},
      non_bus_coordinates: {},
    };
    act(() => {
      useCaseStore.setState({
        selection: { primaryPath: parseWorkspacePath('synthetic.raw'), addfiles: [] },
      });
    });
    await renderLoaded();
    // ELK ran for the buses, as it does for a case with no saved layout, and a
    // layout that holds nothing is not "the topology changed since it was saved".
    expect(elkLayout).toHaveBeenCalled();
    expect(screen.queryByTestId('sld-drift-banner')).toBeNull();
  });

  it('a right-click on a bus offers the bus menu, on a line the line menu, and on the canvas the canvas menu', async () => {
    loadSavedCase();
    await renderLoaded();
    const busWrapper = screen.getByTestId('bus-node-1').closest('[data-rf-node-id]') as HTMLElement;
    fireEvent.contextMenu(busWrapper);
    let menu = await screen.findByTestId('sld-context-menu');
    expect(within(menu).getByTestId('sld-context-menu-title')).toHaveTextContent('Bus b1 (idx 1)');
    expect(within(menu).getByTestId('sld-context-fault')).toBeInTheDocument();
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('sld-context-menu')).toBeNull());

    // A line: React Flow reports it from the edge, with the edge's own data.
    fireEvent.contextMenu(screen.getByTestId('edge-line-10'));
    menu = await screen.findByTestId('sld-context-menu');
    expect(within(menu).getByTestId('sld-context-menu-title')).toHaveTextContent('Line l10');
    expect(within(menu).getByTestId('sld-context-trip-line')).toBeInTheDocument();
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('sld-context-menu')).toBeNull());

    // Empty canvas: nothing from the earlier right-click is left over.
    fireEvent.contextMenu(screen.getByTestId('sld-canvas-surface'));
    menu = await screen.findByTestId('sld-context-menu');
    expect(within(menu).getByTestId('sld-context-menu-title')).toHaveTextContent('Diagram');
    expect(within(menu).getByTestId('sld-context-fit-view')).toBeInTheDocument();
    expect(within(menu).queryByTestId('sld-context-fault')).toBeNull();
  });

  it('a right-click on one of several picked nodes offers to line them up', async () => {
    loadSavedCase();
    await renderLoaded();
    act(() => useSldStore.getState().setPickedNodeIds(['1', '2']));
    const picked = screen.getByTestId('bus-node-1').closest('[data-rf-node-id]') as HTMLElement;
    fireEvent.contextMenu(picked);
    const menu = await screen.findByTestId('sld-context-menu');
    expect(within(menu).getByTestId('sld-context-menu-title')).toHaveTextContent(
      '2 elements picked',
    );
    expect(within(menu).getByTestId('sld-context-align-left')).toBeInTheDocument();
    // Not the menu of the one bus that was under the pointer.
    expect(within(menu).queryByTestId('sld-context-fault')).toBeNull();
  });

  it('the canvas menu tidies the diagram', async () => {
    const info = vi.spyOn(toast, 'info');
    loadSavedCase();
    await renderLoaded();
    fireEvent.contextMenu(screen.getByTestId('sld-canvas-surface'));
    const menu = await screen.findByTestId('sld-context-menu');
    await userEvent.click(within(menu).getByTestId('sld-context-tidy'));
    // The one line was routed as the diagram was drawn, so the tidy that
    // ran has nothing to change, and says so.
    expect(info).toHaveBeenCalledWith('The diagram is already tidy.', expect.anything());
    info.mockRestore();
  });

  it('a right-click inside the node search popover leaves the browser its own menu', async () => {
    loadSavedCase();
    await renderLoaded();
    fireEvent.click(screen.getByTestId('sld-node-search-trigger'));
    const input = await screen.findByTestId('sld-node-search-input');
    // The popover is portaled out of the canvas, though React still bubbles its
    // events to it. ``fireEvent`` returns false when a handler prevented the
    // default, which is what opening the diagram's menu does.
    expect(fireEvent.contextMenu(input)).toBe(true);
    expect(screen.queryByTestId('sld-context-menu')).toBeNull();
    // The diagram's own menu still opens from the canvas.
    fireEvent.contextMenu(screen.getByTestId('sld-canvas-surface'));
    expect(await screen.findByTestId('sld-context-menu')).toBeInTheDocument();
  });

  /** Press on `el` the way a finger or a pen does, and hold past Radix's long-press delay. */
  function longPress(el: Element, pointerType: 'touch' | 'pen') {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fireEvent.pointerDown(el, { pointerType, clientX: 20, clientY: 20 });
      act(() => {
        vi.advanceTimersByTime(800);
      });
    } finally {
      vi.useRealTimers();
    }
  }

  async function menuTitle(): Promise<string> {
    return (await screen.findByTestId('sld-context-menu-title')).textContent ?? '';
  }

  async function closeMenu() {
    fireEvent.keyDown(await screen.findByTestId('sld-context-menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('sld-context-menu')).toBeNull());
  }

  it.each(['touch', 'pen'] as const)(
    'a long press by %s offers the menu of what was pressed, whatever a right-click left behind',
    async (pointerType) => {
      loadSavedCase();
      await renderLoaded();
      const busWrapper = screen
        .getByTestId('bus-node-1')
        .closest('[data-rf-node-id]') as HTMLElement;

      // iOS reports no contextmenu event for a long press, so nothing but the
      // press itself can say what it landed on. A right-click on the bus first
      // leaves that bus behind as the last target.
      fireEvent.contextMenu(busWrapper);
      expect(await menuTitle()).toContain('Bus b1');
      await closeMenu();

      longPress(screen.getByTestId('sld-canvas-surface'), pointerType);
      expect(await menuTitle()).toBe('Diagram');
      await closeMenu();

      longPress(screen.getByTestId('edge-line-10'), pointerType);
      expect(await menuTitle()).toContain('Line l10');
      expect(screen.getByTestId('sld-context-trip-line')).toBeInTheDocument();
      await closeMenu();

      longPress(busWrapper, pointerType);
      expect(await menuTitle()).toContain('Bus b1');
      expect(screen.getByTestId('sld-context-fault')).toBeInTheDocument();
    },
  );

  it('a touch that dismisses the open menu does not change what the menu offers as it goes', async () => {
    loadSavedCase();
    await renderLoaded();
    longPress(
      screen.getByTestId('bus-node-1').closest('[data-rf-node-id]') as HTMLElement,
      'touch',
    );
    expect(await menuTitle()).toContain('Bus b1');
    // Radix closes a menu on a touch outside it at the click that follows, so the
    // menu is still up when the press lands; its items must not turn into the
    // canvas's under the finger.
    fireEvent.pointerDown(screen.getByTestId('sld-canvas-surface'), {
      pointerType: 'touch',
      clientX: 400,
      clientY: 400,
    });
    expect(screen.getByTestId('sld-context-menu-title')).toHaveTextContent('Bus b1');
  });

  it('the canvas menu runs Fit view', async () => {
    loadSavedCase();
    await renderLoaded();
    fireEvent.contextMenu(screen.getByTestId('sld-canvas-surface'));
    fireEvent.click(await screen.findByTestId('sld-context-fit-view'));
    await waitFor(() => expect(fitViewSpy).toHaveBeenCalledTimes(1));
  });

  it('the canvas menu sets how device connectors are drawn, and shows the choice', async () => {
    const info = vi.spyOn(toast, 'info').mockReturnValue('id');
    try {
      loadSavedCase();
      await renderLoaded();
      fireEvent.contextMenu(screen.getByTestId('sld-canvas-surface'));
      const elbow = await screen.findByTestId('sld-context-connectors-elbow');
      expect(elbow).toHaveAttribute('aria-checked', 'false');
      fireEvent.click(elbow);
      await waitFor(() => expect(useCaseStore.getState().connectorStyle).toBe('elbow'));
      // It says what changed: on a diagram whose devices all stand square
      // over their taps nothing moves.
      expect(info).toHaveBeenCalledWith(
        'Device connectors turn at a right angle',
        expect.objectContaining({ description: expect.stringContaining('Saved with the layout') }),
      );

      fireEvent.contextMenu(screen.getByTestId('sld-canvas-surface'));
      expect(await screen.findByTestId('sld-context-connectors-elbow')).toHaveAttribute(
        'aria-checked',
        'true',
      );
    } finally {
      info.mockRestore();
      act(() => useCaseStore.setState({ connectorStyle: null }));
    }
  });
});
