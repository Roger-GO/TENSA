/**
 * PNG export for chart and SVG-canvas panels.
 *
 * Strategy: delegate to `html-to-image` (MIT-licensed, zero deps beyond
 * the browser's native canvas). For non-SVG containers (uPlot canvas +
 * surrounding axis labels + legend) it walks the live DOM, clones the
 * subtree into an off-screen iframe, rasterises via the browser's own
 * `<foreignObject>` + canvas pipeline, and returns a PNG `Blob`.
 *
 * For SVG-only containers (the SLD canvas) we have a faster purpose-
 * built path: serialise the SVG, wrap it in a `data:` URL, draw it onto
 * a `<canvas>` of the requested dimensions, and read back the PNG. This
 * avoids `html-to-image`'s overhead for the common SLD-export case
 * while still supporting the full DOM clone for anything else.
 *
 * Why not screenshot the entire viewport: per the v2.0 plan, exports
 * are panel-scoped — the user clicks a panel's Export menu and gets
 * just that panel. The chart container's bounding rect drives the PNG
 * dimensions; no scaling is applied unless `pixelRatio` is set
 * explicitly.
 */
import { toBlob } from 'html-to-image';

export interface ExportToPngOptions {
  /**
   * Pixel ratio for the rasterised output. Defaults to the device's
   * `devicePixelRatio` so retina displays produce 2x exports. Override
   * when the caller wants deterministic output (e.g., in tests or for
   * print).
   */
  pixelRatio?: number;
  /**
   * Background color. Defaults to white so a screenshot of a chart
   * with a transparent background still reads on a white wiki page or
   * PDF. Pass `null` to keep transparency.
   */
  backgroundColor?: string | null;
}

/**
 * Convert a DOM element (typically the chart container or any panel
 * wrapper) to a PNG `Blob`. Resolves to `null` when the element has no
 * intrinsic size yet — the caller should treat that as "not ready" and
 * surface a "no data" tooltip rather than as a hard error.
 *
 * Throws on rasterisation failure (browser permission errors, OOM,
 * etc.). The Export menu catches the throw and surfaces the
 * "Export failed" toast.
 */
export async function elementToPng(
  element: HTMLElement,
  options: ExportToPngOptions = {},
): Promise<Blob | null> {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  const pixelRatio =
    options.pixelRatio ??
    (typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1);
  const backgroundColor =
    options.backgroundColor === null ? undefined : (options.backgroundColor ?? '#ffffff');
  const blob = await toBlob(element, {
    pixelRatio,
    backgroundColor,
    cacheBust: true,
    // html-to-image returns a `Blob | null`; null is its "browser
    // returned an empty data URL" path, surfaced as a hard failure
    // upstream so the caller can show the error toast.
  });
  return blob;
}

/**
 * Convert an SVG element to a PNG `Blob` via a `<canvas>` rasterisation
 * path. Used by the SLD canvas export which is SVG-only and where the
 * `html-to-image` foreignObject pipeline would lose ReactFlow's edge
 * markers in some browsers (Safari < 17 has a known bug with nested
 * SVG masks inside foreignObject).
 *
 * Steps:
 *   1. Clone the SVG so any inline modifications (selection styling,
 *      hover state) are captured at the moment of export.
 *   2. Inline computed styles for nodes the cloned SVG references —
 *      `html-to-image` does this automatically; we replicate the
 *      essentials (stroke, fill, opacity) by serialising and letting
 *      the browser's SVG renderer pick up its own defaults.
 *   3. Serialise to an XML string + wrap as a `data:` URL.
 *   4. Draw onto an HTMLCanvasElement and `toBlob`.
 *
 * jsdom doesn't implement canvas drawing of SVGs, so under test we
 * mock this function or feed it a stub canvas. The default browser
 * implementation works in Chrome/Edge/Safari/Firefox 2024+.
 */
export async function svgToPng(
  svg: SVGElement,
  options: ExportToPngOptions = {},
): Promise<Blob | null> {
  const rect = svg.getBoundingClientRect();
  // `viewBox` falls back to bounding rect for SVGs that don't declare one.
  const widthCss = rect.width || svg.clientWidth || 0;
  const heightCss = rect.height || svg.clientHeight || 0;
  if (widthCss <= 0 || heightCss <= 0) return null;
  const pixelRatio =
    options.pixelRatio ??
    (typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1);
  const backgroundColor =
    options.backgroundColor === null ? null : (options.backgroundColor ?? '#ffffff');

  // Serialise via XMLSerializer — the standard path for SVG → string.
  // We clone first so any in-flight render mutations during
  // serialisation don't touch the live DOM.
  const cloned = svg.cloneNode(true) as SVGElement;
  // Ensure the standard SVG namespace is present so the serialised
  // string round-trips through `new Image()`.
  if (!cloned.getAttribute('xmlns')) {
    cloned.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }
  if (!cloned.getAttribute('xmlns:xlink')) {
    cloned.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  }
  const serialiser = new XMLSerializer();
  const svgString = serialiser.serializeToString(cloned);
  const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const svgUrl = URL.createObjectURL(svgBlob);

  try {
    const img = await loadImage(svgUrl);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(widthCss * pixelRatio));
    canvas.height = Math.max(1, Math.round(heightCss * pixelRatio));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    if (backgroundColor !== null) {
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await canvasToBlob(canvas);
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

/** Promise wrapper for `Image` loading. Rejects on `error`. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err instanceof Event ? new Error('Image load failed') : err);
    img.src = src;
  });
}

/** Promise wrapper for `canvas.toBlob`. Resolves with `null` on encode failure. */
function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}
