/**
 * Tidy diagram (`tidy.ts`): the routes it gives the branches of a diagram,
 * with the buses and the devices where they are, and the grid it brings the
 * buses onto for Tidy and re-layout.
 *
 * A bus node at `(x, y)` is drawn as a bar from `x` to `x + 92` whose centre
 * line is at `y + 3`. The first tests are small diagrams built by hand, one
 * rule each. The last ones are the three example cases drawn along the
 * routes ELK makes for them (which the app no longer draws: a case opens
 * tidied, see `noOverlap.test.ts`), where the rules are held on the whole
 * drawing: those routes share corridors, as the routes of a layout saved by
 * an earlier version do, which is what Tidy diagram is for.
 *
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK
 * engine run in-thread, as in `layout.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { TopologySummary } from '@/api/types';
import { autoLayout } from '@/components/sld/layout';
import { buildGraph } from '@/components/sld/graph';
import {
  BEND_CLEAR,
  RUN_CLEARANCE,
  SLIDE_CLEARANCE,
  TAP_SPACING,
  distanceToRun,
  layoutConnections,
  type ConnectionEdge,
  type Point,
  type Rect,
} from '@/components/sld/connections';
import {
  ALIGN_TOLERANCE,
  DEVICE_CLEARANCE,
  GRID_STEP,
  NEAR_LINE,
  TIDY_STEPS,
  TIP_REACH,
  alignToGrid,
  tidyRoutes,
  type TidyNode,
} from '@/components/sld/tidy';
import { IEEE14, KUNDUR, WSCC9 } from '../../helpers/exampleCases';

vi.mock('@/components/sld/elkClient', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { elkLayout: vi.fn((graph: ElkNode) => elk.layout(graph)) };
});

function bus(id: string, x: number, y: number): TidyNode {
  return { id, type: 'bus', position: { x, y }, data: { name: `B${id}` } };
}

/** A 40 x 40 device whose top-left corner is at `(x, y)`. */
function device(id: string, x: number, y: number, type = 'load'): TidyNode {
  return { id, type, position: { x, y }, initialWidth: 40, initialHeight: 40 };
}

function stub(deviceId: string, busId: string): ConnectionEdge {
  return { id: `stub-${deviceId}`, type: 'stub', source: deviceId, target: busId };
}

function line(id: string, from: string, to: string): ConnectionEdge {
  return { id, type: 'topology', source: from, target: to };
}

/** The edges with the routes Tidy gave them, as the canvas hands them to the connection pass. */
function tidied(
  nodes: readonly TidyNode[],
  edges: readonly ConnectionEdge[],
  routes: ReadonlyMap<string, Point[]>,
): ConnectionEdge[] {
  const at = new Map(nodes.map((n) => [n.id, n.position]));
  return edges.map((edge) => {
    const points = routes.get(edge.id);
    if (points === undefined) return edge;
    return {
      ...edge,
      data: {
        ...edge.data,
        bendPoints: points,
        bendAnchors: { source: { ...at.get(edge.source)! }, target: { ...at.get(edge.target)! } },
      },
    };
  });
}

/** The straight runs of a route. */
function runsOf(points: readonly Point[]): [Point, Point][] {
  return points.slice(1).map((p, i) => [points[i]!, p]);
}

function bendsOf(points: readonly Point[]): number {
  return points.length - 2;
}

/** How far the level or upright run from `a` to `b` is from `box`; 0 when it touches or enters it. */
function distance(a: Point, b: Point, box: Rect): number {
  const dx = Math.max(box.left - Math.max(a[0], b[0]), Math.min(a[0], b[0]) - box.right, 0);
  const dy = Math.max(box.top - Math.max(a[1], b[1]), Math.min(a[1], b[1]) - box.bottom, 0);
  return Math.hypot(dx, dy);
}

/** How long the stretch is that two runs lie side by side for, nearer than `NEAR_LINE`. */
function alongside([a, b]: [Point, Point], [p, q]: [Point, Point]): number {
  for (const axis of [0, 1] as const) {
    const other = axis === 0 ? 1 : 0;
    // Both runs along this axis: level for 0, upright for 1.
    if (a[other] !== b[other] || p[other] !== q[other]) continue;
    if (Math.abs(a[other] - p[other]) >= NEAR_LINE) continue;
    const from = Math.max(Math.min(a[axis], b[axis]), Math.min(p[axis], q[axis]));
    const to = Math.min(Math.max(a[axis], b[axis]), Math.max(p[axis], q[axis]));
    return Math.max(0, to - from);
  }
  return 0;
}

/** Whether two runs cross, each at a point inside it. */
function cross([a, b]: [Point, Point], [p, q]: [Point, Point]): boolean {
  const side = (u: Point, v: Point, w: Point): number =>
    (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]);
  return side(p, q, a) * side(p, q, b) < 0 && side(a, b, p) * side(a, b, q) < 0;
}

/** Every pair of routes that share a run, and how often two routes cross. */
function meetings(routes: ReadonlyMap<string, readonly Point[]>): {
  shared: string[];
  crossings: number;
} {
  const ids = [...routes.keys()];
  const shared: string[] = [];
  let crossings = 0;
  for (let i = 0; i < ids.length; i += 1) {
    for (let k = i + 1; k < ids.length; k += 1) {
      for (const first of runsOf(routes.get(ids[i]!)!)) {
        for (const second of runsOf(routes.get(ids[k]!)!)) {
          if (alongside(first, second) > 1) shared.push(`${ids[i]} and ${ids[k]}`);
          if (cross(first, second)) crossings += 1;
        }
      }
    }
  }
  return { shared: [...new Set(shared)], crossings };
}

