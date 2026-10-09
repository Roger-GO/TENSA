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
  drawerKeepsTooSmall,
  fitPadding,
  fittedZoom,
  isTooSmallToRead,
  locateZoom,
  middleOfDiagram,
  withinPane,
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

describe('fittedZoom', () => {
  it('is the zoom the padding of a fit leaves a diagram, so it can be known before the fit', () => {
    // A wide diagram stands over the minimap: 24 px each side, 24 over and 176 under.
    expect(fittedZoom({ width: 1200, height: 700 }, { width: 2400, height: 600 })).toBeCloseTo(
      Math.min((1200 - 48) / 2400, (700 - 200) / 600),
    );
    // A tall one stands between the zoom controls and the minimap.
    expect(fittedZoom({ width: 1200, height: 700 }, { width: 500, height: 2000 })).toBeCloseTo(
      Math.min((1200 - 288) / 500, (700 - 48) / 2000),
    );
  });

  it('is too small to read for a diagram of some size in a pane a hundred pixels high', () => {
    const zoom = fittedZoom({ width: 1200, height: 110 }, { width: 1800, height: 1100 });
    expect(isTooSmallToRead(zoom)).toBe(true);
    // The same diagram in the room a lowered drawer gives it can be read.
    expect(
      isTooSmallToRead(fittedZoom({ width: 1200, height: 700 }, { width: 1800, height: 1100 })),
    ).toBe(false);
  });

  it('never goes past full size, and is nothing in a pane with no room', () => {
    expect(fittedZoom({ width: 1200, height: 700 }, { width: 92, height: 40 })).toBe(FULL_ZOOM);
    expect(fittedZoom({ width: 100, height: 20 }, { width: 800, height: 400 })).toBe(0);
  });
});

describe('drawerKeepsTooSmall', () => {
  const IEEE14 = { width: 600, height: 1150 };

  it('is so for a diagram a tall drawer leaves a strip, which the room of the drawer makes readable', () => {
    // A window 485 high with the drawer open: the diagram has about 110.
    expect(drawerKeepsTooSmall({ width: 1100, height: 110 }, 520, IEEE14)).toBe(true);
  });

  it('is not so for a diagram that can be read as it is', () => {
    expect(drawerKeepsTooSmall({ width: 1100, height: 600 }, 300, IEEE14)).toBe(false);
  });

  it('is not so for a diagram that is too small with or without the drawer', () => {
    // A case of a hundred buses: lowering the drawer takes the tables and gives nothing.
    const large = { width: 6000, height: 5000 };
    expect(drawerKeepsTooSmall({ width: 1100, height: 250 }, 500, large)).toBe(false);
  });

  it('is not so in a pane of a usable height, however small the diagram is fitted there', () => {
    // A laptop window with the drawer at its usual third: the diagram is
    // small, the tables are where the user expects them, and both stay.
    const pane = { width: 700, height: 400 };
    expect(isTooSmallToRead(fittedZoom(pane, IEEE14))).toBe(true);
    expect(isTooSmallToRead(fittedZoom({ width: 700, height: 650 }, IEEE14))).toBe(false);
    expect(drawerKeepsTooSmall(pane, 250, IEEE14)).toBe(false);
    // The same diagram in a strip is another matter.
    expect(drawerKeepsTooSmall({ width: 700, height: 240 }, 410, IEEE14)).toBe(true);
  });

  it('is not so for a pane that is not on screen, or a drawer that has nothing to give', () => {
    expect(drawerKeepsTooSmall({ width: 0, height: 0 }, 520, IEEE14)).toBe(false);
    expect(drawerKeepsTooSmall({ width: 1100, height: 110 }, 0, IEEE14)).toBe(false);
  });
});

describe('middleOfDiagram', () => {
  const box = (x: number, y: number, width = 100, height = 20) => ({ x, y, width, height });

  it('is the middle of the box nearest to the middle of them all, not the ground between them', () => {
    // Two buses far apart and a load between them, off the middle.
    const boxes = [box(0, 0), box(0, 1000), box(300, 450, 40, 30)];
    // The middle of the whole is (170, 510), where nothing is drawn.
    expect(middleOfDiagram(boxes)).toEqual({ x: 320, y: 465 });
  });

  it('is the middle of the one box of a diagram that has one, and nothing for none', () => {
    expect(middleOfDiagram([box(40, 60)])).toEqual({ x: 90, y: 70 });
    expect(middleOfDiagram([])).toBeNull();
  });
});

describe('withinPane', () => {
  const pane = { left: 300, right: 1300, top: 100, bottom: 700 };

  it('takes a line that shows whole, with room to spare, as in view', () => {
    expect(
      withinPane(
        [
          { x: 400, y: 200 },
          { x: 400, y: 500 },
          { x: 900, y: 500 },
        ],
        pane,
      ),
    ).toBe(true);
  });

  it('does not take one that runs out of the pane, or up to its edge', () => {
    expect(
      withinPane(
        [
          { x: 400, y: 200 },
          { x: 1400, y: 200 },
        ],
        pane,
      ),
    ).toBe(false);
    expect(
      withinPane(
        [
          { x: 400, y: 200 },
          { x: 400, y: 695 },
        ],
        pane,
      ),
    ).toBe(false);
    // With no margin asked for, the edge itself is in view.
    expect(
      withinPane(
        [
          { x: 400, y: 200 },
          { x: 400, y: 695 },
        ],
        pane,
        0,
      ),
    ).toBe(true);
  });

  it('takes nothing as in view of a pane that has no size yet', () => {
    expect(withinPane([{ x: 0, y: 0 }], { left: 0, right: 0, top: 0, bottom: 0 })).toBe(false);
  });
});
