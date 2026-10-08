/**
 * The path data of an SVG (`d="M 6 12 Q 9 7.5 12 12 T 18 12"`) as the steps
 * a figure draws: absolute points, with every curve a cubic one. The symbols
 * of the diagram are SVG files (`icons/iec60617`), and a PDF has straight
 * runs and cubic curves and nothing else, so a quadratic curve and an arc
 * are turned into cubics here, once, for every writer.
 *
 * Pure: nothing read but the arguments.
 */
import type { PathStep } from './displayList';

/** How many numbers each command takes. */
const ARITY: Record<string, number> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0,
};

const NUMBER = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/y;
const FLAG = /[01]/y;
const GAP = /[\s,]*/y;

/**
 * The commands of `d` in order, each with the numbers after it. The two
 * flags of an arc are one digit each and may be written with nothing after
 * them (`a8 8 0 0116 0` ends at 16, 0), so they are read as flags and not
 * as the start of a number.
 */
function tokens(d: string): { command: string; values: number[] }[] {
  const out: { command: string; values: number[] }[] = [];
  let at = 0;
  const skip = (): void => {
    GAP.lastIndex = at;
    GAP.exec(d);
    at = GAP.lastIndex;
  };
  for (skip(); at < d.length; skip()) {
    const command = d[at]!;
    if (!/[a-zA-Z]/.test(command)) throw new Error(`path data: unexpected "${command}"`);
    at += 1;
    const isArc = command === 'A' || command === 'a';
    const values: number[] = [];
    for (;;) {
      skip();
      const flag = isArc && (values.length % 7 === 3 || values.length % 7 === 4);
      const pattern = flag ? FLAG : NUMBER;
      pattern.lastIndex = at;
      const match = pattern.exec(d);
      if (match === null) break;
      values.push(Number(match[0]));
      at = pattern.lastIndex;
    }
    out.push({ command, values });
  }
  return out;
}

/**
 * The cubic curves of the arc of an ellipse from (`x0`, `y0`) to (`x`, `y`),
 * as SVG describes one: the two radii, the turn of the ellipse in degrees,
 * and the two flags that pick one of the four arcs through both points.
 */
function arc(
  x0: number,
  y0: number,
  radiusX: number,
  radiusY: number,
  turn: number,
  large: boolean,
  sweep: boolean,
  x: number,
  y: number,
): PathStep[] {
  let rx = Math.abs(radiusX);
  let ry = Math.abs(radiusY);
  if (rx === 0 || ry === 0 || (x0 === x && y0 === y)) return [{ op: 'L', x, y }];
  const phi = (turn * Math.PI) / 180;
  const [cos, sin] = [Math.cos(phi), Math.sin(phi)];
  // The middle of the chord, turned into the frame of the ellipse.
  const dx = (x0 - x) / 2;
  const dy = (y0 - y) / 2;
  const px = cos * dx + sin * dy;
  const py = -sin * dx + cos * dy;
  // Radii too small to reach from one point to the other are scaled up.
  const reach = (px * px) / (rx * rx) + (py * py) / (ry * ry);
  if (reach > 1) {
    rx *= Math.sqrt(reach);
    ry *= Math.sqrt(reach);
  }
  const over = rx * rx * py * py + ry * ry * px * px;
  const factor =
    (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, (rx * rx * ry * ry - over) / over));
  const cxp = (factor * rx * py) / ry;
  const cyp = (-factor * ry * px) / rx;
  const cx = cos * cxp - sin * cyp + (x0 + x) / 2;
  const cy = sin * cxp + cos * cyp + (y0 + y) / 2;
  const angle = (ux: number, uy: number): number => Math.atan2(uy, ux);
  const start = angle((px - cxp) / rx, (py - cyp) / ry);
  let extent = angle((-px - cxp) / rx, (-py - cyp) / ry) - start;
  if (sweep && extent < 0) extent += 2 * Math.PI;
  if (!sweep && extent > 0) extent -= 2 * Math.PI;
  // A cubic follows a quarter turn closely, so the arc is cut into those.
  const parts = Math.max(1, Math.ceil(Math.abs(extent) / (Math.PI / 2) - 1e-9));
  const step = extent / parts;
  const handle = (4 / 3) * Math.tan(step / 4);
  const at = (theta: number): [number, number] => [
    cx + rx * Math.cos(theta) * cos - ry * Math.sin(theta) * sin,
    cy + rx * Math.cos(theta) * sin + ry * Math.sin(theta) * cos,
  ];
  const along = (theta: number): [number, number] => [
    -rx * Math.sin(theta) * cos - ry * Math.cos(theta) * sin,
    -rx * Math.sin(theta) * sin + ry * Math.cos(theta) * cos,
  ];
  const out: PathStep[] = [];
  for (let i = 0; i < parts; i += 1) {
    const from = start + i * step;
    const to = from + step;
    const [ax, ay] = at(from);
    const [bx, by] = at(to);
    const [adx, ady] = along(from);
    const [bdx, bdy] = along(to);
    out.push({
      op: 'C',
      x1: ax + handle * adx,
      y1: ay + handle * ady,
      x2: bx - handle * bdx,
      y2: by - handle * bdy,
      // The last part ends on the point the path names, not on a rounding of it.
      x: i === parts - 1 ? x : bx,
      y: i === parts - 1 ? y : by,
    });
  }
  return out;
}

/**
 * The steps of the path data `d`. Throws on a command it does not know, so
 * that a symbol that cannot be drawn in a figure is found by the tests and
 * not left out of one.
 */
