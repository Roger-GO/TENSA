import { describe, expect, it } from 'vitest';
import { formatMvar } from '@/lib/reactivePower';

describe('formatMvar', () => {
  it('shows a reactive power in MVAr, to two decimals', () => {
    expect(formatMvar(30.436)).toBe('30.44 MVAr');
    expect(formatMvar(0)).toBe('0.00 MVAr');
    expect(formatMvar(-1.005)).toBe('-1.00 MVAr');
  });

  it('shows the null of a DC power flow as a dash, never as 0', () => {
    expect(formatMvar(null)).toBe('—');
  });
});
