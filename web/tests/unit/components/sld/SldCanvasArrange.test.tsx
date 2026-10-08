/**
 * Arranging the diagram: Tidy diagram, Tidy and re-layout, Align and
 * Distribute, Snap to grid, and taking any of them, or a move, back.
 *
 * The canvas is rendered against a stand-in for React Flow that records what
 * it is asked to draw (every node's position and whether it shows as
 * selected, every edge's route) and hands back the handlers a test needs to
 * move a node, pick several, or lock the diagram, the way React Flow does.
 * A command is posted the way the palette, a shortcut and the buttons post
 * it (`__requestSldCommand`), or a button of the canvas is pressed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

interface DrawnNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  draggable?: boolean;
  selected?: boolean;
  data: Record<string, unknown>;
}
interface DrawnEdge {
  id: string;
  type?: string;
  source: string;
  target: string;
  data?: Record<string, unknown>;
}
type Change =
  | { id: string; type: 'position'; position: { x: number; y: number }; dragging: boolean }
  | { id: string; type: 'select'; selected: boolean };

type DragHandler = (
  event: unknown,
  node: Pick<DrawnNode, 'id' | 'position'>,
  nodes: Pick<DrawnNode, 'id' | 'position'>[],
) => void;

/** What the canvas last asked React Flow to draw, and the handlers it gave it. */
const drawn: {
  nodes: DrawnNode[];
  edges: DrawnEdge[];
  onNodesChange: ((changes: Change[]) => void) | null;
  onNodeDragStart: DragHandler | null;
  onNodeDragStop: DragHandler | null;
  onInteractiveChange: ((interactive: boolean) => void) | null;
  snapToGrid: boolean | undefined;
  snapGrid: [number, number] | undefined;
  nodesDraggable: boolean | undefined;
} = {
  nodes: [],
  edges: [],
  onNodesChange: null,
  onNodeDragStart: null,
  onNodeDragStop: null,
  onInteractiveChange: null,
  snapToGrid: undefined,
  snapGrid: undefined,
  nodesDraggable: undefined,
};

vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: {
    nodes: DrawnNode[];
    edges: DrawnEdge[];
    onNodesChange: (changes: Change[]) => void;
    onNodeDragStart: DragHandler;
    onNodeDragStop: DragHandler;
    snapToGrid?: boolean;
    snapGrid?: [number, number];
    nodesDraggable?: boolean;
    children?: ReactNode;
  }) => {
    drawn.nodes = props.nodes;
    drawn.edges = props.edges;
    drawn.onNodesChange = props.onNodesChange;
    drawn.onNodeDragStart = props.onNodeDragStart;
    drawn.onNodeDragStop = props.onNodeDragStop;
    drawn.snapToGrid = props.snapToGrid;
    drawn.snapGrid = props.snapGrid;
    drawn.nodesDraggable = props.nodesDraggable;
    return props.children;
  },
  ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
  Handle: () => null,
  Background: () => null,
  // The lock button of the real controls reports each press through this.
  Controls: (props: { onInteractiveChange?: (interactive: boolean) => void }) => {
    drawn.onInteractiveChange = props.onInteractiveChange ?? null;
    return null;
  },
  MiniMap: () => null,
  BaseEdge: () => null,
  BackgroundVariant: { Lines: 'lines', Dots: 'dots', Cross: 'cross' },
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
  SelectionMode: { Partial: 'partial', Full: 'full' },
  useStore: (selector: (s: { transform: [number, number, number] }) => unknown) =>
    selector({ transform: [0, 0, 1] }),
  useReactFlow: () => ({
    setCenter: vi.fn(),
    getZoom: () => 1,
    getNodes: () => [],
    fitView: vi.fn(),
    screenToFlowPosition: (p: { x: number; y: number }) => p,
  }),
}));

// An ELK that lays the buses out two to a row, a little off the grid. The
// canvas asks it for the places of the buses only: the devices and the
// routes are arranged around them afterwards (`useAutoLayout`).
vi.mock('@/components/sld/elkClient', () => ({
  elkLayout: vi.fn(async (graph: { children?: { id: string }[] }) => ({
    children: (graph.children ?? []).map((c, i) => ({
      id: c.id,
      x: 300 * (i % 2) + 5,
      y: 220 * Math.floor(i / 2) + 7,
    })),
  })),
}));

/**
 * What the next tidy is made to answer on top of what it worked out: the
 * branches it found no way for, whether the steps ran out, and whether the
 * diagram was too large to route at all. A diagram that does any of these is
 * a large or a walled-in one; here the answer is changed and the canvas is
 * what is under test.
 */
const forced = vi.hoisted(() => ({
  unrouted: [] as string[],
  outOfSteps: false,
  tooLarge: false,
  /**
   * The picture finds no route of its own while this is set: a branch whose
   * route is broken is drawn the plain way from bar to bar, as on a diagram
   * where there is no way round.
   */
  noRouting: false,
  /**
   * The job the next tidy is handed in place of a plan made within the
   * call: what a diagram large enough for the worker gets, which jsdom has
   * none of.
   */
  job: null as { done: Promise<unknown>; cancel: () => void } | null,
  /**
   * What the next plan is refused for (`TidyPlan.refused`): what it would
   * draw over what, on a diagram where a tidy cannot be mended.
   */
  refused: null as string[] | null,
  /** The lines and connectors that plan would draw over something (`TidyPlan.blamed`). */
  blamed: [] as string[],
  /**
   * The picture passes no place a node is dropped in while this is set
   * (`drawsClear`), as where the connector of a device has no way to its
   * bar from anywhere near.
   */
  noClearPlace: false,
}));

vi.mock('@/components/sld/picture', async () => {
  const actual = await vi.importActual<typeof import('@/components/sld/picture')>(
    '@/components/sld/picture',
  );
  const drawsClear: typeof actual.drawsClear = (...args) =>
    forced.noClearPlace ? () => false : actual.drawsClear(...args);
  return { ...actual, drawsClear };
});

vi.mock('@/components/sld/tidyPlan', async () => {
  const actual = await vi.importActual<typeof import('@/components/sld/tidyPlan')>(
    '@/components/sld/tidyPlan',
  );
  return {
    ...actual,
    planTidy: (...args: Parameters<typeof actual.planTidy>) => {
      const plan = actual.planTidy(...args);
      const branches = plan.edges.filter((edge) => edge.type !== 'stub').map((edge) => edge.id);
      if (forced.tooLarge) {
        return {
          ...plan,
          tidied: { routes: new Map(), unrouted: branches, steps: 0, tooLarge: true as const },
        };
      }
      for (const id of forced.unrouted) plan.tidied.routes.delete(id);
      return {
        ...plan,
        tidied: {
          ...plan.tidied,
          unrouted: [...plan.tidied.unrouted, ...forced.unrouted],
          ...(forced.outOfSteps ? { outOfSteps: true as const } : {}),
        },
        ...(forced.refused !== null ? { refused: forced.refused, blamed: forced.blamed } : {}),
      };
    },
  };
});

vi.mock('@/components/sld/tidyClient', async () => {
  const actual = await vi.importActual<typeof import('@/components/sld/tidyClient')>(
    '@/components/sld/tidyClient',
  );
  return {
    ...actual,
    startTidy: vi.fn((...args: Parameters<typeof actual.startTidy>) => {
      const job = forced.job;
      if (job === null) return actual.startTidy(...args);
      forced.job = null;
      return job as ReturnType<typeof actual.startTidy>;
    }),
  };
});

vi.mock('@/components/sld/routing', async () => {
  const actual = await vi.importActual<typeof import('@/components/sld/routing')>(
    '@/components/sld/routing',
  );
  const routeDiagram: typeof actual.routeDiagram = (nodes, edges, options) =>
    actual.routeDiagram(nodes, edges, forced.noRouting ? { ...options, steps: 0 } : options);
  return { ...actual, routeDiagram };
});

import { SldCanvas } from '@/components/sld/SldCanvas';
import { GRID_STEP } from '@/components/sld/tidy';
import { planTidy } from '@/components/sld/tidyPlan';
import { startTidy } from '@/components/sld/tidyClient';
import { defaultBarLengths } from '@/components/sld/graph';
import { __clearAllPendingForTests, captureLayout, parseSidecar } from '@/components/sld/sidecar';
import { useCaseStore } from '@/store/case';
import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layout';
import { useLayoutHistoryStore } from '@/store/layoutHistory';
import { usePflowStore } from '@/store/pflow';
import { useSessionStore } from '@/store/session';
import { __requestSldCommand, useSldStore } from '@/store/sld';
import type { SldCommand } from '@/store/sld';
import { toast } from '@/lib/toast';
import { parseRunId, parseSessionId, parseWorkspacePath } from '@/api/types';
import type { SidecarLayout, TopologyEntry, TopologySummary } from '@/api/types';
import { lineFlow } from '../../helpers/lineFlow';

