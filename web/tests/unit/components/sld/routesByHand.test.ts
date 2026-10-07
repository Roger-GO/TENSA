/**
 * What the diagram does with a route that was drawn by hand
 * (`data.bendManual`): the connection pass draws it as it is and brings it
 * along with its ends (`connections.ts`), the routing never takes it out
 * for what lies on it and gives it up only where its own bus was moved to
 * where it does not fit (`routing.ts`), and the graph builder hands it on
 * wherever its buses stand (`graph.ts`).
 *
 * A bus node at `(x, y)` is drawn as a bar from `x` to `x + 92` whose centre
 * line is at `y + 3`. Each test is a small diagram built by hand.
 */
import { describe, expect, it } from 'vitest';
import type { TopologyEntry, TopologySummary } from '@/api/types';
import {
  TAP_SPACING,
  bringAlong,
  layoutConnections,
  type ConnectionEdge,
  type ConnectionNode,
  type Point,
} from '@/components/sld/connections';
import { buildGraph } from '@/components/sld/graph';
import { findOverlaps } from '@/components/sld/overlapCheck';
import { routeDiagram } from '@/components/sld/routing';
import { planTidy } from '@/components/sld/tidyPlan';

function bus(id: string, x: number, y: number): ConnectionNode {
  return { id, type: 'bus', position: { x, y } };
}

/** A 40 x 40 device whose top-left corner is at `(x, y)`. */
function device(id: string, x: number, y: number): ConnectionNode {
  return { id, type: 'load', position: { x, y }, initialWidth: 40, initialHeight: 40 };
}

interface Anchors {
  source: { x: number; y: number };
  target: { x: number; y: number };
}

/** A line with a route, drawn by hand or made by the diagram, for ends at `anchors`. */
function line(
  id: string,
  from: string,
  to: string,
  bendPoints: Point[],
  anchors: Anchors,
  byHand = true,
): ConnectionEdge {
  return {
    id,
    type: 'topology',
    source: from,
    target: to,
    data: { bendPoints, bendAnchors: anchors, ...(byHand ? { bendManual: true } : {}) },
  };
}

/** The connector of `deviceId` to `busId`, drawn by hand through `bendPoints` for ends at `anchors`. */
function stub(
  deviceId: string,
  busId: string,
  bendPoints?: Point[],
  anchors?: Anchors,
): ConnectionEdge {
  return {
    id: `stub-${deviceId}`,
    type: 'stub',
    source: deviceId,
    target: busId,
    data: bendPoints === undefined ? {} : { bendPoints, bendAnchors: anchors, bendManual: true },
  };
}

/** Bus A over bus B, 200 apart. */
const A = { x: 0, y: 0 };
const B = { x: 0, y: 200 };
const AT: Anchors = { source: A, target: B };

/** Down from A, across, and down onto B. */
const STEPPED: Point[] = [
  [30, 3],
  [30, 100],
  [60, 100],
  [60, 203],
];

describe('bringAlong', () => {
  it('takes the whole route along when both ends move alike', () => {
    expect(bringAlong(STEPPED, [10, -5], [10, -5])).toEqual([
      [40, -2],
      [40, 95],
      [70, 95],
      [70, 198],
    ]);
  });

  it('takes an end along and keeps the run that ends there upright', () => {
    expect(bringAlong(STEPPED, [0, 0], [40, 20])).toEqual([
      [30, 3],
      [30, 100],
      [100, 100],
      [100, 223],
    ]);
    expect(bringAlong(STEPPED, [-12, 0], [0, 0])).toEqual([
      [18, 3],
      [18, 100],
      [60, 100],
      [60, 203],
    ]);
  });

  it('keeps a level run out of the side of a device level', () => {
    const elbow: Point[] = [
      [60, 20],
      [120, 20],
      [120, 80],
    ];
    // The device goes down by 10, the bar right by 8: the corner follows both.
    expect(bringAlong(elbow, [0, 10], [8, 0])).toEqual([
      [60, 30],
      [128, 30],
      [128, 80],
    ]);
  });

  it('steps a single upright run across when its two ends are no longer in line', () => {
    const straight: Point[] = [
      [46, 3],
      [46, 203],
    ];
    expect(bringAlong(straight, [0, 0], [30, 0])).toEqual([
      [46, 3],
      [46, 103],
      [76, 103],
      [76, 203],
    ]);
    // One that runs at an angle stays one run.
    const slanted: Point[] = [
      [46, 3],
      [80, 203],
    ];
    expect(bringAlong(slanted, [0, 0], [30, 0])).toEqual([
      [46, 3],
      [110, 203],
    ]);
  });
});

