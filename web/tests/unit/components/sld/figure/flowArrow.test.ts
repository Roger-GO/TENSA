/**
 * The arrow of a flow on a figure, held to where it may stand.
 *
 * `placeArrow` is given a line and what is drawn round it, and answers the
 * place of the arrow: where it was asked for while that is clear, the
 * nearest clear place along the line otherwise, and none where the line has
 * none. Each rule it keeps is held here on a line made for it: the room to
 * another line, to a box, to a bend, to the bar at either end and to the
 * line's own label, and the way the arrow points.
 */
import { describe, expect, it } from 'vitest';
import { distanceToRun, type Rect } from '@/components/sld/connections';
import {
  ARROW_HALF_WIDTH,
  ARROW_OFF_BAR,
  ARROW_OFF_BEND,
  ARROW_OFF_BOX,
  ARROW_OFF_LINE,
  arrowCorners,
  placeArrow,
  type ArrowSpot,
} from '@/components/sld/figure/flowArrow';

type At = readonly [number, number];

/** A line straight down from one bar to another, 200 px long. */
const DOWN: At[] = [
  [0, 0],
  [0, 200],
];
const NOTHING = { lines: [], boxes: [] };

/** From the top of the arrow at `spot` to its foot, along an upright line. */
function span(spot: ArrowSpot, size: number): [number, number] {
  const ys = arrowCorners(spot, size, true).map(([, y]) => y);
  return [Math.min(...ys), Math.max(...ys)];
}

/** How near the arrow at `spot` comes to the run from `a` to `b`: the nearest of its corners. */
function offLine(spot: ArrowSpot, size: number, forward: boolean, a: At, b: At): number {
  return Math.min(...arrowCorners(spot, size, forward).map((c) => distanceToRun(c, a, b)));
}

describe('the shape of the arrow of a flow', () => {
  it('points along the run where the power flows from the first end to the last, and against it otherwise', () => {
    const spot = { x: 10, y: 50, angleDeg: 90 };
    const [tip, left, right] = arrowCorners(spot, 12, true);
    // Down the line: the tip 6 px past the middle, the base 6 px before it.
    expect(tip[0]).toBeCloseTo(10, 9);
    expect(tip[1]).toBeCloseTo(56, 9);
    expect(left[1]).toBeCloseTo(44, 9);
    expect(right[1]).toBeCloseTo(44, 9);
    const [back] = arrowCorners(spot, 12, false);
    expect(back[0]).toBeCloseTo(10, 9);
    expect(back[1]).toBeCloseTo(44, 9);
    // On a level run from left to right, to the right and to the left.
    expect(arrowCorners({ x: 0, y: 0, angleDeg: 0 }, 12, true)[0]![0]).toBeCloseTo(6, 9);
    expect(arrowCorners({ x: 0, y: 0, angleDeg: 0 }, 12, false)[0]![0]).toBeCloseTo(-6, 9);
  });

  it('is never wider than what stands beside a line leaves it', () => {
    for (const size of [7, 10, 15]) {
      const [, left, right] = arrowCorners({ x: 0, y: 0, angleDeg: 0 }, size, true);
      const half = Math.abs(left[1]);
      expect(Math.abs(right[1])).toBeCloseTo(half, 9);
      expect(half).toBeCloseTo(Math.min(size * 0.3, ARROW_HALF_WIDTH), 9);
      expect(half).toBeLessThanOrEqual(ARROW_HALF_WIDTH);
    }
    // The largest arrow is the widest there is.
    expect(Math.abs(arrowCorners({ x: 0, y: 0, angleDeg: 0 }, 15, true)[1]![1])).toBe(3.5);
  });
});

