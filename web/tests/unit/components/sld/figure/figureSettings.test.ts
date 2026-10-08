/** The choices a figure is drawn with, and how they are kept in a layout. */
import { describe, expect, it } from 'vitest';
import type { SidecarLayout } from '@/api/types';
import {
  DEFAULT_FIGURE_SETTINGS,
  FIGURE_DPIS,
  FIGURE_FONT_SIZES,
  FIGURE_LINE_WIDTHS,
  figureSettingsEntries,
  figureSettingsOf,
  normalizeFigureSettings,
  showsValues,
} from '@/components/sld/figure/figureSettings';
import { MAX_FIGURE_SETTINGS, buildSidecarLayout, parseSidecar } from '@/components/sld/sidecar';

describe('the defaults', () => {
  it('are a figure for a paper: black on white, with everything the diagram shows', () => {
    expect(DEFAULT_FIGURE_SETTINGS).toEqual({
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
    });
  });

  it('are among what the dialog offers', () => {
    expect(FIGURE_LINE_WIDTHS).toContain(DEFAULT_FIGURE_SETTINGS.lineWidth);
    expect(FIGURE_FONT_SIZES).toContain(DEFAULT_FIGURE_SETTINGS.fontSize);
    expect(FIGURE_DPIS).toContain(DEFAULT_FIGURE_SETTINGS.dpi);
  });
});

describe('normalizeFigureSettings', () => {
  it('fills what is not said with the default', () => {
    expect(normalizeFigureSettings({})).toEqual(DEFAULT_FIGURE_SETTINGS);
    expect(normalizeFigureSettings({ monochrome: false, font: 'serif', flows: false })).toEqual({
      ...DEFAULT_FIGURE_SETTINGS,
      monochrome: false,
      font: 'serif',
      flows: false,
    });
  });

  it('brings a number into the range a figure can be drawn with', () => {
    expect(normalizeFigureSettings({ lineWidth: 0, fontSize: 1, dpi: 1 })).toMatchObject({
      lineWidth: 0.25,
      fontSize: 5,
      dpi: 72,
    });
    expect(normalizeFigureSettings({ lineWidth: 99, fontSize: 99, dpi: 99_999 })).toMatchObject({
      lineWidth: 4,
      fontSize: 16,
      dpi: 1200,
    });
    expect(normalizeFigureSettings({ dpi: 299.6 }).dpi).toBe(300);
  });

  it('gives way to the default where a layout file holds something else than it should', () => {
    const fromAFile = {
      monochrome: 'yes',
      lineWidth: '2',
      font: 'comic',
      fontSize: Number.NaN,
      busNames: 1,
      dpi: Number.POSITIVE_INFINITY,
    } as unknown as Parameters<typeof normalizeFigureSettings>[0];
    expect(normalizeFigureSettings(fromAFile)).toEqual(DEFAULT_FIGURE_SETTINGS);
  });
});

describe('the settings in a layout', () => {
  it('are one entry each, named so that they are told from a setting of the diagram', () => {
    const entries = figureSettingsEntries(DEFAULT_FIGURE_SETTINGS);
    expect(Object.keys(entries).sort()).toEqual([
      'angles',
      'bus_names',
      'chips',
      'device_names',
      'dpi',
      'flows',
      'font',
      'font_size',
      'limit_marks',
      'line_width',
      'monochrome',
      'powers',
      'voltages',
    ]);
    // With the connector style beside them, well within what the section holds.
    expect(Object.keys(entries).length + 1).toBeLessThan(MAX_FIGURE_SETTINGS);
    expect(entries).toMatchObject({
      font: 'sans',
      dpi: 300,
      monochrome: true,
    });
  });

  it('come back from a layout as they went into it, through the file and its validation', () => {
    const chosen = {
      ...DEFAULT_FIGURE_SETTINGS,
      monochrome: false,
      lineWidth: 0.75,
      font: 'mono' as const,
      fontSize: 8,
      angles: false,
      limitMarks: true,
      dpi: 600,
    };
    const layout = buildSidecarLayout(
      { '1': { x: 0, y: 0 } },
      { sections: { figure: { connector_style: 'elbow', ...figureSettingsEntries(chosen) } } },
    );
    const read = parseSidecar(JSON.parse(JSON.stringify(layout)));
    expect(normalizeFigureSettings(figureSettingsOf(read))).toEqual(chosen);
    // The setting of the diagram that shares the section is not one of them, and is still there.
    expect(figureSettingsOf(read)).not.toHaveProperty('connector_style');
    expect(read.figure.connector_style).toBe('elbow');
  });

  it('holds only what was changed, where only that was written', () => {
    expect(figureSettingsEntries({ dpi: 150 })).toEqual({ dpi: 150 });
    expect(figureSettingsEntries({})).toEqual({});
    const layout = {
      figure: { dpi: 150, connector_style: 'straight' },
    } as unknown as SidecarLayout;
    expect(figureSettingsOf(layout)).toEqual({ dpi: 150 });
    expect(normalizeFigureSettings(figureSettingsOf(layout))).toEqual({
      ...DEFAULT_FIGURE_SETTINGS,
      dpi: 150,
    });
  });

  it('is nothing for a layout that says nothing of a figure, and for none', () => {
    expect(figureSettingsOf(null)).toEqual({});
    expect(figureSettingsOf({} as SidecarLayout)).toEqual({});
  });
});

describe('showsValues', () => {
  it('is whether anything a power flow gives is on the figure', () => {
    expect(showsValues(DEFAULT_FIGURE_SETTINGS)).toBe(true);
    const none = {
      ...DEFAULT_FIGURE_SETTINGS,
      voltages: false,
      angles: false,
      flows: false,
      powers: false,
    };
    expect(showsValues(none)).toBe(false);
    for (const one of ['voltages', 'angles', 'flows', 'powers'] as const) {
      expect(showsValues({ ...none, [one]: true }), one).toBe(true);
    }
    // The names and the marks are not values.
    expect(showsValues({ ...none, limitMarks: true })).toBe(false);
  });
});
