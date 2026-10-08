/**
 * The arrow of a flow on a figure: its shape, and where on its line it
 * stands.
 *
 * The canvas draws the arrow at the place the label of the line was given,
 * or half way along a line whose label has no place. On a figure that place
 * is where the arrow stands only while it is clear there: half way along is
 * where a line most often crosses another, and an arrow drawn on a crossing
 * reads as pointing into the other line, or as a junction of the two. So
 * the arrow is held to the rule everything else on the diagram keeps.
 * `placeArrow` takes the place asked for where the arrow is on nothing
 * there, and otherwise the nearest place along the route where it is: in
 * the middle of a run, off the bends and the bars, clear of every other
 * line and of everything that stands by its own. A line with no such place
 * is drawn without an arrow.
 *
 * Pure: nothing read but the arguments.
 */
import { distanceToRun, lengthInside, type Rect } from '../connections';

type At = readonly [number, number];

/** Half the width of the arrow of a flow at the most: it stays clear of what stands beside its line. */
export const ARROW_HALF_WIDTH = 3.5;
/**
 * The room an arrow keeps: to a label, a symbol or a bar that stands by its
 * line, to a bend of its line, to the end of its line on a bar, and to
 * another line.
 */
export const ARROW_OFF_BOX = 2;
export const ARROW_OFF_BEND = 2;
export const ARROW_OFF_BAR = 9;
export const ARROW_OFF_LINE = 6;

/** How far apart the places tried for an arrow are, along the route. */
const ARROW_STEP = 1;

/** Two lengths nearer than this are one length: what the arithmetic of a place leaves over. */
const EXACT = 1e-6;

/** Where an arrow stands: the middle of it, and the direction of the run there. */
export interface ArrowSpot {
  x: number;
  y: number;
  angleDeg: number;
}

/** What an arrow has to stay clear of. */
export interface ArrowSurroundings {
  /** The other lines, each as the points it runs through. */
  lines: readonly (readonly At[])[];
  /** Everything else that is drawn: the bars, the symbols, the labels. */
  boxes: readonly Rect[];
}

/**
 * The corners of an arrow `size` long at `spot`: the tip first, then the
 * two ends of its base. It points along the run where the power flows from
 * the first end of the line to the last (`forward`), and against it
 * otherwise, as the canvas turns it (`LineFlowArrow`).
 */
export function arrowCorners(
  spot: ArrowSpot,
  size: number,
  forward: boolean,
): [[number, number], [number, number], [number, number]] {
  const turn = ((spot.angleDeg + (forward ? 0 : 180)) * Math.PI) / 180;
  const [cos, sin] = [Math.cos(turn), Math.sin(turn)];
  const corner = (dx: number, dy: number): [number, number] => [
    spot.x + dx * cos - dy * sin,
    spot.y + dx * sin + dy * cos,
  ];
  const half = Math.min(size * 0.3, ARROW_HALF_WIDTH);
  return [corner(size / 2, 0), corner(-size / 2, -half), corner(-size / 2, half)];
}

/** The box round `corners`. */
function boxOf(corners: readonly At[]): Rect {
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}

const grown = (box: Rect, by: number): Rect => ({
  left: box.left - by,
  right: box.right + by,
  top: box.top - by,
  bottom: box.bottom + by,
});

/** Whether two boxes reach into each other; two that only touch do not. */
const meet = (a: Rect, b: Rect): boolean =>
  Math.min(a.right, b.right) - Math.max(a.left, b.left) > EXACT &&
  Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > EXACT;

/** Whether two boxes are nowhere near each other: what is left out before anything is measured. */
const apart = (a: Rect, b: Rect): boolean =>
  a.right < b.left || b.right < a.left || a.bottom < b.top || b.bottom < a.top;

/**
 * Where the arrow of a flow, `size` long, stands on the line that runs
 * through `points`: at `prefer`, a point of the route, or at the place
 * nearest to it along the route where the arrow is clear of everything
 * `around`. Of two places as near, the one the power flows towards is taken.
 *
 * `label` is the room the diagram keeps for the line's own label when that
 * stands on the line, at `prefer`. The arrow is then drawn on the same run
 * right past that room, at the end the power flows towards or at the other
 * one, and only where neither is clear at the nearest place there is: the
 * label as it is drawn is among the `boxes`, and is often shorter than its
 * room.
 *
 * `null` where the route has no place for it: every run ends too soon, or
 * something stands in the way all along.
 */
