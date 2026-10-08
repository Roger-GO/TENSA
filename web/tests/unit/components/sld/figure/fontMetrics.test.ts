/** How wide a text is in the three fonts a figure is set in. */
import { describe, expect, it } from 'vitest';
import { textWidth } from '@/components/sld/figure/fontMetrics';

describe('textWidth', () => {
  it('gives the widths Helvetica and Times have', () => {
    // A figure of either is 556 and 500 thousandths of the size.
    expect(textWidth('0123456789', 'sans', 10)).toBeCloseTo(55.6, 6);
    expect(textWidth('0123456789', 'serif', 10)).toBeCloseTo(50, 6);
    // "1.030 pu": five figures, a point, a space, p and u.
    expect(textWidth('1.030 pu', 'sans', 10)).toBeCloseTo(
      (4 * 556 + 278 + 278 + 556 + 556) / 100,
      6,
    );
    expect(textWidth('BUS14', 'sans', 10)).toBeCloseTo((667 + 722 + 667 + 556 + 556) / 100, 6);
    expect(textWidth('BUS14', 'serif', 10)).toBeCloseTo((667 + 722 + 556 + 500 + 500) / 100, 6);
    expect(textWidth('Wi', 'sans', 1000)).toBe(944 + 222);
  });

  it('gives every character of Courier the same width', () => {
    expect(textWidth('BUS14', 'mono', 10)).toBeCloseTo(30, 6);
    expect(textWidth('il.,', 'mono', 10)).toBeCloseTo(textWidth('MWMW', 'mono', 10), 6);
    expect(textWidth('母線', 'mono', 10)).toBeCloseTo(12, 6);
  });

  it('scales with the size, and is nothing for no text', () => {
    expect(textWidth('40.0 MW', 'sans', 20)).toBeCloseTo(2 * textWidth('40.0 MW', 'sans', 10), 6);
    expect(textWidth('', 'sans', 10)).toBe(0);
  });

  it('knows the degree sign of an angle, and takes a letter with an accent as the letter', () => {
    expect(textWidth('-7.25°', 'sans', 10)).toBeCloseTo(
      (333 + 556 + 278 + 556 + 556 + 400) / 100,
      6,
    );
    expect(textWidth('Öl', 'sans', 10)).toBeCloseTo(textWidth('Ol', 'sans', 10), 6);
    expect(textWidth('é', 'serif', 10)).toBeCloseTo(textWidth('e', 'serif', 10), 6);
  });

  it('takes a character it has no width for as no narrower than it is drawn', () => {
    // A CJK ideograph is a full em; a Latin letter outside the table as wide as most capitals.
    expect(textWidth('母', 'sans', 10)).toBe(10);
    expect(textWidth('ß', 'sans', 10)).toBeCloseTo(6.67, 6);
    expect(textWidth('ß', 'sans', 10)).toBeGreaterThanOrEqual(textWidth('n', 'sans', 10));
  });
});
