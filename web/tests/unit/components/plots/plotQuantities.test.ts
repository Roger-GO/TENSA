/**
 * The pure part of the plot's quantity toggles: which series make up a
 * quantity, and what flipping one does to the selection.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_ELEMENTS,
  QUANTITIES,
  isQuantityOn,
  seriesOf,
  toggleQuantity,
} from '@/components/plots/plotQuantities';

const BUS_V = QUANTITIES.find((q) => q.group === 'bus_v' && q.field === 'v')!;
const BUS_A = QUANTITIES.find((q) => q.group === 'bus_v' && q.field === 'a')!;
const GEN_W = QUANTITIES.find((q) => q.group === 'gen_state' && q.field === 'omega')!;
const GEN_D = QUANTITIES.find((q) => q.group === 'gen_state' && q.field === 'delta')!;

const COLUMNS = [
  'Bus_1_v',
  'Bus_1_a',
  'Bus_2_v',
  'Bus_2_a',
  'Bus_3_v',
  'Bus_3_a',
  'Gen_1_omega',
  'Gen_1_delta',
  'Gen_2_omega',
  'Gen_2_delta',
  'Line_1_p',
];

describe('seriesOf', () => {
  it('lists the series of one field of one group, in column order', () => {
    expect(seriesOf(COLUMNS, 'bus_v', 'a').map((s) => s.name)).toEqual([
      'Bus_1_a',
      'Bus_2_a',
      'Bus_3_a',
    ]);
    expect(seriesOf(COLUMNS, 'gen_state', 'omega').map((s) => s.elementIdx)).toEqual(['1', '2']);
  });

  it('is empty when the run did not record the group', () => {
    expect(seriesOf(['Bus_1_v'], 'gen_state', 'omega')).toEqual([]);
  });
});

describe('isQuantityOn', () => {
  it('is on when any series of the quantity is selected, and off otherwise', () => {
    expect(isQuantityOn(COLUMNS, new Set(['Bus_2_v']), BUS_V)).toBe(true);
    expect(isQuantityOn(COLUMNS, new Set(['Bus_2_v']), BUS_A)).toBe(false);
    expect(isQuantityOn(COLUMNS, new Set(), BUS_V)).toBe(false);
  });
});

describe('toggleQuantity', () => {
  it('turns a quantity on for the elements its partner is drawn for', () => {
    const next = toggleQuantity(COLUMNS, new Set(['Bus_2_v', 'Bus_3_v']), BUS_A);
    expect([...next].sort()).toEqual(['Bus_2_a', 'Bus_2_v', 'Bus_3_a', 'Bus_3_v']);
  });

  it('pairs a machine speed with its rotor angle the same way', () => {
    const next = toggleQuantity(COLUMNS, new Set(['Gen_2_omega']), GEN_D);
    expect([...next].sort()).toEqual(['Gen_2_delta', 'Gen_2_omega']);
    // And the other way round, from the angle.
    const back = toggleQuantity(COLUMNS, new Set(['Gen_1_delta']), GEN_W);
    expect([...back].sort()).toEqual(['Gen_1_delta', 'Gen_1_omega']);
  });

  it('takes the first elements when the partner is not drawn', () => {
    const next = toggleQuantity(COLUMNS, new Set(), GEN_W);
    expect([...next]).toEqual(['Gen_1_omega', 'Gen_2_omega']);
  });

  it('takes at most MAX_ELEMENTS elements, the first in column order', () => {
    const many = Array.from({ length: MAX_ELEMENTS + 5 }, (_, i) => `Bus_${i + 1}_v`);
    const next = toggleQuantity(many, new Set(), BUS_V);
    expect(next.size).toBe(MAX_ELEMENTS);
    expect(next.has('Bus_1_v')).toBe(true);
    expect(next.has(`Bus_${MAX_ELEMENTS + 1}_v`)).toBe(false);
  });

  it('turns a quantity that is on off for every element, and leaves the rest', () => {
    const next = toggleQuantity(
      COLUMNS,
      new Set(['Bus_1_v', 'Bus_1_a', 'Bus_2_a', 'Gen_1_omega']),
      BUS_A,
    );
    expect([...next].sort()).toEqual(['Bus_1_v', 'Gen_1_omega']);
  });

  it('does not change the selection it was given', () => {
    const before = new Set(['Bus_1_v']);
    toggleQuantity(COLUMNS, before, BUS_A);
    expect([...before]).toEqual(['Bus_1_v']);
  });

  it('adds nothing for a quantity the run has no columns for', () => {
    expect([...toggleQuantity(['Bus_1_v'], new Set(['Bus_1_v']), GEN_W)]).toEqual(['Bus_1_v']);
  });
});
