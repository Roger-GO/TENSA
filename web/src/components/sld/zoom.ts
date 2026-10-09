/**
 * When the diagram is too small to read, and what it is zoomed to then.
 *
 * A diagram opens fitted to its pane, whole. In a short pane (a small
 * window, or a tall bottom drawer) that fit can be a fifth of full size: a
 * bus is a dash, a device a dot, and a connector cannot be followed. The
 * names are 9 and 10 px text and a device's symbol is 24 px, so under
 * `LEGIBLE_ZOOM` a name is under 4 px on screen and a symbol under 10, and
 * the diagram counts as too small to read. The canvas says so above the
 * diagram and offers a button that zooms in (`SldCanvasHint`), and asking
 * to be shown an element (a table row, the search) zooms in on it as well
 * as centring it (`locateZoom`).
 *
 * A fit keeps the whole diagram clear of what floats over the corners of
 * its pane, the minimap and the zoom controls (`fitPadding`): a load at the
 * foot of a tall diagram is not behind the minimap.
 *
 * The line is drawn low on purpose. Between it and full size the names are
 * small but the symbols can be told apart and a drag can be aimed, which is
 * how a case of a few dozen buses is looked at whole, and a pick in a table
 * there should not take that view away.
 */
import { useStore } from '@xyflow/react';

/** Zoom factor under which the names on the diagram are too small to read. */
export const LEGIBLE_ZOOM = 0.4;

/** Full size: the zoom the symbols and their names are drawn for. */
export const FULL_ZOOM = 1;

/** True when a diagram at `zoom` is too small to read. */
export function isTooSmallToRead(zoom: number): boolean {
  return zoom < LEGIBLE_ZOOM;
}

/**
 * The zoom to show an element at when the user asks where it is: the zoom
 * the diagram has, unless that is too small to read, in which case full size.
 */
export function locateZoom(zoom: number): number {
  return isTooSmallToRead(zoom) ? FULL_ZOOM : zoom;
}

/**
 * The zoom of the diagram in percent while it is too small to read, and
 * `null` otherwise. One value for the selector, so a reader re-renders when
 * the percentage it shows changes and not on every frame of a pan or zoom.
 */
export function useTooSmallZoomPercent(): number | null {
  return useStore((s) => {
    const zoom = s.transform[2];
    return isTooSmallToRead(zoom) ? Math.round(zoom * 100) : null;
  });
}

/**
 * Whether every one of `points`, as places on screen, is inside `pane` with
 * `margin` to spare: what is asked of a line that was picked away from the
 * diagram before the view is moved to it. One that shows whole already is
 * left where the user has it.
 */
export function withinPane(
  points: readonly { x: number; y: number }[],
  pane: { left: number; right: number; top: number; bottom: number },
  margin = FIT_MARGIN,
): boolean {
  if (pane.right - pane.left <= 2 * margin || pane.bottom - pane.top <= 2 * margin) return false;
  return points.every(
    ({ x, y }) =>
      x >= pane.left + margin &&
      x <= pane.right - margin &&
      y >= pane.top + margin &&
      y <= pane.bottom - margin,
  );
}

/** The room a fitted diagram keeps to the edge of its pane, in pixels on screen. */
const FIT_MARGIN = 24;

/**
 * The height under which the pane of the diagram is a strip: what floats
 * over its top left corner (the draw buttons and the two legends) would
 * reach the zoom controls of the bottom left one, and a diagram of any size
 * is fitted too small to use.
 */
export const SHORT_PANE_PX = 300;

/**
 * What floats over the corners of the diagram: the minimap with the search
 * button at the bottom right, and the zoom controls at the bottom left, each
 * with the margin it keeps to the edge.
 */
const MINIMAP_CORNER = { width: 232, height: 176 };
const CONTROLS_CORNER = { width: 56, height: 132 };

