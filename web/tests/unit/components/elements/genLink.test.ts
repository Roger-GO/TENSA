/**
 * genLink: the `bus` and `gen` of a device that takes over a static generator.
 * Which generators there are, on which bus and already used by what; what to
 * write beside a bus; what a pick of one field does to the other; what a bus
 * brings along when nobody picked it; what to warn about.
 */
import { describe, it, expect } from 'vitest';

import {
  followLink,
  freeGeneratorOn,
  generatorLabel,
  generatorsByBus,
  linkWarnings,
  staticGenerators,
  usedBy,
  type StaticGenerator,
} from '@/components/elements/genLink';
import type { TopologyEntry, TopologySummary } from '@/api/types';

function entry(
  idx: number | string,
  kind: string,
  params: TopologyEntry['params'] = {},
): TopologyEntry {
  return { idx, name: String(idx), kind, params };
}

/**
 * Buses 1 to 5. A slack and a machine on bus 1, a PV with a machine on bus 2, a
 * free PV on bus 3, two PVs on bus 4 (one with a battery), nothing on bus 5.
 */
function topology(): TopologySummary {
  return {
    state: 'pre-setup',
    buses: [1, 2, 3, 4, 5].map((n) => entry(n, 'Bus')),
    lines: [],
    transformers: [],
    generators: [
      entry(2, 'PV', { bus: 2 }),
      entry('PV_B', 'PV', { bus: 3 }),
      entry(6, 'PV', { bus: 4 }),
      entry(7, 'PV', { bus: 4 }),
      entry(1, 'Slack', { bus: 1 }),
      entry('GENROU_1', 'GENROU', { bus: 1, gen: 1 }),
      entry('GENROU_2', 'GENROU', { bus: 2, gen: 2 }),
    ],
    loads: [],
    shunts: [],
    controllers: [
      entry('ESD1_1', 'ESD1', { bus: 4, gen: 6 }),
      // A governor names a machine, not a static generator.
      entry('TGOV1_1', 'TGOV1', { syn: 'GENROU_1' }),
    ],
  };
}

const GENS = staticGenerators(topology());

function gen(idx: string): StaticGenerator {
  return GENS.find((g) => g.idx === idx)!;
}

describe('staticGenerators', () => {
  it('lists the PV and Slack generators with their bus, and no machine', () => {
    expect(GENS.map((g) => [g.idx, g.kind, g.bus])).toEqual([
      ['2', 'PV', '2'],
      ['PV_B', 'PV', '3'],
      ['6', 'PV', '4'],
      ['7', 'PV', '4'],
      ['1', 'Slack', '1'],
    ]);
  });

  it('says which devices already take each one over, machines and batteries alike', () => {
    expect(gen('1').takenBy).toEqual(['GENROU_1']);
    expect(gen('2').takenBy).toEqual(['GENROU_2']);
    expect(gen('6').takenBy).toEqual(['ESD1_1']);
    expect(gen('PV_B').takenBy).toEqual([]);
    expect(gen('7').takenBy).toEqual([]);
  });

  it('names a device with its model where its idx alone is a bare number', () => {
    // Kundur numbers its machines 1 to 4, like the generators they take over.
    const t = topology();
    t.generators = [entry(2, 'PV', { bus: 2 }), entry(2, 'GENROU', { bus: 2, gen: 2 })];
    t.controllers = [entry(1, 'ESD1', { bus: 2, gen: 2 })];
    expect(staticGenerators(t)[0]!.takenBy).toEqual(['GENROU 2', 'ESD1 1']);
  });

  it('matches a reference held as text to an idx held as a number', () => {
    const t = topology();
    t.controllers = [entry('ESD1_9', 'ESD1', { bus: '3', gen: '2' })];
    expect(staticGenerators(t).find((g) => g.idx === '2')!.takenBy).toEqual(['GENROU_2', 'ESD1_9']);
  });

  it('has none for no case, and no bus for a generator the topology gives none for', () => {
    expect(staticGenerators(null)).toEqual([]);
    const t = topology();
    t.generators = [{ idx: 9, name: 'G9', kind: 'PV' }];
    expect(staticGenerators(t)).toEqual([
      { idx: '9', kind: 'PV', name: 'G9', bus: null, takenBy: [] },
    ]);
  });
});

describe('what is written beside a generator and a bus', () => {
  it('names a generator by its kind and idx, or by an idx that already says the kind', () => {
    expect(generatorLabel(gen('2'))).toBe('PV 2');
    expect(generatorLabel(gen('1'))).toBe('Slack 1');
    expect(generatorLabel(gen('PV_B'))).toBe('PV_B');
  });

  it('says what uses a generator, and nothing for a free one', () => {
    expect(usedBy(gen('2'))).toBe('used by GENROU_2');
    expect(usedBy(gen('PV_B'))).toBeNull();
    expect(usedBy({ takenBy: ['A', 'B'] })).toBe('used by A and B');
    // ANDES's ieee14_esd1 has ten batteries on one PV: the list stays short.
    expect(usedBy({ takenBy: ['1', '2', '3', '4', '5'] })).toBe('used by 1, 2 and 3 more');
  });

  it('names the generators of each bus that has one, with what uses them', () => {
    const notes = generatorsByBus(GENS);
    expect(notes.get('1')).toBe('generator: Slack 1 used by GENROU_1');
    expect(notes.get('2')).toBe('generator: PV 2 used by GENROU_2');
    expect(notes.get('3')).toBe('generator: PV_B');
    expect(notes.get('4')).toBe('generators: PV 6 used by ESD1_1, PV 7');
    expect(notes.has('5')).toBe(false);
  });
});

