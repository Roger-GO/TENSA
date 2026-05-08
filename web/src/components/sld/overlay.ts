/**
 * Pure helpers that translate a `PflowResult` into per-element visual
 * state for the SLD canvas (Unit 9).
 *
 * Lives in its own module so:
 *
 * - The functions can be unit-tested without spinning up a ReactFlow
 *   render or the case store.
 * - Bus / line nodes consume the helpers via plain function calls and
 *   stay thin.
 *
 * Voltage band thresholds default to the standard 0.95 / 1.05 pu limits
 * with a tighter 0.97 / 1.03 amber band; v0.5 will make these per-bus
 * configurable.
 */
import type { PflowResult } from '@/api/types';

/** Voltage band classification for a bus. */
export type VoltageBand = 'success' | 'warning' | 'danger' | 'neutral';

export interface BusOverlayState {
  /** "1.060 pu" or null if labels hidden / no PF / missing data. */
  voltage_label: string | null;
  /** "0.00°" (degrees) or null if labels hidden / no PF / missing data. */
  angle_label: string | null;
  /** Classification used by the bus node to pick a stroke / border class. */
  band: VoltageBand;
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
}

/** Default voltage thresholds (pu). */
export const VOLTAGE_LIMITS = {
  /** Below this is danger (limit-violation). */
  danger_low: 0.95,
  /** Below this (but above danger_low) is warning. */
  warning_low: 0.97,
  /** Above this (but below danger_high) is warning. */
  warning_high: 1.03,
  /** Above this is danger (limit-violation). */
  danger_high: 1.05,
} as const;

/** Map a voltage to a band. Pure; exported for testing. */
export function classifyVoltage(v: number): VoltageBand {
  if (!Number.isFinite(v)) return 'neutral';
  if (v < VOLTAGE_LIMITS.danger_low || v > VOLTAGE_LIMITS.danger_high) return 'danger';
  if (v < VOLTAGE_LIMITS.warning_low || v > VOLTAGE_LIMITS.warning_high) return 'warning';
  return 'success';
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
  color_class: BAND_COLOR_CLASS.neutral,
};

/**
 * Compute the visual state for a bus given a PF result. Returns the
 * neutral state when there is no PF result, the run did not converge,
 * or the bus's idx is missing from the response.
 */
export function getBusOverlayState(
  busIdx: string,
  pflowResult: PflowResult | null,
  hideLabels = false,
): BusOverlayState {
  if (!pflowResult || !pflowResult.converged) return NEUTRAL_BUS;
  const v = pflowResult.bus_voltages[busIdx];
  const a = pflowResult.bus_angles[busIdx];
  if (v === undefined || !Number.isFinite(v)) return NEUTRAL_BUS;
  const band = classifyVoltage(v);
  // Convert ANDES radians → degrees for the inspector / overlay label.
  const angleDeg = a !== undefined && Number.isFinite(a) ? (a * 180) / Math.PI : null;
  return {
    voltage_label: hideLabels ? null : `${v.toFixed(3)} pu`,
    angle_label: hideLabels || angleDeg === null ? null : `${angleDeg.toFixed(2)}°`,
    band,
    color_class: BAND_COLOR_CLASS[band],
  };
}

const NEUTRAL_LINE: LineOverlayState = {
  p_label: null,
  q_label: null,
  direction: 'neutral',
  has_data: false,
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
  return {
    p_label: hideLabels || !Number.isFinite(p) ? null : `${p.toFixed(2)} MW`,
    q_label: hideLabels || !Number.isFinite(q) ? null : `${q.toFixed(2)} MVAr`,
    direction,
    has_data: true,
  };
}
