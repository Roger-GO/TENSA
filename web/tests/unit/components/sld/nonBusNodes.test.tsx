/**
 * Non-bus node emission (Unit 3).
 *
 * Verifies that `buildGraph` produces React Flow nodes for generators,
 * loads, and shunts anchored to their parent bus, plus stub edges
 * connecting each non-bus node to its bus, and that a device the layout
 * does not place is put over a free part of the bar, clear of the branches
 * that pass through its row. Transformers stay as edges (TransformerEdge) —
 * these tests cover that they don't accidentally emit a node.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  branchColumns,
  buildGraph,
  busRoom,
  defaultBarLengths,
  deviceBoxSize,
  freeColumn,
  readoutPlaces,
  DEVICE_COLUMN_GAP,
  DEVICE_COLUMN_OFFSET,
  DEVICE_DETOUR_LIMIT,
  DEVICE_ROW_OFFSET,
  DEVICE_VALUE_LABEL,
  NODE_FOOTPRINT,
  UNIT_CHAIN_GAP,
  UNIT_CHIP_SLOTS,
  chooseChainSide,
  unitBoxSize,
  unitChainPlaces,
  unitChainSize,
  unitChips,
  type ChainSide,
  type UnitNodeData,
} from '@/components/sld/graph';
import type { UnitMemberInfo } from '@/lib/generatingUnits';
import { TAP_SPACING, layoutConnections } from '@/components/sld/connections';
import type { TopologySummary, TopologyEntry } from '@/api/types';

function bus(idx: number | string, name = `b${idx}`): TopologyEntry {
  return { idx, name, kind: 'Bus', params: {} };
}

function gen(idx: number | string, busIdx: number | string, kind = 'PV'): TopologyEntry {
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
    controllers: opts.controllers ?? [],
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
    // From the port on the face of the device that looks at the bus.
    expect(stub?.sourceHandle).toBe('port-south');
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
    expect(stub?.sourceHandle).toBe('port-north');
    expect(stub?.targetHandle).toBe('south-target');
  });

  it('emits a shunt node south of the bus, under the bar like a load', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      shunts: [shunt('SH1', 1)],
    });
    const { nodes, edges } = buildGraph(topology, { '1': { x: 100, y: 100 } });
    const shuntNode = nodes.find((n) => n.type === 'shunt');
    expect(shuntNode).toBeDefined();
    expect(shuntNode?.position.y).toBe(100 + DEVICE_ROW_OFFSET);
    const stub = edges.find((e) => e.id === 'stub-shunt-SH1');
    expect(stub?.targetHandle).toBe('south-target');
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
      transformers: [{ idx: 'T3', name: 't3', kind: 'Trafo3', params: { bus1: 1, bus2: 2 } }],
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

    it('draws the static load a dynamic load takes over, and says nothing of the dynamic one', () => {
      // ANDES's ZIP names a PQ (`pq`) and has no bus: it is that load's model.
      const topology = makeTopology({
        buses: [bus(1)],
        loads: [
          load('PQ_1', 1),
          { idx: 'ZIP_1', name: 'ZIP_1', kind: 'ZIP', params: { pq: 'PQ_1', kpp: 100 } },
        ],
      });
      const { nodes } = buildGraph(topology, { '1': { x: 0, y: 0 } });
      expect(nodes.filter((n) => n.type === 'load').map((n) => n.id)).toEqual(['load-PQ_1']);
      expect(console.warn).not.toHaveBeenCalled();
    });

    it('still warns about a load that has no bus and names no load', () => {
      const topology = makeTopology({
        buses: [bus(1)],
        loads: [{ idx: 'L_noisy', name: 'l', kind: 'PQ', params: {} }],
      });
      const { nodes } = buildGraph(topology, { '1': { x: 0, y: 0 } });
      expect(nodes.find((n) => n.type === 'load')).toBeUndefined();
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

  it('anchors a device to its parent bus DRAG OVERRIDE, not the stale layout coord', () => {
    // When the user drags a bus, the bus renders at its drag override
    // (not the auto-layout `coords` position). A generator on that bus
    // must follow the bar — otherwise moving a bus strands its devices
    // at the old grid position and they scatter off-canvas.
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('GEN_1', 1)],
    });
    const { nodes } = buildGraph(
      topology,
      { '1': { x: 0, y: 100 } },
      { dragOverrides: { '1': { x: 900, y: 500 } } },
    );
    const genNode = nodes.find((n) => n.type === 'generator');
    expect(genNode).toBeDefined();
    // Generator sits just NORTH of the bus's *moved* position (≈900,500),
    // not anchored near the original (0,100).
    expect(Math.abs((genNode?.position.x ?? 0) - 900)).toBeLessThan(45);
    expect(genNode?.position.y).toBeLessThan(500); // north of the moved bus
    expect(genNode?.position.y).toBeGreaterThan(380); // …but near it, not at y≈100
  });

  it('hangs a generator on the side facing AWAY from the bus branch neighbour', () => {
    // Bus 1 sits BELOW bus 2 (its only branch neighbour), so its machine
    // should hang SOUTH (down, away from the network) — not north through
    // the line it feeds. The mirror bus (2, above its neighbour) keeps its
    // generator north.
    const topology = makeTopology({
      buses: [bus(1), bus(2)],
      transformers: [trafo('T12', 1, 2)],
      generators: [gen('G1', 1), gen('G2', 2)],
    });
    const { nodes } = buildGraph(topology, {
      '1': { x: 0, y: 500 }, // bottom bus
      '2': { x: 0, y: 100 }, // top bus
    });
    const g1 = nodes.find((n) => n.id === 'generator-G1');
    const g2 = nodes.find((n) => n.id === 'generator-G2');
    expect(g1?.position.y).toBeGreaterThan(500); // south of the bottom bus
    expect(g2?.position.y).toBeLessThan(100); // north of the top bus
  });

  describe('PF result key and readout side (what the P / Q labels read)', () => {
    type DeviceData = { pflowIdx?: string | null; valueSide?: string };
    type SldData = { parentBus?: string };
    const dataOf = (nodes: { id: string; data: unknown }[], id: string): DeviceData =>
      nodes.find((n) => n.id === id)?.data as DeviceData;
    const machine = (
      idx: string,
      busIdx: number,
      genIdx?: number | string,
      kind = 'GENROU',
    ): TopologyEntry => ({
      idx,
      name: `m-${idx}`,
      kind,
      params: genIdx === undefined ? { bus: busIdx } : { bus: busIdx, gen: genIdx },
    });

    it('keys a static generator and a load by their own idx', () => {
      const topology = makeTopology({
        buses: [bus(1)],
        generators: [gen('GEN_1', 1)],
        loads: [load('PQ_1', 1)],
      });
      const { nodes } = buildGraph(topology, { '1': { x: 0, y: 100 } });
      expect(dataOf(nodes, 'generator-GEN_1').pflowIdx).toBe('GEN_1');
      expect(dataOf(nodes, 'load-PQ_1').pflowIdx).toBe('PQ_1');
    });

    it('keys a dynamic machine by the static generator named in its gen link', () => {
      // PF reports the machine under the static generator, not under the
      // machine's own idx (it has no row of its own).
      const topology = makeTopology({
        buses: [bus(1)],
        generators: [machine('GENROU_1', 1, 2)],
      });
      const { nodes } = buildGraph(topology, { '1': { x: 0, y: 100 } });
      expect(dataOf(nodes, 'generator-GENROU_1').pflowIdx).toBe('2');
    });

    it('falls back to the machine idx when it names no static generator', () => {
      const topology = makeTopology({
        buses: [bus(1)],
        generators: [machine('GENROU_1', 1)],
      });
      const { nodes } = buildGraph(topology, { '1': { x: 0, y: 100 } });
      expect(dataOf(nodes, 'generator-GENROU_1').pflowIdx).toBe('GENROU_1');
    });

    it('draws a machine and the static generator it shares an idx with as one node, on the static row', () => {
      // kundur_full numbers PV/Slack and GENROU alike (1..4). The two are one
      // unit, drawn once, which reads the static row under `1`.
      const topology = makeTopology({
        buses: [bus(1)],
        generators: [
          { idx: 1, name: 'slack', kind: 'Slack', params: { bus: 1 } },
          { idx: 1, name: 'm1', kind: 'GENROU', params: { bus: 1, gen: 1 } },
        ],
      });
      const { nodes } = buildGraph(topology, { '1': { x: 0, y: 100 } });
      const gens = nodes.filter((n) => n.type === 'generator');
      expect(gens).toHaveLength(1);
      // The node is the static generator's, with the name the case gives it.
      expect(gens[0]?.data).toMatchObject({ kind: 'Slack', name: 'slack', symbolKind: 'GENROU' });
      expect(dataOf(nodes, 'generator-1').pflowIdx).toBe('1');
    });

    it('draws a static generator and the machine that names it as one node', () => {
      // ieee14_full numbers its machines GENROU_1..5, so the static PV 2 and
      // GENROU_2 have different idx values. They are still one generator:
      // one node, under the idx of the static one, which prints the row.
      const topology = makeTopology({
        buses: [bus(2)],
        generators: [gen('2', 2), machine('GENROU_2', 2, 2)],
      });
      const { nodes, edges } = buildGraph(topology, { '2': { x: 0, y: 100 } });
      expect(nodes.filter((n) => n.type === 'generator').map((n) => n.id)).toEqual(['generator-2']);
      expect(edges.filter((e) => e.type === 'stub').map((e) => e.id)).toEqual(['stub-generator-2']);
      expect(dataOf(nodes, 'generator-2').pflowIdx).toBe('2');
    });

    it('takes two machines that name the same static generator into one node', () => {
      const topology = makeTopology({
        buses: [bus(1)],
        generators: [gen('2', 1), machine('GENROU_1', 1, 2), machine('GENCLS_1', 1, '2', 'GENCLS')],
      });
      const { nodes } = buildGraph(topology, { '1': { x: 0, y: 100 } });
      expect(nodes.filter((n) => n.type === 'generator').map((n) => n.id)).toEqual(['generator-2']);
      expect(dataOf(nodes, 'generator-2').pflowIdx).toBe('2');
      const unit = (nodes.find((n) => n.id === 'generator-2')!.data as { unit: UnitNodeData }).unit;
      expect(unit.members.map((m) => `${m.kind} ${m.idx}`)).toEqual([
        'PV 2',
        'GENROU GENROU_1',
        'GENCLS GENCLS_1',
      ]);
    });

    it('draws a machine apart when the generator it names is on another bus, and prints the row once', () => {
      // The machine says it is on bus 2, so that is where it is drawn. Its
      // generator has a symbol of its own on bus 1, which prints the row.
      const topology = makeTopology({
        buses: [bus(1), bus(2)],
        generators: [gen('1', 1), machine('GENROU_1', 2, 1)],
      });
      const { nodes } = buildGraph(topology, {
        '1': { x: 0, y: 100 },
        '2': { x: 300, y: 100 },
      });
      expect(dataOf(nodes, 'generator-1').pflowIdx).toBe('1');
      expect(dataOf(nodes, 'generator-GENROU_1').pflowIdx).toBeNull();
      expect((nodes.find((n) => n.id === 'generator-GENROU_1')!.data as SldData).parentBus).toBe(
        '2',
      );
    });

    it('still prints a static generator that no machine names', () => {
      const topology = makeTopology({
        buses: [bus(1), bus(2)],
        generators: [gen('1', 1), gen('2', 2), machine('GENROU_2', 2, 2)],
      });
      const { nodes } = buildGraph(topology, {
        '1': { x: 0, y: 100 },
        '2': { x: 300, y: 100 },
      });
      expect(dataOf(nodes, 'generator-1').pflowIdx).toBe('1');
      expect(dataOf(nodes, 'generator-2').pflowIdx).toBe('2');
    });

    it('prints every generator_outputs row exactly once on an ieee14_full-shaped case', () => {
      // Five static generators on buses 1, 2, 3, 6 and 8, each with a machine
      // of its own idx on the same bus: five units, five nodes, five rows.
      const onBus = [1, 2, 3, 6, 8];
      const topology = makeTopology({
        buses: onBus.map((b) => bus(b)),
        generators: [
          ...onBus.map((b, i) => gen(String(i + 1), b, i === 0 ? 'Slack' : 'PV')),
          ...onBus.map((b, i) => machine(`GENROU_${i + 1}`, b, i + 1)),
        ],
        loads: [load('PQ_1', 2), load('PQ_2', 3)],
      });
      const coords = Object.fromEntries(onBus.map((b, i) => [String(b), { x: i * 200, y: 100 }]));
      const { nodes } = buildGraph(topology, coords);
      const printed = nodes
        .filter((n) => n.type === 'generator')
        .map((n) => dataOf([n], n.id).pflowIdx)
        .filter((key): key is string => typeof key === 'string');
      expect(nodes.filter((n) => n.type === 'generator')).toHaveLength(5);
      expect([...printed].sort()).toEqual(['1', '2', '3', '4', '5']);
      // Loads each print their own row.
      expect(dataOf(nodes, 'load-PQ_1').pflowIdx).toBe('PQ_1');
      expect(dataOf(nodes, 'load-PQ_2').pflowIdx).toBe('PQ_2');
    });

    it('puts the readout on the side facing the bus: below a node above its bus', () => {
      const topology = makeTopology({
        buses: [bus(1)],
        generators: [gen('GEN_1', 1)],
        loads: [load('PQ_1', 1)],
      });
      const { nodes } = buildGraph(topology, { '1': { x: 0, y: 100 } });
      // The generator hangs north of the bus, the load south of it.
      expect(dataOf(nodes, 'generator-GEN_1').valueSide).toBe('below');
      expect(dataOf(nodes, 'load-PQ_1').valueSide).toBe('above');
    });

    it('flips the readout side for a bus that sits below its branch neighbour', () => {
      const topology = makeTopology({
        buses: [bus(1), bus(2)],
        transformers: [trafo('T12', 1, 2)],
        generators: [gen('G1', 1), gen('G2', 2)],
        loads: [load('L1', 1), load('L2', 2)],
      });
      const { nodes } = buildGraph(topology, {
        '1': { x: 0, y: 500 }, // bottom bus: devices hang south, bus above them
        '2': { x: 0, y: 100 }, // top bus: devices hang north, bus below them
      });
      expect(dataOf(nodes, 'generator-G1').valueSide).toBe('above');
      expect(dataOf(nodes, 'load-L1').valueSide).toBe('above');
      expect(dataOf(nodes, 'generator-G2').valueSide).toBe('below');
      expect(dataOf(nodes, 'load-L2').valueSide).toBe('below');
    });

    it('follows a device the user dragged to the other side of its bus', () => {
      // The stub still targets the bus face the device was built for, but the
      // readout goes where the device now sits relative to the bus.
      const topology = makeTopology({
        buses: [bus(1)],
        generators: [gen('GEN_1', 1)],
        loads: [load('PQ_1', 1)],
      });
      const coords = { '1': { x: 0, y: 100 } };
      const dragOverrides = {
        'generator-GEN_1': { x: 0, y: 260 }, // generator moved below the bus
        'load-PQ_1': { x: 0, y: -60 }, // load moved above it
      };
      const { nodes } = buildGraph(topology, coords, { dragOverrides });
      expect(dataOf(nodes, 'generator-GEN_1').valueSide).toBe('above');
      expect(dataOf(nodes, 'load-PQ_1').valueSide).toBe('below');
    });

    it('puts the readout on the far side of a device that hangs close under its bus', () => {
      // Under a bus, the strip between the two is where the label of the
      // bus hangs. The default row leaves room for both; nearer than that
      // the readout goes below the device.
      const topology = makeTopology({ buses: [bus(1)], loads: [load('PQ_1', 1)] });
      const coords = { '1': { x: 0, y: 100 } };
      const at = (y: number) =>
        buildGraph(topology, coords, { dragOverrides: { 'load-PQ_1': { x: 0, y } } }).nodes;
      expect(dataOf(at(100 + DEVICE_ROW_OFFSET), 'load-PQ_1').valueSide).toBe('above');
      expect(dataOf(at(100 + DEVICE_ROW_OFFSET - 1), 'load-PQ_1').valueSide).toBe('below');
      expect(dataOf(at(120), 'load-PQ_1').valueSide).toBe('below');
      // Above its bus the readout faces the bus however near the device is.
      expect(dataOf(at(40), 'load-PQ_1').valueSide).toBe('below');
    });

    it('follows a sidecar position and a moved bus', () => {
      const topology = makeTopology({
        buses: [bus(1)],
        generators: [gen('GEN_1', 1)],
      });
      const nonBusCoords = new Map([['PV|GEN_1', { x: 0, y: 400 }]]);
      const sidecar = buildGraph(topology, { '1': { x: 0, y: 100 } }, { nonBusCoords });
      expect(dataOf(sidecar.nodes, 'generator-GEN_1').valueSide).toBe('above');
      // The bus itself dragged below the generator's default spot.
      const moved = buildGraph(
        topology,
        { '1': { x: 0, y: 100 } },
        { dragOverrides: { '1': { x: 0, y: 600 } } },
      );
      expect(dataOf(moved.nodes, 'generator-GEN_1').valueSide).toBe('below');
    });

    it('hangs the readout in the strip between a device and its bus', () => {
      // The strip is free by construction: the default offsets leave it
      // between the footprint and the bus, so a node placed there collides
      // with nothing. Check the readout box against both.
      const topology = makeTopology({
        buses: [bus(1)],
        generators: [gen('GEN_1', 1)],
        loads: [load('PQ_1', 1)],
      });
      const bus1 = { x: 0, y: 400 };
      const { nodes } = buildGraph(topology, { '1': bus1 });
      const g = nodes.find((n) => n.id === 'generator-GEN_1')!;
      const l = nodes.find((n) => n.id === 'load-PQ_1')!;
      // Generator above the bus: readout below the node, above the bus bar.
      const genBottom = g.position.y + NODE_FOOTPRINT.generator.height;
      expect(genBottom + DEVICE_VALUE_LABEL.height).toBeLessThanOrEqual(bus1.y);
      // Load below the bus: readout above the node, under the bus box.
      expect(l.position.y - DEVICE_VALUE_LABEL.height).toBeGreaterThanOrEqual(
        bus1.y + NODE_FOOTPRINT.bus.height,
      );
    });
  });

  it('honors sidecar non_bus_coordinates overrides', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('GEN_1', 1)],
    });
    const nonBusCoords = new Map([['PV|GEN_1', { x: 500, y: 600 }]]);
    const { nodes } = buildGraph(topology, { '1': { x: 0, y: 100 } }, { nonBusCoords });
    const genNode = nodes.find((n) => n.type === 'generator');
    expect(genNode?.position).toEqual({ x: 500, y: 600 });
  });

  describe('where a saved layout puts a generating unit', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [
        gen('2', 1),
        { idx: 'GENROU_2', name: 'GENROU_2', kind: 'GENROU', params: { bus: 1, gen: 2 } },
      ],
    });
    const unitAt = (nonBusCoords: Map<string, { x: number; y: number }>) =>
      buildGraph(topology, { '1': { x: 0, y: 100 } }, { nonBusCoords }).nodes.find(
        (n) => n.id === 'generator-2',
      )?.position;

    it('is where the layout has its static generator, under its model or as a generator', () => {
      expect(unitAt(new Map([['PV|2', { x: 500, y: 600 }]]))).toEqual({ x: 500, y: 600 });
      expect(unitAt(new Map([['generator|2', { x: 510, y: 610 }]]))).toEqual({ x: 510, y: 610 });
    });

    it('is where the layout has its machine when it has no place for the generator', () => {
      // A layout saved while the two were two symbols may place only the
      // machine: the unit takes that place, and is not laid out afresh.
      expect(unitAt(new Map([['generator|GENROU_2', { x: 300, y: -40 }]]))).toEqual({
        x: 300,
        y: -40,
      });
      expect(unitAt(new Map([['GENROU|GENROU_2', { x: 310, y: -50 }]]))).toEqual({
        x: 310,
        y: -50,
      });
    });

    it('prefers the place of the generator to that of its machine', () => {
      const both = new Map([
        ['generator|GENROU_2', { x: 300, y: -40 }],
        ['generator|2', { x: 510, y: 610 }],
      ]);
      expect(unitAt(both)).toEqual({ x: 510, y: 610 });
    });
  });
});

/**
 * Pre-measure size hints (MiniMap fix).
 *
 * RF v12's MiniMap only draws a rect for a node whose user object carries
 * dimensions; nodes built with only `{id,type,position,data}` measure 0 and
 * are filtered out, leaving the minimap white. `buildGraph` now seeds
 * `initialWidth`/`initialHeight` on every node so a rect renders before the
 * DOM measures the real glyph. These are *initial* hints (dropped after
 * measurement), not `width`/`height`, so the glyph/handles aren't pinned.
 */
