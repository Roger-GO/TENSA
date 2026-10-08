/**
 * How the canvas gets a diagram that is too small to read back to a size it
 * can be read at.
 *
 * A diagram is fitted to its pane when it opens, and a tall diagram in a
 * short pane comes out at a fifth of full size. The canvas then says so above
 * the diagram and offers a button that zooms to full size, a pick made away
 * from the diagram (a table row, the search) is shown at full size, and a
 * click on the diagram itself keeps the zoom.
 *
 * The canvas is rendered against a stand-in for React Flow that records the
 * nodes it is asked to draw and hands back the handler a click calls, with a
 * zoom the test sets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

interface DrawnNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  initialWidth?: number;
  initialHeight?: number;
  data: Record<string, unknown>;
}
type Change = {
  id: string;
  type: 'dimensions';
  dimensions: { width: number; height: number };
};

const { view, setCenterSpy, zoomToSpy } = vi.hoisted(() => ({
  view: { zoom: 1 },
  setCenterSpy: vi.fn(),
  zoomToSpy: vi.fn(),
}));

const drawn: {
  nodes: DrawnNode[];
  onNodesChange: ((changes: Change[]) => void) | null;
  onNodeClick: ((event: unknown, node: DrawnNode) => void) | null;
} = { nodes: [], onNodesChange: null, onNodeClick: null };

vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: {
    nodes: DrawnNode[];
    onNodesChange: (changes: Change[]) => void;
    onNodeClick: (event: unknown, node: DrawnNode) => void;
  }) => {
    drawn.nodes = props.nodes;
    drawn.onNodesChange = props.onNodesChange;
    drawn.onNodeClick = props.onNodeClick;
    return null;
  },
  ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
  Handle: () => null,
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  BaseEdge: () => null,
  BackgroundVariant: { Lines: 'lines', Dots: 'dots', Cross: 'cross' },
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
  SelectionMode: { Partial: 'partial', Full: 'full' },
  useStore: (selector: (s: { transform: [number, number, number] }) => unknown) =>
    selector({ transform: [0, 0, view.zoom] }),
  useReactFlow: () => ({
    setCenter: setCenterSpy,
    zoomTo: zoomToSpy,
    getZoom: () => view.zoom,
    getNodes: () => [],
    fitView: vi.fn(),
    screenToFlowPosition: (p: { x: number; y: number }) => p,
  }),
}));

// Every case here opens with a saved layout that places its buses, so ELK
// never runs.
vi.mock('@/components/sld/elkClient', () => ({
  elkLayout: vi.fn(async () => ({ children: [] })),
}));

import { SldCanvas } from '@/components/sld/SldCanvas';
import { __clearAllPendingForTests, buildSidecarLayout } from '@/components/sld/sidecar';
import { FULL_ZOOM, LEGIBLE_ZOOM } from '@/components/sld/zoom';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { useSldStore } from '@/store/sld';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { SidecarLayout, TopologyEntry, TopologySummary } from '@/api/types';

let mockTopology: TopologySummary | null = null;
let mockSidecar: SidecarLayout | null = null;

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useGetSidecar: () => ({ data: mockSidecar, isLoading: false, isError: false, error: null }),
    usePutSidecar: () => ({ mutate: vi.fn() }),
    useCurrentTopology: () => mockTopology,
    // The fields of each model: only a draft on the diagram is checked against them.
    useTopologySchema: () => ({ data: undefined }),
    useConnectivity: () => ({
      data: null,
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
  };
});

function entry(idx: string | number, kind: string, params: TopologyEntry['params']): TopologyEntry {
  return { idx, name: String(idx), kind, params };
}

/** Two buses one above the other, a line between them, a load beside the lower one. */
function pair(): TopologySummary {
  return {
    state: 'pre-setup',
    buses: [entry(1, 'Bus', {}), entry(2, 'Bus', {})],
    lines: [entry('L', 'Line', { bus1: 1, bus2: 2 })],
    transformers: [],
    generators: [],
    loads: [{ idx: 'PQ', name: 'Mill', kind: 'PQ', params: { bus: 2 } }],
    shunts: [],
    controllers: [],
  };
}

