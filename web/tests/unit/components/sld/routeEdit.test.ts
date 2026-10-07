/**
 * Moving a line by hand: what each move does to the points of a route
 * (`routeEdit.ts`). The routes here stand for the three shapes the diagram
 * draws: a branch that steps from one bar to the next, a branch that runs
 * straight down, and the connector of a device to its bar.
 */
import { describe, expect, it } from 'vitest';
import type { Point } from '@/components/sld/connections';
import {
  NECK,
  SNAP_REACH,
  applyEdit,
  moveBend,
  pointIn,
  pullBend,
  removeBend,
  runIn,
  settleEdit,
  slideRun,
  splitRun,
  tidyPoints,
  type RouteEnds,
} from '@/components/sld/routeEdit';

/** Two bars: one at the height 0 from 0 to 100, one at the height 200 from 150 to 250. */
const BARS: RouteEnds = {
  source: { kind: 'bar', y: 0, lo: 3, hi: 97 },
  target: { kind: 'bar', y: 200, lo: 153, hi: 247 },
};

/** Down from the first bar, across, and down onto the second. */
const STEPPED: Point[] = [
  [50, 0],
  [50, 100],
  [200, 100],
  [200, 200],
];

/** A device over a bar: out of its south face, square onto the bar. */
const DEVICE: RouteEnds = {
  source: { kind: 'fixed' },
  target: { kind: 'bar', y: 80, lo: 3, hi: 97 },
};
const DROP: Point[] = [
  [40, 0],
  [40, 80],
];

describe('slideRun', () => {
  it('moves a level run up or down, and the runs it meets get longer or shorter', () => {
    const { points, picked, by } = slideRun(STEPPED, 1, [30, -40], BARS);
    expect(points).toEqual([
      [50, 0],
      [50, 60],
      [200, 60],
      [200, 200],
    ]);
    // Only across itself: the 30 along the run moved nothing.
    expect(by).toEqual([0, -40]);
    expect(picked).toBe(1);
  });

  it('takes the tap of an upright run that ends on a bar along that bar', () => {
    const { points } = slideRun(STEPPED, 0, [20, 99], BARS);
    expect(points).toEqual([
      [70, 0],
      [70, 100],
      [200, 100],
      [200, 200],
    ]);
  });

  it('stops the tap at the tip of its bar, and says that it did', () => {
    const { points, by, stopped } = slideRun(STEPPED, 0, [500, 0], BARS);
    expect(points[0]).toEqual([97, 0]);
    expect(points[1]).toEqual([97, 100]);
    expect(by).toEqual([47, 0]);
    expect(stopped).toBe(true);
    // A move that stays on the bar, and one of a level run, is not stopped.
    expect(slideRun(STEPPED, 0, [20, 0], BARS).stopped).toBeUndefined();
    expect(slideRun(STEPPED, 1, [500, 30], BARS).stopped).toBeUndefined();
    expect(slideRun(STEPPED, 2, [-500, 0], BARS).points[3]).toEqual([153, 200]);
  });

  it('keeps a straight run between two bars straight, as far as both bars reach', () => {
    const ends: RouteEnds = {
      source: { kind: 'bar', y: 0, lo: 3, hi: 97 },
      target: { kind: 'bar', y: 200, lo: 40, hi: 140 },
    };
    const straight: Point[] = [
      [60, 0],
      [60, 200],
    ];
    expect(slideRun(straight, 0, [-50, 0], ends).points).toEqual([
      [40, 0],
      [40, 200],
    ]);
    expect(slideRun(straight, 0, [80, 0], ends).points).toEqual([
      [97, 0],
      [97, 200],
    ]);
  });

  it('puts a square step in where the run leaves a device, which stays attached', () => {
    const { points, picked } = slideRun(DROP, 0, [30, 0], DEVICE);
    expect(points).toEqual([
      [40, 0],
      [40, NECK],
      [70, NECK],
      [70, 80],
    ]);
    // The part that was grabbed is the one that moved.
    expect(picked).toBe(2);
  });

  it('steps out of a device half way along a run too short for the whole neck', () => {
    const short: Point[] = [
      [40, 0],
      [40, 16],
    ];
    const ends: RouteEnds = {
      source: { kind: 'fixed' },
      target: { kind: 'bar', y: 16, lo: 0, hi: 99 },
    };
    expect(slideRun(short, 0, [20, 0], ends).points[1]).toEqual([40, 8]);
  });

  it('makes a step at a bend that was put into a straight run', () => {
    const split = splitRun(STEPPED, 1, [120, 100])!;
    expect(split.points).toEqual([
      [50, 0],
      [50, 100],
      [120, 100],
      [200, 100],
      [200, 200],
    ]);
    // The half after the bend goes down, and the half before it stays.
    const { points } = slideRun(split.points, 2, [0, 40], BARS);
    expect(points).toEqual([
      [50, 0],
      [50, 100],
      [120, 100],
      [120, 140],
      [200, 140],
      [200, 200],
    ]);
  });

  it('moves a run at an angle as it is, with its tap along the bar', () => {
    const angled: Point[] = [
      [50, 0],
      [120, 100],
      [200, 100],
      [200, 200],
    ];
    const { points } = slideRun(angled, 0, [10, 15], BARS);
    expect(points).toEqual([
      [60, 0],
      [130, 115],
      [200, 100],
      [200, 200],
    ]);
  });

  it('answers the route unchanged for a run it does not have', () => {
    expect(slideRun(STEPPED, 7, [10, 10], BARS).points).toEqual(STEPPED);
  });
});

