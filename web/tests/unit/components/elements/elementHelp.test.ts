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
});

describe('elementWarnings', () => {
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
    expect(elementDefaults('ESD1', { baseMva: 100 })).toEqual({ Sn: 100, pqflag: 1, pmx: 1 });
    expect(elementDefaults('ESD1', { baseMva: 250 })).toEqual({ Sn: 250, pqflag: 1, pmx: 1 });
  });

  it('leaves the rating empty when the case has no usable base', () => {
    expect(elementDefaults('ESD1', { baseMva: null })).toEqual({ pqflag: 1, pmx: 1 });
  });

  it('leaves the energy for the user to give', () => {
    expect(elementDefaults('ESD1', { baseMva: 100 })).not.toHaveProperty('En');
  });

  it('has none for another model', () => {
    expect(elementDefaults('Bus', { baseMva: 100 })).toBeUndefined();
  });
});

describe('namedAfterIdx', () => {
  it('names a battery after its idx, and leaves the name of anything else to the user', () => {
    expect(namedAfterIdx('ESD1')).toBe(true);
    for (const model of ['Bus', 'PV', 'GENROU', 'TGOV1']) {
      expect(namedAfterIdx(model), model).toBe(false);
    }
  });
});
