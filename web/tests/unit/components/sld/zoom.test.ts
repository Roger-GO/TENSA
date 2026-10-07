/**
 * When the diagram counts as too small to read, the zoom an element is
 * shown at when the user asks where it is, and the room a fit of the
 * diagram leaves for what floats over its corners.
 */
import { describe, expect, it, vi } from 'vitest';

// `zoom.ts` imports React Flow's store hook for `useTooSmallZoomPercent`; the
// rules under test here are the pure ones.
vi.mock('@xyflow/react', () => ({ useStore: () => null }));

import {
  FULL_ZOOM,
  LEGIBLE_ZOOM,
  fitPadding,
  isTooSmallToRead,
  locateZoom,
} from '@/components/sld/zoom';

describe('isTooSmallToRead', () => {
  it('is true under the zoom at which the names can still be read', () => {
    expect(isTooSmallToRead(0.19)).toBe(true);
    expect(isTooSmallToRead(LEGIBLE_ZOOM - 0.01)).toBe(true);
  });

  it('is false from that zoom up', () => {
    expect(isTooSmallToRead(LEGIBLE_ZOOM)).toBe(false);
    expect(isTooSmallToRead(1)).toBe(false);
    expect(isTooSmallToRead(2)).toBe(false);
  });
});

describe('locateZoom', () => {
  it('is full size for a diagram too small to read', () => {
    expect(locateZoom(0.1)).toBe(FULL_ZOOM);
    expect(locateZoom(0.19)).toBe(FULL_ZOOM);
  });

  it('is the zoom the diagram has when that can be read, closer or further than full size', () => {
    expect(locateZoom(LEGIBLE_ZOOM)).toBe(LEGIBLE_ZOOM);
    expect(locateZoom(0.8)).toBe(0.8);
    expect(locateZoom(1.7)).toBe(1.7);
  });
});

describe('fitPadding', () => {
  const px = (value: string): number => Number(value.replace('px', ''));

  /** The zoom a fit ends at, and where the diagram then is in the pane. */
  function fitted(
    pane: { width: number; height: number },
    diagram: { width: number; height: number },
  ) {
    const padding = fitPadding(pane, diagram);
    const [top, right, bottom, left] = [
      px(padding.top),
      px(padding.right),
      px(padding.bottom),
      px(padding.left),
    ];
    const zoom = Math.min(
      (pane.width - left - right) / diagram.width,
      (pane.height - top - bottom) / diagram.height,
    );
    const [width, height] = [diagram.width * zoom, diagram.height * zoom];
    // Centred in the room the padding leaves, as React Flow fits it.
    const x = left + (pane.width - left - right - width) / 2;
    const y = top + (pane.height - top - bottom - height) / 2;
    return { zoom, box: { left: x, right: x + width, top: y, bottom: y + height } };
  }

  const PANE = { width: 1200, height: 700 };
  // The minimap with the search button, at the bottom right of the pane,
  // and the zoom controls at its bottom left.
  const minimap = { left: PANE.width - 232, top: PANE.height - 176 };
  const controls = { right: 56, top: PANE.height - 132 };

  for (const [name, diagram] of [
    ['a wide diagram', { width: 2400, height: 600 }],
    ['a tall diagram', { width: 500, height: 2000 }],
    ['a diagram the shape of the pane', { width: 1200, height: 700 }],
    ['a single bus', { width: 92, height: 40 }],
  ] as const) {
    it(`keeps ${name} out from behind the minimap and the zoom controls`, () => {
      const { box } = fitted(PANE, diagram);
      const behindMinimap = box.right > minimap.left && box.bottom > minimap.top;
      const behindControls = box.left < controls.right && box.bottom > controls.top;
      expect(behindMinimap).toBe(false);
      expect(behindControls).toBe(false);
      // And inside the pane, with a margin all round.
      expect(box.left).toBeGreaterThanOrEqual(24);
      expect(box.top).toBeGreaterThanOrEqual(24);
      expect(box.right).toBeLessThanOrEqual(PANE.width - 24);
      expect(box.bottom).toBeLessThanOrEqual(PANE.height - 24);
    });
  }

  it('stands a wide diagram over the minimap and a tall one beside it, whichever shows it larger', () => {
    const wide = fitPadding(PANE, { width: 2400, height: 600 });
    expect(wide).toEqual({ top: '24px', right: '24px', bottom: '176px', left: '24px' });
    const tall = fitPadding(PANE, { width: 500, height: 2000 });
    expect(tall).toEqual({ top: '24px', right: '232px', bottom: '24px', left: '56px' });
    // Either is the better of the two for its diagram.
    const zoomOf = (diagram: { width: number; height: number }, across: number, down: number) =>
      Math.min((PANE.width - across) / diagram.width, (PANE.height - down) / diagram.height);
    expect(fitted(PANE, { width: 2400, height: 600 }).zoom).toBeGreaterThanOrEqual(
      zoomOf({ width: 2400, height: 600 }, 232 + 56, 48),
    );
    expect(fitted(PANE, { width: 500, height: 2000 }).zoom).toBeGreaterThanOrEqual(
      zoomOf({ width: 500, height: 2000 }, 48, 24 + 176),
    );
  });

  it('answers for a diagram with no size, and for a pane that has none yet', () => {
    expect(fitPadding(PANE, { width: 0, height: 0 }).top).toBe('24px');
    expect(fitPadding({ width: 0, height: 0 }, { width: 800, height: 400 }).left).toMatch(
      /^\d+px$/,
    );
  });
});
