/**
 * Which values of a power flow the diagram does not draw (`valuesLeftOff`):
 * the flow of a line whose label has no place, the P and Q of a device whose
 * readout has none, and the voltage and angle of a bus whose label has room
 * for the name alone. The 118-bus case is held to the whole of it: every
 * value of the power flow is either drawn or in the list.
 *
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK
 * engine run in-thread, as in `layout.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { PflowResult, TopologySummary } from '@/api/types';
import type { ConnectionEdge, LabelPlace } from '@/components/sld/connections';
import type { BusLabel, ReadoutPlace } from '@/components/sld/labels';
import { valueLabelWidths } from '@/components/sld/valueWidths';
import { valuesCount, valuesLeftOff, type PlacesOfValues } from '@/components/sld/valuesLeftOff';
import { CASE118 } from '../../helpers/case118';
import { drawn, opened } from '../../helpers/diagramStates';
import { lineFlow } from '../../helpers/lineFlow';

vi.mock('@/components/sld/elkClient', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { elkLayout: vi.fn((graph: ElkNode) => elk.layout(graph)) };
});

const BOX = { left: 0, right: 10, top: 0, bottom: 10 };

/** A power flow that gave every element of `topology` a value. */
function solved(topology: TopologySummary): PflowResult {
  const keyed = <T>(entries: readonly { idx: number | string }[], row: (i: number) => T) =>
    Object.fromEntries(entries.map((entry, i) => [String(entry.idx), row(i)]));
  const statics = (topology.generators ?? []).filter((g) => g.kind === 'PV' || g.kind === 'Slack');
  return {
    run_id: 'run',
    converged: true,
    iterations: 4,
    mismatch: 1e-9,
    bus_voltages: keyed(topology.buses, (i) => 1 + (i % 7) / 100),
    bus_angles: keyed(topology.buses, (i) => -i / 100),
    line_flows: keyed([...topology.lines, ...(topology.transformers ?? [])], (i) =>
      lineFlow(10 + i, 2, { from: 1, to: 2 }),
    ),
    generator_outputs: keyed(statics, (i) => ({ p: 40 + i, q: 5, v: 1, bus: 1 })),
    load_consumption: keyed(topology.loads ?? [], (i) => ({ p: 20 + i, q: 4, bus: 1 })),
  } as PflowResult;
}

