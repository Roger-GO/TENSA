/**
 * Whether anything on the diagram is drawn over anything else.
 *
 * `findOverlaps` reads the diagram as it is drawn (every line as the points
 * it runs through, every bar, and every box: a symbol, a block, a label or
 * a readout) and answers each place where two of them are on top of each
 * other. A diagram that keeps the rule answers none:
 *
 * - Two different lines share no stretch. They do not lie on top of each
 *   other, and where they run side by side they keep `LINE_GAP` between
 *   them. One does not end or turn on another either, which would read as a
 *   junction, nor right beside it: a bend, and an end that is on no bar,
 *   keeps `BEND_CLEAR` from every other line, so that its corner is not
 *   drawn onto that line. Two lines that cross, each in the middle of a
 *   run and clear of the bends of both, are a crossing and not an overlap.
 * - Every end of a line on a bar has a place of its own there: on the bar,
 *   and `TAP_SPACING` from every other end on that bar, whichever face each
 *   comes to. Two that came to one place from above and from below would
 *   read as one line running through the bus. No line passes over the dot
 *   that marks the end of another either (`TAP_CLEAR` from its middle),
 *   where it would read as ending there.
 * - A line runs through no bar and along none: not one it has nothing to do
 *   with, not a second time through one of its own, and not up to the tip
 *   of one in line with it. A branch leaves its own bar by a face; only the
 *   connector of a device that stands beside its bar runs into the tip. The
 *   run that ends on a bar comes to it, at `MEET_ANGLE` or more, and does
 *   not lie along it on the way to its tap (`meetsBarFlat`); only into the
 *   tap at a tip, from beyond that tip, it may come flatter.
 * - A line runs through no box but the one it is drawn from (the device of
 *   a connector) and the ones that are drawn on it (its own label, the
 *   symbol of a transformer).
 * - No two boxes reach into each other, and none reaches into a bar.
 *
 * The canvas holds the routes it keeps to the first four (`routing.ts`),
 * and the tests hold every state of the example cases to all five.
 *
 * Pure: no React, no React Flow, nothing read but the arguments.
 */
import {
  BAR_CLEAR,
  BAR_THICKNESS,
  BEND_CLEAR,
  TAP_CLEAR,
  TAP_INSET,
  TAP_SPACING,
  distanceToRun,
  lengthInside,
  meetsBarFlat,
  type Point,
  type Rect,
} from './connections';

export { lengthInside };

/** The least room two lines keep between them where they run side by side. */
export const LINE_GAP = 12;

/** A line as it is drawn. */
export interface DrawnLine {
  id: string;
  /** The points it runs through, in order. */
  points: readonly Point[];
  /** What it is drawn from and to: the id of a bar, or of the box of a device. */
  from: string;
  to: string;
}

/** The bar of a bus as it is drawn: its two tips and the height of its centre line. */
export interface DrawnBar {
  id: string;
  left: number;
  right: number;
  y: number;
}

/** What a box is: the symbol of a device, a block (a control chain drawn out), a label or a readout. */
export type BoxKind = 'symbol' | 'block' | 'label' | 'readout';

export interface DrawnBox {
  id: string;
  kind: BoxKind;
  box: Rect;
  /**
   * What it is drawn on or against, by id, and so may touch: the line a
   * label stands on, the bar a label hangs under, the symbol a block is
   * drawn out of.
   */
  of?: readonly string[];
}

export interface DrawnDiagram {
  lines: readonly DrawnLine[];
  bars: readonly DrawnBar[];
  boxes: readonly DrawnBox[];
}

export type OverlapKind =
  | 'line-line'
  | 'shared-tap'
  | 'line-tap'
  | 'loose-end'
  | 'line-bar'
  | 'line-box'
  | 'box-box';

/** One place where two things are drawn on each other. */
export interface Overlap {
  kind: OverlapKind;
  /**
   * The two things, by id: for a `loose-end` the line and the bar it should
   * end on, for a `line-tap` the line that passes and the line whose end it
   * passes over.
   */
  a: string;
  b: string;
  /**
   * What is wrong, in words. Of two lines, `the first` and `the second`
   * are `a` and `b`: `the first turns 2.0 px from the other`.
   */
  detail: string;
}

