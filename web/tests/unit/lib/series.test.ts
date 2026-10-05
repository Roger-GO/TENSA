/**
 * ``valueAt`` and ``formatSignificant``: the reads behind the A/B cursor readout
 * and the response-metrics table.
 */
import { describe, expect, it } from 'vitest';
import { formatSignificant, valueAt } from '@/lib/series';

const T = new Float64Array([0, 1, 2, 4]);
const Y = new Float64Array([10, 20, 40, 0]);

describe('valueAt', () => {
  it('interpolates linearly between two samples', () => {
    expect(valueAt(T, Y, 0.5)).toBeCloseTo(15);
    expect(valueAt(T, Y, 1.5)).toBeCloseTo(30);
    // Samples need not be evenly spaced: 3 s sits halfway between 2 s and 4 s.
    expect(valueAt(T, Y, 3)).toBeCloseTo(20);
  });

  it('returns the sample itself on a sample, the first and the last included', () => {
    expect(valueAt(T, Y, 0)).toBe(10);
    expect(valueAt(T, Y, 2)).toBe(40);
    expect(valueAt(T, Y, 4)).toBe(0);
  });

  it('is null outside the span the signal is sampled over', () => {
    expect(valueAt(T, Y, -0.001)).toBeNull();
    expect(valueAt(T, Y, 4.001)).toBeNull();
  });

  it('is null for a target that is not a number, and for no samples', () => {
    expect(valueAt(T, Y, Number.NaN)).toBeNull();
    expect(valueAt(new Float64Array(0), new Float64Array(0), 1)).toBeNull();
  });

  it('is null beside a sample that is not a number (a gap, or a run that ended early)', () => {
    const t = new Float64Array([0, 1, 2, 3]);
    const y = new Float64Array([1, Number.NaN, 3, 4]);
    expect(valueAt(t, y, 0.5)).toBeNull();
    expect(valueAt(t, y, 1.5)).toBeNull();
    expect(valueAt(t, y, 1)).toBeNull();
    expect(valueAt(t, y, 2.5)).toBeCloseTo(3.5);
  });

  it('counts only the rows the run has: the typed arrays are over-allocated', () => {
    const t = new Float64Array([0, 1, 2, 0, 0, 0]);
    const y = new Float64Array([1, 2, 3, 99, 99, 99]);
    expect(valueAt(t, y, 1.5, 3)).toBeCloseTo(2.5);
    expect(valueAt(t, y, 2.5, 3)).toBeNull();
  });

  it('takes the later of samples at one time: the value after an event at that instant', () => {
    const t = new Float64Array([0, 1, 1, 2]);
    const y = new Float64Array([1, 1, 0.5, 0.5]);
    expect(valueAt(t, y, 1)).toBe(0.5);
    expect(valueAt(t, y, 0.5)).toBeCloseTo(1);
    expect(valueAt(t, y, 1.5)).toBeCloseTo(0.5);
  });
});

describe('formatSignificant', () => {
  it('shows a few significant digits and drops trailing zeros', () => {
    expect(formatSignificant(1.23456)).toBe('1.235');
    expect(formatSignificant(1)).toBe('1');
    expect(formatSignificant(0.99205)).toBe('0.992');
    expect(formatSignificant(-0.0123456)).toBe('-0.01235');
    expect(formatSignificant(1234.5678)).toBe('1235');
  });

  it('takes the digits asked for', () => {
    expect(formatSignificant(1.23456, 2)).toBe('1.2');
    expect(formatSignificant(12.3456, 5)).toBe('12.346');
  });

  it('moves to exponent form for very large and very small values', () => {
    expect(formatSignificant(123456)).toBe('1.235e+5');
    expect(formatSignificant(0.00001234)).toBe('1.234e-5');
  });

  it('shows zero as 0 and a missing or non-finite value as a dash', () => {
    expect(formatSignificant(0)).toBe('0');
    expect(formatSignificant(null)).toBe('–');
    expect(formatSignificant(undefined)).toBe('–');
    expect(formatSignificant(Number.NaN)).toBe('–');
    expect(formatSignificant(Number.POSITIVE_INFINITY)).toBe('–');
  });
});
