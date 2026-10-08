/**
 * What the canvas hands React Flow for the connections of the diagram: the
 * route of every connector and branch, the bar of every bus, and how these
 * follow a drag, a measured node, and the choice of connector style. Also
 * which connector it marks to be drawn picked out: that of the device that
 * is selected, or under the pointer in a drag.
 *
 * The canvas is rendered against a stand-in for React Flow that records the
 * nodes and edges it is asked to draw and hands back `onNodesChange`, so a
 * test can move a node the way a drag does (before it is dropped) and report
 * a measured size the way React Flow does, and the two handlers React Flow
 * calls when a drag starts and when it stops.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import type { BarGeometry, ConnectorRoute } from '@/components/sld/connections';

interface DrawnNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  measured?: { width: number; height: number };
  initialWidth?: number;
  initialHeight?: number;
  data: Record<string, unknown>;
}
interface DrawnEdge {
  id: string;
  type?: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  data?: Record<string, unknown>;
}
type OnDrag = (event: unknown, node: DrawnNode, nodes: DrawnNode[]) => void;
type Change =
  | { id: string; type: 'position'; position: { x: number; y: number }; dragging: boolean }
  | { id: string; type: 'dimensions'; dimensions: { width: number; height: number } };

const drawn: {
  nodes: DrawnNode[];
  edges: DrawnEdge[];
  onNodesChange: ((changes: Change[]) => void) | null;
  onNodeDragStart: OnDrag | null;
  onNodeDragStop: OnDrag | null;
} = { nodes: [], edges: [], onNodesChange: null, onNodeDragStart: null, onNodeDragStop: null };

vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: {
    nodes: DrawnNode[];
    edges: DrawnEdge[];
    onNodesChange: (changes: Change[]) => void;
    onNodeDragStart: OnDrag;
    onNodeDragStop: OnDrag;
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
    getZoom: () => 1,
    getNodes: () => [],
    fitView: vi.fn(),
    screenToFlowPosition: (p: { x: number; y: number }) => p,
  }),
}));

// The auto-layout is not what is under test: every case here opens with a
// saved layout that places its buses, so ELK never runs.
vi.mock('@/components/sld/elkClient', () => ({
  elkLayout: vi.fn(async () => ({ children: [] })),
}));

import { SldCanvas } from '@/components/sld/SldCanvas';
import {
  __clearAllPendingForTests,
  buildSidecarLayout,
  CONNECTOR_STYLE_SETTING,
} from '@/components/sld/sidecar';
import { DEVICE_PORT, SOURCE_HANDLE, TARGET_HANDLE } from '@/components/sld/graph';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useSessionStore } from '@/store/session';
import { __requestSldCommand, useSldStore } from '@/store/sld';
import { parseRunId, parseSessionId, parseWorkspacePath } from '@/api/types';
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
  return { idx, name: String(idx), kind, params };
}

/** Two buses one above the other, a line between them, a load under the lower one. */
function pair(): TopologySummary {
  return {
    state: 'pre-setup',
    buses: [entry(1, 'Bus', {}), entry(2, 'Bus', {})],
    lines: [entry('L', 'Line', { bus1: 1, bus2: 2 })],
    transformers: [],
    generators: [],
    loads: [entry('PQ', 'PQ', { bus: 2 })],
    shunts: [],
    controllers: [],
  };
}

/**
 * A saved layout for `pair()`: bus 1 at the origin, bus 2 below it, and the
 * load to the right of bus 2, above its level: past the tip of the bar.
 */
function placed(extra: Partial<SidecarLayout> = {}): SidecarLayout {
  return {
    ...buildSidecarLayout(
      { '1': { x: 0, y: 0 }, '2': { x: 0, y: 200 } },
      { nonBusCoords: { load: { PQ: { x: 150, y: 120, bus: '2' } } } },
    ),
    ...extra,
  };
}

function open(casePath: string | null): void {
  useCaseStore.getState().setCase({
    primaryPath: casePath === null ? null : parseWorkspacePath(casePath),
    addfiles: [],
  });
}

async function draw(): Promise<void> {
  render(<SldCanvas />);
  await waitFor(() => expect(drawn.nodes.length).toBeGreaterThan(0));
}