let mockTopology: TopologySummary | null = null;
let mockSidecar: SidecarLayout | null = null;
const putSidecarSpy = vi.fn();

vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useGetSidecar: () => ({ data: mockSidecar, isLoading: false, isError: false, error: null }),
    usePutSidecar: () => ({ mutate: putSidecarSpy }),
    useCurrentTopology: () => mockTopology,
    // The fields of each model: only a draft on the diagram is checked against them.
    useTopologySchema: () => ({ data: undefined }),
    useEditElements: () => ({ mutate: vi.fn(), isPending: false }),
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
  return { idx, name: `${kind} ${idx}`, kind, params };
}

/**
 * Four buses, two to a row, with a line from bus 1 to each of the others and
 * one from 2 to 4; a machine on bus 1 and a load on bus 4.
 */
function square(): TopologySummary {
  return {
    state: 'pre-setup',
    buses: [1, 2, 3, 4].map((i) => entry(i, 'Bus', {})),
    lines: [
      entry('L12', 'Line', { bus1: 1, bus2: 2 }),
      entry('L13', 'Line', { bus1: 1, bus2: 3 }),
      entry('L14', 'Line', { bus1: 1, bus2: 4 }),
    ],
    transformers: [entry('T24', 'Line', { bus1: 2, bus2: 4 })],
    generators: [entry('G1', 'GENROU', { bus: 1 })],
    loads: [entry('PQ_1', 'PQ', { bus: 4 })],
    shunts: [],
    controllers: [],
  };
}

type Points = [number, number][];

/** Every node's position and every branch's stored route, as last drawn. */
function picture() {
  return {
    positions: Object.fromEntries(drawn.nodes.map((n) => [n.id, { ...n.position }])),
    stored: Object.fromEntries(
      drawn.edges
        .filter((e) => e.type !== 'stub')
        .map((e) => [e.id, (e.data?.bendPoints as Points | undefined) ?? null]),
    ),
  };
}

/** The points each branch is drawn through. */
function routes(): Record<string, Points> {
  return Object.fromEntries(
    drawn.edges
      .filter((e) => e.type !== 'stub')
      .map((e) => [e.id, (e.data?.route as { points: Points }).points]),
  );
}

function positionOf(id: string): { x: number; y: number } {
  const node = drawn.nodes.find((n) => n.id === id);
  if (node === undefined) throw new Error(`no node ${id}`);
  return { ...node.position };
}

function open(casePath: string): void {
  useCaseStore.getState().setCase({ primaryPath: parseWorkspacePath(casePath), addfiles: [] });
}

async function draw(): Promise<void> {
  render(<SldCanvas />);
  await waitFor(() => expect(drawn.nodes.length).toBeGreaterThan(0));
}

function run(command: SldCommand): void {
  act(() => __requestSldCommand(command));
}

/** A whole pointer drag of `id` to `to`, as React Flow reports it. */
function dragTo(id: string, to: { x: number; y: number }): void {
  const from = { id, position: positionOf(id) };
  act(() => {
    drawn.onNodeDragStart?.({}, from, [from]);
    drawn.onNodesChange?.([{ id, type: 'position', position: to, dragging: true }]);
    drawn.onNodesChange?.([{ id, type: 'position', position: to, dragging: false }]);
    drawn.onNodeDragStop?.({}, { id, position: to }, [{ id, position: to }]);
  });
}

/** A press of an arrow key on `id`: one move, with no drag in it. */
function nudgeTo(id: string, to: { x: number; y: number }): void {
  act(() => {
    drawn.onNodesChange?.([{ id, type: 'position', position: to, dragging: false }]);
  });
}

/** Pick `ids` together, as a box drawn with Shift held does. */
function pick(...ids: string[]): void {
  act(() => {
    drawn.onNodesChange?.(ids.map((id) => ({ id, type: 'select', selected: true })));
  });
}

const history = () => useLayoutHistoryStore.getState();
const labels = () => history().past.map((step) => step.label);

/** The layout the canvas last wrote beside the case. */
async function written(): Promise<SidecarLayout> {
  await waitFor(() => expect(putSidecarSpy).toHaveBeenCalled(), { timeout: 3000 });
  const calls = putSidecarSpy.mock.calls as [{ casePath: string; layout: SidecarLayout }][];
  return calls[calls.length - 1]![0].layout;
}

/** Whether every run of a route is level or upright. */
function squareCornered(points: Points): boolean {
  return points.slice(1).every((p, i) => p[0] === points[i]![0] || p[1] === points[i]![1]);
}

/** How long two routes lie on top of each other for. */
function overlap(a: Points, b: Points): number {
  let shared = 0;
  for (let i = 1; i < a.length; i += 1) {
    for (let k = 1; k < b.length; k += 1) {
      const [p, q, r, s] = [a[i - 1]!, a[i]!, b[k - 1]!, b[k]!];
      for (const axis of [0, 1] as const) {
        const other = axis === 0 ? 1 : 0;
        if (p[other] !== q[other] || r[other] !== s[other] || p[other] !== r[other]) continue;
        const from = Math.max(Math.min(p[axis], q[axis]), Math.min(r[axis], s[axis]));
        const to = Math.min(Math.max(p[axis], q[axis]), Math.max(r[axis], s[axis]));
        shared += Math.max(0, to - from);
      }
    }
  }
  return shared;
}

/**
 * The route the line from bus 1 to bus 4 has in `untidy()`: down, across,
 * down again and across again, where one turn would do.
 */
const JOGGED: Points = [
  [64, 3],
  [64, 112],
  [240, 112],
  [240, 160],
  [320, 160],
  [320, 227],
];

/**
 * Open `square()` from a layout that was saved with a line the long way
 * round: the diagram as it opens with no layout, but with a jog in the line
 * from bus 1 to bus 4 that nothing calls for. No line of it is drawn over
 * anything, so it is drawn as it was saved, and a tidy has something to do.
 */
async function openUntidy(): Promise<void> {
  open('square.xlsx');
  await draw();
  const layout = captureLayout(
    {
      nodes: drawn.nodes,
      edges: drawn.edges.map((e) =>
        e.id === 'line-L14' ? { ...e, data: { ...e.data, bendPoints: JOGGED } } : e,
      ),
    },
    mockTopology!,
    null,
  );
  cleanup();
  drawn.nodes = [];
  useCaseStore.getState().clearCase();
  history().clear();
  mockSidecar = parseSidecar(JSON.parse(JSON.stringify(layout)));
  open('square.xlsx');
  await draw();
  expect(routes()['line-L14']).toEqual(JOGGED);
  expect(putSidecarSpy).not.toHaveBeenCalled();
}

beforeEach(() => {
  mockTopology = square();
  mockSidecar = null;
  putSidecarSpy.mockClear();
  drawn.nodes = [];
  drawn.edges = [];
  drawn.onNodesChange = null;
  drawn.onInteractiveChange = null;
  useSessionStore.setState({ sessionId: parseSessionId('sess-arrange') });
  useCaseStore.getState().clearCase();
  useSldStore.setState({
    selectedNodeId: null,
    pickedNodeIds: [],
    pickedCount: 0,
    diagramLocked: false,
  });
  forced.unrouted = [];
  forced.outOfSteps = false;
  forced.tooLarge = false;
  forced.noRouting = false;
  forced.refused = null;
  forced.blamed = [];
  forced.noClearPlace = false;
  forced.job = null;
  vi.mocked(startTidy).mockClear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
  usePflowStore.setState({ lastRun: null });
  history().clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  __clearAllPendingForTests();
  useCaseStore.getState().clearCase();
});

describe('a case that opens with no saved layout', () => {
  it('is arranged already: no line lies on another, and a tidy finds nothing to do', async () => {
    const info = vi.spyOn(toast, 'info');
    open('square.xlsx');
    await draw();
    const opened = { picture: picture(), routes: routes() };
    // Every branch has its route, drawn as it is stored.
    const ids = Object.keys(opened.routes);
    expect(ids).toHaveLength(4);
    for (const id of ids) {
      expect(squareCornered(opened.routes[id]!), id).toBe(true);
      expect(opened.routes[id], id).toEqual(opened.picture.stored[id]);
      for (const other of ids) {
        if (id < other) {
          expect(overlap(opened.routes[id]!, opened.routes[other]!), `${id} ${other}`).toBe(0);
        }
      }
    }
    // The buses are on the grid, and the devices beside their bars.
    for (const id of ['1', '2', '3', '4']) {
      expect(positionOf(id).x % GRID_STEP, id).toBe(0);
      expect(positionOf(id).y % GRID_STEP, id).toBe(0);
    }

    for (const command of ['tidy', 'tidy-relayout'] as const) {
      info.mockClear();
      run(command);
      expect(info, command).toHaveBeenCalledWith('The diagram is already tidy.', expect.anything());
    }
    expect(picture()).toEqual(opened.picture);
    expect(labels()).toEqual([]);
    // A diagram that only stands in its automatic arrangement is not written.
    expect(putSidecarSpy).not.toHaveBeenCalled();
  });
});

