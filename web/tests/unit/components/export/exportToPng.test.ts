/**
 * Tests for the PNG exporter.
 *
 * `html-to-image` is mocked because jsdom can't actually rasterise a
 * subtree to PNG. We assert on the contract: the wrapper passes the
 * element + options through, returns the Blob, surfaces null for
 * zero-sized elements, and applies pixelRatio defaults.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { toBlobSpy } = vi.hoisted(() => ({ toBlobSpy: vi.fn() }));

vi.mock('html-to-image', () => ({
  toBlob: toBlobSpy,
}));

import { elementToPng, svgToPng } from '@/components/export/exportToPng';

beforeEach(() => {
  toBlobSpy.mockReset();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('elementToPng', () => {
  it('returns null for a zero-sized element without calling html-to-image', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    // jsdom default getBoundingClientRect → all zeros.
    const blob = await elementToPng(el);
    expect(blob).toBeNull();
    expect(toBlobSpy).not.toHaveBeenCalled();
  });

  it('returns the blob from html-to-image when the element has size', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    // Override jsdom's bounding rect to a non-zero size.
    el.getBoundingClientRect = () =>
      ({
        width: 600,
        height: 200,
        top: 0,
        left: 0,
        right: 600,
        bottom: 200,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    const fake = new Blob(['png-bytes'], { type: 'image/png' });
    toBlobSpy.mockResolvedValue(fake);
    const blob = await elementToPng(el, { pixelRatio: 2, backgroundColor: '#fff' });
    expect(blob).toBe(fake);
    expect(toBlobSpy).toHaveBeenCalledTimes(1);
    const [target, opts] = toBlobSpy.mock.calls[0]!;
    expect(target).toBe(el);
    expect(opts.pixelRatio).toBe(2);
    expect(opts.backgroundColor).toBe('#fff');
  });

  it('forwards backgroundColor=null as transparent (undefined option)', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    el.getBoundingClientRect = () =>
      ({
        width: 100,
        height: 100,
        top: 0,
        left: 0,
        right: 100,
        bottom: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    toBlobSpy.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    await elementToPng(el, { backgroundColor: null });
    expect(toBlobSpy.mock.calls[0]?.[1]?.backgroundColor).toBeUndefined();
  });

  it('happy path: returns a non-empty image/png Blob', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    el.getBoundingClientRect = () =>
      ({
        width: 200,
        height: 100,
        top: 0,
        left: 0,
        right: 200,
        bottom: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    toBlobSpy.mockResolvedValue(
      new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
    );
    const blob = await elementToPng(el);
    expect(blob).not.toBeNull();
    expect(blob!.type).toBe('image/png');
    expect(blob!.size).toBeGreaterThan(0);
  });
});

describe('svgToPng', () => {
  it('returns null for a zero-sized SVG', async () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    document.body.appendChild(svg);
    const blob = await svgToPng(svg);
    expect(blob).toBeNull();
  });
});
