/**
 * When the diagram counts as too small to read, and the zoom an element is
 * shown at when the user asks where it is.
 */
import { describe, expect, it, vi } from 'vitest';

// `zoom.ts` imports React Flow's store hook for `useTooSmallZoomPercent`; the
// rules under test here are the pure ones.
vi.mock('@xyflow/react', () => ({ useStore: () => null }));

import { FULL_ZOOM, LEGIBLE_ZOOM, isTooSmallToRead, locateZoom } from '@/components/sld/zoom';

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
