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
 * route must be like by itself (`shapeFaults`: no fold, no step too short to
 * read, a connector that leaves its own symbol) and to the room it keeps to
 * the symbols it passes (`HAND_CLEARANCE`).
 *
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK
 * engine run in-thread, as in `noOverlap.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { TopologySummary } from '@/api/types';
import {
  lengthInside,
  onOwnSymbol,
  routeFolds,
  type ConnectionEdge,
  type Point,
  type Rect,
} from '@/components/sld/connections';
import { HAND_CLEARANCE, routeChecker } from '@/components/sld/routeCheck';
import { leavesKink, routeEndsOf, sameRoute, settleEdit } from '@/components/sld/routeEdit';
import {
  bothWays,
  dragged,
  drawn,
  opened,
  overlapsOf,
  routedByHand,
  routesByHand,
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