describe('valuesLeftOff', () => {
  const nodes = [
    { id: '1', type: 'bus', position: { x: 0, y: 0 }, data: { idx: '1', name: 'North' } },
    { id: '2', type: 'bus', position: { x: 0, y: 200 }, data: { idx: '2', name: 'South' } },
    {
      id: 'generator-G1',
      type: 'generator',
      position: { x: 0, y: -80 },
      data: { idx: 'G1', name: 'G1' },
    },
    { id: 'load-PQ_1', type: 'load', position: { x: 0, y: 260 }, data: { idx: 'PQ_1' } },
    // The machine of a unit prints no row of its own.
    {
      id: 'generator-GENROU_1',
      type: 'generator',
      position: { x: 80, y: -80 },
      data: { idx: 'GENROU_1', pflowIdx: null },
    },
  ];
  const line = (id: string, type: string, bucket: string): ConnectionEdge => ({
    id,
    type,
    source: '1',
    target: '2',
    data: { idx: id.slice(id.indexOf('-') + 1), bucket },
  });
  const edges: ConnectionEdge[] = [
    line('line-L1', 'topology', 'line'),
    line('line-L2', 'topology', 'line'),
    line('transformer-T1', 'transformer', 'transformer'),
    { id: 'stub-load-PQ_1', type: 'stub', source: 'load-PQ_1', target: '2' },
  ];
  const pflow = {
    run_id: 'run',
    converged: true,
    iterations: 3,
    mismatch: 0,
    bus_voltages: { '1': 1.06, '2': 1.0123 },
    bus_angles: { '1': 0, '2': -0.1 },
    line_flows: {
      L1: lineFlow(25.97, 3, { from: 1, to: 2 }, { rate_a: 30, loading_pct: 87.3 }),
      L2: lineFlow(-12.5, 1, { from: 1, to: 2 }),
      T1: lineFlow(5, 1, { from: 1, to: 2 }),
    },
    generator_outputs: { G1: { p: 40, q: 30.44, v: 1.06, bus: 1 } },
    load_consumption: { PQ_1: { p: 21.7, q: 12.7, bus: 2 } },
  } as PflowResult;
  const here = { x: 0, y: 0, angleDeg: 0 };
  const picture = (over: {
    hidden?: string[];
    none?: string[];
    compact?: string[];
  }): PlacesOfValues => ({
    labelPlaces: new Map<string, LabelPlace>(
      edges.map((edge) => [
        edge.id,
        over.hidden?.includes(edge.id) ? { ...here, hidden: true as const } : here,
      ]),
    ),
    readouts: new Map<string, ReadoutPlace>(
      nodes
        .filter((n) => n.type !== 'bus')
        .map((n) => [n.id, { spot: over.none?.includes(n.id) ? 'none' : 'right', box: BOX }]),
    ),
    busLabels: new Map<string, BusLabel>(
      nodes
        .filter((n) => n.type === 'bus')
        .map((n) => [
          n.id,
          {
            offset: 46,
            side: 'below',
            box: BOX,
            ...(over.compact?.includes(n.id) ? { compact: true } : {}),
          } as BusLabel,
        ]),
    ),
  });

  it('answers nothing where every value has a place, and nothing before a power flow', () => {
    expect(valuesLeftOff(nodes, edges, picture({}), pflow)).toEqual([]);
    const all = { hidden: ['line-L1'], none: ['load-PQ_1'], compact: ['2'] };
    expect(valuesLeftOff(nodes, edges, picture(all), null)).toEqual([]);
    expect(valuesLeftOff(nodes, edges, picture(all), { ...pflow, converged: false })).toEqual([]);
  });

  it('lists the flow of a line whose label has no place, with its direction and its loading', () => {
    const found = valuesLeftOff(
      nodes,
      edges,
      picture({ hidden: ['line-L1', 'line-L2', 'transformer-T1', 'stub-load-PQ_1'] }),
      pflow,
    );
    // A transformer carries its symbol there, and a connector nothing.
    expect(found).toEqual([
      { id: 'line-L1', kind: 'flow', name: 'line L1', values: ['→ 25.97 MW', '87.3%'] },
      { id: 'line-L2', kind: 'flow', name: 'line L2', values: ['← -12.50 MW'] },
    ]);
  });

  it('lists the P and Q of a device whose readout has no place, and not a node that prints none', () => {
    const found = valuesLeftOff(
      nodes,
      edges,
      picture({ none: ['generator-G1', 'load-PQ_1', 'generator-GENROU_1'] }),
      pflow,
    );
    expect(found).toEqual([
      {
        id: 'generator-G1',
        kind: 'readout',
        name: 'generator G1',
        values: ['40.0 MW', '30.4 MVAr'],
      },
      { id: 'load-PQ_1', kind: 'readout', name: 'load PQ_1', values: ['21.7 MW', '12.7 MVAr'] },
    ]);
  });

  it('lists the voltage and angle of a bus whose label has room for the name alone, in the unit asked for', () => {
    const withBase = nodes.map((n) =>
      n.id === '2' ? { ...n, data: { ...n.data, baseKv: 230 } } : n,
    );
    const found = valuesLeftOff(withBase, edges, picture({ compact: ['2'] }), pflow);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: '2', kind: 'bus', name: 'bus South' });
    expect(found[0]!.values[0]).toMatch(/^1\.012 pu$/);
    expect(found[0]!.values[1]).toMatch(/°$/);
    const inKv = valuesLeftOff(withBase, edges, picture({ compact: ['2'] }), pflow, 'actual');
    expect(inKv[0]!.values[0]).toMatch(/ kV$/);
  });

  it('puts the flows first, then the devices, then the buses', () => {
    const found = valuesLeftOff(
      nodes,
      edges,
      picture({ hidden: ['line-L2'], none: ['load-PQ_1'], compact: ['1'] }),
      pflow,
    );
    expect(found.map(({ id, kind }) => `${kind} ${id}`)).toEqual([
      'flow line-L2',
      'readout load-PQ_1',
      'bus 1',
    ]);
  });

  it('counts in words', () => {
    expect(valuesCount(1)).toBe('1 value');
    expect(valuesCount(12)).toBe('12 values');
  });
});

describe('the values of a power flow on the 118-bus case', () => {
  it('are each drawn or in the list: none is left off without a word', async () => {
    const diagram = await opened(CASE118);
    const pflow = solved(CASE118);
    const labelWidths = valueLabelWidths(diagram.nodes, diagram.edges as ConnectionEdge[], pflow);
    const picture = drawn(diagram, { values: true, labelWidths });
    const found = valuesLeftOff(diagram.nodes, diagram.edges as ConnectionEdge[], picture, pflow);
    // A diagram of this size has no room for some of its values.
    expect(found.length).toBeGreaterThan(0);
    const listed = new Set(found.map(({ id }) => id));
    expect(listed.size).toBe(found.length);
    for (const row of found) expect(row.values.length, row.id).toBeGreaterThan(0);
    // Every line has its flow on the diagram or in the list, and none both.
    for (const edge of diagram.edges) {
      if ((edge.data as { bucket?: string }).bucket !== 'line') continue;
      const place = picture.labelPlaces.get(edge.id);
      const shown = place !== undefined && place.hidden !== true;
      expect(shown !== listed.has(edge.id), edge.id).toBe(true);
    }
    // So has every generator and load its readout, and every bus its values.
    for (const node of diagram.nodes) {
      if (node.type === 'load' || (node.type === 'generator' && node.data.pflowIdx !== null)) {
        const shown = picture.readouts.get(node.id)?.spot !== 'none';
        expect(shown !== listed.has(node.id), node.id).toBe(true);
      } else if (node.type === 'bus') {
        const shown = picture.busLabels.get(node.id)?.compact !== true;
        expect(shown !== listed.has(node.id), node.id).toBe(true);
      }
    }
  }, 60_000);
});
