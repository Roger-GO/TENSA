/**
 * The frequency controllers of a TDS run: what the form opens with, what it
 * refuses, what it sends, and how a controller and its outcome are worded.
 */
import { describe, expect, it } from 'vitest';
import type { TdsControllerCatalogue, TdsControllerResult, TdsControllerTarget } from '@/api/types';
import {
  defaultDraft,
  describeController,
  describeResult,
  draftFromSpec,
  entryFromDraft,
  formatNumber,
  recordedVariables,
  runDaeVars,
  summariseResults,
  targetKey,
  targetLabel,
  validateDraft,
  type ControllerDraft,
  type TdsControllerEntry,
  type TdsControllerSpec,
} from '@/lib/tdsControllers';

function target(extra: Partial<TdsControllerTarget> = {}): TdsControllerTarget {
  return {
    model: 'ESD1',
    idx: 1,
    name: 'ESD1_1',
    bus: 4,
    in_service: true,
    p_limit: 40,
    fn: 60,
    variables: {
      command: 'Pext ESD1 1',
      frequency: 'fHz ESD1 1',
      active_current: 'Ipout_y ESD1 1',
      soc: 'pIG_y ESD1 1',
    },
    ...extra,
  };
}

function catalogue(extra: Partial<TdsControllerCatalogue> = {}): TdsControllerCatalogue {
  return {
    types: ['droop', 'ffr'],
    coi_available: true,
    freq_hz: 60,
    base_mva: 100,
    targets: [target()],
    ...extra,
  };
}

function draft(patch: Partial<ControllerDraft> = {}): ControllerDraft {
  return { ...defaultDraft(catalogue()), ...patch };
}

const DROOP: TdsControllerSpec = {
  type: 'droop',
  model: 'ESD1',
  idx: 1,
  frequency: 'coi',
  period: 0.1,
  t_start: 0,
  ramp: null,
  gain: 80,
  deadband: 0.02,
  p_max: null,
};

const FFR: TdsControllerSpec = {
  type: 'ffr',
  model: 'ESD1',
  idx: 1,
  frequency: 'bus',
  period: 0.1,
  t_start: 0,
  ramp: null,
  power: 30,
  trigger_deviation: 0.1,
  trigger_rocof: null,
  hold: 10,
};

function result(extra: Partial<TdsControllerResult>): TdsControllerResult {
  return {
    type: 'droop',
    model: 'ESD1',
    idx: 1,
    samples: 60,
    first_action_t: null,
    released_t: null,
    peak_command: 0,
    final_command: 0,
    ...extra,
  };
}