describe('tidyRoutes: one branch', () => {
  it('runs straight down between two bars that stand one over the other', () => {
    const nodes = [bus('1', 0, 0), bus('2', 16, 160)];
    const edges = [line('l', '1', '2')];
    const { routes, unrouted } = tidyRoutes(nodes, edges);
    expect(unrouted).toEqual([]);
    const points = routes.get('l')!;
    expect(points).toHaveLength(2);
    expect(points[0]![0]).toBe(points[1]![0]);
    // On the grid, and on both bars: 16 + 3 to 89 is what the two share.
    expect(points[0]![0] % GRID_STEP).toBe(0);
    expect(points[0]![0]).toBeGreaterThanOrEqual(19);
    expect(points[0]![0]).toBeLessThanOrEqual(89);
    expect([points[0]![1], points[1]![1]]).toEqual([3, 163]);
  });

  it('bridges over two buses that stand level, and never joins them end to end', () => {
    const nodes = [bus('1', 0, 0), bus('2', 200, 0)];
    const points = tidyRoutes(nodes, [line('l', '1', '2')]).routes.get('l')!;
    // Out of a face of one bar, across clear of both, and onto the same face
    // of the other: a line from tip to tip would read as one long bar.
    expect(points).toHaveLength(4);
    expect([points[0]![1], points[3]![1]]).toEqual([3, 3]);
    expect(points[0]![0]).toBeLessThanOrEqual(92);
    expect(points[3]![0]).toBeGreaterThanOrEqual(200);
    const across = points[1]![1];
    expect(points[2]![1]).toBe(across);
    expect(Math.abs(across - 3)).toBeGreaterThanOrEqual(GRID_STEP);
  });

  it('draws neither of two level bars out towards the other, however near they stand', () => {
    // Tip to tip the two bars are 48 apart: a tap past the east tip of the
    // one and a tap past the west tip of the other could be the same place,
    // the bars would be drawn out to it from both sides, and the line
    // between them would be no line at all. (`noOverlap.test.ts` holds the
    // layout shipped for IEEE 14 to this, where it happened.)
    for (const gap of [48, 64, 108, 140]) {
      const nodes = [bus('1', 0, 0), bus('2', 92 + gap, 0)];
      const { routes, unrouted } = tidyRoutes(nodes, [line('l', '1', '2')]);
      expect(unrouted, `${gap} apart`).toEqual([]);
      const points = routes.get('l')!;
      // On its own bar at either end, and over or under in between.
      expect(points[0]![0], `${gap} apart`).toBeLessThanOrEqual(92);
      expect(points.at(-1)![0], `${gap} apart`).toBeGreaterThanOrEqual(92 + gap);
      expect(points, `${gap} apart`).toHaveLength(4);
      expect(Math.abs(points[1]![1] - 3), `${gap} apart`).toBeGreaterThanOrEqual(GRID_STEP);
      expect(points[2]![1], `${gap} apart`).toBe(points[1]![1]);
    }
  });

  it('is routed from its source to its target, whichever stands first', () => {
    const nodes = [bus('1', 0, 0), bus('2', 200, 0)];
    const forward = tidyRoutes(nodes, [line('l', '1', '2')]).routes.get('l')!;
    const backward = tidyRoutes(nodes, [line('l', '2', '1')]).routes.get('l')!;
    expect(backward[0]![0]).toBeGreaterThanOrEqual(200);
    expect(backward).toEqual([...forward].reverse());
  });

  it('turns twice to reach a bus that stands below and to the side: out of a face, onto a face', () => {
    const nodes = [bus('1', 0, 0), bus('2', 240, 160)];
    const points = tidyRoutes(nodes, [line('l', '1', '2')]).routes.get('l')!;
    expect(bendsOf(points)).toBe(2);
    const runs = runsOf(points);
    // It leaves the one bar downwards and lands on the other from above.
    expect(runs[0]![0][0]).toBe(runs[0]![1][0]);
    expect(runs[2]![0][0]).toBe(runs[2]![1][0]);
    expect([points[0]![1], points[3]![1]]).toEqual([3, 163]);
  });

  it('runs level at the height of no bar within reach of its tips', () => {
    // Bus 3 stands beside the way from 1 to 2, a little off the grid: the
    // line of the grid nearest its bar would bring a level run up to its tip.
    const nodes = [bus('1', 0, 0), bus('2', 400, 320), bus('3', 150, 157)];
    const points = tidyRoutes(nodes, [line('l', '1', '2')]).routes.get('l')!;
    for (const [a, b] of runsOf(points)) {
      if (a[1] !== b[1]) continue;
      const nearBar = Math.abs(a[1] - 160) < RUN_CLEARANCE;
      const nearTips =
        Math.max(a[0], b[0]) > 150 - TIP_REACH && Math.min(a[0], b[0]) < 242 + TIP_REACH;
      expect(nearBar && nearTips, `a level run at ${a[1]}`).toBe(false);
    }
  });

  it('goes round a device that stands between its two buses', () => {
    const nodes = [bus('1', 0, 0), bus('2', 0, 240), device('load-x', 26, 100)];
    const edges = [line('l', '1', '2')];
    const points = tidyRoutes(nodes, edges).routes.get('l')!;
    const box: Rect = { left: 26, right: 66, top: 100, bottom: 140 };
    for (const [a, b] of runsOf(points)) {
      expect(distance(a, b, box)).toBeGreaterThanOrEqual(DEVICE_CLEARANCE);
    }
    // With the device out of the way it would be one run.
    expect(tidyRoutes([nodes[0]!, nodes[1]!], edges).routes.get('l')).toHaveLength(2);
  });

  it('keeps off the bar of a bus it passes, and off the label under it', () => {
    const nodes = [bus('1', 0, 0), bus('2', 0, 320), bus('3', 0, 160)];
    const points = tidyRoutes(nodes, [line('l', '1', '2')]).routes.get('l')!;
    // The bar of bus 3 with its label: the route keeps the clearance of an
    // upright run from the one and stays out of the other.
    const bar: Rect = { left: 0, right: 92, top: 160, bottom: 166 };
    const label: Rect = { left: 46 - 31, right: 46 + 31, top: 166, bottom: 204 };
    for (const [a, b] of runsOf(points)) {
      expect(distance(a, b, bar)).toBeGreaterThanOrEqual(SLIDE_CLEARANCE);
      expect(distance(a, b, label)).toBeGreaterThan(0);
    }
    // It ends on the two bars it joins, drawn out to it if it passes the third by its tip.
    expect([points[0]![1], points[points.length - 1]![1]]).toEqual([3, 323]);
  });

  it('keeps off what stands on the diagram and is no node', () => {
    const nodes = [bus('1', 0, 0), bus('2', 0, 240)];
    const chain: Rect = { left: 10, right: 80, top: 90, bottom: 150 };
    const points = tidyRoutes(nodes, [line('l', '1', '2')], { obstacles: [chain] }).routes.get(
      'l',
    )!;
    for (const [a, b] of runsOf(points)) expect(distance(a, b, chain)).toBeGreaterThan(0);
  });

  it('runs through no place where it is told the label of a bus stands, its own bus among them', () => {
    // Two buses one over the other: the line runs straight down from the
    // middle of one bar to the middle of the other, through where the label
    // of the upper bus hangs unless it is told the label stands there.
    const nodes = [bus('1', 0, 0), bus('2', 0, 240)];
    const edges = [line('l', '1', '2')];
    const label: Rect = { left: 15, right: 77, top: 6, bottom: 46 };
    const straight = tidyRoutes(nodes, edges).routes.get('l')!;
    expect(runsOf(straight).some(([a, b]) => distance(a, b, label) === 0)).toBe(true);
    const round = tidyRoutes(nodes, edges, { labels: [label] }).routes.get('l')!;
    for (const [a, b] of runsOf(round)) expect(distance(a, b, label)).toBeGreaterThan(0);
    expect([round[0]![1], round[round.length - 1]![1]]).toEqual([3, 243]);
    // A label that is in the way of nothing changes nothing: it adds no
    // line to the grid for a route to take.
    const aside: Rect = { left: 200, right: 262, top: 100, bottom: 140 };
    expect(tidyRoutes(nodes, edges, { labels: [aside] }).routes.get('l')).toEqual(straight);
  });

  it('makes no run between two bends shorter than a step of the grid allows', () => {
    // The device leaves a way past it a pixel off a line of the grid.
    const nodes = [bus('1', 0, 0), bus('2', 0, 240), device('load-x', 31, 100)];
    const points = tidyRoutes(nodes, [line('l', '1', '2')]).routes.get('l')!;
    for (const [a, b] of runsOf(points).slice(1, -1)) {
      expect(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])).toBeGreaterThanOrEqual(12);
    }
  });

  it('leaves a branch that has no way out to the connection pass', () => {
    // Bus 1 is walled in on every side.
    const walls: Rect[] = [
      { left: -60, right: 150, top: -60, bottom: -40 },
      { left: -60, right: 150, top: 70, bottom: 90 },
      { left: -60, right: -40, top: -60, bottom: 90 },
      { left: 130, right: 150, top: -60, bottom: 90 },
    ];
    const nodes = [bus('1', 0, 0), bus('2', 400, 0), bus('3', 400, 160)];
    const { routes, unrouted } = tidyRoutes(nodes, [line('in', '1', '2'), line('out', '2', '3')], {
      obstacles: walls,
    });
    expect(unrouted).toEqual(['in']);
    expect([...routes.keys()]).toEqual(['out']);
  });

  it('routes nothing where there is no branch, and no branch from a bus to itself', () => {
    const nodes = [bus('1', 0, 0), device('load-x', 20, 70)];
    expect(tidyRoutes(nodes, [stub('load-x', '1')])).toEqual({
      routes: new Map(),
      unrouted: [],
      spots: new Map(),
      steps: 0,
    });
    expect(tidyRoutes(nodes, [line('loop', '1', '1')]).routes.size).toBe(0);
  });
  it('never turns a route back into the bar it has just left', () => {
    // The generator lands a few pixels from the east tip of bus 1, which
    // shuts that end, so the line to the bus level with it leaves by a face.
    // A route that went up from a tap past the tip and straight back down
    // onto the line of the bar would be drawn as running out of the tip.
    const nodes = [
      bus('1', 0, 0),
      bus('2', 300, 0),
      device('generator-g', 59, -70, 'generator'),
      device('load-x', 20, 70),
    ];
    const edges = [stub('generator-g', '1'), stub('load-x', '1'), line('l', '1', '2')];
    const { routes, unrouted } = tidyRoutes(nodes, edges);
    expect(unrouted).toEqual([]);
    const points = routes.get('l')!;
    for (const [a, b] of runsOf(points)) {
      expect(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])).toBeGreaterThan(0);
    }
    // It leaves the bar square, and what it answers is what is drawn.
    expect(points[0]![0]).toBe(points[1]![0]);
    const drawn = layoutConnections(nodes, tidied(nodes, edges, routes));
    expect(drawn.routes.get('l')!.points).toEqual(points);
  });
});

