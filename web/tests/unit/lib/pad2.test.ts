import { describe, expect, it } from 'vitest';
import { pad2 } from '@/lib/pad2';

describe('pad2', () => {
  it('writes a part of a date or a time as two digits', () => {
    expect(pad2(0)).toBe('00');
    expect(pad2(7)).toBe('07');
    expect(pad2(12)).toBe('12');
  });
});
