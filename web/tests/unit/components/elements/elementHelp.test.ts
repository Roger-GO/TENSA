/**
 * elementHelp: what the add form says about a model beyond its parameter
 * names, the warnings that follow what is typed, and the values it opens with.
 */
import { describe, it, expect } from 'vitest';

import {
  elementDefaults,
  elementHelp,
  elementWarnings,
  namedAfterIdx,
  systemBaseEquivalent,
} from '@/components/elements/elementHelp';

describe('elementHelp', () => {
  it('has nothing to add for a model the schema describes well enough', () => {
    expect(elementHelp('Bus', { baseMva: 100 })).toBeNull();
    expect(elementHelp('GENROU', { baseMva: 100 })).toBeNull();
  });

  it('tells a battery to keep its rating on the system base, and names that base', () => {
    const help = elementHelp('ESD1', { baseMva: 100 });
    expect(help).not.toBeNull();
    const note = help!.note.join(' ');
    expect(note).toContain('Keep Sn equal to the system base (100 MVA).');
    expect(note).toContain('per unit of Sn');
    expect(note).toContain('per unit of the system base');
    expect(help!.fields.Sn).toContain('system base (100 MVA)');
  });

  it('says that a ZIP load takes over a PQ load, and what its shares are', () => {
    const help = elementHelp('ZIP', { baseMva: 100 });
    expect(help).not.toBeNull();
    const note = help!.note.join(' ');
    expect(note).toContain('takes over the PQ load named in pq');
    expect(note).toContain('Add the PQ load first.');
    expect(note).toContain('each three must add up to 100');
    expect(help!.fields.pq).toContain('idx of the PQ load');
    expect(Object.keys(help!.fields).sort()).toEqual([
      'kpi',
      'kpp',
      'kpz',
      'kqi',
      'kqp',
      'kqz',
      'pq',
    ]);
  });

  it('names the base the case sets, not 100', () => {
    const help = elementHelp('ESD1', { baseMva: 250 });
    expect(help!.note.join(' ')).toContain('the system base (250 MVA)');
    expect(help!.fields.Sn).toContain('(250 MVA)');
  });

  it('gives the advice without a number when the case has no usable base', () => {
    const help = elementHelp('ESD1', { baseMva: null });
    expect(help!.note.join(' ')).toContain('Keep Sn equal to the system base.');
    expect(help!.fields.Sn).not.toContain('MVA)');
  });

  it('says what a battery needs first, how to plot its charge and how to step its power', () => {
    const note = elementHelp('ESD1', { baseMva: 100 })!.note.join(' ');
    expect(note).toContain('add a PV generator there first');
    expect(note).toContain('pIG_y');
    expect(note).toContain('ANDES variables to record');
    expect(note).toContain('Alter disturbance on Pext0');
  });

  it('explains the fields whose names do not', () => {
    const fields = elementHelp('ESD1', { baseMva: 100 })!.fields;
    for (const name of [
      'bus',
      'gen',
      'Sn',
      'pqflag',
      'pmx',
      'En',
      'SOCinit',
      'EtaC',
      'EtaD',
      'fn',
    ]) {
      expect(fields[name], name).toBeTruthy();
    }
    expect(fields.bus).toContain('picking the generator below sets the bus');
    expect(fields.pmx).toContain('1 is the rating');
    expect(fields.pmx).toContain('9999');
    expect(fields.fn).toContain('between ft1 and ft2');
    // A field with nothing to explain has no line.
    expect(fields.idx).toBeUndefined();
  });

  it('says that the energy the form opens with is not the battery to study', () => {
    expect(elementHelp('ESD1', { baseMva: 100 })!.fields.En).toContain(
      'The form opens with one hour at the rating',
    );
  });

  it('says what the four numbers of a PV generator are, with no note above them', () => {
    const help = elementHelp('PV', { baseMva: 100 });
    expect(help!.note).toEqual([]);
    // Sn does not scale the powers: said without setting the two side by side.
    expect(help!.fields.Sn).toContain('It does not scale the powers below');
    expect(help!.fields.Sn).toContain('per unit of the system base (100 MVA)');
    expect(help!.fields.Vn).toContain('the Vn of the bus it is on');
    expect(help!.fields.Vn).toContain('the form fills in when the bus is picked');
    expect(help!.fields.p0).toContain('per unit of the system base (100 MVA): 0.4 is 40 MW');
    expect(help!.fields.p0).toContain('0 starts it idle');
    expect(help!.fields.v0).toContain('1 is the rated voltage');
    expect(help!.fields.idx).toBeUndefined();
  });

  it("works the PV example out on the case's base, and leaves it out without one", () => {
    expect(elementHelp('PV', { baseMva: 250 })!.fields.p0).toContain('(250 MVA): 0.4 is 100 MW');
    const bare = elementHelp('PV', { baseMva: null })!.fields;
    expect(bare.p0).toContain('per unit of the system base.');
    expect(bare.p0).not.toContain('MW');
    expect(bare.Sn).not.toContain('MVA)');
  });

  it('explains a Slack generator alike, but not its power, which the power flow finds', () => {
    const fields = elementHelp('Slack', { baseMva: 100 })!.fields;
    expect(fields.Sn).toBeTruthy();
    expect(fields.Vn).toBeTruthy();
    expect(fields.v0).toBeTruthy();
    expect(fields.p0).toBeUndefined();
  });
});

