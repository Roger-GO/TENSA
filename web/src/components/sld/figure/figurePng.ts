/**
 * A figure as a PNG: its SVG drawn onto a canvas at the resolution asked
 * for, and written with that resolution in the file.
 *
 * One px of the diagram is 1/96 inch, so a figure rasterised at 300 dpi is
 * 300/96 times as many pixels across as the diagram is wide. The resolution
 * also goes into the file (the `pHYs` chunk), which is what a program that
 * places the image reads its real size from.
 */

/** Px of the diagram per inch. */
export const PX_PER_INCH = 96;

/**
 * The most pixels a browser draws on one canvas, with room to spare: the
 * longest side, and the whole area. Past either the canvas comes back empty
 * or the tab runs out of memory.
 */
export const MAX_PNG_SIDE = 16_384;
export const MAX_PNG_PIXELS = 120_000_000;

/** How many pixels a figure `width` by `height` px of the diagram is at `dpi`. */
export function pngSize(
  width: number,
  height: number,
  dpi: number,
): { width: number; height: number } {
  const scale = dpi / PX_PER_INCH;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Why a PNG of that many pixels cannot be made, or `null` when it can. */
export function pngRefusal(size: { width: number; height: number }): string | null {
  const tooLarge =
    size.width > MAX_PNG_SIDE ||
    size.height > MAX_PNG_SIDE ||
    size.width * size.height > MAX_PNG_PIXELS;
  return tooLarge
    ? `${size.width} x ${size.height} pixels is more than a browser can draw. Choose a lower resolution, or save the figure as SVG or PDF, which have no pixels.`
    : null;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** The CRC-32 a PNG chunk ends with, over its type and its data. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The PNG `png` with its resolution set to `dpi`: a `pHYs` chunk in pixels
 * per metre, in place of the one it has or after its header. Anything that
 * is not a PNG is given back as it is.
 */
export function withPngDpi(png: Uint8Array, dpi: number): Uint8Array {
  if (png.length < 33 || PNG_SIGNATURE.some((byte, i) => png[i] !== byte)) return png;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const perMetre = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const chunkView = new DataView(chunk.buffer);
  chunkView.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  chunkView.setUint32(8, perMetre);
  chunkView.setUint32(12, perMetre);
  chunk[16] = 1; // The unit is the metre.
  chunkView.setUint32(17, crc32(chunk.subarray(4, 17)));
  // The header chunk is first and 25 bytes long; the chunks after it are
  // walked for a resolution that is already there.
  const parts: Uint8Array[] = [png.subarray(0, 33), chunk];
  let at = 33;
  while (at + 12 <= png.length) {
    const length = view.getUint32(at);
    const end = at + 12 + length;
    const type = String.fromCharCode(png[at + 4]!, png[at + 5]!, png[at + 6]!, png[at + 7]!);
    if (type !== 'pHYs') parts.push(png.subarray(at, Math.min(end, png.length)));
    at = end;
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The figure could not be drawn as an image.'));
    img.src = src;
  });
}

/**
 * The SVG of a figure `width` by `height` px of the diagram, rasterised at
 * `dpi`. Throws with the reason when the picture would be larger than a
 * browser can draw, or when the browser gives no picture back.
 */
export async function svgToPng(
  svg: string,
  width: number,
  height: number,
  dpi: number,
): Promise<Blob> {
  const size = pngSize(width, height, dpi);
  const refusal = pngRefusal(size);
  if (refusal !== null) throw new Error(refusal);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('The browser gave no canvas to draw the figure on.');
    ctx.drawImage(img, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((made) => resolve(made), 'image/png');
    });
    if (blob === null) throw new Error('The browser could not write the figure as a PNG.');
    const bytes = withPngDpi(new Uint8Array(await blob.arrayBuffer()), dpi);
    // A copy in a buffer of its own, which is what a Blob takes.
    return new Blob([new Uint8Array(bytes)], { type: 'image/png' });
  } finally {
    URL.revokeObjectURL(url);
  }
}
