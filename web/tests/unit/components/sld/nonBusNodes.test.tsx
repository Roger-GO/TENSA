/**
 * Non-bus node emission (Unit 3).
 *
 * Verifies that `buildGraph` produces React Flow nodes for generators,
 * loads, and shunts anchored to their parent bus, plus stub edges
 * connecting each non-bus node to the bus's appropriate cardinal
 * handle. Transformers stay as edges (TransformerEdge) — these tests
 * cover that they don't accidentally emit a node.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildGraph } from '@/components/sld/graph';
import type { TopologySummary, TopologyEntry } from '@/api/types';

function bus(idx: number | string, name = `b${idx}`): TopologyEntry {
  return { idx, name, kind: 'Bus', params: {} };
}

function gen(
  idx: number | string,
  busIdx: number | string,
  kind = 'PV',
): TopologyEntry {
  return {
    idx,
    name: `gen-${idx}`,
    kind,
    params: { bus: busIdx, Sn: 100, Vn: 100, p0: 1, v0: 1 },
  };
}

function load(idx: number | string, busIdx: number | string): TopologyEntry {
  return {
    idx,
    name: `load-${idx}`,
    kind: 'PQ',
    params: { bus: busIdx, Vn: 100, p0: 0.5, q0: 0.1 },
  };
}

function shunt(idx: number | string, busIdx: number | string): TopologyEntry {
  return {
    idx,
    name: `shunt-${idx}`,
    kind: 'Shunt',
    params: { bus: busIdx, Vn: 100, b: 0.1 },
  };
}

function trafo(idx: number | string, b1: number | string, b2: number | string): TopologyEntry {
  return {
    idx,
    name: `trafo-${idx}`,
    kind: 'Line',
    params: { bus1: b1, bus2: b2, r: 0.01, x: 0.05, tap: 1.05 },
  };
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
  };
}

describe('buildGraph — non-bus nodes', () => {
  it('emits a generator node north of its parent bus with a stub edge', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('GEN_1', 1)],
    });
    const { nodes, edges } = buildGraph(topology, { '1': { x: 0, y: 100 } });
    const genNode = nodes.find((n) => n.type === 'generator');
    expect(genNode).toBeDefined();
    expect(genNode?.id).toBe('generator-GEN_1');
    // x is roughly the bus's x — tiny row-parity stagger (Unit 13c)
    // shifts solo devices a few px to one side so vertical-neighbor
    // buses' children don't overlap. Width ±35 px from the bus.
    expect(Math.abs(genNode?.position.x ?? 999)).toBeLessThan(40);
    expect(genNode?.position.y).toBeLessThan(100); // north of bus
    const stub = edges.find((e) => e.id === 'stub-generator-GEN_1');
    expect(stub).toBeDefined();
    expect(stub?.type).toBe('stub');
    expect(stub?.source).toBe('generator-GEN_1');
    expect(stub?.target).toBe('1');
    expect(stub?.targetHandle).toBe('north-target');
  });

  it('stacks two generators on the same bus into a fan', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('G1', 1), gen('G2', 1, 'GENROU')],
    });
    const { nodes } = buildGraph(topology, { '1': { x: 100, y: 100 } });
    const gens = nodes.filter((n) => n.type === 'generator');
    expect(gens).toHaveLength(2);
    // Devices fan along the bus face (Unit 9 layout): the two
    // generators share the same y row but differ on x.
    expect(gens[0]!.position.x).not.toBe(gens[1]!.position.x);
  });

  it('emits a load node south of the bus + stub to south handle', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      loads: [load('PQ_1', 1)],
    });
    const { nodes, edges } = buildGraph(topology, { '1': { x: 0, y: 100 } });
    const loadNode = nodes.find((n) => n.type === 'load');
    expect(loadNode).toBeDefined();
    expect(loadNode?.position.y).toBeGreaterThan(100); // south of bus
    const stub = edges.find((e) => e.id === 'stub-load-PQ_1');
    expect(stub?.targetHandle).toBe('south-target');
  });

  it('emits a shunt node south-west of the bus + stub to west handle', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      shunts: [shunt('SH1', 1)],
    });
    const { nodes, edges } = buildGraph(topology, { '1': { x: 100, y: 100 } });
    const shuntNode = nodes.find((n) => n.type === 'shunt');
    expect(shuntNode).toBeDefined();
    expect(shuntNode?.position.x).toBeLessThan(100); // west of bus
    const stub = edges.find((e) => e.id === 'stub-shunt-SH1');
    expect(stub?.targetHandle).toBe('west-target');
  });

  it('routes transformers as edges (not nodes) with type=transformer', () => {
    const topology = makeTopology({
      buses: [bus(1), bus(2)],
      transformers: [trafo('T12', 1, 2)],
    });
    const { nodes, edges } = buildGraph(topology, {
      '1': { x: 0, y: 100 },
      '2': { x: 200, y: 100 },
    });
    expect(nodes.find((n) => n.type === 'transformer')).toBeUndefined();
    const trafoEdge = edges.find((e) => e.id === 'transformer-T12');
    expect(trafoEdge?.type).toBe('transformer');
    expect((trafoEdge?.data as { winding?: string })?.winding).toBe('2w');
  });

  it('marks Trafo3 transformer edges with the 3w winding flag', () => {
    const topology = makeTopology({
      buses: [bus(1), bus(2)],
      transformers: [
        { idx: 'T3', name: 't3', kind: 'Trafo3', params: { bus1: 1, bus2: 2 } },
      ],
    });
    const { edges } = buildGraph(topology, {
      '1': { x: 0, y: 100 },
      '2': { x: 200, y: 100 },
    });
    const trafoEdge = edges.find((e) => e.id === 'transformer-T3');
    expect((trafoEdge?.data as { winding?: string })?.winding).toBe('3w');
  });

  describe('defensive paths', () => {
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('skips a generator referencing a missing bus + warns', () => {
      const topology = makeTopology({
        buses: [bus(1)],
        generators: [gen('G_orphan', 99)],
      });
      const { nodes } = buildGraph(topology, { '1': { x: 0, y: 0 } });
      expect(nodes.find((n) => n.type === 'generator')).toBeUndefined();
      expect(console.warn).toHaveBeenCalled();
    });

    it('skips a generator with no bus param', () => {
      const topology = makeTopology({
        buses: [bus(1)],
        generators: [{ idx: 'G_noisy', name: 'g', kind: 'PV', params: {} }],
      });
      const { nodes } = buildGraph(topology, { '1': { x: 0, y: 0 } });
      expect(nodes.find((n) => n.type === 'generator')).toBeUndefined();
      expect(console.warn).toHaveBeenCalled();
    });
  });

  it('honors sidecar non_bus_coordinates overrides', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('GEN_1', 1)],
    });
    const nonBusCoords = new Map([
      ['PV|GEN_1', { x: 500, y: 600 }],
    ]);
    const { nodes } = buildGraph(
      topology,
      { '1': { x: 0, y: 100 } },
      { nonBusCoords },
    );
    const genNode = nodes.find((n) => n.type === 'generator');
    expect(genNode?.position).toEqual({ x: 500, y: 600 });
  });
});