describe('moveBend', () => {
  it('moves a corner and keeps the two runs that meet there square', () => {
    const { points, picked } = moveBend(STEPPED, 1, [-20, 30], BARS);
    expect(points).toEqual([
      [30, 0],
      [30, 130],
      [200, 130],
      [200, 200],
    ]);
    expect(picked).toBe(1);
  });

  it('goes no further along x than the tap of its upright run can', () => {
    const { points, by, stopped } = moveBend(STEPPED, 1, [-500, 0], BARS);
    expect(points[0]).toEqual([3, 0]);
    expect(points[1]).toEqual([3, 100]);
    expect(by).toEqual([-47, 0]);
    expect(stopped).toBe(true);
  });

  it('moves the bend alone when asked to, which leaves its runs at an angle', () => {
    const { points } = moveBend(STEPPED, 1, [-20, 30], BARS, true);
    expect(points).toEqual([
      [50, 0],
      [30, 130],
      [200, 100],
      [200, 200],
    ]);
  });

  it('steps out of a device whose connector it bends', () => {
    const elbow: Point[] = [
      [60, 20],
      [120, 20],
      [120, 80],
    ];
    const ends: RouteEnds = {
      source: { kind: 'fixed' },
      target: { kind: 'bar', y: 80, lo: 3, hi: 197 },
    };
    const { points, picked } = moveBend(elbow, 1, [10, 25], ends);
    expect(points).toEqual([
      [60, 20],
      [60 + NECK, 20],
      [60 + NECK, 45],
      [130, 45],
      [130, 80],
    ]);
    expect(picked).toBe(3);
  });

  it('leaves the ends of a route alone', () => {
    expect(moveBend(STEPPED, 0, [10, 10], BARS).points).toEqual(STEPPED);
    expect(moveBend(STEPPED, 3, [10, 10], BARS).points).toEqual(STEPPED);
  });
});

