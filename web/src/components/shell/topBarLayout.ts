/**
 * How the top bar gives way as the window narrows.
 *
 * The bar's controls add up to about 1460 px once a power flow has run, and to about
 * 1750 px while a time-domain run streams (the Abort button, the "Streaming" status and
 * the job chip all show). On a 1280 or 1440 px window the last of them (Search, Theme,
 * History, Help) scrolled out of sight. The lower-priority ones now hand over to a
 * "More" menu (`TopBarMoreMenu`) instead of the bar scrolling, in three steps:
 *
 * - From WIDE_PX the bar holds everything inline.
 * - Below WIDE_PX, Search, Theme and History are in More.
 * - Below MEDIUM_PX, the four pane toggles (sidebar, inspector, drawer, results view)
 *   are in More too.
 * - Below NARROW_PX, the Labels and Units toggles are as well.
 *
 * Each width is the streaming worst case plus about 70 px, for fonts wider than the
 * ones it was measured with. Every control that moves is a command with a shortcut or a
 * preference with a menu item, so nothing becomes unreachable. Below about 1100 px the
 * bar still scrolls, as it did before, and so does it while the "Cannot reach substrate"
 * badge shows.
 *
 * The class names are written out in full, and not built from the numbers, because
 * Tailwind finds the classes it must generate by reading the source for them. Each
 * carries its threshold in square brackets: the `max-` form hides below that width and
 * the `min-` form from it up (in Tailwind 4, `max-` with a width means "narrower than
 * it"), so an inline control and its More item swap over at the same width. A test
 * reads them against these numbers.
 *
 * Tailwind reads comments too, and the tests. A class written here with a letter for
 * the width, as an example, becomes a rule with a media query that is not valid CSS,
 * and the build warns about it. So the only width classes in this file are the six
 * below, and the same test fails on one written anywhere without a length in it.
 */
export const WIDE_PX = 1820;
export const MEDIUM_PX = 1620;
export const NARROW_PX = 1400;

/** On a control that is inline only from WIDE_PX up. */
export const INLINE_FROM_WIDE = 'max-[1820px]:hidden';
/** On a control that is inline only from MEDIUM_PX up. */
export const INLINE_FROM_MEDIUM = 'max-[1620px]:hidden';
/** On a control that is inline only from NARROW_PX up. */
export const INLINE_FROM_NARROW = 'max-[1400px]:hidden';

/** On the More button, which is there only below WIDE_PX. */
export const MORE_BELOW_WIDE = 'min-[1820px]:hidden';
/** On a More item that stands in for a control inline from MEDIUM_PX up. */
export const MORE_BELOW_MEDIUM = 'min-[1620px]:hidden';
/** On a More item that stands in for a control inline from NARROW_PX up. */
export const MORE_BELOW_NARROW = 'min-[1400px]:hidden';