describe('a bus or device that is dropped on something', () => {
  /** The box a node is drawn in, by the size it was built with. */
  function boxOf(id: string) {
    const node = drawn.nodes.find((n) => n.id === id)! as DrawnNode & {
      initialWidth?: number;
      initialHeight?: number;
    };
    return {
      left: node.position.x,
      right: node.position.x + (node.initialWidth ?? 0),
      top: node.position.y,
      bottom: node.position.y + (node.initialHeight ?? 0),
    };
  }

  it('is put in the nearest free place, says so, and goes back with one Undo', async () => {
    const info = vi.spyOn(toast, 'info');
    open('square.xlsx');
    await draw();
    const before = positionOf('load-PQ_1');
    const machine = positionOf('generator-G1');

    // The load on the machine of bus 1.
    dragTo('load-PQ_1', { x: machine.x + 12, y: machine.y + 6 });

    const [load, other] = [boxOf('load-PQ_1'), boxOf('generator-G1')];
    const apart =
      load.left >= other.right ||
      other.left >= load.right ||
      load.top >= other.bottom ||
      other.top >= load.bottom;
    expect(apart).toBe(true);
    expect(positionOf('load-PQ_1')).not.toEqual({ x: machine.x + 12, y: machine.y + 6 });
    expect(info).toHaveBeenCalledWith(
      'Moved to the nearest free place',
      expect.objectContaining({
        description: expect.stringContaining('dropped on another symbol') as string,
      }),
    );
    // It is the place that is kept, and one move for Undo.
    expect(useCaseStore.getState().dragOverrides['load-PQ_1']).toEqual(positionOf('load-PQ_1'));
    expect(labels()).toHaveLength(1);
    run('undo-layout');
    await waitFor(() => expect(positionOf('load-PQ_1')).toEqual(before));
  });

  it('stays where it is dropped on free ground, and nothing is said', async () => {
    const info = vi.spyOn(toast, 'info');
    open('square.xlsx');
    await draw();
    const at = positionOf('3');
    dragTo('3', { x: at.x + 16, y: at.y + 8 });
    expect(positionOf('3')).toEqual({ x: at.x + 16, y: at.y + 8 });
    expect(info).not.toHaveBeenCalledWith('Moved to the nearest free place', expect.anything());
  });

  it('is put beside a line that has no way round it, where it was dropped on the line', async () => {
    const info = vi.spyOn(toast, 'info');
    open('square.xlsx');
    await draw();
    // The machine on the line that leaves bus 1 downwards, on a diagram
    // where no way round it is found: by the boxes it is on free ground,
    // and the picture has the line through it.
    forced.noRouting = true;
    dragTo('generator-G1', { x: 20, y: 60 });
    expect(positionOf('generator-G1')).not.toEqual({ x: 20, y: 60 });
    expect(info).toHaveBeenCalledWith(
      'Moved to the nearest free place',
      expect.objectContaining({
        description: expect.stringContaining('had no way that is clear') as string,
      }),
    );
    // No line is left through it for a tidy to put right.
    await waitFor(() => expect(labels()).toHaveLength(1));
    expect(screen.queryByTestId('sld-tidy-count')).not.toBeInTheDocument();
    const machine = boxOf('generator-G1');
    for (const [id, points] of Object.entries(routes())) {
      for (const [i, b] of points.entries()) {
        const a = points[i - 1];
        if (a === undefined) continue;
        const through =
          Math.max(a[0], b[0]) > machine.left &&
          Math.min(a[0], b[0]) < machine.right &&
          Math.max(a[1], b[1]) > machine.top &&
          Math.min(a[1], b[1]) < machine.bottom;
        expect(through, id).toBe(false);
      }
    }
  });

  it('goes back where it stood, and says so, where no place near can be drawn', async () => {
    const info = vi.spyOn(toast, 'info');
    open('square.xlsx');
    await draw();
    const before = picture();
    forced.noClearPlace = true;
    const at = positionOf('3');
    dragTo('3', { x: at.x + 16, y: at.y + 8 });
    expect(info).toHaveBeenCalledWith(
      'Put back where it was',
      expect.objectContaining({
        description: expect.stringContaining('the move was not made') as string,
      }),
    );
    expect(info).not.toHaveBeenCalledWith('Moved to the nearest free place', expect.anything());
    expect(picture().positions).toEqual(before.positions);
    // A move that was not made is no step for Undo, and is not written.
    expect(labels()).toEqual([]);
    expect(putSidecarSpy).not.toHaveBeenCalled();
    // A press of an arrow key is held to the same.
    nudgeTo('3', { x: at.x + 8, y: at.y });
    expect(positionOf('3')).toEqual(at);
    expect(labels()).toEqual([]);
  });
});

describe('Tidy diagram', () => {
  it('routes every branch afresh, moves nothing, and writes the result beside the case', async () => {
    const success = vi.spyOn(toast, 'success');
    await openUntidy();
    const before = picture();

    fireEvent.click(screen.getByTestId('sld-tidy'));

    await waitFor(() => expect(picture().stored).not.toEqual(before.stored));
    const after = picture();
    expect(after.positions).toEqual(before.positions);
    const tidy = routes();
    for (const [id, points] of Object.entries(tidy)) {
      expect(squareCornered(points), id).toBe(true);
      // What was chosen is what is drawn: the connection pass moves no tap.
      expect(points, id).toEqual(after.stored[id]);
    }
    const ids = Object.keys(tidy);
    for (const a of ids) {
      for (const b of ids) if (a < b) expect(overlap(tidy[a]!, tidy[b]!), `${a} ${b}`).toBe(0);
    }
    // The jog is gone: one turn takes the line from bus 1 to bus 4.
    expect(tidy['line-L14']!.length).toBeLessThan(JOGGED.length);
    expect(success).toHaveBeenCalledWith(
      'Diagram tidied',
      expect.objectContaining({
        description: expect.stringContaining(
          '4 lines and transformers re-routed. Nothing was moved.',
        ),
      }),
    );
    // One step for Undo, and the routes are in the file.
    expect(labels()).toEqual(['tidy diagram']);
    const layout = await written();
    expect(layout.branches?.line?.L14).toMatchObject({
      routing: 'polyline',
      bus1: '1',
      bus2: '4',
      bend_points: tidy['line-L14']!.map(([x, y]) => ({ x, y })),
    });
    expect(layout.branches?.transformer?.T24?.routing).toBe('polyline');
  });

  it('reopens as it was tidied', async () => {
    await openUntidy();
    run('tidy');
    const layout = await written();
    const tidied = { picture: picture(), routes: routes() };

    cleanup();
    drawn.nodes = [];
    useCaseStore.getState().clearCase();
    history().clear();
    mockSidecar = parseSidecar(JSON.parse(JSON.stringify(layout)));
    open('square.xlsx');
    await draw();

    expect(picture()).toEqual(tidied.picture);
    expect(routes()).toEqual(tidied.routes);
  });

  it('is taken back by one Undo, and put back by one Redo', async () => {
    const info = vi.spyOn(toast, 'info');
    await openUntidy();
    const before = { picture: picture(), routes: routes() };
    run('tidy');
    await waitFor(() => expect(picture().stored).not.toEqual(before.picture.stored));
    const tidied = { picture: picture(), routes: routes() };
    await written();
    putSidecarSpy.mockClear();

    run('undo-layout');
    await waitFor(() => expect(routes()).toEqual(before.routes));
    expect(picture()).toEqual(before.picture);
    expect(info).toHaveBeenCalledWith('Undone: tidy diagram');
    expect(labels()).toEqual([]);
    expect(history().future.map((step) => step.label)).toEqual(['tidy diagram']);
    // The file follows: it holds the route with the jog in it again.
    const undone = await written();
    expect(undone.branches?.line?.L14?.bend_points).toEqual(JOGGED.map(([x, y]) => ({ x, y })));

    run('redo-layout');
    await waitFor(() => expect(routes()).toEqual(tidied.routes));
    expect(picture()).toEqual(tidied.picture);
    expect(info).toHaveBeenCalledWith('Redone: tidy diagram');
    expect(labels()).toEqual(['tidy diagram']);
  });

  it('offers Undo on its toast, which takes it back while it is the newest change', async () => {
    const success = vi.spyOn(toast, 'success');
    await openUntidy();
    const before = routes();
    run('tidy');
    await waitFor(() => expect(routes()).not.toEqual(before));
    const options = success.mock.calls[0]![1] as { action: { label: string; onClick: () => void } };
    expect(options.action.label).toBe('Undo');
    act(() => options.action.onClick());
    await waitFor(() => expect(routes()).toEqual(before));
    expect(labels()).toEqual([]);
  });

  it('says so, and leaves nothing to take back, when the diagram is already tidy', async () => {
    const info = vi.spyOn(toast, 'info');
    await openUntidy();
    const before = routes();
    run('tidy');
    await waitFor(() => expect(routes()).not.toEqual(before));
    const tidied = routes();

    run('tidy');
    expect(info).toHaveBeenCalledWith('The diagram is already tidy.', expect.anything());
    expect(routes()).toEqual(tidied);
    expect(labels()).toEqual(['tidy diagram']);
  });

  it('says what the last tidy came to beside its button, until the diagram is arranged some other way', async () => {
    const info = vi.spyOn(toast, 'info');
    await openUntidy();
    const note = () => screen.getByTestId('sld-tidy-note');
    expect(note()).toHaveTextContent('');
    const before = routes();
    run('tidy');
    await waitFor(() => expect(routes()).not.toEqual(before));
    expect(note()).toHaveTextContent(
      /^Tidied: \d+ lines? (and transformers|or transformer) re-routed$/,
    );

    // A second tidy changes nothing that could be seen: the note says so,
    // and stays after the notice has gone. The notice stays for 8 s.
    run('tidy');
    expect(note()).toHaveTextContent('Already tidy: nothing was changed');
    const [, shown] = info.mock.calls.find(([text]) => text === 'The diagram is already tidy.')!;
    expect(shown).toMatchObject({ duration: 8_000 });
    expect(shown!.description).toMatch(/Nothing was changed\.$/);

    // A move makes it a diagram the tidy has not seen.
    const at = positionOf('3');
    dragTo('3', { x: at.x + 40, y: at.y + 8 });
    expect(note()).toHaveTextContent('');
  });

  it('says there is nothing to tidy on a diagram with no branch', async () => {
    const info = vi.spyOn(toast, 'info');
    mockTopology = { ...square(), lines: [], transformers: [] };
    open('square.xlsx');
    await draw();
    run('tidy');
    expect(info).toHaveBeenCalledWith('Nothing to tidy: the diagram has no lines or transformers.');
    expect(labels()).toEqual([]);
  });
});

