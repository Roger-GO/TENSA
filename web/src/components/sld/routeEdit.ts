/**
 * Moving a line of the diagram by hand: the geometry of it.
 *
 * A route is the points a line is drawn through, from one end to the other.
 * Its two ends are attached (`RouteEnds`): the end of a branch is a tap on
 * the bar of its bus, which may slide along that bar and no further, and
 * the first point of a device connector is the middle of a face of its
 * device, which stays where it is. Everything between the ends is the
 * user's to move:
 *
 * - `slideRun` moves one run sideways. A level run goes up or down and an
 *   upright one left or right, and the runs it meets stay square: the one
 *   beside it gets longer or shorter. Where a run cannot give (the run ends
 *   on a device, or on a bend that was put into a straight run), a square
 *   step is put in, so the end stays attached and the part that was
 *   grabbed still moves. An upright run that ends on a bar takes its tap
 *   along the bar. A run at an angle moves as it is.
 * - `moveBend` moves one bend. The two runs that meet there stay level or
 *   upright where they were, which moves the bends at their other ends
 *   along (`free` moves the bend alone, and leaves its runs at an angle).
 * - `pullBend` puts a new bend into a run and takes it where it is pulled,
 *   which leaves the run at an angle either side of it.
 * - `splitRun` puts a bend into a run where it is, in line with it. Nothing
 *   moves; either half can then be slid on its own, which makes a step.
 * - `removeBend` takes a bend out: the line runs straight between the two
 *   bends beside it.
 *
 * None of them looks at what else is on the diagram: `routeCheck.ts` says
 * whether a route they answer is clear of it. What they answer may hold
 * points that repeat or lie on a straight run (a step of no height, a bend
 * that was put in and not moved); `tidyPoints` takes those out, which is
 * the form a route is kept in.
 *
 * A move leaves no step too short to be read as one (`leavesKink`,
 * `MIN_STEP`): `settleEdit`, which is what a drag asks at every move, takes
 * the part to the nearest place that leaves none, and leaves the line as it
 * is for a move too small to make a step of.
 *
 * Pure: no React, no React Flow, nothing read but the arguments.
 */
import {
  BAR_LENGTH,
  BAR_THICKNESS,
  TAP_INSET,
  runKind,
  simplifyRoute,
  type BarGeometry,
  type ConnectionEdge,
  type Point,
  type RunKind,
} from './connections';

/** What one end of a route is attached to. */
export type RouteEnd =
  /** A tap on the bar of a bus at the height `y`: it may stand anywhere from `lo` to `hi` along it. */
  | { kind: 'bar'; y: number; lo: number; hi: number }
  /** The middle of a face of a device, or the tip of a bar: it stays where it is. */
  | { kind: 'fixed' };

export interface RouteEnds {
  source: RouteEnd;
  target: RouteEnd;
}

/**
 * What the two ends of the route of `edge` are attached to, on a diagram
 * whose nodes stand at `at` and whose bars are `bars`: `points` is the
 * route as it is drawn. An end of a branch is a tap on the bar of its bus,
 * anywhere between the middles of the two rounded tips of the bar as it is
 * drawn. The connector of a device leaves the device where it does, and
 * lands on the bar the same way unless it runs level into a tip of it.
 */
export function routeEndsOf(
  edge: ConnectionEdge,
  points: readonly Point[],
  at: ReadonlyMap<string, { x: number; y: number }>,
  bars: ReadonlyMap<string, BarGeometry>,
): RouteEnds {
  const onBar = (bus: string): RouteEnd => {
    const origin = at.get(bus);
    if (origin === undefined) return { kind: 'fixed' };
    const bar = bars.get(bus);
    return {
      kind: 'bar',
      y: origin.y + BAR_THICKNESS / 2,
      lo: origin.x + (bar?.start ?? 0) + TAP_INSET,
      hi: origin.x + (bar?.end ?? BAR_LENGTH) - TAP_INSET,
    };
  };
  if (edge.type !== 'stub') return { source: onBar(edge.source), target: onBar(edge.target) };
  const last = points[points.length - 1];
  const before = points[points.length - 2];
  const intoTip = last !== undefined && before !== undefined && runKind(before, last) === 'level';
  return { source: { kind: 'fixed' }, target: intoTip ? { kind: 'fixed' } : onBar(edge.target) };
}