describe('elementWarnings', () => {
  it('says when the shares of a ZIP load do not add up to 100', () => {
    const shares = { kpp: 50, kpi: 30, kpz: 20, kqp: '60', kqi: '0', kqz: '40' };
    expect(elementWarnings('ZIP', shares, { baseMva: 100 })).toEqual({});
    expect(elementWarnings('ZIP', { ...shares, kpz: 10 }, { baseMva: 100 })).toEqual({
      kpp: 'The shares of the active power (kpp, kpi, kpz) add up to 90, not 100.',
    });
    expect(elementWarnings('ZIP', { ...shares, kqz: 50.5 }, { baseMva: 100 })).toEqual({
      kqp: 'The shares of the reactive power (kqp, kqi, kqz) add up to 110.5, not 100.',
    });
  });

  it('waits for all three shares of a ZIP load before it adds them up', () => {
    expect(elementWarnings('ZIP', { kpp: 50, kpi: '', kqp: 100 }, { baseMva: null })).toEqual({});
  });

  it('says nothing while the rating is the system base', () => {
    expect(elementWarnings('ESD1', { Sn: 100 }, { baseMva: 100 })).toEqual({});
    expect(elementWarnings('ESD1', { Sn: '100' }, { baseMva: 100 })).toEqual({});
    expect(elementWarnings('ESD1', { Sn: '100.0' }, { baseMva: 100 })).toEqual({});
  });

  it('says nothing about a rating that is empty, not a number or not above zero', () => {
    for (const sn of ['', 'abc', 0, -5]) {
      expect(elementWarnings('ESD1', { Sn: sn }, { baseMva: 100 })).toEqual({});
    }
  });

  it('says nothing when the case has no usable base to compare with', () => {
    expect(elementWarnings('ESD1', { Sn: 50 }, { baseMva: null })).toEqual({});
  });

  it('warns under Sn when the rating is another number, with both bases', () => {
    const warnings = elementWarnings('ESD1', { Sn: '50' }, { baseMva: 100 });
    expect(Object.keys(warnings)).toEqual(['Sn']);
    expect(warnings.Sn).toContain('Sn is not the system base (100 MVA)');
    expect(warnings.Sn).toContain('per unit of 50 MVA');
    expect(warnings.Sn).toContain('per unit of 100 MVA');
  });

  it('works out what the power limit comes to on the system base', () => {
    const warnings = elementWarnings('ESD1', { Sn: 50, pmx: 1 }, { baseMva: 100 });
    expect(warnings.Sn).toContain(
      'With pmx = 1 the battery delivers at most 0.5 pu on the system base (50 MW).',
    );
    // No limit to work out for ANDES's "no limit" value, or without one.
    expect(elementWarnings('ESD1', { Sn: 50, pmx: 9999 }, { baseMva: 100 }).Sn).not.toContain(
      'at most',
    );
    expect(elementWarnings('ESD1', { Sn: 50, pmx: '' }, { baseMva: 100 }).Sn).not.toContain(
      'at most',
    );
  });

  it('warns under SOCinit when the state of charge is outside its window', () => {
    const warnings = elementWarnings('ESD1', { Sn: 100, SOCinit: '1.5' }, { baseMva: 100 });
    expect(Object.keys(warnings)).toEqual(['SOCinit']);
    // Left empty, the window is ANDES's own.
    expect(warnings.SOCinit).toContain('1.5 is outside SOCmin to SOCmax (0 to 1)');
    expect(warnings.SOCinit).toContain('The add is refused');
    expect(elementWarnings('ESD1', { SOCinit: -0.1 }, { baseMva: 100 }).SOCinit).toBeDefined();
  });

  it('reads the window the form holds, and says nothing inside it or with no value', () => {
    const window = { SOCmin: '0.2', SOCmax: '0.8' };
    expect(
      elementWarnings('ESD1', { ...window, SOCinit: '0.9' }, { baseMva: 100 }).SOCinit,
    ).toContain('(0.2 to 0.8)');
    for (const soc of ['0.2', '0.5', '0.8', '']) {
      expect(elementWarnings('ESD1', { ...window, SOCinit: soc }, { baseMva: 100 })).toEqual({});
    }
    expect(elementWarnings('ESD1', { SOCinit: 1 }, { baseMva: 100 })).toEqual({});
  });

  it('has no warnings for another model', () => {
    expect(elementWarnings('PV', { Sn: 50, SOCinit: 5 }, { baseMva: 100 })).toEqual({});
  });
});

