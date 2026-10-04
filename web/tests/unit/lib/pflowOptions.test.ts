/**
 * Tests for the power-flow option rules: the request body, the two number
 * parsers, the words about a run's settings, and the adjusted retries a run that
 * did not converge offers.
 */
import { describe, expect, it } from 'vitest';
import {
  ANDES_PFLOW_DEFAULTS,
  DEFAULT_PFLOW_OPTIONS,
  describeSettings,
  formatTolerance,
  isDefaultPflowOptions,
  nonDefaultSettings,
  parseMaxIterations,
  parseTolerance,
  pflowRequestBody,
  pflowRetries,
  pflowSuccessMessage,
  settingsOrAssumed,
} from '@/lib/pflowOptions';
import type { PflowSettings } from '@/api/types';

const PLAIN: PflowSettings = {
  tolerance: 1e-6,
  max_iterations: 25,
  flat_start: false,
  enforce_q_limits: false,
};

describe('pflowRequestBody', () => {
  it('is empty for the defaults, so the case keeps its own settings', () => {
    expect(pflowRequestBody(DEFAULT_PFLOW_OPTIONS)).toEqual({});
  });

  it('carries only what was changed', () => {
    expect(pflowRequestBody({ ...DEFAULT_PFLOW_OPTIONS, maxIterations: 50 })).toEqual({
      max_iterations: 50,
    });
    expect(
      pflowRequestBody({
        tolerance: 1e-8,
        maxIterations: 100,
        flatStart: true,
        enforceQLimits: true,
      }),
    ).toEqual({
      tolerance: 1e-8,
      max_iterations: 100,
      flat_start: true,
      enforce_q_limits: true,
    });
  });

  it('sends a checkbox only when it is ticked', () => {
    const body = pflowRequestBody({ ...DEFAULT_PFLOW_OPTIONS, flatStart: false });
    expect('flat_start' in body).toBe(false);
    expect('enforce_q_limits' in body).toBe(false);
  });
});

describe('isDefaultPflowOptions', () => {
  it('is true only when nothing is set', () => {
    expect(isDefaultPflowOptions(DEFAULT_PFLOW_OPTIONS)).toBe(true);
    expect(isDefaultPflowOptions({ ...DEFAULT_PFLOW_OPTIONS, tolerance: 1e-6 })).toBe(false);
    expect(isDefaultPflowOptions({ ...DEFAULT_PFLOW_OPTIONS, flatStart: true })).toBe(false);
    expect(isDefaultPflowOptions({ ...DEFAULT_PFLOW_OPTIONS, enforceQLimits: true })).toBe(false);
  });
});

describe('parseTolerance', () => {
  it('reads plain and exponent notation', () => {
    expect(parseTolerance('1e-8')).toEqual({ ok: true, value: 1e-8 });
    expect(parseTolerance(' 0.0001 ')).toEqual({ ok: true, value: 1e-4 });
    expect(parseTolerance('1E-3')).toEqual({ ok: true, value: 1e-3 });
  });

  it('treats blank as the case’s own value', () => {
    expect(parseTolerance('')).toEqual({ ok: true, value: null });
    expect(parseTolerance('   ')).toEqual({ ok: true, value: null });
  });

  it('accepts the ends of the server’s range', () => {
    expect(parseTolerance('1e-12')).toEqual({ ok: true, value: 1e-12 });
    expect(parseTolerance('0.01')).toEqual({ ok: true, value: 0.01 });
  });

  it.each(['0', '-1e-6', '1e-13', '0.5', 'abc', '1e-6x', 'NaN', 'Infinity'])(
    'refuses %s and names the range',
    (text) => {
      const parsed = parseTolerance(text);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(/1e-12 to 1e-2/);
    },
  );
});