/**
 * The shortest run a move leaves in a route: shorter, a step reads as a
 * kink in the line (`MIN_RUN` of the router).
 */
export const MIN_STEP = 12;

/** How far out of a fixed end a run goes before it steps aside, where it is long enough. */
export const NECK = MIN_STEP;

/** Two coordinates closer than this are the same place (as in `connections.ts`). */
const EPS = 0.5;

/** What an edit answers. */
export interface EditedRoute {
  /** The route after the edit; not yet tidied (`tidyPoints`). */
  points: Point[];
  /**
   * What was moved, as an index into `points`: the first point of the run
   * for `slideRun`, the bend for `moveBend` and `pullBend`.
   */
  picked: number;
  /**
   * How far it went, which is less than was asked for where an end reached
   * the tip of its bar (`stopped`).
   */
  by: [number, number];
  /** Set where the tap of an upright run was at the tip of its bar and went no further. */
  stopped?: true;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * How far along x an upright run that ends at `end`, attached as `to`, may
 * be moved: the tap stays on its bar.
 */
function reachAlong(end: Point, to: RouteEnd, dx: number): number {
  if (to.kind !== 'bar') return dx;
  return clamp(end[0] + dx, Math.min(to.lo, end[0]), Math.max(to.hi, end[0])) - end[0];
}

/**
 * What takes the place of `p`, an end point of a run that is moved by
 * `shift`, in order from the outside of the run towards it. `other` is the
 * run's other end point, `beyond` the point of the route past `p` (absent
 * when `p` is an end of the route, which is attached as `end`), and `kind`
 * what the run is.
 */
function movedEnd(
  p: Point,
  other: Point,
  beyond: Point | undefined,
  end: RouteEnd | null,
  shift: readonly [number, number],
  kind: RunKind,
): Point[] {
  const to: Point = [p[0] + shift[0], p[1] + shift[1]];
  if (beyond === undefined) {
    // An end of the route. A tap goes along its bar with an upright run,
    // and with one at an angle as far as the bar lets it.
    if (end?.kind === 'bar' && kind === 'upright') return [[to[0], p[1]]];
    if (end?.kind === 'bar' && kind === 'angled') {
      return [[p[0] + reachAlong(p, end, shift[0]), p[1]]];
    }
    if (kind === 'angled') return [p];
    // It stays, and the run steps aside a little way out of it.
    const length = Math.hypot(other[0] - p[0], other[1] - p[1]);
    if (length < 1e-6) return [p];
    const reach = Math.min(NECK, length / 2);
    const out: Point = [
      p[0] + ((other[0] - p[0]) / length) * reach,
      p[1] + ((other[1] - p[1]) / length) * reach,
    ];
    return [p, out, [out[0] + shift[0], out[1] + shift[1]]];
  }
  // In line with the run (a bend that was put into a straight run): the
  // run past it stays, and a square step joins the two.
  if (kind !== 'angled' && runKind(beyond, p) === kind) return [p, to];
  return [to];
}

/** The shift of a run of `kind` for a move of the pointer by `by`. */
function shiftOf(kind: RunKind, by: readonly [number, number]): [number, number] {
  if (kind === 'level') return [0, by[1]];
  if (kind === 'upright') return [by[0], 0];
  return [by[0], by[1]];
}

/**
 * Move the run of `points` that starts at the point `run` by `by`: a level
 * run by its `y`, an upright one by its `x`, one at an angle by both.
 */
export function slideRun(
  points: readonly Point[],
  run: number,
  by: readonly [number, number],
  ends: RouteEnds,
): EditedRoute {
  const last = points.length - 1;
  const a = points[run];
  const b = points[run + 1];
  if (a === undefined || b === undefined) {
    return { points: points.map(([x, y]): Point => [x, y]), picked: run, by: [0, 0] };
  }
  const kind = runKind(a, b);
  const shift = shiftOf(kind, by);
  const asked = shift[0];
  if (kind === 'upright') {
    // The taps it ends on stay on their bars.
    if (run === 0) shift[0] = reachAlong(a, ends.source, shift[0]);
    if (run + 1 === last) shift[0] = reachAlong(b, ends.target, shift[0]);
  }
  const head = movedEnd(a, b, points[run - 1], run === 0 ? ends.source : null, shift, kind);
  const tail = movedEnd(b, a, points[run + 2], run + 1 === last ? ends.target : null, shift, kind);
  return {
    points: [...points.slice(0, run), ...head, ...tail.reverse(), ...points.slice(run + 2)],
    picked: run + head.length - 1,
    by: shift,
    ...(Math.abs(shift[0] - asked) > EPS ? { stopped: true as const } : {}),
  };
}

/**
 * Move the bend at the point `bend` of `points` by `by`. The run either
 * side of it stays level or upright where it was, so the bend at its other
 * end goes along; with `free` the bend moves alone.
 */
export function moveBend(
  points: readonly Point[],
  bend: number,
  by: readonly [number, number],
  ends: RouteEnds,
  free = false,
): EditedRoute {
  const last = points.length - 1;
  const p = points[bend];
  const before = points[bend - 1];
  const after = points[bend + 1];
  if (p === undefined || before === undefined || after === undefined) {
    return { points: points.map(([x, y]): Point => [x, y]), picked: bend, by: [0, 0] };
  }
  const shift: [number, number] = [by[0], by[1]];
  const kinds = { before: runKind(before, p), after: runKind(p, after) };
  if (free) {
    const moved = points.map(([x, y]): Point => [x, y]);
    moved[bend] = [p[0] + shift[0], p[1] + shift[1]];
    return { points: moved, picked: bend, by: shift };
  }
  // An upright run that ends on a bar keeps its tap on the bar.
  const asked = shift[0];
  if (kinds.before === 'upright' && bend - 1 === 0) {
    shift[0] = reachAlong(before, ends.source, shift[0]);
  }
  if (kinds.after === 'upright' && bend + 1 === last) {
    shift[0] = reachAlong(after, ends.target, shift[0]);
  }
  const follow = (
    far: Point,
    beyond: Point | undefined,
    end: RouteEnd | null,
    kind: RunKind,
  ): Point[] =>
    kind === 'angled' ? [far] : movedEnd(far, p, beyond, end, shiftOf(kind, shift), kind);
  const head = follow(before, points[bend - 2], bend - 1 === 0 ? ends.source : null, kinds.before);
  const tail = follow(after, points[bend + 2], bend + 1 === last ? ends.target : null, kinds.after);
  return {
    points: [
      ...points.slice(0, bend - 1),
      ...head,
      [p[0] + shift[0], p[1] + shift[1]],
      ...tail.reverse(),
      ...points.slice(bend + 2),
    ],
    picked: bend - 1 + head.length,
    by: shift,
    ...(Math.abs(shift[0] - asked) > EPS ? { stopped: true as const } : {}),
  };
}

/** Put a bend into the run of `points` that starts at the point `run`, at `at`. */
export function pullBend(points: readonly Point[], run: number, at: Point): EditedRoute {
  return {
    points: [...points.slice(0, run + 1), [at[0], at[1]], ...points.slice(run + 1)],
    picked: run + 1,
    by: [0, 0],
  };
}

/** The point of the run from `a` to `b` nearest to `p`. */
export function nearestOnRun(a: Point, b: Point, p: Point): Point {
  const [ux, uy] = [b[0] - a[0], b[1] - a[1]];
  const length = ux * ux + uy * uy;
  if (length < 1e-9) return [a[0], a[1]];
  const t = clamp(((p[0] - a[0]) * ux + (p[1] - a[1]) * uy) / length, 0, 1);
  return [a[0] + t * ux, a[1] + t * uy];
}

/** The least a bend that is put into a run keeps from the bends at its two ends. */
export const SPLIT_ROOM = 6;

/**
 * Put a bend into the run of `points` that starts at the point `run`, in
 * line with it, at the place nearest to `at`. `null` where that is right at
 * one of its ends: the bend is there already.
 */
export function splitRun(points: readonly Point[], run: number, at: Point): EditedRoute | null {
  const a = points[run];
  const b = points[run + 1];
  if (a === undefined || b === undefined) return null;
  const on = nearestOnRun(a, b, at);
  const near = (q: Point): boolean => Math.hypot(on[0] - q[0], on[1] - q[1]) < SPLIT_ROOM;
  if (near(a) || near(b)) return null;
  return pullBend(points, run, on);
}

/** Take the bend at the point `bend` out of `points`; `null` for an end, which is no bend. */
export function removeBend(points: readonly Point[], bend: number): Point[] | null {
  if (bend <= 0 || bend >= points.length - 1) return null;
  return [...points.slice(0, bend), ...points.slice(bend + 1)].map(([x, y]): Point => [x, y]);
}

/**
 * `points` as a route is kept: without the points that repeat the one
 * before, and without the ones on a straight level or upright run.
 */
export function tidyPoints(points: readonly Point[]): Point[] {
  return simplifyRoute(points.map(([x, y]): Point => [x, y]));
}

/**
 * Whether the route `points`, which a move made of `base`, has a step too
 * short to be read as one that `base` did not have: more runs under
 * `MIN_STEP` than it had, or one shorter than its shortest were. A run the
 * diagram itself made that short (the jog a tap asks for) is not held
 * against a move that leaves it alone or makes it longer.
 */
export function leavesKink(base: readonly Point[], points: readonly Point[]): boolean {
  const short = (route: readonly Point[]): number[] =>
    route
      .slice(1)
      .map((b, k) => Math.hypot(b[0] - route[k]![0], b[1] - route[k]![1]))
      .filter((length) => length < MIN_STEP - EPS)
      .sort((p, q) => p - q);
  const now = short(points);
  if (now.length === 0) return false;
  const was = short(tidyPoints(base));
  return now.length > was.length || now.some((length, k) => length < was[k]! - EPS);
}

/** What a move that would leave such a step is refused for. */
export const KINK_REASON = `it would leave a step of under ${MIN_STEP} px, too short to read as one`;

/** The same, where the step is that short because the end of the line is at the tip of its bar. */
export const TIP_REASON = `its end is at the tip of the bar of its bus, which leaves room only for a step of under ${MIN_STEP} px`;

/**
 * What the route `points`, which the move `edited` made of `base`, is
 * refused for by the step it leaves; `null` where it leaves none too short.
 */
export function kinkReason(
  base: readonly Point[],
  edited: EditedRoute,
  points: readonly Point[],
): string | null {
  if (!leavesKink(base, points)) return null;
  return edited.stopped === true ? TIP_REASON : KINK_REASON;
}

/** Whether two routes run through the same points. */
export function sameRoute(a: readonly Point[], b: readonly Point[]): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => Math.abs(p[0] - b[i]![0]) < 0.01 && Math.abs(p[1] - b[i]![1]) < 0.01)
  );
}

