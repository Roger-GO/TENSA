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
import { buildGraph } from '@/components/sld/graph';
import type { TopologySummary, TopologyEntry } from '@/api/types';

function bus(idx: number | string): TopologyEntry {
  return { idx, name: `b${idx}`, kind: 'Bus', params: {} };
}
function gen(idx: number | string, busIdx: number | string, kind = 'GENROU'): TopologyEntry {
  return { idx, name: `gen-${idx}`, kind, params: { bus: busIdx } };
}
function ctrl(
  idx: string,
  kind: string,
  params: Record<string, number | string>,
): TopologyEntry {
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
    const ctrlNode = nodeById(nodes, 'controller-EXST1_1');
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
    expect(ctrlNode!.position.x - genNode!.position.x).toBe(32);
    expect(ctrlNode!.position.y - genNode!.position.y).toBe(-18);
    // Tether vector points back to the parent origin.
    expect(d.connectorDx).toBe(-32);
    expect(d.connectorDy).toBe(18);
  });

  it('docks a governor (syn) and classifies it', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('GENROU_1', 1)],
      controllers: [ctrl('IEEEG1_1', 'IEEEG1', { syn: 'GENROU_1' })],
    });
    const { nodes } = buildGraph(topology, COORDS);
    const c = nodeById(nodes, 'controller-IEEEG1_1');
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
    const pss = nodeById(nodes, 'controller-IEEEST_1');
    expect(pss).toBeDefined();
    const d = pss?.data as Record<string, unknown>;
    expect(d.subKind).toBe('pss');
    expect(d.orphan).toBe(false);
    // Docked beside the exciter node, not the generator.
    expect(d.parentNodeId).toBe('controller-EXST1_1');
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
    const reg = nodeById(nodes, 'controller-REGCP1_1');
    const ree = nodeById(nodes, 'controller-REECA1_1');
    const rep = nodeById(nodes, 'controller-REPCA1_1');
    expect(reg).toBeDefined();
    expect(ree).toBeDefined();
    expect(rep).toBeDefined();
    // REGCP1 prefers its StaticGen (`gen`) over the bus.
    expect((reg?.data as Record<string, unknown>).parentNodeId).toBe('generator-PV_1');
    expect((ree?.data as Record<string, unknown>).parentNodeId).toBe('controller-REGCP1_1');
    expect((rep?.data as Record<string, unknown>).parentNodeId).toBe('controller-REECA1_1');
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
    const pmu = nodeById(nodes, 'controller-PMU_1');
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
    const a = nodeById(nodes, 'controller-EXST1_1');
    const b = nodeById(nodes, 'controller-IEEEG1_1');
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
    const orphan = nodeById(nodes, 'controller-EXST1_X');
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
});