describe('tidyRoutes: the taps of a bar', () => {
  it('gives the branches of one bus taps and runs of their own', () => {
    const nodes = [bus('1', 100, 0), bus('2', 0, 200), bus('3', 100, 200), bus('4', 200, 200)];
    const edges = [line('a', '1', '2'), line('b', '1', '3'), line('c', '1', '4')];
    const { routes } = tidyRoutes(nodes, edges);
    expect(meetings(routes).shared).toEqual([]);
    const taps = edges.map((edge) => routes.get(edge.id)![0]![0]).sort((p, q) => p - q);
    expect(taps[1]! - taps[0]!).toBeGreaterThanOrEqual(TAP_SPACING);
    expect(taps[2]! - taps[1]!).toBeGreaterThanOrEqual(TAP_SPACING);
  });

  it('runs two lines between the same buses side by side', () => {
    const nodes = [bus('1', 0, 0), bus('2', 0, 160)];
    const { routes } = tidyRoutes(nodes, [line('a', '1', '2'), line('b', '1', '2')]);
    const [a, b] = [routes.get('a')!, routes.get('b')!];
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    expect(Math.abs(a[0]![0] - b[0]![0])).toBe(GRID_STEP);
  });

  it('lands a branch a spacing clear of a device on the other face, never on its dot', () => {
    // A generator over the middle of the bar of bus 1, and a branch that
    // leaves under it: in one place the two would read as one line through
    // the bus.
    const nodes = [bus('1', 0, 100), bus('2', 0, 300), device('generator-g', 26, 30, 'generator')];
    const edges = [stub('generator-g', '1'), line('l', '1', '2')];
    const { routes } = tidyRoutes(nodes, edges);
    const tap = routes.get('l')![0]![0];
    const deviceTap = layoutConnections(nodes, edges).routes.get('stub-generator-g')!.points[1]![0];
    expect(deviceTap).toBe(46);
    expect(Math.abs(tap - deviceTap)).toBeGreaterThanOrEqual(TAP_SPACING);
    // And what Tidy answers is what the connection pass draws.
    const drawn = layoutConnections(nodes, tidied(nodes, edges, routes));
    expect(drawn.routes.get('l')!.points).toEqual(routes.get('l'));
  });

  it('never lands two branches at one place, one from above and one from below', () => {
    // Three buses one over the other: the line that comes down onto the
    // middle one and the line that leaves under it have a tap each.
    const nodes = [bus('1', 0, 0), bus('2', 0, 160), bus('3', 0, 320)];
    const { routes } = tidyRoutes(nodes, [line('upper', '1', '2'), line('lower', '2', '3')]);
    const [upper, lower] = [routes.get('upper')!, routes.get('lower')!];
    expect(upper).toHaveLength(2);
    expect(lower).toHaveLength(2);
    expect(Math.abs(upper[1]![0] - lower[0]![0])).toBeGreaterThanOrEqual(TAP_SPACING);
  });

  it('keeps a branch on a face a spacing clear of the device beside it there', () => {
    const nodes = [bus('1', 0, 100), bus('2', 0, -100), device('generator-g', 12, 30, 'generator')];
    const edges = [stub('generator-g', '1'), line('l', '2', '1')];
    const { routes } = tidyRoutes(nodes, edges);
    const points = routes.get('l')!;
    const tap = points[points.length - 1]![0];
    expect(Math.abs(tap - 32)).toBeGreaterThanOrEqual(TAP_SPACING);
    // And clear of the device itself on its way down.
    const box: Rect = { left: 12, right: 52, top: 30, bottom: 70 };
    for (const [a, b] of runsOf(points)) {
      expect(distance(a, b, box)).toBeGreaterThanOrEqual(DEVICE_CLEARANCE);
    }
  });

  it('draws a bar out for the branches it has no place left for', () => {
    // Nine buses under one, in a row: more than a face of 92 has taps for.
    const below = Array.from({ length: 9 }, (_, i) => bus(`b${i}`, (i - 4) * 120, 320));
    const nodes = [bus('top', 0, 0), ...below];
    const edges = below.map((node) => line(`to-${node.id}`, 'top', node.id));
    const { routes, unrouted } = tidyRoutes(nodes, edges);
    expect(unrouted).toEqual([]);
    const drawn = layoutConnections(nodes, tidied(nodes, edges, routes));
    for (const edge of edges) {
      expect(drawn.routes.get(edge.id)!.points).toEqual(routes.get(edge.id));
    }
    // The connection pass draws the bar as long as its taps need.
    const bar = drawn.bars.get('top')!;
    expect(bar.end - bar.start).toBeGreaterThan(92);
    for (const tap of bar.taps) {
      expect(tap.x).toBeGreaterThanOrEqual(bar.start);
      expect(tap.x).toBeLessThanOrEqual(bar.end);
    }
    expect(meetings(routes).shared).toEqual([]);
  });
});