/**
 * Where the point at `index` of `before` is in `after`, a route that
 * `tidyPoints` made of it: its index there, or -1 when it was taken out.
 */
export function pointIn(before: readonly Point[], index: number, after: readonly Point[]): number {
  const p = before[index];
  if (p === undefined) return -1;
  return after.findIndex((q) => Math.abs(q[0] - p[0]) <= EPS && Math.abs(q[1] - p[1]) <= EPS);
}

/**
 * Where the run that starts at the point `run` of `before` is in `after`,
 * a route that `tidyPoints` made of it: the index of the run of `after` its
 * middle lies on, or -1 when it has none (the run was a step of no length).
 */
export function runIn(before: readonly Point[], run: number, after: readonly Point[]): number {
  const a = before[run];
  const b = before[run + 1];
  if (a === undefined || b === undefined) return -1;
  const middle: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  for (let k = 0; k + 1 < after.length; k += 1) {
    const on = nearestOnRun(after[k]!, after[k + 1]!, middle);
    if (Math.hypot(on[0] - middle[0], on[1] - middle[1]) <= EPS) return k;
  }
  return -1;
}

// ---- a move, and the nearest place it is clear ---------------------------------

/** What of a route is moved: a run, a bend, or a new bend pulled out of a run at `at`. */
export type EditPart =
  | { kind: 'run'; index: number }
  | { kind: 'bend'; index: number }
  | { kind: 'pull'; index: number; at: Point };