describe('followLink', () => {
  it('sets the bus to the bus of the generator that was picked, and says so', () => {
    expect(followLink('gen', { bus: '', gen: 'PV_B' }, GENS)).toEqual({
      bus: '3',
      gen: 'PV_B',
      note: { field: 'bus', text: 'Set to bus 3, where PV_B is.' },
    });
    // A bus picked earlier gives way: the generator decides.
    expect(followLink('gen', { bus: '5', gen: '2' }, GENS)).toMatchObject({ bus: '2', gen: '2' });
  });

  it('leaves the bus alone when it is already the one of the generator', () => {
    expect(followLink('gen', { bus: '3', gen: 'PV_B' }, GENS)).toEqual({
      bus: '3',
      gen: 'PV_B',
      note: null,
    });
  });

  it('picks the generator of a bus that has exactly one, and says so', () => {
    expect(followLink('bus', { bus: '3', gen: '' }, GENS)).toEqual({
      bus: '3',
      gen: 'PV_B',
      note: { field: 'gen', text: 'Set to PV_B, the static generator on bus 3.' },
    });
    // Also in place of a generator on another bus.
    expect(followLink('bus', { bus: '2', gen: 'PV_B' }, GENS)).toMatchObject({ gen: '2' });
  });

  it('leaves the choice open on a bus with several, and keeps one already on that bus', () => {
    expect(followLink('bus', { bus: '4', gen: '' }, GENS)).toEqual({
      bus: '4',
      gen: '',
      note: null,
    });
    expect(followLink('bus', { bus: '4', gen: '7' }, GENS)).toEqual({
      bus: '4',
      gen: '7',
      note: null,
    });
  });

  it('drops a generator that is not on the bus that was picked', () => {
    expect(followLink('bus', { bus: '5', gen: '2' }, GENS)).toEqual({
      bus: '5',
      gen: '',
      note: null,
    });
    expect(followLink('bus', { bus: '4', gen: '2' }, GENS)).toMatchObject({ gen: '' });
  });

  it('does nothing for a generator the case does not have or one with no known bus', () => {
    expect(followLink('gen', { bus: '5', gen: 'nope' }, GENS)).toEqual({
      bus: '5',
      gen: 'nope',
      note: null,
    });
    const lost: StaticGenerator[] = [{ idx: '9', kind: 'PV', name: 'G9', bus: null, takenBy: [] }];
    expect(followLink('gen', { bus: '5', gen: '9' }, lost)).toMatchObject({ bus: '5', note: null });
  });
});

describe('freeGeneratorOn', () => {
  it('gives the one generator of a bus that no device takes over, with the line to say so', () => {
    expect(freeGeneratorOn('3', GENS)).toEqual({
      bus: '3',
      gen: 'PV_B',
      note: { field: 'gen', text: 'Set to PV_B, the static generator on bus 3.' },
    });
  });

  it('gives none where a device already takes the one generator over', () => {
    // A pick by hand would take it, with a warning: this is nobody's pick.
    expect(followLink('bus', { bus: '2', gen: '' }, GENS).gen).toBe('2');
    expect(freeGeneratorOn('2', GENS)).toBeNull();
    expect(freeGeneratorOn('1', GENS)).toBeNull();
  });

  it('gives none on a bus with several generators, with none, or that the case lacks', () => {
    expect(freeGeneratorOn('4', GENS)).toBeNull();
    expect(freeGeneratorOn('5', GENS)).toBeNull();
    expect(freeGeneratorOn('99', GENS)).toBeNull();
    expect(freeGeneratorOn('', GENS)).toBeNull();
  });
});

describe('linkWarnings', () => {
  it('says nothing for a free generator on its own bus, or while nothing is picked', () => {
    expect(linkWarnings({ bus: '3', gen: 'PV_B' }, GENS)).toEqual({});
    expect(linkWarnings({ bus: '', gen: '' }, GENS)).toEqual({});
  });

  it('warns under bus when the bus has no static generator', () => {
    const warnings = linkWarnings({ bus: '5', gen: '' }, GENS);
    expect(Object.keys(warnings)).toEqual(['bus']);
    expect(warnings.bus).toBe(
      'Bus 5 has no PV or Slack generator. Add one there first (Kind: PV generator), or pick a bus that names its generator.',
    );
  });

  it('does not point at other buses when no bus has a generator', () => {
    expect(linkWarnings({ bus: '5', gen: '' }, []).bus).toBe(
      'Bus 5 has no PV or Slack generator. Add one there first (Kind: PV generator).',
    );
  });

  it('warns under gen when a device already takes the generator over', () => {
    const warnings = linkWarnings({ bus: '2', gen: '2' }, GENS);
    expect(Object.keys(warnings)).toEqual(['gen']);
    expect(warnings.gen).toContain('GENROU_2 already takes over PV 2.');
    expect(warnings.gen).toContain('their gammap must add up to 1');
    expect(warnings.gen).toContain('the time-domain run does not initialize');
    expect(warnings.gen).toContain('add it (Kind: PV generator) and pick it here');
  });

  it('counts the devices on a shared generator in the plural', () => {
    const shared: StaticGenerator[] = [
      { idx: '6', kind: 'PV', name: '6', bus: '4', takenBy: ['1', '2', '3'] },
    ];
    expect(linkWarnings({ bus: '4', gen: '6' }, shared).gen).toContain(
      '1, 2 and 1 more already take over PV 6.',
    );
  });
});
