/**
 * Controller badges (v3.1 Unit 19) and the controllers of a generating unit.
 *
 * A controller that leads back to a generator (an exciter or a governor by
 * `syn`, a stabiliser by `avr`, a converter and its controls by `gen`, `reg`
 * and `ree`) is a model of that generator's unit: `buildGraph` names it on
 * the symbol of the unit (`data.unit.members`) and draws no node for it.
 * The rest still get a `'controller'` badge: one that acts on a bus is
 * docked beside the bus, one whose reference names nothing is an orphan in
 * the gutter. The reference structure mirrors real ANDES wiring.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildGraph, CONTROLLER_DOCK, type UnitNodeData } from '@/components/sld/graph';
import type { TopologySummary, TopologyEntry } from '@/api/types';

function bus(idx: number | string): TopologyEntry {
  return { idx, name: `b${idx}`, kind: 'Bus', params: {} };
}
function gen(idx: number | string, busIdx: number | string, kind = 'GENROU'): TopologyEntry {
  return { idx, name: `gen-${idx}`, kind, params: { bus: busIdx } };
}
function ctrl(idx: string, kind: string, params: Record<string, number | string>): TopologyEntry {
  return { idx, name: `${kind} ${idx}`, kind, params };
}

function makeTopology(opts: Partial<TopologySummary>): TopologySummary {
  return {
    state: 'pre-setup',
    buses: opts.buses ?? [],
    lines: opts.lines ?? [],
    transformers: opts.transformers ?? [],
    generators: opts.generators ?? [],
    loads: opts.loads ?? [],
    shunts: opts.shunts ?? [],
    controllers: opts.controllers ?? [],
  };
}

const COORDS = { '1': { x: 0, y: 200 } };

function nodeById(nodes: ReturnType<typeof buildGraph>['nodes'], id: string) {
  return nodes.find((n) => n.id === id);
}

/** The models the symbol of a unit names, as `kind idx role depth`. */
function membersOf(nodes: ReturnType<typeof buildGraph>['nodes'], id: string): string[] {
  const unit = (nodeById(nodes, id)?.data as { unit?: UnitNodeData }).unit;
  return (unit?.members ?? []).map((m) => `${m.kind} ${m.idx} ${m.role} ${m.depth}`);
}

const badgesOf = (nodes: ReturnType<typeof buildGraph>['nodes']) =>
  nodes.filter((n) => n.type === 'controller');