export interface EditOptions {
  /** Move a bend alone, and leave the runs that meet there at an angle. */
  free?: boolean;
  /** The grid what is moved lands on; absent: it lands where it is put. */
  grid?: number;
  /**
   * How near a bend that is moved freely, or pulled out of a run, comes to
   * being in line with the bend before or after it for it to be put in
   * line; absent: it is not.
   */
  align?: number;
}

/** `value` on the nearest line of a grid `grid` apart. */
function onGrid(value: number, grid: number | undefined): number {
  return grid === undefined || grid <= 0 ? value : Math.round(value / grid) * grid;
}

/** `p` put in line with `before` and `after` along each axis where it is within `within` of that. */
function inLine(p: Point, before: Point, after: Point, within: number | undefined): Point {
  if (within === undefined) return p;
  const snap = (value: number, to: readonly number[]): number => {
    const near = to.filter((t) => Math.abs(t - value) <= within);
    return near.length === 0
      ? value
      : near.reduce((a, b) => (Math.abs(a - value) <= Math.abs(b - value) ? a : b));
  };
  return [snap(p[0], [before[0], after[0]]), snap(p[1], [before[1], after[1]])];
}

/** `part` of the route `base` moved by `by`. */
export function applyEdit(
  base: readonly Point[],
  part: EditPart,
  by: readonly [number, number],
  ends: RouteEnds,
  options: EditOptions = {},
): EditedRoute {
  const { grid, align } = options;
  if (part.kind === 'run') {
    const a = base[part.index];
    if (a === undefined) return slideRun(base, part.index, by, ends);
    // The line of the run lands on the grid, not how far it was moved.
    const to: [number, number] = [
      onGrid(a[0] + by[0], grid) - a[0],
      onGrid(a[1] + by[1], grid) - a[1],
    ];
    return slideRun(base, part.index, to, ends);
  }
  if (part.kind === 'pull') {
    const [before, after] = [base[part.index], base[part.index + 1]];
    // The handle is beside its run, at no whole place of the diagram: the
    // bend that is pulled out of it lands on one, as every other point does.
    const at: Point = [
      onGrid(Math.round(part.at[0] + by[0]), grid),
      onGrid(Math.round(part.at[1] + by[1]), grid),
    ];
    const placed = before && after ? inLine(at, before, after, align) : at;
    return pullBend(base, part.index, placed);
  }
  const p = base[part.index];
  const [before, after] = [base[part.index - 1], base[part.index + 1]];
  if (p === undefined || before === undefined || after === undefined) {
    return moveBend(base, part.index, by, ends, options.free);
  }
  let to: Point = [onGrid(p[0] + by[0], grid), onGrid(p[1] + by[1], grid)];
  if (options.free === true) to = inLine(to, before, after, align);
  return moveBend(base, part.index, [to[0] - p[0], to[1] - p[1]], ends, options.free);
}

