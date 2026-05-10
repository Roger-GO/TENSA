/**
 * EIG-scatter view micro-bus (Unit 15 of the v2.0 polish plan).
 *
 * The EIG scatter's zoom + log-toggle state lives inside ``EIGScatter``
 * as ``useState`` (transient view state, not domain data — see KTD-15).
 * Two palette / cmdk commands need to drive that state from outside
 * the component:
 *
 *   - ``analyze.eig.reset-zoom`` → "Reset EIG zoom"
 *   - ``analyze.eig.toggle-log`` → "Toggle EIG log scale"
 *
 * A Zustand slice would be overkill (no other consumer + no need for
 * derived selectors), so we use the same lightweight pub-sub pattern
 * used by the palette → local-dialog bridge in ``commands.ts``.
 *
 * Lifecycle: ``EIGScatter`` subscribes once on mount and unsubscribes
 * on unmount. If the component isn't mounted (e.g., user is on PFlow
 * sub-mode) the commands fire a no-op — the palette filters them out
 * unconditionally because the buttons live inside the chart's chrome
 * anyway.
 */

type ResetListener = () => void;
type LogToggleListener = () => void;

const resetListeners: Set<ResetListener> = new Set();
const logToggleListeners: Set<LogToggleListener> = new Set();

export function subscribeEigViewReset(listener: ResetListener): () => void {
  resetListeners.add(listener);
  return () => {
    resetListeners.delete(listener);
  };
}

export function requestEigViewReset(): void {
  for (const l of resetListeners) l();
}

export function subscribeEigLogToggle(listener: LogToggleListener): () => void {
  logToggleListeners.add(listener);
  return () => {
    logToggleListeners.delete(listener);
  };
}

export function requestEigLogToggle(): void {
  for (const l of logToggleListeners) l();
}

/** Test-only helper: drop all listeners (avoids cross-test bleed). */
export function __resetEigViewBus(): void {
  resetListeners.clear();
  logToggleListeners.clear();
}
