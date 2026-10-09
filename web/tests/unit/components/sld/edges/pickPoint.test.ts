/**
 * Where a click on the middle of an edge lands (`pickPoint.ts`): on the
 * line itself, clear of the boxes at its two ends and of the symbol drawn
 * on it, with a box around the whole line that has that point for its
 * middle.
 */
import { describe, expect, it } from 'vitest';
import type { Point } from '@/components/sld/connections';
import {
  PICK_MIN_HALF,
  PICK_OFF_BAR,
  PICK_OFF_BAR_WITH_VALUES,
  PICK_OFF_SYMBOL,
  pickBox,
  pickPoint,
} from '@/components/sld/edges/pickPoint';

/** How far `p` is from the route `points`. */
function offRoute(points: readonly Point[], p: Point): number {
  let least = Infinity;
  for (let k = 1; k < points.length; k += 1) {
    const [a, b] = [points[k - 1]!, points[k]!];
    const [ux, uy] = [b[0] - a[0], b[1] - a[1]];
    const t = Math.min(
      1,
      Math.max(0, ((p[0] - a[0]) * ux + (p[1] - a[1]) * uy) / (ux * ux + uy * uy)),
    );
    least = Math.min(least, Math.hypot(a[0] + t * ux - p[0], a[1] + t * uy - p[1]));
  }
  return least;
}

describe('pickPoint', () => {
  it('is on the line where the middle of its box is not: a line that turns', () => {
    // Down, across and down: the middle of the box is on empty ground.
    const stepped: Point[] = [
      [0, 3],
      [0, 100],
      [200, 100],
      [200, 203],
    ];
    const at = pickPoint(stepped, { fromBar: true });
    expect(offRoute(stepped, at)).toBeLessThan(0.01);
    // The middle of its longest run.
    expect(at).toEqual([100, 100]);
  });

  it('keeps off the bars a line ends on, where the box of the bus takes the click', () => {
    // Straight down from one bar to the next.
    const straight: Point[] = [
      [40, 3],
      [40, 203],
    ];
    const at = pickPoint(straight, { fromBar: true });
    expect(at).toEqual([40, 103]);
    // A connector that comes up to its bar from a device under it: nearer
    // the device, clear of the box that hangs under the bar.
    const fromBelow: Point[] = [
      [40, 60],
      [40, 3],
    ];
    const [, y] = pickPoint(fromBelow, { fromBar: false });
    expect(y).toBeGreaterThanOrEqual(3 + PICK_OFF_BAR);
    expect(y).toBeLessThan(60);
  });

  it('keeps further off under a bar while the values of a power flow show, where the box of the bus is taller', () => {
    // Down from one bar to the top of the next, 80 apart: the box of the
    // upper bus hangs over the first 46 of it with a voltage and an angle
    // in its label.
    const down: Point[] = [
      [40, 3],
      [40, 83],
    ];
    expect(pickPoint(down, { fromBar: true })[1]).toBeLessThan(3 + PICK_OFF_BAR_WITH_VALUES);
    const [, y] = pickPoint(down, { fromBar: true, values: true });
    expect(y).toBeGreaterThanOrEqual(3 + PICK_OFF_BAR_WITH_VALUES);
    // Only under a bar: the end that comes to the top of the lower bar
    // keeps the room it kept.
    expect(y).toBeLessThanOrEqual(83 - PICK_OFF_BAR);
    // The connector of a device under its bar, the same from the other end.
    const fromBelow: Point[] = [
      [40, 90],
      [40, 3],
    ];
    const [, up] = pickPoint(fromBelow, { fromBar: false, values: true });
    expect(up).toBeGreaterThanOrEqual(3 + PICK_OFF_BAR_WITH_VALUES);
    expect(up).toBeLessThan(90);
  });

  it('keeps off the symbol of a transformer, which takes its own clicks', () => {
    const route: Point[] = [
      [40, 3],
      [40, 203],
    ];
    const at = pickPoint(route, { fromBar: true, avoid: { x: 40, y: 103 } });
    expect(offRoute(route, at)).toBeLessThan(0.01);
    expect(Math.abs(at[1] - 103)).toBeGreaterThanOrEqual(PICK_OFF_SYMBOL);
    // A symbol that stands beside the line, not on it, is not in the way.
    expect(pickPoint(route, { fromBar: true, avoid: { x: 120, y: 103 } })).toEqual([40, 103]);
  });

  it('is half way along a line too short to keep off anything', () => {
    const short: Point[] = [
      [40, 3],
      [40, 23],
    ];
    expect(pickPoint(short, { fromBar: true })).toEqual([40, 13]);
  });
});

describe('pickBox', () => {
  it('holds the whole line, with the point in its middle', () => {
    const stepped: Point[] = [
      [0, 3],
      [0, 100],
      [200, 100],
      [200, 203],
    ];
    const at = pickPoint(stepped, { fromBar: true });
    const box = pickBox(stepped, at);
    expect([box.x + box.width / 2, box.y + box.height / 2]).toEqual(at);
    for (const [x, y] of stepped) {
      expect(x).toBeGreaterThanOrEqual(box.x);
      expect(x).toBeLessThanOrEqual(box.x + box.width);
      expect(y).toBeGreaterThanOrEqual(box.y);
      expect(y).toBeLessThanOrEqual(box.y + box.height);
    }
  });

  it('gives a straight line a box with a width', () => {
    const straight: Point[] = [
      [40, 3],
      [40, 203],
    ];
    const box = pickBox(straight, pickPoint(straight, { fromBar: true }));
    expect(box.width).toBe(2 * PICK_MIN_HALF);
    expect(box.height).toBe(200);
  });
});
