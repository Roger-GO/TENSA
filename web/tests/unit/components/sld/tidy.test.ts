/**
 * Tidy diagram (`tidy.ts`): the routes it gives the branches of a diagram,
 * with the buses and the devices where they are, and the grid it brings the
 * buses onto for Tidy and re-layout.
 *
 * A bus node at `(x, y)` is drawn as a bar from `x` to `x + 92` whose centre
 * line is at `y + 3`. The first tests are small diagrams built by hand, one
 * rule each. The last ones are the three example cases as the automatic
 * layout draws them, where the rules are held on the whole drawing: that is
 * where the routes the automatic layout makes share corridors, which is
 * what Tidy diagram is for.
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
  SLIDE_CLEARANCE,
  TAP_SPACING,
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

  it('joins two buses that stand level end to end', () => {
    const nodes = [bus('1', 0, 0), bus('2', 200, 0)];
    const { routes } = tidyRoutes(nodes, [line('l', '1', '2')]);
    // From the middle of one rounded tip to the middle of the other.
    expect(routes.get('l')).toEqual([
      [89, 3],
      [203, 3],
    ]);
  });

  it('is routed from its source to its target, whichever stands first', () => {
    const nodes = [bus('1', 0, 0), bus('2', 200, 0)];
    const { routes } = tidyRoutes(nodes, [line('l', '2', '1')]);
    expect(routes.get('l')).toEqual([
      [203, 3],
      [89, 3],
    ]);
  });

  it('turns once to reach a bus that stands below and to the side', () => {
    const nodes = [bus('1', 0, 0), bus('2', 240, 160)];
    const points = tidyRoutes(nodes, [line('l', '1', '2')]).routes.get('l')!;
    expect(bendsOf(points)).toBe(1);
    // Out of an end of one bar and onto a face of the other.
    const level = runsOf(points).find(([a, b]) => a[1] === b[1])!;
    expect([3, 163]).toContain(level[0][1]);
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
    expect(bendsOf(points)).toBeGreaterThan(0);
  });

  it('keeps off what stands on the diagram and is no node', () => {
    const nodes = [bus('1', 0, 0), bus('2', 0, 240)];
    const chain: Rect = { left: 10, right: 80, top: 90, bottom: 150 };
    const points = tidyRoutes(nodes, [line('l', '1', '2')], { obstacles: [chain] }).routes.get(
      'l',
    )!;
    for (const [a, b] of runsOf(points)) expect(distance(a, b, chain)).toBeGreaterThan(0);
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

  it('lands a branch on the dot of a device on the other face, or a spacing clear of it', () => {
    // A generator over the bar of bus 1, and a branch that leaves under it.
    const nodes = [bus('1', 0, 100), bus('2', 0, 300), device('generator-g', 12, 30, 'generator')];
    const edges = [stub('generator-g', '1'), line('l', '1', '2')];
    const { routes } = tidyRoutes(nodes, edges);
    const tap = routes.get('l')![0]![0];
    const deviceTap = layoutConnections(nodes, edges).routes.get('stub-generator-g')!.points[1]![0];
    const apart = Math.abs(tap - deviceTap);
    expect(apart === 0 || apart >= TAP_SPACING).toBe(true);
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
    expect(routes.get('across')).toHaveLength(2);
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
  it('routes a diagram of over 200 branches within its steps, in about a second', () => {
    const { nodes, edges } = mesh(12, 10, 70);
    const branches = edges.filter((edge) => edge.type !== 'stub');
    expect(nodes.filter((node) => node.type === 'bus')).toHaveLength(120);
    expect(branches.length).toBeGreaterThan(200);
    const started = performance.now();
    const { routes, unrouted, steps } = tidyRoutes(nodes, edges);
    const took = performance.now() - started;
    // The steps are what bounds the work, on any machine, and this diagram
    // takes all it is given: routed until nothing could be bettered it
    // takes several times as many. The time is about a second; the bound
    // here is loose enough for a slow machine that is doing other things.
    expect(steps).toBeGreaterThanOrEqual(TIDY_STEPS);
    expect(steps).toBeLessThanOrEqual(TIDY_STEPS + 20_000);
    expect(took).toBeLessThan(20_000);
    expect(unrouted).toEqual([]);
    expect(routes.size).toBe(branches.length);
    expect(meetings(routes).shared).toEqual([]);
  });

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

describe('tidyRoutes: the example cases, drawn by the automatic layout', () => {
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

  it('parts the lines of IEEE 14 that the automatic layout runs down one corridor', async () => {
    // The automatic layout runs every branch of one side of a bus through
    // one point: lines 4 and 5 leave bus 2 on top of each other, and lines 8
    // and 10 leave bus 6 the same way.
    const drawn = await drawings(IEEE14);
    expect(drawn.before.shared).toContain('line-Line_4 and line-Line_5');
    expect(drawn.before.shared).toContain('line-Line_8 and line-Line_10');
    expect(drawn.after.shared).toEqual([]);
    // And no line of it crosses another once tidied.
    expect(drawn.after.crossings).toBe(0);
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