describe('putting a bend in, and taking one out', () => {
  it('pulls a new bend out of a run to where it is taken', () => {
    const { points, picked } = pullBend(DROP, 0, [70, 40]);
    expect(points).toEqual([
      [40, 0],
      [70, 40],
      [40, 80],
    ]);
    expect(picked).toBe(1);
  });

  it('splits a run at the place on it nearest to the pointer', () => {
    expect(splitRun(STEPPED, 1, [130, 60])!.points[2]).toEqual([130, 100]);
  });

  it('does not split a run right at one of its ends', () => {
    expect(splitRun(STEPPED, 1, [52, 100])).toBeNull();
    expect(splitRun(STEPPED, 1, [900, 100])).toBeNull();
  });

  it('takes a bend out, so that the line runs straight between the two beside it', () => {
    expect(removeBend(STEPPED, 1)).toEqual([
      [50, 0],
      [200, 100],
      [200, 200],
    ]);
    expect(removeBend(STEPPED, 0)).toBeNull();
    expect(removeBend(STEPPED, 3)).toBeNull();
  });
});

describe('tidyPoints', () => {
  it('drops a bend that was put in and not moved, and a step of no height', () => {
    const split = splitRun(STEPPED, 1, [120, 100])!;
    expect(tidyPoints(split.points)).toEqual(STEPPED);
    expect(tidyPoints(slideRun(split.points, 2, [0, 0], BARS).points)).toEqual(STEPPED);
  });

  it('says where a run and a bend of a route are once it is tidied', () => {
    const split = splitRun(STEPPED, 1, [120, 100])!;
    const stepped = slideRun(split.points, 2, [0, 40], BARS);
    const tidy = tidyPoints(stepped.points);
    expect(runIn(stepped.points, stepped.picked, tidy)).toBe(3);
    expect(pointIn(stepped.points, 2, tidy)).toBe(2);
    // A bend that was in line with its run is gone.
    expect(pointIn(split.points, 2, tidyPoints(split.points))).toBe(-1);
  });
});

describe('applyEdit', () => {
  it('lands the line of a run on the grid, not how far it was moved', () => {
    const { points } = applyEdit(STEPPED, { kind: 'run', index: 1 }, [0, 23], BARS, { grid: 16 });
    // From 100: 123 is nearest to 128.
    expect(points[1]![1]).toBe(128);
  });

  it('puts a bend that is pulled nearly in line with its neighbours in line', () => {
    const part = { kind: 'pull', index: 0, at: [40, 40] as Point } as const;
    const { points } = applyEdit(DROP, part, [30, 37], DEVICE, { align: 6 });
    // 77 is within 6 of the bar at 80: a square corner.
    expect(points[1]).toEqual([70, 80]);
    expect(applyEdit(DROP, part, [30, 20], DEVICE, { align: 6 }).points[1]).toEqual([70, 60]);
  });

  it('lands a bend that is pulled on a whole place, whatever place its handle was drawn at', () => {
    // The handle is drawn beside its run, a few pixels of the screen off it.
    const part = { kind: 'pull', index: 0, at: [48.126, 40.5] as Point } as const;
    expect(applyEdit(DROP, part, [-39, 6], DEVICE, { align: 0 }).points[1]).toEqual([9, 47]);
  });
});