describe('where the arrow of a flow stands', () => {
  it('stands where it is asked for while nothing is there', () => {
    expect(placeArrow(DOWN, { x: 0, y: 100 }, 10, true, null, NOTHING)).toEqual({
      x: 0,
      y: 100,
      angleDeg: 90,
    });
    // Also right beside a line that only passes, far enough off.
    const beside: At[] = [
      [ARROW_HALF_WIDTH + ARROW_OFF_LINE + 0.01, 0],
      [ARROW_HALF_WIDTH + ARROW_OFF_LINE + 0.01, 200],
    ];
    expect(
      placeArrow(DOWN, { x: 0, y: 100 }, 15, true, null, { lines: [beside], boxes: [] }),
    ).toMatchObject({ y: 100 });
  });

  it('moves off a line that crosses its own there, to the nearest place clear of it', () => {
    const crossing: At[] = [
      [-40, 100],
      [40, 100],
    ];
    const around = { lines: [crossing], boxes: [] };
    for (const size of [7, 15]) {
      for (const forward of [true, false]) {
        const spot = placeArrow(DOWN, { x: 0, y: 100 }, size, forward, null, around)!;
        expect(spot, `${size} ${forward}`).not.toBeNull();
        // On its own line still, and off the other by the room it keeps.
        expect(spot.x).toBe(0);
        expect(offLine(spot, size, forward, crossing[0]!, crossing[1]!)).toBeGreaterThanOrEqual(
          ARROW_OFF_LINE,
        );
        // No further than it has to go: the room, half its length, and a step.
        expect(Math.abs(spot.y - 100)).toBeLessThanOrEqual(ARROW_OFF_LINE + size / 2 + 1);
        // To the side the power flows towards.
        expect(spot.y > 100).toBe(forward);
      }
    }
  });

  it('moves the other way where the side the power flows towards is taken as well', () => {
    const crossings: At[][] = [
      [
        [-40, 100],
        [40, 100],
      ],
      [
        [-40, 118],
        [40, 118],
      ],
    ];
    const spot = placeArrow(DOWN, { x: 0, y: 100 }, 10, true, null, {
      lines: crossings,
      boxes: [],
    })!;
    expect(spot.y).toBeLessThan(100);
    for (const [a, b] of crossings) {
      expect(offLine(spot, 10, true, a!, b!)).toBeGreaterThanOrEqual(ARROW_OFF_LINE);
    }
  });

  it('keeps off the end of another line, and off a line that passes at an angle', () => {
    // One that ends right beside the place, and one that cuts across it.
    for (const other of [
      [
        [4, 100],
        [60, 100],
      ],
      [
        [-30, 80],
        [30, 120],
      ],
    ] as At[][]) {
      const spot = placeArrow(DOWN, { x: 0, y: 100 }, 12, true, null, {
        lines: [other],
        boxes: [],
      })!;
      expect(spot.y).not.toBe(100);
      // No corner of it within the room, and the other line nowhere through it.
      expect(offLine(spot, 12, true, other[0]!, other[1]!)).toBeGreaterThanOrEqual(ARROW_OFF_LINE);
    }
  });

  it('keeps off a box that stands by its line: a symbol, a label, a bar', () => {
    // 3 px from the line, where the arrow would reach into it.
    const box: Rect = { left: 3, right: 60, top: 90, bottom: 110 };
    const size = 15;
    const spot = placeArrow(DOWN, { x: 0, y: 100 }, size, true, null, {
      lines: [],
      boxes: [box],
    })!;
    const [top, foot] = span(spot, size);
    expect(top).toBeGreaterThanOrEqual(box.bottom + ARROW_OFF_BOX - 1e-6);
    expect(top).toBeLessThan(box.bottom + ARROW_OFF_BOX + 1);
    expect(foot - top).toBeCloseTo(size, 9);
    // One that stands further off than the arrow reaches, with its room, is not in the way.
    const clear: Rect = { ...box, left: ARROW_HALF_WIDTH + ARROW_OFF_BOX };
    expect(
      placeArrow(DOWN, { x: 0, y: 100 }, size, true, null, { lines: [], boxes: [clear] }),
    ).toMatchObject({ y: 100 });
  });

  it('keeps off the bar at either end of its line', () => {
    for (const [asked, forward] of [
      [199, true],
      [1, true],
      [199, false],
      [1, false],
    ] as const) {
      const spot = placeArrow(DOWN, { x: 0, y: asked }, 10, forward, null, NOTHING)!;
      const [top, foot] = span(spot, 10);
      if (asked > 100) {
        expect(foot).toBeLessThanOrEqual(200 - ARROW_OFF_BAR);
        expect(foot).toBeGreaterThan(200 - ARROW_OFF_BAR - 1);
      } else {
        expect(top).toBeGreaterThanOrEqual(ARROW_OFF_BAR);
        expect(top).toBeLessThan(ARROW_OFF_BAR + 1);
      }
    }
  });

  it('stands in the middle of a run, off the bend at its end', () => {
    // Down, then across: asked for right at the bend.
    const bent: At[] = [
      [0, 0],
      [0, 100],
      [100, 100],
    ];
    for (const forward of [true, false]) {
      const spot = placeArrow(bent, { x: 0, y: 100 }, 10, forward, null, NOTHING)!;
      const corners = arrowCorners(spot, 10, forward);
      if (spot.angleDeg === 90) {
        // On the upright run: all of it over the bend.
        expect(spot.x).toBe(0);
        const foot = Math.max(...corners.map(([, y]) => y));
        expect(foot).toBeLessThanOrEqual(100 - ARROW_OFF_BEND);
        expect(foot).toBeGreaterThan(100 - ARROW_OFF_BEND - 1);
      } else {
        // On the level run: all of it past the bend.
        expect(spot.angleDeg).toBe(0);
        expect(spot.y).toBe(100);
        const left = Math.min(...corners.map(([x]) => x));
        expect(left).toBeGreaterThanOrEqual(ARROW_OFF_BEND);
        expect(left).toBeLessThan(ARROW_OFF_BEND + 1);
      }
      // The run the power flows towards: on from the bend, or back up from it.
      expect(spot.angleDeg).toBe(forward ? 0 : 90);
    }
  });

  it('is drawn right past the room of a label that stands on the line, at the end the power flows towards', () => {
    // The label of a line, 84 by 19, on the middle of the line.
    const label: Rect = { left: -42, right: 42, top: 90.5, bottom: 109.5 };
    const drawn: Rect = { left: -30, right: 30, top: 93, bottom: 107 };
    const around = { lines: [], boxes: [drawn] };
    const size = 12;
    const down = placeArrow(DOWN, { x: 0, y: 100 }, size, true, label, around)!;
    expect(span(down, size)[0]).toBeCloseTo(label.bottom + ARROW_OFF_BOX, 9);
    const up = placeArrow(DOWN, { x: 0, y: 100 }, size, false, label, around)!;
    expect(span(up, size)[1]).toBeCloseTo(label.top - ARROW_OFF_BOX, 9);

    // With another line across that end, at the other end of the label.
    const crossing: At[] = [
      [-40, 120],
      [40, 120],
    ];
    const other = placeArrow(DOWN, { x: 0, y: 100 }, size, true, label, {
      lines: [crossing],
      boxes: [drawn],
    })!;
    expect(span(other, size)[1]).toBeCloseTo(label.top - ARROW_OFF_BOX, 9);
  });

  it('is drawn beside the label as it is drawn where the room of the label leaves the line too short', () => {
    // A line 96 px long with a label turned along it: its room is 64 px of
    // the line, which leaves 7 px either end between room and bar.
    const short: At[] = [
      [0, 0],
      [0, 96],
    ];
    const label: Rect = { left: -9.5, right: 9.5, top: 16, bottom: 80 };
    // What is drawn of it is 40 px long.
    const drawn: Rect = { left: -6, right: 6, top: 28, bottom: 68 };
    const size = 8;
    const spot = placeArrow(short, { x: 0, y: 48 }, size, true, label, {
      lines: [],
      boxes: [drawn],
    })!;
    expect(spot).not.toBeNull();
    const [top, foot] = span(spot, size);
    // Past the end the power flows towards, clear of the text and of the bar.
    expect(top).toBeGreaterThanOrEqual(drawn.bottom + ARROW_OFF_BOX);
    expect(top).toBeLessThan(drawn.bottom + ARROW_OFF_BOX + 1);
    expect(foot).toBeLessThanOrEqual(96 - ARROW_OFF_BAR);
  });

  it('is left off a line that has no place for it', () => {
    // Too short between its two bars for the arrow and its room.
    const stub: At[] = [
      [0, 0],
      [0, 2 * ARROW_OFF_BAR + 9],
    ];
    expect(placeArrow(stub, { x: 0, y: 13.5 }, 10, true, null, NOTHING)).toBeNull();
    expect(placeArrow(stub, { x: 0, y: 13.5 }, 9, true, null, NOTHING)).not.toBeNull();
    // Long enough, with a line across it wherever the arrow could stand.
    const tight: At[] = [
      [0, 0],
      [0, 40],
    ];
    const crossing: At[] = [
      [-40, 20],
      [40, 20],
    ];
    expect(
      placeArrow(tight, { x: 0, y: 20 }, 10, true, null, { lines: [crossing], boxes: [] }),
    ).toBeNull();
    expect(placeArrow(tight, { x: 0, y: 20 }, 10, true, null, NOTHING)).not.toBeNull();
    // And a line with no length at all.
    expect(
      placeArrow(
        [
          [5, 5],
          [5, 5],
        ],
        { x: 5, y: 5 },
        10,
        true,
        null,
        NOTHING,
      ),
    ).toBeNull();
  });

  it('finds the place on another run of the line where the one asked for has none', () => {
    // Across for 16 px between two long upright runs: no room on the middle run.
    const stepped: At[] = [
      [0, 0],
      [0, 100],
      [16, 100],
      [16, 200],
    ];
    const spot = placeArrow(stepped, { x: 8, y: 100 }, 15, true, null, NOTHING)!;
    // On the run the power flows towards, right past the bend.
    expect(spot.x).toBe(16);
    expect(spot.angleDeg).toBe(90);
    expect(span(spot, 15)[0]).toBeGreaterThanOrEqual(100 + ARROW_OFF_BEND);
    expect(span(spot, 15)[0]).toBeLessThan(100 + ARROW_OFF_BEND + 1);
  });
});
