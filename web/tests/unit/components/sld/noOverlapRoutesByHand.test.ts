/**
 * Nothing on the diagram is drawn over anything else after a line was moved
 * by hand, on the three example cases: wherever a run of any line,
 * transformer or device connector is slid and let go, the line comes to
 * stand where it is on nothing (`settleEdit` with `routeChecker`), the
 * canvas keeps it (`routesDrawClear`), and the picture the diagram then
 * gives is held to the overlap checker, with and without the values of a
 * power flow. The same after a tidy of such a diagram, which leaves the
 * routes that were drawn by hand as they are, and after a bus that has one
 * is dragged.
 *
 * A line that is let go also reads as one line: it is held to what a hand
 * route must be like by itself (`shapeFaults`: no fold and no run that
 * doubles back, no step too short to read, a connector that leaves its own
 * symbol) and to the room it keeps to the symbols it passes
 * (`HAND_CLEARANCE`). It ends on its own tap and reads as ending there: the
 * routes that were found drawn along their bar, over the dot of the end
 * beside their own, or folded into a spike off the corner of their symbol
 * are refused where they were let by, and no bend that is moved alone or
 * taken out leaves one like them. No bend of it is let go on another line
 * or right beside one either (`HAND_BEND_CLEARANCE`), where the corner would
 * read as the two lines meeting: the two routes that were found drawn that
 * way come to stand clear of the line beside them, and a layout that was
 * saved with one has that line routed again around the bend.
 *
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK
 * engine run in-thread, as in `noOverlap.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { TopologySummary } from '@/api/types';
import {
  lengthInside,
  BAR_LENGTH,
  BAR_THICKNESS,
  BEND_CLEAR,
  distanceToRun,
  meetsBarFlat,
  onOwnSymbol,
  routeFolds,
  type ConnectionEdge,
  type Point,
  type Rect,
} from '@/components/sld/connections';
import {
  HAND_BEND_CLEARANCE,
  HAND_CLEARANCE,
  HAND_TAP_CLEARANCE,
  routeChecker,
} from '@/components/sld/routeCheck';
import {
  leavesKink,
  removeBend,
  routeEndsOf,
  sameRoute,
  settleEdit,
  tidyPoints,
} from '@/components/sld/routeEdit';
import {
  bothWays,
  dragged,
  drawn,
  opened,
  overlapsOf,
  routedByHand,
  routesByHand,
  settled,
  tidied,
  type Diagram,
} from '../../helpers/diagramStates';
import { CASE118 } from '../../helpers/case118';
import { IEEE14, KUNDUR, WSCC9 } from '../../helpers/exampleCases';

vi.mock('@/components/sld/elkClient', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { elkLayout: vi.fn((graph: ElkNode) => elk.layout(graph)) };
});

const CASES = [
  ['IEEE 14', IEEE14],
  ['Kundur', KUNDUR],
  ['WSCC 9', WSCC9],
] as const satisfies readonly (readonly [string, TopologySummary])[];

/** How far a run is slid, across itself: within the grid, and well past the line beside it. */
const SLIDES = [-40, -16, 16, 40];

/**
 * Where the run `run` of the edge `id` of `diagram` comes to stand when it
 * is slid by `by` and let go, as the editor of the canvas settles it: the
 * route, or `null` where no place near is clear.
 */
function slid(diagram: Diagram, id: string, run: number, by: number): Point[] | null {
  const picture = drawn(diagram);
  const edge = (diagram.edges as ConnectionEdge[]).find((e) => e.id === id)!;
  const route = picture.connections.routes.get(id)!.points;
  const at = new Map(diagram.nodes.map((n) => [n.id, n.position]));
  const ends = routeEndsOf(edge, route, at, picture.connections.bars);
  const check = routeChecker(diagram.nodes, picture, edge, { values: false });
  return settleEdit(route, { kind: 'run', index: run }, [by, by], ends, check)?.points ?? null;
}

/** The box of each generator, load and shunt of `diagram`, by node id. */
function symbolBoxes(diagram: Diagram): Map<string, Rect> {
  const boxes = new Map<string, Rect>();
  for (const node of diagram.nodes) {
    if (node.type !== 'generator' && node.type !== 'load' && node.type !== 'shunt') continue;
    const { x, y } = node.position;
    boxes.set(node.id, {
      left: x,
      right: x + (node.initialWidth ?? 0),
      top: y,
      bottom: y + (node.initialHeight ?? 0),
    });
  }
  return boxes;
}

