/**
 * The rules of a continuation power flow's options: what the request body
 * holds, how a custom direction's drafts become its two lists and what they
 * add up to, which devices a direction can name, and how a result is read (the
 * lower branch, a run that used up its steps, the generators held at a limit,
 * the sentences about them).
 */
import { describe, expect, it } from 'vitest';
import {
  CPF_DIRECTIONS,
  cpfRequestBody,
  directionLabel,
  directionRows,
  directionTotals,
  hasLowerBranch,
  heldFromTheStart,
  lambdaMeaning,
  limitsSummary,
  moreSteps,
  noseBeforeTarget,
  noseLimitEvent,
  parseCustomDirection,
  parseIncrease,
  reachedTarget,
  releaseCaution,
  stepLimitReached,
  switchedAlongThePath,
  targetLambda,
  validateCpfAdvanced,
  wouldHaveReleased,
} from '@/lib/cpfOptions';
import type {
  CpfGeneratorTrace,
  CpfLimitEvent,
  CpfResult,
  PflowResult,
  TopologySummary,
} from '@/api/types';

function result(over: Partial<CpfResult> = {}): CpfResult {
  return {
    lambdas: [0, 0.2, 0.4, 0.3],
    voltages_per_bus: { '1': [1, 0.98, 0.9, 0.8] },
    bus_idxes: ['1'],
    nose_idx: 2,
    max_lam: 0.4,
    truncated: false,
    done_msg: 'Nose point at lambda=0.400000',
    mode: 'pv',
    ...over,
  };
}

function event(over: Partial<CpfLimitEvent> = {}): CpfLimitEvent {
  return {
    step: 0,
    lam: 0,
    idx: '2',
    model: 'PV',
    bus: '2',
    limit: 'qmax',
    at_nose: false,
    would_release_step: null,
    ...over,
  };
}

function trace(idx: string, model: 'PV' | 'Slack' = 'PV'): CpfGeneratorTrace {
  return { idx, model, bus: idx, q: [1, 2, 3, 3], q_min: -10, q_max: 10 };
}

describe('cpfRequestBody', () => {
  it('sends the direction alone when nothing else was set', () => {
    expect(cpfRequestBody({ direction: 'load' })).toEqual({ direction: 'load' });
    expect(cpfRequestBody({ direction: 'load-only', enforceQLimits: null })).toEqual({
      direction: 'load-only',
    });
  });

  it('sends the Q-limit switch whichever way it points once it was touched', () => {
    expect(cpfRequestBody({ direction: 'load', enforceQLimits: true })).toEqual({
      direction: 'load',
      enforce_q_limits: true,
    });
    // A case that turns limits on itself can be told to run without.
    expect(cpfRequestBody({ direction: 'load', enforceQLimits: false })).toEqual({
      direction: 'load',
      enforce_q_limits: false,
    });
  });

  it('asks for the full curve, the step and the step count only when given', () => {
    expect(cpfRequestBody({ direction: 'gen', stopAt: 'full', step: 0.05, maxIter: 800 })).toEqual({
      direction: 'gen',
      stop_at: 'full',
      step: 0.05,
      max_iter: 800,
    });
    expect(cpfRequestBody({ direction: 'gen', stopAt: 'nose' })).toEqual({ direction: 'gen' });
  });

  it('sends the new solver settings only when given', () => {
    expect(cpfRequestBody({ direction: 'load', parameterization: 'natural' })).toEqual({
      direction: 'load',
      parameterization: 'natural',
    });
    expect(cpfRequestBody({ direction: 'load', tol: 0.0001 })).toEqual({
      direction: 'load',
      tol: 0.0001,
    });
    expect(cpfRequestBody({ direction: 'load', correctorMaxIter: 10 })).toEqual({
      direction: 'load',
      corrector_max_iter: 10,
    });
    expect(cpfRequestBody({ direction: 'load', stepMin: 0.001, stepMax: 0.1 })).toEqual({
      direction: 'load',
      step_min: 0.001,
      step_max: 0.1,
    });
  });

  it('writes no key at all for a setting left out', () => {
    // toEqual passes over a key whose value is undefined; the body must not have one.
    expect(Object.keys(cpfRequestBody({ direction: 'load' }))).toEqual(['direction']);
  });

  it('sends a target lambda as a number on the stop_at wire field', () => {
    expect(cpfRequestBody({ direction: 'load', stopAtLambda: 2.5 })).toEqual({
      direction: 'load',
      stop_at: 2.5,
    });
    // The two never both go out; the full curve alone is unchanged.
    expect(cpfRequestBody({ direction: 'load', stopAt: 'full' })).toEqual({
      direction: 'load',
      stop_at: 'full',
    });
  });

  it('carries the lists of a custom direction, and of no other', () => {
    const loadIncrease = [{ idx: 'PQ_1', p: 10, q: 3 }];
    const generatorIncrease = [{ idx: '2', p: 10 }];
    expect(cpfRequestBody({ direction: 'custom', loadIncrease, generatorIncrease })).toEqual({
      direction: 'custom',
      load_increase: loadIncrease,
      generator_increase: generatorIncrease,
    });
    // The server refuses the lists with any other direction.
    expect(cpfRequestBody({ direction: 'load', loadIncrease, generatorIncrease })).toEqual({
      direction: 'load',
    });
    // An empty list is left out: the server reads it as "given".
    expect(cpfRequestBody({ direction: 'custom', loadIncrease, generatorIncrease: [] })).toEqual({
      direction: 'custom',
      load_increase: loadIncrease,
    });
  });
});