describe('tidyRoutes: several branches', () => {
  it('crosses two routes at a right angle where they must meet, and nowhere else', () => {
    // 1 over 2 and 3 beside 4, with the line from 3 to 4 between 1 and 2.
    const nodes = [bus('1', 100, 0), bus('2', 100, 320), bus('3', -200, 160), bus('4', 400, 160)];
    const edges = [line('down', '1', '2'), line('across', '3', '4')];
    const { routes } = tidyRoutes(nodes, edges);
    const met = meetings(routes);
    expect(met.shared).toEqual([]);
    expect(met.crossings).toBe(1);
    expect(routes.get('down')).toHaveLength(2);
    // Out of a face of bus 3, across, and onto a face of bus 4.
    expect(routes.get('across')).toHaveLength(4);
  });

  it('lets two routes that cross change places when that parts them', () => {
    // Bus 1 has a line to the bus under its left half and one to the bus
    // under its right half: each lands on its own side, and they never cross.
    const nodes = [bus('1', 100, 0), bus('2', 0, 200), bus('3', 200, 200)];
    const edges = [line('right', '1', '3'), line('left', '1', '2')];
    const { routes } = tidyRoutes(nodes, edges);
    expect(meetings(routes).crossings).toBe(0);
    expect(routes.get('left')![0]![0]).toBeLessThan(routes.get('right')![0]![0]);
  });

  it('answers the same routes for the same diagram', () => {
    const nodes = [bus('1', 100, 0), bus('2', 0, 200), bus('3', 200, 200), bus('4', 100, 400)];
    const edges = [
      line('a', '1', '2'),
      line('b', '1', '3'),
      line('c', '2', '4'),
      line('d', '3', '4'),
    ];
    const first = tidyRoutes(nodes, edges);
    const second = tidyRoutes(nodes, edges);
    expect([...second.routes]).toEqual([...first.routes]);
  });
});