const node = (id: string): DrawnNode => {
  const found = drawn.nodes.find((n) => n.id === id);
  if (found === undefined) throw new Error(`no node ${id}`);
  return found;
};
const edge = (id: string): DrawnEdge => {
  const found = drawn.edges.find((e) => e.id === id);
  if (found === undefined) throw new Error(`no edge ${id}`);
  return found;
};
const routeOf = (id: string): ConnectorRoute => edge(id).data?.route as ConnectorRoute;
const barOf = (id: string): BarGeometry => node(id).data.bar as BarGeometry;

/** Move `id` as a drag does while the pointer is still down. */
function dragTo(id: string, position: { x: number; y: number }): void {
  act(() => drawn.onNodesChange?.([{ id, type: 'position', position, dragging: true }]));
}

/** Let go of `id` where it is, as the end of a drag does. */
function drop(id: string): void {
  const { position } = node(id);
  act(() => drawn.onNodesChange?.([{ id, type: 'position', position, dragging: false }]));
}

/** A power flow has run: the loads show what they draw, in a readout beside each. */
function showValues(): void {
  act(() =>
    usePflowStore.setState({
      lastRun: {
        run_id: parseRunId('pf-1'),
        converged: true,
        iterations: 3,
        mismatch: 1e-6,
        bus_voltages: { '1': 1.02, '2': 0.99 },
        bus_angles: { '1': 0, '2': -2 },
        line_flows: {},
        load_consumption: {
          PQ: { p: 120.5, q: 30.2, bus: 2 },
          PQ2: { p: 80, q: 12, bus: 2 },
        },
      },
      isRunning: false,
      error: null,
    }),
  );
}

/** Whether every run of a route is level or upright. */
function squareCornered(points: readonly (readonly number[])[]): boolean {
  return points.slice(1).every((p, i) => p[0] === points[i]![0] || p[1] === points[i]![1]);
}

beforeEach(() => {
  mockTopology = pair();
  mockSidecar = placed();
  putSidecarSpy.mockClear();
  drawn.nodes = [];
  drawn.edges = [];
  drawn.onNodesChange = null;
  useSessionStore.setState({ sessionId: parseSessionId('sess-connections') });
  useCaseStore.getState().clearCase();
  useSldStore.getState().clearSelectedNodeId();
  usePflowStore.setState({ lastRun: null });
});

afterEach(() => {
  cleanup();
  __clearAllPendingForTests();
  useCaseStore.getState().clearCase();
  useSldStore.getState().clearSelectedNodeId();
});

describe('what the canvas hands React Flow', () => {
  it('gives every connector and branch its route, and every bus its bar', async () => {
    open('pair.xlsx');
    await draw();

    // The line runs straight down between the two bars, tap to tap, on a
    // line of the grid.
    expect(routeOf('line-L')).toEqual({
      points: [
        [48, 3],
        [48, 203],
      ],
      sourceSide: 'south',
      targetSide: 'north',
    });
    // The load is 41 high and as wide as its name: up and to the right of
    // bar 2, so its connector lands on the tip of the bar.
    const connector = routeOf('stub-load-PQ');
    expect(connector.targetSide).toBe('north');
    expect(connector.points[connector.points.length - 1]).toEqual([89, 203]);

    expect(barOf('1')).toEqual({ start: 0, end: 92, taps: [{ x: 48, side: 'south' }] });
    expect(barOf('2').taps).toEqual([
      { x: 48, side: 'north' },
      { x: 89, side: 'north' },
    ]);
  });

  it('keeps the route it made for a line the layout has none for, and writes nothing for it', async () => {
    open('pair.xlsx');
    await draw();
    // The route is part of the arrangement from here on: an Undo puts it
    // back, and the next write of the layout holds it.
    await waitFor(() =>
      expect(useCaseStore.getState().routeOverrides['line-L']).toEqual({
        points: [
          [48, 3],
          [48, 203],
        ],
        anchors: { source: { x: 0, y: 0 }, target: { x: 0, y: 200 } },
      }),
    );
    expect(useCaseStore.getState().diagramLayout?.branches?.line?.L?.routing).toBe('polyline');
    // Opening a case is no reason to write beside it.
    cleanup();
    expect(putSidecarSpy).not.toHaveBeenCalled();
  });

  it('attaches each edge to the handles on the sides its route leaves and lands by', async () => {
    open('pair.xlsx');
    await draw();
    expect(edge('line-L')).toMatchObject({
      sourceHandle: SOURCE_HANDLE.south,
      targetHandle: TARGET_HANDLE.north,
    });
    const connector = routeOf('stub-load-PQ');
    expect(edge('stub-load-PQ')).toMatchObject({
      sourceHandle: DEVICE_PORT[connector.sourceSide],
      targetHandle: TARGET_HANDLE.north,
    });
    // The device knows which face its connector leaves by, and which way it
    // goes from there: to the left, to the tip of the bar.
    expect(node('load-PQ').data.connectorFace).toBe(connector.sourceSide);
    expect(node('load-PQ').data.connectorLean).toBe(-1);
  });

  it('draws a bar at the length the saved layout sets for it', async () => {
    mockSidecar = placed({ busbars: { '2': { length: 200, orientation: 'horizontal' } } });
    open('pair.xlsx');
    await draw();
    expect(barOf('2')).toMatchObject({ start: -54, end: 146 });
    expect(barOf('1')).toMatchObject({ start: 0, end: 92 });
  });
});

