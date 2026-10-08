/**
 * The sweeps that hold a diagram with drafts on it to the no-overlap rule:
 * a draft is an element that was placed on the diagram and is not in the
 * system yet (`store/drafts.ts`), and it is drawn among everything else, so
 * nothing of it may be on anything, and nothing on it.
 *
 * Each state is made the way the canvas makes it: a draft is dropped by
 * `draftPlace`, drawn by `draftGraph`, brought clear by `connectedPlace`
 * when it is given a bus from its form, dragged like a device, and tidied
 * with the rest. One file per example case calls `holdDrafts`.
 */
import { describe, expect, it } from 'vitest';
import type { ParamValue, TopologySummary } from '@/api/types';
import type { ConnectionEdge } from '@/components/sld/connections';
import { connectedPlace, draftPlace, settledPlaces } from '@/components/sld/draftPlace';
import { DRAFT_NODE_SIZE, DRAFT_NODE_TYPE, draftGraph } from '@/components/sld/drafts';
import { countCrossings } from '@/components/sld/overlapCheck';
import { drawnDiagram } from '@/components/sld/picture';
import type { DraftElement } from '@/store/drafts';
import {
  bothWays,
  dragged,
  drawn,
  opened,
  overlapsOf,
  settled,
  tidied,
  type Diagram,
} from './diagramStates';
import { TOPOLOGY_SCHEMA } from './topologySchema';

/** `diagram` without its drafts. */
function withoutDrafts(diagram: Diagram): Diagram {
  return {
    ...diagram,
    nodes: diagram.nodes.filter((n) => n.type !== DRAFT_NODE_TYPE),
    edges: diagram.edges.filter((e) => (e.data as { draft?: boolean } | undefined)?.draft !== true),
  };
}

/** `diagram` with `drafts` drawn on it, as the canvas adds them to the graph of the case. */
export function withDrafts(diagram: Diagram, drafts: readonly DraftElement[]): Diagram {
  const plain = withoutDrafts(diagram);
  const busPositions = new Map(
    plain.nodes.filter((n) => n.type === 'bus').map((n) => [n.id, n.position]),
  );
  const graph = draftGraph(drafts, {
    schema: TOPOLOGY_SCHEMA,
    topology: diagram.topology,
    busPositions,
  });
  return {
    ...plain,
    nodes: [...plain.nodes, ...graph.nodes],
    edges: [...plain.edges, ...graph.edges],
  };
}

/**
 * Where a draft dropped with the pointer at `centre` comes to stand on
 * `diagram`. `pictures` is how many places the picture is asked about, where
 * that is not as many as the canvas asks about on a small diagram.
 */
export function dropPlace(diagram: Diagram, centre: { x: number; y: number }, pictures?: number) {
  const { connections } = drawn(diagram);
  return draftPlace(diagram.nodes, diagram.edges as ConnectionEdge[], centre, connections, {
    atRest: connections,
    picture: { barLengths: diagram.barLengths, values: false },
    pictures,
  }).position;
}

/**
 * `diagram` with a draft of `kind` dropped at `centre` and then given
 * `values` in its form: where it was dropped, or where the canvas brings it
 * when its connector has no clear way from there (`connectedPlace`). `moved`
 * says which.
 */
export function drafted(
  diagram: Diagram,
  kind: string,
  centre: { x: number; y: number },
  values: Record<string, ParamValue> = {},
  id = 'draft-1',
  pictures?: number,
): { diagram: Diagram; draft: DraftElement; moved: boolean } {
  let draft: DraftElement = { id, kind, position: dropPlace(diagram, centre, pictures), values };
  let there = withDrafts(diagram, [...draftsOn(diagram), draft]);
  const { connections } = drawn(there);
  const place = connectedPlace(there.nodes, there.edges as ConnectionEdge[], id, connections, {
    atRest: connections,
    picture: { barLengths: diagram.barLengths, values: false },
    given: true,
    pictures,
  });
  if (place !== null) {
    draft = { ...draft, position: place.position };
    there = withDrafts(diagram, [...draftsOn(diagram), draft]);
  }
  return { diagram: settled(there), draft, moved: place !== null };
}