describe('layoutConnections: a branch drawn by hand', () => {
  const nodes = [bus('A', A.x, A.y), bus('B', B.x, B.y)];

  it('is drawn through its points as they are', () => {
    const pass = layoutConnections(nodes, [line('L1', 'A', 'B', STEPPED, AT)]);
    expect(pass.routes.get('L1')!.points).toEqual(STEPPED);
    expect(pass.kept.has('L1')).toBe(true);
  });

  it('keeps an end where it was put when the route leaves the bar at an angle', () => {
    const slanted: Point[] = [
      [30, 3],
      [70, 100],
      [70, 203],
    ];
    const byHand = layoutConnections(nodes, [line('L1', 'A', 'B', slanted, AT)]);
    expect(byHand.routes.get('L1')!.points).toEqual(slanted);
    // A route the diagram made lands under where it heads.
    const made = layoutConnections(nodes, [line('L1', 'A', 'B', slanted, AT, false)]);
    expect(made.routes.get('L1')!.points[0]).toEqual([70, 3]);
  });

  it('holds its tap against a device that drops square beside it', () => {
    // The load stands over the bar of A, its middle 6 from the end of the route.
    const withLoad = [...nodes, device('PQ', 16, -70)];
    const edges = (byHand: boolean) => [line('L1', 'A', 'B', STEPPED, AT, byHand), stub('PQ', 'A')];
    const kept = layoutConnections(withLoad, edges(true));
    expect(kept.routes.get('L1')!.points[0]).toEqual([30, 3]);
    const loadTap = kept.routes.get('stub-PQ')!.points.at(-1)!;
    expect(Math.abs(loadTap[0] - 30)).toBeGreaterThanOrEqual(TAP_SPACING - 0.5);
    // The end of a route the diagram made gives way to the device.
    const gave = layoutConnections(withLoad, edges(false));
    expect(gave.routes.get('L1')!.points[0]![0]).not.toBe(30);
    expect(gave.routes.get('stub-PQ')!.points.at(-1)).toEqual([36, 3]);
  });

  it('is brought along when one of its buses has moved since it was drawn', () => {
    const moved = [bus('A', A.x, A.y), bus('B', 40, 220)];
    const pass = layoutConnections(moved, [line('L1', 'A', 'B', STEPPED, AT)]);
    expect(pass.routes.get('L1')!.points).toEqual([
      [30, 3],
      [30, 100],
      [100, 100],
      [100, 223],
    ]);
    expect(pass.kept.has('L1')).toBe(true);
    // A route the diagram made is not: the branch is stepped from tap to tap.
    const made = layoutConnections(moved, [line('L1', 'A', 'B', STEPPED, AT, false)]);
    expect(made.kept.has('L1')).toBe(false);
  });
});