/** Whether a route through `points` comes within `room` of `box`. */
function near(points: readonly Point[], box: Rect, room: number): boolean {
  const reach: Rect = {
    left: box.left - room + 0.5,
    right: box.right + room - 0.5,
    top: box.top - room + 0.5,
    bottom: box.bottom + room - 0.5,
  };
  return points.some((p, k) => k > 0 && lengthInside(points[k - 1]!, p, reach) > 0);
}

/** How far the place `at` is from the route `points`, where the route is nearest to it. */
function offRoute(points: readonly Point[], at: Point): number {
  return Math.min(...points.slice(1).map((b, k) => distanceToRun(at, points[k]!, b)));
}

/**
 * How near the bends of the route `points` come to the route `other`, or the
 * bends of `other` to `points`, whichever is nearer: `Infinity` where
 * neither has a bend.
 */
function bendGap(points: readonly Point[], other: readonly Point[]): number {
  return Math.min(
    ...points.slice(1, -1).map((bend) => offRoute(other, bend)),
    ...other.slice(1, -1).map((bend) => offRoute(points, bend)),
  );
}

/** The routes `diagram` is drawn with, by edge id: worked out once for each diagram. */
const routesDrawn = new WeakMap<Diagram, ReadonlyMap<string, { points: Point[] }>>();
function routesOf(diagram: Diagram): ReadonlyMap<string, { points: Point[] }> {
  let routes = routesDrawn.get(diagram);
  if (routes === undefined) {
    routes = drawn(diagram).connections.routes;
    routesDrawn.set(diagram, routes);
  }
  return routes;
}

/**
 * What is wrong with the route `points`, which a move made of `route`, as a
 * line read by itself: nothing, for one the editor lets go of.
 */
function shapeFaults(
  diagram: Diagram,
  edge: ConnectionEdge,
  route: readonly Point[],
  points: readonly Point[],
): string[] {
  const faults: string[] = [];
  if (routeFolds(points)) faults.push('folds back on itself');
  if (leavesKink(route, points)) faults.push('has a step too short to read');
  const boxes = symbolBoxes(diagram);
  const own = edge.type === 'stub' ? boxes.get(edge.source) : undefined;
  if (own !== undefined) {
    const how = onOwnSymbol(points, own);
    if (how !== null) faults.push(`is ${how} its own symbol`);
  }
  for (const [id, box] of boxes) {
    if (id === edge.source) continue;
    // Where it passed nearer than that already, it may stay as near.
    if (near(points, box, HAND_CLEARANCE) && !near(route, box, HAND_CLEARANCE)) {
      faults.push(`passes nearer than ${HAND_CLEARANCE} to ${id}`);
    }
  }
  // No bend of it on another line or right beside one, and none of another
  // line beside it: nearer than it was before the move, that is.
  for (const [id, other] of routesOf(diagram)) {
    if (id === edge.id) continue;
    const gap = bendGap(points, other.points);
    if (gap < HAND_BEND_CLEARANCE - 0.5 && gap < bendGap(route, other.points) - 0.5) {
      faults.push(`has a bend ${gap.toFixed(1)} from ${id}, or passes one of its bends that near`);
    }
  }
  return faults;
}

