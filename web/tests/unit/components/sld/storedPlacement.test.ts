/**
 * What `buildGraph` draws from a saved layout beyond bus and device
 * positions: the routes of its branches, and the controllers it places on
 * their own. Both are only used while they still fit the case: a route
 * whose bus has moved, or whose idx now names another branch, goes back
 * to automatic routing instead of hanging in mid-air.
 */
import { describe, it, expect } from 'vitest';
import {
  buildGraph,
  CONTROLLER_DOCK,
  NODE_FOOTPRINT,
  routeFitsBuses,
} from '@/components/sld/graph';
import type { TopologySummary, TopologyEntry } from '@/api/types';

function bus(idx: number | string): TopologyEntry {
  return { idx, name: `b${idx}`, kind: 'Bus', params: {} };
}
function line(idx: string, bus1: number, bus2: number): TopologyEntry {
  return { idx, name: idx, kind: 'Line', params: { bus1, bus2 } };
}

const COORDS = { '1': { x: 0, y: 0 }, '2': { x: 300, y: 0 }, '3': { x: 300, y: 300 } };

/** A route that leaves bus 1 downwards and arrives on bus 2 from below. */
const ROUTE_1_2: [number, number][] = [
  [30, 40],
  [30, 90],
  [330, 90],
  [330, 40],
];

const topology: TopologySummary = {
  state: 'pre-setup',
  buses: [bus(1), bus(2), bus(3)],
  lines: [line('L1', 1, 2), line('L2', 2, 3)],
  transformers: [{ idx: 'T1', name: 'T1', kind: 'Line', params: { bus1: 1, bus2: 3 } }],
  generators: [{ idx: 'G1', name: 'G1', kind: 'GENROU', params: { bus: 1 } }],
  loads: [],
  shunts: [],
  controllers: [
    { idx: 'E1', name: 'E1', kind: 'EXST1', params: { syn: 'G1' } },
    { idx: 'T1', name: 'T1', kind: 'TGOV1', params: { syn: 'G1' } },
    { idx: 'P1', name: 'P1', kind: 'IEEEST', params: { avr: 'E1' } },
  ],
};

function edge(edges: ReturnType<typeof buildGraph>['edges'], id: string) {
  const found = edges.find((e) => e.id === id);
  if (!found) throw new Error(`no edge ${id}`);
  return found;
}
function node(nodes: ReturnType<typeof buildGraph>['nodes'], id: string) {
  const found = nodes.find((n) => n.id === id);
  if (!found) throw new Error(`no node ${id}`);
  return found;
}

describe('routeFitsBuses', () => {
  const at = (x: number, y: number, moved = false) => ({ coord: { x, y }, moved });

  it('takes a route whose ends sit at its two buses', () => {
    expect(routeFitsBuses(ROUTE_1_2, at(0, 0), at(300, 0))).toBe(true);
  });

  it('takes an end anywhere on the bus footprint, and a little outside it', () => {
    const { width, height } = NODE_FOOTPRINT.bus;
    const from = at(0, 0);
    const to = at(300, 0);
    const endsAt = (x: number, y: number): [number, number][] => [
      [x, y],
      [330, 40],
    ];
    expect(routeFitsBuses(endsAt(0, 0), from, to)).toBe(true);
    expect(routeFitsBuses(endsAt(width, height), from, to)).toBe(true);
    expect(routeFitsBuses(endsAt(-10, height + 10), from, to)).toBe(true);
    expect(routeFitsBuses(endsAt(-40, 0), from, to)).toBe(false);
    expect(routeFitsBuses(endsAt(0, height + 40), from, to)).toBe(false);
  });

  it('refuses a route once either bus has been moved', () => {
    expect(routeFitsBuses(ROUTE_1_2, at(0, 0, true), at(300, 0))).toBe(false);
    expect(routeFitsBuses(ROUTE_1_2, at(0, 0), at(300, 0, true))).toBe(false);
  });

  it('refuses a route that ends at some other bus', () => {
    // The idx was reused: the branch now runs from bus 1 to bus 3.
    expect(routeFitsBuses(ROUTE_1_2, at(0, 0), at(300, 300))).toBe(false);
    // Or the route is the right one the wrong way round.
    expect(routeFitsBuses(ROUTE_1_2, at(300, 0), at(0, 0))).toBe(false);
  });

  it('refuses a route with a bus missing or fewer than two points', () => {
    expect(routeFitsBuses(ROUTE_1_2, { coord: undefined, moved: false }, at(300, 0))).toBe(false);
    expect(routeFitsBuses([[30, 40]], at(0, 0), at(300, 0))).toBe(false);
    expect(routeFitsBuses([], at(0, 0), at(300, 0))).toBe(false);
  });
});

