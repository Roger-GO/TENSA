/**
 * The routes the lines take round the drafts (`draftRoutes.ts`): a line that
 * gives way to a draft keeps the route it had, and the way round the draft
 * is held apart from it, for the drafts as they stand.
 *
 * The canvas is held to the same in `SldCanvasDrafts.test.tsx`, and the
 * example cases whole in `noOverlapDrafts*.test.ts`.
 *
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK
 * engine run in-thread, as in `layout.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { ConnectionEdge } from '@/components/sld/connections';
import {
  NO_DRAFT_ROUTES,
  draftsStand,
  settleDraftRoutes,
  withDraftRoutes,
} from '@/components/sld/draftRoutes';
import { draftBranchEdgeId } from '@/components/sld/drafts';
import { pictureOf } from '@/components/sld/picture';
import type { DraftElement } from '@/store/drafts';
import { IEEE14 } from '../../helpers/exampleCases';
import { drawn, opened, overlapsOf, settled, type Diagram } from '../../helpers/diagramStates';
import { withDrafts } from '../../helpers/draftSweeps';

vi.mock('@/components/sld/elkClient', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { elkLayout: vi.fn((graph: ElkNode) => elk.layout(graph)) };
});

const edgesOf = (diagram: Diagram) => diagram.edges as ConnectionEdge[];
const optionsOf = (diagram: Diagram) => ({ barLengths: diagram.barLengths, values: false });
const routeOf = (diagram: Diagram, id: string) => drawn(diagram).connections.routes.get(id)?.points;

/** A load draft with nothing filled in, at `x`, `y`. */
function load(x: number, y: number, id = 'draft-1'): DraftElement {
  return { id, kind: 'PQ', position: { x, y }, values: {} };
}

/**
 * IEEE 14 as it opens, and with a draft right over the bar of bus 5, on the
 * lines that come down to it from buses 1 and 2: they have to go round.
 */
async function withDraftOnLines() {
  const first = settled(await opened(IEEE14));
  const five = first.nodes.find((n) => n.id === '5')!.position;
  const there = withDrafts(first, [load(five.x + 6, five.y - 112)]);
  return { first, there };
}

describe('where the drafts stand, as text', () => {
  it('is empty for a diagram without a draft', async () => {
    const first = settled(await opened(IEEE14));
    expect(draftsStand(first.nodes, edgesOf(first))).toBe('');
  });

  it('changes when a draft moves or is connected, and not when anything else moves', async () => {
    const first = settled(await opened(IEEE14));
    const stand = (diagram: Diagram) => draftsStand(diagram.nodes, edgesOf(diagram));
    const one = withDrafts(first, [load(-300, 0)]);
    expect(stand(one)).not.toBe('');
    expect(stand(withDrafts(first, [load(-300, 16)]))).not.toBe(stand(one));
    const wired = withDrafts(first, [{ ...load(-300, 0), values: { bus: '1' } }]);
    expect(stand(wired)).not.toBe(stand(one));
    // A bus that is moved leaves the drafts where they stand.
    const busMoved = {
      ...one,
      nodes: one.nodes.map((n) =>
        n.id === '14' ? { ...n, position: { x: n.position.x - 32, y: n.position.y } } : n,
      ),
    };
    expect(stand(busMoved)).toBe(stand(one));
  });
});

