/**
 * Pure helpers that translate a `PflowResult` into per-element visual
 * state for the SLD canvas (Unit 9 of v0.1) AND a TDS frame stream
 * into the per-bus animation overlay (Unit 5 of v0.2).
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
import { useEffect } from 'react';
import type { PflowResult } from '@/api/types';
import { useRunsStore, type RunRecord } from '@/store/runs';
import { findClosestFrameIdx, parseColumnName, usePlotStore } from '@/store/plot';
import { useAnimationStore, type BusOverlayMap, type FrameBusOverlay } from '@/store/animation';

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

// ---- frame-driven overlay (v0.2 Unit 5) ----------------------------------

/**
 * Map a band → Tailwind border class. Re-exported so callers (e.g.,
 * BusNode's streaming branch) don't have to duplicate the lookup.
 */
export function colorClassForBand(band: VoltageBand): string {
  return BAND_COLOR_CLASS[band];
}

/**
 * Pure helper: pick the frame index a streaming overlay should read
 * for the given run + scrub state.
 *
 * - ``scrubT === null`` → live mode: latest frame index (``seqCount - 1``).
 *   Returns ``-1`` when the run has zero frames yet.
 * - ``scrubT !== null`` → scrub mode: nearest frame at or before scrubT.
 *   Returns ``-1`` when ``scrubT < t[0]``.
 *
 * Edge case: ``scrubT > t_max`` (user seeked past the buffered range,
 * common when scrubbing during a still-streaming run that hasn't
 * reached the requested ``tf`` yet) → returns the last buffered frame.
 * ``findClosestFrameIdx`` already handles this branch.
 */
export function pickFrameIdx(run: RunRecord, scrubT: number | null): number {
  if (run.seqCount <= 0) return -1;
  if (scrubT === null) return run.seqCount - 1;
  return findClosestFrameIdx(run.t, run.seqCount, scrubT);
}

/**
 * Pure helper: extract the per-bus overlay slot for one frame index.
 *
 * Walks the run's column-name list, picks out the ``Bus_<idx>_v``
 * columns, and classifies each. Generator / line columns are skipped
 * (they don't drive bus coloring).
 *
 * Returns an empty map when ``frameIdx < 0`` (no buffered frame yet) so
 * callers can use a single ``map.size === 0`` check to distinguish "no
 * data" from "data, all neutral".
 *
 * Pure / synchronous / no React — testable directly.
 */
export function getFrameBusOverlay(run: RunRecord, frameIdx: number): BusOverlayMap {
  if (frameIdx < 0) return new Map();
  const out = new Map<string, FrameBusOverlay>();
  for (const name of run.columnNames) {
    const parsed = parseColumnName(name);
    // The bus_v group now carries BOTH voltage (field 'v') and angle
    // (field 'a') columns per bus. Only the voltage magnitude drives bus
    // coloring — skip the angle column, or it would overwrite the band
    // classification depending on column iteration order.
    if (!parsed || parsed.group !== 'bus_v' || parsed.field !== 'v') continue;
    const col = run.columns[name];
    if (!col) continue;
    // Defensive: a frame index past the column's logical length would
    // read into the over-allocated tail (which contains zeros). Only
    // bus_v columns from the run's authoritative ``columnNames`` list
    // reach this point, and the runs-slice append loop keeps every
    // tracked column's logical length in lockstep with ``seqCount``,
    // so this branch is mainly for paranoia.
    if (frameIdx >= run.seqCount) continue;
    const v = col[frameIdx]!;
    out.set(parsed.elementIdx, { band: classifyVoltage(v), voltage: v });
  }
  return out;
}

/**
 * Decide whether a run should drive the streaming overlay at all. The
 * overlay is active for ``starting`` + ``streaming`` runs (frames may
 * still be flowing in) and for any run that's been scrubbed (``scrubT``
 * is non-null — even a finished run is "active" for scrubbing).
 *
 * For ``done`` / ``error`` / ``aborted`` runs with no scrub set, we
 * stop ticking and clear the overlay so BusNode falls back to its PF
 * coloring (and the rAF loop has nothing to drive). The plan calls
 * this out explicitly: "no point animating a finished run unless
 * scrubbing, in which case scrubT drives it directly without rAF".
 */
function isOverlayActive(state: RunRecord['state'], scrubT: number | null): boolean {
  if (state === 'starting' || state === 'streaming') return true;
  if (scrubT !== null) return true;
  return false;
}