describe('tidyRoutes: the routes that stay as they are', () => {
  // Bus 1 over buses 2 and 3: the line to 2 is kept, the line to 3 is routed.
  const nodes = [bus('1', 100, 0), bus('2', 0, 200), bus('3', 200, 200)];
  const edges = [line('kept', '1', '2'), line('new', '1', '3')];
  const held: Point[] = [
    [144, 3],
    [144, 96],
    [48, 96],
    [48, 203],
  ];

  it('routes only the others, and answers nothing for a kept one', () => {
    const { routes, unrouted } = tidyRoutes(nodes, edges, { keep: new Map([['kept', held]]) });
    expect([...routes.keys()]).toEqual(['new']);
    expect(unrouted).toEqual([]);
  });

  it('keeps a new route off the run of a kept one, and its tap a spacing from the kept tap', () => {
    const { routes } = tidyRoutes(nodes, edges, { keep: new Map([['kept', held]]) });
    const made = routes.get('new')!;
    expect(
      meetings(
        new Map([
          ['kept', held],
          ['new', made],
        ]),
      ).shared,
    ).toEqual([]);
    expect(Math.abs(made[0]![0] - 144)).toBeGreaterThanOrEqual(TAP_SPACING);
    // The connection pass draws both where they are.
    const drawn = layoutConnections(
      nodes,
      tidied(
        nodes,
        edges,
        new Map([
          ['kept', held],
          ['new', made],
        ]),
      ),
    );
    expect(drawn.routes.get('kept')!.points).toEqual(held);
    expect(drawn.routes.get('new')!.points).toEqual(made);
  });

  it('takes the place a kept route has on the bar as taken, whichever face it is on', () => {
    // The kept line comes down onto the middle of bus 2, and a new one leaves
    // under bus 2: not from the same place.
    const stacked = [bus('1', 0, 0), bus('2', 0, 160), bus('3', 0, 320)];
    const lines = [line('upper', '1', '2'), line('lower', '2', '3')];
    const keep = new Map<string, Point[]>([
      [
        'upper',
        [
          [48, 3],
          [48, 163],
        ],
      ],
    ]);
    const lower = tidyRoutes(stacked, lines, { keep }).routes.get('lower')!;
    expect(Math.abs(lower[0]![0] - 48)).toBeGreaterThanOrEqual(TAP_SPACING);
  });

  it('crosses a kept route that is drawn at an angle, and does not run along it', () => {
    const diagonal: Point[] = [
      [144, 3],
      [48, 203],
    ];
    const made = tidyRoutes(nodes, edges, { keep: new Map([['kept', diagonal]]) }).routes.get(
      'new',
    )!;
    expect(made.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(made[0]![0] - 144)).toBeGreaterThanOrEqual(TAP_SPACING);
  });

  it('passes no bend of a kept route that is drawn at an angle right beside it', () => {
    // Two pairs of buses side by side. The kept line of the right pair is
    // drawn as a `<` whose point comes to two beside where the line of the
    // left pair drops straight down, half way between two lines of the grid.
    const pairs = [bus('1', 0, 0), bus('2', 0, 144), bus('3', 200, 0), bus('4', 200, 144)];
    const both = [line('new', '1', '2'), line('kept', '3', '4')];
    const pointed: Point[] = [
      [216, 3],
      [50, 72],
      [216, 147],
    ];
    expect(tidyRoutes(pairs, [both[0]!]).routes.get('new')).toEqual([
      [48, 3],
      [48, 147],
    ]);
    const made = tidyRoutes(pairs, both, { keep: new Map([['kept', pointed]]) }).routes.get('new')!;
    const off = Math.min(...runsOf(made).map(([a, b]) => distanceToRun(pointed[1]!, a, b)));
    expect(off).toBeGreaterThanOrEqual(BEND_CLEAR);
  });

  it('does not turn corner to corner with a kept route, each just short of the other', () => {
    // The kept line comes in from the left at 99 and turns down at 45. The
    // new one comes down at 48, and what stands to its right leaves it only
    // the line of the grid at 96 to turn right on: three over the kept run
    // and three beside the kept bend, where the two bends would read as one
    // crossing. It goes another way.
    const around = [bus('L', -160, 0), bus('1', 0, 0), bus('2', 0, 200), bus('3', 200, 200)];
    const lines = [line('kept', 'L', '2'), line('new', '1', '3')];
    const turned: Point[] = [
      [-112, 3],
      [-112, 99],
      [45, 99],
      [45, 203],
    ];
    const { routes, unrouted } = tidyRoutes(around, lines, {
      keep: new Map([['kept', turned]]),
      obstacles: [{ left: 56, right: 104, top: 10, bottom: 84 }],
    });
    expect(unrouted).toEqual([]);
    const made = routes.get('new')!;
    for (const bend of made.slice(1, -1)) {
      for (const corner of turned.slice(1, -1)) {
        const [dx, dy] = [Math.abs(bend[0] - corner[0]), Math.abs(bend[1] - corner[1])];
        expect(Math.max(dx, dy), `${bend[0]}, ${bend[1]}`).toBeGreaterThanOrEqual(NEAR_LINE);
      }
    }
  });
});

describe('tidyRoutes: room for the symbol of a transformer', () => {
  const transformer = (id: string, from: string, to: string): ConnectionEdge => ({
    ...line(id, from, to),
    type: 'transformer',
  });
  /** The box the symbol takes about `spot`. */
  const symbolAt = ([x, y]: Point): Rect => ({
    left: x - 15,
    right: x + 15,
    top: y - 15,
    bottom: y + 15,
  });
  /** Whether a route runs through `box`, and not just along its edge. */
  const through = (points: readonly Point[], box: Rect): boolean =>
    runsOf(points).some(
      ([a, b]) =>
        Math.max(a[0], b[0]) > box.left &&
        Math.min(a[0], b[0]) < box.right &&
        Math.max(a[1], b[1]) > box.top &&
        Math.min(a[1], b[1]) < box.bottom,
    );

  it('says where the route of a transformer has room for its symbol, and of a line nothing', () => {
    const nodes = [bus('1', 0, 0), bus('2', 0, 208)];
    const { routes, spots } = tidyRoutes(nodes, [transformer('t', '1', '2'), line('l', '1', '2')]);
    expect(routes.get('t')).toEqual([
      [48, 3],
      [48, 211],
    ]);
    // Half way along, where nothing stands.
    expect([...spots]).toEqual([['t', [48, 107]]]);
    // The line beside it passes the symbol, on the next line of the grid.
    expect(through(routes.get('l')!, symbolAt(spots.get('t')!))).toBe(false);
  });

  it('runs a transformer straight between two bars that leave its symbol room', () => {
    // 48 apart: 42 clear between the two bars, for a symbol of 30.
    const nodes = [bus('1', 0, 0), bus('2', 0, 48)];
    const { routes, spots } = tidyRoutes(nodes, [transformer('t', '1', '2')]);
    expect(routes.get('t')).toEqual([
      [48, 3],
      [48, 51],
    ]);
    expect(spots.get('t')).toEqual([48, 27]);
  });

  it('takes a transformer round where the straight way between two bars has no room for its symbol', () => {
    // 36 apart: a line runs straight from one bar to the other, and the
    // symbol of a transformer would be on both bars there.
    const nodes = [bus('1', 0, 0), bus('2', 0, 36)];
    expect(tidyRoutes(nodes, [line('l', '1', '2')]).routes.get('l')).toEqual([
      [48, 3],
      [48, 39],
    ]);
    const edges = [transformer('t', '1', '2')];
    const { routes, spots, unrouted } = tidyRoutes(nodes, edges);
    expect(unrouted).toEqual([]);
    const route = routes.get('t')!;
    expect(route.length).toBeGreaterThan(2);
    // On a straight stretch as long as the symbol, clear of both bars as
    // they are drawn with the route.
    const spot = spots.get('t')!;
    const run = runsOf(route).find(
      ([a, b]) =>
        (a[0] === b[0] && a[0] === spot[0] && Math.abs(a[1] - b[1]) >= 30) ||
        (a[1] === b[1] && a[1] === spot[1] && Math.abs(a[0] - b[0]) >= 30),
    );
    expect(run).toBeDefined();
    const { bars } = layoutConnections(nodes, tidied(nodes, edges, routes));
    for (const node of nodes) {
      const bar = bars.get(node.id)!;
      const box = symbolAt(spot);
      const onBar =
        box.left < node.position.x + bar.end &&
        box.right > node.position.x + bar.start &&
        box.top < node.position.y + 6 &&
        box.bottom > node.position.y;
      expect(onBar, `bar ${node.id}`).toBe(false);
    }
  });

  it('keeps a route out of the symbol of a transformer that stays as it is', () => {
    const nodes = [bus('1', 0, 0), bus('2', 0, 208)];
    const edges = [transformer('t', '1', '2'), line('l', '1', '2')];
    const keep = new Map<string, Point[]>([
      [
        't',
        [
          [48, 3],
          [48, 211],
        ],
      ],
    ]);
    // A symbol wider than it is drawn, so that the next line of the grid
    // runs through it.
    const symbol: Rect = { left: 20, right: 76, top: 92, bottom: 122 };
    const beside = tidyRoutes(nodes, edges, { keep }).routes.get('l')!;
    expect(through(beside, symbol)).toBe(true);
    const clear = tidyRoutes(nodes, edges, { keep, symbols: new Map([['t', symbol]]) });
    expect(clear.unrouted).toEqual([]);
    expect(through(clear.routes.get('l')!, symbol)).toBe(false);
  });
});