/** How far the tall diagram of a short pane is zoomed out: a fifth of full size. */
const FITTED_TO_A_SHORT_PANE = 0.19;

const node = (id: string): DrawnNode => {
  const found = drawn.nodes.find((n) => n.id === id);
  if (found === undefined) throw new Error(`no node ${id}`);
  return found;
};

/** Open the case at `zoom`, with the load measured at 40 by 30. */
async function drawAt(zoom: number): Promise<void> {
  view.zoom = zoom;
  useCaseStore.getState().setCase({ primaryPath: parseWorkspacePath('pair.xlsx'), addfiles: [] });
  render(<SldCanvas />);
  await waitFor(() => expect(drawn.nodes.length).toBeGreaterThan(0));
  act(() =>
    drawn.onNodesChange?.([
      { id: 'load-PQ', type: 'dimensions', dimensions: { width: 40, height: 30 } },
    ]),
  );
}

/** The middle of the load's box: it is placed at (150, 120) and measured at 40 by 30. */
const LOAD_MIDDLE = { x: 170, y: 135 };

beforeEach(() => {
  mockTopology = pair();
  mockSidecar = buildSidecarLayout(
    { '1': { x: 0, y: 0 }, '2': { x: 0, y: 200 } },
    { nonBusCoords: { load: { PQ: { x: 150, y: 120, bus: '2' } } } },
  );
  drawn.nodes = [];
  setCenterSpy.mockClear();
  zoomToSpy.mockClear();
  useSessionStore.setState({ sessionId: parseSessionId('sess-zoom') });
  useCaseStore.getState().clearCase();
  useSldStore.getState().clearSelectedNodeId();
});

afterEach(() => {
  cleanup();
  __clearAllPendingForTests();
  useCaseStore.getState().clearCase();
  useSldStore.getState().clearSelectedNodeId();
});

