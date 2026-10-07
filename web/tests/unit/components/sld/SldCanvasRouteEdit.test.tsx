/**
 * Moving a line by hand, on the canvas: a click picks a line and shows its
 * handles and its bar, a move of a handle becomes the route of the line,
 * that route is the user's (a tidy leaves it, a moved bus takes it along),
 * it can be taken back, reset and saved, and the diagram refuses a route
 * that would leave something drawn over something else.
 *
 * The canvas is rendered against a stand-in for React Flow that records what
 * it is asked to draw and hands back the handlers a test needs (a click on
 * an edge, on a node, on the background; the moves of a node). The handles
 * are the real ones (`SldRouteEditor`), driven by the keyboard and by
 * pointer events as a user drives them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

interface DrawnNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}
interface DrawnEdge {
  id: string;
  type?: string;
  source: string;
  target: string;
  data?: Record<string, unknown>;
}
type Change = {
  id: string;
  type: 'position';
  position: { x: number; y: number };
  dragging: boolean;
};
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
  onEdgeClick: ((event: unknown, edge: DrawnEdge) => void) | null;
  onNodeClick: ((event: unknown, node: DrawnNode) => void) | null;
  onPaneClick: (() => void) | null;
  onInteractiveChange: ((interactive: boolean) => void) | null;
} = {
  nodes: [],
  edges: [],
  onNodesChange: null,
  onNodeDragStart: null,
  onNodeDragStop: null,
  onEdgeClick: null,
  onNodeClick: null,
  onPaneClick: null,
  onInteractiveChange: null,
};

vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: {
    nodes: DrawnNode[];
    edges: DrawnEdge[];
    onNodesChange: (changes: Change[]) => void;
    onNodeDragStart: DragHandler;
    onNodeDragStop: DragHandler;
    onEdgeClick: (event: unknown, edge: DrawnEdge) => void;
    onNodeClick: (event: unknown, node: DrawnNode) => void;
    onPaneClick: () => void;
    children?: ReactNode;
  }) => {
    drawn.nodes = props.nodes;
    drawn.edges = props.edges;
    drawn.onNodesChange = props.onNodesChange;
    drawn.onNodeDragStart = props.onNodeDragStart;
    drawn.onNodeDragStop = props.onNodeDragStop;
    drawn.onEdgeClick = props.onEdgeClick;
    drawn.onNodeClick = props.onNodeClick;
    drawn.onPaneClick = props.onPaneClick;
    return props.children;
  },
  ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
  Handle: () => null,
  Background: () => null,
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
    // The pane is drawn at full size from the corner of the window.
    screenToFlowPosition: (p: { x: number; y: number }) => p,
  }),
}));

// An ELK that lays the buses out two to a row. The canvas asks it for the
// places of the buses only (`useAutoLayout`).
vi.mock('@/components/sld/elkClient', () => ({
  elkLayout: vi.fn(async (graph: { children?: { id: string }[] }) => ({
    children: (graph.children ?? []).map((c, i) => ({
      id: c.id,
      x: 304 * (i % 2),
      y: 224 * Math.floor(i / 2),
    })),
  })),
}));

/** What the picture is made to say of a route that is handed to the canvas. */
const forced = vi.hoisted(() => ({ refuseRoutes: false }));

vi.mock('@/components/sld/picture', async () => {
  const actual = await vi.importActual<typeof import('@/components/sld/picture')>(
    '@/components/sld/picture',
  );
  const routesDrawClear: typeof actual.routesDrawClear = (...args) =>
    forced.refuseRoutes ? () => false : actual.routesDrawClear(...args);
  return { ...actual, routesDrawClear };
});