describe('elementDefaults', () => {
  it('opens a battery rated on the system base, limited to its rating, active power first', () => {
    expect(elementDefaults('ESD1', { baseMva: 100 })).toMatchObject({ Sn: 100, pqflag: 1, pmx: 1 });
    expect(elementDefaults('ESD1', { baseMva: 250 })).toMatchObject({ Sn: 250, pqflag: 1, pmx: 1 });
  });

  it('opens a battery holding one hour of its rating, so no required field is empty', () => {
    expect(elementDefaults('ESD1', { baseMva: 100 })).toEqual({
      Sn: 100,
      pqflag: 1,
      pmx: 1,
      En: 100,
    });
    expect(elementDefaults('ESD1', { baseMva: 250 })?.En).toBe(250);
  });

  it('leaves the rating and the energy empty when the case has no usable base', () => {
    expect(elementDefaults('ESD1', { baseMva: null })).toEqual({ pqflag: 1, pmx: 1 });
  });

  it('has none for another model', () => {
    expect(elementDefaults('Bus', { baseMva: 100 })).toBeUndefined();
  });
});

describe('namedAfterIdx', () => {
  it('names every model after the idx its form proposes', () => {
    for (const model of ['ESD1', 'PV', 'Slack', 'Bus', 'Line', 'PQ', 'GENROU', 'TGOV1']) {
      expect(namedAfterIdx(model), model).toBe(true);
    }
  });
});

describe('the help of a load and of a line', () => {
  it('says which base a load is on, and what a value is in MW', () => {
    const help = elementHelp('PQ', { baseMva: 100 })!;
    expect(help.note).toEqual([]);
    expect(help.fields.p0).toBe(
      'Active power the load draws, per unit of the system base (100 MVA): 0.9 is 90 MW.',
    );
    expect(help.fields.q0).toContain('0.3 is 30 MVAr');
    expect(help.fields.Vn).toContain('the form fills in when the bus is picked');
  });

  it('gives no example in MW for a case that has no base', () => {
    const help = elementHelp('PQ', { baseMva: null })!;
    expect(help.fields.p0).toBe('Active power the load draws, per unit of the system base.');
  });

  it('says which base a line is on and what order of size its values have', () => {
    const help = elementHelp('Line', { baseMva: 100 })!;
    expect(help.fields.r).toContain('per unit of the system base (100 MVA)');
    expect(help.fields.r).toContain('from about 0.01 to 0.22');
    expect(help.fields.x).toContain('from about 0.04 to 0.35');
    expect(help.fields.rate_a).toContain('not checked for overload');
  });
});

describe('systemBaseEquivalent', () => {
  const context = { baseMva: 100 };

  it('says what a power per unit of the system base is in MW or MVAr', () => {
    expect(systemBaseEquivalent('PQ', 'p0', '0.9', context)).toBe('= 90 MW');
    expect(systemBaseEquivalent('PQ', 'q0', 0.3, context)).toBe('= 30 MVAr');
    expect(systemBaseEquivalent('PV', 'qmax', '-0.25', { baseMva: 200 })).toBe('= -50 MVAr');
  });

  it('answers nothing for a field that holds no such power, an empty one, or no base', () => {
    expect(systemBaseEquivalent('PQ', 'Vn', '138', context)).toBeNull();
    expect(systemBaseEquivalent('Line', 'r', '0.01', context)).toBeNull();
    // A machine's powers are per unit of its own rating, not of the system base.
    expect(systemBaseEquivalent('GENROU', 'p0', '0.9', context)).toBeNull();
    expect(systemBaseEquivalent('PQ', 'p0', '', context)).toBeNull();
    expect(systemBaseEquivalent('PQ', 'p0', 'abc', context)).toBeNull();
    expect(systemBaseEquivalent('PQ', 'p0', '0.9', { baseMva: null })).toBeNull();
  });
});