describe('a diagram too small to read', () => {
  it('says so above the diagram, with the zoom and the ways to get closer', async () => {
    await drawAt(FITTED_TO_A_SHORT_PANE);
    const notice = screen.getByTestId('sld-canvas-too-small');
    expect(notice).toHaveTextContent('The diagram is zoomed out to 19%, too small to read.');
    expect(notice).toHaveTextContent('Press Zoom to 100%');
    expect(notice).toHaveTextContent('pick a bus, a device or a line in a table below');
    expect(screen.getByRole('button', { name: 'Zoom to 100%' })).toBeInTheDocument();
    // The line it stands in for is about dragging, which cannot be aimed yet.
    expect(screen.queryByTestId('sld-canvas-hint')).not.toBeInTheDocument();
  });

  it('says nothing of it, and offers no button, once the names can be read', async () => {
    await drawAt(LEGIBLE_ZOOM);
    expect(screen.getByTestId('sld-canvas-hint')).toBeInTheDocument();
    expect(screen.queryByTestId('sld-canvas-too-small')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sld-zoom-readable')).not.toBeInTheDocument();
  });

  it('zooms to full size where the view is when nothing is selected', async () => {
    await drawAt(FITTED_TO_A_SHORT_PANE);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom to 100%' }));
    expect(zoomToSpy).toHaveBeenCalledWith(FULL_ZOOM, expect.objectContaining({ duration: 250 }));
    expect(setCenterSpy).not.toHaveBeenCalled();
  });

  it('names the selected device on the button, and zooms to full size on its middle', async () => {
    await drawAt(FITTED_TO_A_SHORT_PANE);
    act(() => drawn.onNodeClick?.({}, node('load-PQ')));
    setCenterSpy.mockClear();

    const button = screen.getByRole('button', { name: 'Zoom to Mill' });
    expect(screen.getByTestId('sld-canvas-too-small')).toHaveTextContent('Press Zoom to Mill');
    fireEvent.click(button);
    expect(setCenterSpy).toHaveBeenCalledWith(
      LOAD_MIDDLE.x,
      LOAD_MIDDLE.y,
      expect.objectContaining({ zoom: FULL_ZOOM }),
    );
    expect(zoomToSpy).not.toHaveBeenCalled();
  });
});

describe('a bus or device picked away from the diagram', () => {
  it('is shown at full size when the diagram is too small to read', async () => {
    await drawAt(FITTED_TO_A_SHORT_PANE);
    // What a click on a row of the Loads table writes.
    act(() => useSldStore.getState().setSelectedNodeId('load-PQ'));
    expect(setCenterSpy).toHaveBeenCalledTimes(1);
    expect(setCenterSpy).toHaveBeenCalledWith(
      LOAD_MIDDLE.x,
      LOAD_MIDDLE.y,
      expect.objectContaining({ zoom: FULL_ZOOM }),
    );
  });

  it('is centred at the zoom the diagram has when that can be read', async () => {
    await drawAt(0.8);
    act(() => useSldStore.getState().setSelectedNodeId('load-PQ'));
    expect(setCenterSpy).toHaveBeenCalledWith(
      LOAD_MIDDLE.x,
      LOAD_MIDDLE.y,
      expect.objectContaining({ zoom: 0.8 }),
    );
  });

  it('shows the symbol of its unit for a machine or a controller, which has no node of its own', async () => {
    // A generator with its machine and a governor: one symbol, placed at
    // (150, -90) and measured at 80 by 41.
    mockTopology = {
      ...pair(),
      generators: [entry(1, 'PV', { bus: 1 }), entry('GENROU_1', 'GENROU', { bus: 1, gen: 1 })],
      controllers: [entry('TGOV1_1', 'TGOV1', { syn: 'GENROU_1' })],
    };
    mockSidecar = buildSidecarLayout(
      { '1': { x: 0, y: 0 }, '2': { x: 0, y: 200 } },
      {
        nonBusCoords: {
          load: { PQ: { x: 150, y: 120, bus: '2' } },
          generator: { '1': { x: 150, y: -90, bus: '1' } },
        },
      },
    );
    await drawAt(FITTED_TO_A_SHORT_PANE);
    act(() =>
      drawn.onNodesChange?.([
        { id: 'generator-1', type: 'dimensions', dimensions: { width: 80, height: 41 } },
      ]),
    );
    expect(drawn.nodes.map((n) => n.id)).not.toContain('generator-GENROU_1');
    // What a row of the Machines table writes, then a row of the governors.
    for (const picked of ['generator-GENROU_1', 'controller-TGOV1-TGOV1_1']) {
      setCenterSpy.mockClear();
      act(() => useSldStore.getState().setSelectedNodeId(picked));
      expect(setCenterSpy).toHaveBeenCalledTimes(1);
      expect(setCenterSpy).toHaveBeenCalledWith(
        190,
        -69.5,
        expect.objectContaining({ zoom: FULL_ZOOM }),
      );
      expect((node('generator-1') as { selected?: boolean }).selected).toBe(true);
    }
    // And the button above the diagram zooms to the same symbol.
    setCenterSpy.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom to 1' }));
    expect(setCenterSpy).toHaveBeenCalledWith(190, -69.5, expect.objectContaining({ zoom: 1 }));
  });

  it('keeps the zoom when it is clicked on the diagram itself, however small', async () => {
    await drawAt(FITTED_TO_A_SHORT_PANE);
    act(() => drawn.onNodeClick?.({}, node('load-PQ')));
    expect(useSldStore.getState().selectedNodeId).toBe('load-PQ');
    expect(setCenterSpy).toHaveBeenCalledWith(
      LOAD_MIDDLE.x,
      LOAD_MIDDLE.y,
      expect.objectContaining({ zoom: FITTED_TO_A_SHORT_PANE }),
    );
  });
});