describe.each(CASES)('nothing overlaps on %s after a line is moved by hand', (_name, topology) => {
  it('wherever a run of any line or connector is slid and let go', async () => {
    const diagram = await opened(topology);
    const routes = drawn(diagram).connections.routes;
    const found: string[] = [];
    let kept = 0;
    let refused = 0;
    for (const edge of diagram.edges) {
      const route = routes.get(edge.id)!.points;
      for (let run = 0; run + 1 < route.length; run += 1) {
        for (const by of SLIDES) {
          const points = slid(diagram, edge.id, run, by);
          if (points === null || sameRoute(points, route)) continue;
          const moved = routedByHand(diagram, edge.id, points);
          if (moved === null) {
            // The picture found fault with what the check of the move let by.
            refused += 1;
            continue;
          }
          kept += 1;
          const where = `${edge.id}, run ${run} by ${by}`;
          // Drawn where it was put, and the user's.
          const hand = routesByHand(moved).get(edge.id);
          if (hand === undefined || !sameRoute(hand, points)) {
            found.push(`${where}: not drawn where it was put`);
          }
          found.push(...bothWays(moved).map((text) => `${where}: ${text}`));
          found.push(
            ...shapeFaults(diagram, edge as ConnectionEdge, route, points).map(
              (text) => `${where}: ${text}`,
            ),
          );
        }
      }
    }
    expect(found).toEqual([]);
    // Most moves find a place: the rule does not hold by refusing them all.
    expect(kept).toBeGreaterThan(diagram.edges.length);
    expect(refused).toBe(0);
  }, 240_000);

  it('whatever a second and a third move make of a connector that was moved', async () => {
    const opening = await opened(topology);
    const found: string[] = [];
    let kept = 0;
    /** Every slide of every run of the edge `id` of `diagram`: each kept one checked, and handed on. */
    const slides = (diagram: Diagram, id: string, moves: number, said: string): void => {
      const edge = (diagram.edges as ConnectionEdge[]).find((e) => e.id === id)!;
      const route = drawn(diagram).connections.routes.get(id)!.points;
      for (let run = 0; run + 1 < route.length; run += 1) {
        for (const by of SLIDES) {
          const points = slid(diagram, id, run, by);
          if (points === null || sameRoute(points, route)) continue;
          const moved = routedByHand(diagram, id, points);
          if (moved === null) continue;
          kept += 1;
          const where = `${said}, then run ${run} by ${by}`;
          found.push(...overlapsOf(moved).map((text) => `${where}: ${text}`));
          found.push(...shapeFaults(diagram, edge, route, points).map((t) => `${where}: ${t}`));
          if (moves > 1) slides(moved, id, moves - 1, where);
        }
      }
    };
    for (const edge of opening.edges.filter((e) => e.type === 'stub'))
      slides(opening, edge.id, 3, edge.id);
    expect(found).toEqual([]);
    expect(kept).toBeGreaterThan(0);
  }, 240_000);

  it('where a bend is pulled out of a line towards the symbol nearest to it', async () => {
    const diagram = await opened(topology);
    const picture = drawn(diagram);
    const boxes = [...symbolBoxes(diagram)];
    const at = new Map(diagram.nodes.map((n) => [n.id, n.position]));
    const found: string[] = [];
    let kept = 0;
    for (const edge of diagram.edges as ConnectionEdge[]) {
      const route = picture.connections.routes.get(edge.id)!.points;
      // Out of the middle of its longest run.
      let run = 0;
      for (let k = 1; k + 1 < route.length; k += 1) {
        const length = (i: number): number =>
          Math.hypot(route[i + 1]![0] - route[i]![0], route[i + 1]![1] - route[i]![1]);
        if (length(k) > length(run)) run = k;
      }
      const from: Point = [
        (route[run]![0] + route[run + 1]![0]) / 2,
        (route[run]![1] + route[run + 1]![1]) / 2,
      ];
      const middle = ([, box]: (typeof boxes)[number]): Point => [
        (box.left + box.right) / 2,
        (box.top + box.bottom) / 2,
      ];
      const nearest = boxes
        .filter(([id]) => id !== edge.source)
        .map(middle)
        .sort(
          (p, q) =>
            Math.hypot(p[0] - from[0], p[1] - from[1]) - Math.hypot(q[0] - from[0], q[1] - from[1]),
        )[0];
      if (nearest === undefined) continue;
      const ends = routeEndsOf(edge, route, at, picture.connections.bars);
      const check = routeChecker(diagram.nodes, picture, edge, { values: false });
      // Onto the symbol itself, and half way to it.
      for (const part of [1, 0.5]) {
        const by: [number, number] = [
          Math.round((nearest[0] - from[0]) * part),
          Math.round((nearest[1] - from[1]) * part),
        ];
        const settled = settleEdit(route, { kind: 'pull', index: run, at: from }, by, ends, check);
        if (settled === null || sameRoute(settled.points, route)) continue;
        const where = `${edge.id}, a bend pulled by ${by[0]}, ${by[1]}`;
        found.push(
          ...shapeFaults(diagram, edge, route, settled.points).map((t) => `${where}: ${t}`),
        );
        const moved = routedByHand(diagram, edge.id, settled.points);
        if (moved === null) continue;
        kept += 1;
        found.push(...overlapsOf(moved).map((text) => `${where}: ${text}`));
      }
    }
    expect(found).toEqual([]);
    expect(kept).toBeGreaterThan(0);
  }, 240_000);

  it('after a tidy, which leaves the routes drawn by hand as they are', async () => {
    let diagram = await opened(topology);
    // A run of every third branch, moved to the first place that is clear.
    const branches = diagram.edges.filter((edge) => edge.type !== 'stub');
    const moved: string[] = [];
    for (const edge of branches.filter((_, i) => i % 3 === 0)) {
      const route = drawn(diagram).connections.routes.get(edge.id)!.points;
      for (const by of SLIDES) {
        const run = Math.floor((route.length - 1) / 2);
        const points = slid(diagram, edge.id, run, by);
        const next =
          points === null || sameRoute(points, route)
            ? null
            : routedByHand(diagram, edge.id, points);
        if (next === null) continue;
        diagram = next;
        moved.push(edge.id);
        break;
      }
    }
    expect(moved.length).toBeGreaterThan(0);
    const before = routesByHand(diagram);
    expect([...before.keys()].sort()).toEqual([...moved].sort());

    const tidy = tidied(diagram, false);
    expect(bothWays(tidy)).toEqual([]);
    const after = routesByHand(tidy);
    for (const [id, points] of before) {
      expect(after.get(id), `${id} after a tidy`).toEqual(points);
    }

    // A re-layout moves the buses: a route goes along with them, or is
    // routed with the rest where it no longer fits. Nothing overlaps either way.
    const laidOut = tidied(diagram, true);
    expect(bothWays(laidOut)).toEqual([]);
    for (const id of routesByHand(laidOut).keys()) expect(moved).toContain(id);
  }, 240_000);

  it('after a bus that has a route drawn by hand is dragged', async () => {
    const diagram = await opened(topology);
    const found: string[] = [];
    let followed = 0;
    for (const edge of diagram.edges.filter((e) => e.type !== 'stub').slice(0, 6)) {
      const route = drawn(diagram).connections.routes.get(edge.id)!.points;
      const points = SLIDES.map((by) =>
        slid(diagram, edge.id, Math.floor((route.length - 1) / 2), by),
      ).find((candidate) => candidate !== null && !sameRoute(candidate, route));
      const byHand = points ? routedByHand(diagram, edge.id, points) : null;
      if (byHand === null) continue;
      for (const [dx, dy] of [
        [16, 0],
        [-32, 16],
        [0, -48],
        [96, 64],
      ] as const) {
        const after = dragged(byHand, edge.target, dx, dy);
        if (routesByHand(after).has(edge.id)) followed += 1;
        found.push(
          ...bothWays(after).map(
            (text) => `${edge.id}, bus ${edge.target} by ${dx}, ${dy}: ${text}`,
          ),
        );
      }
    }
    expect(found).toEqual([]);
    // Some of the moves leave the route its shape: it is brought along, not always given up.
    expect(followed).toBeGreaterThan(0);
  }, 240_000);
});

