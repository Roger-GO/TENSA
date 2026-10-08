/**
 * A figure as a one-page PDF, written here and not by a library: the page is
 * the figure, every shape is a path and every text is text, set in one of
 * the fonts every PDF reader has (Helvetica, Times, Courier), so nothing is
 * rasterised: it scales without loss and its text can be selected. Nothing
 * is embedded either. A reader draws the three fonts itself, but a
 * publisher that asks for every font of a paper to be embedded will say so
 * of one that holds the figure, until the fonts are embedded on the way to
 * the final file.
 *
 * One px of the diagram is 0.75 pt (1/96 inch), as in the SVG. The file is
 * PDF 1.4 and ASCII throughout: a character outside ASCII is written as an
 * octal escape of its WinAnsi code, and one WinAnsi does not have as a
 * question mark. That keeps every offset of the cross-reference table equal
 * to a length in characters.
 *
 * Pure: nothing read but the arguments.
 */
import type { Figure, FigureColour, FigureItem, PathStep, Stroke } from './displayList';
import type { FigureFont } from './figureSettings';
import { PDF_FONT_NAME, textWidth } from './fontMetrics';
import { circleSteps, roundedRectSteps } from './pathData';

/** Points per px of the diagram. */
export const PT_PER_PX = 0.75;

/** A number as it is written into the file: three decimals at the most. */
function n(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** The three parts of `#rrggbb`, each from 0 to 1. */
function rgb(colour: FigureColour): string {
  const value = /^#([0-9a-f]{6})$/i.exec(colour)?.[1] ?? '000000';
  return [0, 2, 4].map((at) => n(parseInt(value.slice(at, at + 2), 16) / 255)).join(' ');
}

/** The characters WinAnsi has between 0x80 and 0x9f, by Unicode code point. */
const WIN_ANSI_HIGH: Readonly<Record<number, number>> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
  // A minus sign reads as a hyphen where the font has no minus.
  0x2212: 0x2d,
};

/** `text` as a PDF string in WinAnsi, written in ASCII. */
export function pdfString(text: string): string {
  let out = '(';
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0x3f;
    const code =
      point < 0x80 || (point >= 0xa0 && point <= 0xff) ? point : (WIN_ANSI_HIGH[point] ?? 0x3f);
    if (code === 0x28 || code === 0x29 || code === 0x5c) out += `\\${String.fromCharCode(code)}`;
    else if (code >= 0x20 && code < 0x7f) out += String.fromCharCode(code);
    else out += `\\${code.toString(8).padStart(3, '0')}`;
  }
  return `${out})`;
}

function pathOps(steps: readonly PathStep[]): string[] {
  return steps.map((step) => {
    switch (step.op) {
      case 'M':
        return `${n(step.x)} ${n(step.y)} m`;
      case 'L':
        return `${n(step.x)} ${n(step.y)} l`;
      case 'C':
        return `${n(step.x1)} ${n(step.y1)} ${n(step.x2)} ${n(step.y2)} ${n(step.x)} ${n(step.y)} c`;
      case 'Z':
        return 'h';
    }
  });
}

/** The operators that set how a shape is painted, and the one that paints it. */
function paintOps(stroke: Stroke | undefined, fill: FigureColour | undefined): [string[], string] {
  const set: string[] = [];
  if (fill !== undefined) set.push(`${rgb(fill)} rg`);
  if (stroke !== undefined) {
    set.push(`${rgb(stroke.colour)} RG`, `${n(stroke.width)} w`);
    set.push(`${stroke.cap === 'round' ? 1 : 0} J`);
    set.push(stroke.dash === undefined ? '[] 0 d' : `[${stroke.dash.map(n).join(' ')}] 0 d`);
  }
  const paint =
    fill !== undefined && stroke !== undefined
      ? 'B'
      : fill !== undefined
        ? 'f'
        : stroke !== undefined
          ? 'S'
          : 'n';
  return [set, paint];
}

function itemOps(item: FigureItem, fontName: (font: FigureFont) => string): string[] {
  if (item.kind === 'text') {
    if (item.text === '') return [];
    const natural = textWidth(item.text, item.font, item.size);
    // Set narrower where the figure gave it less room than the font takes.
    const squeeze = natural > 0 && item.width < natural ? item.width / natural : 1;
    const drawn = natural * squeeze;
    const back = item.anchor === 'start' ? 0 : item.anchor === 'middle' ? drawn / 2 : drawn;
    const turn = ((item.rotate ?? 0) * Math.PI) / 180;
    const [cos, sin] = [Math.cos(turn), Math.sin(turn)];
    // The page is drawn with y down; the text matrix turns the letters
    // upright again, and by the angle of the text.
    return [
      'BT',
      `${rgb(item.colour)} rg`,
      `/${fontName(item.font)} ${n(item.size)} Tf`,
      `${n(squeeze * 100)} Tz`,
      `${n(cos)} ${n(sin)} ${n(sin)} ${n(-cos)} ${n(item.x - back * cos)} ${n(item.y - back * sin)} Tm`,
      `${pdfString(item.text)} Tj`,
      'ET',
    ];
  }
  const steps =
    item.kind === 'path'
      ? item.steps
      : item.kind === 'circle'
        ? circleSteps(item.cx, item.cy, item.r)
        : roundedRectSteps(item.x, item.y, item.width, item.height, item.radius ?? 0);
  const [set, paint] = paintOps(item.stroke, item.fill);
  return [...set, ...pathOps(steps), paint];
}

export interface PdfOptions {
  /** What the figure is of, for the title of the document. */
  title?: string;
}

/** `figure` as the text of a PDF file (ASCII, so one character is one byte). */
export function figureToPdf(figure: Figure, options: PdfOptions = {}): string {
  const { x, y, width, height } = figure.box;
  const pageWidth = width * PT_PER_PX;
  const pageHeight = height * PT_PER_PX;
  // The fonts the figure is set in, each a resource of the page.
  const fonts: FigureFont[] = [];
  const fontName = (font: FigureFont): string => {
    if (!fonts.includes(font)) fonts.push(font);
    return `F${fonts.indexOf(font) + 1}`;
  };
  const content = [
    'q',
    // From the diagram's px, y down from the top of the figure, to the
    // page's points, y up from its foot.
    `${n(PT_PER_PX)} 0 0 ${n(-PT_PER_PX)} ${n(-x * PT_PER_PX)} ${n(pageHeight + y * PT_PER_PX)} cm`,
    '1 j',
    `${rgb(figure.paper)} rg`,
    `${n(x)} ${n(y)} ${n(width)} ${n(height)} re f`,
    ...figure.items.flatMap((item) => itemOps(item, fontName)),
    'Q',
  ].join('\n');

  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '', // The page: written below, once the fonts are known.
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  const fontRefs = fonts.map((font, i) => {
    objects.push(
      `<< /Type /Font /Subtype /Type1 /BaseFont /${PDF_FONT_NAME[font]} /Encoding /WinAnsiEncoding >>`,
    );
    return `/F${i + 1} ${objects.length} 0 R`;
  });
  objects[2] =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(pageWidth)} ${n(pageHeight)}] ` +
    `/Resources << /Font << ${fontRefs.join(' ')} >> >> /Contents 4 0 R >>`;
  objects.push(
    `<< /Title ${pdfString(options.title ?? 'Single-line diagram')} /Creator (TENSA) /Producer (TENSA) >>`,
  );
  const info = objects.length;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${info} 0 R >>\n`;
  out += `startxref\n${xref}\n%%EOF\n`;
  return out;
}