describe('a node React Flow has measured', () => {
  it('moves the port of a device to the middle of the face of its real box', async () => {
    open('pair.xlsx');
    await draw();
    const before = routeOf('stub-load-PQ');
    const hinted = node('load-PQ');

    // React Flow reports the box it measured: wider and lower than the hint.
    act(() =>
      drawn.onNodesChange?.([
        { id: 'load-PQ', type: 'dimensions', dimensions: { width: 80, height: 30 } },
      ]),
    );

    const after = routeOf('stub-load-PQ');
    const at = node('load-PQ').position;
    expect(after.points[0]).not.toEqual(before.points[0]);
    // From the middle of a face of an 80 by 30 box.
    const [x, y] = after.points[0]!;
    const onVerticalFace = (x === at.x || x === at.x + 80) && y === at.y + 15;
    const onHorizontalFace = x === at.x + 40 && (y === at.y || y === at.y + 30);
    expect(onVerticalFace || onHorizontalFace).toBe(true);
    // The size goes back to React Flow with the node, so it measures it once.
    expect(node('load-PQ').measured).toEqual({ width: 80, height: 30 });
    expect(hinted.measured).toBeUndefined();
  });

  it('redraws nothing for a measurement that changes nothing', async () => {
    open('pair.xlsx');
    await draw();
    const size = { width: 80, height: 30 };
    act(() => drawn.onNodesChange?.([{ id: 'load-PQ', type: 'dimensions', dimensions: size }]));
    const edges = drawn.edges;
    const nodes = drawn.nodes;
    act(() =>
      drawn.onNodesChange?.([{ id: 'load-PQ', type: 'dimensions', dimensions: { ...size } }]),
    );
    expect(drawn.edges).toBe(edges);
    expect(drawn.nodes).toBe(nodes);
  });
});

