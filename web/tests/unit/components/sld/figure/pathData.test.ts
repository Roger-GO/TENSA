/**
 * The path data of the symbol files as the steps a figure draws: absolute
 * points, every curve a cubic one.
 */
import { describe, expect, it } from 'vitest';
import type { PathStep } from '@/components/sld/figure/displayList';
import { circleSteps, parsePathData, roundedRectSteps } from '@/components/sld/figure/pathData';

/** The point a step ends at. */
const end = (step: PathStep): [number, number] | null =>
  step.op === 'Z' ? null : [step.x, step.y];

/** Where a cubic from `from` is at `t`. */
function cubicAt(from: [number, number], step: PathStep, t: number): [number, number] {
  if (step.op !== 'C') throw new Error('not a curve');
  const u = 1 - t;
  const at = (p0: number, p1: number, p2: number, p3: number): number =>
    u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
  return [at(from[0], step.x1, step.x2, step.x), at(from[1], step.y1, step.y2, step.y)];
}

describe('parsePathData', () => {
  it('reads straight runs, absolute and relative, and closes a path', () => {
    expect(parsePathData('M 4 8 L 20 8 L 12 22 Z')).toEqual([
      { op: 'M', x: 4, y: 8 },
      { op: 'L', x: 20, y: 8 },
      { op: 'L', x: 12, y: 22 },
      { op: 'Z' },
    ]);
    // The triangle of the exciter glyph, written the short way.
    expect(parsePathData('M7 5l10 7-10 7z')).toEqual([
      { op: 'M', x: 7, y: 5 },
      { op: 'L', x: 17, y: 12 },
      { op: 'L', x: 7, y: 19 },
      { op: 'Z' },
    ]);
  });

  it('reads level and upright runs', () => {
    expect(parsePathData('M12 9V4h3v-2H1')).toEqual([
      { op: 'M', x: 12, y: 9 },
      { op: 'L', x: 12, y: 4 },
      { op: 'L', x: 15, y: 4 },
      { op: 'L', x: 15, y: 2 },
      { op: 'L', x: 1, y: 2 },
    ]);
  });

  it('goes on in straight runs after the first pair of a move', () => {
    expect(parsePathData('M1 1 5 1 5 5').map((s) => s.op)).toEqual(['M', 'L', 'L']);
    expect(parsePathData('m1 1 4 0').map(end)).toEqual([
      [1, 1],
      [5, 1],
    ]);
  });

  it('turns a quadratic curve into the cubic that draws the same curve', () => {
    // The tilde of the generator symbol.
    const steps = parsePathData('M 6 12 Q 9 7.5 12 12 T 18 12');
    expect(steps.map((s) => s.op)).toEqual(['M', 'C', 'C']);
    expect(steps.map(end)).toEqual([
      [6, 12],
      [12, 12],
      [18, 12],
    ]);
    // Half way along, a quadratic from 6,12 over 9,7.5 to 12,12 is at 9, 9.75.
    const [x, y] = cubicAt([6, 12], steps[1]!, 0.5);
    expect(x).toBeCloseTo(9, 6);
    expect(y).toBeCloseTo(9.75, 6);
    // The smooth one mirrors the control point: 15, 16.5, so it dips to 14.25.
    const [x2, y2] = cubicAt([12, 12], steps[2]!, 0.5);
    expect(x2).toBeCloseTo(15, 6);
    expect(y2).toBeCloseTo(14.25, 6);
  });

  it('reads a smooth cubic as mirroring the control point before it', () => {
    // The sine of the stabiliser glyph.
    const steps = parsePathData('M3 12c3-7 6 7 9 0s6-7 9 0');
    expect(steps.map((s) => s.op)).toEqual(['M', 'C', 'C']);
    const second = steps[2]!;
    if (second.op !== 'C') throw new Error('not a curve');
    // The first curve ended with its control point at 9, 19; mirrored in 12, 12.
    expect([second.x1, second.y1]).toEqual([15, 5]);
    expect([second.x, second.y]).toEqual([21, 12]);
  });

  it('reads the two flags of an arc as one digit each, with nothing between them and the next number', () => {
    // The gauge of the measurement glyph: half a circle of radius 8 from 4,16 to 20,16.
    const steps = parsePathData('M4 16a8 8 0 0116 0');
    expect(end(steps[steps.length - 1]!)).toEqual([20, 16]);
    expect(steps.slice(1).every((s) => s.op === 'C')).toBe(true);
    // Every point of it is 8 from the middle, 12,16, and over it.
    let from: [number, number] = [4, 16];
    for (const step of steps.slice(1)) {
      for (const t of [0.25, 0.5, 0.75, 1]) {
        const [x, y] = cubicAt(from, step, t);
        expect(Math.hypot(x - 12, y - 16)).toBeCloseTo(8, 2);
        expect(y).toBeLessThanOrEqual(16 + 1e-6);
      }
      from = end(step)!;
    }
  });

  it('follows each arc of a row of them, and ends on the point the path names', () => {
    // The coil of the reactor symbol: three half circles of radius 2 down from 12,7.
    const steps = parsePathData('M 12 7 A 2 2 0 0 1 12 11 A 2 2 0 0 1 12 15 A 2 2 0 0 1 12 19');
    const ends = steps.map(end).filter((p) => p !== null);
    expect(ends[0]).toEqual([12, 7]);
    expect(ends[ends.length - 1]).toEqual([12, 19]);
    // Each bulges to the right of the line it runs down.
    let from: [number, number] = [12, 7];
    for (const step of steps.slice(1)) {
      expect(cubicAt(from, step, 0.5)[0]).toBeGreaterThan(12);
      from = end(step)!;
    }
  });

  it('draws an arc whose radii are too short to reach as the smallest that does', () => {
    const steps = parsePathData('M0 0A1 1 0 0 1 10 0');
    expect(end(steps[steps.length - 1]!)).toEqual([10, 0]);
    // Half a circle of radius 5 about 5,0.
    const [x, y] = cubicAt([0, 0], steps[1]!, 0.5);
    expect(Math.hypot(x - 5, y)).toBeCloseTo(5, 2);
  });

  it('refuses a command it cannot draw, so that a symbol is not left out of a figure in silence', () => {
    expect(() => parsePathData('M0 0X5 5')).toThrow(/not supported/);
    expect(() => parsePathData('M0 0L5')).toThrow(/numbers/);
    expect(() => parsePathData('5 5')).toThrow(/unexpected/);
  });
});