describe('buildGraph — minimap size hints', () => {
  type SizedNode = { initialWidth?: unknown; initialHeight?: unknown };

  it('emits numeric initialWidth/initialHeight > 0 on every node kind', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('GEN_1', 1)],
      loads: [load('PQ_1', 1)],
      shunts: [shunt('SH1', 1)],
      // An exciter on the generator, so the generator is sized as a unit,
      // and a PMU on the bus, so a controller badge node is emitted.
      controllers: [
        { idx: 'AVR1', name: 'avr-1', kind: 'EXST1', params: { syn: 'GEN_1' } },
        { idx: 'PMU_1', name: 'pmu-1', kind: 'PMU', params: { bus: 1 } },
      ],
    });
    const { nodes } = buildGraph(topology, { '1': { x: 0, y: 100 } });

    // All five node kinds must be present so the assertion below covers each.
    const kinds = new Set(nodes.map((n) => n.type));
    expect(kinds).toEqual(new Set(['bus', 'generator', 'load', 'shunt', 'controller']));

    for (const n of nodes) {
      const sized = n as SizedNode;
      expect(typeof sized.initialWidth, `${n.type} ${n.id} initialWidth`).toBe('number');
      expect(typeof sized.initialHeight, `${n.type} ${n.id} initialHeight`).toBe('number');
      expect(sized.initialWidth as number).toBeGreaterThan(0);
      expect(sized.initialHeight as number).toBeGreaterThan(0);
    }
  });

  it('uses NODE_FOOTPRINT for a bus, and the box its label gives for a device', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('GEN_1', 1)],
      loads: [load('PQ_1', 1)],
      shunts: [shunt('SH1', 1)],
    });
    const { nodes } = buildGraph(topology, { '1': { x: 0, y: 100 } });
    const sized = (type: string) => nodes.find((n) => n.type === type) as SizedNode | undefined;

    expect(sized('bus')?.initialWidth).toBe(NODE_FOOTPRINT.bus.width);
    expect(sized('bus')?.initialHeight).toBe(NODE_FOOTPRINT.bus.height);
    // The helpers above name a device `<kind>-<idx>`.
    expect(sized('generator')).toMatchObject({
      initialWidth: deviceBoxSize('gen-GEN_1').width,
      initialHeight: 41,
    });
    expect(sized('load')?.initialWidth).toBe(deviceBoxSize('load-PQ_1').width);
    expect(sized('shunt')?.initialWidth).toBe(deviceBoxSize('shunt-SH1').width);
  });

  it('sizes controller badges with the 28×28 glyph footprint', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('GEN_1', 1)],
      controllers: [{ idx: 'PMU_1', name: 'pmu-1', kind: 'PMU', params: { bus: 1 } }],
    });
    const { nodes } = buildGraph(topology, { '1': { x: 0, y: 100 } });
    const ctrl = nodes.find((n) => n.type === 'controller') as SizedNode | undefined;
    expect(ctrl).toBeDefined();
    expect(ctrl?.initialWidth).toBe(28);
    expect(ctrl?.initialHeight).toBe(28);
  });
});