export function parsePathData(d: string): PathStep[] {
  const out: PathStep[] = [];
  // Where the pen is, where the subpath began, and the control point the
  // last curve ended with (what a smooth curve mirrors).
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let control: { x: number; y: number; of: 'C' | 'Q' } | null = null;
  for (const { command, values } of tokens(d)) {
    const upper = command.toUpperCase();
    const arity = ARITY[upper];
    if (arity === undefined) throw new Error(`path command ${command} is not supported`);
    const relative = command !== upper;
    if (upper === 'Z') {
      out.push({ op: 'Z' });
      x = startX;
      y = startY;
      control = null;
      continue;
    }
    if (values.length === 0 || values.length % arity !== 0) {
      throw new Error(`path command ${command} has ${values.length} numbers`);
    }
    for (let i = 0; i < values.length; i += arity) {
      const v = values.slice(i, i + arity);
      const ox = relative ? x : 0;
      const oy = relative ? y : 0;
      // After the first pair, a move goes on as straight runs.
      const op = upper === 'M' && i > 0 ? 'L' : upper;
      switch (op) {
        case 'M':
          x = ox + v[0]!;
          y = oy + v[1]!;
          startX = x;
          startY = y;
          out.push({ op: 'M', x, y });
          control = null;
          break;
        case 'L':
          x = ox + v[0]!;
          y = oy + v[1]!;
          out.push({ op: 'L', x, y });
          control = null;
          break;
        case 'H':
          x = ox + v[0]!;
          out.push({ op: 'L', x, y });
          control = null;
          break;
        case 'V':
          y = oy + v[0]!;
          out.push({ op: 'L', x, y });
          control = null;
          break;
        case 'C':
        case 'S': {
          const smooth = op === 'S';
          const x1: number = smooth ? (control?.of === 'C' ? 2 * x - control.x : x) : ox + v[0]!;
          const y1: number = smooth ? (control?.of === 'C' ? 2 * y - control.y : y) : oy + v[1]!;
          const rest = smooth ? v : v.slice(2);
          const x2 = ox + rest[0]!;
          const y2 = oy + rest[1]!;
          x = ox + rest[2]!;
          y = oy + rest[3]!;
          out.push({ op: 'C', x1, y1, x2, y2, x, y });
          control = { x: x2, y: y2, of: 'C' };
          break;
        }
        case 'Q':
        case 'T': {
          const smooth = op === 'T';
          const qx: number = smooth ? (control?.of === 'Q' ? 2 * x - control.x : x) : ox + v[0]!;
          const qy: number = smooth ? (control?.of === 'Q' ? 2 * y - control.y : y) : oy + v[1]!;
          const rest = smooth ? v : v.slice(2);
          const ex = ox + rest[0]!;
          const ey = oy + rest[1]!;
          // The cubic that draws the same curve as the quadratic.
          out.push({
            op: 'C',
            x1: x + (2 / 3) * (qx - x),
            y1: y + (2 / 3) * (qy - y),
            x2: ex + (2 / 3) * (qx - ex),
            y2: ey + (2 / 3) * (qy - ey),
            x: ex,
            y: ey,
          });
          x = ex;
          y = ey;
          control = { x: qx, y: qy, of: 'Q' };
          break;
        }
        case 'A': {
          const ex = ox + v[5]!;
          const ey = oy + v[6]!;
          out.push(...arc(x, y, v[0]!, v[1]!, v[2]!, v[3] !== 0, v[4] !== 0, ex, ey));
          x = ex;
          y = ey;
          control = null;
          break;
        }
      }
    }
  }
  return out;
}

/** The four cubic curves of a circle, as a closed path. */
export function circleSteps(cx: number, cy: number, r: number): PathStep[] {
  // The length of the handles that make a cubic follow a quarter of a circle.
  const k = 0.5522847498 * r;
  return [
    { op: 'M', x: cx + r, y: cy },
    { op: 'C', x1: cx + r, y1: cy + k, x2: cx + k, y2: cy + r, x: cx, y: cy + r },
    { op: 'C', x1: cx - k, y1: cy + r, x2: cx - r, y2: cy + k, x: cx - r, y: cy },
    { op: 'C', x1: cx - r, y1: cy - k, x2: cx - k, y2: cy - r, x: cx, y: cy - r },
    { op: 'C', x1: cx + k, y1: cy - r, x2: cx + r, y2: cy - k, x: cx + r, y: cy },
    { op: 'Z' },
  ];
}

/** A rectangle whose corners are rounded with `radius`, as a closed path. */
export function roundedRectSteps(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): PathStep[] {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (r === 0) {
    return [
      { op: 'M', x, y },
      { op: 'L', x: x + width, y },
      { op: 'L', x: x + width, y: y + height },
      { op: 'L', x, y: y + height },
      { op: 'Z' },
    ];
  }
  const k = 0.5522847498 * r;
  const [right, bottom] = [x + width, y + height];
  return [
    { op: 'M', x: x + r, y },
    { op: 'L', x: right - r, y },
    { op: 'C', x1: right - r + k, y1: y, x2: right, y2: y + r - k, x: right, y: y + r },
    { op: 'L', x: right, y: bottom - r },
    {
      op: 'C',
      x1: right,
      y1: bottom - r + k,
      x2: right - r + k,
      y2: bottom,
      x: right - r,
      y: bottom,
    },
    { op: 'L', x: x + r, y: bottom },
    { op: 'C', x1: x + r - k, y1: bottom, x2: x, y2: bottom - r + k, x, y: bottom - r },
    { op: 'L', x, y: y + r },
    { op: 'C', x1: x, y1: y + r - k, x2: x + r - k, y2: y, x: x + r, y },
    { op: 'Z' },
  ];
}
