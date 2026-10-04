/**
 * The y axes of one stacked chart.
 *
 * A variable group mixes quantities that share no scale: a bus's voltage is
 * about 1 pu while its angle is tens of degrees, and a machine's speed is
 * 1 +/- 0.001 pu next to a rotor angle of tens of degrees. On one axis the
 * small one plots flat. So each quantity a chart carries gets its own axis,
 * the first on the left and a second (an angle) on the right, and each series
 * is scaled into the unit its axis reads in. Pure, so the choices (which
 * unit, which side, what factor) are testable without a chart.
 *
 * The streamed values are per unit and in radians; the units come from
 * ``lib/units.ts``. A voltage or speed is shown as kV or Hz only when every
 * series of that quantity on the chart has its base, since one axis cannot
 * read in two units.
 */
import type { ParsedSeries, VarGroup } from '@/store/plot';
import {
  RAD_TO_DEG,
  busBaseKv,
  type DisplayUnit,
  type UnitBases,
  type UnitMode,
} from '@/lib/units';

/** The uPlot scale keys of the left and the right y axis. */
export const PRIMARY_SCALE = 'y';
export const SECONDARY_SCALE = 'y2';

/** What a series measures. A chart gives each quantity it carries its own axis. */
export type Quantity = 'voltage' | 'speed' | 'power' | 'angle';

/** The order axes are drawn in: the group's main quantity on the left, the angle on the right. */
const AXIS_ORDER: readonly Quantity[] = ['voltage', 'speed', 'power', 'angle'];

/** The quantity a series measures, from its group and field. */
export function seriesQuantity(series: Pick<ParsedSeries, 'group' | 'field'>): Quantity {
  switch (series.group) {
    case 'bus_v':
      return series.field === 'a' ? 'angle' : 'voltage';
    case 'gen_state':
      return series.field === 'delta' ? 'angle' : 'speed';
    default:
      return 'power';
  }
}

/** A series, with the bases of the run it belongs to. */
export interface PlannedSeries {
  series: ParsedSeries;
  bases: UnitBases | undefined;
}

/** One y axis of a chart. */
export interface AxisPlan {
  quantity: Quantity;
  /** The uPlot scale key the axis reads and the series on it name. */
  scale: string;
  unit: DisplayUnit | '°' | 'MW';
  /** The axis title. */
  label: string;
  side: 'left' | 'right';
}

export interface GroupAxes {
  /** The axes to draw, the left one first. */
  axes: readonly AxisPlan[];
  /** The scale key and unit factor of one series of the chart. */
  place: (planned: PlannedSeries) => { scale: string; factor: number };
}

function angleLabel(group: VarGroup): string {
  return group === 'gen_state' ? 'δ (°)' : 'θ (°)';
}

/**
 * Plan the axes of the chart of ``group`` that shows ``planned``.
 *
 * ``mode`` asks for actual units; the plan honours it for a quantity only when
 * every series of that quantity has its base (a bus's rated kV, the system
 * frequency), and otherwise leaves that axis per unit and says so.
 */
export function planGroupAxes(
  group: VarGroup,
  planned: readonly PlannedSeries[],
  mode: UnitMode,
): GroupAxes {
  const present = new Set(planned.map((p) => seriesQuantity(p.series)));
  const ofQuantity = (quantity: Quantity) =>
    planned.filter((p) => seriesQuantity(p.series) === quantity);

  const actual = mode === 'actual';
  const inKv =
    actual && ofQuantity('voltage').every((p) => busBaseKv(p.bases, p.series.elementIdx) !== null);
  const inHz = actual && ofQuantity('speed').every((p) => (p.bases?.freqHz ?? null) !== null);

  const axes: AxisPlan[] = AXIS_ORDER.filter((q) => present.has(q)).map((quantity, i) => {
    const scale = i === 0 ? PRIMARY_SCALE : SECONDARY_SCALE;
    const side = i === 0 ? 'left' : 'right';
    switch (quantity) {
      case 'voltage':
        return {
          quantity,
          scale,
          side,
          unit: inKv ? 'kV' : 'pu',
          label: `V (${inKv ? 'kV' : 'pu'})`,
        };
      case 'speed':
        return inHz
          ? { quantity, scale, side, unit: 'Hz', label: 'f (Hz)' }
          : { quantity, scale, side, unit: 'pu', label: 'ω (pu)' };
      case 'angle':
        return { quantity, scale, side, unit: '°', label: angleLabel(group) };
      case 'power':
        return { quantity, scale, side, unit: 'MW', label: 'P (MW) / Q (MVar)' };
    }
  });

  const scaleOf = new Map(axes.map((axis) => [axis.quantity, axis.scale]));
  return {
    axes,
    place: ({ series, bases }) => {
      const quantity = seriesQuantity(series);
      const scale = scaleOf.get(quantity) ?? PRIMARY_SCALE;
      switch (quantity) {
        case 'angle':
          return { scale, factor: RAD_TO_DEG };
        case 'voltage':
          return { scale, factor: inKv ? (busBaseKv(bases, series.elementIdx) ?? 1) : 1 };
        case 'speed':
          return { scale, factor: inHz ? (bases?.freqHz ?? 1) : 1 };
        case 'power':
          return { scale, factor: 1 };
      }
    },
  };
}

/** ``values`` times ``factor``: the same view when the factor is 1, otherwise a scaled copy. */
export function scaleColumn(values: Float64Array, factor: number): Float64Array {
  if (factor === 1) return values;
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i += 1) out[i] = values[i]! * factor;
  return out;
}
