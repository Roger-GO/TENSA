/**
 * elementKinds: the one list of what can be added, which the Add element
 * form's Kind picker and the Components palette both show, how it is grouped,
 * and what a search of the palette keeps.
 */
import { describe, it, expect } from 'vitest';

import {
  ELEMENT_KINDS,
  groupElementKinds,
  searchElementKinds,
} from '@/components/elements/elementKinds';

const values = (kinds: readonly { value: string }[]) => kinds.map((k) => k.value);

describe('ELEMENT_KINDS', () => {
  it('lists each kind once, in the order the picker and the palette show them', () => {
    expect(values(ELEMENT_KINDS)).toEqual([
      'Bus',
      'Line',
      'Transformer2W',
      'PV',
      'Slack',
      'GENROU',
      'GENCLS',
      'IEEEX1',
      'ESDC2A',
      'EXST1',
      'SEXS',
      'TGOV1',
      'IEEEG1',
      'ESD1',
      'PQ',
      'ZIP',
      'Shunt',
    ]);
  });

  it('adds a transformer as an ANDES Line with an off-nominal tap', () => {
    const transformer = ELEMENT_KINDS.find((k) => k.value === 'Transformer2W');
    expect(transformer).toMatchObject({ submitModel: 'Line', defaultParams: { tap: 1.05 } });
    // Every other kind is added as the model it is named after.
    for (const kind of ELEMENT_KINDS) {
      if (kind.value !== 'Transformer2W') expect(kind.submitModel).toBe(kind.value);
    }
  });

  it('describes every kind in a sentence or two the palette can show under its name', () => {
    for (const kind of ELEMENT_KINDS) {
      expect(kind.description, kind.value).toMatch(/^[A-Z].*\.$/);
      // Short enough to read at a glance in a sidebar at its narrowest.
      expect(kind.description.length, kind.value).toBeLessThanOrEqual(90);
    }
  });

  it('says what a kind needs first when it cannot stand alone', () => {
    const description = (value: string) =>
      ELEMENT_KINDS.find((k) => k.value === value)?.description ?? '';
    for (const value of ['GENROU', 'GENCLS', 'ESD1']) {
      expect(description(value)).toContain('Needs a PV or Slack generator on its bus.');
    }
    expect(description('ZIP')).toContain('Needs that PQ load.');
    for (const value of ['IEEEX1', 'ESDC2A', 'EXST1', 'SEXS']) {
      expect(description(value)).toContain('Regulates the voltage of a machine.');
    }
    for (const value of ['TGOV1', 'IEEEG1']) {
      expect(description(value)).toContain('Regulates the speed of a machine.');
    }
  });
});

describe('groupElementKinds', () => {
  it('groups the whole list as the Kind picker does, each group where it first appears', () => {
    expect(
      groupElementKinds(ELEMENT_KINDS).map(({ group, kinds }) => [group, values(kinds)]),
    ).toEqual([
      ['Network', ['Bus', 'Line']],
      ['Transformers', ['Transformer2W']],
      ['Generators', ['PV', 'Slack', 'GENROU', 'GENCLS']],
      ['Exciters', ['IEEEX1', 'ESDC2A', 'EXST1', 'SEXS']],
      ['Governors', ['TGOV1', 'IEEEG1']],
      ['Storage', ['ESD1']],
      ['Loads', ['PQ', 'ZIP']],
      ['Shunts', ['Shunt']],
    ]);
  });

  it('leaves out a group none of the kinds is in, and gives nothing for no kinds', () => {
    const some = ELEMENT_KINDS.filter((k) => k.value === 'ZIP' || k.value === 'Bus');
    expect(groupElementKinds(some).map(({ group, kinds }) => [group, values(kinds)])).toEqual([
      ['Network', ['Bus']],
      ['Loads', ['ZIP']],
    ]);
    expect(groupElementKinds([])).toEqual([]);
  });
});

describe('searchElementKinds', () => {
  it('keeps every kind for an empty query, or one of only spaces', () => {
    expect(searchElementKinds('')).toEqual(ELEMENT_KINDS);
    expect(searchElementKinds('   ')).toEqual(ELEMENT_KINDS);
  });

  it('finds a kind by its name or its model, whatever the case', () => {
    expect(values(searchElementKinds('genrou'))).toEqual(['GENROU']);
    expect(values(searchElementKinds('Slack'))).toEqual(['Slack']);
    expect(values(searchElementKinds('  TRANSFORMER '))).toEqual(['Transformer2W']);
    expect(values(searchElementKinds('zip'))).toEqual(['ZIP']);
  });

  it('finds the kinds of a group by the name of the group', () => {
    expect(values(searchElementKinds('generators'))).toEqual(['PV', 'Slack', 'GENROU', 'GENCLS']);
    expect(values(searchElementKinds('storage'))).toEqual(['ESD1']);
    expect(values(searchElementKinds('load'))).toEqual(['PQ', 'ZIP']);
  });

  it('finds a kind by another word it is known under', () => {
    expect(values(searchElementKinds('avr'))).toEqual(['IEEEX1', 'ESDC2A', 'EXST1', 'SEXS']);
    expect(values(searchElementKinds('battery'))).toEqual(['ESD1']);
    expect(values(searchElementKinds('bess'))).toEqual(['ESD1']);
    expect(values(searchElementKinds('swing'))).toEqual(['Slack']);
    expect(values(searchElementKinds('capacitor'))).toEqual(['Shunt']);
    expect(values(searchElementKinds('machine'))).toEqual(['GENROU', 'GENCLS']);
    expect(values(searchElementKinds('turbine'))).toEqual(['TGOV1', 'IEEEG1']);
    expect(values(searchElementKinds('branch'))).toEqual(['Line', 'Transformer2W']);
  });

  it('keeps only the kinds that hold every word typed', () => {
    expect(values(searchElementKinds('pv gen'))).toEqual(['PV']);
    expect(values(searchElementKinds('exciter static'))).toEqual(['EXST1']);
    expect(values(searchElementKinds('load dynamic'))).toEqual(['ZIP']);
    expect(searchElementKinds('exciter governor')).toEqual([]);
  });

  it('does not search the descriptions: most of them name a bus or a generator', () => {
    expect(values(searchElementKinds('bus'))).toEqual(['Bus']);
    expect(values(searchElementKinds('line'))).toEqual(['Line']);
    expect(values(searchElementKinds('slack'))).toEqual(['Slack']);
  });

  it('keeps nothing for a word no kind is known under', () => {
    expect(searchElementKinds('flux capacitor')).toEqual([]);
  });
});