describe('layoutConnections: the connector of a device drawn by hand', () => {
  /** A load over the bar of A: its box from (26, -80) to (66, -40). */
  const LOAD = { x: 26, y: -80 };
  const DRAWN: Point[] = [
    [46, -40],
    [46, -28],
    [70, -28],
    [70, 3],
  ];
  const FOR: Anchors = { source: LOAD, target: A };

  it('is drawn through its points, out of the face they leave by', () => {
    const nodes = [bus('A', A.x, A.y), device('PQ', LOAD.x, LOAD.y)];
    const pass = layoutConnections(nodes, [stub('PQ', 'A', DRAWN, FOR)]);
    const route = pass.routes.get('stub-PQ')!;
    expect(route.points).toEqual(DRAWN);
    expect(route.sourceSide).toBe('south');
    expect(route.targetSide).toBe('north');
    expect(pass.byHand.has('stub-PQ')).toBe(true);
    // The bar has its tap where the connector was drawn to.
    expect(pass.bars.get('A')!.taps.map((tap) => tap.x)).toEqual([70]);
  });

  it('goes along whole when the bus takes its device with it', () => {
    const nodes = [bus('A', 10, 5), device('PQ', LOAD.x + 10, LOAD.y + 5)];
    const pass = layoutConnections(nodes, [stub('PQ', 'A', DRAWN, FOR)]);
    expect(pass.routes.get('stub-PQ')!.points).toEqual(
      DRAWN.map(([x, y]): Point => [x + 10, y + 5]),
    );
  });

  it('follows a device that was moved a little, still out of the same face', () => {
    const nodes = [bus('A', A.x, A.y), device('PQ', LOAD.x - 20, LOAD.y)];
    const pass = layoutConnections(nodes, [stub('PQ', 'A', DRAWN, FOR)]);
    expect(pass.routes.get('stub-PQ')!.points).toEqual([
      [26, -40],
      [26, -28],
      [70, -28],
      [70, 3],
    ]);
    expect(pass.byHand.has('stub-PQ')).toBe(true);
  });

  it('leaves from the middle of its face when the device comes to be measured wider', () => {
    const nodes = [bus('A', A.x, A.y), device('PQ', LOAD.x, LOAD.y)];
    const pass = layoutConnections(nodes, [stub('PQ', 'A', DRAWN, FOR)], {
      sizes: new Map([['PQ', { width: 48, height: 40 }]]),
    });
    expect(pass.routes.get('stub-PQ')!.points).toEqual([
      [50, -40],
      [50, -28],
      [70, -28],
      [70, 3],
    ]);
  });

  it('is given up for a device that was moved to the other side of its bar', () => {
    const nodes = [bus('A', A.x, A.y), device('PQ', LOAD.x, 40)];
    const pass = layoutConnections(nodes, [stub('PQ', 'A', DRAWN, FOR)]);
    expect(pass.byHand.has('stub-PQ')).toBe(false);
    // Worked out like any other: out of the face that looks at the bar.
    expect(pass.routes.get('stub-PQ')!.points).toEqual([
      [46, 40],
      [46, 3],
    ]);
  });

  it('is given up where bringing it along would take it through another symbol', () => {
    // Moved left, its run across at -28 would pass through the load beside it.
    const nodes = [
      bus('A', A.x, A.y),
      device('PQ', LOAD.x - 80, LOAD.y),
      device('other', -10, -60),
    ];
    const pass = layoutConnections(nodes, [stub('PQ', 'A', DRAWN, FOR), stub('other', 'A')]);
    expect(pass.byHand.has('stub-PQ')).toBe(false);
  });

  it('runs level into the tip of the bar where it was drawn to', () => {
    // A load right of the bar, level with it: its box from (130, -17) to (170, 23).
    const beside = { x: 130, y: -17 };
    const around: Point[] = [
      [130, 3],
      [118, 3],
      [118, -30],
      [104, -30],
      [104, 3],
      [89, 3],
    ];
    const nodes = [bus('A', A.x, A.y), device('PQ', beside.x, beside.y)];
    const pass = layoutConnections(nodes, [stub('PQ', 'A', around, { source: beside, target: A })]);
    const route = pass.routes.get('stub-PQ')!;
    expect(route.points).toEqual(around);
    expect(route.targetSide).toBe('east');
  });

  it('counts for nothing without the places it was drawn for', () => {
    const nodes = [bus('A', A.x, A.y), device('PQ', LOAD.x, LOAD.y)];
    const loose: ConnectionEdge = {
      ...stub('PQ', 'A'),
      data: { bendPoints: DRAWN, bendManual: true },
    };
    const pass = layoutConnections(nodes, [loose]);
    expect(pass.byHand.size).toBe(0);
    expect(pass.routes.get('stub-PQ')!.points).toEqual([
      [46, -40],
      [46, 3],
    ]);
  });
});

