/** A figure as a PNG: how many pixels it is at a resolution, and the resolution written into it. */
import { describe, expect, it } from 'vitest';
import {
  MAX_PNG_PIXELS,
  MAX_PNG_SIDE,
  crc32,
  pngRefusal,
  pngSize,
  withPngDpi,
} from '@/components/sld/figure/figurePng';

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const u32 = (value: number): number[] => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const chunk = (type: string, data: number[]): number[] => [
  ...u32(data.length),
  ...ascii(type),
  ...data,
  ...u32(crc32(new Uint8Array([...ascii(type), ...data]))),
];
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = chunk('IHDR', [...u32(2), ...u32(3), 8, 6, 0, 0, 0]);
const IDAT = chunk('IDAT', [1, 2, 3, 4, 5]);
const IEND = chunk('IEND', []);

/** The chunks of a PNG, each with its type and its data. */
function chunksOf(png: Uint8Array): { type: string; data: number[]; crcOk: boolean }[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: { type: string; data: number[]; crcOk: boolean }[] = [];
  for (let at = 8; at < png.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    out.push({
      type,
      data: [...png.subarray(at + 8, at + 8 + length)],
      crcOk: view.getUint32(at + 8 + length) === crc32(png.subarray(at + 4, at + 8 + length)),
    });
    at += 12 + length;
  }
  return out;
}

describe('pngSize', () => {
  it('counts 96 px of the diagram to the inch', () => {
    expect(pngSize(601, 1151, 96)).toEqual({ width: 601, height: 1151 });
    expect(pngSize(601, 1151, 300)).toEqual({ width: 1878, height: 3597 });
    expect(pngSize(601, 1151, 600)).toEqual({ width: 3756, height: 7194 });
    expect(pngSize(960, 480, 150)).toEqual({ width: 1500, height: 750 });
  });

  it('is never without a pixel', () => {
    expect(pngSize(0, 0, 300)).toEqual({ width: 1, height: 1 });
  });
});

describe('pngRefusal', () => {
  it('takes a picture a browser can draw', () => {
    expect(pngRefusal({ width: 3756, height: 7194 })).toBeNull();
    expect(pngRefusal({ width: MAX_PNG_SIDE, height: 7000 })).toBeNull();
  });

  it('refuses one that is too long on a side or too large in all, and says what to do', () => {
    const tooLong = pngRefusal({ width: MAX_PNG_SIDE + 1, height: 10 });
    expect(tooLong).toMatch(/16385 x 10 pixels is more than a browser can draw/);
    expect(tooLong).toMatch(/lower resolution, or save the figure as SVG or PDF/);
    expect(pngRefusal({ width: 10, height: MAX_PNG_SIDE + 1 })).not.toBeNull();
    // The IEEE 118-bus diagram at 600 dpi.
    expect(14_700 * 36_250).toBeGreaterThan(MAX_PNG_PIXELS);
    expect(pngRefusal({ width: 14_700, height: 36_250 })).not.toBeNull();
  });
});

describe('crc32', () => {
  it('gives the check values the PNG format is known by', () => {
    // The CRC of an empty IEND chunk, which every PNG ends with.
    expect(crc32(new Uint8Array(ascii('IEND')))).toBe(0xae426082);
    expect(crc32(new Uint8Array(ascii('123456789')))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array([]))).toBe(0);
  });
});

describe('withPngDpi', () => {
  it('writes the resolution after the header, in pixels per metre, with a check that holds', () => {
    const png = new Uint8Array([...SIGNATURE, ...IHDR, ...IDAT, ...IEND]);
    const out = withPngDpi(png, 300);
    expect([...out.subarray(0, 8)]).toEqual(SIGNATURE);
    const chunks = chunksOf(out);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'pHYs', 'IDAT', 'IEND']);
    expect(chunks.every((c) => c.crcOk)).toBe(true);
    // 300 dots per inch are 11811 per metre, both ways, and the unit is the metre.
    expect(chunks[1]!.data).toEqual([...u32(11811), ...u32(11811), 1]);
    // The picture itself is what it was.
    expect(chunks[0]!.data).toEqual([...u32(2), ...u32(3), 8, 6, 0, 0, 0]);
    expect(chunks[2]!.data).toEqual([1, 2, 3, 4, 5]);
    expect(out.length).toBe(png.length + 21);
    // And the bytes handed in are left alone.
    expect(png.length).toBe(SIGNATURE.length + IHDR.length + IDAT.length + IEND.length);
  });

  it('puts its own in the place of a resolution the picture came with', () => {
    const old = chunk('pHYs', [...u32(3780), ...u32(3780), 1]);
    const png = new Uint8Array([...SIGNATURE, ...IHDR, ...old, ...IDAT, ...IEND]);
    const chunks = chunksOf(withPngDpi(png, 600));
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'pHYs', 'IDAT', 'IEND']);
    expect(chunks[1]!.data).toEqual([...u32(23622), ...u32(23622), 1]);
    expect(chunks.every((c) => c.crcOk)).toBe(true);
  });

  it('reads a picture that is a part of a larger buffer', () => {
    const padded = new Uint8Array([9, 9, 9, ...SIGNATURE, ...IHDR, ...IDAT, ...IEND]);
    const chunks = chunksOf(withPngDpi(padded.subarray(3), 96));
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'pHYs', 'IDAT', 'IEND']);
    expect(chunks[1]!.data).toEqual([...u32(3780), ...u32(3780), 1]);
  });

  it('gives back what is no PNG as it is', () => {
    const notOne = new Uint8Array(ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
    expect(withPngDpi(notOne, 300)).toBe(notOne);
    const short = new Uint8Array(SIGNATURE);
    expect(withPngDpi(short, 300)).toBe(short);
  });
});