describe('validateCpfAdvanced', () => {
  it('accepts all-blank fields with the nose stop', () => {
    expect(validateCpfAdvanced('', 'nose', '', '', '', '', '')).toEqual({});
  });

  it('refuses the natural parameterization with the full curve', () => {
    const errors = validateCpfAdvanced('natural', 'full', '', '', '', '', '');
    expect(errors.parameterization).toMatch(/cannot trace the full curve/);
    expect(validateCpfAdvanced('natural', 'nose', '', '', '', '', '')).toEqual({});
    expect(validateCpfAdvanced('arclength', 'full', '', '', '', '', '')).toEqual({});
  });

  it('refuses a target stop without a positive lambda', () => {
    for (const text of ['', '0', 'abc', '-1']) {
      expect(validateCpfAdvanced('', 'target', text, '', '', '', '')).toEqual({
        stopAtLambda: 'Target λ must be a positive number.',
      });
    }
    expect(validateCpfAdvanced('', 'target', '2.5', '', '', '', '')).toEqual({});
    // The lambda is only read while the target stop is chosen.
    expect(validateCpfAdvanced('', 'nose', 'abc', '', '', '', '')).toEqual({});
  });

  it('holds the tolerance to a positive number of at most 1e-4', () => {
    expect(validateCpfAdvanced('', 'nose', '', '0.001', '', '', '')).toEqual({
      tol: 'Tolerance must be at most 1e-4.',
    });
    expect(validateCpfAdvanced('', 'nose', '', '0.0001', '', '', '')).toEqual({});
    expect(validateCpfAdvanced('', 'nose', '', '-1', '', '', '')).toEqual({
      tol: 'Tolerance must be a positive number.',
    });
    expect(validateCpfAdvanced('', 'nose', '', 'abc', '', '', '')).toEqual({
      tol: 'Tolerance must be a positive number.',
    });
  });

  it('holds the corrector iterations to an integer of at least 2', () => {
    expect(validateCpfAdvanced('', 'nose', '', '', '1', '', '')).toEqual({
      correctorMaxIter: 'Corrector iterations must be an integer of at least 2.',
    });
    expect(validateCpfAdvanced('', 'nose', '', '', '2.5', '', '')).toEqual({
      correctorMaxIter: 'Corrector iterations must be an integer of at least 2.',
    });
    expect(validateCpfAdvanced('', 'nose', '', '', '2', '', '')).toEqual({});
  });

  it('holds the step bounds to positive numbers, the minimum not above the maximum', () => {
    expect(validateCpfAdvanced('', 'nose', '', '', '', '0.1', '0.01')).toEqual({
      stepMin: 'Minimum step must not be above maximum step.',
    });
    expect(validateCpfAdvanced('', 'nose', '', '', '', '0.01', '0.1')).toEqual({});
    expect(validateCpfAdvanced('', 'nose', '', '', '', '-1', '')).toEqual({
      stepMin: 'Minimum step must be a positive number.',
    });
    expect(validateCpfAdvanced('', 'nose', '', '', '', '', '0')).toEqual({
      stepMax: 'Maximum step must be a positive number.',
    });
  });
});