describe('while a node is dragged', () => {
  it('moves the connector of a device with it: the face it leaves by and the tap it lands on', async () => {
    open('pair.xlsx');
    await draw();
    expect(routeOf('stub-load-PQ').targetSide).toBe('north');

    // Under the bar, over its left half. The pointer is still down.
    dragTo('load-PQ', { x: 0, y: 300 });

    const under = routeOf('stub-load-PQ');
    const box = node('load-PQ');
    const middle = box.position.x + (box.initialWidth ?? 0) / 2;
    expect(under).toEqual({
      points: [
        [middle, 300],
        [middle, 203],
      ],
      sourceSide: 'north',
      targetSide: 'south',
    });
    expect(barOf('2').taps).toContainEqual({ x: middle, side: 'south' });
    expect(node('load-PQ').data.connectorFace).toBe('north');
    // Straight up: it goes neither way.
    expect(node('load-PQ').data.connectorLean).toBeUndefined();

    // Under the bar's level but past its west tip: up and to the right.
    dragTo('load-PQ', { x: -100, y: 300 });
    expect(node('load-PQ').data.connectorFace).toBe('north');
    expect(node('load-PQ').data.connectorLean).toBe(1);
    // Nothing is kept until the drag ends.
    expect(useCaseStore.getState().dragOverrides).toEqual({});
  });

  it('tells a device to show its readout left of its connector when a line runs through it on the right', async () => {
    open('pair.xlsx');
    await draw();
    showValues();

    // Over the left half of bar 2, between the two bars: the connector
    // drops straight at 19, and the line comes down at 48, through where
    // the readout would stand on the right of it. The left is free.
    dragTo('load-PQ', { x: 0, y: 120 });
    expect(routeOf('stub-load-PQ').points).toEqual([
      [19, 161],
      [19, 203],
    ]);
    expect(node('load-PQ').data.connectorLean).toBeUndefined();
    expect(node('load-PQ').data.readoutSpot).toBe('left');

    // Over the right half: the line is on its left now, and nothing on its right.
    dragTo('load-PQ', { x: 60, y: 120 });
    expect(routeOf('stub-load-PQ').points[0]).toEqual([79, 161]);
    expect(node('load-PQ').data.readoutSpot).toBeUndefined();
  });

  it('places no readout before a power flow has given one something to show', async () => {
    open('pair.xlsx');
    await draw();
    dragTo('load-PQ', { x: 0, y: 120 });
    expect(node('load-PQ').data.readoutSpot).toBeUndefined();
  });

  it('stands the readout on the far side of the symbol when neither side of the connector is free', async () => {
    // A second load of bus 2, placed 100 left of where the first is dragged
    // to, past the tip of the bar: its connector runs at an angle through
    // the place left of the first one's, and the line takes the right.
    mockTopology = { ...pair(), loads: [...pair().loads, entry('PQ2', 'PQ', { bus: 2 })] };
    mockSidecar = {
      ...buildSidecarLayout(
        { '1': { x: 0, y: 0 }, '2': { x: 0, y: 200 } },
        {
          nonBusCoords: {
            load: { PQ: { x: 150, y: 120, bus: '2' }, PQ2: { x: -100, y: 120, bus: '2' } },
          },
        },
      ),
    };
    open('pair.xlsx');
    await draw();
    showValues();
    dragTo('load-PQ', { x: 0, y: 120 });
    expect(routeOf('stub-load-PQ').points[0]).toEqual([19, 161]);
    const neighbour = routeOf('stub-load-PQ2').points;
    expect(neighbour[0]![0]).toBeLessThan(19 - 4);
    expect(neighbour[0]![0]).toBeGreaterThan(19 - 4 - 144);
    expect(node('load-PQ').data.readoutSpot).toBe('far');
  });

  it('moves a line out of the way of a device that is dragged onto it', async () => {
    // A second load of bus 2 over the west tip of the bar.
    mockTopology = { ...pair(), loads: [...pair().loads, entry('PQ2', 'PQ', { bus: 2 })] };
    mockSidecar = {
      ...buildSidecarLayout(
        { '1': { x: 0, y: 0 }, '2': { x: 0, y: 200 } },
        {
          nonBusCoords: {
            load: { PQ: { x: 150, y: 120, bus: '2' }, PQ2: { x: -34, y: 120, bus: '2' } },
          },
        },
      ),
    };
    open('pair.xlsx');
    await draw();
    showValues();
    expect(routeOf('line-L').points[0]![0]).toBe(48);

    // Over the middle of bar 2, between the two bars, where the line comes
    // down. The pointer is still down.
    dragTo('load-PQ', { x: 27, y: 120 });

    const load = node('load-PQ');
    const [left, right] = [load.position.x, load.position.x + (load.initialWidth ?? 0)];
    expect(routeOf('stub-load-PQ').points[0]![0]).toBe(46);
    // The line still drops straight from bar to bar, beside the load now:
    // clear of its symbol, of its connector, and of the other load's.
    const line = routeOf('line-L').points;
    expect(line).toHaveLength(2);
    expect(line[0]![0]).toBe(line[1]![0]);
    const x = line[0]![0]!;
    expect(x < left || x > right).toBe(true);
    expect(Math.abs(x - 46)).toBeGreaterThanOrEqual(12);
    expect(Math.abs(x - routeOf('stub-load-PQ2').points.at(-1)![0]!)).toBeGreaterThanOrEqual(12);
    // With the line gone from beside its connector, the readout stands
    // where it first would.
    expect(node('load-PQ').data.readoutSpot).toBeUndefined();
    // Nothing is kept until the drag ends.
    expect(useCaseStore.getState().routeOverrides['line-L']?.points[0]![0]).toBe(48);

    drop('load-PQ');
    await waitFor(() =>
      expect(useCaseStore.getState().routeOverrides['line-L']?.points).toEqual(line),
    );
  });

  it('takes the branches of a bus along with it', async () => {
    open('pair.xlsx');
    await draw();

    dragTo('2', { x: 300, y: 200 });

    // Bar 2 is now at 300..392: the line steps across to it, on the lines of
    // the grid, and lands inside the bar, a step in from its tip.
    expect(routeOf('line-L')).toEqual({
      points: [
        [80, 3],
        [80, 48],
        [304, 48],
        [304, 203],
      ],
      sourceSide: 'south',
      targetSide: 'north',
    });
    expect(barOf('2').taps).toContainEqual({ x: 4, side: 'north' });

    // Level with bar 1 it does not leave by the tip, in line with the bar,
    // where it would read as more bar: it goes over, and the handles follow.
    dragTo('2', { x: 300, y: 0 });
    expect(routeOf('line-L')).toEqual({
      points: [
        [80, 3],
        [80, -16],
        [304, -16],
        [304, 3],
      ],
      sourceSide: 'north',
      targetSide: 'north',
    });
    expect(edge('line-L')).toMatchObject({
      sourceHandle: SOURCE_HANDLE.north,
      targetHandle: TARGET_HANDLE.north,
    });
  });

  it('hands React Flow the same edge again when its route did not change', async () => {
    open('pair.xlsx');
    await draw();
    const line = edge('line-L');
    const connector = edge('stub-load-PQ');

    // The load moves; the line between the two buses does not.
    dragTo('load-PQ', { x: 150, y: 60 });

    expect(edge('line-L')).toBe(line);
    expect(edge('stub-load-PQ')).not.toBe(connector);
  });
});

