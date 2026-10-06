import { describe, expect, it } from 'vitest';
import { finiteOrNull, isFiniteNumber } from '@/lib/finite';

describe('isFiniteNumber', () => {
  it('takes a number that is neither NaN nor infinite', () => {
    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(-1.5e-9)).toBe(true);
  });

  it('refuses what is not a number, or not a finite one', () => {
    for (const value of [NaN, Infinity, -Infinity, null, undefined, '1', true, {}, []]) {
      expect(isFiniteNumber(value)).toBe(false);
    }
  });
});

describe('finiteOrNull', () => {
  it('gives the number back, and null for anything else', () => {
    expect(finiteOrNull(1.02)).toBe(1.02);
    expect(finiteOrNull(0)).toBe(0);
    expect(finiteOrNull(NaN)).toBeNull();
    expect(finiteOrNull(Infinity)).toBeNull();
    expect(finiteOrNull(null)).toBeNull();
    expect(finiteOrNull(undefined)).toBeNull();
    expect(finiteOrNull('1.02')).toBeNull();
  });
});