describe('a bus or a device that is moved', () => {
  it('has the lines of a bus routed to where it is dropped, with no tidy asked for', async () => {
    open('square.xlsx');
    await draw();
    const start = positionOf('3');
    const before = picture().stored;
    dragTo('3', { x: start.x + 150, y: start.y + 90 });
    await waitFor(() => expect(positionOf('3').x).toBe(start.x + 150));

    // The route of its line is made for where the bus stands now, and kept.
    await waitFor(() => expect(picture().stored['line-L13']).not.toEqual(before['line-L13']));
    const points = routes()['line-L13']!;
    expect(points).toEqual(picture().stored['line-L13']);
    expect(squareCornered(points)).toBe(true);
    // It lands on the bar where the bus stands now.
    const end = points[points.length - 1]!;
    expect(end[1]).toBe(start.y + 90 + 3);
    expect(end[0]).toBeGreaterThanOrEqual(start.x + 150);
    expect(end[0]).toBeLessThanOrEqual(start.x + 150 + 92);
    // The lines of the buses that stayed keep their routes.
    expect(picture().stored['transformer-T24']).toEqual(before['transformer-T24']);
    // The move is the one step there is to take back, and the routes are saved with it.
    expect(labels()).toEqual(['move bus Bus 3']);
    const layout = await written();
    expect(layout.branches?.line?.L13?.bend_points).toEqual(points.map(([x, y]) => ({ x, y })));
  });

  it('has the lines a device is dropped on routed round it', async () => {
    open('square.xlsx');
    await draw();
    const straight = routes()['line-L13']!;
    // The line from bus 1 to bus 3 drops straight down at x = 48.
    expect(straight).toEqual([
      [48, 3],
      [48, 227],
    ]);

    // The generator is dropped on it.
    dragTo('generator-G1', { x: 20, y: 60 });
    await waitFor(() => expect(routes()['line-L13']).not.toEqual(straight));
    const box = { left: 20, right: 20 + 55, top: 60, bottom: 60 + 41 };
    for (const [id, points] of Object.entries(routes())) {
      expect(squareCornered(points), id).toBe(true);
      for (let i = 1; i < points.length; i += 1) {
        const [a, b] = [points[i - 1]!, points[i]!];
        const through =
          Math.max(a[0], b[0]) > box.left &&
          Math.min(a[0], b[0]) < box.right &&
          Math.max(a[1], b[1]) > box.top &&
          Math.min(a[1], b[1]) < box.bottom;
        expect(through, `${id} run ${i}`).toBe(false);
      }
    }
    // Nothing is left for the Tidy diagram button to count.
    expect(screen.queryByTestId('sld-tidy-count')).not.toBeInTheDocument();
    expect(labels()).toEqual(['move generator GENROU G1']);
  });

  it('routes nothing afresh while the drag is on its way, and keeps what it made when it ends', async () => {
    open('square.xlsx');
    await draw();
    const start = positionOf('3');
    const from = { id: '3', position: start };
    const to = { x: start.x + 150, y: start.y + 90 };
    act(() => {
      drawn.onNodeDragStart?.({}, from, [from]);
      drawn.onNodesChange?.([{ id: '3', type: 'position', position: to, dragging: true }]);
    });
    // In the drag the line follows the bus, and no route is kept for it yet.
    expect(positionOf('3')).toEqual(to);
    expect(squareCornered(routes()['line-L13']!)).toBe(true);
    expect(useCaseStore.getState().routeOverrides).toEqual({});

    act(() => {
      drawn.onNodesChange?.([{ id: '3', type: 'position', position: to, dragging: false }]);
      drawn.onNodeDragStop?.({}, { id: '3', position: to }, [{ id: '3', position: to }]);
    });
    await waitFor(() =>
      expect(useCaseStore.getState().routeOverrides['line-L13']?.points).toEqual(
        routes()['line-L13'],
      ),
    );
  });
});

