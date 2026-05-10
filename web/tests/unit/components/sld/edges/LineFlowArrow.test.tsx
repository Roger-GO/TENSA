/**
 * Unit 19 — LineFlowArrow tests.
 *
 * Two surfaces to lock down:
 *
 *  1. The pure ``arrowSizeFromMw`` mapping — clamp + interpolation.
 *  2. The component itself — emits a ``<polygon>`` with the right
 *     direction, transform, and CSS transition so the parent edge
 *     gets a smooth sign-flip animation.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import { LineFlowArrow } from '@/components/sld/edges/LineFlowArrow';
import {
  ARROW_MIN_SIZE,
  ARROW_MAX_SIZE,
  ARROW_SAT_MW,
  arrowSizeFromMw,
} from '@/components/sld/edges/lineFlowArrowMath';

function svg(children: React.ReactNode): React.ReactElement {
  return <svg>{children}</svg>;
}

describe('arrowSizeFromMw', () => {
  it('returns ARROW_MIN_SIZE at zero magnitude', () => {
    expect(arrowSizeFromMw(0)).toBe(ARROW_MIN_SIZE);
  });

  it('returns ARROW_MIN_SIZE for non-finite / negative inputs (defensive)', () => {
    expect(arrowSizeFromMw(NaN)).toBe(ARROW_MIN_SIZE);
    expect(arrowSizeFromMw(-50)).toBe(ARROW_MIN_SIZE);
  });

  it('returns ARROW_MAX_SIZE at the saturation magnitude', () => {
    expect(arrowSizeFromMw(ARROW_SAT_MW)).toBe(ARROW_MAX_SIZE);
  });

  it('clamps at ARROW_MAX_SIZE above saturation', () => {
    expect(arrowSizeFromMw(ARROW_SAT_MW * 5)).toBe(ARROW_MAX_SIZE);
  });

  it('linearly interpolates between MIN and MAX', () => {
    // Halfway through the saturation range → halfway between min and max.
    const mid = arrowSizeFromMw(ARROW_SAT_MW / 2);
    expect(mid).toBeCloseTo((ARROW_MIN_SIZE + ARROW_MAX_SIZE) / 2, 5);
  });

  it('honors a custom saturation MW', () => {
    // With satMw = 100, a 50 MW flow should be at the half-size point.
    expect(arrowSizeFromMw(50, 100)).toBeCloseTo((ARROW_MIN_SIZE + ARROW_MAX_SIZE) / 2, 5);
    expect(arrowSizeFromMw(100, 100)).toBe(ARROW_MAX_SIZE);
  });
});

describe('<LineFlowArrow />', () => {
  it('emits a polygon with the forward direction + tangent rotation', () => {
    const { getByTestId } = render(
      svg(<LineFlowArrow x={50} y={20} angleDeg={0} direction="forward" absMw={500} />),
    );
    const arrow = getByTestId('line-flow-arrow');
    expect(arrow.tagName.toLowerCase()).toBe('polygon');
    expect(arrow.getAttribute('data-direction')).toBe('forward');
    // 500 MW under the default 1000 MW saturation → midpoint size.
    const expectedSize = arrowSizeFromMw(500);
    expect(arrow.getAttribute('data-arrow-size')).toBe(expectedSize.toFixed(2));
    // Forward at angle 0 → no rotation flip; the transform should
    // include the anchor + a 0deg rotation.
    expect(arrow.getAttribute('style')).toContain('translate(50px, 20px)');
    expect(arrow.getAttribute('style')).toContain('rotate(0deg)');
  });

  it('rotates 180° on reverse direction', () => {
    const { getByTestId } = render(
      svg(<LineFlowArrow x={0} y={0} angleDeg={45} direction="reverse" absMw={100} />),
    );
    const arrow = getByTestId('line-flow-arrow');
    expect(arrow.getAttribute('data-direction')).toBe('reverse');
    // 45° tangent + 180° flip = 225°.
    expect(arrow.getAttribute('style')).toContain('rotate(225deg)');
  });

  it('declares a CSS transition on transform with the cubic-out easing token', () => {
    // The whole point of Unit 19 — sign-flip animates instead of snapping.
    // We assert the transition string mentions the property + the easing
    // token (the global reduced-motion media query in styles/globals.css
    // collapses the duration to 0ms when the user prefers it).
    const { getByTestId } = render(
      svg(<LineFlowArrow x={0} y={0} direction="forward" absMw={0} />),
    );
    const arrow = getByTestId('line-flow-arrow');
    const style = arrow.getAttribute('style') ?? '';
    expect(style).toContain('transform var(--duration-base) var(--ease-out-quart)');
  });

  it('keeps the transition declaration stable across direction flips', () => {
    // If the transition string churned every render, CSS would never
    // interpolate the rotation. Verify the transition is identical
    // before and after a flip; only the rotate value changes.
    const { getByTestId, rerender } = render(
      svg(<LineFlowArrow x={0} y={0} direction="forward" absMw={100} />),
    );
    const arrow = getByTestId('line-flow-arrow');
    const styleBefore = arrow.getAttribute('style') ?? '';
    const transitionPart = styleBefore
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('transition'));
    expect(transitionPart).toBeDefined();

    rerender(svg(<LineFlowArrow x={0} y={0} direction="reverse" absMw={100} />));
    const styleAfter = arrow.getAttribute('style') ?? '';
    const transitionAfter = styleAfter
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('transition'));
    expect(transitionAfter).toBe(transitionPart);
  });

  it('respects prefers-reduced-motion via the global media query (transition stays declared)', () => {
    // We don't override transition-duration inline — the global
    // ``@media (prefers-reduced-motion: reduce)`` rule in globals.css
    // does that with !important. Verify the inline style still declares
    // the transition (the cascade does the rest); a JSDOM matchMedia
    // assertion on the actual collapsed duration would only validate
    // that we wrote globals.css correctly, which is covered elsewhere.
    const { getByTestId } = render(
      svg(<LineFlowArrow x={0} y={0} direction="forward" absMw={50} />),
    );
    const arrow = getByTestId('line-flow-arrow');
    expect(arrow.getAttribute('style')).toContain('transition');
  });

  it('uses the supplied testid suffix so multiple arrows can coexist on the canvas', () => {
    const { getByTestId } = render(
      svg(<LineFlowArrow x={0} y={0} direction="forward" testid="line-flow-arrow-line-3" />),
    );
    expect(getByTestId('line-flow-arrow-line-3')).toBeInTheDocument();
  });
});
