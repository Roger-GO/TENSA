/**
 * Where a line of the diagram is clicked by something that clicks the
 * middle of it without looking: a screen reader's "activate", voice or
 * switch control, a test that clicks an element, an assistant that drives
 * the page by its accessibility tree. All of them click the middle of the
 * box of the element, and the box of a line that turns has its middle on
 * empty ground, while that of a straight line has no width at all and
 * counts as not shown.
 *
 * So each edge carries a box that is not drawn (`EdgePickBox`), centred on
 * a point of its own line (`pickPoint`) and large enough to hold the whole
 * of it (`pickBox`): the box of the edge is then that box, and a click on
 * its middle is a click on the line.
 *
 * Pure: no React, nothing read but the arguments.
 */
import { routeMidpoint, type Point } from '../connections';

/**
 * How far from an end on a bar the point keeps: the box of a bus node
 * hangs this far under its bar, and a click there is a click on the bus.
 */
export const PICK_OFF_BAR = 26;

/**
 * The same under a bar while the values of a power flow show: the box of
 * the bus node is taller by the voltage and the angle its label then holds.
 */
export const PICK_OFF_BAR_WITH_VALUES = 48;

/** How far the point keeps from what is drawn on the line and takes its own clicks (the symbol of a transformer). */
export const PICK_OFF_SYMBOL = 20;

/** Half the least width and height of the box: a straight line has a box to click. */
export const PICK_MIN_HALF = 8;

export interface PickOptions {
  /** Whether the first point is on the bar of a bus (a line or a transformer), and not on a device. */
  fromBar: boolean;
  /** A place on the line that takes its own clicks, which the point keeps off. */
  avoid?: { x: number; y: number };
  /** Whether the values of a power flow show, and the box under each bar is the taller one. */
  values?: boolean;
}

/**
 * The point of the route `points` a click on the middle of its edge lands
 * on: the middle of the longest stretch of one run that is clear of the
 * boxes of its two ends and of `options.avoid`. Half way along the route
 * where no run has such a stretch.
 */
export function pickPoint(points: readonly Point[], options: PickOptions): Point {
  const last = points.length - 1;
  let best: { at: Point; length: number } | null = null;
  for (let k = 0; k < last; k += 1) {
    const [a, b] = [points[k]!, points[k + 1]!];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 1e-6) continue;
    // How far the point keeps from an end on a bar: further where the run
    // hangs under the bar and the box of the bus is the taller one.
    const offBar = (end: Point, other: Point): number =>
      options.values === true && other[1] > end[1] + 1e-6 ? PICK_OFF_BAR_WITH_VALUES : PICK_OFF_BAR;
    const from = k === 0 && options.fromBar ? offBar(a, b) : 0;
    const to = length - (k === last - 1 ? offBar(b, a) : 0);
    // The stretches of the run that are clear, as lengths along it.
    let stretches: [number, number][] = [[from, to]];
    if (options.avoid !== undefined) {
      const along =
        ((options.avoid.x - a[0]) * (b[0] - a[0]) + (options.avoid.y - a[1]) * (b[1] - a[1])) /
        length;
      const off = Math.hypot(
        a[0] + ((b[0] - a[0]) * along) / length - options.avoid.x,
        a[1] + ((b[1] - a[1]) * along) / length - options.avoid.y,
      );
      if (off < PICK_OFF_SYMBOL) {
        stretches = [
          [from, Math.min(to, along - PICK_OFF_SYMBOL)],
          [Math.max(from, along + PICK_OFF_SYMBOL), to],
        ];
      }
    }
    for (const [lo, hi] of stretches) {
      if (hi - lo <= 0 || (best !== null && hi - lo <= best.length)) continue;
      const t = (lo + hi) / 2 / length;
      best = { at: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], length: hi - lo };
    }
  }
  if (best !== null) return best.at;
  const middle = routeMidpoint(points);
  return [middle.x, middle.y];
}

/**
 * The box centred on `at` that holds every point of `points`, and is
 * `PICK_MIN_HALF` to each side of `at` at the least.
 */
export function pickBox(
  points: readonly Point[],
  at: Point,
): { x: number; y: number; width: number; height: number } {
  let [halfWidth, halfHeight] = [PICK_MIN_HALF, PICK_MIN_HALF];
  for (const [x, y] of points) {
    halfWidth = Math.max(halfWidth, Math.abs(x - at[0]));
    halfHeight = Math.max(halfHeight, Math.abs(y - at[1]));
  }
  return {
    x: at[0] - halfWidth,
    y: at[1] - halfHeight,
    width: 2 * halfWidth,
    height: 2 * halfHeight,
  };
}
