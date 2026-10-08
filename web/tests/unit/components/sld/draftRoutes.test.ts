/**
 * The routes the lines take round the drafts (`draftRoutes.ts`): a line that
 * gives way to a draft keeps the route it had, and the way round the draft
 * is held apart from it, for the drafts as they stand. What is held is kept
 * with the drafts, and a diagram that is opened again is drawn from it.
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
  draftRoutesFrom,
  draftRoutesKept,
  draftsStand,
  settleDraftRoutes,
  systemOf,
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

describe('what is kept with the drafts of a diagram at rest', () => {
  /** IEEE 14 with a draft on two of its lines and a draft line from bus 12 to bus 14, at rest. */
  async function atRestWithDrafts() {
    const first = settled(await opened(IEEE14));
    const five = first.nodes.find((n) => n.id === '5')!.position;
    const there = withDrafts(first, [
      load(five.x + 6, five.y - 112),
      { id: 'draft-2', kind: 'Line', position: { x: 0, y: 0 }, values: { bus1: '12', bus2: '14' } },
    ]);
    const options = optionsOf(there);
    const made = settleDraftRoutes(
      there.nodes,
      edgesOf(there),
      drawn(there),
      NO_DRAFT_ROUTES,
      options,
    );
    // As the canvas keeps them: the line of the draft on the route it was given.
    const edges = edgesOf(there).map((edge) => {
      const route = made.changed.get(edge.id);
      return route === undefined
        ? edge
        : { ...edge, data: { ...edge.data, bendPoints: route.points, bendAnchors: route.anchors } };
    });
    return { first, there, edges, held: made.routes, options };
  }

  it('is the ways round them and the route of each draft line, and a diagram opened again is drawn from them to the same picture', async () => {
    const { there, edges, held, options } = await atRestWithDrafts();
    const stand = draftsStand(there.nodes, edges);
    const before = pictureOf(there.nodes, withDraftRoutes(edges, held, stand), options);
    const kept = draftRoutesKept(edges, held, stand)!;
    const line = draftBranchEdgeId('draft-2');
    expect(kept.stand).toBe(stand);
    expect(Object.keys(kept.own)).toEqual([line]);
    expect(kept.own[line]!.points).toEqual(before.connections.routes.get(line)!.points);
    expect(Object.keys(kept.round).sort()).toEqual([...held.routes.keys()].sort());
    for (const [id, way] of Object.entries(kept.round)) {
      expect(way).toEqual(held.routes.get(id));
    }
    // Through the storage, as text, and back onto the edges of the case as
    // it is opened again: the lines of the system on the routes the layout
    // holds, the line of the draft on the one that was kept for it.
    const read = JSON.parse(JSON.stringify(kept)) as typeof kept;
    const opened = edgesOf(there).map((edge) => {
      const own = read.own[edge.id];
      return own === undefined
        ? edge
        : { ...edge, data: { ...edge.data, bendPoints: own.points, bendAnchors: own.anchors } };
    });
    const again = pictureOf(
      there.nodes,
      withDraftRoutes(opened, draftRoutesFrom(read), draftsStand(there.nodes, opened)),
      options,
    );
    // Nothing is searched for, and every line runs as it ran.
    expect(again.changed.size).toBe(0);
    for (const edge of edges) {
      expect(again.connections.routes.get(edge.id)?.points).toEqual(
        before.connections.routes.get(edge.id)?.points,
      );
    }
  });

  it('holds only the ways that are in place: not one made for a route the line no longer keeps', async () => {
    const { there, edges, held } = await atRestWithDrafts();
    const stand = draftsStand(there.nodes, edges);
    const [id] = [...held.routes.keys()];
    const rerouted = edges.map((edge) =>
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
    const kept = draftRoutesKept(rerouted, held, stand)!;
    expect(kept.round[id!]).toBeUndefined();
    expect(Object.keys(kept.round)).toHaveLength(held.routes.size - 1);
    // Nor any for drafts that stand somewhere else than the ways were made for.
    expect(Object.keys(draftRoutesKept(edges, held, `${stand};moved`)!.round)).toEqual([]);
  });

  it('is nothing for a diagram without a draft, or with drafts no line runs another way for', async () => {
    const first = settled(await opened(IEEE14));
    expect(draftRoutesKept(edgesOf(first), NO_DRAFT_ROUTES, '')).toBeNull();
    const xs = first.nodes.map((n) => n.position.x);
    const aside = withDrafts(first, [load(Math.min(...xs) - 300, 0)]);
    const stand = draftsStand(aside.nodes, edgesOf(aside));
    expect(draftRoutesKept(edgesOf(aside), NO_DRAFT_ROUTES, stand)).toBeNull();
    // And nothing kept is no way to hold.
    expect(draftRoutesFrom(undefined)).toBe(NO_DRAFT_ROUTES);
    expect(draftRoutesFrom({ stand, own: {}, round: {} })).toBe(NO_DRAFT_ROUTES);
  });
});

describe('the name a system is kept under', () => {
  it('is the same for the same elements between the same buses, whatever their values', () => {
    const again = {
      ...IEEE14,
      state: 'committed' as const,
      buses: IEEE14.buses.map((bus) => ({ ...bus, name: `${bus.name}!`, params: { Vn: 1 } })),
    };
    expect(systemOf(again)).toBe(systemOf(IEEE14));
    expect(systemOf(IEEE14)).toMatch(/^b14-l\d+-[0-9a-z]+$/);
  });

  it('is another for another system, and for the same one with an element moved, added or taken away', () => {
    const names = new Set([
      systemOf(IEEE14),
      systemOf({ ...IEEE14, buses: IEEE14.buses.slice(0, -1) }),
      systemOf({ ...IEEE14, lines: IEEE14.lines.slice(1) }),
      systemOf({
        ...IEEE14,
        loads: IEEE14.loads.map((entry, i) =>
          i === 0 ? { ...entry, params: { ...entry.params, bus: 1 } } : entry,
        ),
      }),
      systemOf({
        ...IEEE14,
        generators: [
          ...IEEE14.generators,
          { idx: 'G9', name: 'G9', kind: 'PV', params: { bus: 9 } },
        ],
      }),
    ]);
    expect(names.size).toBe(5);
  });
});
