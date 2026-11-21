/**
 * Tests for the power-flow option rules: the request body, the two number
 * parsers, the words about a run's settings, and the adjusted retries a run that
 * did not converge offers.
 */
import { describe, expect, it } from 'vitest';
import {
  ANDES_PFLOW_DEFAULTS,
  DEFAULT_PFLOW_OPTIONS,
  caseSettingsFromRun,
  describeSettings,
  formatTolerance,
  isDefaultPflowOptions,
  iterationsPhrase,
  nkIgnores,
  nonDefaultSettings,
  parseMaxIterations,
  parseNFactorize,
  parseTolerance,
  pflowRequestBody,
  pflowRetries,
  pflowSuccessMessage,
  settingsOrAssumed,
  shownSwitch,
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
    const body = pflowRequestBody(DEFAULT_PFLOW_OPTIONS);
    expect(body).toEqual({});
    expect('method' in body).toBe(false);
    expect('n_factorize' in body).toBe(false);
    expect('linesearch' in body).toBe(false);
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
        method: 'dishonest',
        nFactorize: 10,
        linesearch: false,
      }),
    ).toEqual({
      tolerance: 1e-8,
      max_iterations: 100,
      flat_start: true,
      enforce_q_limits: true,
      method: 'dishonest',
      n_factorize: 10,
      linesearch: false,
    });
  });

  it('sends a chosen solver, and an explicit line-search off, like the other switches', () => {
    expect(pflowRequestBody({ ...DEFAULT_PFLOW_OPTIONS, method: 'NK' })).toEqual({
      method: 'NK',
    });
    expect(pflowRequestBody({ ...DEFAULT_PFLOW_OPTIONS, linesearch: false })).toEqual({
      linesearch: false,
    });
  });

  it('sends a checkbox only once it has been touched, and then whichever way it points', () => {
    const untouched = pflowRequestBody(DEFAULT_PFLOW_OPTIONS);
    expect('flat_start' in untouched).toBe(false);
    expect('enforce_q_limits' in untouched).toBe(false);

    // Unticked after being ticked is "off", not "leave it to the case": a case
    // whose own settings turn Q limits on is otherwise one the form cannot turn off.
    expect(
      pflowRequestBody({ ...DEFAULT_PFLOW_OPTIONS, flatStart: false, enforceQLimits: false }),
    ).toEqual({ flat_start: false, enforce_q_limits: false });
  });
});

describe('isDefaultPflowOptions', () => {
  it('is true only when nothing is set', () => {
    expect(isDefaultPflowOptions(DEFAULT_PFLOW_OPTIONS)).toBe(true);
    expect(isDefaultPflowOptions({ ...DEFAULT_PFLOW_OPTIONS, tolerance: 1e-6 })).toBe(false);
    expect(isDefaultPflowOptions({ ...DEFAULT_PFLOW_OPTIONS, flatStart: true })).toBe(false);
    expect(isDefaultPflowOptions({ ...DEFAULT_PFLOW_OPTIONS, enforceQLimits: true })).toBe(false);
    // An explicit "off" is a choice, not the case's own.
    expect(isDefaultPflowOptions({ ...DEFAULT_PFLOW_OPTIONS, enforceQLimits: false })).toBe(false);
    expect(isDefaultPflowOptions({ ...DEFAULT_PFLOW_OPTIONS, method: 'NR' })).toBe(false);
    expect(isDefaultPflowOptions({ ...DEFAULT_PFLOW_OPTIONS, nFactorize: 4 })).toBe(false);
    expect(isDefaultPflowOptions({ ...DEFAULT_PFLOW_OPTIONS, linesearch: false })).toBe(false);
    expect(isDefaultPflowOptions({ ...DEFAULT_PFLOW_OPTIONS, method: 'NK' })).toBe(false);
    expect(isDefaultPflowOptions({ ...DEFAULT_PFLOW_OPTIONS, linesearch: true })).toBe(false);
  });
});