/** A check of the routes the edge `id` of `diagram` could be given, as the editor of the canvas asks it. */
function checkOf(diagram: Diagram, id: string) {
  const picture = drawn(diagram);
  const edge = (diagram.edges as ConnectionEdge[]).find((e) => e.id === id)!;
  const route = picture.connections.routes.get(id)!.points;
  const at = new Map(diagram.nodes.map((n) => [n.id, n.position]));
  return {
    edge,
    route,
    ends: routeEndsOf(edge, route, at, picture.connections.bars),
    check: routeChecker(diagram.nodes, picture, edge, { values: false }),
  };
}

/** `diagram` with the connector `id` slid `by` along its bar and kept, as a drag of its one run does. */
function connectorSlid(diagram: Diagram, id: string, by: number): Diagram {
  const { route } = checkOf(diagram, id);
  expect(route, `${id} drops square onto its bar`).toHaveLength(2);
  const points = slid(diagram, id, 0, by);
  expect(points, `${id} slid by ${by}`).toHaveLength(4);
  const moved = routedByHand(diagram, id, points!);
  expect(moved, `${id} slid by ${by} is kept`).not.toBeNull();
  return moved!;
}

/**
 * What is wrong with how the route `points` of `edge` ends on the bar of
 * its bus on `diagram`, read by itself: nothing, for one that comes to its
 * own tap and keeps off the dots of the ends beside it.
 */
