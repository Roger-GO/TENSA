/**
 * The choices a figure of the diagram is drawn with (`SldFigureDialog`): the
 * style, the line width, the font, which labels show and how a PNG is
 * rasterised.
 *
 * They are settings of the diagram of one case, like the connector style, so
 * they are kept the same way: among the `figure` settings of its layout,
 * which every save path carries. Each is one flat entry there, beside
 * `connector_style` (the section holds numbers, flags and short texts, and
 * at most 64 of them).
 *
 * Pure: nothing read but the arguments.
 */
import type { SidecarLayout } from '@/api/types';

/** The font a figure sets its text in; each is one of the fonts every PDF reader has. */
export type FigureFont = 'sans' | 'serif' | 'mono';

/** The file a figure is saved as. */
export type FigureFormat = 'svg' | 'pdf' | 'png';

export interface FigureSettings {
  /** Black on white, with nothing told by colour. Off: the colours of the diagram. */
  monochrome: boolean;
  /** How heavy a line, a connector and the stroke of a symbol are drawn, in px of the diagram. */
  lineWidth: number;
  font: FigureFont;
  /**
   * The size the text is set in, in px of the diagram. A label is drawn
   * smaller where the room the diagram keeps for it is less (`drawFigure`).
   */
  fontSize: number;
  /** The name of each bus. */
  busNames: boolean;
  /** The name under the symbol of each generator, load and shunt. */
  deviceNames: boolean;
  /** The voltage magnitude a power flow gave each bus. */
  voltages: boolean;
  /** The voltage angle a power flow gave each bus. */
  angles: boolean;
  /** The flow of each line, with the arrow of its direction. */
  flows: boolean;
  /** The P and Q of each generator and load. */
  powers: boolean;
  /** The chips that name the machine and the controllers of a generating unit. */
  chips: boolean;
  /** The marks of a limit: the triangle of a bus or generator at one, and the heavier line near its rating. */
  limitMarks: boolean;
  /** The resolution a PNG is rasterised at, in dots per inch; 96 px of the diagram are one inch. */
  dpi: number;
}

export const DEFAULT_FIGURE_SETTINGS: FigureSettings = {
  monochrome: true,
  lineWidth: 1.5,
  font: 'sans',
  fontSize: 10,
  busNames: true,
  deviceNames: true,
  voltages: true,
  angles: true,
  flows: true,
  powers: true,
  chips: true,
  limitMarks: false,
  dpi: 300,
};

/** The line widths the dialog offers. */
export const FIGURE_LINE_WIDTHS: readonly number[] = [0.75, 1, 1.5, 2, 2.5];

/** The text sizes the dialog offers. */
export const FIGURE_FONT_SIZES: readonly number[] = [7, 8, 9, 10, 11, 12];

/** The resolutions the dialog offers for a PNG. */
export const FIGURE_DPIS: readonly number[] = [96, 150, 300, 600];

export const FIGURE_FONTS: readonly FigureFont[] = ['sans', 'serif', 'mono'];

/** What a font is called in the dialog. */
export const FIGURE_FONT_LABEL: Record<FigureFont, string> = {
  sans: 'Sans serif (Helvetica, Arial)',
  serif: 'Serif (Times)',
  mono: 'Monospace (Courier)',
};

const LINE_WIDTH_RANGE = { min: 0.25, max: 4 };
const FONT_SIZE_RANGE = { min: 5, max: 16 };
const DPI_RANGE = { min: 72, max: 1200 };

/** The name each setting goes by among the `figure` settings of a layout. */
const SETTING_NAME: Record<keyof FigureSettings, string> = {
  monochrome: 'monochrome',
  lineWidth: 'line_width',
  font: 'font',
  fontSize: 'font_size',
  busNames: 'bus_names',
  deviceNames: 'device_names',
  voltages: 'voltages',
  angles: 'angles',
  flows: 'flows',
  powers: 'powers',
  chips: 'chips',
  limitMarks: 'limit_marks',
  dpi: 'dpi',
};

const within = (value: number, range: { min: number; max: number }): number =>
  Math.min(range.max, Math.max(range.min, value));

/**
 * `settings` with every entry one a figure can be drawn with: a number that
 * is out of range is brought into it, and an entry of the wrong kind gives
 * way to the default. What a layout file holds was written by this app, by
 * an earlier build of it or by hand.
 */
export function normalizeFigureSettings(settings: Partial<FigureSettings>): FigureSettings {
  const out: FigureSettings = { ...DEFAULT_FIGURE_SETTINGS };
  const flags = [
    'monochrome',
    'busNames',
    'deviceNames',
    'voltages',
    'angles',
    'flows',
    'powers',
    'chips',
    'limitMarks',
  ] as const;
  for (const name of flags) {
    const value = settings[name];
    if (typeof value === 'boolean') out[name] = value;
  }
  const numbers = [
    ['lineWidth', LINE_WIDTH_RANGE],
    ['fontSize', FONT_SIZE_RANGE],
    ['dpi', DPI_RANGE],
  ] as const;
  for (const [name, range] of numbers) {
    const value = settings[name];
    if (typeof value === 'number' && Number.isFinite(value)) out[name] = within(value, range);
  }
  out.dpi = Math.round(out.dpi);
  if (settings.font !== undefined && FIGURE_FONTS.includes(settings.font)) out.font = settings.font;
  return out;
}

/** The figure settings `layout` holds, each as it stands there; one it does not hold is absent. */
export function figureSettingsOf(layout: SidecarLayout | null): Partial<FigureSettings> {
  const held = layout?.figure ?? {};
  const out: Record<string, unknown> = {};
  for (const [name, key] of Object.entries(SETTING_NAME)) {
    if (key in held) out[name] = held[key];
  }
  return out as Partial<FigureSettings>;
}

/** `settings` as entries of the `figure` section of a layout. */
export function figureSettingsEntries(
  settings: Partial<FigureSettings>,
): Record<string, boolean | number | string> {
  const out: Record<string, boolean | number | string> = {};
  for (const [name, value] of Object.entries(settings)) {
    const key = SETTING_NAME[name as keyof FigureSettings];
    if (key !== undefined && value !== undefined) out[key] = value;
  }
  return out;
}

/** Whether a figure drawn with `settings` shows anything a power flow gives. */
export function showsValues(settings: FigureSettings): boolean {
  return settings.voltages || settings.angles || settings.flows || settings.powers;
}
