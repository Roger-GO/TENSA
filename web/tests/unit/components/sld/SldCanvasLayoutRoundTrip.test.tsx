/**
 * Place, save, reload: the diagram comes back as it was.
 *
 * The canvas is rendered against a stand-in for React Flow that records what
 * it is asked to draw (every node's position, every edge's route) and hands
 * back `onNodesChange` and the drag-start and drag-stop handlers, so a test
 * can end a drag, or make a whole one, the way React Flow does.
 * "Save" is whatever the canvas keeps for the save paths (`diagramLayout` in
 * the case store) or writes itself after a drag (`PUT /workspace/layout`).
 * "Reload" is a fresh canvas given that document as the saved layout, after
 * it has been through the validator, as it would come back from the server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

interface DrawnNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  draggable?: boolean;
  data: Record<string, unknown>;
}
interface DrawnEdge {
  id: string;
  type?: string;
  data?: Record<string, unknown>;
}
interface PositionChange {
  id: string;
  type: 'position';
  position: { x: number; y: number };
  dragging: boolean;
}

type DragHandler = (
  event: unknown,
  node: Pick<DrawnNode, 'id' | 'position'>,
  nodes: Pick<DrawnNode, 'id' | 'position'>[],
) => void;

/** What the canvas last asked React Flow to draw, and the zoom React Flow reports. */
const drawn: {
  nodes: DrawnNode[];
  edges: DrawnEdge[];
  onNodesChange: ((changes: PositionChange[]) => void) | null;
  onNodeDragStart: DragHandler | null;
  onNodeDragStop: DragHandler | null;
  zoom: number;
} = {
  nodes: [],
  edges: [],
  onNodesChange: null,
  onNodeDragStart: null,
  onNodeDragStop: null,
  zoom: 1,
};

vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: {
    nodes: DrawnNode[];
    edges: DrawnEdge[];
    onNodesChange: (changes: PositionChange[]) => void;
    onNodeDragStart: DragHandler;
    onNodeDragStop: DragHandler;
  }) => {
    drawn.nodes = props.nodes;
    drawn.edges = props.edges;
    drawn.onNodesChange = props.onNodesChange;
    drawn.onNodeDragStart = props.onNodeDragStart;
    drawn.onNodeDragStop = props.onNodeDragStop;
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
    selector({ transform: [0, 0, 1] }),
  useReactFlow: () => ({
    setCenter: vi.fn(),
    getZoom: () => drawn.zoom,
    getNodes: () => [],
    fitView: vi.fn(),
    screenToFlowPosition: (p: { x: number; y: number }) => p,
  }),
}));

// An ELK that lays the buses out on a slope, a little off the grid. It is
// asked for the places of the buses only: the diagram is arranged around
// them, and its branches routed, afterwards (`useAutoLayout`).
vi.mock('@/components/sld/elkClient', () => ({
  elkLayout: vi.fn(async (graph: { children?: { id: string }[] }) => ({
    children: (graph.children ?? []).map((c, i) => ({
      id: c.id,
      x: 240 * i + 1 / 3,
      y: 130 * i,
    })),
  })),
}));

import { SldCanvas } from '@/components/sld/SldCanvas';
import { elkLayout } from '@/components/sld/elkClient';
import {
  __clearAllPendingForTests,
  branchPolylines,
  layoutForRenumberedCopy,
  parseSidecar,
} from '@/components/sld/sidecar';
import type { UnitNodeData } from '@/components/sld/graph';
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { __requestUnitExpanded } from '@/store/sld';
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

/** Four buses in a chain, a machine with its exciter and governor, a load and a shunt. */
function chain(): TopologySummary {
  return {
    state: 'pre-setup',
    buses: [1, 2, 3, 4].map((i) => entry(i, 'Bus', {})),
    lines: [entry('L12', 'Line', { bus1: 1, bus2: 2 }), entry('L23', 'Line', { bus1: 2, bus2: 3 })],
    transformers: [entry('T34', 'Line', { bus1: 3, bus2: 4 })],
    generators: [entry('G1', 'GENROU', { bus: 1 })],
    loads: [entry('PQ_1', 'PQ', { bus: 4 })],
    shunts: [entry('Shunt_1', 'Shunt', { bus: 3 })],
    controllers: [entry('E1', 'EXST1', { syn: 'G1' }), entry('T1', 'TGOV1', { syn: 'G1' })],
  };
}

