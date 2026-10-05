/**
 * When a kept result was produced, as a list shows it: the time for one from
 * today, the date in front for an older one.
 */
import { describe, expect, it } from 'vitest';
import { formatTakenAt } from '@/lib/takenAt';

/** A local time, since the label is written in the reader's own time zone. */
function local(y: number, m: number, d: number, hh: number, mm: number, ss = 0): number {
  return new Date(y, m - 1, d, hh, mm, ss).getTime();
}

describe('formatTakenAt', () => {
  const now = local(2026, 10, 5, 16, 30);

  it('gives the time, to the second, for a result from today', () => {
    expect(formatTakenAt(local(2026, 10, 5, 9, 4, 7), now)).toBe('09:04:07');
  });

  it('puts the date in front for a result from an earlier day', () => {
    expect(formatTakenAt(local(2026, 10, 4, 23, 59, 58), now)).toBe('2026-10-04 23:59');
    expect(formatTakenAt(local(2025, 10, 5, 9, 4), now)).toBe('2025-10-05 09:04');
  });

  it('gives a dash for a time that is not one', () => {
    expect(formatTakenAt(Number.NaN, now)).toBe('—');
  });
});