export interface OverlapOptions {
  /** The room two lines side by side keep; default `LINE_GAP`. */
  gap?: number;
  /** The room two ends on one bar keep; default `TAP_SPACING`. */
  tapSpacing?: number;
  /**
   * How far two boxes may reach into each other, and a line into a box,
   * and still count as apart: half a pixel for a diagram that is worked
   * out, a pixel or two for one read off the screen, where the browser
   * lays text out on whole pixels. Default 0.5.
   */
  slack?: number;
}

/** Two directions closer than this (the sine of the angle between them) are one direction. */
const PARALLEL = 0.035;

/** Two runs that are side by side for less than this do not share a stretch. */
const SHARED = 1;

/** A point nearer than this to a run is on it. */
const TOUCH = 1;

/**
 * A level run within `TIP_BAND` of the height of a bar, that comes nearer
 * than `TIP_CLEAR` to one of its tips, reads as a line that leaves the bar
 * by that tip.
 */
const TIP_BAND = BAR_THICKNESS / 2 + 4;
const TIP_CLEAR = 16;

/** The side of the squares everything is sorted into, to find what is near what. */
const CELL = 128;

interface Run {
  line: number;
  a: Point;
  b: Point;
  /** Whether it is the first run of its line, and the last. */
  first: boolean;
  last: boolean;
  /**
   * The places where its line turns or ends loose, of its two end points:
   * the bend it ends in, and an end of the line that is on no bar. Each
   * such place of a line is with one run of it.
   */
  turns: { at: Point; end: boolean }[];
}

/**
 * How a turn of the line of `s` is right beside the run `t` of another
 * line (nearer than `BEND_CLEAR`), in words that begin with `whose`;
 * `null` when every turn of `s` is clear of it.
 */
function turnsBeside(s: Run, t: Run, whose: string): string | null {
  for (const { at, end } of s.turns) {
    const off = distanceToRun(at, t.a, t.b);
    if (off < BEND_CLEAR - 0.5) {
      return `${whose} ${end ? 'ends' : 'turns'} ${off.toFixed(1)} px from the other`;
    }
  }
  return null;
}

/** How two runs of different lines are on each other, in words; `null` when they are apart or cross. */
function runsMeet(s: Run, t: Run, gap: number): string | null {
  const [ux, uy] = [s.b[0] - s.a[0], s.b[1] - s.a[1]];
  const [vx, vy] = [t.b[0] - t.a[0], t.b[1] - t.a[1]];
  const lu = Math.hypot(ux, uy);
  const lv = Math.hypot(vx, vy);
  if (lu < 1e-6 || lv < 1e-6) return null;
  const cross = ux * vy - uy * vx;
  if (Math.abs(cross) <= PARALLEL * lu * lv) {
    // Side by side: how far along `s` each end of `t` is, and how far off it.
    const along = (p: Point): number => ((p[0] - s.a[0]) * ux + (p[1] - s.a[1]) * uy) / lu;
    const off = (p: Point): number => ((p[0] - s.a[0]) * uy - (p[1] - s.a[1]) * ux) / lu;
    const [tp, tq] = [along(t.a), along(t.b)];
    const lo = Math.max(0, Math.min(tp, tq));
    const hi = Math.min(lu, Math.max(tp, tq));
    if (hi - lo <= SHARED) return null;
    // How far apart they are half way along the stretch they share.
    const part = Math.abs(tq - tp) < 1e-9 ? 0 : ((lo + hi) / 2 - tp) / (tq - tp);
    const apart = Math.abs(off(t.a) + part * (off(t.b) - off(t.a)));
    if (apart >= gap - 0.5) return null;
    const shared = Math.round(hi - lo);
    return apart < TOUCH
      ? `lie on each other for ${shared} px`
      : `run ${apart.toFixed(1)} px apart for ${shared} px`;
  }
  // At an angle: where the two meet, as a length along each.
  const [wx, wy] = [t.a[0] - s.a[0], t.a[1] - s.a[1]];
  const onS = ((wx * vy - wy * vx) / cross) * lu;
  const onT = ((wx * uy - wy * ux) / cross) * lv;
  if (onS < -TOUCH || onS > lu + TOUCH || onT < -TOUCH || onT > lv + TOUCH) return null;
  const insideS = onS > TOUCH && onS < lu - TOUCH;
  const insideT = onT > TOUCH && onT < lv - TOUCH;
  // Each in the middle of a run: a crossing.
  if (insideS && insideT) return null;
  return 'one ends or turns on the other';
}

