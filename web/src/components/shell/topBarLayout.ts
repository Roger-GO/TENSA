/**
 * How the top bar gives way as the window narrows.
 *
 * The bar's controls add up to about 1550 px once a power flow has run, and to about
 * 1840 px while a time-domain run streams (the Abort button, the "Streaming" status and
 * the job chip all show; it was 1460 and 1750 px when this file was first written). On
 * a 1280 or 1440 px window the last of them (Search, Theme, History, Help) scrolled out
 * of sight. The lower-priority ones now hand over to a "More" menu (`TopBarMoreMenu`)
 * instead of the bar scrolling, in three steps:
 *
 * - From WIDE_PX the bar holds everything inline.
 * - Below WIDE_PX, Search, Theme and History are in More.
 * - Below MEDIUM_PX, the four pane toggles (sidebar, inspector, drawer, results view)
 *   are in More too, and the job chip shows its dot without its words.
 * - Below NARROW_PX, the Labels and Units toggles are in More as well.
 *
 * Every control that moves is a command with a shortcut or a preference with a menu
 * item, so nothing becomes unreachable. Below about 1100 px the bar still scrolls, as
 * it did before, and so does it while the "Cannot reach substrate" badge shows.
 *
 * The widths are measured, and the margin is for fonts wider than the ones they were
 * measured with, which is not a guess: the numbers below were measured with Chromium on
 * Windows, and GitHub's Linux runner draws the same bar about 5 percent wider. With the
 * widths at 1500, 1690 and 1910, set from the Windows figures plus 70 px, the streaming
 * bar scrolled there at 1910 px by 14 px (22 px on the retry): its content was some 1925
 * to 1930 px against 1841 px here. So each width is now the content measured here plus
 * 6 percent and 70 px at least, and `top-bar-fit.spec.ts` holds the margin itself: it
 * checks every width a second time with the bar's text spaced out until the content is
 * 5 percent wider (`letter-spacing`, `WIDENING` there), so a margin too thin for the
 * runner's fonts fails on any machine. On the runner that second pass stands for fonts
 * some 10 percent wider than these, and the widths leave it about 40 px at each step.
 * Do not shave these widths back to the figures measured on one machine.
 *
 * The content measured here (Windows, `top-bar-fit.spec.ts` with IEEE 14 streaming a
 * time-domain run, the engine picker showing "ANDES", the longest engine label, the
 * status at t of two digits; gaps and padding included), then 5 percent wider (the
 * spec's second pass), and the room each leaves at its width:
 *
 * - all three steps in More: 1101 px (1149 px), 179 px to spare at 1280 px (131 px);
 * - Labels and Units inline: 1336 px (1401 px), 184 px at NARROW_PX (119 px);
 * - the pane toggles and the job chip's words too: 1615 px (1698 px), 205 px at
 *   MEDIUM_PX (122 px);
 * - everything inline: 1841 px (1942 px), 229 px at WIDE_PX (128 px).
 *
 * The job chip's words ("Running TDS...", 87 px) were the cheapest room to make below
 * MEDIUM_PX: during a time-domain run the status beside the Run button says the same,
 * and the chip keeps them for a screen reader and as its hover text. A control that
 * joins the bar is measured into these numbers the same way, on the fit spec's two
 * passes, whose report gives the content and the room at every width.
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
 * and the build warns about it. So the only width classes in this file are the seven
 * below, and the same test fails on one written anywhere without a length in it.
 */
export const WIDE_PX = 2070;
export const MEDIUM_PX = 1820;
export const NARROW_PX = 1520;

/** On a control that is inline only from WIDE_PX up. */
export const INLINE_FROM_WIDE = 'max-[2070px]:hidden';
/** On a control that is inline only from MEDIUM_PX up. */
export const INLINE_FROM_MEDIUM = 'max-[1820px]:hidden';
/** On a control that is inline only from NARROW_PX up. */
export const INLINE_FROM_NARROW = 'max-[1520px]:hidden';

/** On the words of a control that shows its glyph alone below MEDIUM_PX (the job chip). */
export const LABEL_FROM_MEDIUM = 'max-[1820px]:sr-only';

/** On the More button, which is there only below WIDE_PX. */
export const MORE_BELOW_WIDE = 'min-[2070px]:hidden';
/** On a More item that stands in for a control inline from MEDIUM_PX up. */
export const MORE_BELOW_MEDIUM = 'min-[1820px]:hidden';
/** On a More item that stands in for a control inline from NARROW_PX up. */
export const MORE_BELOW_NARROW = 'min-[1520px]:hidden';