describe('routeDiagram: a route drawn by hand', () => {
  const nodes = [bus('A', A.x, A.y), bus('B', B.x, B.y)];

  it('stays as it is, and a line that lies beside it is routed round it', () => {
    const straight: Point[] = [
      [30, 3],
      [30, 203],
    ];
    const beside: Point[] = [
      [36, 3],
      [36, 203],
    ];
    const edges = [line('L1', 'A', 'B', straight, AT), line('L2', 'A', 'B', beside, AT, false)];
    const routed = routeDiagram(nodes, edges);
    expect(routed.connections.routes.get('L1')!.points).toEqual(straight);
    expect(routed.changed.has('L1')).toBe(false);
    expect(routed.released).toEqual([]);
    // The other one moved off it.
    expect(routed.changed.has('L2')).toBe(true);
    expect(routed.changed.get('L2')!.manual).toBeUndefined();
    const lines = ['L1', 'L2'].map((id) => ({
      id,
      points: routed.connections.routes.get(id)!.points,
      from: 'A',
      to: 'B',
    }));
    const bars = nodes.map((n) => {
      const bar = routed.connections.bars.get(n.id)!;
      return {
        id: n.id,
        left: n.position.x + bar.start,
        right: n.position.x + bar.end,
        y: n.position.y + 3,
      };
    });
    expect(findOverlaps({ lines, bars, boxes: [] })).toEqual([]);
  });

  it("follows its bus, and is still the user's", () => {
    const moved = [bus('A', A.x, A.y), bus('B', 16, 200)];
    const routed = routeDiagram(moved, [line('L1', 'A', 'B', STEPPED, AT)]);
    const drawn = routed.connections.routes.get('L1')!.points;
    expect(drawn).toEqual([
      [30, 3],
      [30, 100],
      [76, 100],
      [76, 203],
    ]);
    expect(routed.changed.get('L1')).toEqual({
      points: drawn,
      anchors: { source: A, target: { x: 16, y: 200 } },
      manual: true,
    });
    expect(routed.released).toEqual([]);
    expect(routed.edges[0]!.data?.bendManual).toBe(true);
  });

  it('is given up where its bus was moved to where it runs along the bar of another', () => {
    // The bar of C lies at the height of the run across, right of where it ends.
    const moved = [bus('A', A.x, A.y), bus('B', 100, 200), bus('C', 120, 97)];
    const routed = routeDiagram(moved, [line('L1', 'A', 'B', STEPPED, AT)]);
    expect(routed.released).toEqual(['L1']);
    // Routed afresh, as a route the diagram made.
    expect(routed.unrouted).toEqual([]);
    expect(routed.changed.get('L1')!.manual).toBeUndefined();
    expect(routed.edges[0]!.data?.bendManual).toBeUndefined();
  });

  it('leaves a route that stands where it was drawn alone, whatever is put on it', () => {
    // A load dropped on the run across: the route is not the one that gives way.
    const withLoad = [...nodes, device('PQ', 30, 80), bus('C', 300, 0)];
    const routed = routeDiagram(withLoad, [line('L1', 'A', 'B', STEPPED, AT), stub('PQ', 'C')]);
    expect(routed.connections.routes.get('L1')!.points).toEqual(STEPPED);
    expect(routed.changed.has('L1')).toBe(false);
    expect(routed.released).toEqual([]);
  });

  it('says which connectors of devices it brought along, and which it gave up', () => {
    const drawn: Point[] = [
      [46, -40],
      [46, -28],
      [70, -28],
      [70, 3],
    ];
    const made: Anchors = { source: { x: 26, y: -80 }, target: A };
    const along = routeDiagram(
      [bus('A', A.x, A.y), device('PQ', 6, -80)],
      [stub('PQ', 'A', drawn, made)],
    );
    expect(along.released).toEqual([]);
    expect(along.changed.get('stub-PQ')).toEqual({
      points: [
        [26, -40],
        [26, -28],
        [70, -28],
        [70, 3],
      ],
      anchors: { source: { x: 6, y: -80 }, target: A },
      manual: true,
    });
    const across = routeDiagram(
      [bus('A', A.x, A.y), device('PQ', 26, 40)],
      [stub('PQ', 'A', drawn, made)],
    );
    expect(across.released).toEqual(['stub-PQ']);
    expect(across.changed.has('stub-PQ')).toBe(false);
    // One that stands where it was drawn is neither.
    const still = routeDiagram(
      [bus('A', A.x, A.y), device('PQ', 26, -80)],
      [stub('PQ', 'A', drawn, made)],
    );
    expect(still.released).toEqual([]);
    expect(still.changed.size).toBe(0);
  });
});

