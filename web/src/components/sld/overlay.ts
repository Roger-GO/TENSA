/**
 * Pure helpers that translate a `PflowResult` into per-element visual
 * state for the SLD canvas (Unit 9 of v0.1).
 *
 * Lives in its own module so:
 *
 * - The functions can be unit-tested without spinning up a ReactFlow
 *   render or the case store.
 * - Bus / line nodes consume the helpers via plain function calls and
 *   stay thin.
 *
 * The TDS-frame-driven half (the rAF hook the App root mounts, and the
 * `pickFrameIdx` / `getFrameBusOverlay` helpers it ticks with) lives in
 * `frameOverlay.ts` so the App root does not pull this module's per-element
 * helpers (`loading.ts`, `qLimit.ts`) into the first load; the names are
 * re-exported here so the importers of this module do not change.
 *
 * A bus is judged against its own voltage limits (`voltage.ts`).
 */
import type { PflowResult } from '@/api/types';
import { PER_UNIT, formatDisplayed, radToDeg, type Display } from '@/lib/units';
import {
  DEFAULT_VOLTAGE_LIMITS,
  assessVoltage,
  type VoltageBand,
  type VoltageLimits,
  type VoltageSide,
} from './voltage';
import { assessLoading, formatLoading, loadingStatusText, type LoadingBand } from './loading';
import { assessQLimit, type QLimitState } from './qLimit';

export { getFrameBusOverlay, pickFrameIdx, useSldFrameOverlay } from './frameOverlay';

export interface BusOverlayState {
  /** "1.060 pu" (or "243.80 kV" in actual units) or null if labels hidden / no PF / missing data. */
  voltage_label: string | null;
  /** "0.00°" (degrees) or null if labels hidden / no PF / missing data. */
  angle_label: string | null;
  /** Classification used by the bus node to pick a stroke / border class. */
  band: VoltageBand;
  /** The limit the voltage is near or past; `null` when `band` is success or neutral. */
  side: VoltageSide | null;
  /** Tailwind border class to apply to the bus node container. */
  color_class: string;
}

export interface LineOverlayState {
  /** "12.4 MW" or null if labels hidden / no PF / missing data. */
  p_label: string | null;
  /** "3.2 MVAr" or null if labels hidden / no PF / missing data. */
  q_label: string | null;
  /**
   * Direction of active power flow at terminal 1.
   *
   * - `forward`  → P > 0; arrow points from `from_idx` → `to_idx`.
   * - `reverse`  → P < 0; arrow points from `to_idx`   → `from_idx`.
   * - `neutral`  → no PF data, or P is not defined.
   */
  direction: 'forward' | 'reverse' | 'neutral';
  /** True if `pflowResult` is present, converged, and contains this line. */
  has_data: boolean;
  /**
   * The line's loading against its rating: `neutral` for a line the case
   * rates at nothing, and before a power flow.
   */
  loading_band: LoadingBand;
  /** "87.3%" of the rating, or null for a line with no rating (or without data). */
  loading_label: string | null;
  /** The words behind `loading_band` ("Over rating"), or null when the line is not close to its rating. */
  loading_status: string | null;
}

export interface DeviceOverlayState {
  /** "40.0 MW" or null if labels hidden / no PF / missing data. */
  p_label: string | null;
  /** "30.4 MVAr" or null if labels hidden / no PF / missing data. */
  q_label: string | null;
  /** True if `pflowResult` is present, converged, and holds a row for this device. */
  has_data: boolean;
}

const BAND_COLOR_CLASS: Record<VoltageBand, string> = {
  success: 'border-success',
  warning: 'border-warning',
  danger: 'border-danger',
  neutral: 'border-border',
};

const NEUTRAL_BUS: BusOverlayState = {
  voltage_label: null,
  angle_label: null,
  band: 'neutral',
  side: null,
  color_class: BAND_COLOR_CLASS.neutral,
};

/**
 * Compute the visual state for a bus given a PF result. Returns the
 * neutral state when there is no PF result, the run did not converge,
 * or the bus's idx is missing from the response. `limits` are the bus's
 * own voltage limits (default: 0.95 / 1.05 pu). The band is judged in pu;
 * `display` only sets the unit the voltage label reads in (pu, or kV).
 */
export function getBusOverlayState(
  busIdx: string,
  pflowResult: PflowResult | null,
  hideLabels = false,
  limits: VoltageLimits = DEFAULT_VOLTAGE_LIMITS,
  display: Display = PER_UNIT,
): BusOverlayState {
  if (!pflowResult || !pflowResult.converged) return NEUTRAL_BUS;
  const v = pflowResult.bus_voltages[busIdx];
  const a = pflowResult.bus_angles[busIdx];
  if (v === undefined || !Number.isFinite(v)) return NEUTRAL_BUS;
  const { band, side } = assessVoltage(v, limits);
  // Convert ANDES radians → degrees for the inspector / overlay label.
  const angleDeg = a !== undefined && Number.isFinite(a) ? radToDeg(a) : null;
  return {
    voltage_label: hideLabels ? null : formatDisplayed(v, display, 3),
    angle_label: hideLabels || angleDeg === null ? null : `${angleDeg.toFixed(2)}°`,
    band,
    side,
    color_class: BAND_COLOR_CLASS[band],
  };
}

const NEUTRAL_LINE: LineOverlayState = {
  p_label: null,
  q_label: null,
  direction: 'neutral',
  has_data: false,
  loading_band: 'neutral',
  loading_label: null,
  loading_status: null,
};

