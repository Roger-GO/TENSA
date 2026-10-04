/**
 * Bus voltage limits and what a voltage means against them. Pure and
 * import-clean (no React, no stores), so the graph builder, the bus node,
 * the streaming overlay and the legend all read the same rules.
 *
 * A bus is judged against its own limits (`vmin` / `vmax`, as the case
 * file sets them) with an amber band `VOLTAGE_WARNING_MARGIN` inside each
 * limit. A bus that carries no usable limit falls back to the usual
 * 0.95 / 1.05 pu.
 */
import type { TopologyEntry, TopologySummary } from '@/api/types';

/** Voltage band classification for a bus. */
export type VoltageBand = 'success' | 'warning' | 'danger' | 'neutral';

/**
 * Which limit a voltage is at or past: `low` is the `vmin` end, `high` the
 * `vmax` end. `null` for a voltage in the clear, and for no reading at all.
 * The bus node draws it as a triangle pointing up or down, so a violation
 * can be told from a normal bus (and a low one from a high one) without
 * the colour.
 */
export type VoltageSide = 'low' | 'high';

/** The voltage limits of one bus (pu). Read-only: the default is one shared object. */
export interface VoltageLimits {
  readonly vmin: number;
  readonly vmax: number;
}

/** What a bus is judged against when its case sets no usable limit. */
export const DEFAULT_VOLTAGE_LIMITS: VoltageLimits = { vmin: 0.95, vmax: 1.05 };

/** How far inside a limit the amber warning band begins (pu). */
export const VOLTAGE_WARNING_MARGIN = 0.02;

/**
 * Turn a bus's `vmin` / `vmax` into the limits it is judged against. A
 * value that is missing, not a finite positive number, or that leaves no
 * band between the two (`vmin` at or above `vmax`) is the case file's
 * gap, not a limit, and the 0.95 / 1.05 pu default stands in for it.
 */
export function resolveVoltageLimits(vmin: unknown, vmax: unknown): VoltageLimits {
  const usable = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0;
  const low = usable(vmin) ? vmin : DEFAULT_VOLTAGE_LIMITS.vmin;
  const high = usable(vmax) ? vmax : DEFAULT_VOLTAGE_LIMITS.vmax;
  if (low >= high) return DEFAULT_VOLTAGE_LIMITS;
  return low === DEFAULT_VOLTAGE_LIMITS.vmin && high === DEFAULT_VOLTAGE_LIMITS.vmax
    ? DEFAULT_VOLTAGE_LIMITS
    : { vmin: low, vmax: high };
}

/** The limits a topology bus entry carries (its `vmin` / `vmax` params). */
export function busVoltageLimits(entry: Pick<TopologyEntry, 'params'>): VoltageLimits {
  return resolveVoltageLimits(entry.params?.vmin, entry.params?.vmax);
}

const limitsByTopology = new WeakMap<TopologySummary, ReadonlyMap<string, VoltageLimits>>();

/**
 * The limits of every bus of a topology, keyed by bus idx. Built once per
 * topology object (the query cache hands back the same one until the case
 * changes), because the streaming overlay asks for it on every frame.
 */
export function busLimitsByIdx(topology: TopologySummary): ReadonlyMap<string, VoltageLimits> {
  let limits = limitsByTopology.get(topology);
  if (limits === undefined) {
    limits = new Map(topology.buses.map((bus) => [String(bus.idx), busVoltageLimits(bus)]));
    limitsByTopology.set(topology, limits);
  }
  return limits;
}

/** A band with the limit it is near or past. */
export interface VoltageStatus {
  band: VoltageBand;
  side: VoltageSide | null;
}

// One shared object per outcome: the streaming overlay classifies every bus
// on every frame, and a status is never mutated.
const NEUTRAL: Readonly<VoltageStatus> = { band: 'neutral', side: null };
const SUCCESS: Readonly<VoltageStatus> = { band: 'success', side: null };
const WARNING_LOW: Readonly<VoltageStatus> = { band: 'warning', side: 'low' };
const WARNING_HIGH: Readonly<VoltageStatus> = { band: 'warning', side: 'high' };
const DANGER_LOW: Readonly<VoltageStatus> = { band: 'danger', side: 'low' };
const DANGER_HIGH: Readonly<VoltageStatus> = { band: 'danger', side: 'high' };

/**
 * Judge a voltage against a bus's limits. Beyond a limit is danger; within
 * `VOLTAGE_WARNING_MARGIN` of one is warning (at most a quarter of the
 * band, so a narrow band keeps a clear middle). Pure; exported for testing.
 */
export function assessVoltage(
  v: number,
  limits: VoltageLimits = DEFAULT_VOLTAGE_LIMITS,
): Readonly<VoltageStatus> {
  if (!Number.isFinite(v)) return NEUTRAL;
  if (v < limits.vmin) return DANGER_LOW;
  if (v > limits.vmax) return DANGER_HIGH;
  const margin = Math.min(VOLTAGE_WARNING_MARGIN, (limits.vmax - limits.vmin) / 4);
  if (v < limits.vmin + margin) return WARNING_LOW;
  if (v > limits.vmax - margin) return WARNING_HIGH;
  return SUCCESS;
}

/**
 * The words behind a bus's limit marker (its tooltip and accessible name),
 * or `null` when the bus carries no marker.
 */
export function voltageMarkerLabel(band: VoltageBand, side: VoltageSide | null): string | null {
  if (side === null) return null;
  const end = side === 'high' ? 'upper' : 'lower';
  if (band === 'danger') return `Voltage beyond its ${end} limit`;
  if (band === 'warning') return `Voltage near its ${end} limit`;
  return null;
}

/**
 * A bus's standing against its limits in words, for the Buses table and the
 * Inspector: where the diagram has a bar colour and a triangle, this is the
 * same reading as text. `null` when there is no voltage to judge.
 */
export function voltageStatusText(status: Readonly<VoltageStatus>): string | null {
  switch (status.band) {
    case 'success':
      return 'Within limits';
    case 'warning':
      return status.side === 'low' ? 'Near vmin' : 'Near vmax';
    case 'danger':
      return status.side === 'low' ? 'Below vmin' : 'Above vmax';
    default:
      return null;
  }
}

/** The limits as one phrase, e.g. `0.9 to 1.1 pu`, for a tooltip. */
export function formatVoltageLimits(limits: VoltageLimits): string {
  const pu = (value: number) => String(Number(value.toFixed(4)));
  return `${pu(limits.vmin)} to ${pu(limits.vmax)} pu`;
}

/**
 * Busbar fill by voltage band. Traditional one-line busbars are drawn as
 * a solid dark bar; we keep that for normal/unsolved buses and only tint
 * the bar amber / red when a voltage limit is breached, so a violation
 * reads at a glance without making every bus a different colour.
 */
const BAR_BG_CLASS: Record<VoltageBand, string> = {
  danger: 'bg-[var(--color-danger)]',
  warning: 'bg-[var(--color-warning)]',
  success: 'bg-foreground',
  neutral: 'bg-foreground',
};

/** Tailwind background class for a bus bar in the given band. */
export function barClassForBand(band: VoltageBand): string {
  return BAR_BG_CLASS[band];
}