describe('settleEdit', () => {
  /** Nothing may run level between the heights 120 and 150. */
  const shut = (points: readonly Point[]): string | null =>
    points.some((p, i) => i > 0 && p[1] === points[i - 1]![1] && p[1] > 120 && p[1] < 150)
      ? 'it would lie on line L9'
      : null;

  it('draws the line where it was put, where that is clear', () => {
    const settled = settleEdit(STEPPED, { kind: 'run', index: 1 }, [0, -30], BARS, shut)!;
    expect(settled.refused).toBeNull();
    expect(settled.wanted).toBeNull();
    expect(settled.points[1]).toEqual([50, 70]);
  });

  it('goes to the nearest clear place where it was put on something, and says what on', () => {
    // 140 is shut: 150 is ten further, 120 twenty back.
    const settled = settleEdit(STEPPED, { kind: 'run', index: 1 }, [0, 40], BARS, shut)!;
    expect(settled.refused).toBe('it would lie on line L9');
    expect(settled.points[1]).toEqual([50, 150]);
    expect(settled.wanted![1]).toEqual([50, 140]);
    // 124 is nearer to 120.
    expect(settleEdit(STEPPED, { kind: 'run', index: 1 }, [0, 24], BARS, shut)!.points[1]).toEqual([
      50, 120,
    ]);
  });

  it('does not settle for a step too short to be read as one', () => {
    // Clear only within 4 of where the run came from, and at 60 from it.
    const near = (points: readonly Point[]): string | null => {
      const y = points[1]![1];
      return Math.abs(y - 100) <= 4 || y === 160 ? null : 'it would lie on line L9';
    };
    // Asked for 20 down: 4 down would be clear and is nearer than 60, but is no step.
    const settled = settleEdit(STEPPED, { kind: 'run', index: 1 }, [0, 20], BARS, near)!;
    expect(settled.points[1]).toEqual([50, 160]);
    // A move that small is made when it is what was asked for.
    expect(settleEdit(STEPPED, { kind: 'run', index: 1 }, [0, 4], BARS, near)!.points[1]).toEqual([
      50, 104,
    ]);
  });

  it('does not leave a kink where an end at the tip of its bar lets a run go only a little way', () => {
    // The tap of the connector can go 5 further along its bar, and no more.
    const short: RouteEnds = {
      source: { kind: 'fixed' },
      target: { kind: 'bar', y: 80, lo: 3, hi: 45 },
    };
    const none = (): null => null;
    expect(settleEdit(DROP, { kind: 'run', index: 0 }, [28, 0], short, none)).toBeNull();
    // With room for a step that can be read, the run goes as far as the tip.
    const wide: RouteEnds = { ...short, target: { kind: 'bar', y: 80, lo: 3, hi: 60 } };
    const settled = settleEdit(DROP, { kind: 'run', index: 0 }, [28, 0], wide, none)!;
    expect(settled.points.at(-1)).toEqual([60, 80]);
    expect(settled.refused).toBeNull();
    // A run that takes both its taps along leaves no step: a little way is a move.
    const straight: Point[] = [
      [50, 0],
      [50, 200],
    ];
    const both: RouteEnds = {
      source: { kind: 'bar', y: 0, lo: 3, hi: 55 },
      target: { kind: 'bar', y: 200, lo: 3, hi: 97 },
    };
    expect(settleEdit(straight, { kind: 'run', index: 0 }, [28, 0], both, none)!.points).toEqual([
      [55, 0],
      [55, 200],
    ]);
  });

  it('has no place for a line with none clear within reach', () => {
    const never = (): string => 'it would run through the bar of bus 3';
    expect(settleEdit(STEPPED, { kind: 'run', index: 1 }, [0, 40], BARS, never)).toBeNull();
    expect(SNAP_REACH).toBeGreaterThan(0);
  });

  it('looks for a bend a clear place in every direction', () => {
    // Shut wherever the bend is right of 75.
    const right = (points: readonly Point[]): string | null =>
      points[1]![0] > 75 ? 'it would run through the symbol of G1' : null;
    const settled = settleEdit(
      [
        [50, 0],
        [50, 100],
        [200, 140],
        [200, 200],
      ],
      { kind: 'bend', index: 1 },
      [30, 0],
      BARS,
      right,
      { free: true },
    )!;
    expect(settled.refused).not.toBeNull();
    // Straight back towards where it came from is the nearest way out.
    expect(settled.points[1]).toEqual([74, 100]);
  });

  it('does not take a part back past where it came from', () => {
    // Clear only on the far side of where the run stands.
    const above = (points: readonly Point[]): string | null =>
      points[1]![1] <= 100 ? null : 'it would lie on line L9';
    expect(settleEdit(STEPPED, { kind: 'run', index: 1 }, [0, 30], BARS, above)).toBeNull();
  });
});