describe('tidyRoutes: a part of the diagram', () => {
  it('routes only the branches it is asked for, as if the others were not there', () => {
    const nodes = [bus('1', 0, 0), bus('2', 0, 208)];
    const edges = [line('a', '1', '2'), line('b', '1', '2')];
    const { routes, unrouted } = tidyRoutes(nodes, edges, { only: new Set(['b']) });
    expect([...routes.keys()]).toEqual(['b']);
    expect(unrouted).toEqual([]);
    // In the middle of the bar, where the first of two would stand.
    expect(routes.get('b')).toEqual([
      [48, 3],
      [48, 211],
    ]);
  });

  it('reads only what stands in the box it is given, and routes only the branches in it', () => {
    // Two pairs of buses far apart, a line in each.
    const nodes = [bus('1', 0, 0), bus('2', 0, 160), bus('3', 4000, 0), bus('4', 4000, 160)];
    const edges = [line('here', '1', '2'), line('there', '3', '4')];
    const within = { left: -200, right: 300, top: -200, bottom: 400 };
    const { routes, unrouted } = tidyRoutes(nodes, edges, { within });
    expect([...routes.keys()]).toEqual(['here']);
    expect(unrouted).toEqual([]);
    // The same route as with the whole diagram read.
    expect(routes.get('here')).toEqual(tidyRoutes(nodes, edges).routes.get('here'));
  });

  it('brings the bus of a device that stands in the box along, and its connector', () => {
    // The load of bus 2 hangs in the box though its bus stands outside it:
    // the route keeps off the connector all the same.
    const nodes = [
      bus('1', 0, 0),
      bus('3', 0, 320),
      bus('2', 300, 100),
      device('load-x', 180, 150),
    ];
    const edges = [line('l', '1', '3'), stub('load-x', '2')];
    const within = { left: -100, right: 230, top: -100, bottom: 420 };
    const { routes } = tidyRoutes(nodes, edges, { within });
    const box: Rect = { left: 180, right: 220, top: 150, bottom: 190 };
    for (const [a, b] of runsOf(routes.get('l')!)) {
      expect(distance(a, b, box)).toBeGreaterThanOrEqual(DEVICE_CLEARANCE);
    }
  });

  it('routes nothing on a grid of more points than it may have, and says so', () => {
    const nodes = [bus('1', 0, 0), bus('2', 0, 160)];
    const result = tidyRoutes(nodes, [line('l', '1', '2')], { gridPoints: 10 });
    expect(result.tooLarge).toBe(true);
    expect(result.unrouted).toEqual(['l']);
  });
});

describe('tidyRoutes: the connectors of the devices', () => {
  it('never runs a branch along the connector of a device, side by side with it', () => {
    // A load hangs under the right of bus 1, and bus 2 stands under and to
    // the right: the way down beside the connector is the shortest.
    const nodes = [bus('1', 0, 0), bus('2', 60, 240), device('load-x', 50, 70)];
    const edges = [stub('load-x', '1'), line('l', '1', '2')];
    const stubs = layoutConnections(nodes, edges).routes.get('stub-load-x')!.points;
    const points = tidyRoutes(nodes, edges).routes.get('l')!;
    const wire: [Point, Point] = [stubs[0]!, stubs[1]!];
    for (const run of runsOf(points)) expect(alongside(run, wire)).toBe(0);
  });
});

describe('tidyRoutes: the places left for the labels of the buses', () => {
  // Bus 1 over bus 2, a label place right under the way between them.
  const nodes = [bus('1', 0, 0), bus('2', 0, 240)];
  const edges = [line('l', '1', '2')];
  const place: Rect = { left: 30, right: 66, top: 100, bottom: 140 };

  it('takes the last place of a label rather than a step aside', () => {
    const { routes } = tidyRoutes(nodes, edges, { preferFree: [[place]] });
    // Straight down, through the place or beside it: no bend is spent on it.
    expect(routes.get('l')).toHaveLength(2);
  });

  it('goes a long way round the last place of a readout', () => {
    const wide: Rect = { left: -40, right: 140, top: 100, bottom: 140 };
    const { routes } = tidyRoutes(nodes, edges, { keepFree: [[wide]] });
    for (const [a, b] of runsOf(routes.get('l')!)) expect(through(a, b, wide)).toBe(false);
  });
});

/** Whether the level or upright run from `a` to `b` passes through the inside of `box`. */
function through(a: Point, b: Point, box: Rect): boolean {
  return (
    Math.max(a[0], b[0]) > box.left &&
    Math.min(a[0], b[0]) < box.right &&
    Math.max(a[1], b[1]) > box.top &&
    Math.min(a[1], b[1]) < box.bottom
  );
}