/**
 * The padding a fit of the diagram keeps to each edge of its pane, so that
 * the whole of it is in view and none of it is behind the minimap or the
 * zoom controls. There are two ways to keep clear of those: leave the strip
 * along the bottom that holds both, or leave a strip down each side. The
 * one that shows the diagram larger is taken: a tall, narrow diagram stands
 * between the two, a wide one over them. `pane` is the size of the pane on
 * screen and `diagram` the size of what is drawn, in its own units.
 */
export function fitPadding(
  pane: { width: number; height: number },
  diagram: { width: number; height: number },
): { top: `${number}px`; right: `${number}px`; bottom: `${number}px`; left: `${number}px` } {
  const zoomWith = (across: number, down: number): number =>
    Math.min(
      (pane.width - across) / Math.max(1, diagram.width),
      (pane.height - down) / Math.max(1, diagram.height),
    );
  const above = zoomWith(2 * FIT_MARGIN, FIT_MARGIN + MINIMAP_CORNER.height);
  const between = zoomWith(MINIMAP_CORNER.width + CONTROLS_CORNER.width, 2 * FIT_MARGIN);
  const side = between > above;
  return {
    top: `${FIT_MARGIN}px`,
    right: `${side ? MINIMAP_CORNER.width : FIT_MARGIN}px`,
    bottom: `${side ? FIT_MARGIN : MINIMAP_CORNER.height}px`,
    left: `${side ? CONTROLS_CORNER.width : FIT_MARGIN}px`,
  };
}

/**
 * The zoom a diagram of the size `diagram` is fitted at in a pane of the
 * size `pane`, with the padding `fitPadding` keeps; never more than full
 * size, which a fit does not go past.
 */
export function fittedZoom(
  pane: { width: number; height: number },
  diagram: { width: number; height: number },
): number {
  const px = (side: `${number}px`): number => Number.parseFloat(side);
  const padding = fitPadding(pane, diagram);
  const across = pane.width - px(padding.left) - px(padding.right);
  const down = pane.height - px(padding.top) - px(padding.bottom);
  return Math.min(
    FULL_ZOOM,
    Math.max(0, across) / Math.max(1, diagram.width),
    Math.max(0, down) / Math.max(1, diagram.height),
  );
}

/**
 * Whether the bottom drawer is what keeps a diagram too small to read: the
 * pane is a strip (under `SHORT_PANE_PX`, which a drawer that was left tall
 * makes of it), fitted in it the diagram is too small, and in a pane higher
 * by `drawer`, the room an open drawer gives back when it is lowered to its
 * tabs, it could be read. A pane of a usable height is how the user has the
 * window, small diagram or not; a diagram that is too small either way (a
 * case of a hundred buses) gains nothing; and a pane with no size is not on
 * screen.
 */
export function drawerKeepsTooSmall(
  pane: { width: number; height: number },
  drawer: number,
  diagram: { width: number; height: number },
): boolean {
  if (pane.width <= 0 || pane.height <= 0 || drawer <= 0) return false;
  if (pane.height >= SHORT_PANE_PX) return false;
  if (!isTooSmallToRead(fittedZoom(pane, diagram))) return false;
  return !isTooSmallToRead(
    fittedZoom({ width: pane.width, height: pane.height + drawer }, diagram),
  );
}

/**
 * Where full size is shown when nothing is selected: the middle of the box,
 * among `boxes`, that is nearest to the middle of them all. Full size on the
 * middle of the diagram itself would as often show the ground between two
 * buses as anything drawn. `null` with no box.
 */
export function middleOfDiagram(
  boxes: readonly { x: number; y: number; width: number; height: number }[],
): { x: number; y: number } | null {
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((b) => b.x));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const top = Math.min(...boxes.map((b) => b.y));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  const middle = { x: (left + right) / 2, y: (top + bottom) / 2 };
  let nearest: { x: number; y: number } | null = null;
  let least = Infinity;
  for (const box of boxes) {
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const far = Math.hypot(at.x - middle.x, at.y - middle.y);
    if (far < least) [nearest, least] = [at, far];
  }
  return nearest;
}
