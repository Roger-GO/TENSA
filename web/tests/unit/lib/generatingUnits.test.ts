/**
 * `generatingUnits`: which models of a case are one generator. The diagram
 * draws a unit as one symbol and the Inspector lists it as one unit, so the
 * grouping is held here on the shapes the example cases have and on the ones
 * that could split or merge units wrongly.
 */
import { describe, expect, it } from 'vitest';
import {
  generatingUnits,
  selectedUnitMember,
  unitChipLabel,
  unitGenerators,
  unitMemberInfo,
  unitMemberSelection,
  unitOfSelection,
  unitRoleLabel,
  type GeneratingUnit,
} from '@/lib/generatingUnits';
import type { TopologyEntry, TopologySummary } from '@/api/types';

const entry = (
  idx: number | string,
  kind: string,
  params: Record<string, number | string | boolean> = {},
  name = `${kind}_${idx}`,
): TopologyEntry => ({ idx, name, kind, params });

function topologyOf(
  generators: TopologyEntry[],
  controllers: TopologyEntry[] = [],
): TopologySummary {
  return {
    state: 'pre-setup',
    buses: [],
    lines: [],
    transformers: [],
    generators,
    loads: [],
    shunts: [],
    controllers,
  };
}

/** A unit as `idx@bus: kind idx role depth, ...`. */
const shape = (unit: GeneratingUnit): string =>
  `${unit.idx}@${unit.bus}: ` +
  unit.members.map((m) => `${m.kind} ${m.idx} ${m.role} ${m.depth}`).join(', ');

