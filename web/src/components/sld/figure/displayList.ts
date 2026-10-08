/**
 * What a figure is made of: a list of plain shapes and texts in the order
 * they are painted, each with everything that says how it looks. It is what
 * `drawFigure` makes of the diagram, and what the three writers read
 * (`figureSvg`, `figurePdf`; a PNG is the SVG rasterised), so the preview
 * and every file show one and the same drawing.
 *
 * The coordinates are the diagram's own: px, x to the right and y down.
 *
 * Pure: nothing read but the arguments.
 */
import type { FigureFont } from './figureSettings';
import { textWidth } from './fontMetrics';

/** A colour as `#rrggbb`. */
export type FigureColour = string;

export interface Stroke {
  colour: FigureColour;
  width: number;
  /** The lengths of the dashes and the gaps of a dashed line; solid without. */
  dash?: readonly number[];
  /** How a line ends: cut square at its end, or rounded past it as the symbols are drawn. */
  cap?: 'butt' | 'round';
}

/** One step of a path: where it starts, a straight run, a cubic curve, or its closing. */
export type PathStep =
  | { op: 'M'; x: number; y: number }
  | { op: 'L'; x: number; y: number }
  | { op: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { op: 'Z' };

/** What every item says of itself besides its shape. */
interface ItemBase {
  /**
   * What on the diagram the item draws: the id of the node or the edge,
   * with the part of it after a colon where it is one (`label:5`,
   * `readout:load-PQ_3`, `flow:line-Line_4`, `symbol:transformer-Line_17`).
   */
  of: string;
}

export interface PathItem extends ItemBase {
  kind: 'path';
  steps: readonly PathStep[];
  stroke?: Stroke;
  fill?: FigureColour;
}

export interface RectItem extends ItemBase {
  kind: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
  /** The radius its corners are rounded with; square without. */
  radius?: number;
  stroke?: Stroke;
  fill?: FigureColour;
}

export interface CircleItem extends ItemBase {
  kind: 'circle';
  cx: number;
  cy: number;
  r: number;
  stroke?: Stroke;
  fill?: FigureColour;
}

export interface TextItem extends ItemBase {
  kind: 'text';
  text: string;
  /** Where the text is hung: `anchor` says which point of its baseline this is. */
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
  font: FigureFont;
  size: number;
  colour: FigureColour;
  /**
   * How wide the text is drawn. It is the width the font gives it, or less
   * where the room it has is less: the text is then set narrower, so that
   * it stays in its room whatever it says.
   */
  width: number;
  /** Degrees the text is turned by about (`x`, `y`), clockwise; upright without. */
  rotate?: number;
}

export type FigureItem = PathItem | RectItem | CircleItem | TextItem;

/** A box on the diagram. */
export interface FigureBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Figure {
  /** What is painted, first to last. */
  items: readonly FigureItem[];
  /** The part of the diagram the figure shows: everything drawn, with a margin round it. */
  box: FigureBox;
  /** The colour of the paper. */
  paper: FigureColour;
}

/** The straight runs through `points` as a path. */
export function polyline(points: readonly (readonly [number, number])[]): PathStep[] {
  return points.map(([x, y], i) => ({ op: i === 0 ? 'M' : 'L', x, y }));
}

/** A text as wide as `font` makes it at `size`, or as wide as `room` where that is less. */
export function fittedWidth(text: string, font: FigureFont, size: number, room: number): number {
  return Math.min(textWidth(text, font, size), Math.max(0, room));
}

/** The box `item` is drawn in, its stroke included. */
export function itemBox(item: FigureItem): FigureBox {
  switch (item.kind) {
    case 'rect': {
      const half = (item.stroke?.width ?? 0) / 2;
      return {
        x: item.x - half,
        y: item.y - half,
        width: item.width + 2 * half,
        height: item.height + 2 * half,
      };
    }
    case 'circle': {
      const reach = item.r + (item.stroke?.width ?? 0) / 2;
      return { x: item.cx - reach, y: item.cy - reach, width: 2 * reach, height: 2 * reach };
    }
    case 'path': {
      // The control points of a curve bound it, so they are counted as well.
      const xs: number[] = [];
      const ys: number[] = [];
      for (const step of item.steps) {
        if (step.op === 'Z') continue;
        xs.push(step.x);
        ys.push(step.y);
        if (step.op === 'C') {
          xs.push(step.x1, step.x2);
          ys.push(step.y1, step.y2);
        }
      }
      if (xs.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
      const half = (item.stroke?.width ?? 0) / 2;
      const left = Math.min(...xs) - half;
      const top = Math.min(...ys) - half;
      return {
        x: left,
        y: top,
        width: Math.max(...xs) + half - left,
        height: Math.max(...ys) + half - top,
      };
    }
    case 'text': {
      const left =
        item.anchor === 'start'
          ? item.x
          : item.anchor === 'middle'
            ? item.x - item.width / 2
            : item.x - item.width;
      // From the top of a capital to the foot of a descender, generously.
      const upright = {
        x: left,
        y: item.y - item.size * 0.8,
        width: item.width,
        height: item.size,
      };
      if (item.rotate === undefined || item.rotate === 0) return upright;
      return turnedBox(upright, item.x, item.y, item.rotate);
    }
  }
}

/** The box round `box` after it is turned by `degrees` about (`cx`, `cy`). */
function turnedBox(box: FigureBox, cx: number, cy: number, degrees: number): FigureBox {
  const angle = (degrees * Math.PI) / 180;
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  const corners = [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x, box.y + box.height],
    [box.x + box.width, box.y + box.height],
  ].map(([x, y]) => [
    cx + (x! - cx) * cos - (y! - cy) * sin,
    cy + (x! - cx) * sin + (y! - cy) * cos,
  ]);
  const xs = corners.map((c) => c[0]!);
  const ys = corners.map((c) => c[1]!);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

/** The box round every one of `items`, `margin` wider on each side; `null` for none. */
export function boxAround(items: readonly FigureItem[], margin: number): FigureBox | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const item of items) {
    const box = itemBox(item);
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.width);
    bottom = Math.max(bottom, box.y + box.height);
  }
  if (!Number.isFinite(left)) return null;
  return {
    x: Math.floor(left - margin),
    y: Math.floor(top - margin),
    width: Math.ceil(right + margin) - Math.floor(left - margin),
    height: Math.ceil(bottom + margin) - Math.floor(top - margin),
  };
}