describe('the form a controller is set in', () => {
  it('opens as a droop that reaches the device limit at half a hertz', () => {
    expect(defaultDraft(catalogue())).toEqual({
      type: 'droop',
      target: targetKey({ model: 'ESD1', idx: 1 }),
      frequency: 'coi',
      period: '0.1',
      tStart: '0',
      ramp: '',
      gain: '80',
      deadband: '0.02',
      pMax: '',
      power: '40',
      triggerDeviation: '0.1',
      triggerRocof: '',
      hold: '10',
    });
  });

  it('opens on the first device in service', () => {
    const off = target({ idx: 1, in_service: false });
    const on = target({ idx: 2 });
    expect(defaultDraft(catalogue({ targets: [off, on] })).target).toBe(targetKey(on));
    // With every device off, the first is as good as any.
    expect(defaultDraft(catalogue({ targets: [off] })).target).toBe(targetKey(off));
  });

  it('leaves the size blank for a device with no limit to size it by', () => {
    for (const p_limit of [null, 9999 * 100]) {
      const opened = defaultDraft(catalogue({ targets: [target({ p_limit })] }));
      expect(opened.gain).toBe('');
      expect(opened.power).toBe('');
    }
  });

  it('reads the bus frequency on a case with no machine to give the system one', () => {
    expect(defaultDraft(catalogue({ coi_available: false })).frequency).toBe('bus');
  });

  it('has no device picked while the case has none', () => {
    expect(defaultDraft(catalogue({ targets: [] })).target).toBe('');
    expect(validateDraft(defaultDraft(catalogue({ targets: [] }))).target).toBe('Pick a device');
  });

  it('accepts what it opens with', () => {
    expect(validateDraft(draft())).toEqual({});
    expect(validateDraft(draft({ type: 'ffr' }))).toEqual({});
  });

  it.each([
    [{ gain: '' }, 'gain', 'Required'],
    [{ gain: 'lots' }, 'gain', 'Enter a number'],
    [{ gain: '0' }, 'gain', 'Must be above 0'],
    [{ gain: '-5' }, 'gain', 'Must be above 0'],
    [{ deadband: '' }, 'deadband', 'Required'],
    [{ deadband: '-0.1' }, 'deadband', 'Must not be negative'],
    [{ pMax: '0' }, 'pMax', 'Must be above 0'],
    [{ pMax: 'x' }, 'pMax', 'Enter a number or leave blank'],
    [{ period: '0.0001' }, 'period', 'Must be between 0.001 and 60 s'],
    [{ period: '61' }, 'period', 'Must be between 0.001 and 60 s'],
    [{ tStart: '-1' }, 'tStart', 'Must not be negative'],
    [{ ramp: '0' }, 'ramp', 'Must be above 0'],
  ] as const)('refuses a droop with %o', (patch, field, message) => {
    expect(validateDraft(draft(patch))).toEqual({ [field]: message });
  });

  it.each([
    [{ power: '' }, 'power', 'Required'],
    [{ power: '0' }, 'power', 'Must not be 0: positive discharges, negative absorbs'],
    [{ hold: '0' }, 'hold', 'Must be above 0'],
    [{ triggerDeviation: '-0.1' }, 'triggerDeviation', 'Must be above 0'],
    [{ triggerRocof: '0' }, 'triggerRocof', 'Must be above 0'],
    [{ triggerDeviation: '' }, 'triggerDeviation', 'Give a deviation, a rate, or both'],
  ] as const)('refuses a fast frequency response with %o', (patch, field, message) => {
    expect(validateDraft(draft({ type: 'ffr', ...patch }))).toEqual({ [field]: message });
  });

  it('takes a rate alone, a deviation alone, or both as the trigger', () => {
    const ffr = (patch: Partial<ControllerDraft>) =>
      validateDraft(draft({ type: 'ffr', ...patch }));
    expect(ffr({ triggerDeviation: '', triggerRocof: '0.5' })).toEqual({});
    expect(ffr({ triggerDeviation: '0.1', triggerRocof: '0.5' })).toEqual({});
    expect(ffr({ power: '-20' })).toEqual({});
  });

  it('does not hold a droop to the rules of the other kind', () => {
    expect(validateDraft(draft({ power: '0', hold: '', triggerDeviation: '' }))).toEqual({});
    expect(validateDraft(draft({ type: 'ffr', gain: '', deadband: '-1' }))).toEqual({});
  });
});

describe('what the run is sent', () => {
  it('turns a droop form into its request, blanks left to the substrate', () => {
    expect(entryFromDraft(draft({ gain: ' 80 ', deadband: '0.02' }), target())).toEqual({
      spec: DROOP,
      record: ['Pext ESD1 1', 'Ipout_y ESD1 1', 'pIG_y ESD1 1'],
    });
  });

  it('keeps the limits and the timing a droop form names', () => {
    const { spec } = entryFromDraft(
      draft({ pMax: '25', ramp: '100', period: '0.05', tStart: '1.5', frequency: 'bus' }),
      target(),
    );
    expect(spec).toMatchObject({
      p_max: 25,
      ramp: 100,
      period: 0.05,
      t_start: 1.5,
      frequency: 'bus',
    });
  });

  it('turns a fast frequency response form into its request', () => {
    const { spec } = entryFromDraft(
      draft({ type: 'ffr', power: '30', frequency: 'bus', triggerRocof: '' }),
      target(),
    );
    expect(spec).toEqual(FFR);
    // Nothing of the other kind rides along: the substrate refuses unknown fields.
    expect(Object.keys(spec)).not.toContain('gain');
  });

  it('names the device as the catalogue holds it, text or number', () => {
    const named = target({ idx: 'ESD1_B' });
    expect(entryFromDraft(draft(), named).spec.idx).toBe('ESD1_B');
    // An idx that already says what the device is stands alone, as in the messages.
    expect(targetLabel(named)).toBe('ESD1_B');
    expect(targetLabel(target())).toBe('ESD1 1');
    expect(targetLabel(target({ idx: 'B7' }))).toBe('ESD1 B7');
    expect(targetKey(named)).not.toBe(targetKey(target()));
  });

  it('records no state of charge for a device without one', () => {
    const pv = target({
      model: 'PVD1',
      variables: {
        command: 'Pext PVD1 1',
        frequency: 'fHz PVD1 1',
        active_current: 'Ipout_y PVD1 1',
        soc: null,
      },
    });
    expect(recordedVariables(pv)).toEqual(['Pext PVD1 1', 'Ipout_y PVD1 1']);
  });

  it('opens the form on an existing controller with what it holds', () => {
    expect(entryFromDraft(draftFromSpec(DROOP), target()).spec).toEqual(DROOP);
    expect(entryFromDraft(draftFromSpec(FFR), target()).spec).toEqual(FFR);
    const edited = draftFromSpec({ ...DROOP, p_max: 25, ramp: 50 });
    expect([edited.pMax, edited.ramp]).toEqual(['25', '50']);
  });

  it("adds the controllers' variables to the user's own, each once", () => {
    const entries: TdsControllerEntry[] = [
      { spec: DROOP, record: ['Pext ESD1 1', 'Ipout_y ESD1 1'] },
      { spec: FFR, record: ['Pext ESD1 1', 'pIG_y ESD1 1'] },
    ];
    expect(runDaeVars(['omega GENROU 1', 'Pext ESD1 1'], entries, 1000)).toEqual([
      'omega GENROU 1',
      'Pext ESD1 1',
      'Ipout_y ESD1 1',
      'pIG_y ESD1 1',
    ]);
    expect(runDaeVars([], [], 1000)).toEqual([]);
  });

  it("cuts at the most a run records, the user's own picks first", () => {
    const entries: TdsControllerEntry[] = [{ spec: DROOP, record: ['Pext ESD1 1', 'b', 'c'] }];
    expect(runDaeVars(['omega GENROU 1', 'vf GENROU 1'], entries, 3)).toEqual([
      'omega GENROU 1',
      'vf GENROU 1',
      'Pext ESD1 1',
    ]);
  });
});