describe('Tidy diagram that cannot route every branch', () => {
  it('leaves a branch it finds no way for on the route it had, and says so', async () => {
    const success = vi.spyOn(toast, 'success');
    await openUntidy();
    const before = { picture: picture() };
    expect(before.picture.stored['line-L13']).not.toBeNull();
    forced.unrouted = ['line-L13'];

    run('tidy');

    await waitFor(() => expect(labels()).toEqual(['tidy diagram']));
    // The other three are routed afresh; this one keeps the route it had.
    expect(picture().stored['line-L13']).toEqual(before.picture.stored['line-L13']);
    expect(squareCornered(routes()['line-L13']!)).toBe(true);
    expect(picture().stored['line-L14']).not.toEqual(before.picture.stored['line-L14']);
    expect(success).toHaveBeenCalledWith(
      'Diagram tidied',
      expect.objectContaining({
        description:
          '3 lines and transformers re-routed. Nothing was moved. No way was found for 1: it keeps the route it had. Saved with the layout.',
      }),
    );
    // And the file holds the route it kept.
    const layout = await written();
    expect(layout.branches?.line?.L13?.bend_points).toEqual(
      before.picture.stored['line-L13']!.map(([x, y]) => ({ x, y })),
    );
  });

  it('keeps the routes of several', async () => {
    const success = vi.spyOn(toast, 'success');
    await openUntidy();
    const before = picture();
    forced.unrouted = ['line-L13', 'transformer-T24'];

    run('tidy');

    await waitFor(() => expect(labels()).toEqual(['tidy diagram']));
    expect(picture().stored['line-L13']).toEqual(before.stored['line-L13']);
    expect(picture().stored['transformer-T24']).toEqual(before.stored['transformer-T24']);
    expect(success).toHaveBeenCalledWith(
      'Diagram tidied',
      expect.objectContaining({
        description: expect.stringContaining(
          'No way was found for 2: they keep the routes they had.',
        ),
      }),
    );
  });

  it('says that the work ran out, when that is why a branch has no route', async () => {
    const success = vi.spyOn(toast, 'success');
    await openUntidy();
    forced.unrouted = ['line-L13'];
    forced.outOfSteps = true;
    run('tidy');
    await waitFor(() => expect(labels()).toEqual(['tidy diagram']));
    expect(success).toHaveBeenCalledWith(
      'Diagram tidied',
      expect.objectContaining({
        description: expect.stringContaining(
          '1 could not be routed in the time a tidy takes: it keeps the route it had.',
        ),
      }),
    );
  });

  it('says that a re-layout found no way for a branch, which the diagram then routes as it is drawn', async () => {
    const success = vi.spyOn(toast, 'success');
    open('square.xlsx');
    await draw();
    forced.unrouted = ['line-L13'];

    run('tidy-relayout');

    await waitFor(() => expect(labels()).toEqual(['tidy and re-layout']));
    expect(success).toHaveBeenCalledWith(
      'Diagram tidied and laid out again',
      expect.objectContaining({
        description: expect.stringContaining(
          'No way was found for 1: it is drawn the most direct way, which may cross a symbol or a bar.',
        ),
      }),
    );
    // The plan left it without a route; the diagram finds it one as it draws.
    await waitFor(() => expect(picture().stored['line-L13']).not.toBeNull());
    expect(squareCornered(routes()['line-L13']!)).toBe(true);
  });

  it('changes nothing on a diagram that is too large to route, and says so', async () => {
    const info = vi.spyOn(toast, 'info');
    const success = vi.spyOn(toast, 'success');
    open('square.xlsx');
    await draw();
    const before = { picture: picture(), routes: routes() };
    forced.tooLarge = true;

    for (const command of ['tidy', 'tidy-relayout'] as const) {
      info.mockClear();
      run(command);
      expect(info, command).toHaveBeenCalledWith(
        'This diagram is too large to tidy',
        expect.objectContaining({ description: expect.stringContaining('Nothing was changed.') }),
      );
    }
    expect(success).not.toHaveBeenCalled();
    expect(picture()).toEqual(before.picture);
    expect(routes()).toEqual(before.routes);
    expect(labels()).toEqual([]);
    expect(putSidecarSpy).not.toHaveBeenCalled();
  });

  it('names the lines that would be drawn over something', async () => {
    const info = vi.spyOn(toast, 'info');
    await openUntidy();
    forced.refused = ['line-box: stub-load-PQ_1 / generator-G1: runs through the symbol'];
    forced.blamed = ['stub-load-PQ_1', 'line-L14'];

    run('tidy-relayout');
    expect(info).toHaveBeenCalledWith(
      'Nothing was changed',
      expect.objectContaining({
        description:
          'Laid out again, the connector of PQ PQ_1 and line Line L14 would have been drawn over something else, so the diagram keeps the arrangement it has.',
      }),
    );
    // With nothing to name, it says that much.
    forced.blamed = [];
    info.mockClear();
    run('tidy');
    expect(info).toHaveBeenCalledWith(
      'Nothing was changed',
      expect.objectContaining({
        description: expect.stringContaining(
          'With the lines routed afresh, something on the diagram would have been drawn over something else',
        ) as string,
      }),
    );
  });
});

describe('a tidy that would leave something drawn over something else', () => {
  it('changes nothing, and says why', async () => {
    const info = vi.spyOn(toast, 'info');
    const success = vi.spyOn(toast, 'success');
    await openUntidy();
    const before = { picture: picture(), routes: routes() };
    forced.refused = ['line-box: stub-load-PQ_1 / generator-G1: runs through the symbol'];

    run('tidy');
    expect(info).toHaveBeenCalledWith(
      'Nothing was changed',
      expect.objectContaining({
        description: expect.stringContaining('The diagram keeps the routes it has.') as string,
      }),
    );
    expect(screen.getByTestId('sld-tidy-note')).toHaveTextContent(
      'Not tidied: nothing was changed',
    );
    info.mockClear();
    run('tidy-relayout');
    expect(info).toHaveBeenCalledWith(
      'Nothing was changed',
      expect.objectContaining({
        description: expect.stringContaining('keeps the arrangement it has') as string,
      }),
    );
    expect(success).not.toHaveBeenCalled();
    expect(picture()).toEqual(before.picture);
    expect(routes()).toEqual(before.routes);
    expect(labels()).toEqual([]);
    expect(putSidecarSpy).not.toHaveBeenCalled();
  });
});

describe('lines that are drawn through a symbol or a bar', () => {
  it('are counted on the Tidy diagram button until a tidy routes them clear', async () => {
    open('square.xlsx');
    await draw();
    // As the case opens no line runs through anything.
    expect(screen.queryByTestId('sld-tidy-count')).not.toBeInTheDocument();
    expect(screen.getByTestId('sld-tidy')).toHaveAccessibleName('Tidy diagram');

    // A layout saved by an earlier version has the generator on the line
    // that leaves bus 1 downwards (a drop does not leave it there any
    // more), on a diagram where no way round it is found: the line is drawn
    // through it.
    const layout = captureLayout(
      {
        nodes: drawn.nodes.map((n) =>
          n.id === 'generator-G1' ? { ...n, position: { x: 20, y: 60 } } : n,
        ),
        edges: drawn.edges,
      },
      mockTopology!,
      null,
    );
    cleanup();
    drawn.nodes = [];
    useCaseStore.getState().clearCase();
    history().clear();
    mockSidecar = parseSidecar(JSON.parse(JSON.stringify(layout)));
    forced.noRouting = true;
    open('square.xlsx');
    await draw();
    const count = await screen.findByTestId('sld-tidy-count');
    expect(Number(count.textContent)).toBeGreaterThan(0);
    const button = screen.getByTestId('sld-tidy');
    expect(button.getAttribute('title')).toMatch(
      /^\d+ lines? runs? through a symbol or a bar\. Routes every line and transformer afresh/,
    );
    expect(button).toHaveAccessibleName(/^Tidy diagram.*runs? through a symbol or a bar\.$/);

    run('tidy');
    await waitFor(() => expect(screen.queryByTestId('sld-tidy-count')).not.toBeInTheDocument());
    expect(screen.getByTestId('sld-tidy')).toHaveAccessibleName('Tidy diagram');
  });
});

describe('Tidy diagram on a large diagram', () => {
  /** A tidy of the diagram that is drawn, held back until `finish` or `fail` is called. */
  function heldTidy() {
    let finish: () => void = () => {};
    let fail: (err: Error) => void = () => {};
    const cancel = vi.fn();
    const graph = {
      nodes: drawn.nodes as Parameters<typeof planTidy>[0]['nodes'],
      edges: drawn.edges as Parameters<typeof planTidy>[0]['edges'],
    };
    const topology = mockTopology!;
    const done = new Promise((resolve, reject) => {
      finish = () =>
        resolve(
          planTidy(graph, topology, {
            relayout: false,
            barLengths: defaultBarLengths(topology),
          }),
        );
      fail = reject;
    });
    forced.job = { done, cancel };
    return { finish: () => act(async () => finish()), fail, cancel };
  }

  it('says that it is at work, and takes no second press and no drag meanwhile', async () => {
    await openUntidy();
    const before = picture();
    vi.mocked(startTidy).mockClear();
    const job = heldTidy();

    fireEvent.click(screen.getByTestId('sld-tidy'));
    const button = screen.getByTestId('sld-tidy');
    expect(button).toHaveTextContent('Tidying…');
    expect(button).toBeDisabled();
    expect(screen.getByTestId('sld-tidy-cancel')).toHaveTextContent('Stop');
    // Nothing can be dragged from under the plan that is being made.
    expect(drawn.nodesDraggable).toBe(false);
    // Nothing is routed yet, and a second press starts nothing.
    expect(labels()).toEqual([]);
    run('tidy');
    run('tidy-relayout');
    expect(startTidy).toHaveBeenCalledTimes(1);

    await job.finish();
    await waitFor(() => expect(labels()).toEqual(['tidy diagram']));
    expect(screen.getByTestId('sld-tidy')).toHaveTextContent('Tidy diagram');
    expect(screen.getByTestId('sld-tidy')).toBeEnabled();
    expect(screen.queryByTestId('sld-tidy-cancel')).not.toBeInTheDocument();
    expect(drawn.nodesDraggable).toBe(true);
    expect(picture().positions).toEqual(before.positions);
    expect(picture().stored).not.toEqual(before.stored);
  });

  it('is called off by Stop, and then changes nothing', async () => {
    const info = vi.spyOn(toast, 'info');
    await openUntidy();
    const before = { picture: picture(), routes: routes() };
    const job = heldTidy();

    run('tidy');
    fireEvent.click(await screen.findByTestId('sld-tidy-cancel'));

    expect(job.cancel).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('Tidy stopped. Nothing was changed.');
    expect(screen.getByTestId('sld-tidy')).toHaveTextContent('Tidy diagram');
    expect(screen.getByTestId('sld-tidy')).toBeEnabled();
    // A plan that still arrives is not put in place.
    await job.finish();
    expect(picture()).toEqual(before.picture);
    expect(routes()).toEqual(before.routes);
    expect(labels()).toEqual([]);
    expect(putSidecarSpy).not.toHaveBeenCalled();
  });

  it('says so when the work fails, and changes nothing', async () => {
    const error = vi.spyOn(toast, 'error');
    await openUntidy();
    const before = picture();
    const job = heldTidy();

    run('tidy');
    await act(async () => job.fail(new Error('The tidy worker failed')));

    expect(error).toHaveBeenCalledWith('The diagram could not be tidied', {
      description: 'The tidy worker failed. Nothing was changed.',
    });
    expect(screen.getByTestId('sld-tidy')).toBeEnabled();
    expect(picture()).toEqual(before);
    expect(labels()).toEqual([]);
  });

  it('calls the work off when the diagram goes away', async () => {
    await openUntidy();
    const job = heldTidy();
    run('tidy');
    expect(job.cancel).not.toHaveBeenCalled();
    cleanup();
    expect(job.cancel).toHaveBeenCalledTimes(1);
  });
});

