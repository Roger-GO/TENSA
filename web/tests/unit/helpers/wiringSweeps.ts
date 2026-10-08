/**
 * The sweeps that hold a diagram to the no-overlap rule through what
 * connecting by a drag does to it (`wiring.ts`): a component dropped on a
 * bus, a draft dragged onto one, a line or a transformer drawn from one bus
 * to another, and a device of the system moved to another bus by the end of
 * its connector.
 *
 * Each state is made the way the canvas makes it. A draft that is given its
 * bus on the diagram is brought beside it like one that is given it in its
 * form (`connectedPlace`, with `given`), and so is a device of the system
 * once the topology has it on its new bus: the graph is built again from
 * that topology with every node where it stood, or with the device where
 * the diagram puts one it has no place for, which is what is left of a
 * saved layout that placed it by its old bus. One file per example case
 * calls `holdWiring`.
 */
import { describe, expect, it } from 'vitest';
import type { TopologyEntry, TopologySummary } from '@/api/types';
import type { ConnectionEdge } from '@/components/sld/connections';
import { CONNECTOR_REACH, SLANT_PUT_ON_BUS, connectedPlace } from '@/components/sld/draftPlace';
import { DRAFT_NODE_SIZE, DRAFT_NODE_TYPE } from '@/components/sld/drafts';
import { buildGraph } from '@/components/sld/graph';
import { symbolBoxes } from '@/components/sld/labels';
import { moveToBus } from '@/components/sld/wiring';
import {
  bothWays,
  drawn,
  opened,
  overlapsOf,
  settled,
  tidied,
  type Diagram,
} from './diagramStates';
import { atRest, drafted, draftsOn, draggedDraft, withDrafts } from './draftSweeps';
import { TOPOLOGY_SCHEMA } from './topologySchema';

/** The node types of the devices that hang off a bus by a connector. */
const DEVICES: ReadonlySet<string> = new Set(['generator', 'load', 'shunt']);

/**
 * `diagram` after the draft `id` was connected to the bus `bus` where it
 * stands: on that bus, and beside it where its connector would not be drawn
 * well from there, as the canvas brings one that is given its bus.
 */
export function connected(diagram: Diagram, id: string, bus: string): Diagram {
  let held = draftsOn(diagram).map((d) => (d.id === id ? { ...d, values: { bus } } : d));
  let there = withDrafts(diagram, held);
  const { connections, symbols } = drawn(there);
  const place = connectedPlace(there.nodes, there.edges as ConnectionEdge[], id, connections, {
    atRest: connections,
    picture: { barLengths: diagram.barLengths, values: false },
    given: true,
    slant: SLANT_PUT_ON_BUS,
    symbols: [...symbolBoxes(symbols).values()],
  });
  if (place !== null) {
    held = held.map((d) => (d.id === id ? { ...d, position: place.position } : d));
    there = withDrafts(diagram, held);
  }
  return atRest(there);
}

/**
 * `diagram` with a draft of `kind` dropped on the bus `bus`, with the
 * pointer at `centre`: placed where a drop puts it, and connected.
 */
export function droppedOn(
  diagram: Diagram,
  kind: string,
  centre: { x: number; y: number },
  bus: string,
): Diagram {
  return connected(drafted(diagram, kind, centre).diagram, 'draft-1', bus);
}

/** Whether the connector `id` of `diagram` runs straight and square: level or upright, with no bend. */
export function runsSquare(diagram: Diagram, id: string): boolean {
  const points = drawn(diagram).connections.routes.get(id)?.points ?? [];
  if (points.length !== 2) return false;
  const [a, b] = [points[0]!, points[1]!];
  return Math.abs(a[0] - b[0]) <= 0.5 || Math.abs(a[1] - b[1]) <= 0.5;
}