describe('a line that gives way to a draft', () => {
  it('keeps the route it had: the way round the draft is held apart from it', async () => {
    const { first, there } = await withDraftOnLines();
    const picture = drawn(there);
    // The draft stands on lines, which are drawn round it, over nothing.
    expect(picture.changed.size).toBeGreaterThan(0);
    expect(overlapsOf(there)).toEqual([]);
    const kept = settleDraftRoutes(
      there.nodes,
      edgesOf(there),
      picture,
      NO_DRAFT_ROUTES,
      optionsOf(there),
    );
    // Nothing of it is the diagram's to keep.
    expect(kept.changed.size).toBe(0);
    expect(kept.released).toEqual([]);
    expect([...kept.routes.routes.keys()].sort()).toEqual([...picture.changed.keys()].sort());
    for (const [id, route] of kept.routes.routes) {
      expect(route.points).toEqual(picture.changed.get(id)!.points);
      // In the place of the route the line keeps, which is the one it had.
      const had = first.edges.find((edge) => edge.id === id)!.data!.bendPoints;
      expect(route.from).toBe(JSON.stringify(had));
    }
  });

  it('is drawn along that way again with nothing searched for, while the draft stands there', async () => {
    const { there } = await withDraftOnLines();
    const picture = drawn(there);
    const options = optionsOf(there);
    const kept = settleDraftRoutes(there.nodes, edgesOf(there), picture, NO_DRAFT_ROUTES, options);
    const stand = draftsStand(there.nodes, edgesOf(there));
    const given = withDraftRoutes(edgesOf(there), kept.routes, stand);
    const again = pictureOf(there.nodes, given, options);
    expect(again.changed.size).toBe(0);
    for (const id of kept.routes.routes.keys()) {
      expect(again.connections.routes.get(id)!.points).toEqual(
        picture.connections.routes.get(id)!.points,
      );
    }
    // And what is held is held as it is: the same object, so nothing is set again.
    const settledAgain = settleDraftRoutes(
      there.nodes,
      edgesOf(there),
      again,
      kept.routes,
      options,
    );
    expect(settledAgain.changed.size).toBe(0);
    expect(settledAgain.routes).toBe(kept.routes);
  });

  it('is drawn as it was before once the draft is deleted or moved off it', async () => {
    const { first, there } = await withDraftOnLines();
    const kept = settleDraftRoutes(
      there.nodes,
      edgesOf(there),
      drawn(there),
      NO_DRAFT_ROUTES,
      optionsOf(there),
    ).routes;
    const ids = [...kept.routes.keys()];
    expect(ids.length).toBeGreaterThan(0);
    // Deleted: the edges are the ones the diagram keeps, untouched.
    expect(withDraftRoutes(edgesOf(first), kept, draftsStand(first.nodes, edgesOf(first)))).toBe(
      first.edges,
    );
    // Moved to free ground beside the diagram: drawn from the routes the
    // diagram keeps, and none of them has to be made afresh.
    const xs = first.nodes.map((n) => n.position.x);
    const away = withDrafts(first, [load(Math.min(...xs) - 300, 0)]);
    const stand = draftsStand(away.nodes, edgesOf(away));
    const given = withDraftRoutes(edgesOf(away), kept, stand);
    expect(given).toBe(away.edges);
    const picture = pictureOf(away.nodes, given, optionsOf(away));
    expect(picture.changed.size).toBe(0);
    for (const id of ids) {
      expect(picture.connections.routes.get(id)!.points).toEqual(routeOf(first, id));
    }
    // What is held then says so: nothing goes round a draft any more.
    const after = settleDraftRoutes(away.nodes, edgesOf(away), picture, kept, optionsOf(away));
    expect(after.routes.routes.size).toBe(0);
    expect(after.routes.stand).toBe(stand);
  });

  it('is drawn from the route it keeps when that is another one than it gave way from', async () => {
    const { there } = await withDraftOnLines();
    const kept = settleDraftRoutes(
      there.nodes,
      edgesOf(there),
      drawn(there),
      NO_DRAFT_ROUTES,
      optionsOf(there),
    ).routes;
    const [id] = [...kept.routes.keys()];
    // A tidy, a route drawn by hand: the diagram keeps another route for it.
    const rerouted = edgesOf(there).map((edge) =>
      edge.id === id
        ? {
            ...edge,
            data: {
              ...edge.data,
              bendPoints: [...(edge.data!.bendPoints as [number, number][])].reverse(),
            },
          }
        : edge,
    );
    const given = withDraftRoutes(rerouted, kept, draftsStand(there.nodes, rerouted));
    const at = (edges: readonly ConnectionEdge[]) => edges.find((edge) => edge.id === id)!;
    expect(at(given)).toBe(at(rerouted));
    // The others still go round the draft.
    for (const other of kept.routes.keys()) {
      if (other === id) continue;
      expect(given.find((edge) => edge.id === other)!.data!.bendPoints).toEqual(
        kept.routes.get(other)!.points,
      );
    }
  });
});