describe('a custom direction', () => {
  it('reads a blank field as zero and refuses text that is no number', () => {
    expect(parseIncrease('')).toBe(0);
    expect(parseIncrease('  ')).toBe(0);
    expect(parseIncrease(undefined)).toBe(0);
    expect(parseIncrease('12.5')).toBe(12.5);
    expect(parseIncrease('-3')).toBe(-3);
    expect(parseIncrease('1e2')).toBe(100);
    expect(parseIncrease('abc')).toBeNull();
    expect(parseIncrease('Infinity')).toBeNull();
  });

  it('turns the drafts into the two lists, leaving out what does not move', () => {
    const parsed = parseCustomDirection(
      {
        loads: { PQ_1: { p: '10', q: '' }, PQ_2: { p: '', q: '' }, PQ_3: { p: '0', q: '4' } },
        generators: { '2': { p: '10', q: '' }, '3': { p: '', q: '' } },
      },
      ['PQ_1', 'PQ_2', 'PQ_3'],
      ['2', '3'],
    );
    expect(parsed).toEqual({
      ok: true,
      loadIncrease: [
        { idx: 'PQ_1', p: 10, q: 0 },
        { idx: 'PQ_3', p: 0, q: 4 },
      ],
      generatorIncrease: [{ idx: '2', p: 10 }],
    });
  });

  it('drops a draft left from another case', () => {
    const parsed = parseCustomDirection(
      { loads: { PQ_9: { p: '10', q: '' }, PQ_1: { p: '5', q: '' } }, generators: {} },
      ['PQ_1'],
      [],
    );
    expect(parsed).toEqual({
      ok: true,
      loadIncrease: [{ idx: 'PQ_1', p: 5, q: 0 }],
      generatorIncrease: [],
    });
  });

  it('is refused when a field is not a number, naming the device', () => {
    expect(
      parseCustomDirection({ loads: { PQ_1: { p: 'ten', q: '' } }, generators: {} }, ['PQ_1'], []),
    ).toEqual({ ok: false, error: 'The increase of load PQ_1 is not a number.' });
    expect(
      parseCustomDirection({ loads: {}, generators: { '2': { p: '1,5', q: '' } } }, [], ['2']),
    ).toEqual({ ok: false, error: 'The increase of generator 2 is not a number.' });
  });

  it('is refused when nothing moves', () => {
    const parsed = parseCustomDirection(
      { loads: { PQ_1: { p: '0', q: '' } }, generators: {} },
      ['PQ_1'],
      ['2'],
    );
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(/at least one load or generator/);
  });
});

describe('directionTotals', () => {
  const loads = [
    { idx: 'PQ_1', name: 'PQ_1', bus: '2', p: 21.7, q: 12.7 },
    { idx: 'PQ_2', name: 'PQ_2', bus: '3', p: 50, q: 25 },
  ];
  const generators = [{ idx: '2', name: '2', bus: '2', p: 40 }];

  it('adds up what is typed beside what the case has', () => {
    const totals = directionTotals(
      {
        loads: { PQ_1: { p: '10', q: '5' }, PQ_2: { p: '-2.5', q: '' } },
        generators: { '2': { p: '5', q: '' } },
      },
      loads,
      generators,
    );
    expect(totals).toEqual({
      loadP: 7.5,
      loadQ: 5,
      generatorP: 5,
      baseLoadP: 71.7,
      baseLoadQ: 37.7,
      baseGeneratorP: 40,
      moved: 3,
    });
  });

  it('counts a field that is no number as zero, and a draft of another case not at all', () => {
    const totals = directionTotals(
      {
        loads: { PQ_1: { p: 'abc', q: '' }, PQ_99: { p: '100', q: '' } },
        generators: {},
      },
      loads,
      generators,
    );
    expect(totals.loadP).toBe(0);
    expect(totals.moved).toBe(0);
  });

  it('has no base totals without a solved power flow', () => {
    const totals = directionTotals(
      { loads: { PQ_1: { p: '1', q: '' } }, generators: {} },
      [{ idx: 'PQ_1', name: 'PQ_1', bus: '2', p: null, q: null }],
      [],
    );
    expect(totals.baseLoadP).toBeNull();
    expect(totals.baseLoadQ).toBeNull();
    expect(totals.baseGeneratorP).toBeNull();
    expect(totals.moved).toBe(1);
  });
});