describe('deviceBoxSize', () => {
  it('is as wide as the glyph for a short label and as the text for a long one', () => {
    // What the nodes measure in the browser: 38 for "2", 41 for "PQ_10", 57 for "GENROU_3".
    expect(deviceBoxSize('2')).toEqual({ width: 38, height: 41 });
    expect(deviceBoxSize('PQ_10')).toEqual({ width: 41, height: 41 });
    expect(deviceBoxSize('GENROU_3')).toEqual({ width: 57, height: 41 });
  });
});

describe('unitBoxSize', () => {
  const member = (kind: string, role: UnitMemberInfo['role']): UnitMemberInfo => ({
    kind,
    idx: `${kind}_1`,
    name: `${kind}_1`,
    role,
    nodeId: `controller-${kind}-${kind}_1`,
    depth: 1,
  });
  const root = member('PV', 'generator');

  it('is the box of any device for a unit of one model', () => {
    expect(unitBoxSize('2', [root])).toEqual(deviceBoxSize('2'));
    expect(unitBoxSize('GENROU_3', [root])).toEqual(deviceBoxSize('GENROU_3'));
  });

  it('is as high as any device, and as wide as the symbol with a chip on either side', () => {
    // `SG` and `GOV`: the wider chip is 3 letters of 4.8 in 6 of border and
    // padding, 3 from the 24 of the symbol, and each side is as wide as it.
    const size = unitBoxSize('2', [root, member('GENROU', 'machine'), member('TGOV1', 'governor')]);
    expect(size).toEqual({ width: Math.round(24 + 2 * (3 * 4.8 + 6 + 3) + 14), height: 41 });
  });

  it('is no wider for a second chip on a side, which stands under the first', () => {
    const two = [root, member('GENROU', 'machine'), member('TGOV1', 'governor')];
    const four = [...two, member('EXST1', 'exciter'), member('IEEEST', 'pss')];
    expect(unitBoxSize('2', four)).toEqual(unitBoxSize('2', two));
  });

  it('is as wide as its widest chip needs: the four letters of a converter stage', () => {
    const narrow = unitBoxSize('2', [root, member('GENROU', 'machine')]);
    const wide = unitBoxSize('2', [root, member('REGCA1', 'renewable')]);
    expect(wide.width).toBeGreaterThan(narrow.width);
    expect(wide.height).toBe(41);
  });

  it('is as wide as a long name needs, with room at its end for the control that draws the chain out', () => {
    const name = 'A_GENERATOR_WITH_A_LONG_NAME';
    const size = unitBoxSize(name, [root, member('GENROU', 'machine')]);
    expect(size.width).toBe(Math.round(5.4 * name.length + 20 + 14));
  });
});

