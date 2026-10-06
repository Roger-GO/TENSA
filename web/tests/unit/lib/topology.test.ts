/**
 * `generatorRowKey`: which row of the PF result's `generator_outputs` a
 * generator reads. The SLD readouts, the Inspector and the plots panel all
 * resolve a dynamic machine through it.
 */
import { describe, expect, it } from 'vitest';
import { elementsGone, findTopologyEntry, generatorRowKey, loadBusIdx } from '@/lib/topology';
import type { TopologyEntry, TopologySummary } from '@/api/types';

const entry = (
  idx: number | string,
  kind: string,
  params: Record<string, number | string | boolean> = {},
): TopologyEntry => ({ idx, name: `e-${idx}`, kind, params });

describe('generatorRowKey', () => {
  it('reads a static generator under its own idx', () => {
    expect(generatorRowKey(entry(2, 'PV'))).toBe('2');
    expect(generatorRowKey(entry('SL', 'Slack'))).toBe('SL');
  });

  it('reads a dynamic machine under the static generator named in gen', () => {
    expect(generatorRowKey(entry('GENROU_2', 'GENROU', { bus: 2, gen: 2 }))).toBe('2');
    expect(generatorRowKey(entry('GENCLS_1', 'GENCLS', { bus: 1, gen: 'PV_1' }))).toBe('PV_1');
  });

  it('falls back to the machine idx when gen is missing or not an idx', () => {
    expect(generatorRowKey(entry('GENROU_2', 'GENROU', { bus: 2 }))).toBe('GENROU_2');
    expect(generatorRowKey(entry('GENROU_2', 'GENROU', { bus: 2, gen: true }))).toBe('GENROU_2');
    expect(generatorRowKey({ idx: 7, name: 'm', kind: 'GENROU' })).toBe('7');
  });

  it('ignores gen on a static generator', () => {
    expect(generatorRowKey(entry(3, 'PV', { gen: 9 }))).toBe('3');
  });
});

describe('loadBusIdx', () => {
  const pq = entry('PQ_1', 'PQ', { bus: 4, p0: 0.2 });
  const zip = entry('ZIP_1', 'ZIP', { pq: 'PQ_1', kpp: 100, kpi: 0, kpz: 0 });

  it('reads a static load on its own bus', () => {
    expect(loadBusIdx(pq, [pq, zip])).toBe('4');
  });

  it('reads a dynamic load on the bus of the static load it takes over', () => {
    expect(loadBusIdx(zip, [pq, zip])).toBe('4');
    // The case holds the idx as a number, the reference as text.
    const numbered = entry(7, 'PQ', { bus: 'B9' });
    expect(loadBusIdx(entry('Z', 'ZIP', { pq: '7' }), [numbered])).toBe('B9');
  });

  it('has no bus for a load that names none, or names a load that is not there', () => {
    expect(loadBusIdx(entry('Z', 'ZIP', { pq: 'PQ_9' }), [pq])).toBeNull();
    expect(loadBusIdx(entry('Z', 'ZIP'), [pq])).toBeNull();
    // A load does not take itself over.
    const self = entry('Z', 'ZIP', { pq: 'Z' });
    expect(loadBusIdx(self, [self])).toBeNull();
  });
});

describe('findTopologyEntry', () => {
  const topology = (generators: TopologyEntry[]): TopologySummary => ({
    state: 'pre-setup',
    buses: [],
    lines: [],
    transformers: [],
    generators,
    loads: [],
  });
  const generators = [entry('1', 'Slack'), entry('1', 'GENROU', { bus: 1, gen: 1 })];

  it('finds the first element with the idx when the selection names no model', () => {
    expect(findTopologyEntry(topology(generators), { kind: 'generator', idx: '1' })?.kind).toBe(
      'Slack',
    );
  });

  it('finds the element of the model the selection names, among those sharing an idx', () => {
    const t = topology(generators);
    expect(findTopologyEntry(t, { kind: 'generator', idx: '1', modelClass: 'GENROU' })?.kind).toBe(
      'GENROU',
    );
    expect(findTopologyEntry(t, { kind: 'generator', idx: '1', modelClass: 'Slack' })?.kind).toBe(
      'Slack',
    );
  });

  it('falls back to the idx when no element of that model has it', () => {
    expect(
      findTopologyEntry(topology(generators), { kind: 'generator', idx: '1', modelClass: 'PV' })
        ?.kind,
    ).toBe('Slack');
  });

  it('finds nothing for an idx that is not there', () => {
    expect(findTopologyEntry(topology(generators), { kind: 'generator', idx: '9' })).toBeNull();
  });
});

describe('elementsGone', () => {
  const topology = (parts: Partial<TopologySummary>): TopologySummary => ({
    state: 'pre-setup',
    buses: [],
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
    ...parts,
  });

  it('names what the first topology lists and the second does not, by model and idx', () => {
    const before = topology({
      buses: [entry(3, 'Bus'), entry(4, 'Bus')],
      lines: [entry('L1', 'Line')],
      transformers: [entry('T1', 'Line')],
      generators: [entry(3, 'PV'), entry('G3', 'GENROU')],
      loads: [entry('PQ_3', 'PQ')],
      shunts: [entry('Sh_3', 'Shunt')],
      controllers: [entry(1, 'EXST1'), entry(1, 'TGOV1')],
    });
    const after = topology({
      buses: [entry(4, 'Bus')],
      transformers: [entry('T1', 'Line')],
      controllers: [entry(1, 'TGOV1')],
    });

    expect(elementsGone(before, after)).toEqual([
      { model: 'Bus', idx: 3 },
      { model: 'Line', idx: 'L1' },
      { model: 'PV', idx: 3 },
      { model: 'GENROU', idx: 'G3' },
      { model: 'PQ', idx: 'PQ_3' },
      { model: 'Shunt', idx: 'Sh_3' },
      // The governor with the same idx stays, so only the exciter is named.
      { model: 'EXST1', idx: 1 },
    ]);
  });

  it('names nothing when the second lists everything the first did, or more', () => {
    const before = topology({ buses: [entry(3, 'Bus')] });
    expect(elementsGone(before, before)).toEqual([]);
    expect(elementsGone(before, topology({ buses: [entry('3', 'Bus'), entry(9, 'Bus')] }))).toEqual(
      [],
    );
  });
});
