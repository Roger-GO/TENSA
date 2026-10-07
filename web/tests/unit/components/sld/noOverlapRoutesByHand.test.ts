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
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK
 * engine run in-thread, as in `noOverlap.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { TopologySummary } from '@/api/types';
import type { ConnectionEdge, Point } from '@/components/sld/connections';
import { routeChecker } from '@/components/sld/routeCheck';
import { routeEndsOf, sameRoute, settleEdit } from '@/components/sld/routeEdit';
import {
  bothWays,
  dragged,
  drawn,
  opened,
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
        }
      }
    }
    expect(found).toEqual([]);
    // Most moves find a place: the rule does not hold by refusing them all.
    expect(kept).toBeGreaterThan(diagram.edges.length);
    expect(refused).toBe(0);
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