describe('directionRows', () => {
  const topology = {
    loads: [
      { idx: 'PQ_1', name: 'Load A', kind: 'PQ', params: { bus: 4 } },
      { idx: 'ZIP_1', name: 'Zip', kind: 'ZIP', params: { bus: 5 } },
    ],
    generators: [
      { idx: 2, name: 'G2', kind: 'PV', params: { bus: 2 } },
      { idx: 1, name: 'G1', kind: 'Slack', params: { bus: 1 } },
      { idx: 1, name: 'M1', kind: 'GENROU', params: { bus: 1 } },
    ],
  } as unknown as TopologySummary;
  const pflow = {
    converged: true,
    load_consumption: { PQ_1: { p: 21.7, q: 12.7, bus: 4 } },
    generator_outputs: { '2': { p: 40, q: 30, v: 1, bus: 2 } },
  } as unknown as PflowResult;

  it('lists the PQ loads and the PV generators, with their solved power', () => {
    expect(directionRows(topology, pflow)).toEqual({
      loads: [{ idx: 'PQ_1', name: 'Load A', bus: '4', p: 21.7, q: 12.7 }],
      // Not the slack, which supplies what the rest leaves, nor a machine.
      generators: [{ idx: '2', name: 'G2', bus: '2', p: 40 }],
    });
  });

  it('leaves the power out without a converged power flow', () => {
    const rows = directionRows(topology, { ...pflow, converged: false } as PflowResult);
    expect(rows.loads[0]).toMatchObject({ p: null, q: null });
    expect(rows.generators[0]).toMatchObject({ p: null });
    expect(directionRows(topology, null).loads[0]).toMatchObject({ p: null });
  });

  it('is empty without a case, or for one that lists neither', () => {
    expect(directionRows(null, pflow)).toEqual({ loads: [], generators: [] });
    expect(directionRows({} as TopologySummary, pflow)).toEqual({ loads: [], generators: [] });
  });
});

describe('names of a direction', () => {
  it('has a label and a meaning of lambda for each of the four', () => {
    expect(CPF_DIRECTIONS.map((option) => option.value)).toEqual([
      'load',
      'load-only',
      'gen',
      'custom',
    ]);
    expect(directionLabel('load-only')).toBe('Loads only');
    expect(directionLabel(undefined)).toBe('Loads and generation');
    expect(lambdaMeaning('load')).toMatch(/twice the base load and PV generation/);
    expect(lambdaMeaning('load-only')).toMatch(/twice the base load$/);
    expect(lambdaMeaning('gen')).toMatch(/PV generation/);
    expect(lambdaMeaning('custom')).toMatch(/custom increase/);
  });
});