describe('buildGraph — the controllers of a generating unit', () => {
  it('names an exciter on the symbol of its machine and draws no badge for it', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('GENROU_1', 1)],
      controllers: [ctrl('EXST1_1', 'EXST1', { syn: 'GENROU_1', Ka: 200 })],
    });
    const { nodes } = buildGraph(topology, COORDS);

    expect(nodeById(nodes, 'generator-GENROU_1')).toBeDefined();
    expect(badgesOf(nodes)).toEqual([]);
    expect(membersOf(nodes, 'generator-GENROU_1')).toEqual([
      'GENROU GENROU_1 machine 0',
      'EXST1 EXST1_1 exciter 1',
    ]);
    // The id the exciter is still picked by, from a table or the search.
    const unit = (nodeById(nodes, 'generator-GENROU_1')!.data as { unit: UnitNodeData }).unit;
    expect(unit.members[1]?.nodeId).toBe('controller-EXST1-EXST1_1');
    expect(unit.expanded).toBe(false);
  });

  it('classifies a governor (syn)', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('GENROU_1', 1)],
      controllers: [ctrl('IEEEG1_1', 'IEEEG1', { syn: 'GENROU_1' })],
    });
    const { nodes } = buildGraph(topology, COORDS);
    expect(membersOf(nodes, 'generator-GENROU_1')).toEqual([
      'GENROU GENROU_1 machine 0',
      'IEEEG1 IEEEG1_1 governor 1',
    ]);
  });

  it('puts a PSS under the exciter it references (avr → Exciter chain)', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('GENROU_1', 1)],
      controllers: [
        ctrl('IEEEST_1', 'IEEEST', { avr: 'EXST1_1' }),
        ctrl('TGOV1_1', 'TGOV1', { syn: 'GENROU_1' }),
        ctrl('EXST1_1', 'EXST1', { syn: 'GENROU_1' }),
      ],
    });
    const { nodes } = buildGraph(topology, COORDS);
    expect(badgesOf(nodes)).toEqual([]);
    // Whatever order the case lists them in: the exciter, the stabiliser
    // under it, then the governor.
    expect(membersOf(nodes, 'generator-GENROU_1')).toEqual([
      'GENROU GENROU_1 machine 0',
      'EXST1 EXST1_1 exciter 1',
      'IEEEST IEEEST_1 pss 2',
      'TGOV1 TGOV1_1 governor 1',
    ]);
  });

  it('takes the renewable plant chain REPCA1 → REECA1 → REGCP1 into the unit of its generator', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('PV_1', 1, 'PV')],
      controllers: [
        ctrl('REPCA1_1', 'REPCA1', { ree: 'REECA1_1' }),
        ctrl('REECA1_1', 'REECA1', { reg: 'REGCP1_1' }),
        ctrl('REGCP1_1', 'REGCP1', { bus: 1, gen: 'PV_1' }),
      ],
    });
    const { nodes } = buildGraph(topology, COORDS);
    // REGCP1 prefers its StaticGen (`gen`) over the bus, and the two
    // controls follow it.
    expect(badgesOf(nodes)).toEqual([]);
    expect(membersOf(nodes, 'generator-PV_1')).toEqual([
      'PV PV_1 generator 0',
      'REGCP1 REGCP1_1 renewable 1',
      'REECA1 REECA1_1 renewable 2',
      'REPCA1 REPCA1_1 renewable 3',
    ]);
  });

  it('keeps two different controllers that share a numeric idx apart', () => {
    // ANDES idx is model-local — an exciter + a governor on the same machine
    // can both be idx 1. The id each is picked by is namespaced by model
    // class, so neither hides the other.
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('GENROU_1', 1)],
      controllers: [
        ctrl('1', 'IEEEX1', { syn: 'GENROU_1' }),
        ctrl('1', 'IEEEG1', { syn: 'GENROU_1' }),
      ],
    });
    const { nodes } = buildGraph(topology, COORDS);
    const unit = (nodeById(nodes, 'generator-GENROU_1')!.data as { unit: UnitNodeData }).unit;
    expect(unit.members.map((m) => m.nodeId)).toEqual([
      'generator-GENROU_1',
      'controller-IEEEX1-1',
      'controller-IEEEG1-1',
    ]);
    expect(unit.members.map((m) => m.role)).toEqual(['machine', 'exciter', 'governor']);
  });

  it('finds the exciter a PSS means where a governor has the same idx', () => {
    const topology = makeTopology({
      buses: [bus(1), bus(2)],
      generators: [gen('G1', 1), gen('G2', 2)],
      controllers: [
        // Listed first, and `1` like the exciter: `avr` still means the exciter.
        ctrl('1', 'TGOV1', { syn: 'G2' }),
        ctrl('1', 'EXST1', { syn: 'G1' }),
        ctrl('PSS_1', 'IEEEST', { avr: '1' }),
      ],
    });
    const { nodes } = buildGraph(topology, { '1': { x: 0, y: 200 }, '2': { x: 300, y: 200 } });
    expect(membersOf(nodes, 'generator-G1')).toEqual([
      'GENROU G1 machine 0',
      'EXST1 1 exciter 1',
      'IEEEST PSS_1 pss 2',
    ]);
    expect(membersOf(nodes, 'generator-G2')).toEqual(['GENROU G2 machine 0', 'TGOV1 1 governor 1']);
  });

  it('draws a static generator and the machine that shares its idx as one symbol', () => {
    // kundur_full's real shape: a static PV and a dynamic GENROU share idx 2.
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('2', 1, 'PV'), gen('2', 1, 'GENROU')],
      controllers: [ctrl('TGOV1_1', 'TGOV1', { syn: '2' })],
    });
    const { nodes, edges } = buildGraph(topology, COORDS);
    const genNodes = nodes.filter((n) => n.type === 'generator');
    expect(genNodes.map((n) => n.id)).toEqual(['generator-2']); // exactly one node, not two
    // The node is the static generator's, and it shows the machine's symbol.
    const data = genNodes[0]?.data as Record<string, unknown>;
    expect(data.kind).toBe('PV');
    expect(data.symbolKind).toBe('GENROU');
    // One stub edge, no duplicate-key collision.
    expect(edges.filter((e) => e.id === 'stub-generator-2')).toHaveLength(1);
    // The governor names the machine, and is a model of the same unit.
    expect(membersOf(nodes, 'generator-2')).toEqual([
      'PV 2 generator 0',
      'GENROU 2 machine 1',
      'TGOV1 TGOV1_1 governor 2',
    ]);
    expect(badgesOf(nodes)).toEqual([]);
  });

  it('gives a generator of one model no unit to draw out', () => {
    const topology = makeTopology({ buses: [bus(1)], generators: [gen('PV_1', 1, 'PV')] });
    const { nodes } = buildGraph(topology, COORDS);
    const data = nodeById(nodes, 'generator-PV_1')!.data as Record<string, unknown>;
    expect(data.unit).toBeUndefined();
    expect(data.symbolKind).toBeUndefined();
  });
});

