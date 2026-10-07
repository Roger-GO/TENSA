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
} = {
  nodes: [],
  edges: [],
  onNodesChange: null,
  onNodeDragStart: null,
  onNodeDragStop: null,
  onInteractiveChange: null,
  snapToGrid: undefined,
  snapGrid: undefined,
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
    children?: ReactNode;
  }) => {
    drawn.nodes = props.nodes;
    drawn.edges = props.edges;
    drawn.onNodesChange = props.onNodesChange;
    drawn.onNodeDragStart = props.onNodeDragStart;
    drawn.onNodeDragStop = props.onNodeDragStop;
    drawn.snapToGrid = props.snapToGrid;
    drawn.snapGrid = props.snapGrid;
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

// An ELK that lays the buses out two to a row and, on its routing pass, runs
// every branch out of the bottom of its first bus and into the top of its
// second with one bend, through the middle of each, as the real one does: the
// branches of a bus then leave it on top of each other.
vi.mock('@/components/sld/elkClient', () => ({
  elkLayout: vi.fn(
    async (graph: {
      children?: { id: string }[];
      edges?: { id: string; sources: string[]; targets: string[] }[];
    }) => {
      const children = (graph.children ?? []).map((c, i) => ({
        id: c.id,
        x: 300 * (i % 2) + 5,
        y: 220 * Math.floor(i / 2) + 7,
      }));
      const at = (port: string) => {
        const child = children.find((c) => c.id === port.split('.')[0]);
        if (!child) throw new Error(`no node for ${port}`);
        return child;
      };
      const edges = (graph.edges ?? []).map((e) => {
        const from = at(e.sources[0]!);
        const to = at(e.targets[0]!);
        return {
          id: e.id,
          sections: [
            {
              startPoint: { x: from.x + 46, y: from.y + 40 },
              bendPoints: [
                { x: from.x + 46, y: from.y + 100 },
                { x: to.x + 46, y: from.y + 100 },
              ],
              endPoint: { x: to.x + 46, y: to.y },
            },
          ],
        };
      });
      return { children, edges };
    },
  ),
}));

import { SldCanvas } from '@/components/sld/SldCanvas';
import { GRID_STEP } from '@/components/sld/tidy';
import { __clearAllPendingForTests, parseSidecar } from '@/components/sld/sidecar';
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

describe('Tidy diagram', () => {
  it('routes every branch afresh, moves nothing, and writes the result beside the case', async () => {
    const success = vi.spyOn(toast, 'success');
    open('square.xlsx');
    await draw();
    const before = picture();
    // The automatic layout turns the lines from bus 1 to buses 2 and 4 into
    // one corridor: they run on top of each other.
    const untidy = routes();
    expect(overlap(untidy['line-L12']!, untidy['line-L14']!)).toBeGreaterThan(0);

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
    expect(layout.branches?.line?.L13).toMatchObject({
      routing: 'polyline',
      bus1: '1',
      bus2: '3',
      bend_points: tidy['line-L13']!.map(([x, y]) => ({ x, y })),
    });
    expect(layout.branches?.transformer?.T24?.routing).toBe('polyline');
  });

  it('reopens as it was tidied', async () => {
    open('square.xlsx');
    await draw();
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
    open('square.xlsx');
    await draw();
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
    // The file follows: it holds the routes the automatic layout made again.
    const undone = await written();
    expect(undone.branches?.line?.L13?.bend_points).toEqual(
      before.picture.stored['line-L13']!.map(([x, y]) => ({ x, y })),
    );

    run('redo-layout');
    await waitFor(() => expect(routes()).toEqual(tidied.routes));
    expect(picture()).toEqual(tidied.picture);
    expect(info).toHaveBeenCalledWith('Redone: tidy diagram');
    expect(labels()).toEqual(['tidy diagram']);
  });

  it('offers Undo on its toast, which takes it back while it is the newest change', async () => {
    const success = vi.spyOn(toast, 'success');
    open('square.xlsx');
    await draw();
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
    open('square.xlsx');
    await draw();
    const before = routes();
    run('tidy');
    await waitFor(() => expect(routes()).not.toEqual(before));
    const tidied = routes();

    run('tidy');
    expect(info).toHaveBeenCalledWith('The diagram is already tidy.', expect.anything());
    expect(routes()).toEqual(tidied);
    expect(labels()).toEqual(['tidy diagram']);
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

  it('routes the branches of a bus that was dragged, which are drawn from tap to tap until then', async () => {
    open('square.xlsx');
    await draw();
    const start = positionOf('3');
    dragTo('3', { x: start.x + 150, y: start.y + 90 });
    await waitFor(() => expect(positionOf('3').x).toBe(start.x + 150));
    expect(picture().stored['line-L13']).toBeNull();

    run('tidy');
    await waitFor(() => expect(picture().stored['line-L13']).not.toBeNull());
    const points = routes()['line-L13']!;
    expect(squareCornered(points)).toBe(true);
    // It lands on the bar where the bus stands now.
    const end = points[points.length - 1]!;
    expect(end[1]).toBe(start.y + 90 + 3);
    expect(end[0]).toBeGreaterThanOrEqual(start.x + 150);
    expect(end[0]).toBeLessThanOrEqual(start.x + 150 + 92);
    expect(labels()).toEqual(['move bus Bus 3', 'tidy diagram']);
  });
});

describe('Tidy diagram on a large diagram', () => {
  it('says that it is at work before it starts, and takes no second press meanwhile', async () => {
    // A chain of 62 buses: more branches than are routed within the press.
    const buses = Array.from({ length: 62 }, (_, i) => i + 1);
    mockTopology = {
      ...square(),
      buses: buses.map((i) => entry(i, 'Bus', {})),
      lines: buses.slice(1).map((i) => entry(`L${i}`, 'Line', { bus1: i - 1, bus2: i })),
      transformers: [],
    };
    open('chain.xlsx');
    await draw();
    const before = picture();

    fireEvent.click(screen.getByTestId('sld-tidy'));
    // Nothing is routed yet: the button says so first.
    const button = screen.getByTestId('sld-tidy');
    expect(button).toHaveTextContent('Tidying…');
    expect(button).toBeDisabled();
    expect(labels()).toEqual([]);
    run('tidy');

    await waitFor(() => expect(labels()).toEqual(['tidy diagram']), { timeout: 15_000 });
    await waitFor(() => expect(screen.getByTestId('sld-tidy')).toHaveTextContent('Tidy diagram'));
    expect(screen.getByTestId('sld-tidy')).toBeEnabled();
    expect(picture().positions).toEqual(before.positions);
    expect(picture().stored).not.toEqual(before.stored);
  }, 30_000);
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
    expect(picture().stored['line-L12']).toBeNull();
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
    open('square.xlsx');
    await draw();
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
  });
});

describe('Reset to auto-layout', () => {
  it('forgets the tidied routes, and Undo brings them back', async () => {
    putSidecarSpy.mockImplementation((_vars: unknown, callbacks?: { onSuccess?: () => void }) =>
      callbacks?.onSuccess?.(),
    );
    open('square.xlsx');
    await draw();
    const automatic = { picture: picture(), routes: routes() };
    run('tidy');
    await waitFor(() => expect(routes()).not.toEqual(automatic.routes));
    const tidied = { picture: picture(), routes: routes() };

    run('reset-layout');
    await waitFor(() => expect(routes()).toEqual(automatic.routes));
    expect(useCaseStore.getState().routeOverrides).toEqual({});
    expect(labels()).toEqual(['tidy diagram', 'reset to auto-layout']);

    run('undo-layout');
    await waitFor(() => expect(routes()).toEqual(tidied.routes));
    expect(picture()).toEqual(tidied.picture);
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
  it('hands each branch the place of its label, on a run of its route', async () => {
    open('square.xlsx');
    await draw();
    run('tidy');
    await waitFor(() => expect(labels()).toEqual(['tidy diagram']));
    for (const edge of drawn.edges.filter((e) => e.type !== 'stub')) {
      const at = edge.data?.labelAt as { x: number; y: number } | undefined;
      const points = (edge.data?.route as { points: Points }).points;
      expect(at, edge.id).toBeDefined();
      const onRun = points.slice(1).some((p, i) => {
        const a = points[i]!;
        return (
          at!.x >= Math.min(a[0], p[0]) &&
          at!.x <= Math.max(a[0], p[0]) &&
          at!.y >= Math.min(a[1], p[1]) &&
          at!.y <= Math.max(a[1], p[1])
        );
      });
      expect(onRun, edge.id).toBe(true);
    }
    // A device connector carries no label.
    expect(drawn.edges.find((e) => e.type === 'stub')?.data?.labelAt).toBeUndefined();
  });

  it('tells a bus what runs through the strip its label hangs in', async () => {
    open('square.xlsx');
    await draw();
    // Bus 1 has lines leaving under it: each is a stretch for the label to clear.
    const bus = drawn.nodes.find((n) => n.id === '1')!;
    const clear = bus.data.labelClear as [number, number][] | undefined;
    expect(clear).toBeDefined();
    expect(clear!.length).toBeGreaterThan(0);
    for (const [from, to] of clear!) expect(from).toBeLessThanOrEqual(to);
    // A bus nothing passes under is told nothing.
    mockTopology = { ...square(), lines: [], transformers: [] };
    cleanup();
    drawn.nodes = [];
    useCaseStore.getState().clearCase();
    open('square.xlsx');
    await draw();
    expect(drawn.nodes.find((n) => n.id === '2')!.data.labelClear).toBeUndefined();
  });
});
