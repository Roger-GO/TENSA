/**
 * Display units: how a stored value is shown, and the bases that turn a
 * per-unit value into an actual one. Pure and import-clean (types only), so
 * the grids, the diagram, the inspector and the plots all read the same rules.
 *
 * The substrate reports angles in radians, bus voltage and rotor speed per
 * unit, and powers in MW / MVAr. The UI shows:
 *
 * - angles in degrees, always (`radToDeg`);
 * - bus voltage and rotor speed per unit (`'pu'`, the default) or as actual
 *   kV and Hz (`'actual'`), where the base is known: a bus's rated voltage
 *   (`Vn`) and the system frequency. Where it is not, the value stays per
 *   unit and says so. A `Vn` is a base only when the case gives it: ANDES fills
 *   in 110 kV for a bus whose case leaves it out or sets it to zero, and the
 *   topology lists those buses (`buses_without_vn`) so that fill-in is not
 *   mistaken for one. The frequency is the case's own, or ANDES's default of
 *   60 Hz where the case sets none (a MATPOWER file has none to set);
 * - powers as the substrate sends them: they are actual already, so the mode
 *   does not touch them.
 */
import type { TopologyEntry, TopologySummary } from '@/api/types';

/** Per unit, or actual units (kV, Hz) where the base is known. */
export type UnitMode = 'pu' | 'actual';

export const UNIT_MODES: readonly UnitMode[] = ['pu', 'actual'] as const;

export const DEFAULT_UNIT_MODE: UnitMode = 'pu';

/** Degrees in one radian. */
export const RAD_TO_DEG = 180 / Math.PI;

export function radToDeg(radians: number): number {
  return radians * RAD_TO_DEG;
}

/** A unit a bus voltage or a rotor speed can be shown in. */
export type DisplayUnit = 'pu' | 'kV' | 'Hz';

/** How to show a stored per-unit value: what it is multiplied by, and what the result is. */
export interface Display {
  readonly factor: number;
  readonly unit: DisplayUnit;
}

/** The per-unit value as it is stored. */
export const PER_UNIT: Display = { factor: 1, unit: 'pu' };

function isBase(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** How to show a bus voltage: in kV when the mode asks and the bus's rated kV is known. */
export function voltageDisplay(mode: UnitMode, baseKv: number | null | undefined): Display {
  return mode === 'actual' && isBase(baseKv) ? { factor: baseKv, unit: 'kV' } : PER_UNIT;
}

/** How to show a rotor speed: in Hz when the mode asks and the system frequency is known. */
export function speedDisplay(mode: UnitMode, freqHz: number | null | undefined): Display {
  return mode === 'actual' && isBase(freqHz) ? { factor: freqHz, unit: 'Hz' } : PER_UNIT;
}

/**
 * Decimals to print a value in `display` with, given those for the per-unit
 * form. An actual value (kV, Hz) has a magnitude two orders larger, so it gets
 * one decimal fewer for a finer resolution still.
 */
export function displayDecimals(display: Display, puDecimals: number): number {
  return display.unit === 'pu' ? puDecimals : Math.max(puDecimals - 1, 0);
}

/**
 * A per-unit value in a display, with its unit: `1.06` per unit is `1.060 pu`,
 * and `1.06` on a 230 kV bus is `243.80 kV`.
 */
export function formatDisplayed(value: number, display: Display, puDecimals: number): string {
  return `${(value * display.factor).toFixed(displayDecimals(display, puDecimals))} ${display.unit}`;
}

/** The bases of one case: what its per-unit values convert to actual with. */
export interface UnitBases {
  /** Each bus's rated voltage in kV, keyed by bus idx. A bus the case gives none is absent. */
  readonly busKv: Readonly<Record<string, number>>;
  /** System nominal frequency in Hz; `null` when the case does not say. */
  readonly freqHz: number | null;
}

/**
 * The idx (as strings) of the buses whose case gives no rated voltage, so the
 * `Vn` in their params is ANDES's fill-in and no base. Empty for no topology.
 */
export function unratedBusIdx(topology: TopologySummary | null | undefined): ReadonlySet<string> {
  return new Set((topology?.buses_without_vn ?? []).map(String));
}

/**
 * A bus entry's rated voltage in kV (its `Vn`), or `null` when it has none or
 * is one of the `unrated` buses (see `unratedBusIdx`), whose `Vn` is a fill-in.
 */
export function entryBaseKv(
  bus: Pick<TopologyEntry, 'idx' | 'params'>,
  unrated?: ReadonlySet<string>,
): number | null {
  if (unrated?.has(String(bus.idx))) return null;
  const vn = bus.params?.Vn;
  return isBase(vn) ? vn : null;
}

/**
 * The bases a topology carries. `undefined` for no topology, so a caller can
 * tell "no case" from "a case with no bases" (both leave values per unit).
 */
export function unitBasesOf(topology: TopologySummary | null | undefined): UnitBases | undefined {
  if (!topology) return undefined;
  const unrated = unratedBusIdx(topology);
  const busKv: Record<string, number> = {};
  for (const bus of topology.buses) {
    const kv = entryBaseKv(bus, unrated);
    if (kv !== null) busKv[String(bus.idx)] = kv;
  }
  return { busKv, freqHz: isBase(topology.freq_hz) ? topology.freq_hz : null };
}

/** A bus's rated voltage in kV, or `null` when unknown. */
export function busBaseKv(
  bases: UnitBases | null | undefined,
  busIdx: string | number,
): number | null {
  return bases?.busKv[String(busIdx)] ?? null;
}
