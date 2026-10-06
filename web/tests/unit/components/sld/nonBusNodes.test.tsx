/**
 * Non-bus node emission (Unit 3).
 *
 * Verifies that `buildGraph` produces React Flow nodes for generators,
 * loads, and shunts anchored to their parent bus, plus stub edges
 * connecting each non-bus node to its bus, and that a device the layout
 * does not place is put over a free part of the bar. Transformers stay as
 * edges (TransformerEdge) — these tests cover that they don't accidentally
 * emit a node.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildGraph,
  deviceBoxSize,
  freeColumn,
  DEVICE_COLUMN_GAP,
  DEVICE_COLUMN_OFFSET,
  DEVICE_ROW_OFFSET,
  DEVICE_VALUE_LABEL,
  NODE_FOOTPRINT,
} from '@/components/sld/graph';
import { layoutConnections } from '@/components/sld/connections';
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

    it('keeps the machine node and its gen link when it shares an idx with its static generator', () => {
      // kundur_full numbers PV/Slack and GENROU alike (1..4). The two collapse
      // to the machine node, which must still read the static row under `1`.
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
      expect((gens[0]?.data as { kind?: string }).kind).toBe('GENROU');
      expect(dataOf(nodes, 'generator-1').pflowIdx).toBe('1');
    });

    it('prints the row of a static generator on its machine, not on both', () => {
      // ieee14_full numbers its machines GENROU_1..5, so the static PV 2 and
      // GENROU_2 are two nodes on bus 2 that read the same row. Only the
      // machine prints it; the static generator it names stays quiet.
      const topology = makeTopology({
        buses: [bus(2)],
        generators: [gen('2', 2), machine('GENROU_2', 2, 2)],
      });
      const { nodes } = buildGraph(topology, { '2': { x: 0, y: 100 } });
      expect(dataOf(nodes, 'generator-2').pflowIdx).toBeNull();
      expect(dataOf(nodes, 'generator-GENROU_2').pflowIdx).toBe('2');
    });

    it('prints a row once when two machines name the same static generator', () => {
      const topology = makeTopology({
        buses: [bus(1)],
        generators: [gen('2', 1), machine('GENROU_1', 1, 2), machine('GENCLS_1', 1, '2', 'GENCLS')],
      });
      const { nodes } = buildGraph(topology, { '1': { x: 0, y: 100 } });
      expect(dataOf(nodes, 'generator-2').pflowIdx).toBeNull();
      expect(dataOf(nodes, 'generator-GENROU_1').pflowIdx).toBe('2');
      expect(dataOf(nodes, 'generator-GENCLS_1').pflowIdx).toBeNull();
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
      expect(dataOf(nodes, 'generator-2').pflowIdx).toBeNull();
    });

    it('prints every generator_outputs row exactly once on an ieee14_full-shaped case', () => {
      // Five static generators on buses 1, 2, 3, 6 and 8, each with a machine
      // of its own idx on the same bus: ten nodes, five rows.
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
      expect(nodes.filter((n) => n.type === 'generator')).toHaveLength(10);
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
      // Exciter controller docked to the generator via its `syn` ref so a
      // controller badge node is actually emitted.
      controllers: [{ idx: 'AVR1', name: 'avr-1', kind: 'EXDC2', params: { syn: 'GEN_1' } }],
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
      controllers: [{ idx: 'AVR1', name: 'avr-1', kind: 'EXDC2', params: { syn: 'GEN_1' } }],
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
    const { bars } = layoutConnections(nodes, edges);
    const line = bars.get('2')!.taps.find((tap) => tap.side === 'south' && tap.x === 46);
    expect(line).toBeDefined();
    // The box does not sit on the line: its near edge is a gap away from it.
    const half = wide.initialWidth! / 2;
    expect(Math.abs(middleOf(wide) - 46)).toBeCloseTo(half + DEVICE_COLUMN_GAP);
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
