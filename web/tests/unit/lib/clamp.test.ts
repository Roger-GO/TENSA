import { describe, expect, it } from 'vitest';

import { clamp } from '@/lib/clamp';

describe('clamp', () => {
  it('holds a number within its bounds', () => {
    expect(clamp(-3, 0, 4)).toBe(0);
    expect(clamp(9, 0, 4)).toBe(4);
    expect(clamp(2, 0, 4)).toBe(2);
    expect(clamp(0, 0, 4)).toBe(0);
    expect(clamp(4, 0, 4)).toBe(4);
  });

  it('answers the upper bound when the bounds cross, as an index into an empty list needs', () => {
    expect(clamp(0, 0, -1)).toBe(-1);
    expect(clamp(-1, 0, -1)).toBe(-1);
    expect(clamp(3, 0, -1)).toBe(-1);
  });
});