/** What is near what: things kept by the squares their boxes reach into. */
class Near<T> {
  private readonly cells = new Map<number, T[]>();

  private static keys(box: Rect): number[] {
    const keys: number[] = [];
    const [c0, c1] = [Math.floor(box.left / CELL), Math.floor(box.right / CELL)];
    const [r0, r1] = [Math.floor(box.top / CELL), Math.floor(box.bottom / CELL)];
    for (let c = c0; c <= c1; c += 1) {
      for (let r = r0; r <= r1; r += 1) keys.push(c * 65_536 + r);
    }
    return keys;
  }

  add(item: T, box: Rect): void {
    for (const key of Near.keys(box)) {
      const list = this.cells.get(key);
      if (list) list.push(item);
      else this.cells.set(key, [item]);
    }
  }

  /** Everything whose box reaches into a square that `box` reaches into, each once. */
  around(box: Rect): Set<T> {
    const found = new Set<T>();
    for (const key of Near.keys(box)) {
      for (const item of this.cells.get(key) ?? []) found.add(item);
    }
    return found;
  }
}

function boxOfRun(run: Run, by: number): Rect {
  return {
    left: Math.min(run.a[0], run.b[0]) - by,
    right: Math.max(run.a[0], run.b[0]) + by,
    top: Math.min(run.a[1], run.b[1]) - by,
    bottom: Math.max(run.a[1], run.b[1]) + by,
  };
}

/**
 * Every place on `drawn` where two things are on each other, in a fixed
 * order (by kind, then by the two ids); empty for a diagram that keeps the
 * rule. Two things that are on each other in several places are answered
 * once.
 */