describe('unitChips', () => {
  const members = (n: number): UnitMemberInfo[] =>
    Array.from({ length: n + 1 }, (_, i) => ({
      kind: i === 0 ? 'PV' : `M${i}`,
      idx: String(i),
      name: String(i),
      role: i === 0 ? ('generator' as const) : ('other' as const),
      nodeId: `controller-M${i}-${i}`,
      depth: i === 0 ? 0 : 1,
    }));

  it('gives every model after the first a chip while they fit', () => {
    expect(unitChips(members(0))).toEqual({ chips: [], more: 0 });
    expect(unitChips(members(4)).chips.map((m) => m.idx)).toEqual(['1', '2', '3', '4']);
    expect(unitChips(members(4)).more).toBe(0);
  });

  it('keeps the last place to say how many it leaves out', () => {
    const { chips, more } = unitChips(members(6));
    expect(chips.map((m) => m.idx)).toEqual(['1', '2', '3']);
    expect(more).toBe(3);
    expect(chips.length + 1).toBe(UNIT_CHIP_SLOTS);
  });
});

describe('the place of a control chain that is drawn out', () => {
  const member = (
    kind: string,
    idx: string,
    role: UnitMemberInfo['role'],
    depth: number,
  ): UnitMemberInfo => ({ kind, idx, name: idx, role, nodeId: `${kind}-${idx}`, depth });
  const members = [
    member('PV', '2', 'generator', 0),
    member('GENROU', 'GENROU_2', 'machine', 1),
    member('EXST1', 'EXST1_1', 'exciter', 2),
    member('TGOV1', 'TGOV1_2', 'governor', 2),
  ];

  it('takes a row per model, and is as wide as its longest row', () => {
    const size = unitChainSize(members);
    expect(size.height).toBe(4 * 13 + 6);
    // `└ EXST1 EXST1_1 … AVR`, set in by 8: 12 letters of 5.4, the mark, the
    // chip and the gaps. (The machine's row has more letters and is narrower.)
    expect(size.width).toBe(Math.round(12 + 9.4 + 5.4 * 12 + 4 + (8 + 14.4 + 4) + 4 + 6));
    // A model one deeper is set in by 8 more.
    const deeper = unitChainSize([...members, member('IEEEST', 'IEEEST_LONG_1', 'pss', 3)]);
    expect(deeper.height).toBe(5 * 13 + 6);
    expect(deeper.width).toBe(Math.round(20 + 9.4 + 5.4 * 19 + 4 + (8 + 14.4 + 4) + 4 + 6));
  });

  it('stands against the middle of each side of the symbol, a gap from it', () => {
    const places = unitChainPlaces(
      { x: 100, y: 200, width: 80, height: 40 },
      { width: 120, height: 60 },
    );
    expect(places.above).toEqual({ left: 80, right: 200, top: 136, bottom: 196 });
    expect(places.below).toEqual({ left: 80, right: 200, top: 244, bottom: 304 });
    expect(places.left).toEqual({ left: -24, right: 96, top: 190, bottom: 250 });
    expect(places.right).toEqual({ left: 184, right: 304, top: 190, bottom: 250 });
    expect(UNIT_CHAIN_GAP).toBe(4);
  });

  describe('chooseChainSide', () => {
    const places = unitChainPlaces(
      { x: 100, y: 200, width: 80, height: 40 },
      { width: 120, height: 60 },
    );
    const covering =
      (counts: Partial<Record<ChainSide, number>>) =>
      (place: { left: number; top: number }): number => {
        const side = (Object.keys(places) as ChainSide[]).find(
          (key) => places[key].left === place.left && places[key].top === place.top,
        )!;
        return counts[side] ?? 0;
      };

    it('goes away from the bus when nothing is in the way there', () => {
      expect(chooseChainSide('above', places, covering({}))).toBe('above');
      expect(chooseChainSide('below', places, covering({ left: 3, right: 3 }))).toBe('below');
    });

    it('goes beside the symbol when something stands on the far side: the right first, then the left', () => {
      expect(chooseChainSide('above', places, covering({ above: 2 }))).toBe('right');
      expect(chooseChainSide('above', places, covering({ above: 2, right: 1 }))).toBe('left');
    });

    it('takes the side that covers the least when none is free, the far side on a tie', () => {
      expect(chooseChainSide('above', places, covering({ above: 3, right: 1, left: 2 }))).toBe(
        'right',
      );
      expect(chooseChainSide('above', places, covering({ above: 1, right: 1, left: 1 }))).toBe(
        'above',
      );
    });

    it('never goes on the side of the bus, however free that is', () => {
      const asked: unknown[] = [];
      const side = chooseChainSide('above', places, (place) => {
        asked.push(place);
        return 5;
      });
      expect(side).not.toBe('below');
      expect(asked).not.toContain(places.below);
    });
  });
});