import { SldCanvas } from '@/components/sld/SldCanvas';
import { __clearAllPendingForTests, parseSidecar } from '@/components/sld/sidecar';
import { NUDGE_FACTOR, NUDGE_STEP } from '@/components/sld/SldRouteEditor';
import { useCaseStore } from '@/store/case';
import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layout';
import { useLayoutHistoryStore } from '@/store/layoutHistory';
import { usePflowStore } from '@/store/pflow';
import { useSessionStore } from '@/store/session';
import { __requestSldCommand, useSldStore } from '@/store/sld';
import type { SldCommand } from '@/store/sld';
import { toast } from '@/lib/toast';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { SidecarLayout, TopologyEntry, TopologySummary } from '@/api/types';

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
 * a transformer from 2 to 4; a machine on bus 1 and a load on bus 4.
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

function edgeOf(id: string): DrawnEdge {
  const edge = drawn.edges.find((e) => e.id === id);
  if (edge === undefined) throw new Error(`no edge ${id}`);
  return edge;
}

/** The points the edge `id` is drawn through. */
function routeOf(id: string): Points {
  return (edgeOf(id).data?.route as { points: Points }).points;
}

const byHand = (id: string): boolean => edgeOf(id).data?.bendManual === true;

function positionOf(id: string): { x: number; y: number } {
  return { ...drawn.nodes.find((n) => n.id === id)!.position };
}

function open(casePath: string): void {
  useCaseStore.getState().setCase({ primaryPath: parseWorkspacePath(casePath), addfiles: [] });
}

async function draw(): Promise<void> {
  render(<SldCanvas />);
  await waitFor(() => expect(drawn.nodes.length).toBeGreaterThan(0));
}

/** Post `command` the way the palette, a shortcut and the buttons post it. */
function post(command: SldCommand): void {
  act(() => __requestSldCommand(command));
}

/** A click on the edge `id`, as React Flow reports it. */
function pick(id: string): void {
  act(() => drawn.onEdgeClick?.({}, edgeOf(id)));
}

/** A whole pointer drag of the node `id` to `to`, as React Flow reports it. */
function dragNodeTo(id: string, to: { x: number; y: number }): void {
  const from = { id, position: positionOf(id) };
  act(() => {
    drawn.onNodeDragStart?.({}, from, [from]);
    drawn.onNodesChange?.([{ id, type: 'position', position: to, dragging: true }]);
    drawn.onNodesChange?.([{ id, type: 'position', position: to, dragging: false }]);
    drawn.onNodeDragStop?.({}, { id, position: to }, [{ id, position: to }]);
  });
}

/** The index of the first run of `points` that is level, and of the first that is upright. */
function firstRun(points: Points, kind: 'level' | 'upright'): number {
  const at = points.findIndex(
    (p, i) => i > 0 && (kind === 'level' ? p[1] === points[i - 1]![1] : p[0] === points[i - 1]![0]),
  );
  if (at < 1) throw new Error(`no ${kind} run`);
  return at - 1;
}

/** A press of `key` on the handle `testId` of the line that is picked. */
function press(testId: string, key: string, shiftKey = false): void {
  fireEvent.keyDown(screen.getByTestId(testId), { key, shiftKey });
}

/** A drag of the handle `testId` from `from` by `by`, as a pointer does it. */
function dragHandle(testId: string, from: [number, number], by: [number, number]): void {
  const handle = screen.getByTestId(testId);
  const at = (dx: number, dy: number) => ({
    button: 0,
    pointerId: 1,
    clientX: from[0] + dx,
    clientY: from[1] + dy,
  });
  fireEvent.pointerDown(handle, at(0, 0));
  fireEvent.pointerMove(handle, at(by[0] / 2, by[1] / 2));
  fireEvent.pointerMove(handle, at(by[0], by[1]));
  fireEvent.pointerUp(handle, at(by[0], by[1]));
}

const history = () => useLayoutHistoryStore.getState();
const labels = () => history().past.map((step) => step.label);
const note = () => screen.getByTestId('sld-route-note');

/** The layout the canvas last wrote beside the case. */
async function written(): Promise<SidecarLayout> {
  await waitFor(() => expect(putSidecarSpy).toHaveBeenCalled(), { timeout: 3000 });
  const calls = putSidecarSpy.mock.calls as [{ casePath: string; layout: SidecarLayout }][];
  return calls[calls.length - 1]![0].layout;
}