/**
 * Compute the visual state for a line given a PF result. Returns the
 * neutral state when no PF result is available, the run did not
 * converge, or the line's idx is missing from `line_flows`.
 *
 * Sign convention matches the substrate (`LineFlow.p` measured at
 * terminal 1 flowing into the line):
 * - p > 0  → forward (from_idx → to_idx)
 * - p < 0  → reverse (to_idx   → from_idx)
 */
export function getLineOverlayState(
  lineIdx: string,
  pflowResult: PflowResult | null,
  hideLabels = false,
): LineOverlayState {
  if (!pflowResult || !pflowResult.converged) return NEUTRAL_LINE;
  const flows = pflowResult.line_flows;
  if (!flows) return NEUTRAL_LINE;
  const flow = flows[lineIdx];
  if (!flow) return NEUTRAL_LINE;
  const p = flow.p;
  const q = flow.q;
  const direction: LineOverlayState['direction'] = !Number.isFinite(p)
    ? 'neutral'
    : p > 0
      ? 'forward'
      : p < 0
        ? 'reverse'
        : 'neutral';
  const loading = flow.loading_pct;
  const loading_band = assessLoading(loading);
  return {
    p_label: hideLabels || !Number.isFinite(p) ? null : `${p.toFixed(2)} MW`,
    // A DC power flow computes no reactive power (``q`` is null): no label.
    q_label: hideLabels || q === null || !Number.isFinite(q) ? null : `${q.toFixed(2)} MVAr`,
    direction,
    has_data: true,
    loading_band,
    loading_label: loading_band === 'neutral' ? null : formatLoading(loading as number),
    loading_status: loadingStatusText(loading_band),
  };
}

/** How a line's stroke is drawn for each loading band. */
const LOADING_STROKE: Record<LoadingBand, { stroke: string; strokeWidth: number }> = {
  danger: { stroke: 'var(--color-danger)', strokeWidth: 3 },
  warning: { stroke: 'var(--color-warning)', strokeWidth: 2.4 },
  success: { stroke: 'var(--color-foreground)', strokeWidth: 1.8 },
  neutral: { stroke: 'var(--color-foreground)', strokeWidth: 1.8 },
};

/**
 * The stroke of a line or transformer edge: muted and thin before a power
 * flow, the foreground colour after it, and amber or red, and heavier, when
 * the line is near or past its rating. The heavier stroke and the loading
 * figure on the label say the same without the colour.
 */
export function lineStrokeStyle(overlay: LineOverlayState | null): {
  stroke: string;
  strokeWidth: number;
} {
  if (!overlay?.has_data) return { stroke: 'var(--color-muted-foreground)', strokeWidth: 1.5 };
  return LOADING_STROKE[overlay.loading_band];
}

const NEUTRAL_DEVICE: DeviceOverlayState = {
  p_label: null,
  q_label: null,
  has_data: false,
};

/**
 * One decimal keeps a device label inside the 62 px pitch the generators
 * and loads of one bus are fanned at, and a value that rounds to zero is
 * never written "-0.0".
 */
function formatPower(value: number, unit: 'MW' | 'MVAr'): string {
  const text = value.toFixed(1);
  return `${text === '-0.0' ? '0.0' : text} ${unit}`;
}

/**
 * Compute the P / Q labels of a generator or load given a PF result.
 * Returns the neutral state when no PF result is available, the run did
 * not converge, or `key` has no row in `generator_outputs` /
 * `load_consumption`.
 *
 * `key` is the device's row in that map, not always its own idx: a
 * dynamic machine (GENROU / GENCLS) has no row of its own, and one that
 * is drawn apart from its static generator reads the row of the generator
 * it names in `gen` (`graph.ts` puts the right key on the node as
 * `pflowIdx`). `null` is a node that prints no row, because another node
 * prints it, and gets the neutral state.
 *
 * Sign convention matches the substrate: generator P / Q are what the
 * machine injects (a slack bus can absorb Q, so it can be negative), load
 * P / Q are what the load draws.
 */
export function getDeviceOverlayState(
  kind: 'generator' | 'load',
  key: string | null,
  pflowResult: PflowResult | null,
  hideLabels = false,
): DeviceOverlayState {
  if (key === null || !pflowResult || !pflowResult.converged) return NEUTRAL_DEVICE;
  const row =
    kind === 'generator'
      ? pflowResult.generator_outputs?.[key]
      : pflowResult.load_consumption?.[key];
  if (!row) return NEUTRAL_DEVICE;
  return {
    p_label: hideLabels || !Number.isFinite(row.p) ? null : formatPower(row.p, 'MW'),
    q_label:
      hideLabels || row.q === null || !Number.isFinite(row.q) ? null : formatPower(row.q, 'MVAr'),
    has_data: true,
  };
}

/**
 * Where a generator's reactive output stands against its limits after a
 * converged power flow. `key` is the row of `generator_outputs` the node
 * prints, as for `getDeviceOverlayState`: `none` for a node that prints no
 * row, before a power flow, and for a generator the server sends no limits
 * for.
 */
export function getGeneratorLimitState(
  key: string | null,
  pflowResult: PflowResult | null,
): QLimitState {
  if (key === null || !pflowResult || !pflowResult.converged) return 'none';
  const row = pflowResult.generator_outputs?.[key];
  if (!row) return 'none';
  return assessQLimit(row.q, row.q_min, row.q_max);
}

/**
 * Map a band → Tailwind border class. Re-exported so callers (e.g.,
 * BusNode's streaming branch) don't have to duplicate the lookup.
 */
export function colorClassForBand(band: VoltageBand): string {
  return BAND_COLOR_CLASS[band];
}