describe('generatingUnits', () => {
  it('makes a unit of each static generator of a case with no dynamic models', () => {
    // wscc9.xlsx
    const { units, loose } = generatingUnits(
      topologyOf([
        entry(2, 'PV', { bus: 2 }),
        entry(3, 'PV', { bus: 3 }),
        entry(1, 'Slack', { bus: 1 }),
      ]),
    );
    expect(units.map(shape)).toEqual([
      '2@2: PV 2 generator 0',
      '3@3: PV 3 generator 0',
      '1@1: Slack 1 generator 0',
    ]);
    expect(loose).toEqual([]);
  });

  it('joins a machine to the generator it names, though their idx values differ', () => {
    // ieee14_full.xlsx: PV 2 on bus 2, GENROU_2 that names it, and their controllers.
    const { units, loose } = generatingUnits(
      topologyOf(
        [entry(2, 'PV', { bus: 2 }), entry('GENROU_2', 'GENROU', { bus: 2, gen: 2 })],
        [
          entry('TGOV1_2', 'TGOV1', { syn: 'GENROU_2' }),
          entry('EXST1_1', 'EXST1', { syn: 'GENROU_2' }),
        ],
      ),
    );
    expect(units.map(shape)).toEqual([
      '2@2: PV 2 generator 0, GENROU GENROU_2 machine 1, EXST1 EXST1_1 exciter 2, TGOV1 TGOV1_2 governor 2',
    ]);
    expect(loose).toEqual([]);
  });

  it('joins a machine to the generator numbered like it, and its governor by the same number', () => {
    // kundur_full.xlsx: Slack 1 and GENROU 1 on bus 1, TGOV1 1 with `syn: 1`.
    const { units } = generatingUnits(
      topologyOf(
        [entry(1, 'Slack', { bus: 1 }), entry(1, 'GENROU', { bus: 1, gen: 1 })],
        [entry(1, 'TGOV1', { syn: 1 })],
      ),
    );
    expect(units.map(shape)).toEqual([
      '1@1: Slack 1 generator 0, GENROU 1 machine 1, TGOV1 1 governor 2',
    ]);
    // Each model is still picked by an id of its own.
    expect(units[0]?.members.map((m) => m.nodeId)).toEqual([
      'generator-1',
      'generator-1',
      'controller-TGOV1-1',
    ]);
  });

  it('joins a machine that names no generator to the one numbered like it', () => {
    const { units } = generatingUnits(
      topologyOf([entry(2, 'PV', { bus: 1 }), entry(2, 'GENROU', { bus: 1 })]),
    );
    expect(units.map(shape)).toEqual(['2@1: PV 2 generator 0, GENROU 2 machine 1']);
  });

  it('makes a unit of a machine that names no generator of the case', () => {
    const { units } = generatingUnits(
      topologyOf(
        [entry('G', 'GENROU', { bus: 4 }), entry('H', 'GENCLS', { bus: 5, gen: 'GONE' })],
        [entry('E', 'EXST1', { syn: 'G' })],
      ),
    );
    expect(units.map(shape)).toEqual([
      'G@4: GENROU G machine 0, EXST1 E exciter 1',
      'H@5: GENCLS H machine 0',
    ]);
  });

  it('leaves a machine apart from the generator it names when that one is on another bus', () => {
    const { units } = generatingUnits(
      topologyOf([entry(1, 'PV', { bus: 1 }), entry('M', 'GENROU', { bus: 2, gen: 1 })]),
    );
    expect(units.map(shape)).toEqual(['1@1: PV 1 generator 0', 'M@2: GENROU M machine 0']);
  });

  it('takes two machines that name one generator into its unit, each with its own controllers', () => {
    const { units } = generatingUnits(
      topologyOf(
        [
          entry(1, 'PV', { bus: 1 }),
          entry('A', 'GENROU', { bus: 1, gen: 1 }),
          entry('B', 'GENCLS', { bus: 1, gen: 1 }),
        ],
        [entry('GA', 'TGOV1', { syn: 'A' }), entry('GB', 'TGOV1', { syn: 'B' })],
      ),
    );
    expect(units.map(shape)).toEqual([
      '1@1: PV 1 generator 0, GENROU A machine 1, TGOV1 GA governor 2, GENCLS B machine 1, TGOV1 GB governor 2',
    ]);
  });

  it('puts a stabiliser under its exciter, whatever order the case lists them in', () => {
    const { units } = generatingUnits(
      topologyOf(
        [entry('G', 'GENROU', { bus: 1 })],
        [
          entry('P', 'IEEEST', { avr: 'E' }),
          entry('T', 'TGOV1', { syn: 'G' }),
          entry('E', 'EXST1', { syn: 'G' }),
        ],
      ),
    );
    expect(units.map(shape)).toEqual([
      'G@1: GENROU G machine 0, EXST1 E exciter 1, IEEEST P pss 2, TGOV1 T governor 1',
    ]);
  });

  it('takes the exciter for what `avr` names where a governor has the same idx', () => {
    const { units } = generatingUnits(
      topologyOf(
        [entry('G1', 'GENROU', { bus: 1 }), entry('G2', 'GENROU', { bus: 2 })],
        [
          entry(1, 'TGOV1', { syn: 'G2' }),
          entry(1, 'EXST1', { syn: 'G1' }),
          entry('P', 'IEEEST', { avr: 1 }),
        ],
      ),
    );
    expect(units.map(shape)).toEqual([
      'G1@1: GENROU G1 machine 0, EXST1 1 exciter 1, IEEEST P pss 2',
      'G2@2: GENROU G2 machine 0, TGOV1 1 governor 1',
    ]);
  });

  it('hangs a stabiliser on no governor that happens to have the idx of its exciter', () => {
    // kundur_ieeest.xlsx: the exciters are EXDC2, which the topology does not
    // list, and IEEEST 1 names exciter 1. Governor 1 is no exciter.
    const pss = entry(1, 'IEEEST', { avr: 1 });
    const { units, loose } = generatingUnits(
      topologyOf(
        [entry(1, 'Slack', { bus: 1 }), entry(1, 'GENROU', { bus: 1, gen: 1 })],
        [entry(1, 'TGOV1', { syn: 1 }), pss],
      ),
    );
    expect(units.map(shape)).toEqual([
      '1@1: Slack 1 generator 0, GENROU 1 machine 1, TGOV1 1 governor 2',
    ]);
    expect(loose).toEqual([pss]);
  });

  it('takes a model the diagram has no name for as the exciter a stabiliser means', () => {
    // An exciter class the table of classes does not know yet.
    const { units } = generatingUnits(
      topologyOf(
        [entry('G', 'GENROU', { bus: 1 })],
        [entry(7, 'NEWEXC', { syn: 'G' }), entry('P', 'IEEEST', { avr: 7 })],
      ),
    );
    expect(units.map(shape)).toEqual(['G@1: GENROU G machine 0, NEWEXC 7 other 1, IEEEST P pss 2']);
  });

  it('tells the converter, its electrical control and its plant control apart though all three are numbered 1', () => {
    // ieee14_solar.xlsx: REGCA1 1, REECA1 1 with `reg: 1`, REPCA1 1 with `ree: 1`.
    const { units } = generatingUnits(
      topologyOf(
        [entry(5, 'PV', { bus: 8 })],
        [
          entry(1, 'REGCA1', { bus: 8, gen: 5 }),
          entry(1, 'REECA1', { reg: 1 }),
          entry(1, 'REPCA1', { ree: 1 }),
        ],
      ),
    );
    expect(units.map(shape)).toEqual([
      '5@8: PV 5 generator 0, REGCA1 1 renewable 1, REECA1 1 renewable 2, REPCA1 1 renewable 3',
    ]);
  });

  it('takes a converter and its controls into the unit of the generator the converter names', () => {
    const { units, loose } = generatingUnits(
      topologyOf(
        [entry(4, 'PV', { bus: 4 })],
        [
          entry('REPCA1_1', 'REPCA1', { ree: 'REECA1_1' }),
          entry('REECA1_1', 'REECA1', { reg: 'REGCA1_1' }),
          entry('REGCA1_1', 'REGCA1', { bus: 4, gen: 4 }),
        ],
      ),
    );
    expect(units.map(shape)).toEqual([
      '4@4: PV 4 generator 0, REGCA1 REGCA1_1 renewable 1, REECA1 REECA1_1 renewable 2, REPCA1 REPCA1_1 renewable 3',
    ]);
    expect(loose).toEqual([]);
  });

  it('lists a machine before a battery on the same generator', () => {
    const { units } = generatingUnits(
      topologyOf(
        [entry(4, 'PV', { bus: 4 }), entry('M', 'GENROU', { bus: 4, gen: 4 })],
        [entry('ESD1_1', 'ESD1', { bus: 4, gen: 4 }), entry('T', 'TGOV1', { syn: 'M' })],
      ),
    );
    expect(units.map(shape)).toEqual([
      '4@4: PV 4 generator 0, GENROU M machine 1, TGOV1 T governor 2, ESD1 ESD1_1 renewable 1',
    ]);
  });

  it('takes a `syn` that matches no machine but a generator to mean that generator', () => {
    const { units } = generatingUnits(
      topologyOf([entry('PV_1', 'PV', { bus: 1 })], [entry('E', 'EXST1', { syn: 'PV_1' })]),
    );
    expect(units.map(shape)).toEqual(['PV_1@1: PV PV_1 generator 0, EXST1 E exciter 1']);
  });

  it('leaves out of every unit a controller of a bus, one that names nothing, and what refers to either', () => {
    const pmu = entry('PMU_1', 'PMU', { bus: 1 });
    const orphan = entry('E9', 'EXST1', { syn: 'GHOST' });
    const ofOrphan = entry('P9', 'IEEEST', { avr: 'E9' });
    const profile = entry('TS', 'TimeSeries', {});
    const { units, loose } = generatingUnits(
      topologyOf([entry('G', 'GENROU', { bus: 1 })], [pmu, orphan, ofOrphan, profile]),
    );
    expect(units.map(shape)).toEqual(['G@1: GENROU G machine 0']);
    expect(loose).toEqual([pmu, orphan, ofOrphan, profile]);
  });

  it('does not loop on two controllers that name each other', () => {
    const a = entry('A', 'REECA1', { reg: 'B' });
    const b = entry('B', 'REGCA1', { ree: 'A' });
    const { units, loose } = generatingUnits(topologyOf([], [a, b]));
    expect(units).toEqual([]);
    expect(loose).toEqual([a, b]);
  });

  it('draws a second static generator of the same idx no second time', () => {
    const { units } = generatingUnits(
      topologyOf([entry(1, 'PV', { bus: 1 }), entry(1, 'Slack', { bus: 2 })]),
    );
    expect(units.map(shape)).toEqual(['1@1: PV 1 generator 0']);
  });

  it('reads a case that has no controllers bucket', () => {
    const topology = topologyOf([entry(1, 'PV', { bus: 1 })]);
    delete (topology as { controllers?: unknown }).controllers;
    expect(generatingUnits(topology).units.map(shape)).toEqual(['1@1: PV 1 generator 0']);
  });
});

