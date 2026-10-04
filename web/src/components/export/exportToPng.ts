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
/**
 * Attribute that keeps a node out of a PNG export. The export menu's own
 * trigger carries it, so a panel that holds a menu can be rasterised as it
 * stands without the "Export" button showing up in the picture; a panel's
 * other controls (a zoom reset, a scale toggle) can carry it too.
 */
export const EXPORT_IGNORE_ATTR = 'data-export-ignore';

/**
 * `html-to-image` calls its filter on text nodes as well as elements (the
 * `HTMLElement` in its type is optimistic), so only elements are inspected.
 */
function keepInPng(node: HTMLElement): boolean {
  return !(node instanceof Element) || !node.hasAttribute(EXPORT_IGNORE_ATTR);
}

/**
 * The properties that decide how SVG content is painted. `html-to-image` copies
 * an `<svg>` as markup and does not visit what is inside it, so none of its
 * descendants get their computed style written in. The charts style their SVG
 * with classes (`fill-danger`, `stroke-border`, `text-[6px]`), and the
 * rasterised copy has no stylesheet to resolve them against: points come out
 * black, gridlines vanish and labels take the surrounding font size.
 */
const SVG_PAINT_PROPERTIES = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'color',
  'display',
  'visibility',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'letter-spacing',
  'text-anchor',
  'dominant-baseline',
  'text-decoration',
] as const;

/**
 * Write the computed paint properties onto every SVG descendant of `root`, so
 * `html-to-image` copies them with the markup. The values equal what is on
 * screen, so the page does not change; the returned function puts each node's
 * own `style` attribute back, and the caller runs it once the picture is taken.
 */
function inlineSvgPaint(root: HTMLElement): () => void {
  const saved: Array<[SVGElement, string | null]> = [];
  for (const node of root.querySelectorAll('svg *')) {
    // Left-out nodes are not copied, so there is nothing to style.
    if (!(node instanceof SVGElement) || node.closest(`[${EXPORT_IGNORE_ATTR}]`) !== null) continue;
    const computed = getComputedStyle(node);
    saved.push([node, node.getAttribute('style')]);
    for (const property of SVG_PAINT_PROPERTIES) {
      node.style.setProperty(property, computed.getPropertyValue(property));
    }
  }
  return () => {
    for (const [node, original] of saved) {
      if (original === null) node.removeAttribute('style');
      else node.setAttribute('style', original);
    }
  };
}

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
  // Loaded here, not at the top of the module: the rasteriser is only needed
  // when someone exports a PNG, and the menu that calls this is on every page.
  const { toBlob } = await import('html-to-image');
  const restoreSvgStyles = inlineSvgPaint(element);
  try {
    return await toBlob(element, {
      pixelRatio,
      backgroundColor,
      cacheBust: true,
      filter: keepInPng,
      // html-to-image returns a `Blob | null`; null is its "browser
      // returned an empty data URL" path, surfaced as a hard failure
      // upstream so the caller can show the error toast.
    });
  } finally {
    restoreSvgStyles();
  }
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