/** The drafts that stand on `diagram` as symbols, as the store would hold them. */
function draftsOn(diagram: Diagram): DraftElement[] {
  return diagram.nodes
    .filter((n) => n.type === DRAFT_NODE_TYPE)
    .map((n) => {
      const data = n.data as { kind: string; parentBus?: string };
      const values: DraftElement['values'] =
        data.parentBus === undefined ? {} : { bus: data.parentBus };
      return { id: n.id, kind: data.kind, position: { ...n.position }, values };
    });
}

/** How many other lines of `diagram` the connector `id` crosses. */
function connectorCrossings(diagram: Diagram, id: string): number {
  const { lines } = drawnDiagram(diagram.nodes, drawn(diagram), { values: false });
  const own = lines.find((line) => line.id === id);
  if (own === undefined) return 0;
  return lines.reduce((sum, line) => sum + (line === own ? 0 : countCrossings([own, line])), 0);
}

/** `diagram` with each draft that something stands on moved to where it is clear (`settledPlaces`). */
function resettled(diagram: Diagram): Diagram {
  const ids = diagram.nodes.filter((n) => n.type === DRAFT_NODE_TYPE).map((n) => n.id);
  const moves = settledPlaces(
    diagram.nodes,
    diagram.edges as ConnectionEdge[],
    ids,
    drawn(diagram).connections,
  );
  if (moves.size === 0) return diagram;
  const nodes = diagram.nodes.map((n) => {
    const to = moves.get(n.id);
    return to === undefined ? n : { ...n, position: to };
  });
  return settled({ ...diagram, nodes });
}