describe('Tidy and re-layout', () => {
  it('puts the buses on the grid and each device back beside its bus, as one step', async () => {
    const success = vi.spyOn(toast, 'success');
    open('square.xlsx');
    await draw();
    const before = picture();
    // The load is dragged far from its bus.
    dragTo('load-PQ_1', { x: before.positions['load-PQ_1']!.x + 400, y: -300 });
    await waitFor(() => expect(positionOf('load-PQ_1').y).toBe(-300));
    const messy = picture();

    run('tidy-relayout');

    await waitFor(() => expect(positionOf('load-PQ_1').y).not.toBe(-300));
    for (const id of ['1', '2', '3', '4']) {
      const at = positionOf(id);
      expect(at.x % GRID_STEP, id).toBe(0);
      expect(at.y % GRID_STEP, id).toBe(0);
      // Onto the nearest line of the grid, no further.
      expect(Math.abs(at.x - before.positions[id]!.x)).toBeLessThanOrEqual(GRID_STEP / 2);
      expect(Math.abs(at.y - before.positions[id]!.y)).toBeLessThanOrEqual(GRID_STEP / 2);
    }
    // The load hangs off its bus again: within a bar's length of it.
    const [load, bus] = [positionOf('load-PQ_1'), positionOf('4')];
    expect(Math.abs(load.x - bus.x)).toBeLessThanOrEqual(92);
    expect(Math.abs(load.y - bus.y)).toBeLessThanOrEqual(92);
    for (const points of Object.values(routes())) expect(squareCornered(points)).toBe(true);
    // Every device stands over or under its bar: its connector drops square.
    for (const edge of drawn.edges.filter((e) => e.type === 'stub')) {
      const points = (edge.data?.route as { points: Points }).points;
      expect(points, edge.id).toHaveLength(2);
      expect(points[0]![0], edge.id).toBe(points[1]![0]);
    }
    expect(success).toHaveBeenCalledWith(
      'Diagram tidied and laid out again',
      expect.objectContaining({
        description: expect.stringContaining('Buses lined up on the grid'),
      }),
    );
    expect(labels()).toEqual(['move load PQ PQ_1', 'tidy and re-layout']);

    // One Undo brings the whole of it back: the buses, the load and the lines.
    run('undo-layout');
    await waitFor(() => expect(picture()).toEqual(messy));
  });
});

describe('moves that can be taken back', () => {
  it('takes a drag back, and the routes it broke with it', async () => {
    open('square.xlsx');
    await draw();
    const before = { picture: picture(), routes: routes() };
    const start = positionOf('2');
    dragTo('2', { x: start.x + 77, y: start.y - 31 });
    await waitFor(() => expect(positionOf('2')).toEqual({ x: start.x + 77, y: start.y - 31 }));
    // The line to the bus is routed to where it stands now.
    await waitFor(() =>
      expect(picture().stored['line-L12']).not.toEqual(before.picture.stored['line-L12']),
    );
    expect(labels()).toEqual(['move bus Bus 2']);
    await written();
    putSidecarSpy.mockClear();

    run('undo-layout');
    await waitFor(() => expect(positionOf('2')).toEqual(start));
    expect(picture()).toEqual(before.picture);
    expect(routes()).toEqual(before.routes);
    // The file is written with the bus back where it was.
    expect((await written()).coordinates['2']).toEqual(start);
  });

  it('moves the devices of a bus along with it, as one move', async () => {
    open('square.xlsx');
    await draw();
    const [bus, machine, load] = [
      positionOf('1'),
      positionOf('generator-G1'),
      positionOf('load-PQ_1'),
    ];
    dragTo('1', { x: bus.x - 40, y: bus.y + 25 });
    await waitFor(() => expect(positionOf('1')).toEqual({ x: bus.x - 40, y: bus.y + 25 }));
    expect(positionOf('generator-G1')).toEqual({ x: machine.x - 40, y: machine.y + 25 });
    // The load is on another bus and stays.
    expect(positionOf('load-PQ_1')).toEqual(load);
    expect(labels()).toEqual(['move bus Bus 1']);

    run('undo-layout');
    await waitFor(() => expect(positionOf('1')).toEqual(bus));
    expect(positionOf('generator-G1')).toEqual(machine);
  });

  it('leaves a device where it is put when it is dragged along with its bus', async () => {
    open('square.xlsx');
    await draw();
    const [bus, machine] = [positionOf('1'), positionOf('generator-G1')];
    // Both are picked and dragged together: React Flow moves each.
    act(() => {
      drawn.onNodesChange?.([
        { id: '1', type: 'position', position: { x: bus.x + 10, y: bus.y }, dragging: true },
        {
          id: 'generator-G1',
          type: 'position',
          position: { x: machine.x + 10, y: machine.y },
          dragging: true,
        },
      ]);
      drawn.onNodesChange?.([
        { id: '1', type: 'position', position: { x: bus.x + 10, y: bus.y }, dragging: false },
        {
          id: 'generator-G1',
          type: 'position',
          position: { x: machine.x + 10, y: machine.y },
          dragging: false,
        },
      ]);
    });
    await waitFor(() => expect(positionOf('1').x).toBe(bus.x + 10));
    // Moved once, not twice.
    expect(positionOf('generator-G1')).toEqual({ x: machine.x + 10, y: machine.y });
  });

  it('takes presses of an arrow key in quick succession back as one move', async () => {
    open('square.xlsx');
    await draw();
    const start = positionOf('load-PQ_1');
    nudgeTo('load-PQ_1', { x: start.x + 5, y: start.y });
    nudgeTo('load-PQ_1', { x: start.x + 10, y: start.y });
    nudgeTo('load-PQ_1', { x: start.x + 15, y: start.y });
    await waitFor(() => expect(positionOf('load-PQ_1').x).toBe(start.x + 15));
    expect(labels()).toEqual(['move load PQ PQ_1']);

    run('undo-layout');
    await waitFor(() => expect(positionOf('load-PQ_1')).toEqual(start));
  });

  it('keeps a press that slips, and a move of nothing, out of the history', async () => {
    open('square.xlsx');
    await draw();
    const start = positionOf('2');
    dragTo('2', { x: start.x + 1, y: start.y + 1 });
    nudgeTo('2', start);
    expect(positionOf('2')).toEqual(start);
    expect(labels()).toEqual([]);
  });

  it('says so when there is nothing to take back or put back', async () => {
    const info = vi.spyOn(toast, 'info');
    open('square.xlsx');
    await draw();
    run('undo-layout');
    expect(info).toHaveBeenCalledWith('Nothing to undo on the diagram.');
    run('redo-layout');
    expect(info).toHaveBeenCalledWith('Nothing to redo on the diagram.');
  });
});