/** Every node's position and every branch's route, as last drawn. */
function picture() {
  return {
    positions: Object.fromEntries(drawn.nodes.map((n) => [n.id, { ...n.position }])),
    routes: Object.fromEntries(
      drawn.edges.map((e) => [e.id, { type: e.type, bendPoints: e.data?.bendPoints ?? null }]),
    ),
  };
}

function open(casePath: string): void {
  useCaseStore.getState().setCase({ primaryPath: parseWorkspacePath(casePath), addfiles: [] });
}

async function draw(): Promise<void> {
  render(<SldCanvas />);
  await waitFor(() => expect(drawn.nodes.length).toBeGreaterThan(0));
}

/** Close the case and come back to it with `saved` as the layout on disk. */
async function reload(casePath: string, saved: SidecarLayout): Promise<void> {
  cleanup();
  drawn.nodes = [];
  drawn.edges = [];
  drawn.onNodesChange = null;
  useCaseStore.getState().clearCase();
  // Through JSON and the validator: what the server stores and gives back.
  mockSidecar = parseSidecar(JSON.parse(JSON.stringify(saved)));
  vi.mocked(elkLayout).mockClear();
  open(casePath);
  await draw();
}

/** End a drag of `id` at `to`, as React Flow reports it. */
function dropAt(id: string, to: { x: number; y: number }): void {
  act(() => {
    drawn.onNodesChange?.([{ id, type: 'position', position: to, dragging: false }]);
  });
}

/**
 * A whole pointer drag of `id` to `to`, as React Flow reports one that starts
 * on the press: the start, the node following the pointer, the end, the stop.
 */
function dragTo(id: string, to: { x: number; y: number }): void {
  const node = drawn.nodes.find((n) => n.id === id);
  if (node === undefined) throw new Error(`no node ${id}`);
  const from = { id, position: { ...node.position } };
  act(() => {
    drawn.onNodeDragStart?.({}, from, [from]);
    drawn.onNodesChange?.([{ id, type: 'position', position: to, dragging: true }]);
    drawn.onNodesChange?.([{ id, type: 'position', position: to, dragging: false }]);
    drawn.onNodeDragStop?.({}, { id, position: to }, [{ id, position: to }]);
  });
}

function savedLayout(): SidecarLayout {
  const layout = useCaseStore.getState().diagramLayout;
  if (layout === null) throw new Error('the canvas kept no layout');
  return layout;
}

beforeEach(() => {
  mockTopology = chain();
  mockSidecar = null;
  putSidecarSpy.mockClear();
  vi.mocked(elkLayout).mockClear();
  drawn.nodes = [];
  drawn.edges = [];
  drawn.onNodesChange = null;
  drawn.zoom = 1;
  useSessionStore.setState({ sessionId: parseSessionId('sess-layout') });
  useCaseStore.getState().clearCase();
});

afterEach(() => {
  cleanup();
  __clearAllPendingForTests();
  useCaseStore.getState().clearCase();
});

