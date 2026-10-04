/**
 * Pure helpers + constants for the SLD line-flow direction arrow
 * (Unit 19). Lives in its own module so ``LineFlowArrow.tsx`` can be a
 * components-only file (keeping React Refresh happy) and so the math
 * is testable / reusable without dragging the React tree along.
 */

/** Minimum visible arrow size (pixels). Below this the glyph is hard to see. */
export const ARROW_MIN_SIZE = 7;
/** Maximum arrow size (pixels). Above this the glyph crowds the path. */
export const ARROW_MAX_SIZE = 15;
/**
 * Magnitude (MW) at which the arrow saturates to ``ARROW_MAX_SIZE`` when the
 * caller does not say what the case's largest flow is. The diagram does say
 * (``maxAbsFlowMw`` of the PF result), so that its largest flow draws the
 * biggest arrow whatever the case's size: with this fixed value every line of
 * a 100 MVA case such as IEEE 14 drew an arrow barely bigger than the smallest.
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

/** The result of ``maxAbsFlowMw`` per flow map. A PF result never mutates its map. */
const maxAbsFlowByMap = new WeakMap<object, number>();

/**
 * The largest ``|p|`` (MW) among the branch flows of a power flow result, which
 * is what the biggest arrow is scaled to. 0 for a map with no finite flow.
 *
 * Every edge asks for it on every render of a result, so it is worked out once
 * per map: a case with 2000 branches would otherwise read 2000 flows for each
 * of its 2000 edges.
 */
export function maxAbsFlowMw(flows: Readonly<Record<string, { readonly p: number }>>): number {
  const known = maxAbsFlowByMap.get(flows);
  if (known !== undefined) return known;
  let max = 0;
  for (const flow of Object.values(flows)) {
    const abs = Math.abs(flow.p);
    if (Number.isFinite(abs) && abs > max) max = abs;
  }
  maxAbsFlowByMap.set(flows, max);
  return max;
}