describe('picking several nodes, and lining them up', () => {
  it('shows the nodes React Flow selects together as selected, and how many', async () => {
    open('square.xlsx');
    await draw();
    expect(screen.queryByTestId('sld-selection-bar')).not.toBeInTheDocument();
    pick('1', '2');
    await waitFor(() =>
      expect(screen.getByTestId('sld-selection-count')).toHaveTextContent('2 picked'),
    );
    expect(drawn.nodes.filter((n) => n.selected).map((n) => n.id)).toEqual(['1', '2']);
    expect(useSldStore.getState().pickedNodeIds).toEqual(['1', '2']);

    // One more with Ctrl held: React Flow reports only the one added.
    pick('load-PQ_1');
    await waitFor(() =>
      expect(screen.getByTestId('sld-selection-count')).toHaveTextContent('3 picked'),
    );

    // A click on the background lets go of them all.
    act(() => {
      drawn.onNodesChange?.(
        ['1', '2', 'load-PQ_1'].map((id) => ({ id, type: 'select', selected: false })),
      );
    });
    await waitFor(() => expect(screen.queryByTestId('sld-selection-bar')).not.toBeInTheDocument());
    expect(drawn.nodes.some((n) => n.selected)).toBe(false);
  });

  it('does not take one node, or a pick made in a table, for a selection of several', async () => {
    open('square.xlsx');
    await draw();
    // A click on bus 1: React Flow selects it, and the canvas shows it selected.
    pick('1');
    act(() => useSldStore.getState().setSelectedNodeId('1', 'diagram'));
    expect(screen.queryByTestId('sld-selection-bar')).not.toBeInTheDocument();
    // A click on bus 2 with Ctrl held adds it.
    pick('2');
    await waitFor(() => expect(screen.getByTestId('sld-selection-bar')).toBeInTheDocument());
    act(() => useSldStore.getState().setSelectedNodeId('3'));
    await waitFor(() => expect(screen.queryByTestId('sld-selection-bar')).not.toBeInTheDocument());
    expect(drawn.nodes.filter((n) => n.selected).map((n) => n.id)).toEqual(['3']);
  });

  it('tells the commands how many it shows as picked, and lets go of them when it goes away', async () => {
    open('square.xlsx');
    await draw();
    expect(useSldStore.getState().pickedCount).toBe(0);
    pick('1', '2', 'load-PQ_1');
    await waitFor(() => expect(useSldStore.getState().pickedCount).toBe(3));
    // An id that is no node of this diagram is not one of them.
    act(() => useSldStore.getState().setPickedNodeIds(['1', '2', 'gone']));
    await waitFor(() => expect(useSldStore.getState().pickedCount).toBe(2));
    expect(screen.getByTestId('sld-selection-count')).toHaveTextContent('2 picked');

    // Another view takes the place of the diagram: nothing is left picked.
    cleanup();
    expect(useSldStore.getState().pickedNodeIds).toEqual([]);
    expect(useSldStore.getState().pickedCount).toBe(0);
  });

  it('starts another case with nothing picked', async () => {
    open('square.xlsx');
    await draw();
    pick('1', '2');
    await waitFor(() => expect(screen.getByTestId('sld-selection-bar')).toBeInTheDocument());

    // A case whose buses go by the same idx values.
    act(() => open('other.xlsx'));
    await waitFor(() => expect(screen.queryByTestId('sld-selection-bar')).not.toBeInTheDocument());
    expect(useSldStore.getState().pickedNodeIds).toEqual([]);
    expect(drawn.nodes.filter((n) => n.selected)).toEqual([]);
  });

  it('aligns the picked buses, takes their devices along, and takes it back in one step', async () => {
    const success = vi.spyOn(toast, 'success');
    open('square.xlsx');
    await draw();
    // Bus 4 stands a row under bus 1, with its load.
    const [one, four, load] = [positionOf('1'), positionOf('4'), positionOf('load-PQ_1')];
    expect(four.y).toBeGreaterThan(one.y);
    pick('1', '4');
    await waitFor(() => expect(screen.getByTestId('sld-selection-bar')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('sld-align-top'));

    await waitFor(() => expect(positionOf('4').y).toBe(one.y));
    expect(positionOf('4').x).toBe(four.x);
    expect(positionOf('1')).toEqual(one);
    expect(positionOf('load-PQ_1')).toEqual({ x: load.x, y: load.y - (four.y - one.y) });
    expect(success).toHaveBeenCalledWith('Align top: 1 of 2 moved', expect.anything());
    expect(labels()).toEqual(['align top (2 elements)']);
    // Still picked, for the next arrangement.
    expect(screen.getByTestId('sld-selection-count')).toHaveTextContent('2 picked');

    run('undo-layout');
    await waitFor(() => expect(positionOf('4')).toEqual(four));
    expect(positionOf('load-PQ_1')).toEqual(load);
  });

  it('spaces three picked nodes out evenly', async () => {
    open('square.xlsx');
    await draw();
    const before = { one: positionOf('1'), two: positionOf('2') };
    // Bus 3 is put between buses 1 and 2, nearer the first.
    dragTo('3', { x: before.one.x + 100, y: before.one.y });
    await waitFor(() => expect(positionOf('3').x).toBe(before.one.x + 100));
    pick('1', '2', '3');
    await waitFor(() => expect(screen.getByTestId('sld-distribute-horizontal')).toBeEnabled());

    fireEvent.click(screen.getByTestId('sld-distribute-horizontal'));

    // Three bars of 92 between 5 and 397: gaps of 58, so the middle one starts at 155.
    await waitFor(() => expect(positionOf('3').x).toBe((before.one.x + before.two.x) / 2));
    expect(positionOf('1')).toEqual(before.one);
    expect(positionOf('2')).toEqual(before.two);
  });

  it('says what is missing when too few are picked, or nothing would move', async () => {
    const info = vi.spyOn(toast, 'info');
    open('square.xlsx');
    await draw();
    run('align-left');
    expect(info).toHaveBeenCalledWith(
      'Pick two or more buses or devices to align.',
      expect.anything(),
    );
    pick('1', '2');
    run('distribute-horizontal');
    expect(info).toHaveBeenCalledWith(
      'Pick three or more buses or devices to distribute.',
      expect.anything(),
    );
    // Buses 1 and 2 stand in one row already.
    run('align-top');
    expect(info).toHaveBeenCalledWith('Align top: nothing to move.', expect.anything());
    expect(labels()).toEqual([]);
  });
});

describe('Snap to grid', () => {
  it('is off until it is turned on, and then tells React Flow the grid of the background dots', async () => {
    const info = vi.spyOn(toast, 'info');
    open('square.xlsx');
    await draw();
    expect(drawn.snapToGrid).toBe(false);
    expect(drawn.snapGrid).toEqual([GRID_STEP, GRID_STEP]);

    fireEvent.click(screen.getByTestId('sld-arrange-trigger'));
    const toggle = await screen.findByTestId('sld-snap-toggle');
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);

    await waitFor(() => expect(drawn.snapToGrid).toBe(true));
    expect(useLayoutStore.getState().sldSnapToGrid).toBe(true);
    expect(info).toHaveBeenCalledWith('Snap to grid is on', expect.anything());
    // Nothing moves until it is moved.
    expect(labels()).toEqual([]);
  });

  it('puts what Align moves on the grid while it is on', async () => {
    useLayoutStore.setState({ sldSnapToGrid: true });
    open('square.xlsx');
    await draw();
    pick('1', '4');
    await waitFor(() => expect(screen.getByTestId('sld-selection-bar')).toBeInTheDocument());
    run('align-top');
    // Bus 1 is at y = 7: bus 4 goes to the line of the grid nearest that.
    await waitFor(() => expect(positionOf('4').y).toBe(0));
  });
});

describe('the Arrange menu', () => {
  it('runs Tidy and re-layout, and says how to pick several while fewer than two are picked', async () => {
    await openUntidy();
    fireEvent.click(screen.getByTestId('sld-arrange-trigger'));
    expect(await screen.findByTestId('sld-arrange-pick-hint')).toHaveTextContent(
      /hold Shift and drag a box around them, or hold Ctrl/,
    );
    expect(screen.getAllByTestId('sld-align-left')[0]).toBeDisabled();

    fireEvent.click(screen.getByTestId('sld-arrange-tidy-relayout'));
    await waitFor(() => expect(labels()).toEqual(['tidy and re-layout']));
    // The menu closes on a command.
    await waitFor(() => expect(screen.queryByTestId('sld-arrange-menu')).not.toBeInTheDocument());
  });
});