describe('parseMaxIterations', () => {
  it('reads a whole number and treats blank as the case’s own', () => {
    expect(parseMaxIterations('50')).toEqual({ ok: true, value: 50 });
    expect(parseMaxIterations(' 1 ')).toEqual({ ok: true, value: 1 });
    expect(parseMaxIterations('1000')).toEqual({ ok: true, value: 1000 });
    expect(parseMaxIterations('')).toEqual({ ok: true, value: null });
  });

  it.each(['0', '1001', '-5', '2.5', '1e2', 'abc', '+5'])(
    'refuses %s and names the range',
    (text) => {
      const parsed = parseMaxIterations(text);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(/1 to 1000/);
    },
  );
});

describe('formatTolerance', () => {
  it('writes a tolerance the way a person does', () => {
    expect(formatTolerance(1e-6)).toBe('1e-6');
    expect(formatTolerance(2.5e-4)).toBe('2.5e-4');
    expect(formatTolerance(0.01)).toBe('1e-2');
    expect(formatTolerance(1e-12)).toBe('1e-12');
  });
});

describe('describeSettings', () => {
  it('always gives the tolerance and the limit', () => {
    expect(describeSettings(PLAIN)).toBe('tolerance 1e-6, up to 25 iterations');
  });

  it('names flat start and enforced Q limits when they were on', () => {
    expect(
      describeSettings({ ...PLAIN, flat_start: true, enforce_q_limits: true, max_iterations: 50 }),
    ).toBe('tolerance 1e-6, up to 50 iterations, flat start, Q limits enforced');
  });
});

describe('nonDefaultSettings and pflowSuccessMessage', () => {
  it('say nothing for a plain run, or from a server that gave no settings', () => {
    expect(nonDefaultSettings(PLAIN)).toEqual([]);
    expect(nonDefaultSettings(null)).toEqual([]);
    expect(nonDefaultSettings(undefined)).toEqual([]);
    expect(pflowSuccessMessage({ iterations: 3, settings: PLAIN })).toBe(
      'PF converged in 3 iterations.',
    );
    expect(pflowSuccessMessage({ iterations: 4 })).toBe('PF converged in 4 iterations.');
  });

  it('name what was not default, so a different result is never a mystery', () => {
    expect(
      pflowSuccessMessage({
        iterations: 5,
        settings: { ...PLAIN, enforce_q_limits: true },
      }),
    ).toBe('PF converged in 5 iterations (Q limits enforced).');
    expect(
      pflowSuccessMessage({
        iterations: 9,
        settings: {
          tolerance: 1e-4,
          max_iterations: 50,
          flat_start: true,
          enforce_q_limits: false,
        },
      }),
    ).toBe('PF converged in 9 iterations (flat start, tolerance 1e-4, up to 50 iterations).');
  });
});

describe('settingsOrAssumed', () => {
  it('takes what the server reported', () => {
    expect(settingsOrAssumed(PLAIN, { ...DEFAULT_PFLOW_OPTIONS, flatStart: true })).toBe(PLAIN);
  });

  it('falls back to the options form over ANDES’s defaults', () => {
    expect(settingsOrAssumed(null, DEFAULT_PFLOW_OPTIONS)).toEqual({
      tolerance: ANDES_PFLOW_DEFAULTS.tolerance,
      max_iterations: ANDES_PFLOW_DEFAULTS.maxIterations,
      flat_start: false,
      enforce_q_limits: false,
    });
    expect(
      settingsOrAssumed(undefined, {
        tolerance: 1e-3,
        maxIterations: 10,
        flatStart: true,
        enforceQLimits: true,
      }),
    ).toEqual({ tolerance: 1e-3, max_iterations: 10, flat_start: true, enforce_q_limits: true });
  });
});