describe('freeColumn', () => {
  const lo = 3;
  const hi = 89;
  const middle = 46;

  it('takes the place it prefers when nothing is in the way', () => {
    expect(freeColumn(79, 19, [], lo, hi, middle)).toBe(79);
  });

  it('stands a gap clear of a branch that lands there', () => {
    // A branch at 60: a box 19 either side has its edge 8 from the line.
    const x = freeColumn(60, 19, [{ x: 60, half: 0 }], lo, hi, middle);
    expect(Math.abs(x - 60)).toBe(19 + DEVICE_COLUMN_GAP);
    // Of the two sides, the one closer to the middle of the bar.
    expect(x).toBe(33);
  });

  it('stands beside a device that is already there', () => {
    const x = freeColumn(79, 19, [{ x: 79, half: 19 }], lo, hi, middle);
    expect(x).toBe(79 - (19 + 19 + DEVICE_COLUMN_GAP));
  });

  it('prefers a place over the bar to a nearer one past its tip', () => {
    // 84 is nearer (taken: 30..68 by a wide device), but past the tip; 3 is on the bar.
    const taken = [{ x: 49, half: 19 }];
    const x = freeColumn(60, 6, taken, lo, hi, middle);
    expect(x).toBe(82);
    // With the right side taken too, it goes to the left end of the bar
    // though the place past the right tip is nearer.
    const crowded = [...taken, { x: 82, half: 6 }];
    expect(freeColumn(60, 6, crowded, lo, hi, middle)).toBe(49 - (19 + 6 + DEVICE_COLUMN_GAP));
  });

  it('goes past a tip when the bar is full', () => {
    const taken = [
      { x: 20, half: 19 },
      { x: 66, half: 19 },
    ];
    const x = freeColumn(66, 19, taken, lo, hi, middle);
    expect(x).toBe(66 + 19 + 19 + DEVICE_COLUMN_GAP);
  });

  it('stands a tap spacing clear of a tap of the other face, never in line with it', () => {
    // A tap under the bar at 72, 7 from the place it prefers: in line with
    // it the two connectors would read as one line through the bus, so it
    // stands a spacing past it (86), the nearer of the two such places.
    expect(freeColumn(79, 19, [], lo, hi, middle, [72])).toBe(72 + TAP_SPACING);
    expect(freeColumn(79, 19, [{ x: 58, half: 0 }], lo, hi, middle, [72])).toBe(72 + TAP_SPACING);
    // A tap that is a spacing away already leaves it where it prefers.
    expect(freeColumn(79, 19, [], lo, hi, middle, [79 - TAP_SPACING])).toBe(79);
    // One right under it moves it a spacing, to the side nearer the middle of the bar.
    expect(freeColumn(79, 19, [], lo, hi, middle, [79])).toBe(79 - TAP_SPACING);
  });

  it('does not look at the other face for a place past a tip, where the connector lands on the tip', () => {
    // The bar is full, and the nearest free place is past its tip (112). A
    // tap of the other face 7 from there does not move it...
    const taken = [
      { x: 20, half: 19 },
      { x: 66, half: 19 },
    ];
    expect(freeColumn(66, 19, taken, lo, 96, middle, [105])).toBe(112);
    // ...as it does on a bar long enough for that place to be over it.
    expect(freeColumn(66, 19, taken, lo, 120, middle, [105])).toBe(105 + TAP_SPACING);
  });
});

describe('readoutPlaces', () => {
  it('gives the place left of the connector and the one right of it, in the strip the readout hangs in', () => {
    // A device 38 by 41 at (100, 200): its connector leaves at 119.
    const box = { x: 100, y: 200, width: 38, height: 41 };
    const { width, height } = DEVICE_VALUE_LABEL;
    const below = readoutPlaces(box, 'below');
    expect(below.right).toEqual({ left: 123, right: 123 + width, top: 243, bottom: 243 + height });
    expect(below.left).toEqual({ left: 115 - width, right: 115, top: 243, bottom: 243 + height });
    const above = readoutPlaces(box, 'above');
    expect(above.right).toEqual({ left: 123, right: 123 + width, top: 198 - height, bottom: 198 });
    expect(above.left).toEqual({ left: 115 - width, right: 115, top: 198 - height, bottom: 198 });
    // The room it needs on the left: its place, and one more beyond it.
    expect(below.leftRoom).toEqual({ ...below.left, left: 115 - 2 * width });
    expect(above.leftRoom).toEqual({ ...above.left, left: 115 - 2 * width });
  });
});

describe('branchColumns', () => {
  /** One run, as the route of a branch. */
  const run = (a: [number, number], b: [number, number]) => ({ points: [a, b] });

  it('counts an upright run that passes through the row, as a column with no width', () => {
    const through = branchColumns([run([100, 0], [100, 300]), run([220, 300], [220, 120])]);
    expect(through(100, 141)).toEqual({
      upright: [
        { x: 100, half: 0 },
        { x: 220, half: 0 },
      ],
      level: [],
    });
  });

  it('counts an upright run that ends nearer to the row than the gap, and not one that ends the gap away', () => {
    const above = (to: number) => branchColumns([run([100, 0], [100, to])])(100, 141).upright;
    expect(above(100 - DEVICE_COLUMN_GAP)).toEqual([]);
    expect(above(100 - DEVICE_COLUMN_GAP + 1)).toEqual([{ x: 100, half: 0 }]);
    const below = (from: number) => branchColumns([run([100, from], [100, 400])])(100, 141).upright;
    expect(below(141 + DEVICE_COLUMN_GAP)).toEqual([]);
    expect(below(141 + DEVICE_COLUMN_GAP - 1)).toEqual([{ x: 100, half: 0 }]);
  });

  it('counts a level run that lies in the row over its whole length, and none above or below it', () => {
    const at = (y: number) => branchColumns([run([300, y], [380, y])])(100, 141).level;
    expect(at(120)).toEqual([{ x: 340, half: 40 }]);
    expect(at(101)).toEqual([{ x: 340, half: 40 }]);
    // On the edge of the row, or just outside it: a device cannot step out
    // from under a run without leaving its bus.
    expect(at(100)).toEqual([]);
    expect(at(141)).toEqual([]);
    expect(at(96)).toEqual([]);
  });

  it('finds the runs of every route, each once, however long the run and wherever the row', () => {
    // A run 5000 long, a route with a bend, and a run at an angle, which is no column.
    const through = branchColumns([
      run([40, -2000], [40, 3000]),
      {
        points: [
          [500, 1000],
          [500, 1100],
          [700, 1100],
        ],
      },
      run([0, 0], [300, 300]),
    ]);
    expect(through(-1500, -1459)).toEqual({ upright: [{ x: 40, half: 0 }], level: [] });
    expect(through(1080, 1121)).toEqual({
      upright: [
        { x: 40, half: 0 },
        { x: 500, half: 0 },
      ],
      level: [{ x: 600, half: 100 }],
    });
    expect(through(5000, 5041)).toEqual({ upright: [], level: [] });
  });
});