/**
 * The attribute of the handle that takes the keyboard focus when a line is
 * picked from its menu: its longest run, which the arrow keys then slide.
 */
export const ROUTE_FOCUS_ATTR = 'data-route-focus';

/** How far from where a part was put a clear place is looked for, and how far apart the places tried are. */
export const SNAP_REACH = 48;
export const SNAP_STEP = 2;

/**
 * The least a run or a bend is moved when it is put somewhere else than
 * where it was asked to go, or goes less far than it was asked to because
 * its end is at the tip of its bar. A place nearer than this to where the
 * part came from would leave a step too short to be read as one: a kink.
 */
export const SNAP_LEAST = MIN_STEP;

export interface SettledEdit {
  /** The route to draw: tidied, and clear of everything else. */
  points: Point[];
  /** The edit it came from (`points` before it was tidied, and what was moved). */
  edited: EditedRoute;
  /**
   * What stood in the way where the part was put, when that was somewhere
   * else than where it is drawn; `null` when it is drawn where it was put.
   */
  refused: string | null;
  /** The route it would have had where it was put, for one that was refused. */
  wanted: Point[] | null;
  /**
   * Set where the line is left as it was: the part was moved so little way
   * that the step it would make is too short to be read as one.
   */
  stayed?: true;
}

/**
 * Move `part` of the route `base` by `by`, and where that puts the line on
 * something (`clear` says what, or `null`) or leaves a step too short to be
 * read as one (`leavesKink`), to the nearest place where it does neither:
 * a run along the way it slides, a bend in any direction, up to
 * `SNAP_REACH` from where it was put, no nearer than `SNAP_LEAST` to where
 * it came from, and not on the other side of that. A run or a bend that
 * was moved less than `SNAP_LEAST` and would leave such a step stays where
 * it is (`stayed`). `null` with no clear place that near; the caller then
 * leaves the line where it last was.
 */
