/**
 * Directional flow arrow rendered at the midpoint of a line / transformer
 * edge (Unit 19 — SLD animation polish).
 *
 * The arrow is an SVG triangle (``<polygon>``) anchored at ``(x, y)`` and
 * rotated to point along the edge tangent. Two pieces of polish go on
 * top of the static glyph:
 *
 *  1. **Sign-flip animation.** When the line's flow reverses direction,
 *     the polygon rotates 180° rather than instantly snapping. We carry
 *     the direction in a single ``rotate`` transform whose value flips
 *     by 180°; a CSS ``transition`` on ``transform`` smooths the
 *     handover with the same ``--ease-out-quart`` easing as the bus
 *     voltage colour transitions in BusNode.
 *
 *  2. **Magnitude scaling.** Arrow size scales linearly with |P|,
 *     clamped to a perceptible range (``ARROW_MIN_SIZE`` …
 *     ``ARROW_MAX_SIZE``). The scaling defaults to a 1000 MW =
 *     max-size mapping when the case doesn't declare a per-case
 *     maximum (the substrate doesn't expose one today; v0.5 may
 *     surface it). This keeps very small flows visible without making
 *     big flows clip the path.
 *
 * Reduced-motion: the global ``@media (prefers-reduced-motion: reduce)``
 * rule in ``styles/globals.css`` collapses ``transition-duration`` to
 * ``0ms`` for all elements with ``!important``, so users that request
 * reduced motion get an instant flip with no extra wiring here.
 *
 * rAF integration: line-flow streaming today is post-PF only (a single
 * ``pflowResult`` re-render), so the CSS transition fires once per PF
 * update. If a future Unit streams line flows at 60 Hz, the canonical
 * place to debounce is the existing rAF loop in ``overlay.ts`` — the
 * loop should sample line flows alongside bus voltages and write to the
 * animation slice; the arrow component would then read from the slice
 * via a selector that only re-renders on direction or magnitude
 * threshold changes (matching the bus-band selective-redraw pattern).
 * No second rAF loop is needed.
 */
import { memo, type ReactElement } from 'react';
import { arrowSizeFromMw } from './lineFlowArrowMath';

export type FlowDirection = 'forward' | 'reverse';

interface LineFlowArrowProps {
  /** Anchor point along the edge path (canvas units). */
  x: number;
  y: number;
  /**
   * Tangent angle of the edge at ``(x, y)`` in DEGREES, measured CW from
   * the positive X axis. ``0`` points right (the polygon's natural
   * orientation); the component composes this with the direction flip
   * so the arrow head always lies along the path.
   */
  angleDeg?: number;
  /**
   * Sign of the active power flow. ``forward`` keeps the arrow pointing
   * along ``angleDeg``; ``reverse`` rotates 180° (animated).
   */
  direction: FlowDirection;
  /**
   * Absolute MW magnitude. Passed through ``arrowSizeFromMw`` to set the
   * polygon's side length. If omitted, the arrow renders at the minimum
   * size (used by tests + a defensive path when |P| isn't finite).
   */
  absMw?: number;
  /** Test hook — defaults to ``line-flow-arrow``; callers append the line idx. */
  testid?: string;
}

/**
 * Render a triangle pointing along the edge tangent, with a CSS
 * ``transform`` that animates on direction change.
 *
 * The polygon points are defined in a unit-ish local frame centered on
 * the origin so a single ``rotate(...)`` transform drives both the
 * tangent alignment AND the sign-flip flip.
 */
export const LineFlowArrow = memo(function LineFlowArrow({
  x,
  y,
  angleDeg = 0,
  direction,
  absMw,
  testid = 'line-flow-arrow',
}: LineFlowArrowProps): ReactElement {
  const size = arrowSizeFromMw(absMw ?? 0);
  // Triangle pointing right in local coords (apex at +half on X, base on
  // the −half X line). Centered on origin so the rotate pivots about
  // the anchor point.
  const half = size / 2;
  const base = size * 0.6;
  const points = `${half},0 ${-half},${-base / 2} ${-half},${base / 2}`;
  const rotation = (angleDeg + (direction === 'reverse' ? 180 : 0)) % 360;
  return (
    <polygon
      data-testid={testid}
      data-direction={direction}
      data-arrow-size={size.toFixed(2)}
      points={points}
      fill="var(--color-foreground)"
      stroke="var(--color-background)"
      strokeWidth={0.75}
      strokeLinejoin="round"
      style={{
        transform: `translate(${x}px, ${y}px) rotate(${rotation}deg)`,
        transformBox: 'fill-box',
        transformOrigin: 'center',
        transition: 'transform var(--duration-base) var(--ease-out-quart)',
      }}
    />
  );
});