export function findOverlaps(drawn: DrawnDiagram, options: OverlapOptions = {}): Overlap[] {
  const gap = options.gap ?? LINE_GAP;
  const tapSpacing = options.tapSpacing ?? TAP_SPACING;
  const slack = options.slack ?? 0.5;
  const found = new Map<string, Overlap>();
  const report = (kind: OverlapKind, a: string, b: string, detail: string): void => {
    const key = `${kind}|${a}|${b}`;
    if (!found.has(key)) found.set(key, { kind, a, b, detail });
  };

  const bars = new Map(drawn.bars.map((bar) => [bar.id, bar]));
  const runs: Run[] = [];
  const runsNear = new Near<Run>();
  drawn.lines.forEach((line, index) => {
    const points = line.points;
    for (let i = 1; i < points.length; i += 1) {
      const [first, last] = [i === 1, i === points.length - 1];
      const turns: Run['turns'] = [];
      if (first && !bars.has(line.from)) turns.push({ at: points[0]!, end: true });
      if (!last) turns.push({ at: points[i]!, end: false });
      else if (!bars.has(line.to)) turns.push({ at: points[i]!, end: true });
      const run: Run = { line: index, a: points[i - 1]!, b: points[i]!, first, last, turns };
      runs.push(run);
      runsNear.add(run, boxOfRun(run, gap));
    }
  });

  // ---- lines on lines ----
  for (const run of runs) {
    for (const other of runsNear.around(boxOfRun(run, 0))) {
      if (other.line <= run.line) continue;
      // On each other, or one right beside where the other turns or ends.
      const how =
        runsMeet(run, other, gap) ??
        turnsBeside(run, other, 'the first') ??
        turnsBeside(other, run, 'the second');
      if (how !== null) {
        report('line-line', drawn.lines[run.line]!.id, drawn.lines[other.line]!.id, how);
      }
    }
  }

  // ---- the ends on each bar ----
  const ends = new Map<string, { x: number; line: string }[]>();
  const lineIndex = new Map(drawn.lines.map((line, index) => [line.id, index]));
  for (const line of drawn.lines) {
    const land = (barId: string, at: Point | undefined): void => {
      const bar = bars.get(barId);
      if (bar === undefined || at === undefined) return;
      const onBar =
        Math.abs(at[1] - bar.y) <= BAR_THICKNESS / 2 + slack &&
        at[0] >= bar.left - slack &&
        at[0] <= bar.right + slack;
      if (!onBar) {
        report('loose-end', line.id, barId, `ends at ${at[0]}, ${at[1]}, off the bar`);
        return;
      }
      const list = ends.get(barId);
      if (list) list.push({ x: at[0], line: line.id });
      else ends.set(barId, [{ x: at[0], line: line.id }]);
    };
    land(line.from, line.points[0]);
    land(line.to, line.points[line.points.length - 1]);
  }
  for (const [barId, list] of ends) {
    list.sort((p, q) => p.x - q.x || (p.line < q.line ? -1 : 1));
    for (let i = 1; i < list.length; i += 1) {
      const apart = list[i]!.x - list[i - 1]!.x;
      if (apart >= tapSpacing - 0.5) continue;
      report(
        'shared-tap',
        list[i - 1]!.line,
        list[i]!.line,
        apart < TOUCH
          ? `end at one place on the bar of ${barId}`
          : `end ${apart.toFixed(1)} px apart on the bar of ${barId}`,
      );
    }
    // ---- lines over the dot of another line's end ----
    // A run that passes a bar is held to the bar itself, below. The run a
    // line ends on its own bar with is not, and at an angle it can pass
    // over the dot of the end beside its own.
    const y = bars.get(barId)!.y;
    for (const end of list) {
      const dot: Rect = {
        left: end.x - TAP_CLEAR,
        right: end.x + TAP_CLEAR,
        top: y - TAP_CLEAR,
        bottom: y + TAP_CLEAR,
      };
      for (const run of runsNear.around(dot)) {
        if (run.line === lineIndex.get(end.line)) continue;
        const { id: passing, from, to } = drawn.lines[run.line]!;
        if (!((from === barId && run.first) || (to === barId && run.last))) continue;
        // Two ends too close on one bar are that, and not this as well.
        if (list.some((o) => o.line === passing && Math.abs(o.x - end.x) < tapSpacing - 0.5)) {
          continue;
        }
        const [ux, uy] = [run.b[0] - run.a[0], run.b[1] - run.a[1]];
        const length = ux * ux + uy * uy;
        if (length < 1e-9) continue;
        const t = Math.min(
          1,
          Math.max(0, ((end.x - run.a[0]) * ux + (y - run.a[1]) * uy) / length),
        );
        const off = Math.hypot(run.a[0] + t * ux - end.x, run.a[1] + t * uy - y);
        if (off >= TAP_CLEAR - 0.5) continue;
        report(
          'line-tap',
          passing,
          end.line,
          `passes ${off.toFixed(1)} px from the end of the other on the bar of ${barId}`,
        );
      }
    }
  }

  // ---- lines on bars ----
  for (const bar of drawn.bars) {
    const body: Rect = {
      left: bar.left - BAR_CLEAR,
      right: bar.right + BAR_CLEAR,
      top: bar.y - BAR_THICKNESS / 2 - BAR_CLEAR,
      bottom: bar.y + BAR_THICKNESS / 2 + BAR_CLEAR,
    };
    const reach: Rect = { ...body, left: bar.left - TIP_CLEAR, right: bar.right + TIP_CLEAR };
    for (const run of runsNear.around(reach)) {
      const line = drawn.lines[run.line]!;
      const lands = (line.from === bar.id && run.first) || (line.to === bar.id && run.last);
      const level = Math.abs(run.a[1] - run.b[1]) <= TOUCH;
      if (lands) {
        if (!level) {
          // At an angle: it comes to its bar, and does not lie along it.
          const [tap, outer] = line.to === bar.id && run.last ? [run.b, run.a] : [run.a, run.b];
          if (meetsBarFlat(outer, tap, bar)) {
            report('line-bar', line.id, bar.id, 'comes to its own bar too flat, and runs along it');
          }
          continue;
        }
        // In line with its own bar. A branch never is; the connector of a
        // device beside the bar runs into the tip, and no further.
        const branch = bars.has(line.from) && bars.has(line.to);
        const [tap, outer] = line.to === bar.id && run.last ? [run.b, run.a] : [run.a, run.b];
        const fromLeft = outer[0] < tap[0];
        const intoTip =
          (fromLeft ? outer[0] <= bar.left : outer[0] >= bar.right) &&
          Math.abs(tap[0] - (fromLeft ? bar.left : bar.right)) <= 2 * TAP_INSET + slack;
        if (branch) report('line-bar', line.id, bar.id, 'leaves its bar in line with it');
        else if (!intoTip) report('line-bar', line.id, bar.id, 'runs along its own bar');
        continue;
      }
      if (lengthInside(run.a, run.b, body) > 0) {
        report('line-bar', line.id, bar.id, 'runs through the bar or along it');
        continue;
      }
      const inLine =
        level &&
        Math.abs(run.a[1] - bar.y) < TIP_BAND &&
        Math.max(run.a[0], run.b[0]) > bar.left - TIP_CLEAR &&
        Math.min(run.a[0], run.b[0]) < bar.right + TIP_CLEAR;
      if (inLine)
        report('line-bar', line.id, bar.id, 'runs up to the tip of the bar, in line with it');
    }
  }

  // ---- lines on boxes, boxes on boxes, boxes on bars ----
  const boxesNear = new Near<DrawnBox>();
  for (const box of drawn.boxes) boxesNear.add(box, box.box);
  const inner = (rect: Rect): Rect => ({
    left: rect.left + slack,
    right: rect.right - slack,
    top: rect.top + slack,
    bottom: rect.bottom - slack,
  });
  for (const box of drawn.boxes) {
    const room = inner(box.box);
    for (const run of runsNear.around(box.box)) {
      const line = drawn.lines[run.line]!;
      if (line.from === box.id || line.to === box.id || box.of?.includes(line.id)) continue;
      if (lengthInside(run.a, run.b, room) > 0) {
        report('line-box', line.id, box.id, `runs through the ${box.kind}`);
      }
    }
    for (const other of boxesNear.around(box.box)) {
      if (other.id <= box.id || box.of?.includes(other.id) || other.of?.includes(box.id)) continue;
      const across =
        Math.min(box.box.right, other.box.right) - Math.max(box.box.left, other.box.left);
      const down =
        Math.min(box.box.bottom, other.box.bottom) - Math.max(box.box.top, other.box.top);
      if (across > slack && down > slack) {
        report(
          'box-box',
          box.id,
          other.id,
          `the ${box.kind} and the ${other.kind} overlap by ${Math.round(across)} x ${Math.round(down)} px`,
        );
      }
    }
  }
  for (const bar of drawn.bars) {
    const body: Rect = {
      left: bar.left,
      right: bar.right,
      top: bar.y - BAR_THICKNESS / 2,
      bottom: bar.y + BAR_THICKNESS / 2,
    };
    for (const box of boxesNear.around(body)) {
      if (box.of?.includes(bar.id)) continue;
      const across = Math.min(box.box.right, body.right) - Math.max(box.box.left, body.left);
      const down = Math.min(box.box.bottom, body.bottom) - Math.max(box.box.top, body.top);
      if (across > slack && down > slack) {
        report('box-box', box.id, bar.id, `the ${box.kind} is on the bar`);
      }
    }
  }

  const order: OverlapKind[] = [
    'line-line',
    'shared-tap',
    'line-tap',
    'loose-end',
    'line-bar',
    'line-box',
    'box-box',
  ];
  return [...found.values()].sort(
    (p, q) =>
      order.indexOf(p.kind) - order.indexOf(q.kind) ||
      (p.a < q.a ? -1 : p.a > q.a ? 1 : 0) ||
      (p.b < q.b ? -1 : p.b > q.b ? 1 : 0),
  );
}

/** `overlaps` as lines of text, one each: what a failing test prints. */
export function describeOverlaps(overlaps: readonly Overlap[]): string[] {
  return overlaps.map(({ kind, a, b, detail }) => `${kind}: ${a} / ${b}: ${detail}`);
}

/** How often two different lines of `lines` cross, each in the middle of a run. */
export function countCrossings(lines: readonly DrawnLine[]): number {
  const side = (u: Point, v: Point, w: Point): number =>
    (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]);
  let count = 0;
  for (let i = 0; i < lines.length; i += 1) {
    for (let k = i + 1; k < lines.length; k += 1) {
      const [p, q] = [lines[i]!.points, lines[k]!.points];
      for (let m = 1; m < p.length; m += 1) {
        for (let n = 1; n < q.length; n += 1) {
          const [a, b, c, d] = [p[m - 1]!, p[m]!, q[n - 1]!, q[n]!];
          if (side(c, d, a) * side(c, d, b) < 0 && side(a, b, c) * side(a, b, d) < 0) count += 1;
        }
      }
    }
  }
  return count;
}
