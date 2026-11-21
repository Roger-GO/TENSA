import { describe, expect, it } from 'vitest';
import { smallestDampingRatio, unstableModeCount } from '@/lib/eigModes';

describe('unstableModeCount', () => {
  it('counts the eigenvalues with a positive real part, and no zero one', () => {
    expect(
      unstableModeCount([
        { real: 0, imag: 0 },
        { real: 0, imag: 3 },
        { real: -0.5, imag: 1 },
        { real: 1e-9, imag: 2 },
        { real: 0.3, imag: 0 },
      ]),
    ).toBe(2);
  });

  it('skips a missing entry and counts none of an empty set', () => {
    expect(unstableModeCount([undefined, { real: 1, imag: 0 }])).toBe(1);
    expect(unstableModeCount([])).toBe(0);
  });
});

describe('smallestDampingRatio', () => {
  it('takes the smallest ratio of every mode, wherever it is in the list', () => {
    expect(smallestDampingRatio([0.3, 1, -0.02])).toBe(-0.02);
    expect(smallestDampingRatio([-0.1, 1, 0.5])).toBe(-0.1);
  });

  it('is null for a set with no modes', () => {
    expect(smallestDampingRatio([])).toBeNull();
  });
});
