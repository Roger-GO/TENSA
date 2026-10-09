/**
 * The heights of the bottom drawer, as the panels of the shell need them.
 *
 * The panels are sized in percent of the column the drawer shares with the
 * diagram (`react-resizable-panels`), and what the drawer needs is so many
 * pixels whatever the height of the window: its tab strip when it is shut,
 * and room for the bar of a table, its heading and two rows when it is
 * open. A fixed percentage is right for one height of window only. In a
 * short one it cuts the strip off, and leaves an open drawer with the bar
 * of its table over the first row.
 *
 * The diagram over the drawer has a least height in pixels too
 * (`CANVAS_MIN_PX`): the row above it, and room for the zoom controls and
 * the buttons that float over its corners to stand clear of each other. A
 * drawer that was left tall, in a window that has since become short, used
 * to leave the diagram a strip a hundred pixels high.
 */

/** The tab strip of the drawer, with the line over it. */
export const DRAWER_STRIP_PX = 33;

/**
 * The least an open drawer is high: the strip, the bar of a table (its
 * filter and its buttons), the heading, two rows, and the scrollbar under
 * them.
 */
export const DRAWER_OPEN_MIN_PX = 172;

/**
 * The least the diagram's part of the column is high while the drawer is
 * open: the row over the diagram, and under it room for the zoom controls
 * with the buttons over the top left corner clear of them.
 */
export const CANVAS_MIN_PX = 280;

/** The sizes for a column whose height is not known yet: right for a window about 800 high. */
const UNMEASURED = { strip: 4, openMin: 15, canvasMin: 25 };

/** The height a drawer opens to from its strip, where the column is high enough for it. */
const OPEN_PCT = 35;

/** The most of its column an open drawer is held to by its least height, which leaves the diagram the rest. */
const OPEN_MIN_MOST_PCT = 60;

export interface DrawerSizes {
  /** The drawer when only its tab strip shows. */
  strip: number;
  /** The least it is while it is open: dragged lower, it snaps down to the strip. */
  openMin: number;
  /** What it opens to from the strip when it has no height of its own to come back to. */
  open: number;
  /**
   * The least the diagram over it keeps: `CANVAS_MIN_PX`, or what an open
   * drawer at its least height leaves where the column is too short for both.
   */
  canvasMin: number;
}

/**
 * The sizes of the bottom drawer in a column `column` pixels high, each as
 * a percentage of that height. A column that has not been measured (0)
 * gets the sizes that suit a window of the usual height.
 */
export function bottomDrawerSizes(column: number): DrawerSizes {
  if (!(column > 0)) return { ...UNMEASURED, open: OPEN_PCT };
  const percent = (px: number): number => Math.round((px / column) * 1000) / 10;
  const openMin = Math.min(OPEN_MIN_MOST_PCT, percent(DRAWER_OPEN_MIN_PX));
  const strip = Math.min(percent(DRAWER_STRIP_PX), openMin / 2);
  // The drawer can always be opened to its least height: the diagram gives
  // way to that, and to nothing more.
  const canvasMin = Math.round(Math.min(percent(CANVAS_MIN_PX), 100 - openMin) * 10) / 10;
  // What it opens to leaves the diagram its least height as well.
  const open = Math.max(openMin, Math.min(OPEN_PCT, 100 - canvasMin));
  return { strip, openMin, open, canvasMin };
}