/** `topology` with the models `edits` names given the params they set. */
function edited(
  topology: TopologySummary,
  edits: readonly { model: string; idx: string; params: TopologyEntry['params'] }[],
): TopologySummary {
  const apply = (entries: readonly TopologyEntry[] | undefined): TopologyEntry[] =>
    (entries ?? []).map((entry) => {
      const edit = edits.find((e) => e.model === entry.kind && e.idx === String(entry.idx));
      return edit === undefined ? entry : { ...entry, params: { ...entry.params, ...edit.params } };
    });
  return {
    ...topology,
    generators: apply(topology.generators),
    loads: apply(topology.loads),
    shunts: apply(topology.shunts),
    controllers: apply(topology.controllers),
  };
}

/**
 * `diagram` after the device drawn as the node `nodeId` was moved to the
 * bus `bus`: the system has it there (`moveToBus`), the diagram is built
 * again from that, and the device is brought beside its bus where its
 * connector would not be drawn well from where it stands. With `kept` it
 * starts from where it stood, as after a drag of this visit; without, from
 * where the diagram puts a device it has no place for. `null` where the
 * move is refused.
 */
export function rehung(
  diagram: Diagram,
  nodeId: string,
  bus: string,
  kept: boolean,
): Diagram | null {
  const plan = moveToBus(diagram.topology, TOPOLOGY_SCHEMA, nodeId, bus);
  if ('refused' in plan) return null;
  const topology = edited(diagram.topology, plan.edits);
  const coords = Object.fromEntries(
    diagram.nodes.filter((n) => n.type === 'bus').map((n) => [n.id, { ...n.position }]),
  );
  const dragOverrides = Object.fromEntries(
    diagram.nodes
      .filter((n) => n.type !== 'bus' && (kept || n.id !== nodeId))
      .map((n) => [n.id, { ...n.position }]),
  );
  // The routes the diagram keeps, but for the connector of the device.
  const routes = diagram.edges.filter(
    (edge) => edge.id !== `stub-${nodeId}` && edge.data?.bendPoints !== undefined,
  );
  const built = buildGraph(topology, coords, {
    barLengths: diagram.barLengths,
    dragOverrides,
    bendPoints: new Map(routes.map((e) => [e.id, e.data!.bendPoints as [number, number][]])),
    bendAnchors: new Map(
      routes
        .filter((e) => e.data?.bendAnchors !== undefined)
        .map((e) => [
          e.id,
          e.data!.bendAnchors as Record<'source' | 'target', { x: number; y: number }>,
        ]),
    ),
    bendManual: new Set(routes.filter((e) => e.data?.bendManual === true).map((e) => e.id)),
  });
  let there: Diagram = { ...diagram, topology, nodes: built.nodes, edges: built.edges };
  const { connections, symbols } = drawn(there);
  const place = connectedPlace(there.nodes, there.edges as ConnectionEdge[], nodeId, connections, {
    atRest: connections,
    picture: { barLengths: diagram.barLengths, values: false },
    given: true,
    slant: SLANT_PUT_ON_BUS,
    symbols: [...symbolBoxes(symbols).values()],
  });
  if (place !== null) {
    there = {
      ...there,
      nodes: there.nodes.map((n) => (n.id === nodeId ? { ...n, position: place.position } : n)),
    };
  }
  return settled(there);
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

/** How long the route through `points` is. */
function lengthOf(points: readonly (readonly [number, number])[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i += 1) {
    length += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  }
  return length;
}

/**
 * The buses of `diagram` a device on `from` is moved to, `count` of them at
 * the most: its neighbours in the list, and ones further on.
 */
function otherBuses(diagram: Diagram, from: string, count: number): string[] {
  const buses = diagram.nodes.filter((n) => n.type === 'bus').map((n) => n.id);
  const at = buses.indexOf(from);
  const picked = new Set<string>();
  for (const step of [1, -1, Math.floor(buses.length / 2), Math.floor(buses.length / 3), 2, -2]) {
    const id = buses[(at + step + buses.length) % buses.length]!;
    if (id !== from) picked.add(id);
    if (picked.size === count) break;
  }
  return [...picked];
}

/** The sweeps, for the example case `name` whose topology is `topology`. */
export function holdWiring(name: string, topology: TopologySummary): void {
  describe(`nothing overlaps on ${name} through what is connected by a drag`, () => {
    it('when a component is dropped on the bar of any bus, at its middle and at either tip', async () => {
      const first = settled(await opened(topology));
      const found: string[] = [];
      let dropped = 0;
      let square = 0;
      for (const bus of first.nodes.filter((n) => n.type === 'bus')) {
        const bar = drawn(first).connections.bars.get(bus.id);
        const [left, right] = [
          bus.position.x + (bar?.start ?? 0),
          bus.position.x + (bar?.end ?? 92),
        ];
        for (const x of [left + 4, (left + right) / 2, right - 4]) {
          const made = droppedOn(first, 'PQ', { x, y: bus.position.y + 3 }, bus.id);
          dropped += 1;
          const where = `a load dropped on bus ${bus.id} at ${Math.round(x)}`;
          const stub = made.edges.find((e) => e.id === 'stub-draft-1');
          if (stub?.target !== bus.id) found.push(`${where}: not connected`);
          if (runsSquare(made, 'stub-draft-1')) square += 1;
          found.push(...drawn(made).unrouted.map((id) => `${where}: no route for ${id}`));
          found.push(...bothWays(made).map((text) => `${where}: ${text}`));
        }
      }
      expect(dropped).toBeGreaterThan(0);
      expect(found).toEqual([]);
      // It stands square to the bar it was dropped on wherever the row of
      // that bus has a place for it that is in no line's way: on most buses.
      expect(square).toBeGreaterThanOrEqual((3 * dropped) / 4);
    }, 240_000);

    it('when a draft is dragged onto the bar of any bus and connected there, and onto another after', async () => {
      const first = settled(await opened(topology));
      const { left, top, bottom } = extent(first);
      const start = drafted(first, 'Shunt', { x: left - 160, y: (top + bottom) / 2 });
      const from = start.draft.position;
      const buses = first.nodes.filter((n) => n.type === 'bus');
      const found: string[] = [];
      let before: Diagram | null = null;
      for (const bus of buses) {
        // Let go with its middle on the bar.
        const dropped = draggedDraft(
          start.diagram,
          'draft-1',
          bus.position.x + 46 - DRAFT_NODE_SIZE.width / 2 - from.x,
          bus.position.y + 3 - DRAFT_NODE_SIZE.height / 2 - from.y,
        );
        const on = connected(dropped, 'draft-1', bus.id);
        const what = `a draft dragged onto bus ${bus.id}`;
        const stub = on.edges.find((e) => e.id === 'stub-draft-1');
        if (stub?.target !== bus.id) found.push(`${what}: not connected`);
        found.push(...bothWays(on).map((text) => `${what}: ${text}`));
        // And from the bus before to this one, by the end of its connector:
        // it is given the bus where it stands.
        if (before !== null) {
          const moved = connected(before, 'draft-1', bus.id);
          found.push(
            ...overlapsOf(moved).map((text) => `${what}, from the bus before it: ${text}`),
          );
        }
        before = on;
      }
      expect(found).toEqual([]);
    }, 240_000);

    it('when a line or a transformer is drawn between two buses, beside a branch that joins them already as well', async () => {
      const first = settled(await opened(topology));
      const buses = first.nodes.filter((n) => n.type === 'bus').map((n) => n.id);
      const joined = first.edges.filter((e) => e.type !== 'stub');
      const pairs: [string, string][] = [];
      const seen = new Set<string>();
      const take = (from: string, to: string): void => {
        const key = [from, to].sort().join('|');
        if (from === to || seen.has(key)) return;
        seen.add(key);
        pairs.push([from, to]);
      };
      // A second circuit beside a branch of the system: a spread of them.
      const each = Math.max(1, Math.floor(joined.length / 6));
      for (let i = 0; i < joined.length; i += each) take(joined[i]!.source, joined[i]!.target);
      const beside = pairs.length;
      // And between buses no branch joins, near and far in the list.
      for (let i = 0; i < buses.length && pairs.length < beside + 6; i += 2) {
        take(buses[i]!, buses[(i + 3) % buses.length]!);
      }
      const found: string[] = [];
      for (const [k, [from, to]] of pairs.entries()) {
        const kind = k % 2 === 0 ? 'Line' : 'Transformer2W';
        const { diagram } = drafted(first, kind, { x: 0, y: 0 }, { bus1: from, bus2: to });
        const what = `${kind} drawn from ${from} to ${to}`;
        // Drawn as the branch it will be, and not as a symbol.
        if (diagram.nodes.some((n) => n.type === DRAFT_NODE_TYPE)) found.push(`${what}: a symbol`);
        found.push(...drawn(diagram).unrouted.map((id) => `${what}: no route for ${id}`));
        found.push(...bothWays(diagram).map((text) => `${what}: ${text}`));
        found.push(...overlapsOf(tidied(diagram, false)).map((text) => `${what}, tidied: ${text}`));
      }
      expect(beside).toBeGreaterThan(0);
      expect(pairs.length).toBeGreaterThan(beside);
      expect(found).toEqual([]);
    }, 240_000);

    it('when a generator, a load or a shunt is moved to another bus, from where it stood and from where the diagram puts it', async () => {
      const first = settled(await opened(topology));
      const devices = first.nodes.filter((n) => DEVICES.has(n.type ?? ''));
      const found: string[] = [];
      let moved = 0;
      // How many of them were brought beside their bus from where they stood.
      let brought = 0;
      let square = 0;
      for (const device of devices) {
        const from = (device.data as { parentBus: string }).parentBus;
        for (const bus of otherBuses(first, from, 6)) {
          for (const kept of [true, false]) {
            const after = rehung(first, device.id, bus, kept);
            const what = `${device.id} from bus ${from} to bus ${bus}${kept ? '' : ', placed afresh'}`;
            if (after === null) {
              found.push(`${what}: refused`);
              continue;
            }
            moved += 1;
            const stub = after.edges.find((e) => e.id === `stub-${device.id}`);
            if (stub?.target !== bus) found.push(`${what}: not on that bus`);
            const stands = after.nodes.find((n) => n.id === device.id)!.position;
            if (kept && (stands.x !== device.position.x || stands.y !== device.position.y)) {
              brought += 1;
            }
            // It stands by its bus: its connector does not reach across the diagram.
            const picture = drawn(after);
            const reach = lengthOf(picture.connections.routes.get(`stub-${device.id}`)!.points);
            if (reach > CONNECTOR_REACH) {
              found.push(`${what}: its connector is ${Math.round(reach)} long`);
            }
            if (runsSquare(after, `stub-${device.id}`)) square += 1;
            found.push(...picture.unrouted.map((id) => `${what}: no route for ${id}`));
            found.push(...overlapsOf(after).map((text) => `${what}: ${text}`));
            found.push(
              ...overlapsOf(after, { values: true }).map((text) => `${what}, with values: ${text}`),
            );
          }
        }
      }
      expect(moved).toBeGreaterThan(0);
      expect(found).toEqual([]);
      // A device that is on a bus across the diagram does not stay where it stood.
      expect(brought).toBeGreaterThan(0);
      // And square to its bar, on most buses (as a draft that is dropped on one).
      expect(square).toBeGreaterThanOrEqual((3 * moved) / 4);
    }, 480_000);

    it('after a tidy of a diagram a device was moved to another bus on', async () => {
      const first = settled(await opened(topology));
      const device = first.nodes.find((n) => DEVICES.has(n.type ?? ''))!;
      const from = (device.data as { parentBus: string }).parentBus;
      const found: string[] = [];
      for (const bus of otherBuses(first, from, 2)) {
        const after = rehung(first, device.id, bus, true);
        expect(after).not.toBeNull();
        for (const relayout of [false, true]) {
          found.push(
            ...overlapsOf(tidied(after!, relayout)).map(
              (text) =>
                `${device.id} to bus ${bus}, ${relayout ? 'laid out again' : 'tidied'}: ${text}`,
            ),
          );
        }
      }
      expect(found).toEqual([]);
    }, 240_000);
  });
}