describe('circleSteps and roundedRectSteps', () => {
  it('draw a circle as four curves that stay on it', () => {
    const steps = circleSteps(10, 20, 5);
    expect(steps.map((s) => s.op)).toEqual(['M', 'C', 'C', 'C', 'C', 'Z']);
    let from = end(steps[0]!)!;
    for (const step of steps.slice(1, 5)) {
      const [x, y] = cubicAt(from, step, 0.5);
      expect(Math.hypot(x - 10, y - 20)).toBeCloseTo(5, 2);
      from = end(step)!;
    }
    expect(from).toEqual([15, 20]);
  });

  it('draw a rectangle square without a radius, and no rounder than half its shorter side', () => {
    expect(roundedRectSteps(0, 0, 10, 4, 0).map((s) => s.op)).toEqual(['M', 'L', 'L', 'L', 'Z']);
    const rounded = roundedRectSteps(0, 0, 10, 4, 50);
    // A radius of 2: the top edge runs from 2 to 8.
    expect(end(rounded[0]!)).toEqual([2, 0]);
    expect(end(rounded[1]!)).toEqual([8, 0]);
    for (const step of rounded) {
      const at = end(step);
      if (at === null) continue;
      expect(at[0]).toBeGreaterThanOrEqual(0);
      expect(at[0]).toBeLessThanOrEqual(10);
      expect(at[1]).toBeGreaterThanOrEqual(0);
      expect(at[1]).toBeLessThanOrEqual(4);
    }
  });
});