export function placeArrow(
  points: readonly At[],
  prefer: { x: number; y: number },
  size: number,
  forward: boolean,
  label: Rect | null,
  around: ArrowSurroundings,
): ArrowSpot | null {
  // The runs of the route, with how far along it each starts.
  interface Run {
    a: At;
    ux: number;
    uy: number;
    from: number;
    length: number;
  }
  const runs: Run[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const [a, b] = [points[i - 1]!, points[i]!];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length === 0) continue;
    runs.push({ a, ux: (b[0] - a[0]) / length, uy: (b[1] - a[1]) / length, from: total, length });
    total += length;
  }
  if (runs.length === 0) return null;

  // The run the place asked for is on, and how far along the route it is.
  let home = runs[0]!;
  let anchor = 0;
  let nearest = Infinity;
  for (const run of runs) {
    const end: At = [run.a[0] + run.length * run.ux, run.a[1] + run.length * run.uy];
    const off = distanceToRun([prefer.x, prefer.y], run.a, end);
    if (off >= nearest) continue;
    nearest = off;
    home = run;
    const along = (prefer.x - run.a[0]) * run.ux + (prefer.y - run.a[1]) * run.uy;
    anchor = run.from + Math.min(run.length, Math.max(0, along));
  }

  // What is near enough to the route to matter to an arrow anywhere on it.
  const far = size + ARROW_OFF_LINE;
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const near: Rect = {
    left: Math.min(...xs) - far,
    right: Math.max(...xs) + far,
    top: Math.min(...ys) - far,
    bottom: Math.max(...ys) + far,
  };
  const others: [At, At][] = [];
  for (const line of around.lines) {
    for (let i = 1; i < line.length; i += 1) {
      const [p, q] = [line[i - 1]!, line[i]!];
      if (!apart(near, boxOf([p, q]))) others.push([p, q]);
    }
  }
  const boxes = around.boxes.filter((box) => !apart(near, box));

  /**
   * The arrow with its middle `along` the route, where it is clear of
   * everything there; on the run `on` alone, when one is given.
   */
  const clearAt = (along: number, on?: Run): ArrowSpot | null => {
    if (along < 0 || along > total) return null;
    const run = on ?? runs.find((r) => along <= r.from + r.length) ?? runs[runs.length - 1]!;
    const local = along - run.from;
    // A run that ends on a bar ends under the dot of its tap; one that ends in a bend, at the bend.
    const clearOfStart = run === runs[0] ? ARROW_OFF_BAR : ARROW_OFF_BEND;
    const clearOfEnd = run === runs[runs.length - 1] ? ARROW_OFF_BAR : ARROW_OFF_BEND;
    if (local - size / 2 < clearOfStart - EXACT) return null;
    if (local + size / 2 > run.length - clearOfEnd + EXACT) return null;
    const spot: ArrowSpot = {
      x: run.a[0] + local * run.ux,
      y: run.a[1] + local * run.uy,
      angleDeg: (Math.atan2(run.uy, run.ux) * 180) / Math.PI,
    };
    const corners = arrowCorners(spot, size, forward);
    const box = boxOf(corners);
    const room = grown(box, ARROW_OFF_BOX);
    if (boxes.some((other) => meet(room, other))) return null;
    // Its corners, its middle and the middle of its base: no point of the
    // arrow is as far as `ARROW_OFF_LINE` from all of them, so a line that
    // keeps that far from each of them is clear of the whole arrow.
    const [, left, right] = corners;
    const samples: At[] = [
      ...corners,
      [spot.x, spot.y],
      [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2],
    ];
    const reachOfLine = grown(box, ARROW_OFF_LINE);
    for (const [p, q] of others) {
      if (apart(reachOfLine, boxOf([p, q]))) continue;
      if (lengthInside(p, q, box) > 0) return null;
      if (samples.some((sample) => distanceToRun(sample, p, q) < ARROW_OFF_LINE)) return null;
    }
    return spot;
  };

  const ways = forward ? [1, -1] : [-1, 1];
  if (label !== null) {
    // How far the room of the label reaches along its run, either way.
    const reach =
      (Math.abs(home.ux) * (label.right - label.left) +
        Math.abs(home.uy) * (label.bottom - label.top)) /
      2;
    for (const way of ways) {
      const spot = clearAt(anchor + way * (reach + size / 2 + ARROW_OFF_BOX), home);
      if (spot !== null) return spot;
    }
  }
  // From the place asked for outwards, a step at a time.
  for (let d = 0; anchor - d >= 0 || anchor + d <= total; d += ARROW_STEP) {
    for (const way of d === 0 ? [1] : ways) {
      const spot = clearAt(anchor + way * d);
      if (spot !== null) return spot;
    }
  }
  return null;
}