describe('buildGraph — a control chain that is drawn out', () => {
  const topology = makeTopology({
    buses: [bus(1)],
    generators: [
      gen('2', 1, 'PV'),
      { ...gen('GENROU_2', 1), params: { bus: 1, gen: 2 } },
      gen('3', 1, 'PV'),
    ],
    controllers: [ctrl('TGOV1_2', 'TGOV1', { syn: 'GENROU_2' })],
  });
  const drawn = (unitStates: Map<string, { expanded: boolean; bus?: string | null }>) => {
    const { nodes } = buildGraph(topology, COORDS, { unitStates });
    const node = nodeById(nodes, 'generator-2')!;
    return { node, unit: (node.data as { unit: UnitNodeData }).unit };
  };

  it('is folded unless the layout says otherwise', () => {
    expect(drawn(new Map()).unit.expanded).toBe(false);
    expect(drawn(new Map([['2', { expanded: false, bus: '1' }]])).unit.expanded).toBe(false);
    // What the layout says of another unit is not about this one.
    expect(drawn(new Map([['3', { expanded: true }]])).unit.expanded).toBe(false);
  });

  it('is drawn out for the unit the layout names, on the bus it names or on any when it names none', () => {
    expect(drawn(new Map([['2', { expanded: true, bus: '1' }]])).unit.expanded).toBe(true);
    expect(drawn(new Map([['2', { expanded: true, bus: null }]])).unit.expanded).toBe(true);
    expect(drawn(new Map([['2', { expanded: true }]])).unit.expanded).toBe(true);
  });

  it('stays folded where the idx has come to name a generator of another bus', () => {
    expect(drawn(new Map([['2', { expanded: true, bus: '7' }]])).unit.expanded).toBe(false);
  });

  it('is drawn over the symbols around it, on the side away from the bus', () => {
    const folded = drawn(new Map());
    const out = drawn(new Map([['2', { expanded: true }]]));
    expect(folded.node.zIndex).toBeUndefined();
    expect(out.node.zIndex).toBeGreaterThan(0);
    // The unit hangs above its bus, so the chain goes further up.
    expect(out.unit.side).toBe('above');
    // Nothing else of the node changes: it is the same box in the same place.
    expect(out.node.position).toEqual(folded.node.position);
    expect([out.node.initialWidth, out.node.initialHeight]).toEqual([
      folded.node.initialWidth,
      folded.node.initialHeight,
    ]);
  });

  it('draws nothing out for a generator of one model, whatever the layout says', () => {
    const { nodes } = buildGraph(topology, COORDS, {
      unitStates: new Map([['3', { expanded: true }]]),
    });
    const lone = nodeById(nodes, 'generator-3')!;
    expect((lone.data as Record<string, unknown>).unit).toBeUndefined();
    expect(lone.zIndex).toBeUndefined();
  });
});