describe('a locked diagram', () => {
  it('is not arranged: the commands say why, and the buttons are greyed out', async () => {
    const info = vi.spyOn(toast, 'info');
    open('square.xlsx');
    await draw();
    const start = positionOf('2');
    dragTo('2', { x: start.x + 50, y: start.y });
    await waitFor(() => expect(positionOf('2').x).toBe(start.x + 50));
    const before = { picture: picture(), routes: routes() };

    act(() => drawn.onInteractiveChange?.(false));
    await waitFor(() => expect(screen.getByTestId('sld-tidy')).toBeDisabled());
    expect(useSldStore.getState().diagramLocked).toBe(true);
    expect(drawn.nodesDraggable).toBe(false);

    for (const command of ['tidy', 'tidy-relayout', 'undo-layout', 'align-left'] as const) {
      info.mockClear();
      run(command);
      expect(info, command).toHaveBeenCalledWith(expect.stringMatching(/^The diagram is locked\./));
    }
    expect(picture()).toEqual(before.picture);
    expect(routes()).toEqual(before.routes);
    expect(labels()).toEqual(['move bus Bus 2']);

    // Unlocked, it can be arranged again.
    act(() => drawn.onInteractiveChange?.(true));
    await waitFor(() => expect(screen.getByTestId('sld-tidy')).toBeEnabled());
    expect(useSldStore.getState().diagramLocked).toBe(false);
    expect(drawn.nodesDraggable).toBe(true);
  });
});

describe('Reset to auto-layout', () => {
  it('forgets the routes that were kept and puts the automatic ones back, and Undo undoes that', async () => {
    putSidecarSpy.mockImplementation((_vars: unknown, callbacks?: { onSuccess?: () => void }) =>
      callbacks?.onSuccess?.(),
    );
    open('square.xlsx');
    await draw();
    const automatic = { picture: picture(), routes: routes() };
    // A bus is moved: its lines are routed to where it stands, and kept.
    const start = positionOf('3');
    dragTo('3', { x: start.x + 150, y: start.y + 90 });
    await waitFor(() => expect(routes()).not.toEqual(automatic.routes));
    await waitFor(() => expect(useCaseStore.getState().routeOverrides).not.toEqual({}));
    const moved = { picture: picture(), routes: routes() };

    run('reset-layout');
    await waitFor(() => expect(routes()).toEqual(automatic.routes));
    expect(picture()).toEqual(automatic.picture);
    expect(useCaseStore.getState().routeOverrides).toEqual({});
    expect(labels()).toEqual(['move bus Bus 3', 'reset to auto-layout']);

    run('undo-layout');
    await waitFor(() => expect(routes()).toEqual(moved.routes));
    expect(picture()).toEqual(moved.picture);
  });

  it('does not put the old arrangement back from its toast over a change made since', async () => {
    const success = vi.spyOn(toast, 'success');
    const info = vi.spyOn(toast, 'info');
    open('square.xlsx');
    await draw();
    const start = positionOf('2');
    dragTo('2', { x: start.x + 50, y: start.y });
    await waitFor(() => expect(positionOf('2').x).toBe(start.x + 50));
    success.mockClear();
    run('reset-layout');
    await waitFor(() => expect(positionOf('2')).toEqual(start));
    const options = success.mock.calls[0]![1] as { action: { onClick: () => void } };

    // Something else is moved while the toast is still up.
    const three = positionOf('3');
    dragTo('3', { x: three.x + 80, y: three.y });
    await waitFor(() => expect(positionOf('3').x).toBe(three.x + 80));
    const after = picture();
    putSidecarSpy.mockClear();
    info.mockClear();

    act(() => options.action.onClick());

    expect(info).toHaveBeenCalledWith(
      'The diagram was changed since. Use Undo in the Edit menu to go back.',
    );
    // Nothing was put back, and the history still matches what is drawn.
    expect(picture()).toEqual(after);
    expect(putSidecarSpy).not.toHaveBeenCalled();
    expect(labels()).toEqual(['move bus Bus 2', 'reset to auto-layout', 'move bus Bus 3']);
    // Undo from the Edit menu still goes back a step at a time.
    run('undo-layout');
    await waitFor(() => expect(positionOf('3')).toEqual(three));
    run('undo-layout');
    await waitFor(() => expect(positionOf('2').x).toBe(start.x + 50));
  });

  it('leaves no step behind when it is taken back from its own toast', async () => {
    const success = vi.spyOn(toast, 'success');
    open('square.xlsx');
    await draw();
    const start = positionOf('2');
    dragTo('2', { x: start.x + 50, y: start.y });
    await waitFor(() => expect(positionOf('2').x).toBe(start.x + 50));
    putSidecarSpy.mockClear();
    success.mockClear();

    run('reset-layout');
    await waitFor(() => expect(positionOf('2')).toEqual(start));
    expect(labels()).toEqual(['move bus Bus 2', 'reset to auto-layout']);
    const options = success.mock.calls[0]![1] as { action: { onClick: () => void } };
    act(() => options.action.onClick());
    await waitFor(() => expect(positionOf('2').x).toBe(start.x + 50));
    expect(labels()).toEqual(['move bus Bus 2']);
  });
});

describe('labels that keep out of the way', () => {
  /** Whether `at` is on a run of the route `points`. */
  function onARun(at: { x: number; y: number }, points: Points): boolean {
    return points.slice(1).some((p, i) => {
      const a = points[i]!;
      return (
        at.x >= Math.min(a[0], p[0]) &&
        at.x <= Math.max(a[0], p[0]) &&
        at.y >= Math.min(a[1], p[1]) &&
        at.y <= Math.max(a[1], p[1])
      );
    });
  }
  const placeOf = (edge: DrawnEdge) => edge.data?.labelAt as { x: number; y: number } | undefined;
  const pointsOf = (edge: DrawnEdge) => (edge.data?.route as { points: Points }).points;

  it('hands each transformer the place of its symbol, on a run of its route', async () => {
    open('square.xlsx');
    await draw();
    const transformer = drawn.edges.find((e) => e.id === 'transformer-T24')!;
    expect(placeOf(transformer)).toBeDefined();
    expect(onARun(placeOf(transformer)!, pointsOf(transformer))).toBe(true);
    // A line has nothing to place until a power flow gives it a flow to show,
    // and a device connector carries no label.
    expect(placeOf(drawn.edges.find((e) => e.id === 'line-L13')!)).toBeUndefined();
    expect(drawn.edges.find((e) => e.type === 'stub')?.data?.labelAt).toBeUndefined();
  });

  it('hands each line the place of its flow label once a power flow has run', async () => {
    open('square.xlsx');
    await draw();
    act(() =>
      usePflowStore.setState({
        lastRun: {
          run_id: parseRunId('pf-1'),
          converged: true,
          iterations: 4,
          mismatch: 1e-6,
          bus_voltages: { '1': 1.04, '2': 1.01, '3': 1.0, '4': 0.99 },
          bus_angles: { '1': 0, '2': -1, '3': -2, '4': -3 },
          line_flows: {
            L12: lineFlow(120, 10, { from: '1', to: '2' }),
            L13: lineFlow(80, 5, { from: '1', to: '3' }),
            L14: lineFlow(40, 2, { from: '1', to: '4' }),
          },
        },
        isRunning: false,
        error: null,
      }),
    );
    await waitFor(() =>
      expect(placeOf(drawn.edges.find((e) => e.id === 'line-L13')!)).toBeDefined(),
    );
    for (const edge of drawn.edges.filter((e) => e.type === 'topology')) {
      expect(placeOf(edge), edge.id).toBeDefined();
      expect(onARun(placeOf(edge)!, pointsOf(edge)), edge.id).toBe(true);
    }
    // Showing the values moved no line: the routes left room for them.
    expect(labels()).toEqual([]);
    expect(putSidecarSpy).not.toHaveBeenCalled();
  });

  it('tells each bus where its label stands, clear of the lines that leave its bar', async () => {
    open('square.xlsx');
    await draw();
    const labelAt = (id: string) =>
      drawn.nodes.find((n) => n.id === id)!.data.labelAt as
        | { offset: number; side: string }
        | undefined;
    // Bus 3 has one line, onto the top of its bar: its label hangs under the middle.
    expect(labelAt('3')).toEqual({ offset: 46, side: 'below' });
    // Bus 1 has lines leaving under its bar: its label is moved along, clear of them.
    const one = labelAt('1');
    expect(one?.side).toBe('below');
    const taps = (drawn.nodes.find((n) => n.id === '1')!.data.bar as { taps: { x: number }[] })
      .taps;
    for (const tap of taps.filter((t) => (t as { side?: string }).side === 'south')) {
      expect(Math.abs(tap.x - one!.offset), `tap at ${tap.x}`).toBeGreaterThan(20);
    }
    // A bus with no line is told the same place every bus starts from.
    mockTopology = { ...square(), lines: [], transformers: [] };
    cleanup();
    drawn.nodes = [];
    useCaseStore.getState().clearCase();
    open('square.xlsx');
    await draw();
    expect(labelAt('2')).toEqual({ offset: 46, side: 'below' });
  });
});