/** Slide the first level run of the picked line `id` down by a press of the arrow key. */
function slideDown(id: string): { run: number; before: Points } {
  const before = routeOf(id);
  const run = firstRun(before, 'level');
  press(`sld-route-run-${run}`, 'ArrowDown');
  return { run, before };
}

// jsdom has no PointerEvent: a mouse event carries what the handles read of one.
const hadPointerEvent = 'PointerEvent' in window;

beforeEach(() => {
  if (!hadPointerEvent) {
    class PointerEventStandIn extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    vi.stubGlobal('PointerEvent', PointerEventStandIn);
  }
  mockTopology = square();
  mockSidecar = null;
  putSidecarSpy.mockClear();
  drawn.nodes = [];
  drawn.edges = [];
  drawn.onNodesChange = null;
  drawn.onEdgeClick = null;
  drawn.onInteractiveChange = null;
  forced.refuseRoutes = false;
  useSessionStore.setState({ sessionId: parseSessionId('sess-routes') });
  useCaseStore.getState().clearCase();
  useSldStore.setState({
    selectedNodeId: null,
    pickedNodeIds: [],
    pickedCount: 0,
    diagramLocked: false,
    manualRouteCount: 0,
  });
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
  usePflowStore.setState({ lastRun: null });
  history().clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  __clearAllPendingForTests();
  useCaseStore.getState().clearCase();
});

describe('picking a line', () => {
  it('shows its handles and its bar, in the place of the hint, and the line in the Inspector', async () => {
    open('square.xlsx');
    await draw();
    expect(screen.getByTestId('sld-canvas-hint')).toHaveTextContent(
      'Click a line to move its route by hand.',
    );
    expect(screen.queryByTestId('sld-route-editor')).toBeNull();

    pick('line-L14');

    const editor = screen.getByTestId('sld-route-editor');
    expect(editor).toHaveAttribute('data-edge-id', 'line-L14');
    expect(JSON.parse(editor.getAttribute('data-route')!)).toEqual(routeOf('line-L14'));
    // A handle on every run and on every bend, each with a name that says what it is.
    const route = routeOf('line-L14');
    for (let run = 0; run + 1 < route.length; run += 1) {
      expect(screen.getByTestId(`sld-route-run-${run}`)).toHaveAccessibleName(
        new RegExp(`^Run ${run + 1} of ${route.length - 1} of line Line L14`),
      );
    }
    for (let bend = 1; bend + 1 < route.length; bend += 1) {
      expect(screen.getByTestId(`sld-route-bend-${bend}`)).toHaveAccessibleName(
        new RegExp(`^Bend ${bend} of ${route.length - 2} of line Line L14`),
      );
    }
    // The bar stands where the hint stood, and says what the line is.
    expect(screen.queryByTestId('sld-canvas-hint')).toBeNull();
    const bar = screen.getByTestId('sld-route-bar');
    expect(screen.getByTestId('sld-canvas-route-slot')).toContainElement(bar);
    expect(screen.getByTestId('sld-route-name')).toHaveTextContent('Line Line L14');
    expect(screen.getByTestId('sld-route-status')).toHaveTextContent('Routed automatically');
    expect(note()).toHaveTextContent('Drag a run of the blue line to slide it');
    // Nothing that cannot be used is offered: no bend is picked, and the route is the diagram's.
    expect(screen.queryByTestId('sld-route-remove-bend')).toBeNull();
    expect(screen.queryByTestId('sld-route-reset')).toBeNull();
    expect(useCaseStore.getState().selectedElement).toEqual({ kind: 'line', idx: 'L14' });
  });

  it('lets go of it on Done, on Escape, and on a click on the background or on a node', async () => {
    open('square.xlsx');
    await draw();
    const gone = () => expect(screen.queryByTestId('sld-route-editor')).toBeNull();

    pick('line-L14');
    fireEvent.click(screen.getByTestId('sld-route-done'));
    gone();
    expect(screen.getByTestId('sld-canvas-hint')).toBeInTheDocument();

    pick('line-L14');
    press('sld-route-run-0', 'Escape');
    gone();

    pick('line-L14');
    act(() => drawn.onPaneClick?.());
    gone();

    pick('line-L14');
    act(() => drawn.onNodeClick?.({}, drawn.nodes.find((n) => n.id === '2')!));
    gone();
  });

  it('picks the connector of a device too, which is no element of its own', async () => {
    open('square.xlsx');
    await draw();
    pick('stub-load-PQ_1');
    expect(screen.getByTestId('sld-route-editor')).toHaveAttribute(
      'data-edge-id',
      'stub-load-PQ_1',
    );
    expect(screen.getByTestId('sld-route-name')).toHaveTextContent('The connector of PQ PQ_1');
    expect(useCaseStore.getState().selectedElement).toBeNull();
  });

  it('picks none while the diagram is locked', async () => {
    open('square.xlsx');
    await draw();
    pick('line-L14');
    act(() => drawn.onInteractiveChange?.(false));
    expect(screen.queryByTestId('sld-route-editor')).toBeNull();
    pick('line-L14');
    expect(screen.queryByTestId('sld-route-editor')).toBeNull();
  });
});

