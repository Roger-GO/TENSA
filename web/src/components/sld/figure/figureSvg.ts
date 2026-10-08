/**
 * A figure as an SVG document.
 *
 * Plain SVG and nothing else: paths, rectangles, circles and texts, each
 * with its own presentation attributes, no stylesheet, no script, no
 * foreign object and no reference to anything outside the file, so that
 * whatever reads SVG can read it. One user unit is one px of the diagram,
 * which is 1/96 inch.
 *
 * A text names the font of the figure with the fonts that are drawn to the
 * same widths, and says how wide it is (`textLength`), so that it takes the
 * room the figure gave it on a machine that has none of them.
 *
 * Pure: nothing read but the arguments.
 */
import type { Figure, FigureItem, PathStep, Stroke } from './displayList';
import { SVG_FONT_FAMILY } from './fontMetrics';

/** A number as it is written into the file: two decimals at the most, no trailing zeros. */
function n(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** `text` with the characters XML reads as markup written out, and the ones it forbids left out. */
export function escapeXml(text: string): string {
  return (
    text
      // The control characters XML 1.0 does not allow in a document.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  );
}

function pathData(steps: readonly PathStep[]): string {
  return steps
    .map((step) => {
      switch (step.op) {
        case 'Z':
          return 'Z';
        case 'C':
          return `C${n(step.x1)} ${n(step.y1)} ${n(step.x2)} ${n(step.y2)} ${n(step.x)} ${n(step.y)}`;
        default:
          return `${step.op}${n(step.x)} ${n(step.y)}`;
      }
    })
    .join('');
}

function paint(stroke: Stroke | undefined, fill: string | undefined): string {
  const parts = [`fill="${fill ?? 'none'}"`];
  if (stroke !== undefined) {
    parts.push(`stroke="${stroke.colour}"`, `stroke-width="${n(stroke.width)}"`);
    parts.push('stroke-linejoin="round"');
    if (stroke.cap === 'round') parts.push('stroke-linecap="round"');
    if (stroke.dash !== undefined) parts.push(`stroke-dasharray="${stroke.dash.map(n).join(' ')}"`);
  }
  return parts.join(' ');
}

function element(item: FigureItem): string {
  switch (item.kind) {
    case 'path':
      return `<path d="${pathData(item.steps)}" ${paint(item.stroke, item.fill)}/>`;
    case 'rect': {
      const radius = item.radius !== undefined && item.radius > 0 ? ` rx="${n(item.radius)}"` : '';
      return `<rect x="${n(item.x)}" y="${n(item.y)}" width="${n(item.width)}" height="${n(item.height)}"${radius} ${paint(item.stroke, item.fill)}/>`;
    }
    case 'circle':
      return `<circle cx="${n(item.cx)}" cy="${n(item.cy)}" r="${n(item.r)}" ${paint(item.stroke, item.fill)}/>`;
    case 'text': {
      const turned =
        item.rotate !== undefined && item.rotate !== 0
          ? ` transform="rotate(${n(item.rotate)} ${n(item.x)} ${n(item.y)})"`
          : '';
      const anchor = item.anchor === 'start' ? '' : ` text-anchor="${item.anchor}"`;
      const length =
        item.width > 0 ? ` textLength="${n(item.width)}" lengthAdjust="spacingAndGlyphs"` : '';
      return `<text x="${n(item.x)}" y="${n(item.y)}"${anchor} font-family="${SVG_FONT_FAMILY[item.font]}" font-size="${n(item.size)}" fill="${item.colour}"${length}${turned}>${escapeXml(item.text)}</text>`;
    }
  }
}

export interface SvgOptions {
  /** What the figure is of, for the title of the document. */
  title?: string;
}

/** `figure` as the text of an SVG file. */
export function figureToSvg(figure: Figure, options: SvgOptions = {}): string {
  const { x, y, width, height } = figure.box;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" viewBox="${n(x)} ${n(y)} ${n(width)} ${n(height)}">`,
  ];
  if (options.title !== undefined && options.title !== '') {
    lines.push(`<title>${escapeXml(options.title)}</title>`);
  }
  lines.push(
    `<rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" fill="${figure.paper}"/>`,
  );
  for (const item of figure.items) lines.push(element(item));
  lines.push('</svg>');
  return `${lines.join('\n')}\n`;
}
