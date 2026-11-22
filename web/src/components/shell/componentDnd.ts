/**
 * The drag payload type of a row of the Components palette.
 *
 * In a module of its own so that what receives a drop (the diagram, the drop
 * zone of an empty system) can read it without importing the palette, which
 * is loaded the first time its tab is shown.
 */

/** Custom DnD MIME: avoids collision with browser-default drag types. */
export const COMPONENT_DND_MIME = 'application/andes-component-type';