describe('a route the saved layout holds for a branch', () => {
  /**
   * `pair()` with bus 2 below and to the right of bus 1, and a route for the
   * line as the automatic layout leaves one: out of the middle of the south
   * side of the box around bus 1, across half way down, and onto the middle
   * of the north side of bus 2.
   */
  function routed(): SidecarLayout {
    return buildSidecarLayout(
      { '1': { x: 0, y: 0 }, '2': { x: 200, y: 200 } },
      {
        nonBusCoords: { load: { PQ: { x: 350, y: 120, bus: '2' } } },
        sections: {
          branches: {
            line: {
              L: {
                routing: 'polyline',
                bend_points: [
                  { x: 46, y: 40 },
                  { x: 46, y: 120 },
                  { x: 246, y: 120 },
                  { x: 246, y: 200 },
                ],
                bus1: '1',
                bus2: '2',
              },
            },
          },
        },
      },
    );
  }

  /** The line routed from where the two bars are: tip to tip, across half way. */
  const fromTapToTap = (bus2X: number): [number, number][] => [
    [89, 3],
    [89, 103],
    [bus2X + 3, 103],
    [bus2X + 3, 203],
  ];

  it('is drawn through its bends, with its two ends brought onto taps of the bars', async () => {
    mockSidecar = routed();
    open('pair.xlsx');
    await draw();

    // The bends are the stored ones (at y = 120, not half way at 103), and
    // the ends are on the lines of the bars and not on the box around each.
    expect(routeOf('line-L')).toEqual({
      points: [
        [46, 3],
        [46, 120],
        [246, 120],
        [246, 203],
      ],
      sourceSide: 'south',
      targetSide: 'north',
    });
    expect(routeOf('line-L').points).not.toEqual(fromTapToTap(200));
    expect(barOf('1').taps).toEqual([{ x: 46, side: 'south' }]);
    expect(barOf('2').taps).toContainEqual({ x: 46, side: 'north' });
    // The route is kept as it is drawn, with its ends on the taps.
    await waitFor(() =>
      expect(useCaseStore.getState().routeOverrides['line-L']?.points).toEqual(
        routeOf('line-L').points,
      ),
    );
  });

  it('is made afresh where the layout draws two lines on top of each other', async () => {
    // A second line between the same two buses, saved on the same route as
    // the first: what a layout written by an earlier version holds for two
    // lines the automatic layout ran down one corridor.
    mockTopology = {
      ...pair(),
      lines: [...pair().lines, entry('L2', 'Line', { bus1: 1, bus2: 2 })],
    };
    const saved = routed();
    mockSidecar = {
      ...saved,
      branches: { line: { L: saved.branches!.line!.L!, L2: saved.branches!.line!.L! } },
    };
    open('pair.xlsx');
    await draw();

    const [first, second] = [routeOf('line-L').points, routeOf('line-L2').points];
    for (const points of [first, second]) {
      expect(squareCornered(points)).toBe(true);
      expect(points[0]![1]).toBe(3);
      expect(points.at(-1)![1]).toBe(203);
    }
    // One dot each on either bar, and no stretch where the two run closer
    // than a line's width and its gap.
    expect(Math.abs(first[0]![0]! - second[0]![0]!)).toBeGreaterThanOrEqual(12);
    expect(Math.abs(first.at(-1)![0]! - second.at(-1)![0]!)).toBeGreaterThanOrEqual(12);
    const level = (points: typeof first) =>
      points.slice(1).flatMap((p, i) => (p[1] === points[i]![1] ? [p[1]!] : []));
    for (const y of level(first)) {
      for (const other of level(second)) expect(Math.abs(y - other)).toBeGreaterThanOrEqual(12);
    }
    // The file is left as it is until something on the diagram is changed;
    // the change is then written with the routes as they are drawn.
    await waitFor(() => expect(useCaseStore.getState().routeOverrides).not.toEqual({}));
    expect(putSidecarSpy).not.toHaveBeenCalled();
    act(() => __requestSldCommand('connectors-elbow'));
    await waitFor(() => expect(putSidecarSpy).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const [vars] = putSidecarSpy.mock.calls[0] as [{ layout: SidecarLayout }];
    expect(vars.layout.branches?.line?.L2?.bend_points).toEqual(
      routeOf('line-L2').points.map(([x, y]) => ({ x, y })),
    );
    expect(vars.layout.branches?.line?.L?.bend_points).toEqual(
      routeOf('line-L').points.map(([x, y]) => ({ x, y })),
    );
  });

  it('is drawn as the layout has it when another layout takes the place of the one that was drawn', async () => {
    // What restoring a snapshot does: the layout beside the case is replaced
    // while the diagram is up, and the arrangement of this visit is dropped.
    // For one render the diagram has the routes of the new layout and the
    // positions of the old one, where the route of the line fits neither
    // bus: no route made for that graph may be kept, or it would stand in
    // for the one the new layout brings.
    const view = render(<SldCanvas />);
    open('pair.xlsx');
    await waitFor(() => expect(drawn.nodes.length).toBeGreaterThan(0));
    await waitFor(() =>
      expect(useCaseStore.getState().routeOverrides['line-L']?.points).toEqual([
        [48, 3],
        [48, 203],
      ]),
    );

    const saved = routed();
    const onTaps = [
      { x: 48, y: 3 },
      { x: 48, y: 120 },
      { x: 248, y: 120 },
      { x: 248, y: 203 },
    ];
    // Both at once, as the restore does them.
    act(() => {
      mockSidecar = {
        ...saved,
        branches: { line: { L: { ...saved.branches!.line!.L!, bend_points: onTaps } } },
      };
      useCaseStore.getState().setArrangement({ dragOverrides: {}, routeOverrides: {} });
      view.rerender(<SldCanvas />);
    });

    await waitFor(() => expect(node('2').position).toEqual({ x: 200, y: 200 }));
    await waitFor(() => expect(routeOf('line-L').points).toEqual(onTaps.map(({ x, y }) => [x, y])));
    // Nothing was made, so nothing is kept in place of the layout's route.
    expect(useCaseStore.getState().routeOverrides).toEqual({});
    expect(putSidecarSpy).not.toHaveBeenCalled();
  });

  it('writes nothing of another system that is drawn for a moment under the name of the case that was open', async () => {
    // A case is opened from another: the topology of the new one arrives
    // while the store still holds the old case, its file name and the
    // arrangement made in it. What is drawn for that moment is the new
    // system under the old name, and no route made for it may be written
    // into the old case's file.
    const view = render(<SldCanvas />);
    open('pair.xlsx');
    await waitFor(() => expect(drawn.nodes.length).toBeGreaterThan(0));
    dragTo('load-PQ', { x: 150, y: 60 });
    drop('load-PQ');
    await waitFor(() => expect(putSidecarSpy).toHaveBeenCalledTimes(1), { timeout: 3000 });
    putSidecarSpy.mockClear();
    const kept = useCaseStore.getState().routeOverrides;
    expect(Object.keys(useCaseStore.getState().dragOverrides)).toContain('load-PQ');

    // Three buses in a chain, with a load of the same name on the last.
    const other: TopologySummary = {
      ...pair(),
      buses: [entry(1, 'Bus', {}), entry(2, 'Bus', {}), entry(3, 'Bus', {})],
      lines: [entry('A', 'Line', { bus1: 1, bus2: 2 }), entry('B', 'Line', { bus1: 2, bus2: 3 })],
      loads: [entry('PQ', 'PQ', { bus: 3 })],
    };
    act(() => {
      mockTopology = other;
      view.rerender(<SldCanvas />);
    });
    await waitFor(() => expect(drawn.nodes.some((n) => n.id === '3')).toBe(true));
    // Longer than a write waits.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(putSidecarSpy).not.toHaveBeenCalled();
    // The route of the line that is gone is dropped with it.
    expect(Object.keys(kept)).toEqual(['line-L']);
    expect(Object.keys(useCaseStore.getState().routeOverrides)).not.toContain('line-L');
  });

  it('gives way to a route made afresh while one of its buses is away from where the route was made', async () => {
    mockSidecar = routed();
    open('pair.xlsx');
    await draw();

    // The pointer is still down on bus 2, 100 to the right: the line is
    // routed to where the bar is now.
    dragTo('2', { x: 300, y: 200 });
    const away = routeOf('line-L').points;
    expect(squareCornered(away)).toBe(true);
    expect(away[0]![1]).toBe(3);
    expect(away.at(-1)![1]).toBe(203);
    expect(away.at(-1)![0]).toBeGreaterThan(300);
    expect(away.at(-1)![0]).toBeLessThan(392);

    // Back where the route was made for, the route is drawn again.
    dragTo('2', { x: 200, y: 200 });
    expect(routeOf('line-L').points).toEqual([
      [46, 3],
      [46, 120],
      [246, 120],
      [246, 203],
    ]);
  });
});

describe('the connector style', () => {
  it('is straight until something says otherwise', async () => {
    open('pair.xlsx');
    await draw();
    expect(routeOf('stub-load-PQ').points).toHaveLength(2);
    expect(useCaseStore.getState().connectorStyle).toBeNull();
  });

  it('turns the connectors at a right angle when that is chosen, and keeps the choice with the layout', async () => {
    open('pair.xlsx');
    await draw();

    act(() => __requestSldCommand('connectors-elbow'));

    // Sideways out of the device to over the tip of the bar, then down onto it.
    const turned = routeOf('stub-load-PQ');
    expect(turned.points).toHaveLength(3);
    const [from, corner, tap] = turned.points;
    expect(corner).toEqual([tap![0], from![1]]);
    expect(tap).toEqual([89, 203]);
    expect(turned.sourceSide).toBe('west');

    // In the store for this visit, in the layout every save sends, and in
    // the file beside the case.
    expect(useCaseStore.getState().connectorStyle).toBe('elbow');
    expect(useCaseStore.getState().diagramLayout?.figure).toEqual({
      [CONNECTOR_STYLE_SETTING]: 'elbow',
    });
    await waitFor(() => expect(putSidecarSpy).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const [vars] = putSidecarSpy.mock.calls[0] as [{ casePath: string; layout: SidecarLayout }];
    expect(vars.casePath).toBe('pair.xlsx');
    expect(vars.layout.figure).toEqual({ [CONNECTOR_STYLE_SETTING]: 'elbow' });
    // With the placement, which a layout that only held a style would lose.
    expect(vars.layout.coordinates).toEqual({ '1': { x: 0, y: 0 }, '2': { x: 0, y: 200 } });
  });

  it('goes back to straight connectors the same way', async () => {
    mockSidecar = placed({ figure: { [CONNECTOR_STYLE_SETTING]: 'elbow' } });
    open('pair.xlsx');
    await draw();
    expect(routeOf('stub-load-PQ').points).toHaveLength(3);

    act(() => __requestSldCommand('connectors-straight'));

    expect(routeOf('stub-load-PQ').points).toHaveLength(2);
    expect(useCaseStore.getState().diagramLayout?.figure).toEqual({
      [CONNECTOR_STYLE_SETTING]: 'straight',
    });
  });

  it('draws a case the way its saved layout says, with nothing chosen in this visit', async () => {
    mockSidecar = placed({ figure: { [CONNECTOR_STYLE_SETTING]: 'elbow', monochrome: true } });
    open('pair.xlsx');
    await draw();
    expect(routeOf('stub-load-PQ').points).toHaveLength(3);
    expect(useCaseStore.getState().connectorStyle).toBeNull();
    // The other figure settings ride along untouched.
    expect(useCaseStore.getState().diagramLayout?.figure).toEqual({
      [CONNECTOR_STYLE_SETTING]: 'elbow',
      monochrome: true,
    });
  });

  it('writes nothing when the style asked for is the one already drawn', async () => {
    open('pair.xlsx');
    await draw();
    act(() => __requestSldCommand('connectors-straight'));
    expect(useCaseStore.getState().connectorStyle).toBeNull();
    // Leaving the canvas sends whatever write is waiting: none is.
    cleanup();
    expect(putSidecarSpy).not.toHaveBeenCalled();
  });

  it('keeps the choice for a system built from scratch, which has no file to write it beside', async () => {
    mockSidecar = null;
    mockTopology = { ...pair(), lines: [] };
    open(null);
    await draw();

    act(() => __requestSldCommand('connectors-elbow'));

    expect(useCaseStore.getState().connectorStyle).toBe('elbow');
    expect(useCaseStore.getState().diagramLayout?.figure).toEqual({
      [CONNECTOR_STYLE_SETTING]: 'elbow',
    });
    cleanup();
    expect(putSidecarSpy).not.toHaveBeenCalled();
  });

  it('leaves the style alone when the placement is reset', async () => {
    open('pair.xlsx');
    await draw();
    act(() => __requestSldCommand('connectors-elbow'));
    __clearAllPendingForTests();
    putSidecarSpy.mockClear();

    act(() => __requestSldCommand('reset-layout'));

    // The layout that replaces the saved one places nothing and keeps the style.
    expect(putSidecarSpy).toHaveBeenCalledTimes(1);
    const [vars] = putSidecarSpy.mock.calls[0] as [{ layout: SidecarLayout }];
    expect(vars.layout.coordinates).toEqual({});
    expect(vars.layout.figure).toEqual({ [CONNECTOR_STYLE_SETTING]: 'elbow' });
    expect(useCaseStore.getState().connectorStyle).toBe('elbow');
  });

  it('forgets the choice with the case it was made for', async () => {
    open('pair.xlsx');
    await draw();
    act(() => __requestSldCommand('connectors-elbow'));
    act(() => open('other.xlsx'));
    expect(useCaseStore.getState().connectorStyle).toBeNull();
  });
});

describe('the connector that is picked out', () => {
  it('is that of the selected device, and of no bus that is selected', async () => {
    open('pair.xlsx');
    await draw();
    expect(edge('stub-load-PQ').data?.active).toBeUndefined();

    // What a click on the load, or on its row in the Loads table, writes.
    act(() => useSldStore.getState().setSelectedNodeId('load-PQ'));
    expect(edge('stub-load-PQ').data?.active).toBe(true);
    expect(edge('line-L').data?.active).toBeUndefined();
    // The route is still there for the edge to draw.
    expect(routeOf('stub-load-PQ').targetSide).toBe('north');

    // Selecting its bus picks out the bus, not the connectors that land on it.
    act(() => useSldStore.getState().setSelectedNodeId('2'));
    expect(edge('stub-load-PQ').data?.active).toBeUndefined();
    expect(edge('line-L').data?.active).toBeUndefined();
  });

  it('is that of a device while it is dragged, and no longer once it is dropped', async () => {
    open('pair.xlsx');
    await draw();
    const load = node('load-PQ');

    // React Flow calls this with the press, before the first move.
    act(() => drawn.onNodeDragStart?.({}, load, [load]));
    expect(edge('stub-load-PQ').data?.active).toBe(true);

    // It stays picked out, on its new route, as the device moves.
    dragTo('load-PQ', { x: 0, y: 300 });
    expect(edge('stub-load-PQ').data?.active).toBe(true);
    expect(routeOf('stub-load-PQ').targetSide).toBe('south');

    act(() => drawn.onNodeDragStop?.({}, load, [load]));
    expect(edge('stub-load-PQ').data?.active).toBeUndefined();
  });

  it('hands back the same edge while neither its route nor its mark changes', async () => {
    open('pair.xlsx');
    await draw();
    act(() => useSldStore.getState().setSelectedNodeId('load-PQ'));
    const marked = edge('stub-load-PQ');
    const line = edge('line-L');

    // The other bus is moved: the load's connector is not redrawn for it.
    dragTo('1', { x: 0, y: -40 });
    expect(edge('stub-load-PQ')).toBe(marked);
    expect(edge('line-L')).not.toBe(line);
  });
});