describe('how a controller is worded', () => {
  it('says what a droop does', () => {
    expect(describeController(DROOP)).toBe(
      "80 MW per Hz of the system frequency beyond ±0.02 Hz, up to the device's own limit",
    );
    expect(describeController({ ...DROOP, deadband: 0, p_max: 25, frequency: 'bus' })).toBe(
      '80 MW per Hz of the frequency at its bus, up to 25 MW',
    );
  });

  it('says what a fast frequency response waits for', () => {
    expect(describeController(FFR)).toBe(
      '30 MW for 10 s, once the frequency at its bus is 0.1 Hz low',
    );
    expect(
      describeController({ ...FFR, frequency: 'coi', trigger_deviation: null, trigger_rocof: 0.5 }),
    ).toBe('30 MW for 10 s, once the system frequency falls 0.5 Hz/s or faster');
    expect(describeController({ ...FFR, power: -30, trigger_rocof: 0.5 })).toBe(
      '-30 MW for 10 s, once the frequency at its bus is 0.1 Hz high or rises 0.5 Hz/s or faster',
    );
  });

  it('says what a controller did in a run', () => {
    expect(describeResult(result({}))).toBe(
      'did not act: the frequency stayed inside its dead band',
    );
    expect(
      describeResult(
        result({ first_action_t: 1.1001, peak_command: 15.898, final_command: 15.4767 }),
      ),
    ).toBe('acted from t = 1.1 s, peaked at 15.9 MW, 15.48 MW at the end');
    expect(describeResult(result({ type: 'ffr' }))).toBe('did not trigger');
    expect(
      describeResult(result({ type: 'ffr', first_action_t: 1.5001, released_t: 3.5001 })),
    ).toBe('triggered at t = 1.5 s, let go at t = 3.5 s');
    expect(describeResult(result({ type: 'ffr', first_action_t: 4 }))).toBe(
      'triggered at t = 4 s, still holding at the end',
    );
  });

  it('sums a run up in a sentence each for a few controllers, a count for many', () => {
    const acted = result({ first_action_t: 1.1, peak_command: 15.9, final_command: 15.5 });
    const idle = result({ type: 'ffr', idx: 2 });
    expect(summariseResults([acted])).toBe(
      'Droop on ESD1 1 acted from t = 1.1 s, peaked at 15.9 MW, 15.5 MW at the end.',
    );
    expect(summariseResults([acted, idle])).toBe(
      'Droop on ESD1 1 acted from t = 1.1 s, peaked at 15.9 MW, 15.5 MW at the end. Fast frequency response on ESD1 2 did not trigger.',
    );
    expect(summariseResults([acted, idle, acted])).toBe('2 of 3 controllers acted.');
  });

  it('writes numbers as a person would type them', () => {
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatNumber(80)).toBe('80');
    expect(formatNumber(1.1)).toBe('1.1');
    expect(formatNumber(Number.NaN)).toBe('');
  });
});