describe('buildGraph: where a device the layout does not place is put', () => {
  /** The middle of a device node's box along x. */
  const middleOf = (n: { position: { x: number }; initialWidth?: number }): number =>
    n.position.x + (n.initialWidth ?? 0) / 2;

  it('puts a single device over a third of the bar, by the row its bus is in', () => {
    const topology = makeTopology({ buses: [bus(1)], loads: [load('A', 1)] });
    const inRow = (y: number) =>
      buildGraph(topology, { '1': { x: 500, y } }).nodes.find((n) => n.id === 'load-A')!;
    // Row 0 goes right of the middle of the bar (46), row 1 left of it.
    expect(middleOf(inRow(0))).toBe(500 + 46 + DEVICE_COLUMN_OFFSET);
    expect(middleOf(inRow(100))).toBe(500 + 46 - DEVICE_COLUMN_OFFSET);
    expect(inRow(0).position.y).toBe(DEVICE_ROW_OFFSET);
    expect(inRow(100).position.y).toBe(100 + DEVICE_ROW_OFFSET);
  });

  it('drops the connector of a device it placed square onto the bar', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [gen('G', 1)],
      loads: [load('L', 1)],
      shunts: [shunt('S', 1)],
    });
    const { nodes, edges } = buildGraph(topology, { '1': { x: 0, y: 0 } });
    const { routes } = layoutConnections(nodes, edges);
    for (const id of ['stub-generator-G', 'stub-load-L', 'stub-shunt-S']) {
      const points = routes.get(id)!.points;
      expect(points, id).toHaveLength(2);
      expect(points[0]![0], id).toBe(points[1]![0]);
    }
  });

  it('keeps two devices on one face of a bus clear of each other, and over the bar', () => {
    const topology = makeTopology({
      buses: [bus(1)],
      loads: [
        { ...load('A', 1), name: 'A' },
        { ...load('B', 1), name: 'B' },
      ],
    });
    const { nodes } = buildGraph(topology, { '1': { x: 0, y: 0 } });
    const [a, b] = nodes.filter((n) => n.type === 'load');
    const width = deviceBoxSize('A').width;
    expect(Math.abs(middleOf(a!) - middleOf(b!))).toBeGreaterThanOrEqual(width + DEVICE_COLUMN_GAP);
    for (const n of [a!, b!]) {
      expect(middleOf(n)).toBeGreaterThanOrEqual(3);
      expect(middleOf(n)).toBeLessThanOrEqual(89);
    }
    // Side by side: one row.
    expect(a!.position.y).toBe(b!.position.y);
  });

  it('stands a device clear of a branch that lands on its side of the bar', () => {
    // Bus 2 sits between its two neighbours, so its load keeps the south
    // face, where the line down to bus 3 leaves from the middle of the bar.
    const topology = makeTopology({
      buses: [bus(1), bus(2), bus(3)],
      lines: [trafo('L12', 1, 2), trafo('L23', 2, 3)],
      loads: [{ ...load('WIDE', 2), name: 'a load with a long name' }],
    });
    const { nodes, edges } = buildGraph(topology, {
      '1': { x: 0, y: 0 },
      '2': { x: 0, y: 200 },
      '3': { x: 0, y: 400 },
    });
    const wide = nodes.find((n) => n.id === 'load-WIDE')!;
    expect(wide.position.y).toBe(200 + DEVICE_ROW_OFFSET);
    const { bars, routes } = layoutConnections(nodes, edges);
    // The line leaves the south face at a tap of its own (the line from above
    // has the middle of the bar on the north face, and the two keep apart).
    const line = routes.get('line-L23')!.points[0]!;
    expect(bars.get('2')!.taps).toContainEqual({ x: line[0], side: 'south' });
    // The box does not sit on the line: its near edge is a gap away from it.
    const half = wide.initialWidth! / 2;
    expect(Math.abs(middleOf(wide) - line[0])).toBeGreaterThanOrEqual(half + DEVICE_COLUMN_GAP);
  });

  it('stands a device in line with what lands on the other face of its bar, or a spacing clear of it', () => {
    // Bus 2 is between bus 1, straight above it, and bus 3, below and 52 to
    // the right. The line from above lands on its north face at 46, the line
    // down leaves its south face at 72, the middle of what the two bars
    // share. The generator goes above the bar and the load below it.
    const topology = makeTopology({
      buses: [bus(1), bus(2), bus(3)],
      lines: [trafo('L12', 1, 2), trafo('L23', 2, 3)],
      generators: [{ ...gen('G', 2), name: 'G' }],
      loads: [{ ...load('L', 2), name: 'L' }],
    });
    const { nodes, edges } = buildGraph(topology, {
      '1': { x: 0, y: 0 },
      '2': { x: 0, y: 200 },
      '3': { x: 52, y: 400 },
    });
    // The generator would stand over 79, 7 from the line under the bar; in
    // line with that it would be too close to the line that lands beside it.
    expect(middleOf(nodes.find((n) => n.id === 'generator-G')!)).toBe(72 + TAP_SPACING);
    // The load keeps clear of the line on its own face, and a spacing from
    // the line above the bar.
    expect(middleOf(nodes.find((n) => n.id === 'load-L')!)).toBe(46 - TAP_SPACING);
    const { bars, routes } = layoutConnections(nodes, edges);
    expect(bars.get('2')!.taps).toEqual([
      { x: 32, side: 'south' },
      { x: 46, side: 'north' },
      { x: 72, side: 'south' },
      { x: 86, side: 'north' },
    ]);
    for (const id of ['stub-generator-G', 'stub-load-L']) {
      const points = routes.get(id)!.points;
      expect(points[0]![0], id).toBe(points[1]![0]);
    }
  });

  it('connects a row of devices that is wider than the bar without running through any of them', () => {
    // Two generators and two loads, all above bus 1 because its line goes
    // down: more than stand over a bar of the default length.
    const topology = makeTopology({
      buses: [bus(1), bus(2)],
      lines: [trafo('L', 1, 2)],
      generators: [
        { ...gen('G0', 1), name: 'G0' },
        { ...gen('G1', 1), name: 'G1' },
      ],
      loads: [
        { ...load('PQ_0', 1), name: 'PQ_0' },
        { ...load('PQ_1', 1), name: 'PQ_1' },
      ],
    });
    const coords = { '1': { x: 0, y: 0 }, '2': { x: 0, y: 200 } };
    // On a bar as long as its bus needs (`defaultBarLengths`) the four stand
    // side by side over it, and each connector drops square.
    const barLengths = defaultBarLengths(topology);
    expect(barLengths.get('1')).toBeGreaterThan(92);
    const roomy = buildGraph(topology, coords, { barLengths });
    const inARow = roomy.nodes.filter((n) => n.type !== 'bus');
    expect(inARow.map((n) => n.position.y)).toEqual([-70, -70, -70, -70]);
    const square = layoutConnections(roomy.nodes, roomy.edges, { barLengths });
    for (const device of inARow) {
      const points = square.routes.get(`stub-${device.id}`)!.points;
      expect(points, device.id).toHaveLength(2);
      expect(points[0]![0], device.id).toBe(points[1]![0]);
    }
    // On a bar of the default length three have a place over it or over a
    // tip of it. The fourth would stand clear past the tip: it takes the
    // other face of the bar, where it has a place over it.
    const { nodes, edges } = buildGraph(topology, coords);
    const devices = nodes.filter((n) => n.type !== 'bus');
    expect(devices.map((n) => n.position.y)).toEqual([-70, -70, -70, 70]);
    /** Whether the run from `a` to `b` passes through the inside of the box of `n`. */
    const passesThrough = (a: number[], b: number[], n: (typeof nodes)[number]): boolean => {
      for (let i = 0; i <= 100; i += 1) {
        const x = a[0]! + (i / 100) * (b[0]! - a[0]!);
        const y = a[1]! + (i / 100) * (b[1]! - a[1]!);
        const inX = x > n.position.x + 1 && x < n.position.x + n.initialWidth! - 1;
        if (inX && y > n.position.y + 1 && y < n.position.y + n.initialHeight! - 1) return true;
      }
      return false;
    };
    for (const connectorStyle of ['straight', 'elbow'] as const) {
      const { routes, bars } = layoutConnections(nodes, edges, { connectorStyle });
      for (const device of devices) {
        const points = routes.get(`stub-${device.id}`)!.points;
        for (const other of devices) {
          if (other === device) continue;
          const through = points.some((p, i) => i > 0 && passesThrough(points[i - 1]!, p, other));
          expect(through, `${connectorStyle}: ${device.id} through ${other.id}`).toBe(false);
        }
        // Each lands on a tap of the bar, which reaches under them all.
        const tap = points[points.length - 1]!;
        expect(tap[1]).toBe(3);
        expect(tap[0]).toBeGreaterThanOrEqual(bars.get('1')!.start + 3);
        expect(tap[0]).toBeLessThanOrEqual(bars.get('1')!.end - 3);
      }
      // Every one of them drops square: none stands clear past a tip.
      for (const device of devices) {
        const points = routes.get(`stub-${device.id}`)!.points;
        expect(points, `${connectorStyle}: ${device.id}`).toHaveLength(2);
        expect(points[0]![0], `${connectorStyle}: ${device.id}`).toBe(points[1]![0]);
      }
    }
  });

  it('stands a device clear of a branch of other buses that passes through its row', () => {
    // The line from bus 1 down to bus 2 passes 14 right of the tip of the
    // bar of bus 3, through the row where the load of bus 3 hangs.
    const topology = makeTopology({
      buses: [bus(1), bus(2), bus(3)],
      lines: [trafo('L12', 1, 2)],
      loads: [{ ...load('A', 3), name: 'A load' }],
    });
    const coords = { '1': { x: 300, y: 0 }, '2': { x: 300, y: 400 }, '3': { x: 240, y: 200 } };
    const { nodes, edges } = buildGraph(topology, coords);
    const { routes } = layoutConnections(nodes, edges);
    expect(routes.get('line-L12')!.points).toEqual([
      [346, 3],
      [346, 403],
    ]);
    const placed = nodes.find((n) => n.id === 'load-A')!;
    const half = placed.initialWidth! / 2;
    expect(placed.position.y).toBe(200 + DEVICE_ROW_OFFSET);
    // Its box is a gap from the line, and not over the third of the bar it
    // would take with no line there (240 + 46 + 33).
    expect(middleOf(placed)).toBe(346 - half - DEVICE_COLUMN_GAP);
    const alone = buildGraph({ ...topology, lines: [] }, coords).nodes;
    expect(middleOf(alone.find((n) => n.id === 'load-A')!)).toBe(240 + 46 + DEVICE_COLUMN_OFFSET);
  });

  it('keeps a device by its bus when stepping out from under a level run would take it further than the limit', () => {
    // A line runs level through the row under bus 1, as a saved route has
    // it. A fourth bus, far off, has the load of bus 1 prefer the face under
    // its bar.
    const drawn = (from: number, to: number, face: 'south' | 'north' = 'south') => {
      const topology = makeTopology({
        buses: [bus(1), bus(2), bus(3), bus(4)],
        lines: [trafo('L23', 2, 3)],
        loads: [{ ...load('A', 1), name: 'A' }],
      });
      const coords = {
        '1': { x: 0, y: 0 },
        '2': { x: from - 46, y: 180 },
        '3': { x: to - 46, y: 180 },
        '4': { x: 2000, y: -400 },
      };
      const route: [number, number][] = [
        [from, 180],
        [from, 90],
        [to, 90],
        [to, 180],
      ];
      const { nodes } = buildGraph(topology, coords, {
        bendPoints: new Map([['line-L23', route]]),
      });
      const placed = nodes.find((n) => n.id === 'load-A')!;
      expect(placed.position.y).toBe(face === 'south' ? DEVICE_ROW_OFFSET : -DEVICE_ROW_OFFSET);
      return middleOf(placed);
    };
    // A short run, from 46 to 146: the load stands a gap left of where it starts.
    expect(drawn(46, 146)).toBe(46 - 19 - DEVICE_COLUMN_GAP);
    // A run that reaches 300 either side: clear of it the load would stand
    // further past a tip than the limit, so it keeps its third of the bar...
    expect(300 - 19 - DEVICE_COLUMN_GAP).toBeGreaterThan(DEVICE_DETOUR_LIMIT);
    expect(drawn(-254, 346)).toBe(46 + DEVICE_COLUMN_OFFSET);
    // ...and where the upright run of the same line would take it clear past
    // the tip of the bar, it stands over the bar instead, on the other face.
    expect(90 + 19 + DEVICE_COLUMN_GAP - 89).toBeGreaterThan(19);
    expect(drawn(-254, 90, 'north')).toBe(46 + DEVICE_COLUMN_OFFSET);
  });

  it('places the narrow devices first, and a generator with its machine as one symbol', () => {
    // A generator, its machine and a load, all above bus 1 because its line
    // goes down. The generator and its machine are one symbol, so two
    // devices stand over the bar where three did not fit: the load, the
    // narrower, takes the place over its third of the bar, and the unit
    // stands beside it, a gap clear.
    const topology = makeTopology({
      buses: [bus(1), bus(2)],
      lines: [trafo('L', 1, 2)],
      generators: [
        { ...gen(7, 1), name: '7' },
        { ...gen('GENROU_7', 1, 'GENROU'), name: 'GENROU_7', params: { bus: 1, gen: 7 } },
      ],
      loads: [{ ...load('PQ_1', 1), name: 'PQ_1' }],
    });
    const { nodes, edges } = buildGraph(topology, { '1': { x: 0, y: 0 }, '2': { x: 0, y: 200 } });
    const unit = nodes.find((n) => n.id === 'generator-7')!;
    const pq = nodes.find((n) => n.id === 'load-PQ_1')!;
    for (const x of [middleOf(unit), middleOf(pq)]) {
      expect(x).toBeGreaterThanOrEqual(3);
      expect(x).toBeLessThanOrEqual(89);
    }
    expect(middleOf(pq)).toBe(46 + DEVICE_COLUMN_OFFSET);
    expect(pq.position.x - (unit.position.x + unit.initialWidth!)).toBeCloseTo(
      DEVICE_COLUMN_GAP,
      6,
    );
    // The nodes are still built in the order of the topology, and the
    // machine has none of its own.
    expect(nodes.filter((n) => n.type !== 'bus').map((n) => n.id)).toEqual([
      'generator-7',
      'load-PQ_1',
    ]);
    // Both drop square onto the bar.
    const { routes } = layoutConnections(nodes, edges);
    for (const id of ['stub-generator-7', 'stub-load-PQ_1']) {
      const points = routes.get(id)!.points;
      expect(points[0]![0], id).toBe(points[1]![0]);
    }
  });

  it('leaves two devices of different widths that stand a gap apart where they are', () => {
    // A narrow one and a wide one side by side over the bar, 8 apart. Their
    // boxes do not touch, so nothing is pushed out of the way; measured
    // corner to corner as if that were middle to middle, they would seem to.
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [
        { ...gen('A', 1), name: 'A' },
        { ...gen('B', 1), name: 'a wide one' },
      ],
    });
    const coords = { '1': { x: 0, y: 100 } };
    const placed = buildGraph(topology, coords, { applyPushOut: false }).nodes;
    const [narrow, wide] = placed.filter((n) => n.type === 'generator');
    expect(narrow!.initialWidth).toBeLessThan(wide!.initialWidth!);
    expect(wide!.position.x - (narrow!.position.x + narrow!.initialWidth!)).toBe(DEVICE_COLUMN_GAP);
    const pushed = buildGraph(topology, coords).nodes;
    expect(pushed.map((n) => n.position)).toEqual(placed.map((n) => n.position));
  });

  it('takes a device a drag has placed as standing where it was dropped', () => {
    // The generator was dragged onto the column the load would take.
    const topology = makeTopology({
      buses: [bus(1)],
      generators: [{ ...gen('G', 1), name: 'G' }],
      loads: [{ ...load('L', 1), name: 'L' }],
    });
    const coords = { '1': { x: 0, y: 0 } };
    const alone = buildGraph(topology, coords).nodes.find((n) => n.id === 'load-L')!;
    const { nodes } = buildGraph(topology, coords, {
      dragOverrides: { 'generator-G': { ...alone.position } },
    });
    const dragged = nodes.find((n) => n.id === 'generator-G')!;
    const placed = nodes.find((n) => n.id === 'load-L')!;
    expect(dragged.position).toEqual(alone.position);
    expect(Math.abs(middleOf(placed) - middleOf(dragged))).toBeGreaterThanOrEqual(
      deviceBoxSize('L').width + DEVICE_COLUMN_GAP,
    );
  });
});

