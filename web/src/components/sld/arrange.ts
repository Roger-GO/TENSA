/**
 * Align and distribute: line a selection of nodes up, or space it out evenly.
 *
 * Both work on boxes. The box of a bus is its bar, not the node with the
 * label under it, so "align top" puts the bars of the buses on one line and
 * "align middle" a device level with a bar. The box of a device is the one
 * it is drawn in.
 *
 * - Align moves every box onto a line of the selection: its left edge, the
 *   middle of its width, its right edge, its top, the middle of its height or
 *   its bottom. Left, right, top and bottom take the outermost box as the
 *   line, so one box stays where it is; centre and middle take the middle of
 *   the selection's bounding box.
 * - Distribute keeps the two outermost boxes where they are and moves the
 *   ones between so that the gaps between neighbours are equal. With fewer
 *   than three boxes there is nothing between, and nothing moves.
 *
 * `snap` rounds where a moved node ends up to the grid, for a diagram that
 * snaps. A node that need not move keeps its position to the last bit.
 *
 * Pure: no React, no React Flow, nothing read but the arguments.
 */

/** A node to arrange: the position of the node, and its box relative to that position. */
export interface ArrangeBox {
  id: string;
  /** Position of the node (its top-left corner in React Flow's terms). */
  x: number;
  y: number;
  /** The box that is lined up, as offsets from the position. */
  left: number;
  top: number;
  width: number;
  height: number;
}

export type AlignMode = 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom';

export type DistributeAxis = 'horizontal' | 'vertical';

/** New positions, by node id, of the nodes that move. */
export type Moves = Record<string, { x: number; y: number }>;

/** What the selection toolbar and the menus call each alignment. */
export const ALIGN_LABEL: Record<AlignMode, string> = {
  left: 'Align left',
  centre: 'Align centre',
  right: 'Align right',
  top: 'Align top',
  middle: 'Align middle',
  bottom: 'Align bottom',
};

export const DISTRIBUTE_LABEL: Record<DistributeAxis, string> = {
  horizontal: 'Distribute horizontally',
  vertical: 'Distribute vertically',
};

function rounded(value: number, snap: number | null): number {
  return snap === null ? value : Math.round(value / snap) * snap;
}

/** The moves that align `boxes`; empty with fewer than two. */
export function alignBoxes(
  boxes: readonly ArrangeBox[],
  mode: AlignMode,
  snap: number | null = null,
): Moves {
  if (boxes.length < 2) return {};
  const horizontal = mode === 'left' || mode === 'centre' || mode === 'right';
  // Along the axis that is aligned: where each box starts, and how long it is.
  const from = (b: ArrangeBox): number => (horizontal ? b.x + b.left : b.y + b.top);
  const extent = (b: ArrangeBox): number => (horizontal ? b.width : b.height);
  const low = Math.min(...boxes.map(from));
  const high = Math.max(...boxes.map((b) => from(b) + extent(b)));
  const moves: Moves = {};
  for (const b of boxes) {
    let start: number;
    if (mode === 'left' || mode === 'top') start = low;
    else if (mode === 'right' || mode === 'bottom') start = high - extent(b);
    else start = (low + high) / 2 - extent(b) / 2;
    if (Math.abs(start - from(b)) < 1e-9) continue;
    const position = rounded(start - (horizontal ? b.left : b.top), snap);
    const next = horizontal ? { x: position, y: b.y } : { x: b.x, y: position };
    if (next.x !== b.x || next.y !== b.y) moves[b.id] = next;
  }
  return moves;
}

/** The moves that space `boxes` out evenly along `axis`; empty with fewer than three. */
export function distributeBoxes(
  boxes: readonly ArrangeBox[],
  axis: DistributeAxis,
  snap: number | null = null,
): Moves {
  if (boxes.length < 3) return {};
  const horizontal = axis === 'horizontal';
  const from = (b: ArrangeBox): number => (horizontal ? b.x + b.left : b.y + b.top);
  const extent = (b: ArrangeBox): number => (horizontal ? b.width : b.height);
  // In the order they stand in; two that start level keep the order given.
  const ordered = boxes
    .map((box, i) => ({ box, i }))
    .sort((p, q) => from(p.box) - from(q.box) || p.i - q.i)
    .map(({ box }) => box);
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  const span = from(last) + extent(last) - from(first);
  const taken = ordered.reduce((sum, b) => sum + extent(b), 0);
  const gap = (span - taken) / (ordered.length - 1);
  const moves: Moves = {};
  let at = from(first) + extent(first) + gap;
  for (const b of ordered.slice(1, -1)) {
    if (Math.abs(at - from(b)) >= 1e-9) {
      const position = rounded(at - (horizontal ? b.left : b.top), snap);
      const next = horizontal ? { x: position, y: b.y } : { x: b.x, y: position };
      if (next.x !== b.x || next.y !== b.y) moves[b.id] = next;
    }
    at += extent(b) + gap;
  }
  return moves;
}