describe('pflowRetries', () => {
  const ids = (run: Parameters<typeof pflowRetries>[0]) => pflowRetries(run).map((r) => r.id);

  it('offers more iterations when the solver stopped at its limit', () => {
    // ANDES stops once the count passes the limit, so 26 iterations is a run that hit 25.
    const retries = pflowRetries({ iterations: 26, mismatch: 0.3, settings: PLAIN });
    const more = retries.find((r) => r.id === 'more-iterations');
    expect(more?.changes).toEqual({ maxIterations: 50 });
    expect(more?.label).toBe('Retry with 50 iterations');
  });

  it('doubles a limit that is already high, up to the ceiling', () => {
    const at = (max: number) =>
      pflowRetries({
        iterations: max + 1,
        mismatch: 0.3,
        settings: { ...PLAIN, max_iterations: max },
      }).find((r) => r.id === 'more-iterations')?.changes;
    expect(at(40)).toEqual({ maxIterations: 80 });
    expect(at(700)).toEqual({ maxIterations: 1000 });
    expect(at(1000)).toBeUndefined();
  });

  it('does not offer more iterations to a run that gave up early', () => {
    // 6 iterations of a 25 limit: it diverged or hit NaN, more would not help.
    expect(ids({ iterations: 6, mismatch: 80, settings: PLAIN })).not.toContain('more-iterations');
  });

  it('offers a flat start unless the run used one', () => {
    expect(ids({ iterations: 26, mismatch: 0.3, settings: PLAIN })).toContain('flat-start');
    expect(
      ids({ iterations: 26, mismatch: 0.3, settings: { ...PLAIN, flat_start: true } }),
    ).not.toContain('flat-start');
    expect(pflowRetries({ iterations: 26, mismatch: 0.3, settings: PLAIN })[1]?.changes).toEqual({
      flatStart: true,
    });
  });

  it('offers the next power of ten when the mismatch is close to the tolerance', () => {
    const loose = pflowRetries({ iterations: 26, mismatch: 3.2e-6, settings: PLAIN }).find(
      (r) => r.id === 'looser-tolerance',
    );
    expect(loose?.changes).toEqual({ tolerance: 1e-5 });
    expect(loose?.label).toBe('Retry at tolerance 1e-5');
    // Strictly above the mismatch: ANDES accepts only a mismatch below the tolerance.
    const exact = pflowRetries({ iterations: 26, mismatch: 1e-5, settings: PLAIN }).find(
      (r) => r.id === 'looser-tolerance',
    );
    expect(exact?.changes.tolerance).toBeGreaterThan(1e-5);
  });

  it('does not suggest accepting a mismatch that is nowhere near converged', () => {
    expect(ids({ iterations: 26, mismatch: 0.02, settings: PLAIN })).not.toContain(
      'looser-tolerance',
    );
    expect(ids({ iterations: 26, mismatch: Number.NaN, settings: PLAIN })).not.toContain(
      'looser-tolerance',
    );
    expect(
      ids({ iterations: 26, mismatch: Number.POSITIVE_INFINITY, settings: PLAIN }),
    ).not.toContain('looser-tolerance');
    // Below the tolerance already: nothing to loosen.
    expect(ids({ iterations: 26, mismatch: 1e-7, settings: PLAIN })).not.toContain(
      'looser-tolerance',
    );
  });

  it('offers to turn Q limits off when they were enforced', () => {
    const retries = pflowRetries({
      iterations: 26,
      mismatch: 0.3,
      settings: { ...PLAIN, enforce_q_limits: true },
    });
    expect(retries.find((r) => r.id === 'no-q-limits')?.changes).toEqual({
      enforceQLimits: false,
    });
    expect(ids({ iterations: 26, mismatch: 0.3, settings: PLAIN })).not.toContain('no-q-limits');
  });

  it('every retry has a hint for its tooltip', () => {
    const all = pflowRetries({
      iterations: 26,
      mismatch: 3e-6,
      settings: { ...PLAIN, enforce_q_limits: true },
    });
    expect(all.map((r) => r.id)).toEqual([
      'more-iterations',
      'flat-start',
      'looser-tolerance',
      'no-q-limits',
    ]);
    for (const retry of all) expect(retry.hint.length).toBeGreaterThan(20);
  });
});