function endFaults(diagram: Diagram, edge: ConnectionEdge, points: readonly Point[]): string[] {
  const { connections } = drawn(diagram);
  const faults: string[] = [];
  const last = points.length - 1;
  const ends: [string, Point, Point][] = [[edge.target, points[last]!, points[last - 1]!]];
  if (edge.type !== 'stub') ends.push([edge.source, points[0]!, points[1]!]);
  for (const [bus, tap, outer] of ends) {
    const origin = diagram.nodes.find((n) => n.id === bus)!.position;
    const bar = connections.bars.get(bus);
    const flat =
      Math.abs(tap[1] - outer[1]) > 0.5 &&
      meetsBarFlat(outer, tap, {
        left: origin.x + (bar?.start ?? 0),
        right: origin.x + (bar?.end ?? BAR_LENGTH),
        y: origin.y + BAR_THICKNESS / 2,
      });
    if (flat) faults.push(`comes to the bar of ${bus} too flat`);
  }
  // The dots of the ends of the other lines, on any bar.
  const buses = new Set(diagram.nodes.filter((n) => (n.type ?? 'bus') === 'bus').map((n) => n.id));
  for (const other of diagram.edges as ConnectionEdge[]) {
    const route = other.id === edge.id ? undefined : connections.routes.get(other.id)?.points;
    if (route === undefined) continue;
    const dots: Point[] = [route[route.length - 1]!];
    if (buses.has(other.source)) dots.push(route[0]!);
    for (const dot of dots) {
      const off = Math.min(
        ...points.slice(1).map((b, k) => {
          const a = points[k]!;
          const [ux, uy] = [b[0] - a[0], b[1] - a[1]];
          const t = Math.min(
            1,
            Math.max(0, ((dot[0] - a[0]) * ux + (dot[1] - a[1]) * uy) / (ux * ux + uy * uy)),
          );
          return Math.hypot(a[0] + t * ux - dot[0], a[1] + t * uy - dot[1]);
        }),
      );
      if (off < HAND_TAP_CLEARANCE - 0.5) {
        faults.push(`passes ${off.toFixed(1)} from the end of ${other.id}`);
      }
    }
  }
  return faults;
}