describe('reading a result', () => {
  it('has a lower branch only when the full curve was asked for and goes past the nose', () => {
    expect(hasLowerBranch(result())).toBe(false);
    expect(hasLowerBranch(result({ stop_at: 'nose' }))).toBe(false);
    expect(hasLowerBranch(result({ stop_at: 'full' }))).toBe(true);
    expect(hasLowerBranch(result({ stop_at: 'full', nose_idx: 3 }))).toBe(false);
    expect(hasLowerBranch(result({ stop_at: 'full', nose_idx: -1, truncated: true }))).toBe(false);
  });

  it('names the step limit of a run that used it up, with or without a nose', () => {
    // No nose: the routine ran out of steps on the way up.
    const cut = result({ nose_idx: -1, truncated: true, done_msg: 'Reached max steps (500)' });
    expect(stepLimitReached(cut)).toBe(500);
    // A nose, and a lower branch that ran out of them.
    const brokenOff = result({
      stop_at: 'full',
      complete: false,
      done_msg: 'Reached max steps (1000)',
    });
    expect(stepLimitReached(brokenOff)).toBe(1000);
    expect(moreSteps(500)).toBe(2000);
  });

  it('names no step limit for a run that ended another way', () => {
    expect(stepLimitReached(result())).toBeNull();
    expect(
      stepLimitReached(result({ truncated: true, done_msg: 'Corrector failed at lambda=0.3' })),
    ).toBeNull();
    // The message alone is not enough: the run has to have stopped short.
    expect(stepLimitReached(result({ done_msg: 'Reached max steps (500)' }))).toBeNull();
    // A QV curve has no step limit to raise.
    expect(
      stepLimitReached(
        result({ mode: 'qv', truncated: true, done_msg: 'Reached max steps (500)' }),
      ),
    ).toBeNull();
  });

  it('splits the events into held from the start and switched along the path', () => {
    const events = [event(), event({ idx: '3', step: 2, lam: 0.4, at_nose: true })];
    const r = result({ limit_events: events });
    expect(heldFromTheStart(r)).toEqual([events[0]]);
    expect(switchedAlongThePath(r)).toEqual([events[1]]);
    expect(noseLimitEvent(r)).toBe(events[1]);
    expect(noseLimitEvent(result({ limit_events: [events[0]!] }))).toBeNull();
    expect(noseLimitEvent(result())).toBeNull();
  });

  it('says nothing about limits for a result that does not report them', () => {
    expect(limitsSummary(result())).toBeNull();
  });

  it('says whether limits were enforced and how many generators they held', () => {
    expect(limitsSummary(result({ q_limits_enforced: true, limit_events: [] }))).toBe(
      'Q limits were enforced and no generator reached one.',
    );
    expect(
      limitsSummary(
        result({
          q_limits_enforced: true,
          limit_events: [event(), event({ idx: '3' }), event({ idx: '4', step: 2 })],
        }),
      ),
    ).toBe(
      'Q limits were enforced: 2 generators held at a limit from the start, 1 more reached one along the path.',
    );
    expect(limitsSummary(result({ q_limits_enforced: false, limit_events: [] }))).toBe(
      'Q limits were not enforced: generators are free to go past them.',
    );
  });

  it('says that only the power flow’s generators are held when limits were not enforced', () => {
    const summary = limitsSummary(result({ q_limits_enforced: false, limit_events: [event()] }));
    expect(summary).toMatch(/not enforced along the path/);
    expect(summary).toMatch(/holds 1 generator at a limit, and it stays held/);
    expect(summary).toMatch(/the others are free to go past theirs/);
  });

  it('says so when every generator is held from the start', () => {
    const all = result({
      q_limits_enforced: true,
      generators: [trace('2'), trace('3')],
      limit_events: [event(), event({ idx: '3' })],
    });
    expect(limitsSummary(all)).toMatch(/None is left to hold a voltage along the curve\.$/);
    const one = result({
      q_limits_enforced: true,
      generators: [trace('2'), trace('3')],
      limit_events: [event()],
    });
    expect(limitsSummary(one)).not.toMatch(/None is left/);
  });

  it('cautions about generators that would have left their limit', () => {
    expect(releaseCaution(result({ limit_events: [event()] }))).toBeNull();
    const pinned = result({
      limit_events: [event({ limit: 'qmin', would_release_step: 1 }), event({ idx: '3' })],
    });
    expect(wouldHaveReleased(pinned).map((e) => e.idx)).toEqual(['2']);
    expect(releaseCaution(pinned)).toMatch(/^1 held generator has its voltage back across/);
    expect(releaseCaution(pinned)).toMatch(/pinned at its limit/);
    const two = result({
      limit_events: [event({ would_release_step: 1 }), event({ idx: '3', would_release_step: 2 })],
    });
    expect(releaseCaution(two)).toMatch(/^2 held generators have their voltage/);
    // A step of 0 is a step: the generator is past its set-point from the start.
    expect(
      wouldHaveReleased(result({ limit_events: [event({ would_release_step: 0 })] })),
    ).toHaveLength(1);
  });
});

describe('a run to a target lambda', () => {
  it('reads the target, and tells a run that reached it from one whose nose came first', () => {
    // No target: none of it applies, whatever the run found.
    expect(targetLambda(result())).toBeNull();
    expect(targetLambda(result({ stop_at_lambda: null }))).toBeNull();
    expect(reachedTarget(result({ truncated: true, nose_idx: -1, complete: true }))).toBe(false);
    expect(noseBeforeTarget(result({ complete: false }))).toBe(false);

    // Landed on the target below the nose: no nose, so truncated, and complete.
    const reached = result({
      lambdas: [0, 0.2, 0.3],
      nose_idx: -1,
      truncated: true,
      complete: true,
      stop_at: 'nose',
      stop_at_lambda: 0.3,
    });
    expect(targetLambda(reached)).toBe(0.3);
    expect(reachedTarget(reached)).toBe(true);
    expect(noseBeforeTarget(reached)).toBe(false);
    expect(stepLimitReached(reached)).toBeNull();

    // The nose came first: the nose found, not complete.
    const short = result({ complete: false, stop_at: 'nose', stop_at_lambda: 3 });
    expect(reachedTarget(short)).toBe(false);
    expect(noseBeforeTarget(short)).toBe(true);
    expect(hasLowerBranch(short)).toBe(false);

    // Out of steps before either: neither.
    const cut = result({
      nose_idx: -1,
      truncated: true,
      complete: false,
      done_msg: 'Reached max steps (3)',
      stop_at_lambda: 3,
    });
    expect(reachedTarget(cut)).toBe(false);
    expect(noseBeforeTarget(cut)).toBe(false);
    expect(stepLimitReached(cut)).toBe(3);
  });
});
