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
