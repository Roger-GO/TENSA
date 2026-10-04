/**
 * Controller node emission (v3.1 Unit 19).
 *
 * Verifies that `buildGraph` docks a `'controller'` node beside the device
 * each controller references, resolving SynGen (`syn`), Bus (`bus`),
 * StaticGen (`gen`), and controller→controller (`avr`/`reg`/`ree`) chains.
 * The reference structure mirrors real ANDES wiring (exciters/governors →
 * SynGen; PSS → Exciter; renewable plant REPCA1 → REECA1 → REGCP1 → Bus).
 */
import { describe, it, expect } from 'vitest';
import {
  buildGraph,
  CONTROLLER_DOCK,
  DEVICE_VALUE_LABEL,
  NODE_FOOTPRINT,
} from '@/components/sld/graph';
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

describe('buildGraph — controller nodes', () => {
  it('docks an exciter beside its SynGen (syn ref) with a sub-kind + tether', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('GENROU_1', 1)],
      controllers: [ctrl('EXST1_1', 'EXST1', { syn: 'GENROU_1', Ka: 200 })],
    });
    const { nodes } = buildGraph(topology, COORDS);

    const genNode = nodeById(nodes, 'generator-GENROU_1');
    const ctrlNode = nodeById(nodes, 'controller-EXST1-EXST1_1');
    expect(genNode).toBeDefined();
    expect(ctrlNode).toBeDefined();
    expect(ctrlNode?.type).toBe('controller');
    const d = ctrlNode?.data as Record<string, unknown>;
    expect(d.subKind).toBe('exciter');
    expect(d.orphan).toBe(false);
    expect(d.parentNodeId).toBe('generator-GENROU_1');
    expect(ctrlNode?.draggable).toBe(false);
    // Docked at a fixed offset off the parent — exact regardless of where
    // collision push-out placed the generator.
    expect(ctrlNode!.position.x - genNode!.position.x).toBe(CONTROLLER_DOCK.x);
    expect(ctrlNode!.position.y - genNode!.position.y).toBe(CONTROLLER_DOCK.y);
    // Tether vector points back to the parent origin.
    expect(d.connectorDx).toBe(-CONTROLLER_DOCK.x);
    expect(d.connectorDy).toBe(-CONTROLLER_DOCK.y);
  });

  it('docks a governor (syn) and classifies it', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('GENROU_1', 1)],
      controllers: [ctrl('IEEEG1_1', 'IEEEG1', { syn: 'GENROU_1' })],
    });
    const { nodes } = buildGraph(topology, COORDS);
    const c = nodeById(nodes, 'controller-IEEEG1-IEEEG1_1');
    expect((c?.data as Record<string, unknown>).subKind).toBe('governor');
    expect((c?.data as Record<string, unknown>).parentNodeId).toBe('generator-GENROU_1');
  });

  it('resolves a PSS that references its exciter (avr → Exciter chain)', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('GENROU_1', 1)],
      controllers: [
        ctrl('EXST1_1', 'EXST1', { syn: 'GENROU_1' }),
        ctrl('IEEEST_1', 'IEEEST', { avr: 'EXST1_1' }),
      ],
    });
    const { nodes } = buildGraph(topology, COORDS);
    const pss = nodeById(nodes, 'controller-IEEEST-IEEEST_1');
    expect(pss).toBeDefined();
    const d = pss?.data as Record<string, unknown>;
    expect(d.subKind).toBe('pss');
    expect(d.orphan).toBe(false);
    // Docked beside the exciter node, not the generator.
    expect(d.parentNodeId).toBe('controller-EXST1-EXST1_1');
  });

  it('resolves the renewable plant chain REPCA1 → REECA1 → REGCP1 → Bus', () => {
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
    const reg = nodeById(nodes, 'controller-REGCP1-REGCP1_1');
    const ree = nodeById(nodes, 'controller-REECA1-REECA1_1');
    const rep = nodeById(nodes, 'controller-REPCA1-REPCA1_1');
    expect(reg).toBeDefined();
    expect(ree).toBeDefined();
    expect(rep).toBeDefined();
    // REGCP1 prefers its StaticGen (`gen`) over the bus.
    expect((reg?.data as Record<string, unknown>).parentNodeId).toBe('generator-PV_1');
    expect((ree?.data as Record<string, unknown>).parentNodeId).toBe('controller-REGCP1-REGCP1_1');
    expect((rep?.data as Record<string, unknown>).parentNodeId).toBe('controller-REECA1-REECA1_1');
    for (const n of [reg, ree, rep]) {
      expect((n?.data as Record<string, unknown>).subKind).toBe('renewable');
      expect((n?.data as Record<string, unknown>).orphan).toBe(false);
    }
  });

  it('docks a PMU beside its Bus (bus ref)', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      controllers: [ctrl('PMU_1', 'PMU', { bus: 1 })],
    });
    const { nodes } = buildGraph(topology, COORDS);
    const pmu = nodeById(nodes, 'controller-PMU-PMU_1');
    const d = pmu?.data as Record<string, unknown>;
    expect(d.subKind).toBe('measurement');
    expect(d.parentNodeId).toBe('1'); // bus node ids carry no prefix
  });

  it('stacks two controllers on the same parent vertically', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('GENROU_1', 1)],
      controllers: [
        ctrl('EXST1_1', 'EXST1', { syn: 'GENROU_1' }),
        ctrl('IEEEG1_1', 'IEEEG1', { syn: 'GENROU_1' }),
      ],
    });
    const { nodes } = buildGraph(topology, COORDS);
    const a = nodeById(nodes, 'controller-EXST1-EXST1_1');
    const b = nodeById(nodes, 'controller-IEEEG1-IEEEG1_1');
    expect(a!.position.x).toBe(b!.position.x); // same column
    expect(Math.abs(a!.position.y - b!.position.y)).toBe(22); // stacked by stackDy
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
  });

  it('emits no controller nodes when the bucket is absent', () => {
    const topology = makeTopology({ buses: [bus(1)], generators: [gen('GENROU_1', 1)] });
    const { nodes } = buildGraph(topology, COORDS);
    expect(nodes.some((n) => n.type === 'controller')).toBe(false);
  });

  it('gives two different controllers sharing a numeric idx distinct node ids', () => {
    // ANDES idx is model-local — an exciter + a governor on the same machine
    // can both be idx 1. A bare `controller-1` id would collide and drop one
    // badge; the id is namespaced by model class.
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('GENROU_1', 1)],
      controllers: [
        ctrl('1', 'IEEEX1', { syn: 'GENROU_1' }),
        ctrl('1', 'IEEEG1', { syn: 'GENROU_1' }),
      ],
    });
    const { nodes } = buildGraph(topology, COORDS);
    const exc = nodeById(nodes, 'controller-IEEEX1-1');
    const gov = nodeById(nodes, 'controller-IEEEG1-1');
    expect(exc).toBeDefined();
    expect(gov).toBeDefined();
    expect((exc?.data as Record<string, unknown>).subKind).toBe('exciter');
    expect((gov?.data as Record<string, unknown>).subKind).toBe('governor');
    // Both docked to the same generator; two distinct controller nodes exist.
    expect(nodes.filter((n) => n.type === 'controller')).toHaveLength(2);
  });

  it('de-dupes the PV+GENROU shared-idx generator and docks the governor to the single node', () => {
    // kundur_full's real shape: a static PV and a dynamic GENROU share idx 2.
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('2', 1, 'PV'), gen('2', 1, 'GENROU')],
      controllers: [ctrl('TGOV1_1', 'TGOV1', { syn: '2' })],
    });
    const { nodes, edges } = buildGraph(topology, COORDS);
    const genNodes = nodes.filter((n) => n.id === 'generator-2');
    expect(genNodes).toHaveLength(1); // exactly one node, not two
    // The surviving node is the dynamic rotor model (preferred).
    expect((genNodes[0]?.data as Record<string, unknown>).kind).toBe('GENROU');
    // One stub edge, no duplicate-key collision.
    expect(edges.filter((e) => e.id === 'stub-generator-2')).toHaveLength(1);
    // The governor docks to the single generator node.
    const gov = nodeById(nodes, 'controller-TGOV1-TGOV1_1');
    expect((gov?.data as Record<string, unknown>).parentNodeId).toBe('generator-2');
  });

  describe('clear of the generator P / Q readout', () => {
    type Box = { left: number; right: number; top: number; bottom: number };
    const overlap = (a: Box, b: Box) =>
      Math.min(a.right, b.right) > Math.max(a.left, b.left) &&
      Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);

    // The readout is centred on the node's footprint and hangs on the face
    // of the node that looks at the bus (`valueSide`).
    function readoutBox(node: { position: { x: number; y: number }; data: unknown }): Box {
      const side = (node.data as { valueSide?: string }).valueSide;
      const { width, height } = NODE_FOOTPRINT.generator;
      const centre = node.position.x + width / 2;
      const top =
        side === 'below' ? node.position.y + height : node.position.y - DEVICE_VALUE_LABEL.height;
      return {
        left: centre - DEVICE_VALUE_LABEL.width / 2,
        right: centre + DEVICE_VALUE_LABEL.width / 2,
        top,
        bottom: top + DEVICE_VALUE_LABEL.height,
      };
    }

    // Two controllers on one machine stack down the dock; the smallest badge
    // the canvas draws (CONTROLLER_GLYPH_FOOTPRINT) is enough for the check
    // because the dock fixes the badge's left edge.
    function badgeBoxes(nodes: ReturnType<typeof buildGraph>['nodes']): Box[] {
      return nodes
        .filter((n) => n.type === 'controller')
        .map((n) => ({
          left: n.position.x,
          right: n.position.x + 28,
          top: n.position.y,
          bottom: n.position.y + 28,
        }));
    }

    const controllers = [
      ctrl('EXST1_1', 'EXST1', { syn: 'GENROU_1' }),
      ctrl('TGOV1_1', 'TGOV1', { syn: 'GENROU_1' }),
    ];

    it('leaves the readout of a machine above its bus clear of its badges', () => {
      const topology = makeTopology({
        buses: [bus(1)],
        generators: [gen('GENROU_1', 1)],
        controllers,
      });
      const { nodes } = buildGraph(topology, COORDS);
      const machine = nodeById(nodes, 'generator-GENROU_1')!;
      expect((machine.data as { valueSide?: string }).valueSide).toBe('below');
      const badges = badgeBoxes(nodes);
      expect(badges).toHaveLength(2);
      for (const badge of badges) expect(overlap(readoutBox(machine), badge)).toBe(false);
    });

    it('leaves the readout of a machine below its bus clear of its badges', () => {
      // Bus 1 sits below its branch neighbour, so its machine hangs south and
      // the readout moves to the strip above the node, where the first badge
      // used to dock.
      const topology = makeTopology({
        buses: [bus(1), bus(2)],
        transformers: [
          { idx: 'T12', name: 't', kind: 'Line', params: { bus1: 1, bus2: 2, r: 0.01, x: 0.05 } },
        ],
        generators: [gen('GENROU_1', 1)],
        controllers,
      });
      const { nodes } = buildGraph(topology, { '1': { x: 0, y: 500 }, '2': { x: 0, y: 100 } });
      const machine = nodeById(nodes, 'generator-GENROU_1')!;
      expect((machine.data as { valueSide?: string }).valueSide).toBe('above');
      const badges = badgeBoxes(nodes);
      expect(badges).toHaveLength(2);
      for (const badge of badges) expect(overlap(readoutBox(machine), badge)).toBe(false);
    });
  });
});