describe('caseSettingsFromRun', () => {
  const ON: PflowSettings = { ...PLAIN, flat_start: true, enforce_q_limits: true };

  it('reads the case’s own switches off a run whose request left them alone', () => {
    expect(caseSettingsFromRun({}, ON)).toEqual({ flatStart: true, enforceQLimits: true });
    expect(caseSettingsFromRun({}, PLAIN)).toEqual({ flatStart: false, enforceQLimits: false });
  });

  it('learns nothing about a switch the request set, whichever way', () => {
    expect(caseSettingsFromRun({ enforce_q_limits: false }, ON)).toEqual({ flatStart: true });
    expect(caseSettingsFromRun({ flat_start: true, enforce_q_limits: true }, ON)).toEqual({});
  });

  it('learns nothing from a server that reports no settings', () => {
    expect(caseSettingsFromRun({}, null)).toEqual({});
    expect(caseSettingsFromRun({}, undefined)).toEqual({});
  });
});

describe('shownSwitch', () => {
  it('shows the choice, else the case’s own, else off', () => {
    expect(shownSwitch(true, false)).toBe(true);
    expect(shownSwitch(false, true)).toBe(false);
    expect(shownSwitch(null, true)).toBe(true);
    expect(shownSwitch(null, false)).toBe(false);
    expect(shownSwitch(null, null)).toBe(false);
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

describe('parseNFactorize', () => {
  it('reads a whole number and treats blank as the case’s own', () => {
    expect(parseNFactorize('10')).toEqual({ ok: true, value: 10 });
    expect(parseNFactorize(' 1 ')).toEqual({ ok: true, value: 1 });
    expect(parseNFactorize('100')).toEqual({ ok: true, value: 100 });
    expect(parseNFactorize('')).toEqual({ ok: true, value: null });
  });

  it.each(['0', '101', '-5', '2.5', '1e2', 'abc', '+5'])(
    'refuses %s and names the range',
    (text) => {
      const parsed = parseNFactorize(text);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(/1 to 100/);
    },
  );
});

describe('nkIgnores', () => {
  it('is true only for Newton-Krylov', () => {
    expect(nkIgnores('NK')).toBe(true);
    expect(nkIgnores('NR')).toBe(false);
    expect(nkIgnores('dishonest')).toBe(false);
    expect(nkIgnores(null)).toBe(false);
  });
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

  it('names the solver when it was not NR, and the dishonest refactorisation count', () => {
    expect(
      describeSettings({ ...PLAIN, method: 'dishonest', n_factorize: 10, linesearch: true }),
    ).toBe(
      'tolerance 1e-6, up to 25 iterations, dishonest method, refactorizing the first 10 iterations',
    );
    expect(describeSettings({ ...PLAIN, method: 'NR', n_factorize: 4, linesearch: false })).toBe(
      'tolerance 1e-6, up to 25 iterations, line search off',
    );
  });

  it('under Newton-Krylov names only the method and what still applies', () => {
    expect(describeSettings({ ...PLAIN, method: 'NK', n_factorize: 4, linesearch: true })).toBe(
      "Newton-Krylov (SciPy's own stopping rule)",
    );
    expect(
      describeSettings({
        ...PLAIN,
        method: 'NK',
        flat_start: true,
        enforce_q_limits: true,
        linesearch: false,
      }),
    ).toBe("Newton-Krylov (SciPy's own stopping rule), flat start, Q limits enforced");
  });

  it('says nothing of the solver from a server that did not report it', () => {
    expect(describeSettings({ ...PLAIN, method: null, n_factorize: null, linesearch: null })).toBe(
      'tolerance 1e-6, up to 25 iterations',
    );
    expect(
      describeSettings({
        ...PLAIN,
        method: undefined,
        n_factorize: undefined,
        linesearch: undefined,
      }),
    ).toBe('tolerance 1e-6, up to 25 iterations');
    // PLAIN is what an older server sends: the three keys absent.
    expect(describeSettings(PLAIN)).not.toMatch(/undefined|null/);
  });

  it('under Newton-Krylov never names a tolerance or a limit, whatever the server echoed', () => {
    const line = describeSettings({
      tolerance: 1e-4,
      max_iterations: 50,
      flat_start: false,
      enforce_q_limits: false,
      method: 'NK',
      n_factorize: 4,
      linesearch: false,
    });
    expect(line).toBe("Newton-Krylov (SciPy's own stopping rule)");
    expect(line).not.toMatch(/tolerance|iteration|line search/);
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

  it('name the solver when it was not NR, and never a tolerance or limit under Newton-Krylov', () => {
    // Newton-Krylov keeps no count (the server reports 0): the toast names the
    // method instead of "0 iterations".
    expect(
      pflowSuccessMessage({
        iterations: 0,
        settings: { ...PLAIN, method: 'NK', n_factorize: 4, linesearch: true },
      }),
    ).toBe('PF converged by Newton-Krylov.');
    expect(
      pflowSuccessMessage({
        iterations: 5,
        settings: { ...PLAIN, method: 'NR', n_factorize: 4, linesearch: false },
      }),
    ).toBe('PF converged in 5 iterations (line search off).');
    expect(
      pflowSuccessMessage({
        iterations: 0,
        settings: {
          tolerance: 1e-4,
          max_iterations: 50,
          flat_start: true,
          enforce_q_limits: false,
          method: 'NK',
          n_factorize: 4,
          linesearch: false,
        },
      }),
    ).toBe('PF converged by Newton-Krylov (flat start).');
    expect(
      nonDefaultSettings({
        tolerance: 1e-4,
        max_iterations: 50,
        flat_start: false,
        enforce_q_limits: true,
        method: 'NK',
        n_factorize: 10,
        linesearch: false,
      }),
    ).toEqual(['Q limits enforced', 'Newton-Krylov']);
    expect(
      pflowSuccessMessage({
        iterations: 6,
        settings: { ...PLAIN, method: 'dishonest', n_factorize: 10, linesearch: true },
      }),
    ).toBe(
      'PF converged in 6 iterations (dishonest method, refactorizing the first 10 iterations).',
    );
    expect(
      nonDefaultSettings({ ...PLAIN, method: null, n_factorize: null, linesearch: null }),
    ).toEqual([]);
    // An older server leaves the three out altogether.
    expect(
      nonDefaultSettings({
        ...PLAIN,
        method: undefined,
        n_factorize: undefined,
        linesearch: undefined,
      }),
    ).toEqual([]);
    expect(
      nonDefaultSettings({ ...PLAIN, method: 'dishonest', n_factorize: 4, linesearch: true }),
    ).toEqual(['dishonest method']);
  });
});

describe('iterationsPhrase', () => {
  it('gives the count, or names Newton-Krylov, which keeps none', () => {
    expect(iterationsPhrase({ iterations: 5, settings: PLAIN })).toBe('in 5 iterations');
    expect(iterationsPhrase({ iterations: 5 })).toBe('in 5 iterations');
    expect(iterationsPhrase({ iterations: 5, settings: null })).toBe('in 5 iterations');
    expect(iterationsPhrase({ iterations: 0, settings: { ...PLAIN, method: 'NK' } })).toBe(
      'by Newton-Krylov',
    );
    expect(iterationsPhrase({ iterations: 7, settings: { ...PLAIN, method: 'dishonest' } })).toBe(
      'in 7 iterations',
    );
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
      method: 'NR',
      n_factorize: 4,
      linesearch: true,
    });
    expect(
      settingsOrAssumed(undefined, {
        tolerance: 1e-3,
        maxIterations: 10,
        flatStart: true,
        enforceQLimits: true,
        method: 'NK',
        nFactorize: 20,
        linesearch: false,
      }),
    ).toEqual({
      tolerance: 1e-3,
      max_iterations: 10,
      flat_start: true,
      enforce_q_limits: true,
      method: 'NK',
      n_factorize: 20,
      linesearch: false,
    });
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
    const off = retries.find((r) => r.id === 'no-q-limits');
    expect(off?.changes).toEqual({ enforceQLimits: false });
    expect(ids({ iterations: 26, mismatch: 0.3, settings: PLAIN })).not.toContain('no-q-limits');

    // The retry says "off" in the request, so it also beats a case that turns the
    // limits on by itself; an untouched form would send nothing and change nothing.
    expect(pflowRequestBody({ ...DEFAULT_PFLOW_OPTIONS, ...off?.changes })).toEqual({
      enforce_q_limits: false,
    });
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