export function settleEdit(
  base: readonly Point[],
  part: EditPart,
  by: readonly [number, number],
  ends: RouteEnds,
  clear: (points: readonly Point[]) => string | null,
  options: EditOptions = {},
): SettledEdit | null {
  const at = (move: readonly [number, number]): { edited: EditedRoute; points: Point[] } => {
    const edited = applyEdit(base, part, move, ends, options);
    return { edited, points: tidyPoints(edited.points) };
  };
  const asked = at(by);
  /** Whether a move went so little way that the step it leaves is a kink. */
  const short = (edited: EditedRoute): boolean =>
    part.kind !== 'pull' && Math.hypot(edited.by[0], edited.by[1]) < SNAP_LEAST;
  // A step too short to read is not made. Where it is that short because an
  // end at the tip of its bar goes no further, that is what is said
  // (`kinkReason`).
  const kink = kinkReason(base, asked.edited, asked.points);
  const kinked = kink !== null;
  const refused = kink ?? clear(asked.points);
  if (refused === null) return { ...asked, refused: null, wanted: null };
  // Moved too little way to make a step of: the line stays as it is, and
  // goes with the pointer once that has gone far enough. Where going on
  // makes no step either (the tip of the bar stops the end first), that is
  // what it is refused for.
  const gone = Math.hypot(by[0], by[1]);
  if (kinked && part.kind !== 'pull' && gone < SNAP_LEAST) {
    const still: EditedRoute = {
      points: base.map(([x, y]): Point => [x, y]),
      picked: part.index,
      by: [0, 0],
    };
    const on = gone > 0 ? at([(by[0] / gone) * SNAP_LEAST, (by[1] / gone) * SNAP_LEAST]) : asked;
    return {
      edited: still,
      points: tidyPoints(base),
      refused: kinkReason(base, on.edited, on.points) ?? refused,
      wanted: null,
      stayed: true,
    };
  }
  // The ways it can give: a level or an upright run only across itself.
  const run = part.kind === 'run' ? base[part.index] : undefined;
  const next = part.kind === 'run' ? base[part.index + 1] : undefined;
  const kind = run !== undefined && next !== undefined ? runKind(run, next) : 'angled';
  const ways: [number, number][] =
    kind === 'level'
      ? [
          [0, -1],
          [0, 1],
        ]
      : kind === 'upright'
        ? [
            [-1, 0],
            [1, 0],
          ]
        : [
            [0, -1],
            [0, 1],
            [-1, 0],
            [1, 0],
            [-1, -1],
            [1, -1],
            [-1, 1],
            [1, 1],
          ];
  const step = Math.max(SNAP_STEP, options.grid ?? 0);
  const seen = new Set<string>();
  // The route as it is counts as no place to take the part to: a bend that
  // is pulled back into its run, or a part that is put back where it was.
  const asItIs = tidyPoints(base);
  seen.add(asItIs.map(([x, y]) => `${x},${y}`).join(' '));
  // A bend that is pulled out of a run stays on the side of the run it was
  // pulled to.
  const pulledTo = (edited: EditedRoute): number => {
    const [a, p, b] = [base[part.index], edited.points[edited.picked], base[part.index + 1]];
    if (part.kind !== 'pull' || a === undefined || p === undefined || b === undefined) return 0;
    return Math.sign((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
  };
  const side = pulledTo(asked.edited);
  for (let off = step; off <= SNAP_REACH; off += step) {
    for (const [wx, wy] of ways) {
      const tried = at([by[0] + wx * off, by[1] + wy * off]);
      // An end that reached the tip of its bar goes no further: the same route again.
      const key = tried.points.map(([x, y]) => `${x},${y}`).join(' ');
      if (seen.has(key)) continue;
      seen.add(key);
      // Not back past where it came from: that is not where it was taken.
      const back = tried.edited.by[0] * by[0] + tried.edited.by[1] * by[1] <= 0;
      if (short(tried.edited) || (part.kind !== 'pull' && back)) continue;
      if (side !== 0 && pulledTo(tried.edited) !== side) continue;
      if (leavesKink(base, tried.points)) continue;
      if (clear(tried.points) === null) return { ...tried, refused, wanted: asked.points };
    }
  }
  return null;
}
