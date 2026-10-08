/**
 * How wide a text is in the fonts a figure is set in.
 *
 * A figure names one of the three fonts every PDF reader has built in
 * (Helvetica, Times and Courier), and an SVG of it names the same with the
 * fonts that are drawn to their widths (Arial, Times New Roman, Courier New
 * and the Liberation fonts). The widths here are the ones Adobe publishes
 * for the three (their AFM files), in thousandths of the font size, for the
 * printable ASCII characters; a letter with an accent is as wide as the
 * letter, and anything else is taken at a width no narrower than it is
 * drawn. With them a label is placed, and held to the room the diagram keeps
 * for it, without a browser to measure it: the drawing is the same in a
 * test, in the preview and in the file.
 *
 * Pure: nothing read but the arguments.
 */
import type { FigureFont } from './figureSettings';

// prettier-ignore
const HELVETICA: readonly number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // space to /
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 0 to ?
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // @ to O
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // P to _
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // ` to o
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, // p to ~
];

// prettier-ignore
const TIMES: readonly number[] = [
  250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278, // space to /
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444, // 0 to ?
  921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722, // @ to O
  556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500, // P to _
  333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500, // ` to o
  500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541, // p to ~
];

/** Every character of Courier. */
const COURIER = 600;

/** The degree sign, which an angle ends in. */
const DEGREE = 400;

/** A character of Latin script the tables do not hold: no narrower than most. */
const OTHER_LATIN = 667;

/** Any other character (a CJK ideograph is a full em wide). */
const OTHER = 1000;

function charWidth(char: string, table: readonly number[]): number {
  const code = char.codePointAt(0) ?? 0;
  if (code >= 32 && code <= 126) return table[code - 32]!;
  if (code === 0xb0) return DEGREE;
  if (code === 0xa0) return table[0]!;
  // A letter with an accent is as wide as the letter under it.
  const base = char.normalize('NFD').codePointAt(0) ?? 0;
  if (base !== code && base >= 32 && base <= 126) return table[base - 32]!;
  return code < 0x250 ? OTHER_LATIN : OTHER;
}

/** How wide `text` is in `font` at `size`, in the units of `size`. */
export function textWidth(text: string, font: FigureFont, size: number): number {
  let thousandths = 0;
  for (const char of text) {
    thousandths +=
      font === 'mono' ? COURIER : charWidth(char, font === 'serif' ? TIMES : HELVETICA);
  }
  return (thousandths * size) / 1000;
}

/**
 * How far over the baseline the capitals and the figures of a font reach,
 * as a part of its size: what a text is centred on a line by.
 */
export const CAP_HEIGHT: Record<FigureFont, number> = { sans: 0.718, serif: 0.662, mono: 0.562 };

/** How far under the baseline a font reaches, as a part of its size. */
export const DESCENT: Record<FigureFont, number> = { sans: 0.207, serif: 0.217, mono: 0.157 };

/** The fonts an SVG of a figure asks for, the one named in the PDF first. */
export const SVG_FONT_FAMILY: Record<FigureFont, string> = {
  sans: "Helvetica, Arial, 'Liberation Sans', sans-serif",
  serif: "'Times New Roman', Times, 'Liberation Serif', serif",
  mono: "'Courier New', Courier, 'Liberation Mono', monospace",
};

/** The font of a PDF reader a figure names. */
export const PDF_FONT_NAME: Record<FigureFont, string> = {
  sans: 'Helvetica',
  serif: 'Times-Roman',
  mono: 'Courier',
};