describe('a line moved by hand ends on its own tap, and leaves its symbol by the face', () => {
  it('IEEE 14: the connector of PQ_3 is not left along its bar when a bend is taken out', async () => {
    // Slid 96 along the bar of bus 4 it steps down to its tap. Without the
    // second bend it would run from under its symbol straight to that tap,
    // at 12 degrees: over the dot of the line that leaves the bar beside it,
    // and along the bar from there.
    const diagram = connectorSlid(await opened(IEEE14), 'stub-load-PQ_3', 96);
    const { route, check } = checkOf(diagram, 'stub-load-PQ_3');
    const without = tidyPoints(removeBend(route, 2)!);
    expect(without).toHaveLength(3);
    expect(check(without)).toMatch(/run over the end of|run along the bar of bus/);
    // The first bend out as well: one run from the symbol to the tap, flatter still.
    expect(check(tidyPoints(removeBend(without, 1)!))).not.toBeNull();
  }, 240_000);

  it('IEEE 14: the connector of PQ_3 is not folded into a spike off the corner of its symbol', async () => {
    const diagram = connectorSlid(await opened(IEEE14), 'stub-load-PQ_3', 96);
    const { route, check } = checkOf(diagram, 'stub-load-PQ_3');
    const [from, tap] = [route[0]!, route[route.length - 1]!];
    // Out of the bottom of the symbol to the left, a few pixels under its
    // edge, and back under the whole symbol to the tap.
    const hairpin: Point[] = [from, [from[0] - 29, from[1] + 8], tap];
    expect(check(hairpin)).toMatch(/along the edge of its own symbol|fold back on itself/);
    // Clear of the symbol, the same turn is still a line that doubles back.
    const spike: Point[] = [from, [from[0], from[1] + 16], [from[0] - 60, from[1] + 30], tap];
    expect(check(spike)).toBe('it would fold back on itself');
  }, 240_000);

  it('Kundur: the connector of PQ_1 is not left under its bar, across the ends of the lines there', async () => {
    const diagram = await opened(KUNDUR);
    const { edge, route, check } = checkOf(diagram, 'stub-load-PQ_1');
    const [from, tap] = [route[0]!, route[route.length - 1]!];
    // Its tap is the last of its bar, and the lines of the bus end to the
    // left of it. From well to that side, a few pixels off the bar, the last
    // run lies along the bar, across the dots of those ends.
    const side = from[1] < tap[1] ? -1 : 1;
    const grazing: Point[] = [from, [tap[0] - 72, tap[1] + side * 11], tap];
    expect(check(grazing)).toMatch(/run over the end of|run along the bar of bus/);
    expect(endFaults(diagram, edge, grazing)).not.toEqual([]);
  }, 240_000);

  it('WSCC 9: the connector of PQ_0 is not left on the dot of the line that ends beside it', async () => {
    const diagram = await opened(WSCC9);
    const { edge, route, check } = checkOf(diagram, 'stub-load-PQ_0');
    const [from, tap] = [route[0]!, route[route.length - 1]!];
    const side = from[1] < tap[1] ? -1 : 1;
    for (const dx of [-32, 32]) {
      const grazing: Point[] = [from, [tap[0] + dx, tap[1] + side * 11], tap];
      expect(check(grazing), `from ${dx} to the side`).not.toBeNull();
      expect(endFaults(diagram, edge, grazing)).not.toEqual([]);
    }
  }, 240_000);

  it.each(CASES)(
    '%s: no bend of a connector that is moved alone or taken out leaves it along its bar, on a dot or folded',
    async (_name, topology) => {
      const opening = await opened(topology);
      const found: string[] = [];
      let kept = 0;
      let refused = 0;
      /** `points`, which a move made of `route`, kept by the canvas and held to every rule. */
      const hold = (
        diagram: Diagram,
        edge: ConnectionEdge,
        route: readonly Point[],
        points: readonly Point[],
        where: string,
      ): void => {
        const moved = routedByHand(diagram, edge.id, points);
        if (moved === null) return;
        kept += 1;
        found.push(...overlapsOf(moved).map((text) => `${where}: ${text}`));
        found.push(...shapeFaults(diagram, edge, route, points).map((t) => `${where}: ${t}`));
        found.push(...endFaults(diagram, edge, points).map((t) => `${where}: ${t}`));
      };
      for (const stub of opening.edges.filter((e) => e.type === 'stub')) {
        for (const by of [-96, -48, 48, 96]) {
          const stepped = slid(opening, stub.id, 0, by);
          if (stepped === null || stepped.length !== 4) continue;
          const diagram = routedByHand(opening, stub.id, stepped);
          if (diagram === null) continue;
          const { edge, route, ends, check } = checkOf(diagram, stub.id);
          const tap = route[route.length - 1]!;
          for (const bend of [1, 2]) {
            // Taken out, as a double-click on it does: kept only where the check lets it by.
            const without = tidyPoints(removeBend(route, bend)!);
            const where = `${stub.id} slid by ${by}, bend ${bend}`;
            if (check(without) === null) hold(diagram, edge, route, without, `${where} taken out`);
            else refused += 1;
            // Moved alone, as a drag with Shift held does: to beside the tap,
            // a few pixels off the bar, and onto the symbol it left.
            const p = route[bend]!;
            const targets: Point[] = [
              [tap[0] - 72, tap[1] - 11],
              [tap[0] + 72, tap[1] - 11],
              [tap[0] - 32, tap[1] - 11],
              [tap[0] + 32, tap[1] + 11],
              [route[0]![0] - 29, route[0]![1] + 8],
              [route[0]![0] + 29, route[0]![1] - 8],
              [route[0]![0], route[0]![1] - 20],
            ];
            for (const to of targets) {
              const settled = settleEdit(
                route,
                { kind: 'bend', index: bend },
                [to[0] - p[0], to[1] - p[1]],
                ends,
                check,
                { free: true },
              );
              if (settled === null || sameRoute(settled.points, route)) continue;
              hold(diagram, edge, route, settled.points, `${where} moved to ${to[0]}, ${to[1]}`);
            }
          }
        }
      }
      expect(found).toEqual([]);
      // Bends are moved, and the ones that would leave the line on its bar are not taken out.
      expect(kept).toBeGreaterThan(0);
      expect(refused).toBeGreaterThan(0);
    },
    240_000,
  );
});

/**
 * `diagram` as a layout that was saved with the route of the edge `id`
 * drawn by hand through `points` opens: the route is the user's whatever it
 * is on, and the diagram draws the rest around it.
 */
function savedByHand(diagram: Diagram, id: string, points: readonly Point[]): Diagram {
  const at = new Map(diagram.nodes.map((n) => [n.id, n.position]));
  const edges = diagram.edges.map((edge) =>
    edge.id !== id
      ? edge
      : {
          ...edge,
          data: {
            ...edge.data,
            bendPoints: points.map(([x, y]): [number, number] => [x, y]),
            bendAnchors: {
              source: { ...at.get(edge.source)! },
              target: { ...at.get(edge.target)! },
            },
            bendManual: true,
          },
        },
  );
  return settled({ ...diagram, edges });
}