describe('buildGraph with stored branch routes', () => {
  const bendPoints = new Map<string, [number, number][]>([
    ['line-L1', ROUTE_1_2],
    [
      'transformer-T1',
      [
        [30, 40],
        [30, 320],
        [300, 320],
      ],
    ],
  ]);

  it('draws a branch through its stored points', () => {
    const { edges } = buildGraph(topology, COORDS, { bendPoints });
    expect(edge(edges, 'line-L1').type).toBe('routed');
    expect(edge(edges, 'line-L1').data?.bendPoints).toEqual(ROUTE_1_2);
    // A transformer keeps its own edge type and reads the points from its data.
    expect(edge(edges, 'transformer-T1').type).toBe('transformer');
    expect(edge(edges, 'transformer-T1').data?.bendPoints).toHaveLength(3);
    // A branch with no stored route is drawn from where its buses are.
    expect(edge(edges, 'line-L2').type).toBe('topology');
    expect(edge(edges, 'line-L2').data?.bendPoints).toBeUndefined();
  });

  it('keeps every route after a drag that moved no bus', () => {
    // The canvas records an override for every node at the end of any drag,
    // each at the position it already had. That used to send every routed
    // branch of the diagram back to automatic routing.
    const dragOverrides = {
      '1': { x: 0, y: 0 },
      '2': { x: 300, y: 0 },
      '3': { x: 300, y: 300 },
      'generator-G1': { x: -200, y: -200 },
    };
    const { edges } = buildGraph(topology, COORDS, { bendPoints, dragOverrides });
    expect(edge(edges, 'line-L1').type).toBe('routed');
    expect(edge(edges, 'transformer-T1').data?.bendPoints).toHaveLength(3);
  });

  it('sends only the branches of a moved bus back to automatic routing', () => {
    const dragOverrides = {
      '1': { x: 0, y: 0 },
      '2': { x: 360, y: 20 },
      '3': { x: 300, y: 300 },
    };
    const { edges } = buildGraph(topology, COORDS, { bendPoints, dragOverrides });
    expect(edge(edges, 'line-L1').type).toBe('topology');
    expect(edge(edges, 'line-L1').data?.bendPoints).toBeUndefined();
    // Bus 1 and bus 3 stayed, so the transformer between them keeps its route.
    expect(edge(edges, 'transformer-T1').data?.bendPoints).toHaveLength(3);
  });

  it('ignores a route stored for an idx that now names another branch', () => {
    const rewired: TopologySummary = { ...topology, lines: [line('L1', 2, 3)] };
    const { edges } = buildGraph(rewired, COORDS, { bendPoints });
    expect(edge(edges, 'line-L1').type).toBe('topology');
    expect(edge(edges, 'line-L1').data?.bendPoints).toBeUndefined();
  });
});

describe('buildGraph with stored controller positions', () => {
  it('docks every controller when the layout places none', () => {
    const { nodes } = buildGraph(topology, COORDS);
    const machine = node(nodes, 'generator-G1');
    const exciter = node(nodes, 'controller-EXST1-E1');
    expect(exciter.position.x - machine.position.x).toBe(CONTROLLER_DOCK.x);
    expect(exciter.data.placed).toBeUndefined();
  });

  it('puts a placed controller where the layout has it, tethered to its device', () => {
    const controllerCoords = new Map([['EXST1|E1', { x: 500, y: -300 }]]);
    const { nodes } = buildGraph(topology, COORDS, { controllerCoords });
    const machine = node(nodes, 'generator-G1');
    const exciter = node(nodes, 'controller-EXST1-E1');
    expect(exciter.position).toEqual({ x: 500, y: -300 });
    expect(exciter.data.placed).toBe(true);
    // The tether still ends on the machine, however far the badge is from it.
    expect(exciter.position.x + (exciter.data.connectorDx as number)).toBe(machine.position.x);
    expect(exciter.position.y + (exciter.data.connectorDy as number)).toBe(machine.position.y);
  });

  it('closes up the docked badges beside a placed one', () => {
    // Docked, the governor has the first slot beside the machine and the
    // exciter the one below it.
    const docked = buildGraph(topology, COORDS);
    const slotOf = (nodes: ReturnType<typeof buildGraph>['nodes'], id: string) =>
      node(nodes, id).position.y - node(nodes, 'generator-G1').position.y;
    expect(slotOf(docked.nodes, 'controller-TGOV1-T1')).toBe(CONTROLLER_DOCK.y);
    expect(slotOf(docked.nodes, 'controller-EXST1-E1')).toBe(
      CONTROLLER_DOCK.y + CONTROLLER_DOCK.stackDy,
    );

    // With the governor placed elsewhere, the exciter moves up into its slot.
    const controllerCoords = new Map([['TGOV1|T1', { x: 500, y: -300 }]]);
    const { nodes } = buildGraph(topology, COORDS, { controllerCoords });
    expect(slotOf(nodes, 'controller-EXST1-E1')).toBe(CONTROLLER_DOCK.y);
  });

  it('docks a controller of a placed controller beside where that one sits', () => {
    // The stabiliser acts on the exciter, so it follows the exciter.
    const controllerCoords = new Map([['EXST1|E1', { x: 500, y: -300 }]]);
    const { nodes } = buildGraph(topology, COORDS, { controllerCoords });
    const stabiliser = node(nodes, 'controller-IEEEST-P1');
    expect(stabiliser.position).toEqual({
      x: 500 + CONTROLLER_DOCK.x,
      y: -300 + CONTROLLER_DOCK.y,
    });
  });

  it('ignores a position stored for a controller the case no longer has', () => {
    const controllerCoords = new Map([['EXST1|E9', { x: 500, y: -300 }]]);
    const { nodes } = buildGraph(topology, COORDS, { controllerCoords });
    expect(nodes.some((n) => n.id === 'controller-EXST1-E9')).toBe(false);
    expect(node(nodes, 'controller-EXST1-E1').data.placed).toBeUndefined();
  });
});