describe('moving a run with the arrow keys', () => {
  it("moves the line, makes the route the user's, says so, and writes it", async () => {
    const info = vi.spyOn(toast, 'info');
    open('square.xlsx');
    await draw();
    pick('line-L14');
    const { run, before } = slideDown('line-L14');

    const after = routeOf('line-L14');
    expect(after[run]![1]).toBe(before[run]![1] + NUDGE_STEP);
    expect(after[run + 1]![1]).toBe(before[run + 1]![1] + NUDGE_STEP);
    // Only that run moved: the ends are where they were.
    expect(after[0]).toEqual(before[0]);
    expect(after.at(-1)).toEqual(before.at(-1));
    expect(byHand('line-L14')).toBe(true);
    expect(screen.getByTestId('sld-route-status')).toHaveTextContent('Routed by hand');
    expect(screen.getByTestId('sld-route-reset')).toBeInTheDocument();
    expect(useSldStore.getState().manualRouteCount).toBe(1);
    expect(info).toHaveBeenCalledWith(
      'Line Line L14 is now routed by hand',
      expect.objectContaining({
        description: expect.stringContaining('Tidy diagram leaves it as it is') as string,
      }),
    );
    expect(labels()).toEqual(['slide a run of line Line L14']);

    const layout = await written();
    const stored = layout.branches!.line!.L14!;
    expect(stored.routing).toBe('manual');
    expect(stored.bend_points!.map(({ x, y }) => [x, y])).toEqual(after);
    // The other lines are the diagram's.
    expect(layout.branches!.line!.L12!.routing).toBe('polyline');
  });

  it('takes bigger steps with Shift, and several presses are one step for Undo', async () => {
    open('square.xlsx');
    await draw();
    pick('line-L14');
    const before = routeOf('line-L14');
    const run = firstRun(before, 'level');
    press(`sld-route-run-${run}`, 'ArrowDown');
    press(`sld-route-run-${run}`, 'ArrowDown', true);
    expect(routeOf('line-L14')[run]![1]).toBe(before[run]![1] + NUDGE_STEP * (1 + NUDGE_FACTOR));
    expect(labels()).toHaveLength(1);

    post('undo-layout');
    await waitFor(() => expect(routeOf('line-L14')).toEqual(before));
    expect(byHand('line-L14')).toBe(false);
    post('redo-layout');
    await waitFor(() => expect(byHand('line-L14')).toBe(true));
    expect(routeOf('line-L14')[run]![1]).toBe(before[run]![1] + NUDGE_STEP * (1 + NUDGE_FACTOR));
  });

  it('says which keys slide a run when the other two are pressed', async () => {
    open('square.xlsx');
    await draw();
    pick('line-L14');
    const before = routeOf('line-L14');
    press(`sld-route-run-${firstRun(before, 'level')}`, 'ArrowLeft');
    expect(note()).toHaveTextContent('A level run slides up and down');
    press(`sld-route-run-${firstRun(before, 'upright')}`, 'ArrowUp');
    expect(note()).toHaveTextContent('An upright run slides left and right');
    expect(routeOf('line-L14')).toEqual(before);
    expect(labels()).toEqual([]);
  });

  it('does not move a line onto another, and says what is in the way', async () => {
    open('square.xlsx');
    await draw();
    pick('line-L12');
    // The first run of each line from bus 1 leaves its bar: slid along the
    // bar far enough, one comes to stand on the tap of the next.
    const before = routeOf('line-L12');
    const others = ['line-L13', 'line-L14'].map((id) => routeOf(id)[0]![0]);
    const nearest = others.reduce((a, b) =>
      Math.abs(a - before[0]![0]) <= Math.abs(b - before[0]![0]) ? a : b,
    );
    const key = nearest > before[0]![0] ? 'ArrowRight' : 'ArrowLeft';
    for (let i = 0; i < 40 && note().getAttribute('data-tone') !== 'refused'; i += 1) {
      press('sld-route-run-0', key);
    }
    expect(note()).toHaveAttribute('data-tone', 'refused');
    expect(note()).toHaveTextContent(/^Not moved: (it|its end) would /);
    // It stands a tap apart from the other line still.
    expect(Math.abs(routeOf('line-L12')[0]![0] - nearest)).toBeGreaterThanOrEqual(13.5);
  });
});

