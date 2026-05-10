/**
 * Pure helpers + constants for the SLD line-flow direction arrow
 * (Unit 19). Lives in its own module so ``LineFlowArrow.tsx`` can be a
 * components-only file (keeping React Refresh happy) and so the math
 * is testable / reusable without dragging the React tree along.
 */

/** Minimum visible arrow size (pixels). Below this the glyph is hard to see. */
export const ARROW_MIN_SIZE = 6;
/** Maximum arrow size (pixels). Above this the glyph crowds the path. */
export const ARROW_MAX_SIZE = 14;
/**
 * Default magnitude (MW) at which the arrow saturates to ``ARROW_MAX_SIZE``.
 * Substrate doesn't surface a per-case maximum today; this value is large
 * enough to cover transmission lines on the bundled cases (kundur, IEEE 14,
 * NPCC) without clipping the path.
 */
export const ARROW_SAT_MW = 1000;

/**
 * Map an absolute power magnitude to an arrow side length, linearly
 * interpolating from ``ARROW_MIN_SIZE`` (at zero) to ``ARROW_MAX_SIZE``
 * (at ``satMw``). Pure / exported for testing.
 */
export function arrowSizeFromMw(absMw: number, satMw = ARROW_SAT_MW): number {
  if (!Number.isFinite(absMw) || absMw <= 0) return ARROW_MIN_SIZE;
  const ratio = Math.min(1, absMw / Math.max(satMw, 1));
  return ARROW_MIN_SIZE + ratio * (ARROW_MAX_SIZE - ARROW_MIN_SIZE);
}