describe('a bend of a line moved by hand keeps off the lines beside it', () => {
  it('WSCC 9: a bend pulled out of Line_8 is not put on Line_3, short of it or just past it', async () => {
    const diagram = await opened(WSCC9);
    const { edge, route, ends, check } = checkOf(diagram, 'line-Line_8');
    const beside = routesOf(diagram).get('line-Line_3')!.points;
    // Both drop square from the bar of one bus to the next, side by side.
    expect(route).toHaveLength(2);
    expect(beside).toHaveLength(2);
    expect(beside[0]![0]).toBe(beside[1]![0]);
    const x = beside[0]![0];
    const middle = Math.round((route[0]![1] + route[1]![1]) / 2);
    const pointed = (to: number): Point[] => [route[0]!, [to, middle], route[1]!];
    // The point of the `<` two short of the other line, and one past it: a `K`.
    expect(check(pointed(x + 2))).toBe('a bend of it would be too close to line Line_3');
    expect(check(pointed(x - 1))).toBe('a bend of it would be too close to line Line_3');
    expect(check(pointed(x + HAND_BEND_CLEARANCE))).toBeNull();

    // Pulled there by its handle, as a drag of the + beside the run does,
    // it comes to stand as far short of the line as two lines side by side keep.
    const handle: Point = [route[0]![0] + 13, middle];
    const pulled = settleEdit(
      route,
      { kind: 'pull', index: 0, at: handle },
      [x + 2 - handle[0], 0],
      ends,
      check,
    )!;
    expect(pulled.refused).toBe('a bend of it would be too close to line Line_3');
    expect(pulled.points).toEqual(pointed(x + HAND_BEND_CLEARANCE));
    const kept = routedByHand(diagram, edge.id, pulled.points)!;
    expect(kept).not.toBeNull();
    expect(bothWays(kept)).toEqual([]);
    // The line beside it stays where it was: it did not have to give way.
    expect(routesOf(kept).get('line-Line_3')!.points).toEqual(beside);

    // The bend moved alone to one past the line, as a drag with Shift held
    // does: it goes on to where both its runs cross the line clear of it.
    const again = checkOf(kept, edge.id);
    const from = again.route[1]!;
    const moved = settleEdit(
      again.route,
      { kind: 'bend', index: 1 },
      [x - 1 - from[0], 0],
      again.ends,
      again.check,
      { free: true },
    )!;
    expect(moved.refused).toBe('a bend of it would be too close to line Line_3');
    expect(bendGap(moved.points, beside)).toBeGreaterThanOrEqual(HAND_BEND_CLEARANCE - 0.5);
    const crossed = routedByHand(kept, edge.id, moved.points)!;
    expect(crossed).not.toBeNull();
    expect(bothWays(crossed)).toEqual([]);
  }, 240_000);

  it('Kundur: a bend of the connector of PQ_1 is not put on the lines it is dragged across', async () => {
    const diagram = await opened(KUNDUR);
    const { edge, route, ends, check } = checkOf(diagram, 'stub-load-PQ_1');
    expect(route).toHaveLength(2);
    const [from, tap] = [route[0]!, route[1]!];
    // The lines that end on the bar to the left of its tap, each square to it.
    const lines = ['line-Line_7', 'line-Line_8'].map((id) => routesOf(diagram).get(id)!.points);
    for (const points of lines) expect(points[0]![0]).toBeLessThan(tap[0]);
    // A bend pulled out a little way to the left, then dragged on alone
    // across both lines towards the far end of the bar.
    const handle: Point = [from[0] + 13, (from[1] + tap[1]) / 2];
    const first = settleEdit(
      route,
      { kind: 'pull', index: 0, at: handle },
      [from[0] - 14 - handle[0], from[1] - 18 - handle[1]],
      ends,
      check,
    )!;
    expect(first.points).toHaveLength(3);
    let held = routedByHand(diagram, edge.id, first.points)!;
    expect(held).not.toBeNull();
    const start = checkOf(held, edge.id);
    const bend = start.route[1]!;
    const to: Point = [lines[0]![0]![0] - 24, tap[1] + 11];
    let last: Point[] = start.route;
    let stopped = 0;
    for (let k = 1; k <= 12; k += 1) {
      const by: [number, number] = [
        Math.round(((to[0] - bend[0]) * k) / 12),
        Math.round(((to[1] - bend[1]) * k) / 12),
      ];
      const move = settleEdit(
        start.route,
        { kind: 'bend', index: 1 },
        by,
        start.ends,
        start.check,
        {
          free: true,
        },
      );
      if (move === null) continue;
      if (move.refused !== null) stopped += 1;
      last = move.points;
      for (const points of lines) {
        expect(bendGap(move.points, points), `move ${k}`).toBeGreaterThanOrEqual(
          HAND_BEND_CLEARANCE - 0.5,
        );
      }
    }
    // It was stopped short of the lines, and stands where the last clear place was.
    expect(stopped).toBeGreaterThan(0);
    held = routedByHand(held, edge.id, last)!;
    expect(held).not.toBeNull();
    expect(bothWays(held)).toEqual([]);
    expect(shapeFaults(diagram, edge, route, last)).toEqual([]);
  }, 240_000);

  it.each([
    ['WSCC 9', WSCC9, 'line-Line_8', 'line-Line_3', 2],
    ['WSCC 9', WSCC9, 'line-Line_8', 'line-Line_3', -1],
    ['Kundur', KUNDUR, 'stub-load-PQ_1', 'line-Line_7', 2],
  ] as const)(
    '%s: a layout saved with a bend of %s on %s has that line routed again around the bend (%i beside it)',
    async (_name, topology, id, besideId, off) => {
      const diagram = await opened(topology);
      const route = routesOf(diagram).get(id)!.points;
      const beside = routesOf(diagram).get(besideId)!.points;
      const [first, last] = [route[0]!, route[route.length - 1]!];
      // Half way along the line beside it, as the two were found.
      const bend: Point = [
        beside[0]![0] + off,
        Math.round((Math.max(first[1], beside[0]![1]) + Math.min(last[1], beside[1]![1])) / 2),
      ];
      const y = [first[1], last[1]].sort((p, q) => p - q);
      if (bend[1] <= y[0]! || bend[1] >= y[1]!) bend[1] = Math.round((first[1] + last[1]) / 2);
      const saved = savedByHand(diagram, id, [first, bend, last]);
      // The route is the user's still, drawn as it was saved.
      expect(routesByHand(saved).get(id)).toEqual([first, bend, last]);
      // The line it was drawn on has gone round the bend, and nothing is on anything.
      expect(bothWays(saved)).toEqual([]);
      const routed = routesOf(saved).get(besideId)!.points;
      expect(offRoute(routed, bend)).toBeGreaterThanOrEqual(BEND_CLEAR - 0.5);
    },
    240_000,
  );
});