describe('dragging a handle', () => {
  it('slides a run to where the pointer takes it', async () => {
    open('square.xlsx');
    await draw();
    pick('line-L14');
    const before = routeOf('line-L14');
    const run = firstRun(before, 'level');
    const grab: [number, number] = [
      (before[run]![0] + before[run + 1]![0]) / 2 + 3,
      before[run]![1],
    ];
    dragHandle(`sld-route-run-${run}`, grab, [0, 24]);

    const after = routeOf('line-L14');
    expect(after[run]![1]).toBe(before[run]![1] + 24);
    expect(byHand('line-L14')).toBe(true);
    // The dashed lines of a drag are gone once it is let go.
    expect(screen.queryByTestId('sld-route-refused')).toBeNull();
    expect(labels()).toEqual(['slide a run of line Line L14']);
  });

  it('moves a bend, with the two runs that meet there kept square', async () => {
    open('square.xlsx');
    await draw();
    pick('line-L14');
    const before = routeOf('line-L14');
    const run = firstRun(before, 'level');
    // The bend the level run starts at: the upright run before it goes along.
    dragHandle(`sld-route-bend-${run}`, before[run]!, [0, 16]);

    const after = routeOf('line-L14');
    expect(after[run]![1]).toBe(before[run]![1] + 16);
    expect(after.slice(1).every((p, i) => p[0] === after[i]![0] || p[1] === after[i]![1])).toBe(
      true,
    );
    expect(labels()).toEqual(['move a bend of line Line L14']);
  });

  it('is a click, and moves nothing, while the pointer has gone no way', async () => {
    open('square.xlsx');
    await draw();
    pick('line-L14');
    const before = routeOf('line-L14');
    dragHandle('sld-route-run-0', before[0]!, [1, 1]);
    expect(routeOf('line-L14')).toEqual(before);
    expect(byHand('line-L14')).toBe(false);
    expect(labels()).toEqual([]);
  });
});