describe('picking a model of a unit', () => {
  const { units } = generatingUnits(
    topologyOf(
      [
        entry(1, 'Slack', { bus: 1 }),
        entry(1, 'GENROU', { bus: 1, gen: 1 }),
        entry(2, 'PV', { bus: 2 }),
        entry('GENROU_2', 'GENROU', { bus: 2, gen: 2 }),
      ],
      [entry(1, 'TGOV1', { syn: 1 }), entry(1, 'EXST1', { syn: 'GENROU_2' })],
    ),
  );
  const [kundur, ieee] = units as [GeneratingUnit, GeneratingUnit];

  it('selects a generator or a machine by its idx and its model, a controller with its sub-kind', () => {
    expect(kundur.members.map(unitMemberSelection)).toEqual([
      { kind: 'generator', idx: '1', modelClass: 'Slack' },
      { kind: 'generator', idx: '1', modelClass: 'GENROU' },
      { kind: 'controller', subKind: 'governor', modelClass: 'TGOV1', idx: '1' },
    ]);
  });

  it('finds the member a selection is, telling a machine from the generator numbered like it', () => {
    const kindOf = (selected: Parameters<typeof selectedUnitMember>[1]) =>
      selectedUnitMember(kundur.members, selected)?.kind ?? null;
    expect(kindOf({ kind: 'generator', idx: '1', modelClass: 'GENROU' })).toBe('GENROU');
    expect(kindOf({ kind: 'generator', idx: '1', modelClass: 'Slack' })).toBe('Slack');
    // By the idx alone it is the first the case lists: the static generator.
    expect(kindOf({ kind: 'generator', idx: '1' })).toBe('Slack');
    expect(kindOf({ kind: 'controller', subKind: 'governor', modelClass: 'TGOV1', idx: '1' })).toBe(
      'TGOV1',
    );
    // The exciter numbered like the governor is another unit's.
    expect(
      kindOf({ kind: 'controller', subKind: 'exciter', modelClass: 'EXST1', idx: '1' }),
    ).toBeNull();
    expect(kindOf({ kind: 'bus', idx: '1' })).toBeNull();
    expect(kindOf(null)).toBeNull();
  });

  it('takes a machine picked by its idx alone for the machine, where no generator has that idx', () => {
    expect(selectedUnitMember(ieee.members, { kind: 'generator', idx: 'GENROU_2' })?.kind).toBe(
      'GENROU',
    );
  });

  it('finds the unit a selection is a model of', () => {
    expect(unitOfSelection(units, { kind: 'generator', idx: 'GENROU_2' })).toBe(ieee);
    expect(unitOfSelection(units, { kind: 'generator', idx: '2', modelClass: 'PV' })).toBe(ieee);
    expect(
      unitOfSelection(units, {
        kind: 'controller',
        subKind: 'exciter',
        modelClass: 'EXST1',
        idx: '1',
      }),
    ).toBe(ieee);
    expect(
      unitOfSelection(units, {
        kind: 'controller',
        subKind: 'governor',
        modelClass: 'TGOV1',
        idx: '1',
      }),
    ).toBe(kundur);
    expect(unitOfSelection(units, { kind: 'load', idx: '1' })).toBeNull();
    expect(unitOfSelection(units, { kind: 'generator', idx: 'NONE' })).toBeNull();
    expect(unitOfSelection(units, null)).toBeNull();
  });

  it('finds the unit of the static generator where a machine of another unit has its idx', () => {
    // Generator 5 on bus 1, and a machine numbered 5 that belongs to generator 9.
    const mixed = generatingUnits(
      topologyOf([
        entry(5, 'PV', { bus: 1 }),
        entry(9, 'PV', { bus: 2 }),
        entry(5, 'GENROU', { bus: 2, gen: 9 }),
      ]),
    ).units;
    expect(unitOfSelection(mixed, { kind: 'generator', idx: '5' })?.idx).toBe('5');
    expect(unitOfSelection(mixed, { kind: 'generator', idx: '5', modelClass: 'GENROU' })?.idx).toBe(
      '9',
    );
  });

  it('gives the generator and the machines of the unit a selected generator is one of', () => {
    const topology = topologyOf(
      [
        entry(2, 'PV', { bus: 2 }),
        entry('GENROU_2', 'GENROU', { bus: 2, gen: 2 }),
        entry(3, 'PV', { bus: 3 }),
      ],
      [entry('T', 'TGOV1', { syn: 'GENROU_2' })],
    );
    const kinds = (selected: Parameters<typeof unitGenerators>[1]) =>
      unitGenerators(topology, selected).map((m) => `${m.kind} ${m.idx}`);
    // From either of the two, both: to the reader they are one generator.
    expect(kinds({ kind: 'generator', idx: '2', modelClass: 'PV' })).toEqual([
      'PV 2',
      'GENROU GENROU_2',
    ]);
    expect(kinds({ kind: 'generator', idx: 'GENROU_2' })).toEqual(['PV 2', 'GENROU GENROU_2']);
    expect(kinds({ kind: 'generator', idx: '3' })).toEqual(['PV 3']);
    // Nothing for what is no generator, or without a case to read it from.
    expect(
      kinds({ kind: 'controller', subKind: 'governor', modelClass: 'TGOV1', idx: 'T' }),
    ).toEqual([]);
    expect(kinds({ kind: 'bus', idx: '2' })).toEqual([]);
    expect(kinds(null)).toEqual([]);
    expect(unitGenerators(null, { kind: 'generator', idx: '2' })).toEqual([]);
  });

  it('keeps of a member what a node needs, without the entry', () => {
    expect(unitMemberInfo(ieee.members[1]!)).toEqual({
      kind: 'GENROU',
      idx: 'GENROU_2',
      name: 'GENROU_GENROU_2',
      role: 'machine',
      nodeId: 'generator-GENROU_2',
      depth: 1,
    });
  });
});