describe('tidyRoutes: the places kept for the values of a device', () => {
  // A load over the left of bar 2, and a line that comes straight down from
  // bar 1 beside it. `right` is where the values of the load stand, between
  // the load and the bar, right of its connector; `left` is the other side.
  const nodes = [bus('1', 0, 0), bus('2', 0, 200), device('load-x', 0, 130)];
  const edges = [stub('load-x', '2'), line('l', '1', '2')];
  const right: Rect = { left: 24, right: 96, top: 172, bottom: 194 };
  const left: Rect = { left: -56, right: 16, top: 172, bottom: 194 };
  const crosses = (points: readonly Point[], place: Rect): boolean =>
    runsOf(points).some(([a, b]) => through(a, b, place));

  it('runs a line through one of two places as if neither were kept', () => {
    const plain = tidyRoutes(nodes, edges).routes.get('l')!;
    expect(plain).toHaveLength(2);
    expect(crosses(plain, right)).toBe(true);
    // The load still has the other side of its connector.
    const kept = tidyRoutes(nodes, edges, { keepFree: [[right, left]] }).routes.get('l')!;
    expect(kept).toEqual(plain);
    expect(crosses(kept, left)).toBe(false);
  });

  it('takes a line round the last place a device has', () => {
    const { routes, unrouted } = tidyRoutes(nodes, edges, { keepFree: [[right]] });
    expect(unrouted).toEqual([]);
    const points = routes.get('l')!;
    expect(crosses(points, right)).toBe(false);
    // It still lands on both bars, clear of the load.
    const box: Rect = { left: 0, right: 40, top: 130, bottom: 170 };
    for (const [a, b] of runsOf(points)) {
      expect(distance(a, b, box)).toBeGreaterThanOrEqual(DEVICE_CLEARANCE);
    }
    const drawn = layoutConnections(nodes, tidied(nodes, edges, routes));
    expect(drawn.routes.get('l')!.points).toEqual(points);
  });

  it('runs through the last place where there is no other way', () => {
    // Walls either side of the two bars, and a place kept from wall to wall:
    // every way from one bar to the other runs through it.
    const walls: Rect[] = [
      { left: -80, right: -20, top: -60, bottom: 280 },
      { left: 112, right: 170, top: -60, bottom: 280 },
    ];
    const across: Rect = { left: -20, right: 112, top: 172, bottom: 194 };
    const { routes, unrouted } = tidyRoutes(nodes, edges, {
      keepFree: [[across]],
      obstacles: walls,
    });
    expect(unrouted).toEqual([]);
    expect(crosses(routes.get('l')!, across)).toBe(true);
  });
});

/**
 * A mesh of buses in rows, a load under every other one: each bus joined to
 * the next in its row, every other one to the bus below, and `links` more
 * to buses a few rows and columns off, by a fixed rule (the same mesh every
 * time). The links that reach far have to cross what lies between.
 */
function mesh(
  columns: number,
  rows: number,
  links: number,
): { nodes: TidyNode[]; edges: ConnectionEdge[] } {
  const nodes: TidyNode[] = [];
  const edges: ConnectionEdge[] = [];
  const id = (c: number, r: number): string => `${r}-${c}`;
  let seed = 12345;
  const next = (below: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % below;
  };
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      const [x, y] = [c * 176 + next(5) * GRID_STEP, r * 160 + next(3) * GRID_STEP];
      nodes.push(bus(id(c, r), x, y));
      if ((r + c) % 2 === 0) {
        nodes.push(device(`load-${id(c, r)}`, x + 6, y + 70));
        edges.push(stub(`load-${id(c, r)}`, id(c, r)));
      }
      if (c + 1 < columns) edges.push(line(`across-${id(c, r)}`, id(c, r), id(c + 1, r)));
      if (r + 1 < rows && (r + c) % 2 === 1) {
        edges.push(line(`down-${id(c, r)}`, id(c, r), id(c, r + 1)));
      }
    }
  }
  for (let k = 0; k < links; k += 1) {
    const [c, r] = [next(columns), next(rows)];
    const [c2, r2] = [Math.min(columns - 1, c + 1 + next(4)), Math.min(rows - 1, r + 1 + next(3))];
    if (c2 !== c || r2 !== r) edges.push(line(`far-${k}`, id(c, r), id(c2, r2)));
  }
  return { nodes, edges };
}

describe('tidyRoutes: how much work it does', () => {
  it('routes a diagram of over 200 branches within its steps', () => {
    const { nodes, edges } = mesh(12, 10, 70);
    const branches = edges.filter((edge) => edge.type !== 'stub');
    expect(nodes.filter((node) => node.type === 'bus')).toHaveLength(120);
    expect(branches.length).toBeGreaterThan(200);
    const { routes, unrouted, steps } = tidyRoutes(nodes, edges);
    // The steps are what bounds the work, on any machine, and this diagram
    // takes all it is given: routed until nothing could be bettered it
    // takes several times as many. No time is held here, since a time says
    // how fast the machine is: the steps are about a second on one core of
    // a laptop, and 5 to 7 s on a CI runner, where coverage makes the
    // search four to five times slower. The timeout below is the guard
    // against a step that has come to cost many times what it did.
    expect(steps).toBeGreaterThanOrEqual(TIDY_STEPS);
    expect(steps).toBeLessThanOrEqual(TIDY_STEPS + 20_000);
    expect(unrouted).toEqual([]);
    expect(routes.size).toBe(branches.length);
    expect(meetings(routes).shared).toEqual([]);
  }, 60_000);

  it('stops when the steps it is given run out, and says so', () => {
    const { nodes, edges } = mesh(8, 6, 30);
    const branches = edges.filter((edge) => edge.type !== 'stub').length;
    const few = tidyRoutes(nodes, edges, { steps: 2_000 });
    // Past twice the steps nothing more is routed.
    expect(few.steps).toBeLessThanOrEqual(2 * 2_000 + 20_000);
    expect(few.routes.size + few.unrouted.length).toBe(branches);
    expect(few.unrouted.length).toBeGreaterThan(0);
    expect(few.outOfSteps).toBe(true);
    // With enough of them none is left for want of steps.
    const enough = tidyRoutes(nodes, edges);
    expect(enough.outOfSteps).toBeUndefined();
    expect(enough.routes.size).toBeGreaterThan(few.routes.size);
  });

  it('answers the same routes for the same diagram when the steps run out as well', () => {
    const { nodes, edges } = mesh(8, 6, 30);
    const first = tidyRoutes(nodes, edges, { steps: 30_000 });
    const second = tidyRoutes(nodes, edges, { steps: 30_000 });
    expect([...second.routes]).toEqual([...first.routes]);
    expect(second.steps).toBe(first.steps);
  });

  it('routes a diagram that has a bus standing far off without a grid over the room in between', () => {
    // Half a million pixels of nothing between bus 3 and the rest: a grid
    // over all of it would have a billion points.
    const nodes = [bus('1', 0, 0), bus('2', 0, 160), bus('3', -500_000, -300_000)];
    const edges = [line('near', '1', '2'), line('far', '1', '3')];
    const started = performance.now();
    const { routes, unrouted, tooLarge } = tidyRoutes(nodes, edges);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(tooLarge).toBeUndefined();
    expect(unrouted).toEqual([]);
    expect(routes.get('near')).toHaveLength(2);
    const far = routes.get('far')!;
    expect(far[far.length - 1]![1]).toBe(-299_997);
    for (const [a, b] of runsOf(far)) expect(a[0] === b[0] || a[1] === b[1]).toBe(true);
  });

  it('does not route a diagram that is too large for any grid, and says so', () => {
    // A hundred and fifty buses down a diagonal, each far from the next.
    const nodes = Array.from({ length: 150 }, (_, i) => bus(`b${i}`, i * 2_500, i * 2_500));
    const edges = nodes.slice(1).map((node, i) => line(`l${i}`, `b${i}`, node.id));
    const started = performance.now();
    const result = tidyRoutes(nodes, edges);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(result.tooLarge).toBe(true);
    expect(result.routes.size).toBe(0);
    expect(result.unrouted).toHaveLength(149);
  });
});

