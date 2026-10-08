/**
 * The heights of the bottom drawer (`drawerSizes.ts`): so many pixels,
 * whatever the height of the window, handed to the panels in percent of the
 * column the drawer shares with the diagram.
 */
import { describe, expect, it } from 'vitest';
import {
  DRAWER_OPEN_MIN_PX,
  DRAWER_STRIP_PX,
  bottomDrawerSizes,
} from '@/components/shell/drawerSizes';

/** `percent` of a column `column` pixels high, in pixels. */
const px = (percent: number, column: number): number => (percent / 100) * column;

describe('bottomDrawerSizes', () => {
  it('makes the strip as high as the tabs, and the least open height a table with two rows, in a window of any height', () => {
    // The column under the top bar of a window 485, 720, 900 and 1300 high.
    for (const column of [441, 676, 856, 1256]) {
      const { strip, openMin } = bottomDrawerSizes(column);
      expect(px(strip, column)).toBeGreaterThanOrEqual(DRAWER_STRIP_PX - 0.5);
      expect(px(strip, column)).toBeLessThan(DRAWER_STRIP_PX + 1);
      expect(px(openMin, column)).toBeGreaterThanOrEqual(DRAWER_OPEN_MIN_PX - 0.5);
      expect(px(openMin, column)).toBeLessThan(DRAWER_OPEN_MIN_PX + 1);
    }
  });

  it('opens a drawer from its strip to a third of the column, or to its least height where that is more', () => {
    expect(bottomDrawerSizes(856).open).toBe(35);
    const short = bottomDrawerSizes(441);
    expect(short.openMin).toBeGreaterThan(35);
    expect(short.open).toBe(short.openMin);
  });

  it('leaves the diagram the larger part of a column too low for both', () => {
    const { strip, openMin, open } = bottomDrawerSizes(200);
    expect(openMin).toBe(60);
    expect(open).toBe(60);
    // Still down at a strip, and well under the height it snaps open at.
    expect(strip).toBeLessThanOrEqual(openMin / 2);
  });

  it('answers the sizes of a window of the usual height for a column that is not measured yet', () => {
    expect(bottomDrawerSizes(0)).toEqual({ strip: 4, openMin: 15, open: 35 });
    expect(bottomDrawerSizes(Number.NaN)).toEqual({ strip: 4, openMin: 15, open: 35 });
  });
});