describe('unitChipLabel', () => {
  it('names a model by what it is to its unit', () => {
    const label = (kind: string, role: Parameters<typeof unitChipLabel>[0]['role']) =>
      unitChipLabel({ kind, role });
    expect(label('GENROU', 'machine')).toBe('SG');
    expect(label('GENCLS', 'machine')).toBe('SG');
    expect(label('EXST1', 'exciter')).toBe('AVR');
    expect(label('TGOV1', 'governor')).toBe('GOV');
    expect(label('IEEEST', 'pss')).toBe('PSS');
    expect(label('PV', 'generator')).toBe('GEN');
  });

  it('names a converter and its controls by their WECC stage, and any other model by its class', () => {
    const label = (kind: string) => unitChipLabel({ kind, role: 'renewable' });
    expect(label('REGCA1')).toBe('REGC');
    expect(label('REGCP1')).toBe('REGC');
    expect(label('REECA1')).toBe('REEC');
    expect(label('REPCA1')).toBe('REPC');
    expect(label('ESD1')).toBe('ESD1');
    expect(label('PVD1')).toBe('PVD1');
    expect(unitChipLabel({ kind: 'Coupling', role: 'measurement' })).toBe('COUP');
  });
});

describe('unitRoleLabel', () => {
  it('has words for every role', () => {
    expect(
      (
        [
          'generator',
          'machine',
          'exciter',
          'governor',
          'pss',
          'renewable',
          'measurement',
          'profile',
          'other',
        ] as const
      ).map(unitRoleLabel),
    ).toEqual([
      'Generator',
      'Machine',
      // A controller by the words the Inspector heads it with.
      'Exciter',
      'Governor',
      'PSS',
      'Renewable',
      'Measurement',
      'Profile',
      'Controller',
    ]);
  });
});
