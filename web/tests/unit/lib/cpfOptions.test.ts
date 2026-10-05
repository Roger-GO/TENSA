/**
 * The rules of a continuation power flow's options: what the request body
 * holds, how a custom direction's drafts become its two lists, which devices
 * a direction can name, and how a result is read (the lower branch, the
 * generators held at a limit, the sentences about them).
 */
import { describe, expect, it } from 'vitest';
import {
  CPF_DIRECTIONS,
  cpfRequestBody,
  directionLabel,
  directionRows,
  hasLowerBranch,
  heldFromTheStart,
  lambdaMeaning,
  limitsSummary,
  noseLimitEvent,
  parseCustomDirection,
  parseIncrease,
  releaseCaution,
  switchedAlongThePath,
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
