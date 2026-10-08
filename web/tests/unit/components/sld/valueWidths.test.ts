/**
 * How wide the values of a power flow are on the diagram: one answer for the
 * canvas and for the figure made of it.
 */
import { describe, expect, it } from 'vitest';
import type { PflowResult } from '@/api/types';
import type { ConnectionEdge } from '@/components/sld/connections';
import { flowLabelWidth, readoutWidth, type LabelNode } from '@/components/sld/labels';
import { pflowKeyOf, valueLabelWidths } from '@/components/sld/valueWidths';
import { lineFlow } from '../../helpers/lineFlow';

const node = (id: string, type: string, data: Record<string, unknown>): LabelNode => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data,
});

const NODES: LabelNode[] = [
  node('1', 'bus', { idx: '1' }),
  node('generator-1', 'generator', { idx: '1' }),
  // A machine drawn apart from its static generator reads that generator's row.
  node('generator-GENROU_2', 'generator', { idx: 'GENROU_2', pflowIdx: '2' }),
  // And one whose row another node prints reads none.
  node('generator-GENROU_3', 'generator', { idx: 'GENROU_3', pflowIdx: null }),
  node('load-PQ_1', 'load', { idx: 'PQ_1' }),
  node('shunt-S', 'shunt', { idx: 'S' }),
];

const EDGES: ConnectionEdge[] = [
  { id: 'line-L1', source: '1', target: '2', data: { idx: 'L1', bucket: 'line' } },
  { id: 'line-L2', source: '1', target: '2', data: { idx: 'L2', bucket: 'line' } },
  { id: 'transformer-T', source: '1', target: '2', data: { idx: 'T', bucket: 'transformer' } },
  { id: 'stub-load-PQ_1', source: 'load-PQ_1', target: '1', data: { bucket: 'load' } },
];

const PFLOW: PflowResult = {
  run_id: 'pf',
  converged: true,
  iterations: 3,
  mismatch: 1e-9,
  bus_voltages: { '1': 1 },
  bus_angles: { '1': 0 },
  generator_outputs: {
    '1': { p: 232.4, q: -16.9, v: 1, bus: 1 },
    '2': { p: 40, q: 1234.5, v: 1, bus: 2 },
  },
  load_consumption: { PQ_1: { p: 21.7, q: 12.7, bus: 2 } },
  line_flows: {
    L1: lineFlow(156.88, 3),
    L2: lineFlow(-7.5, 1, { from: 1, to: 2 }, { rate_a: 100, loading_pct: 96.4 }),
    T: lineFlow(44, 2),
  },
};

describe('pflowKeyOf', () => {
  it('is the row of the result a node prints: its own, the one it names, or none', () => {
    expect(NODES.map(pflowKeyOf)).toEqual(['1', '1', '2', null, 'PQ_1', 'S']);
    expect(pflowKeyOf(node('x', 'load', {}))).toBeNull();
  });
});

describe('valueLabelWidths', () => {
  it('gives every generator and load the width of its two lines, and nothing else a readout', () => {
    const { readouts } = valueLabelWidths(NODES, EDGES, PFLOW);
    expect([...readouts.keys()]).toEqual([
      'generator-1',
      'generator-GENROU_2',
      'generator-GENROU_3',
      'load-PQ_1',
    ]);
    expect(readouts.get('generator-1')).toBe(readoutWidth('232.4 MW', '-16.9 MVAr'));
    // The longer of the two lines sets it.
    expect(readouts.get('generator-GENROU_2')).toBe(readoutWidth('40.0 MW', '1234.5 MVAr'));
    expect(readouts.get('generator-GENROU_2')).toBeGreaterThan(readouts.get('generator-1')!);
    expect(readouts.get('load-PQ_1')).toBe(readoutWidth('21.7 MW', '12.7 MVAr'));
    // A node that prints no row has the width of an empty readout.
    expect(readouts.get('generator-GENROU_3')).toBe(readoutWidth(null, null));
  });

  it('gives every line the width of its flow, with its loading where the case rates it', () => {
    const { flows } = valueLabelWidths(NODES, EDGES, PFLOW);
    // A transformer carries its symbol and no label; a connector carries neither.
    expect([...flows.keys()]).toEqual(['line-L1', 'line-L2']);
    expect(flows.get('line-L1')).toBe(flowLabelWidth('156.88 MW', null));
    expect(flows.get('line-L2')).toBe(flowLabelWidth('-7.50 MW', '96.4%'));
  });

  it('takes every value as not shown before a power flow, or after one that did not converge', () => {
    for (const none of [null, { ...PFLOW, converged: false }]) {
      const { readouts, flows } = valueLabelWidths(NODES, EDGES, none);
      expect(new Set(readouts.values())).toEqual(new Set([readoutWidth(null, null)]));
      expect(new Set(flows.values())).toEqual(new Set([flowLabelWidth(null, null)]));
    }
  });
});
