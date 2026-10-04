/**
 * Generator reactive-limit rules. The power flow does not hold a generator to
 * its qmin / qmax, so an output can lie past a limit (a violation) or sit on
 * one (a flag), and a generator with no limits has nothing to be judged by.
 */
import { describe, expect, it } from 'vitest';
import {
  Q_LIMIT_TOLERANCE_MVAR,
  assessQLimit,
  qLimitMarker,
  qLimitMarkerLabel,
  qLimitText,
} from '@/components/sld/qLimit';

describe('assessQLimit', () => {
  it('is within the limits between them', () => {
    expect(assessQLimit(5, -10, 15)).toBe('within');
    expect(assessQLimit(-9.5, -10, 15)).toBe('within');
  });

  it('is past a limit beyond the solver tolerance, on it inside the tolerance', () => {
    expect(assessQLimit(15 + 2 * Q_LIMIT_TOLERANCE_MVAR, -10, 15)).toBe('above-max');
    expect(assessQLimit(15 + Q_LIMIT_TOLERANCE_MVAR / 2, -10, 15)).toBe('at-max');
    expect(assessQLimit(15, -10, 15)).toBe('at-max');
    expect(assessQLimit(15 - Q_LIMIT_TOLERANCE_MVAR / 2, -10, 15)).toBe('at-max');
    expect(assessQLimit(-10 - 2 * Q_LIMIT_TOLERANCE_MVAR, -10, 15)).toBe('below-min');
    expect(assessQLimit(-10, -10, 15)).toBe('at-min');
    expect(assessQLimit(-10 + Q_LIMIT_TOLERANCE_MVAR / 2, -10, 15)).toBe('at-min');
  });

  it('checks the one limit it is given', () => {
    expect(assessQLimit(30, null, 15)).toBe('above-max');
    expect(assessQLimit(-30, null, 15)).toBe('within');
    expect(assessQLimit(-30, -10, undefined)).toBe('below-min');
    expect(assessQLimit(30, -10, null)).toBe('within');
  });

  it('has nothing to judge without a reading or without limits', () => {
    expect(assessQLimit(Number.NaN, -10, 15)).toBe('none');
    expect(assessQLimit(null, -10, 15)).toBe('none');
    expect(assessQLimit(5, null, null)).toBe('none');
    expect(assessQLimit(5, Number.NaN, Number.POSITIVE_INFINITY)).toBe('none');
  });

  it('takes the upper limit for a generator whose two limits coincide', () => {
    expect(assessQLimit(10, 10, 10)).toBe('at-max');
    expect(assessQLimit(11, 10, 10)).toBe('above-max');
    expect(assessQLimit(9, 10, 10)).toBe('below-min');
  });
});

describe('qLimitMarker and the words for a state', () => {
  it('draws the same triangle a bus does: up at qmax, down at qmin, filled past it', () => {
    expect(qLimitMarker('above-max')).toEqual({ band: 'danger', side: 'high' });
    expect(qLimitMarker('below-min')).toEqual({ band: 'danger', side: 'low' });
    expect(qLimitMarker('at-max')).toEqual({ band: 'warning', side: 'high' });
    expect(qLimitMarker('at-min')).toEqual({ band: 'warning', side: 'low' });
    expect(qLimitMarker('within')).toEqual({ band: 'success', side: null });
    expect(qLimitMarker('none')).toEqual({ band: 'neutral', side: null });
  });

  it('names each state for a table cell and for the marker', () => {
    expect(qLimitText('above-max')).toBe('Above Qmax');
    expect(qLimitText('below-min')).toBe('Below Qmin');
    expect(qLimitText('at-max')).toBe('At Qmax');
    expect(qLimitText('at-min')).toBe('At Qmin');
    expect(qLimitText('within')).toBe('Within limits');
    expect(qLimitText('none')).toBeNull();
    expect(qLimitMarkerLabel('above-max')).toBe('Reactive power beyond its upper limit');
    expect(qLimitMarkerLabel('at-min')).toBe('Reactive power at its lower limit');
    expect(qLimitMarkerLabel('within')).toBeNull();
    expect(qLimitMarkerLabel('none')).toBeNull();
  });
});