describe('nothing overlaps on a case of a hundred buses after a line is moved by hand', () => {
  it('IEEE 118: wherever the middle run of a line is slid and let go, checked as fast as a drag needs', async () => {
    const diagram = await opened(CASE118);
    const routes = drawn(diagram).connections.routes;
    const found: string[] = [];
    let kept = 0;
    // Every twelfth branch, and a device connector with them.
    const sample = diagram.edges.filter((_, i) => i % 12 === 0);
    for (const edge of sample) {
      const route = routes.get(edge.id)!.points;
      const run = Math.floor((route.length - 1) / 2);
      for (const by of SLIDES) {
        const points = slid(diagram, edge.id, run, by);
        if (points === null || sameRoute(points, route)) continue;
        const moved = routedByHand(diagram, edge.id, points);
        if (moved === null) continue;
        kept += 1;
        found.push(...bothWays(moved).map((text) => `${edge.id}, run ${run} by ${by}: ${text}`));
        break;
      }
    }
    expect(found).toEqual([]);
    expect(kept).toBeGreaterThan(sample.length / 2);

    // One check of a route, which a drag asks many times with every move of
    // the pointer, looks only at what is near the line.
    const picture = drawn(diagram);
    const edge = (diagram.edges as ConnectionEdge[]).find((e) => e.type !== 'stub')!;
    const check = routeChecker(diagram.nodes, picture, edge, { values: false });
    const route = picture.connections.routes.get(edge.id)!.points;
    const started = performance.now();
    for (let i = 0; i < 200; i += 1) check(route);
    expect((performance.now() - started) / 200).toBeLessThan(5);
  }, 240_000);
});