describe('place, save, reload', () => {
  it('a case in its automatic layout is saved with everything it shows, and reopens the same', async () => {
    open('kundur.xlsx');
    await draw();
    const before = picture();
    // The automatic arrangement put the buses on the grid and routed the
    // branches through fixed points.
    expect(before.positions['2']).toEqual({ x: 240, y: 128 });
    expect(before.routes['line-L12']?.type).toBe('routed');
    expect(
      (before.routes['transformer-T34']?.bendPoints as unknown[] | null)?.length,
    ).toBeGreaterThanOrEqual(2);

    // What a save sends: every bus, every device and every route, though
    // nothing was dragged.
    const saved = savedLayout();
    expect(Object.keys(saved.coordinates)).toEqual(['1', '2', '3', '4']);
    expect(Object.keys(saved.non_bus_coordinates ?? {}).sort()).toEqual(
      ['GENROU', 'PQ', 'Shunt', 'generator', 'load', 'shunt'].sort(),
    );
    expect([...branchPolylines(saved, chain()).keys()]).toEqual([
      'line-L12',
      'line-L23',
      'transformer-T34',
    ]);

    // Saved under a new name, which has no curated layout and no ELK run of
    // its own to fall back on.
    await reload('saved-copy.xlsx', saved);

    expect(picture()).toEqual(before);
    // Nothing was laid out again: the saved layout places every bus.
    expect(elkLayout).not.toHaveBeenCalled();
  });

  it('a case in its curated layout keeps that layout under a new name', async () => {
    // `ieee14` has a layout shipped with the app, found by the file's name.
    mockTopology = { ...chain(), buses: [1, 2, 3, 4].map((i) => entry(i, 'Bus', {})) };
    open('ieee14.raw');
    await draw();
    const before = picture();
    expect(before.positions['1']).toEqual({ x: 200, y: 100 });
    expect(elkLayout).not.toHaveBeenCalled();

    await reload('my-system.xlsx', savedLayout());

    // The new name matches no curated layout; the saved one carries it.
    expect(picture()).toEqual(before);
    expect(elkLayout).not.toHaveBeenCalled();
  });

  it('a drag is written beside the case with the whole diagram, and reopens the same', async () => {
    open('kundur.xlsx');
    await draw();
    const start = picture();

    const movedTo = { x: start.positions['1']!.x - 80.5, y: start.positions['1']!.y + 45.25 };
    dropAt('1', movedTo);
    await waitFor(() => expect(drawn.nodes.find((n) => n.id === '1')?.position).toEqual(movedTo));
    // The branch of the bus that moved is routed to where the bus stands
    // now, and that route is kept; the others keep the routes they had.
    await waitFor(() =>
      expect(picture().routes['line-L12']?.bendPoints).not.toEqual(
        start.routes['line-L12']?.bendPoints,
      ),
    );
    const placed = picture();
    const moved = placed.routes['line-L12']?.bendPoints as [number, number][];
    expect(placed.routes['line-L12']?.type).toBe('routed');
    expect(moved[0]![1]).toBe(movedTo.y + 3);
    expect(placed.routes['line-L23']).toEqual(start.routes['line-L23']);
    expect(placed.routes['transformer-T34']).toEqual(start.routes['transformer-T34']);

    // The debounced write: one, with the move and the route it led to.
    await waitFor(() => expect(putSidecarSpy).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const [vars] = putSidecarSpy.mock.calls[0] as [{ casePath: string; layout: SidecarLayout }];
    expect(vars.casePath).toBe('kundur.xlsx');
    expect(vars.layout.schema_version).toBe('2');
    expect(vars.layout.coordinates['1']).toEqual(movedTo);
    expect([...branchPolylines(vars.layout, chain()).keys()]).toEqual([
      'line-L12',
      'line-L23',
      'transformer-T34',
    ]);
    expect(branchPolylines(vars.layout, chain()).get('line-L12')).toEqual(moved);
    // A badge is no bus: none is filed among the bus coordinates.
    expect(Object.keys(vars.layout.coordinates)).toEqual(['1', '2', '3', '4']);

    await reload('kundur.xlsx', vars.layout);

    expect(picture()).toEqual(placed);
  });

  it('a drag still waiting to be written when the canvas goes away is written then', async () => {
    // The write waits out a delay, so that a run of drags is one request. When
    // another view takes the canvas's place inside that delay, the drag stays
    // in the store and is drawn again when the canvas comes back, so the file
    // has to get it too: dropped, it would be a drag behind the diagram.
    open('kundur.xlsx');
    await draw();
    const movedTo = { x: -80.5, y: 45.25 };
    dropAt('1', movedTo);
    await waitFor(() => expect(drawn.nodes.find((n) => n.id === '1')?.position).toEqual(movedTo));
    expect(putSidecarSpy).not.toHaveBeenCalled();

    cleanup(); // the canvas is gone; the case is still open

    expect(putSidecarSpy).toHaveBeenCalledTimes(1);
    const [vars] = putSidecarSpy.mock.calls[0] as [{ casePath: string; layout: SidecarLayout }];
    expect(vars.casePath).toBe('kundur.xlsx');
    expect(vars.layout.coordinates['1']).toEqual(movedTo);

    // Back on the diagram, it shows what the file now holds.
    drawn.nodes = [];
    await draw();
    expect(drawn.nodes.find((n) => n.id === '1')?.position).toEqual(movedTo);
    expect(putSidecarSpy).toHaveBeenCalledTimes(1);
  });

  it('opening another case writes the drag still waiting, beside the case it was made in', async () => {
    open('kundur.xlsx');
    await draw();
    const movedTo = { x: -80.5, y: 45.25 };
    dropAt('1', movedTo);
    await waitFor(() => expect(drawn.nodes.find((n) => n.id === '1')?.position).toEqual(movedTo));
    expect(putSidecarSpy).not.toHaveBeenCalled();

    act(() => open('other.xlsx'));

    await waitFor(() => expect(putSidecarSpy).toHaveBeenCalledTimes(1));
    const [vars] = putSidecarSpy.mock.calls[0] as [{ casePath: string; layout: SidecarLayout }];
    expect(vars.casePath).toBe('kundur.xlsx');
    expect(vars.layout.coordinates['1']).toEqual(movedTo);
  });

  it('a press that slips a pixel or two is a click: the node goes back and nothing is kept', async () => {
    // The drag starts on the press, so React Flow moves the node by whatever
    // the pointer did before it was let go. Two pixels on screen are eight
    // units of the diagram at a quarter of its size.
    drawn.zoom = 0.25;
    open('kundur.xlsx');
    await draw();
    const start = picture();
    const from = start.positions['1']!;

    dragTo('1', { x: from.x + 8, y: from.y });

    expect(drawn.nodes.find((n) => n.id === '1')?.position).toEqual(from);
    expect(picture()).toEqual(start);
    expect(useCaseStore.getState().dragOverrides).toEqual({});
    // Nothing waits to be written either: leaving the canvas sends what does.
    cleanup();
    expect(putSidecarSpy).not.toHaveBeenCalled();
  });

  it('a drag of three pixels is a drag, and a move by an arrow key is kept however small', async () => {
    drawn.zoom = 0.25;
    open('kundur.xlsx');
    await draw();
    const from = picture().positions['1']!;

    const dragged = { x: from.x + 12, y: from.y };
    dragTo('1', dragged);
    await waitFor(() => expect(drawn.nodes.find((n) => n.id === '1')?.position).toEqual(dragged));
    expect(useCaseStore.getState().dragOverrides['1']).toEqual(dragged);

    // An arrow key moves a node five units, which is little more than a pixel
    // here, and React Flow reports it with no drag around it.
    const nudged = { x: dragged.x + 5, y: dragged.y };
    dropAt('1', nudged);
    await waitFor(() => expect(drawn.nodes.find((n) => n.id === '1')?.position).toEqual(nudged));
    expect(useCaseStore.getState().dragOverrides['1']).toEqual(nudged);

    await waitFor(() => expect(putSidecarSpy).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const [vars] = putSidecarSpy.mock.calls[0] as [{ layout: SidecarLayout }];
    expect(vars.layout.coordinates['1']).toEqual(nudged);
  });

  it('a second drag after a reload moves only what was dragged', async () => {
    open('kundur.xlsx');
    await draw();
    dropAt('1', { x: -80, y: 45 });
    await waitFor(() => expect(putSidecarSpy).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const [first] = putSidecarSpy.mock.calls[0] as [{ layout: SidecarLayout }];
    await reload('kundur.xlsx', first.layout);
    const reopened = picture();

    dropAt('load-PQ_1', { x: 900, y: 600 });
    await waitFor(() =>
      expect(drawn.nodes.find((n) => n.id === 'load-PQ_1')?.position).toEqual({ x: 900, y: 600 }),
    );

    const after = picture();
    expect(after.positions).toEqual({ ...reopened.positions, 'load-PQ_1': { x: 900, y: 600 } });
    // No bus moved, so no branch lost its route to the drag of a load.
    expect(after.routes).toEqual(reopened.routes);
  });

  it('a machine is dragged with its controllers as one node, and comes back where it was put', async () => {
    open('kundur.xlsx');
    await draw();
    // The exciter and the governor are named on the machine's symbol; they
    // have no node that could be left behind. (They used to be badges beside
    // the machine, which stayed where it had been.)
    expect(drawn.nodes.filter((n) => n.type === 'controller')).toEqual([]);
    const unit = drawn.nodes.find((n) => n.id === 'generator-G1')!.data.unit as UnitNodeData;
    expect(unit.members.map((m) => `${m.kind} ${m.idx}`)).toEqual([
      'GENROU G1',
      'EXST1 E1',
      'TGOV1 T1',
    ]);
    const machineAt = { x: 640, y: -210 };

    dropAt('generator-G1', machineAt);
    await waitFor(() =>
      expect(drawn.nodes.find((n) => n.id === 'generator-G1')?.position).toEqual(machineAt),
    );
    const overrides = useCaseStore.getState().dragOverrides;
    expect(Object.keys(overrides).some((id) => id.startsWith('controller-'))).toBe(false);
    expect(overrides['generator-G1']).toEqual(machineAt);
    const placed = picture();

    await waitFor(() => expect(putSidecarSpy).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const [vars] = putSidecarSpy.mock.calls[0] as [{ layout: SidecarLayout }];
    expect(vars.layout.controller_coordinates).toEqual({});
    await reload('kundur.xlsx', vars.layout);

    expect(picture()).toEqual(placed);
  });

  it('a unit whose control chain is drawn out is saved so, and reopens so, until it is folded again', async () => {
    const isDrawnOut = (): boolean =>
      (drawn.nodes.find((n) => n.id === 'generator-G1')!.data.unit as UnitNodeData).expanded;
    open('kundur.xlsx');
    await draw();
    expect(isDrawnOut()).toBe(false);
    const before = picture();

    // What the control on the unit's symbol asks for.
    act(() => __requestUnitExpanded('G1', true));
    expect(isDrawnOut()).toBe(true);
    // The chain takes no room of the node's: nothing moved.
    expect(picture()).toEqual(before);
    expect(savedLayout().units).toEqual({ G1: { expanded: true, bus: '1' } });
    await waitFor(() => expect(putSidecarSpy).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const [drawnOut] = putSidecarSpy.mock.calls[0] as [{ layout: SidecarLayout }];
    expect(drawnOut.layout.units).toEqual({ G1: { expanded: true, bus: '1' } });

    await reload('kundur.xlsx', drawnOut.layout);
    expect(isDrawnOut()).toBe(true);
    expect(picture()).toEqual(before);
    // A drag keeps it: the layout that is written still says so.
    dropAt('2', { x: 77, y: 88 });
    await waitFor(() => expect(putSidecarSpy).toHaveBeenCalledTimes(2), { timeout: 3000 });
    const [dragged] = putSidecarSpy.mock.calls[1] as [{ layout: SidecarLayout }];
    expect(dragged.layout.units).toEqual({ G1: { expanded: true, bus: '1' } });

    act(() => __requestUnitExpanded('G1', false));
    expect(isDrawnOut()).toBe(false);
    await waitFor(() => expect(putSidecarSpy).toHaveBeenCalledTimes(3), { timeout: 3000 });
    const [folded] = putSidecarSpy.mock.calls[2] as [{ layout: SidecarLayout }];
    // Folded is how a unit is drawn without an entry.
    expect(folded.layout.units).toEqual({});
    await reload('kundur.xlsx', folded.layout);
    expect(isDrawnOut()).toBe(false);
  });

  it('a device dropped on another is put beside it, and comes back where it was put', async () => {
    open('kundur.xlsx');
    await draw();
    const shuntAt = drawn.nodes.find((n) => n.id === 'shunt-Shunt_1')!.position;
    const before = { ...drawn.nodes.find((n) => n.id === 'load-PQ_1')!.position };
    const dropped = { x: shuntAt.x + 10, y: shuntAt.y + 5 };

    dropAt('load-PQ_1', dropped);
    await waitFor(() =>
      expect(drawn.nodes.find((n) => n.id === 'load-PQ_1')?.position).not.toEqual(before),
    );
    // Not where it was dropped, on the shunt, but in the nearest free place.
    const put = { ...drawn.nodes.find((n) => n.id === 'load-PQ_1')!.position };
    expect(put).not.toEqual(dropped);
    const size = (id: string) => {
      const node = drawn.nodes.find((n) => n.id === id)! as unknown as {
        initialWidth?: number;
        initialHeight?: number;
      };
      return { width: node.initialWidth ?? 0, height: node.initialHeight ?? 0 };
    };
    const [load, other] = [size('load-PQ_1'), size('shunt-Shunt_1')];
    const apart =
      put.x >= shuntAt.x + other.width ||
      shuntAt.x >= put.x + load.width ||
      put.y >= shuntAt.y + other.height ||
      shuntAt.y >= put.y + load.height;
    expect(apart).toBe(true);
    const placed = picture();
    await waitFor(() => expect(putSidecarSpy).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const [vars] = putSidecarSpy.mock.calls[0] as [{ layout: SidecarLayout }];

    await reload('kundur.xlsx', vars.layout);

    expect(drawn.nodes.find((n) => n.id === 'load-PQ_1')?.position).toEqual(put);
    expect(drawn.nodes.find((n) => n.id === 'shunt-Shunt_1')?.position).toEqual(shuntAt);
    expect(picture()).toEqual(placed);
  });

  it('a layout that holds two devices on each other reopens as it was saved, not pushed aside', async () => {
    // The pass that separates overlapping devices runs on every build of the
    // diagram. It must leave a saved position alone, or what a layout of an
    // earlier version holds close together reopens somewhere else.
    open('kundur.xlsx');
    await draw();
    const shuntAt = { ...drawn.nodes.find((n) => n.id === 'shunt-Shunt_1')!.position };
    const loadAt = drawn.nodes.find((n) => n.id === 'load-PQ_1')!.position;
    dropAt('load-PQ_1', { x: loadAt.x, y: loadAt.y - 1 });
    await waitFor(() => expect(putSidecarSpy).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const [vars] = putSidecarSpy.mock.calls[0] as [{ layout: SidecarLayout }];
    // The same layout with the load on the shunt.
    const onShunt = { x: shuntAt.x + 10, y: shuntAt.y + 5 };
    const saved: SidecarLayout = JSON.parse(JSON.stringify(vars.layout)) as SidecarLayout;
    const held = saved.non_bus_coordinates!.PQ!.PQ_1!;
    saved.non_bus_coordinates!.PQ!.PQ_1 = { ...held, ...onShunt };

    await reload('kundur.xlsx', saved);

    expect(drawn.nodes.find((n) => n.id === 'load-PQ_1')?.position).toEqual(onShunt);
    expect(drawn.nodes.find((n) => n.id === 'shunt-Shunt_1')?.position).toEqual(shuntAt);
  });

  it('keeps nothing from the moment a new bus is drawn before it has been laid out', async () => {
    // A bus added to the case reaches the canvas a render before its position
    // does, and until the layout answers it is drawn at the origin. A save in
    // that moment must not record it there.
    open('kundur.xlsx');
    const { rerender } = render(<SldCanvas />);
    await waitFor(() => expect(drawn.nodes.length).toBeGreaterThan(0));
    const kept: SidecarLayout[] = [];
    const unsubscribe = useCaseStore.subscribe((state, previous) => {
      if (state.diagramLayout !== null && state.diagramLayout !== previous.diagramLayout) {
        kept.push(state.diagramLayout);
      }
    });

    const base = chain();
    mockTopology = {
      ...base,
      buses: [...base.buses, entry(5, 'Bus', {})],
      lines: [...base.lines, entry('L45', 'Line', { bus1: 4, bus2: 5 })],
    };
    rerender(<SldCanvas />);
    await waitFor(() => expect(savedLayout().coordinates['5']).toBeDefined());
    unsubscribe();

    // Wherever the layout engine put it, that is the only place it was kept at.
    const finalAt = drawn.nodes.find((n) => n.id === '5')!.position;
    expect(finalAt).not.toEqual({ x: 0, y: 0 });
    const seen = kept.filter((layout) => layout.coordinates['5'] !== undefined);
    expect(seen.length).toBeGreaterThan(0);
    for (const layout of seen) expect(layout.coordinates['5']).toEqual(finalAt);
  });

  it('a system saved as .raw reopens as placed though its devices and lines were renumbered', async () => {
    // A .raw file keeps no idx. Read back, the machine is a plain generator
    // under another idx, its controllers are gone, the load and the shunt
    // have new names, and the lines are numbered from one.
    open('kundur.xlsx');
    await draw();
    dropAt('generator-G1', { x: 640, y: -210 });
    dropAt('load-PQ_1', { x: 900, y: 600 });
    await waitFor(() =>
      expect(drawn.nodes.find((n) => n.id === 'load-PQ_1')?.position).toEqual({ x: 900, y: 600 }),
    );
    const placed = picture();
    const beside = layoutForRenumberedCopy(savedLayout());

    mockTopology = {
      state: 'pre-setup',
      buses: [1, 2, 3, 4].map((i) => entry(i, 'Bus', {})),
      lines: [
        entry('Line_1', 'Line', { bus1: 1, bus2: 2 }),
        entry('Line_2', 'Line', { bus1: 2, bus2: 3 }),
      ],
      transformers: [entry('Line_3', 'Line', { bus1: 3, bus2: 4 })],
      generators: [entry('1', 'PV', { bus: 1 })],
      loads: [entry('PQ_7', 'PQ', { bus: 4 })],
      shunts: [entry('Shunt_9', 'Shunt', { bus: 3 })],
      controllers: [],
    };
    await reload('kundur.raw', beside);

    const now = picture();
    // Same places, under the names the elements have now.
    const renamed: Record<string, string> = {
      'generator-G1': 'generator-1',
      'load-PQ_1': 'load-PQ_7',
      'shunt-Shunt_1': 'shunt-Shunt_9',
    };
    for (const [id, at] of Object.entries(placed.positions)) {
      if (id.startsWith('controller-')) continue; // a .raw holds no controllers
      expect(now.positions[renamed[id] ?? id]).toEqual(at);
    }
    expect(now.routes['line-Line_1']).toEqual(placed.routes['line-L12']);
    expect(now.routes['line-Line_2']).toEqual(placed.routes['line-L23']);
    expect(now.routes['transformer-Line_3']).toEqual(placed.routes['transformer-T34']);
    // Every bus is placed, so nothing was laid out again.
    expect(elkLayout).not.toHaveBeenCalled();
  });

  it('what the canvas does not draw from is carried through a drag untouched', async () => {
    // Sections written by another editor of the layout: a drag must not
    // lose them, or the next save would write a layout without them.
    open('kundur.xlsx');
    await draw();
    const extras = {
      busbars: { '2': { length: 180, orientation: 'vertical' as const } },
      label_offsets: { bus: { '3': { dx: 4, dy: -12 } } },
      connections: { load: { PQ_1: { device_face: 'north' as const, bus_face: null } } },
      figure: { monochrome: true, line_width: 1.5 },
    };
    await reload('kundur.xlsx', { ...savedLayout(), ...extras });
    expect(savedLayout()).toMatchObject(extras);

    dropAt('2', { x: 77, y: 88 });
    await waitFor(() => expect(putSidecarSpy).toHaveBeenCalledTimes(1), { timeout: 3000 });

    const [vars] = putSidecarSpy.mock.calls[0] as [{ layout: SidecarLayout }];
    expect(vars.layout).toMatchObject(extras);
    expect(vars.layout.coordinates['2']).toEqual({ x: 77, y: 88 });
  });

  it('a controller the saved layout places stays where it was placed', async () => {
    open('kundur.xlsx');
    await draw();
    const placedAt = { x: 1200, y: -400 };
    await reload('kundur.xlsx', {
      ...savedLayout(),
      controller_coordinates: { EXST1: { E1: placedAt } },
    });

    expect(drawn.nodes.find((n) => n.id === 'controller-EXST1-E1')?.position).toEqual(placedAt);
    // And the next layout written still has it.
    expect(savedLayout().controller_coordinates).toEqual({ EXST1: { E1: placedAt } });
    const before = picture();
    await reload('kundur.xlsx', savedLayout());
    expect(picture()).toEqual(before);
  });

  it('an element added since the save is drawn, and one removed leaves nothing behind', async () => {
    open('kundur.xlsx');
    await draw();
    const saved = savedLayout();

    // Bus 4 with its transformer and load is gone; bus 5 and a line to it are new.
    const base = chain();
    mockTopology = {
      ...base,
      buses: [1, 2, 3, 5].map((i) => entry(i, 'Bus', {})),
      lines: [...base.lines, entry('L35', 'Line', { bus1: 3, bus2: 5 })],
      transformers: [],
      loads: [],
    };
    await reload('kundur.xlsx', saved);

    const ids = drawn.nodes.map((n) => n.id);
    expect(ids).toContain('5');
    expect(ids).not.toContain('4');
    expect(ids).not.toContain('load-PQ_1');
    // The buses the layout knows stay where it has them.
    expect(drawn.nodes.find((n) => n.id === '2')?.position).toEqual(saved.coordinates['2']);
    // What is written next describes the case as it is now, the new line
    // with the route the diagram made for it.
    await waitFor(() =>
      expect(Object.keys(savedLayout().branches?.line ?? {})).toEqual(['L12', 'L23', 'L35']),
    );
    const next = savedLayout();
    expect(Object.keys(next.coordinates).sort()).toEqual(['1', '2', '3', '5']);
    expect(next.non_bus_coordinates?.load).toBeUndefined();
    expect(next.branches?.transformer).toBeUndefined();
    // Nothing is written for it until something on the diagram is changed.
    expect(putSidecarSpy).not.toHaveBeenCalled();
  });
});
