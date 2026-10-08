/**
 * What an element form holds and whether it can be sent, worked out without a
 * form: the values a form opens with, the values that were kept for it over
 * those, and the check that says what is missing or cannot be used. The form
 * and a draft on the diagram both go by it.
 */
import { describe, expect, it } from 'vitest';
import type { TopologyParamMeta, TopologySummary } from '@/api/types';
import {
  checkElementValues,
  existingIdxSetFor,
  nextAvailableIdx,
  pickTargets,
  seedElementValues,
  withHeldValues,
} from '@/components/elements/elementValues';

const PV: TopologyParamMeta[] = [
  { name: 'idx', kind: 'string', required: true },
  { name: 'name', kind: 'string', required: true },
  { name: 'bus', kind: 'bus_idx', required: true },
  { name: 'p0', kind: 'number', required: true, unit: 'pu' },
  { name: 'q0', kind: 'number', required: false, unit: 'pu' },
  { name: 'u', kind: 'bool', required: false },
];

const TGOV1: TopologyParamMeta[] = [
  { name: 'idx', kind: 'string', required: true },
  { name: 'syn', kind: 'syn_idx', required: true },
  { name: 'gen', kind: 'gen_idx', required: false },
];

const TOPOLOGY: TopologySummary = {
  state: 'pre-setup',
  buses: [
    { idx: 1, name: 'BUS1', kind: 'Bus' },
    { idx: 2, name: 'BUS2', kind: 'Bus' },
  ],
  lines: [],
  transformers: [],
  generators: [
    { idx: 2, name: '2', kind: 'PV', params: { bus: 2 } },
    { idx: 'GENROU_1', name: 'GENROU_1', kind: 'GENROU', params: { bus: 2, gen: 2 } },
  ],
  loads: [],
  shunts: [],
};

describe('the values a form opens with', () => {
  it('are empty but for the next free idx, the name of a model named after it, and the defaults', () => {
    expect(seedElementValues('PV', PV, TOPOLOGY, { q0: 0.1 })).toEqual({
      idx: '3',
      name: '3',
      bus: '',
      p0: '',
      q0: 0.1,
      u: false,
    });
    // A model that is not named after its idx opens with no name.
    expect(seedElementValues('PQ', PV, TOPOLOGY).name).toBe('');
  });

  it('take the next idx from the elements of the same model', () => {
    expect(nextAvailableIdx('PV', TOPOLOGY)).toBe('3');
    expect(nextAvailableIdx('GENROU', TOPOLOGY)).toBe('GENROU_2');
    expect(nextAvailableIdx('Bus', TOPOLOGY)).toBe('3');
    expect(nextAvailableIdx('PQ', TOPOLOGY)).toBe('PQ_1');
    expect([...existingIdxSetFor(TOPOLOGY, 'PV')]).toEqual(['2']);
  });
});

describe('the next free idx past ones that are reserved', () => {
  it('counts a reserved idx as taken, in the shape the idxs of the case have', () => {
    expect(nextAvailableIdx('PV', TOPOLOGY, ['3'])).toBe('4');
    expect(nextAvailableIdx('GENROU', TOPOLOGY, ['GENROU_2', 'GENROU_3'])).toBe('GENROU_4');
    // The first of its model in the case, after one that is reserved.
    expect(nextAvailableIdx('PQ', TOPOLOGY, ['PQ_1'])).toBe('PQ_2');
    expect(nextAvailableIdx('Bus', TOPOLOGY, ['3', '4'])).toBe('5');
  });

  it('is what a form opens with', () => {
    expect(seedElementValues('PV', PV, TOPOLOGY, undefined, ['3'])).toMatchObject({
      idx: '4',
      name: '4',
    });
  });
});

describe('the values that were kept, over what a form opens with', () => {
  const seeded = seedElementValues('PV', PV, TOPOLOGY);

  it('take the place of the seeded ones, field by field', () => {
    expect(withHeldValues('PV', seeded, { bus: '1', p0: '0.4' })).toEqual({
      ...seeded,
      bus: '1',
      p0: '0.4',
    });
  });

  it('take the name along with an idx that was kept, unless a name was kept too', () => {
    expect(withHeldValues('PV', seeded, { idx: 'G9' })).toMatchObject({ idx: 'G9', name: 'G9' });
    expect(withHeldValues('PV', seeded, { idx: 'G9', name: 'North' })).toMatchObject({
      idx: 'G9',
      name: 'North',
    });
    // Not for a model that is not named after its idx.
    expect(withHeldValues('PQ', seeded, { idx: 'L9' }).name).toBe('3');
  });

  it('leave out a field the model does not have', () => {
    expect(withHeldValues('PV', seeded, { xq: '1' })).toEqual(seeded);
  });
});

describe('the check of a set of values', () => {
  const taken = existingIdxSetFor(TOPOLOGY, 'PV');
  const good = { idx: '3', name: '3', bus: '1', p0: '0.4', q0: '', u: true };

  it('passes values that can be sent, as the server takes them', () => {
    expect(checkElementValues(PV, good, taken)).toEqual({
      errors: {},
      // The number is a number, and the optional field left empty is left out.
      params: { idx: '3', name: '3', bus: '1', p0: 0.4, u: true },
    });
  });

  it('names an empty required field, by whether it is typed or picked', () => {
    const { errors } = checkElementValues(PV, { ...good, bus: '', p0: '' }, taken);
    expect(errors).toEqual({
      bus: 'Required. Pick one from the list.',
      p0: 'Required. Enter a value.',
    });
  });

  it('refuses an idx the case already has, and a number that is not one', () => {
    const { errors } = checkElementValues(PV, { ...good, idx: '2', q0: 'abc' }, taken);
    expect(errors).toEqual({ idx: 'idx "2" is already taken', q0: 'Enter a finite number' });
  });

  it('refuses a pick the case does not have, only where it is told what the case has', () => {
    const targets = pickTargets(TOPOLOGY);
    expect(checkElementValues(PV, { ...good, bus: '7' }, taken).errors).toEqual({});
    expect(checkElementValues(PV, { ...good, bus: '7' }, taken, targets).errors).toEqual({
      bus: 'Bus 7 is not in the system. Pick one from the list.',
    });
    const governor = { idx: 'TGOV1_1', syn: 'GENROU_9', gen: '' };
    expect(checkElementValues(TGOV1, governor, new Set(), targets).errors).toEqual({
      syn: 'Machine GENROU_9 is not in the system. Pick one from the list.',
    });
    // An optional pick that was left empty is not looked up.
    expect(
      checkElementValues(TGOV1, { ...governor, syn: 'GENROU_1' }, new Set(), targets).errors,
    ).toEqual({});
  });

  it('lists what the lists of a form offer', () => {
    const targets = pickTargets(TOPOLOGY);
    expect([...targets.bus_idx]).toEqual(['1', '2']);
    expect([...targets.gen_idx]).toEqual(['2']);
    expect([...targets.syn_idx]).toEqual(['GENROU_1']);
    expect(pickTargets(null).bus_idx.size).toBe(0);
  });
});