describe('buildGraph: routes drawn by hand', () => {
  const entry = (
    idx: number | string,
    kind: string,
    params: TopologyEntry['params'],
  ): TopologyEntry => ({ idx, name: String(idx), kind, params });
  const topology: TopologySummary = {
    state: 'pre-setup',
    buses: [entry(1, 'Bus', {}), entry(2, 'Bus', {})],
    lines: [entry('L1', 'Line', { bus1: 1, bus2: 2 })],
    transformers: [],
    generators: [],
    loads: [entry('PQ_1', 'PQ', { bus: 1 })],
    shunts: [],
  };
  const coords = { '1': A, '2': B };
  const drawnStub: Point[] = [
    [46, -40],
    [46, 3],
  ];
  const bendPoints = new Map<string, [number, number][]>([
    ['line-L1', STEPPED],
    ['stub-load-PQ_1', drawnStub],
  ]);
  const bendAnchors = new Map([
    ['line-L1', AT],
    ['stub-load-PQ_1', { source: { x: 26, y: -80 }, target: A }],
  ]);

  it('keeps one for a bus that has moved since, which a route the diagram made is not', () => {
    const dragOverrides = { '2': { x: 64, y: 200 } };
    const byHand = buildGraph(topology, coords, {
      bendPoints,
      bendAnchors,
      bendManual: new Set(['line-L1']),
      dragOverrides,
    });
    const kept = byHand.edges.find((e) => e.id === 'line-L1')!.data!;
    expect(kept.bendPoints).toEqual(STEPPED);
    expect(kept.bendAnchors).toEqual(AT);
    expect(kept.bendManual).toBe(true);
    const made = buildGraph(topology, coords, { bendPoints, bendAnchors, dragOverrides });
    const dropped = made.edges.find((e) => e.id === 'line-L1')!.data!;
    expect(dropped.bendPoints).toBeUndefined();
    expect(dropped.bendManual).toBeUndefined();
  });

  it('hands the connector of a device its points only when it was drawn by hand', () => {
    const byHand = buildGraph(topology, coords, {
      bendPoints,
      bendAnchors,
      bendManual: new Set(['stub-load-PQ_1']),
    });
    const stubEdge = byHand.edges.find((e) => e.id === 'stub-load-PQ_1')!.data!;
    expect(stubEdge.bendPoints).toEqual(drawnStub);
    expect(stubEdge.bendAnchors).toEqual({ source: { x: 26, y: -80 }, target: A });
    expect(stubEdge.bendManual).toBe(true);
    // And is named after its device, for the notices that speak of it.
    expect(stubEdge.name).toBe('PQ_1');
    const plain = buildGraph(topology, coords, { bendPoints, bendAnchors });
    expect(plain.edges.find((e) => e.id === 'stub-load-PQ_1')!.data!.bendPoints).toBeUndefined();
  });
});

describe('planTidy: routes drawn by hand', () => {
  const entry = (
    idx: number | string,
    kind: string,
    params: TopologyEntry['params'],
  ): TopologyEntry => ({ idx, name: String(idx), kind, params });
  const topology: TopologySummary = {
    state: 'pre-setup',
    buses: [entry(1, 'Bus', {}), entry(2, 'Bus', {})],
    lines: [entry('L1', 'Line', { bus1: 1, bus2: 2 }), entry('L2', 'Line', { bus1: 1, bus2: 2 })],
    transformers: [],
    generators: [],
    loads: [],
    shunts: [],
  };
  /** The diagram with `L1` drawn by hand for buses at `at`, which stand at `now`. */
  const graphOf = (at: Anchors, now: Anchors = at) =>
    buildGraph(
      topology,
      { '1': now.source, '2': now.target },
      {
        bendPoints: new Map([['line-L1', STEPPED]]),
        bendAnchors: new Map([['line-L1', at]]),
        bendManual: new Set(['line-L1']),
      },
    );

  it('leaves one as it is, and routes the others round it', () => {
    const plan = planTidy(graphOf(AT), topology, { relayout: false });
    expect(plan.byHand?.get('line-L1')).toEqual(STEPPED);
    expect(plan.released).toBeUndefined();
    // Only the other line was routed.
    expect([...plan.tidied.routes.keys()]).toEqual(['line-L2']);
    expect(plan.tidied.unrouted).toEqual([]);
    const lines = [
      { id: 'line-L1', points: STEPPED, from: '1', to: '2' },
      { id: 'line-L2', points: plan.tidied.routes.get('line-L2')!, from: '1', to: '2' },
    ];
    expect(
      findOverlaps({ lines, bars: [], boxes: [] }).filter((o) => o.kind === 'line-line'),
    ).toEqual([]);
  });

  it('brings one along with the buses a re-layout moves', () => {
    // Bus 2 stands a little off the grid: a re-layout lines it up.
    const off = { source: A, target: { x: 5, y: 203 } };
    const drawn: Point[] = [
      [30, 3],
      [30, 100],
      [60, 100],
      [60, 206],
    ];
    const graph = buildGraph(
      topology,
      { '1': off.source, '2': off.target },
      {
        bendPoints: new Map([['line-L1', drawn]]),
        bendAnchors: new Map([['line-L1', off]]),
        bendManual: new Set(['line-L1']),
      },
    );
    const plan = planTidy(graph, topology, { relayout: true });
    const bus2 = plan.nodes.find((n) => n.id === '2')!.position;
    expect(bus2).not.toEqual(off.target);
    const kept = plan.byHand?.get('line-L1');
    expect(kept).toBeDefined();
    // Its end went with the bus, and the rest of it stayed.
    expect(kept!.at(-1)).toEqual([60 + bus2.x - 5, bus2.y + 3]);
    expect(kept!.slice(0, 2)).toEqual(drawn.slice(0, 2));
    expect(plan.tidied.routes.has('line-L1')).toBe(false);
  });
});