describe('buildGraph: a device and what stands around its bus', () => {
  it('stands a device clear of a device of the bus above that hangs in the same strip', () => {
    // Bus 1 over bus 2, 136 apart: the load under bus 1 and the generator
    // over bus 2 share the strip between the two bars. The load is where a
    // layout put it, right where the generator would stand.
    const topology = makeTopology({
      buses: [bus(1), bus(2), bus(3)],
      lines: [trafo('L23', 2, 3)],
      generators: [{ ...gen('G', 2), name: 'G' }],
      loads: [{ ...load('L', 1), name: 'L' }],
    });
    const coords = { '1': { x: 0, y: 0 }, '2': { x: 0, y: 136 }, '3': { x: 0, y: 400 } };
    const alone = buildGraph({ ...topology, loads: [] }, coords).nodes.find(
      (n) => n.id === 'generator-G',
    )!;
    // In the way: its box over the place the generator takes with nothing there.
    const placed = new Map([['PQ|L', { x: alone.position.x, y: 70 }]]);
    const { nodes } = buildGraph(topology, coords, { nonBusCoords: placed, applyPushOut: false });
    const [generator, hung] = ['generator-G', 'load-L'].map(
      (id) => nodes.find((n) => n.id === id)!,
    );
    expect(hung!.position).toEqual({ x: alone.position.x, y: 70 });
    // Still over its own bar, and a gap clear of the load beside it.
    expect(generator!.position.y).toBe(136 - DEVICE_ROW_OFFSET);
    const middle = (n: (typeof nodes)[number]): number => n.position.x + n.initialWidth! / 2;
    const apart = Math.abs(middle(generator!) - middle(hung!));
    expect(apart).toBeGreaterThanOrEqual(
      (generator!.initialWidth! + hung!.initialWidth!) / 2 + DEVICE_COLUMN_GAP,
    );
  });

  it('stands a device clear of the bar of another bus that lies in its row', () => {
    // Bus 2 stands 70 under bus 1 and a little to the right: its bar and
    // label are where the load of bus 1 would hang.
    const topology = makeTopology({
      buses: [bus(1), bus(2), bus(3)],
      lines: [trafo('L13', 1, 3)],
      loads: [{ ...load('L', 1), name: 'L' }],
    });
    const coords = { '1': { x: 0, y: 0 }, '2': { x: 60, y: 70 }, '3': { x: 400, y: -300 } };
    const { nodes } = buildGraph(topology, coords, { applyPushOut: false });
    const hung = nodes.find((n) => n.id === 'load-L')!;
    const box = {
      left: hung.position.x,
      right: hung.position.x + hung.initialWidth!,
      top: hung.position.y,
      bottom: hung.position.y + hung.initialHeight!,
    };
    // Not on the bar of bus 2 (60 to 152, at 70) nor on the label under it.
    const onBus2 = box.left < 152 && box.right > 60 && box.top < 70 + 44 && box.bottom > 70;
    expect(onBus2).toBe(false);
  });
});

