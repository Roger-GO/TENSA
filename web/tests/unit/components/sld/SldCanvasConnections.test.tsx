/**
 * What the canvas hands React Flow for the connections of the diagram: the
 * route of every connector and branch, the bar of every bus, and how these
 * follow a drag, a measured node, and the choice of connector style.
 *
 * The canvas is rendered against a stand-in for React Flow that records the
 * nodes and edges it is asked to draw and hands back `onNodesChange`, so a
 * test can move a node the way a drag does (before it is dropped) and report
 * a measured size the way React Flow does.
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
type Change =
  | { id: string; type: 'position'; position: { x: number; y: number }; dragging: boolean }
  | { id: string; type: 'dimensions'; dimensions: { width: number; height: number } };

const drawn: {
  nodes: DrawnNode[];
  edges: DrawnEdge[];
  onNodesChange: ((changes: Change[]) => void) | null;
} = { nodes: [], edges: [], onNodesChange: null };

vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: {
    nodes: DrawnNode[];
    edges: DrawnEdge[];
    onNodesChange: (changes: Change[]) => void;
  }) => {
    drawn.nodes = props.nodes;
    drawn.edges = props.edges;
    drawn.onNodesChange = props.onNodesChange;
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
import { useSessionStore } from '@/store/session';
import { __requestSldCommand } from '@/store/sld';
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

beforeEach(() => {
  mockTopology = pair();
  mockSidecar = placed();
  putSidecarSpy.mockClear();
  drawn.nodes = [];
  drawn.edges = [];
  drawn.onNodesChange = null;
  useSessionStore.setState({ sessionId: parseSessionId('sess-connections') });
  useCaseStore.getState().clearCase();
});

afterEach(() => {
  cleanup();
  __clearAllPendingForTests();
  useCaseStore.getState().clearCase();
});

describe('what the canvas hands React Flow', () => {
  it('gives every connector and branch its route, and every bus its bar', async () => {
    open('pair.xlsx');
    await draw();

    // The line runs straight down between the two bars, tap to tap.
    expect(routeOf('line-L')).toEqual({
      points: [
        [46, 3],
        [46, 203],
      ],
      sourceSide: 'south',
      targetSide: 'north',
    });
    // The load is 41 high and as wide as its name: up and to the right of
    // bar 2, so its connector lands on the tip of the bar.
    const connector = routeOf('stub-load-PQ');
    expect(connector.targetSide).toBe('north');
    expect(connector.points[connector.points.length - 1]).toEqual([89, 203]);

    expect(barOf('1')).toEqual({ start: 0, end: 92, taps: [{ x: 46, side: 'south' }] });
    expect(barOf('2').taps).toEqual([
      { x: 46, side: 'north' },
      { x: 89, side: 'north' },
    ]);
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
    // The device knows which face its connector leaves by.
    expect(node('load-PQ').data.connectorFace).toBe(connector.sourceSide);
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
    // Nothing is kept until the drag ends.
    expect(useCaseStore.getState().dragOverrides).toEqual({});
  });

  it('takes the branches of a bus along with it', async () => {
    open('pair.xlsx');
    await draw();

    dragTo('2', { x: 300, y: 200 });

    // Bar 2 is now at 300..392: the line steps across to it, from tip to tip.
    expect(routeOf('line-L')).toEqual({
      points: [
        [89, 3],
        [89, 103],
        [303, 103],
        [303, 203],
      ],
      sourceSide: 'south',
      targetSide: 'north',
    });
    expect(barOf('2').taps).toContainEqual({ x: 3, side: 'north' });

    // Level with bar 1 it joins it end to end, and the handles follow.
    dragTo('2', { x: 300, y: 0 });
    expect(routeOf('line-L')).toEqual({
      points: [
        [89, 3],
        [303, 3],
      ],
      sourceSide: 'east',
      targetSide: 'west',
    });
    expect(edge('line-L')).toMatchObject({
      sourceHandle: SOURCE_HANDLE.east,
      targetHandle: TARGET_HANDLE.west,
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
  });

  it('gives way to a route from tap to tap while one of its buses is away from where the route was made', async () => {
    mockSidecar = routed();
    open('pair.xlsx');
    await draw();

    // The pointer is still down on bus 2, 100 to the right.
    dragTo('2', { x: 300, y: 200 });
    expect(routeOf('line-L').points).toEqual(fromTapToTap(300));

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