/** The box the buses and devices of `diagram` stand in. */
function extent(diagram: Diagram) {
  const xs = diagram.nodes.map((n) => n.position.x);
  const ys = diagram.nodes.map((n) => n.position.y);
  return {
    left: Math.min(...xs),
    right: Math.max(...xs) + 92,
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}

/** How a draft is moved once it stands: to each side of where it was dropped, and far. */
const DRAFT_MOVES: readonly (readonly [number, number])[] = [
  [0, -120],
  [0, 110],
  [-150, 0],
  [160, 10],
  [-260, 140],
  [240, -180],
];

/** The sweeps, for the example case `name` whose topology is `topology`. */
export function holdDrafts(name: string, topology: TopologySummary): void {
  describe(`nothing overlaps on ${name} with drafts on it`, () => {
    it('wherever a draft is dropped: on free ground, on a bar, on a symbol, on a line', async () => {
      const first = settled(await opened(topology));
      const { left, right, top, bottom } = extent(first);
      const found: string[] = [];
      let shifted = 0;
      const STEPS = 6;
      for (let i = 0; i <= STEPS; i += 1) {
        for (let k = 0; k <= STEPS; k += 1) {
          const centre = {
            x: left - 120 + ((right - left + 240) * i) / STEPS,
            y: top - 80 + ((bottom - top + 160) * k) / STEPS,
          };
          const { diagram, draft } = drafted(first, 'PV', centre);
          const where = `dropped at ${Math.round(centre.x)}, ${Math.round(centre.y)}`;
          if (
            Math.abs(draft.position.x + DRAFT_NODE_SIZE.width / 2 - centre.x) > 0.5 ||
            Math.abs(draft.position.y + DRAFT_NODE_SIZE.height / 2 - centre.y) > 0.5
          ) {
            shifted += 1;
          }
          found.push(...drawn(diagram).unrouted.map((id) => `${where}: no route for ${id}`));
          found.push(...bothWays(diagram).map((text) => `${where}: ${text}`));
        }
      }
      expect(found).toEqual([]);
      // Some of the places are taken: a draft dropped there stands beside them.
      expect(shifted).toBeGreaterThan(0);
    }, 240_000);

    it('when a draft is given any bus from its form, from near that bus and from far', async () => {
      const first = settled(await opened(topology));
      const { left, right, top, bottom } = extent(first);
      const far = [
        { x: left - 150, y: (top + bottom) / 2 },
        { x: right + 150, y: top + 60 },
      ];
      const found: string[] = [];
      let brought = 0;
      let crossing = 0;
      let asked = 0;
      for (const bus of first.nodes.filter((n) => n.type === 'bus')) {
        const near = { x: bus.position.x + 46, y: bus.position.y - 90 };
        for (const centre of [near, ...far]) {
          const made = drafted(first, 'PQ', centre, { bus: bus.id });
          asked += 1;
          if (made.moved) brought += 1;
          const where = `bus ${bus.id} from ${Math.round(centre.x)}, ${Math.round(centre.y)}`;
          // It is connected: by a connector of its own, to that bus.
          const stub = made.diagram.edges.find((e) => e.id === 'stub-draft-1');
          if (stub?.target !== bus.id) found.push(`${where}: not connected`);
          found.push(...overlapsOf(made.diagram).map((text) => `${where}: ${text}`));
          crossing += connectorCrossings(made.diagram, 'stub-draft-1') > 0 ? 1 : 0;
        }
      }
      expect(found).toEqual([]);
      // From far, the connector of some has no clear way, and that of most
      // crosses other lines: those are brought to their bus.
      expect(brought).toBeGreaterThan(0);
      // A connector that still crosses a line is the exception: a bus with
      // no room beside it that a connector reaches without one.
      expect(crossing).toBeLessThanOrEqual(asked / 10);
    }, 240_000);

    it('when a draft line or transformer names two buses that have no branch between them', async () => {
      const first = settled(await opened(topology));
      const buses = first.nodes.filter((n) => n.type === 'bus').map((n) => n.id);
      const joined = new Set(
        first.edges
          .filter((e) => e.type !== 'stub')
          .flatMap((e) => [`${e.source}|${e.target}`, `${e.target}|${e.source}`]),
      );
      const found: string[] = [];
      let tried = 0;
      for (let i = 0; i < buses.length && tried < 12; i += 1) {
        for (let k = i + 2; k < buses.length && tried < 12; k += 3) {
          const [from, to] = [buses[i]!, buses[k]!];
          if (joined.has(`${from}|${to}`)) continue;
          tried += 1;
          const kind = tried % 2 === 0 ? 'Transformer2W' : 'Line';
          const { diagram } = drafted(first, kind, { x: 0, y: 0 }, { bus1: from, bus2: to });
          const what = `${kind} ${from} to ${to}`;
          // It is drawn as the branch it will be, and not as a symbol.
          if (diagram.nodes.some((n) => n.type === DRAFT_NODE_TYPE))
            found.push(`${what}: a symbol`);
          found.push(...drawn(diagram).unrouted.map((id) => `${what}: no route for ${id}`));
          found.push(...bothWays(diagram).map((text) => `${what}: ${text}`));
          found.push(
            ...overlapsOf(tidied(diagram, false)).map((text) => `${what}, tidied: ${text}`),
          );
        }
      }
      expect(tried).toBeGreaterThan(0);
      expect(found).toEqual([]);
    }, 240_000);

    it('after a connected draft is dragged and dropped, and after a tidy with drafts on the diagram', async () => {
      const first = settled(await opened(topology));
      const { left, top, bottom } = extent(first);
      const buses = first.nodes.filter((n) => n.type === 'bus');
      const found: string[] = [];
      for (const bus of [buses[0]!, buses[Math.floor(buses.length / 2)]!, buses.at(-1)!]) {
        const start = drafted(
          first,
          'PQ',
          { x: bus.position.x + 46, y: bus.position.y - 90 },
          { bus: bus.id },
        );
        // A second draft that is connected to nothing stands beside the diagram.
        const both = drafted(
          start.diagram,
          'Bus',
          { x: left - 140, y: (top + bottom) / 2 },
          {},
          'draft-2',
        );
        for (const [dx, dy] of DRAFT_MOVES) {
          const what = `draft on bus ${bus.id} by ${dx}, ${dy}`;
          const dropped = dragged(both.diagram, 'draft-1', dx, dy);
          found.push(...bothWays(dropped).map((text) => `${what}: ${text}`));
          for (const relayout of [false, true]) {
            const after = resettled(tidied(dropped, relayout));
            found.push(
              ...overlapsOf(after).map(
                (text) => `${what}, ${relayout ? 'laid out again' : 'tidied'}: ${text}`,
              ),
            );
          }
        }
      }
      expect(found).toEqual([]);
    }, 240_000);
  });
}