describe('busRoom and defaultBarLengths', () => {
  const star = (branches: number, devices = 0): TopologySummary =>
    makeTopology({
      buses: [bus('hub'), ...Array.from({ length: branches }, (_, i) => bus(`b${i}`))],
      lines: Array.from({ length: branches }, (_, i) => trafo(`L${i}`, 'hub', `b${i}`)),
      loads: Array.from({ length: devices }, (_, i) => ({
        ...load(`L${i}`, 'hub'),
        name: `L${i}`,
      })),
    });

  it('leaves a bus with a few connections its bar of the default length', () => {
    expect(busRoom(star(5)).get('hub')).toEqual({ bar: 92, box: 92 });
    expect(defaultBarLengths(star(5)).size).toBe(0);
  });

  it('gives a busy bus a bar with a place on the grid for each of its connections', () => {
    // A bar of 92 has five lines of the grid on it; each 32 more adds two.
    expect(busRoom(star(6)).get('hub')!.bar).toBe(108);
    expect(busRoom(star(7)).get('hub')!.bar).toBe(108);
    expect(busRoom(star(8)).get('hub')!.bar).toBe(140);
    expect(busRoom(star(12)).get('hub')!.bar).toBe(204);
    expect([...defaultBarLengths(star(12))]).toEqual([['hub', 204]]);
    // The buses at the other ends have one connection each.
    expect(busRoom(star(12)).get('b0')).toEqual({ bar: 92, box: 92 });
  });

  it('counts a device for more than a line: its tap is not on the grid', () => {
    expect(busRoom(star(4, 0)).get('hub')!.bar).toBe(92);
    expect(busRoom(star(4, 1)).get('hub')!.bar).toBe(108);
  });

  it('makes the bar long enough for the devices of a bus side by side, and its box as wide as their row', () => {
    const many = star(1, 5);
    const width = deviceBoxSize('L0').width;
    const row = 5 * width + 4 * DEVICE_COLUMN_GAP;
    const room = busRoom(many).get('hub')!;
    expect(room.box).toBe(row);
    // The middles of the two at the ends are over the tips.
    expect(room.bar).toBeGreaterThanOrEqual(row - width);
  });
});