describe('bends', () => {
  it('puts a bend into a run with Add bend, and makes a step of the half that is slid', async () => {
    open('square.xlsx');
    await draw();
    pick('line-L13');
    const before = routeOf('line-L13');
    const bends = () => screen.queryAllByTestId(/^sld-route-bend-/).length;
    const had = bends();

    fireEvent.click(screen.getByTestId('sld-route-add-bend'));
    expect(bends()).toBe(had + 1);
    expect(note()).toHaveTextContent('Bend added.');
    // Nothing of the line has changed yet, and nothing is kept for it.
    expect(routeOf('line-L13')).toEqual(before);
    expect(byHand('line-L13')).toBe(false);
    // The new bend is picked: it can be taken out again at once.
    fireEvent.click(screen.getByTestId('sld-route-remove-bend'));
    expect(bends()).toBe(had);
    expect(note()).toHaveTextContent('Bend removed.');
    expect(labels()).toEqual([]);
  });

  it('takes a bend of the route out with Delete, and the line runs straight past it', async () => {
    open('square.xlsx');
    await draw();
    pick('line-L14');
    slideDown('line-L14');
    const before = routeOf('line-L14');
    expect(before.length).toBeGreaterThan(3);
    press('sld-route-bend-1', 'Delete');
    const after = routeOf('line-L14');
    // Removed, or refused with the reason: either way the bar says which.
    if (after.length === before.length) {
      expect(note()).toHaveAttribute('data-tone', 'refused');
      expect(note()).toHaveTextContent(/^Not removed: /);
    } else {
      expect(after).toEqual([before[0], ...before.slice(2)]);
      expect(note()).toHaveTextContent('Bend removed.');
      expect(labels().at(-1)).toBe('remove a bend of line Line L14');
    }
  });
});