/** The drawing of `topology` with no saved layout, before and after Tidy diagram. */
async function drawings(topology: TopologySummary) {
  const { coords, bendPoints } = await autoLayout(topology);
  const { nodes, edges } = buildGraph(topology, coords, { bendPoints });
  const graphEdges = edges as ConnectionEdge[];
  const before = layoutConnections(nodes, graphEdges);
  const tidy = tidyRoutes(nodes, graphEdges);
  const after = layoutConnections(nodes, tidied(nodes, graphEdges, tidy.routes));
  const branchRoutes = (drawn: typeof before): Map<string, Point[]> =>
    new Map(
      graphEdges
        .filter((edge) => edge.type !== 'stub')
        .map((edge) => [edge.id, drawn.routes.get(edge.id)!.points]),
    );
  const boxOf = (id: string): Rect => {
    const node = nodes.find((n) => n.id === id)!;
    const bar = after.bars.get(id);
    return {
      left: node.position.x + (bar?.start ?? 0),
      right: node.position.x + (bar?.end ?? node.initialWidth!),
      top: node.position.y,
      bottom: node.position.y + (bar ? 6 : node.initialHeight!),
    };
  };
  const problems: string[] = [];
  for (const edge of graphEdges) {
    if (edge.type === 'stub') continue;
    const points = after.routes.get(edge.id)!.points;
    const runs = runsOf(points);
    runs.forEach(([a, b], i) => {
      if (a[0] !== b[0] && a[1] !== b[1]) problems.push(`${edge.id} runs at an angle`);
      const inner = i > 0 && i < runs.length - 1;
      if (inner && Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < 12) {
        problems.push(`${edge.id} has a kink`);
      }
      for (const node of nodes) {
        if (node.id === edge.source || node.id === edge.target) continue;
        const apart = distance(a, b, boxOf(node.id));
        const needed = node.type === 'bus' ? SLIDE_CLEARANCE : DEVICE_CLEARANCE;
        if (apart < needed) problems.push(`${edge.id} is ${apart} from ${node.id}`);
      }
    });
  }
  return {
    tidy,
    before: meetings(branchRoutes(before)),
    after: meetings(branchRoutes(after)),
    moved: [...tidy.routes].filter(
      ([id, points]) => JSON.stringify(after.routes.get(id)!.points) !== JSON.stringify(points),
    ),
    branches: graphEdges.filter((edge) => edge.type !== 'stub').length,
    problems,
  };
}

describe('tidyRoutes: the example cases, drawn along the routes ELK makes', () => {
  for (const [name, topology] of [
    ['IEEE 14', IEEE14],
    ['WSCC 9', WSCC9],
    ['Kundur', KUNDUR],
  ] as const) {
    it(`routes every branch of ${name} clear of the others and of what stands there`, async () => {
      const drawn = await drawings(topology);
      expect(drawn.tidy.unrouted).toEqual([]);
      expect(drawn.tidy.routes.size).toBe(drawn.branches);
      // What Tidy answers is what the connection pass draws: no tap is moved.
      expect(drawn.moved).toEqual([]);
      expect(drawn.problems).toEqual([]);
      expect(drawn.after.shared).toEqual([]);
      expect(drawn.after.crossings).toBeLessThanOrEqual(drawn.before.crossings);
    });
  }

  it('parts the lines of IEEE 14 that ELK runs down one corridor', async () => {
    // ELK runs every branch of one side of a bus through one point, and
    // several of them down one corridor: drawn along its routes, lines of
    // one bus lie on top of each other.
    const drawn = await drawings(IEEE14);
    expect(drawn.before.shared.length).toBeGreaterThan(0);
    expect(drawn.after.shared).toEqual([]);
    expect(drawn.after.crossings).toBeLessThanOrEqual(drawn.before.crossings);
  });
});

describe('alignToGrid', () => {
  it('brings every bus onto the grid', () => {
    expect(alignToGrid({ a: { x: 13, y: 250 }, b: { x: 221, y: 7 } })).toEqual({
      a: { x: 16, y: 256 },
      b: { x: 224, y: 0 },
    });
  });

  it('brings buses that are nearly level onto one line, and nearly in a column into one', () => {
    const out = alignToGrid({
      a: { x: 0, y: 100 },
      b: { x: 200, y: 100 + ALIGN_TOLERANCE },
      c: { x: 5, y: 400 },
    });
    expect(out.a!.y).toBe(out.b!.y);
    expect(out.a!.x).toBe(out.c!.x);
    // Further apart than that, each goes to its own line.
    const apart = alignToGrid({ a: { x: 0, y: 100 }, b: { x: 200, y: 100 + 2 * GRID_STEP } });
    expect(apart.a!.y).not.toBe(apart.b!.y);
  });

  it('parts two buses that come to stand on top of each other', () => {
    const out = alignToGrid({ a: { x: 100, y: 100 }, b: { x: 110, y: 104 } });
    expect(out.a).toEqual({ x: 112, y: 96 });
    // A bar and a step of the grid further right, on the grid.
    expect(out.b!.y).toBe(96);
    expect(out.b!.x - out.a!.x).toBeGreaterThanOrEqual(92 + GRID_STEP);
    expect(out.b!.x % GRID_STEP).toBe(0);
  });

  it('leaves a bus that is on the grid, and alone on its lines, where it is', () => {
    const coords = { a: { x: 160, y: 320 }, b: { x: 480, y: 640 } };
    expect(alignToGrid(coords)).toEqual(coords);
  });
});