/**
 * Single rAF loop driving the SLD streaming overlay for the active run.
 *
 * Mounted ONCE at the App root (alongside ``useSessionRecovery``). The
 * loop runs at the browser's native rAF cadence — typically 60 Hz, so
 * each tick reads the *latest* frame from the runs slice and pushes the
 * derived bus map into the animation slice. If frames arrive faster
 * than rAF (TDS streams can hit 1 kHz with batched frames), intermediate
 * frames are skipped — animation IS the latest state, not every state,
 * which matches the plan's "decoupled from frame rate" requirement.
 *
 * The loop is self-gating:
 *
 * - When there's no active run, no rAF is scheduled.
 * - When the active run is ``done`` / ``error`` / ``aborted`` AND not
 *   being scrubbed, the loop tears down (one final overlay write
 *   reflecting the last frame is left in place — no, wait, we CLEAR
 *   the overlay so BusNode reverts to the PF-result path).
 * - When the active run id changes, the previous run's overlay is
 *   cleared so a stale band doesn't linger on a screen showing a fresh
 *   run.
 *
 * Test-friendliness: the loop reads runs / plot state via
 * ``getState()`` (not React subscriptions) so the rAF callback isn't a
 * stale closure of the values at effect-mount. Identical pattern to
 * the ScrubControl's playback loop.
 */
export function useSldFrameOverlay(): void {
  // We re-run the effect (cancel + re-arm the rAF loop) on the two
  // edges that actually matter:
  //
  // - Active run id flip → previous run's overlay must be cleared,
  //   new run's overlay starts fresh.
  // - Active run state flip → so the "finished + not scrubbed → stop
  //   ticking" branch fires when a run completes.
  //
  // Scrub-time changes are NOT a dependency. The rAF callback re-reads
  // ``scrubByRun`` via ``getState()`` on every tick, so a scrub change
  // is picked up within ~16 ms without restarting the loop. Restarting
  // on every pointermove during a drag would cancel + re-issue rAF
  // dozens of times a second.
  //
  // The "scrubbed-finished run still animates" case is also handled
  // by the in-tick read: when the user starts scrubbing a finished
  // run, ``scrubByRun[runId]`` flips from null to a number — the
  // current tick (or the first tick after the next state change)
  // sees the non-null scrub and keeps ticking. If the loop is already
  // torn down (run finished without ever being scrubbed), see the
  // ``useEffect`` below the main one for the kick-start path.
  const activeRunId = useRunsStore((s) => s.activeRunId);
  const activeRunState = useRunsStore((s) =>
    s.activeRunId ? (s.runs[s.activeRunId]?.state ?? null) : null,
  );
  // Track scrubT separately as a "should we re-arm" trigger: the
  // null ↔ non-null transition is the only one that matters (a finished
  // run that wasn't being scrubbed should kick the loop back on when
  // the user grabs the scrub cursor for the first time).
  const scrubIsNull = usePlotStore((s) =>
    activeRunId ? (s.scrubByRun[activeRunId] ?? null) === null : true,
  );

  useEffect(() => {
    if (!activeRunId) return undefined;

    let raf = 0;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      const run = useRunsStore.getState().runs[activeRunId];
      if (!run) {
        // Run was reset out from under us — bail.
        useAnimationStore.getState().clearOverlayForRun(activeRunId);
        return;
      }
      const liveScrub = usePlotStore.getState().scrubByRun[activeRunId] ?? null;
      if (!isOverlayActive(run.state, liveScrub)) {
        // Finished + not scrubbed → tear down the overlay so BusNode
        // returns to the PF-result coloring path. Don't reschedule.
        useAnimationStore.getState().clearOverlayForRun(activeRunId);
        return;
      }
      const frameIdx = pickFrameIdx(run, liveScrub);
      const overlay = getFrameBusOverlay(run, frameIdx);
      useAnimationStore.getState().setBusOverlayForRun(activeRunId, overlay);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      if (raf !== 0) cancelAnimationFrame(raf);
      // Clear the active run's overlay on cleanup so a switch to
      // another run doesn't leave the previous run's bands rendered
      // until the next tick lands.
      useAnimationStore.getState().clearOverlayForRun(activeRunId);
    };
  }, [activeRunId, activeRunState, scrubIsNull]);
}
