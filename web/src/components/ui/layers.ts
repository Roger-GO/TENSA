/**
 * Where the toasts sit among the surfaces that can lie over one another.
 *
 * Dialogs, popovers, menus and tooltips are all `z-50`, and among themselves
 * the one opened last is drawn on top. A toast is drawn above them, so a
 * dialog's backdrop does not dim it and its buttons stay in reach. The one
 * surface drawn above a toast is an open top bar menu: the toasts appear in the
 * corner the menus on the right drop into, and a toast lying over a menu hides
 * its entries for as long as the pointer rests on it, because a toast under the
 * pointer does not time out.
 *
 * Inline `z-index` values, not classes: `cn` does not settle two classes for
 * one property, and the toaster's own stylesheet sets one of its own.
 */
export const TOAST_Z_INDEX = 55;
export const TOP_BAR_MENU_Z_INDEX = 60;

/**
 * How far below the top of the window the first toast starts, in px: the top
 * bar (`h-11`, 44 px) and a gap, so a toast never lies over the bar's buttons.
 */
export const TOAST_TOP_OFFSET_PX = 52;
