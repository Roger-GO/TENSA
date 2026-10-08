import type { ControllerSubKind } from '@/lib/controllers';

/** One part of a controller glyph: a path, a circle or a rounded rectangle. */
export type ControllerGlyphPart =
  | { d: string }
  | { circle: { cx: number; cy: number; r: number } }
  | { rect: { x: number; y: number; width: number; height: number; rx: number } };

/** The box the parts are drawn in, and how heavy their stroke is in it. */
export const CONTROLLER_GLYPH_BOX = { size: 24, strokeWidth: 1.7 } as const;

/**
 * The line glyph of each controller sub-kind, in a 24 by 24 box. One table
 * for the two places that draw it: `ControllerGlyph` on the screen, and the
 * figure of the diagram (`figure/symbols.ts`), which draws the same parts as
 * shapes of its own.
 */
export const CONTROLLER_GLYPH_PARTS: Record<ControllerSubKind, readonly ControllerGlyphPart[]> = {
  // Amplifier triangle with a field winding tap (AVR / field forcing).
  exciter: [{ d: 'M7 5l10 7-10 7z' }, { d: 'M3 12h4' }],
  // Valve / throttle: a body with a control stem (turbine governor).
  governor: [{ circle: { cx: 12, cy: 14, r: 5 } }, { d: 'M12 9V4' }, { d: 'M9 4h6' }],
  // Damping sine: the stabiliser's modulating signal.
  pss: [{ d: 'M3 12c3-7 6 7 9 0s6-7 9 0' }],
  // Wind/PV controller: a three-blade rotor hub.
  renewable: [
    { circle: { cx: 12, cy: 12, r: 1.6 } },
    { d: 'M12 10.4V4' },
    { d: 'M13.4 12.8l5.6 3.2' },
    { d: 'M10.6 12.8L5 16' },
  ],
  // Gauge: PMU / frequency measurement.
  measurement: [{ d: 'M4 16a8 8 0 0116 0' }, { d: 'M12 16l4-4' }],
  // Time-series profile: a stepped trace.
  profile: [{ d: 'M3 17V7' }, { d: 'M3 17h18' }, { d: 'M6 14l4-4 3 3 4-6' }],
  // Generic control block.
  other: [
    { rect: { x: 6, y: 7, width: 12, height: 10, rx: 1.5 } },
    { d: 'M3 12h3' },
    { d: 'M18 12h3' },
  ],
};