describe('buildGraph — controller badges', () => {
  it('docks a PMU beside its Bus (bus ref)', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      controllers: [ctrl('PMU_1', 'PMU', { bus: 1 })],
    });
    const { nodes } = buildGraph(topology, COORDS);
    const pmu = nodeById(nodes, 'controller-PMU-PMU_1');
    const d = pmu?.data as Record<string, unknown>;
    expect(pmu?.type).toBe('controller');
    expect(pmu?.draggable).toBe(false);
    expect(d.subKind).toBe('measurement');
    expect(d.orphan).toBe(false);
    expect(d.parentNodeId).toBe('1'); // bus node ids carry no prefix
    // Docked at a fixed offset off the bus, with a tether back to it.
    expect(pmu!.position.x - COORDS['1'].x).toBe(CONTROLLER_DOCK.x);
    expect(pmu!.position.y - COORDS['1'].y).toBe(CONTROLLER_DOCK.y);
    expect(d.connectorDx).toBe(-CONTROLLER_DOCK.x);
    expect(d.connectorDy).toBe(-CONTROLLER_DOCK.y);
  });

  it('stacks two controllers on the same bus vertically', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      controllers: [ctrl('PMU_1', 'PMU', { bus: 1 }), ctrl('PMU_2', 'PMU', { bus: 1 })],
    });
    const { nodes } = buildGraph(topology, COORDS);
    const a = nodeById(nodes, 'controller-PMU-PMU_1');
    const b = nodeById(nodes, 'controller-PMU-PMU_2');
    expect(a!.position.x).toBe(b!.position.x); // same column
    expect(Math.abs(a!.position.y - b!.position.y)).toBe(CONTROLLER_DOCK.stackDy);
  });

  it('docks a converter whose generator is missing beside its bus, and its control beside it', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      controllers: [
        ctrl('REECA1_1', 'REECA1', { reg: 'REGCA1_1' }),
        ctrl('REGCA1_1', 'REGCA1', { bus: 1, gen: 'GONE' }),
      ],
    });
    const { nodes } = buildGraph(topology, COORDS);
    const reg = nodeById(nodes, 'controller-REGCA1-REGCA1_1');
    const ree = nodeById(nodes, 'controller-REECA1-REECA1_1');
    expect((reg?.data as Record<string, unknown>).parentNodeId).toBe('1');
    expect((ree?.data as Record<string, unknown>).parentNodeId).toBe('controller-REGCA1-REGCA1_1');
  });

  it('renders an orphan badge when the referenced device is missing', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('GENROU_1', 1)],
      controllers: [ctrl('EXST1_X', 'EXST1', { syn: 'GHOST_9' })],
    });
    const { nodes } = buildGraph(topology, COORDS);
    const orphan = nodeById(nodes, 'controller-EXST1-EXST1_X');
    expect(orphan).toBeDefined();
    const d = orphan?.data as Record<string, unknown>;
    expect(d.orphan).toBe(true);
    expect(d.parentNodeId).toBeUndefined();
    expect(d.connectorDx).toBe(0);
    expect(orphan!.position.x).toBe(24); // gutter
    // The machine that is there has nothing to do with it.
    expect(membersOf(nodes, 'generator-GENROU_1')).toEqual([]);
  });

  it('renders a stabiliser whose exciter the case does not list as an orphan, not beside a governor of that idx', () => {
    // kundur_ieeest's shape: IEEEST 1 names exciter 1, an EXDC2 the topology
    // does not list, and governor 1 is on the machine. The governor is no
    // exciter: the stabiliser is not drawn as its, on the symbol or beside it.
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('1', 1, 'Slack'), { ...gen('1', 1), params: { bus: 1, gen: 1 } }],
      controllers: [ctrl('1', 'TGOV1', { syn: 1 }), ctrl('1', 'IEEEST', { avr: 1 })],
    });
    const { nodes } = buildGraph(topology, COORDS);
    expect(membersOf(nodes, 'generator-1')).toEqual([
      'Slack 1 generator 0',
      'GENROU 1 machine 1',
      'TGOV1 1 governor 2',
    ]);
    const pss = nodeById(nodes, 'controller-IEEEST-1');
    expect((pss?.data as Record<string, unknown>).orphan).toBe(true);
    expect(badgesOf(nodes).map((n) => n.id)).toEqual(['controller-IEEEST-1']);
  });

  it('renders the controllers of a generator that cannot be drawn as orphans', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const topology = makeTopology({
      buses: [bus(1)],
      // No bus: there is nowhere to draw the unit.
      generators: [{ idx: 'G', name: 'G', kind: 'GENROU', params: {} }],
      controllers: [ctrl('EXST1_1', 'EXST1', { syn: 'G' })],
    });
    const { nodes } = buildGraph(topology, COORDS);
    expect(nodeById(nodes, 'generator-G')).toBeUndefined();
    const badge = nodeById(nodes, 'controller-EXST1-EXST1_1');
    expect((badge?.data as Record<string, unknown>).orphan).toBe(true);
    vi.restoreAllMocks();
  });

  it('emits no controller nodes when the bucket is absent', () => {
    const topology = makeTopology({ buses: [bus(1)], generators: [gen('GENROU_1', 1)] });
    const { nodes } = buildGraph(topology, COORDS);
    expect(nodes.some((n) => n.type === 'controller')).toBe(false);
  });
});