describe('what a diagram with drafts on it keeps of the routes its picture made', () => {
  it('is what it would keep without the drafts: a layout that brought no routes', async () => {
    const { first, there } = await withDraftOnLines();
    // The same diagram, opened from a layout that holds no route.
    const bare = (diagram: Diagram): Diagram => ({
      ...diagram,
      edges: diagram.edges.map((edge) =>
        edge.type === 'stub'
          ? edge
          : { ...edge, data: { ...edge.data, bendPoints: undefined, bendAnchors: undefined } },
      ),
    });
    const [plain, drafted] = [bare(first), bare(there)];
    const alone = drawn(plain);
    const picture = drawn(drafted);
    const options = optionsOf(drafted);
    const kept = settleDraftRoutes(
      drafted.nodes,
      edgesOf(drafted),
      picture,
      NO_DRAFT_ROUTES,
      options,
    );
    // Every route the diagram makes for itself, as it makes them alone.
    expect([...kept.changed.keys()].sort()).toEqual([...alone.changed.keys()].sort());
    for (const [id, route] of kept.changed) {
      expect(route.points).toEqual(alone.changed.get(id)!.points);
    }
    // The lines the draft stands on go round it, each in the place of the
    // route the diagram keeps for it from now on.
    expect(kept.routes.routes.size).toBeGreaterThan(0);
    for (const [id, route] of kept.routes.routes) {
      expect(route.points).toEqual(picture.connections.routes.get(id)!.points);
      expect(route.points).not.toEqual(alone.changed.get(id)!.points);
      expect(route.from).toBe(JSON.stringify(alone.changed.get(id)!.points));
    }
    // With both in place the next picture has nothing to make.
    const keeping = edgesOf(drafted).map((edge) => {
      const route = kept.changed.get(edge.id);
      return route === undefined
        ? edge
        : { ...edge, data: { ...edge.data, bendPoints: route.points, bendAnchors: route.anchors } };
    });
    const stand = draftsStand(drafted.nodes, keeping);
    const next = pictureOf(drafted.nodes, withDraftRoutes(keeping, kept.routes, stand), options);
    expect(next.changed.size).toBe(0);
    const settledNext = settleDraftRoutes(drafted.nodes, keeping, next, kept.routes, options);
    expect(settledNext.routes).toBe(kept.routes);
  });

  it('is the route of a draft that is drawn as a branch, which is the draft its own', async () => {
    const first = settled(await opened(IEEE14));
    const there = withDrafts(first, [
      { id: 'draft-1', kind: 'Line', position: { x: 0, y: 0 }, values: { bus1: '12', bus2: '14' } },
    ]);
    const picture = drawn(there);
    const id = draftBranchEdgeId('draft-1');
    expect(picture.changed.has(id)).toBe(true);
    const kept = settleDraftRoutes(
      there.nodes,
      edgesOf(there),
      picture,
      NO_DRAFT_ROUTES,
      optionsOf(there),
    );
    expect(kept.changed.get(id)).toEqual(picture.changed.get(id));
    // No line of the system is kept another way for it.
    expect([...kept.changed.keys()]).toEqual([id]);
  });

  it('is everything the picture made, on a diagram without a draft', async () => {
    const first = settled(await opened(IEEE14));
    const moved = {
      ...first,
      nodes: first.nodes.map((n) =>
        n.id === '14' ? { ...n, position: { x: n.position.x - 48, y: n.position.y + 32 } } : n,
      ),
    };
    const picture = drawn(moved);
    expect(picture.changed.size).toBeGreaterThan(0);
    const kept = settleDraftRoutes(
      moved.nodes,
      edgesOf(moved),
      picture,
      NO_DRAFT_ROUTES,
      optionsOf(moved),
    );
    expect(kept.changed).toBe(picture.changed);
    expect(kept.routes).toBe(NO_DRAFT_ROUTES);
  });
});
