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
    const unmeasured = { strip: 4, openMin: 15, open: 35, canvasMin: 25 };
    expect(bottomDrawerSizes(0)).toEqual(unmeasured);
    expect(bottomDrawerSizes(Number.NaN)).toEqual(unmeasured);
  });

  it('keeps the diagram a height in pixels it can be used at, whatever the window', () => {
    // 280 px of a column 1000 high, and of one 700 high.
    expect(bottomDrawerSizes(1000).canvasMin).toBe(28);
    expect(bottomDrawerSizes(700).canvasMin).toBe(40);
    for (const column of [300, 441, 500, 700, 1000, 1400]) {
      const { openMin, open, canvasMin } = bottomDrawerSizes(column);
      // Both fit: an open drawer at its least height, and the diagram over it.
      expect(canvasMin + openMin, `${column}`).toBeLessThanOrEqual(100);
      // What the drawer opens to leaves the diagram its least height too.
      expect(open, `${column}`).toBeLessThanOrEqual(100 - canvasMin + 1e-9);
      expect(open, `${column}`).toBeGreaterThanOrEqual(openMin);
    }
  });

  it('lets the drawer open in a column too short for both, and the diagram have the rest', () => {
    // 441 px: the column of a window 485 px high. The diagram would want
    // 63 % of it and an open drawer needs 39 %.
    const { openMin, canvasMin } = bottomDrawerSizes(441);
    expect(openMin).toBeCloseTo(39, 0);
    expect(canvasMin).toBeCloseTo(61, 0);
  });
});