describe('a route drawn by hand', () => {
  it('is left as it is by a tidy, which says so', async () => {
    const success = vi.spyOn(toast, 'success');
    const info = vi.spyOn(toast, 'info');
    open('square.xlsx');
    await draw();
    pick('line-L14');
    slideDown('line-L14');
    const drawnByHand = routeOf('line-L14');

    for (const which of ['tidy', 'tidy-relayout'] as const) {
      post(which);
      expect(routeOf('line-L14'), which).toEqual(drawnByHand);
      expect(byHand('line-L14'), which).toBe(true);
    }
    const said = [...success.mock.calls, ...info.mock.calls]
      .map(([, options]) => (options as { description?: string } | undefined)?.description ?? '')
      .join(' ');
    expect(said).toContain('1 routed by hand');
    expect(said).toContain('Reset manual routes');
  });

  it('goes back to the automatic routing with Reset route, which Undo takes back', async () => {
    const success = vi.spyOn(toast, 'success');
    open('square.xlsx');
    await draw();
    const opened = routeOf('line-L14');
    pick('line-L14');
    slideDown('line-L14');
    const drawnByHand = routeOf('line-L14');

    fireEvent.click(screen.getByTestId('sld-route-reset'));
    await waitFor(() => expect(byHand('line-L14')).toBe(false));
    expect(routeOf('line-L14')).toEqual(opened);
    expect(screen.getByTestId('sld-route-status')).toHaveTextContent('Routed automatically');
    expect(success).toHaveBeenCalledWith(
      'Line Line L14 is routed automatically again',
      expect.anything(),
    );
    expect(useSldStore.getState().manualRouteCount).toBe(0);

    post('undo-layout');
    await waitFor(() => expect(byHand('line-L14')).toBe(true));
    expect(routeOf('line-L14')).toEqual(drawnByHand);
  });

  it('is reset with all the others by Reset manual routes, which says when there is none', async () => {
    const info = vi.spyOn(toast, 'info');
    const success = vi.spyOn(toast, 'success');
    open('square.xlsx');
    await draw();
    post('reset-manual-routes');
    expect(info).toHaveBeenCalledWith('No line is routed by hand.', expect.anything());
    expect(labels()).toEqual([]);

    pick('line-L14');
    slideDown('line-L14');
    // And the connector of the load, slid along the bar of its bus.
    pick('stub-load-PQ_1');
    press(`sld-route-run-${firstRun(routeOf('stub-load-PQ_1'), 'upright')}`, 'ArrowRight', true);
    expect(byHand('stub-load-PQ_1')).toBe(true);
    expect(useSldStore.getState().manualRouteCount).toBe(2);
    // What a route drawn by hand is, is said once and not for every line.
    expect(
      info.mock.calls.filter(([title]) => String(title).endsWith('is now routed by hand')),
    ).toHaveLength(1);
    post('reset-manual-routes');
    await waitFor(() => expect(useSldStore.getState().manualRouteCount).toBe(0));
    expect(success).toHaveBeenCalledWith(
      '2 routes are routed automatically again',
      expect.anything(),
    );
    // One step: Undo brings both back.
    post('undo-layout');
    await waitFor(() => expect(useSldStore.getState().manualRouteCount).toBe(2));
  });

  it("follows its bus when the bus is moved, and is the user's still", async () => {
    open('square.xlsx');
    await draw();
    pick('line-L14');
    slideDown('line-L14');
    const before = routeOf('line-L14');
    const bus = positionOf('4');

    dragNodeTo('4', { x: bus.x + 16, y: bus.y + 16 });
    await waitFor(() => expect(routeOf('line-L14').at(-1)![1]).toBe(before.at(-1)![1] + 16));
    const after = routeOf('line-L14');
    expect(after.at(-1)![0]).toBe(before.at(-1)![0] + 16);
    // The end went with the bus; where it leaves bus 1 it stayed.
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
    expect(byHand('line-L14')).toBe(true);
    // And it is the route that is kept, for where the bus stands now.
    await waitFor(() =>
      expect(useCaseStore.getState().routeOverrides['line-L14']).toEqual({
        points: after,
        anchors: { source: positionOf('1'), target: positionOf('4') },
        manual: true,
      }),
    );
  });

  it('reopens as it was drawn, from the layout that was written', async () => {
    open('square.xlsx');
    await draw();
    pick('line-L14');
    slideDown('line-L14');
    pick('stub-load-PQ_1');
    const stub = routeOf('stub-load-PQ_1');
    press(`sld-route-run-${firstRun(stub, 'upright')}`, 'ArrowRight', true);
    const drawnByHand = { line: routeOf('line-L14'), stub: routeOf('stub-load-PQ_1') };
    expect(byHand('stub-load-PQ_1')).toBe(true);
    expect(drawnByHand.stub).not.toEqual(stub);
    // The connector still leaves its device where it did, and lands on the bar.
    expect(drawnByHand.stub[0]).toEqual(stub[0]);
    expect(drawnByHand.stub.at(-1)![1]).toBe(stub.at(-1)![1]);

    const layout = await written();
    expect(layout.connections!.load!.PQ_1!.bend_points!.map(({ x, y }) => [x, y])).toEqual(
      drawnByHand.stub,
    );
    expect(layout.connections!.load!.PQ_1!.bus).toBe('4');

    cleanup();
    drawn.nodes = [];
    useCaseStore.getState().clearCase();
    history().clear();
    putSidecarSpy.mockClear();
    mockSidecar = parseSidecar(JSON.parse(JSON.stringify(layout)));
    open('square.xlsx');
    await draw();
    expect(routeOf('line-L14')).toEqual(drawnByHand.line);
    expect(routeOf('stub-load-PQ_1')).toEqual(drawnByHand.stub);
    expect(byHand('line-L14')).toBe(true);
    expect(byHand('stub-load-PQ_1')).toBe(true);
    expect(byHand('line-L12')).toBe(false);
    expect(useSldStore.getState().manualRouteCount).toBe(2);
    // A diagram that was only opened is not written.
    expect(putSidecarSpy).not.toHaveBeenCalled();
  });

  it('is not kept where the picture of the diagram would have something on something', async () => {
    open('square.xlsx');
    await draw();
    pick('line-L14');
    const before = routeOf('line-L14');
    forced.refuseRoutes = true;
    press(`sld-route-run-${firstRun(before, 'level')}`, 'ArrowDown');
    expect(routeOf('line-L14')).toEqual(before);
    expect(byHand('line-L14')).toBe(false);
    expect(note()).toHaveAttribute('data-tone', 'refused');
    expect(note()).toHaveTextContent(
      'Not moved: with the line there, something on the diagram would be drawn over something else.',
    );
    expect(labels()).toEqual([]);
    expect(putSidecarSpy).not.toHaveBeenCalled();
  });
});
