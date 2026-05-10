/**
 * Session slice. Tracks the active substrate session (the worker subprocess
 * the substrate spawned on `POST /sessions`).
 *
 * Lifecycle: cleared when auth clears (cross-slice cascade in
 * `store/index.ts`). Cleared when the user explicitly closes the session.
 * On a 404 from a session-scoped endpoint, the queries layer is expected
 * to call `resetSession()` (Unit 5) which clears the id AND raises the
 * `recoveryInProgress` flag — the WorkspaceFilePicker's `useEnsureSession`
 * effect picks up the flag and fires a fresh `useCreateSession.mutate()`.
 *
 * NOT persisted — the session id is only valid for the current substrate
 * process; persisting it across reloads would just produce a 404 on the
 * first request. The auth token is the only thing worth persisting.
 *
 * v2.0 polish Unit 2 — recovery state machine + stuck detection. The
 * surface state machine is:
 *
 *     idle (no recovery active)
 *       │
 *       │ resetSession()
 *       ▼
 *     connecting (recoveryInProgress=true, recoveryStuckSince=Date.now())
 *       │
 *       ├── new sessionId arrives, clearRecoveryInProgress() ──► live
 *       │
 *       ├── >10s elapsed without progress, markRecoveryFailed() ──► failed
 *       │
 *       └── >MAX_RECOVERY_ATTEMPTS in window ──► failed
 *
 * "live" is implicit — `sessionId !== null && !recoveryInProgress`. The
 * `recoveryStuckSince` timestamp is the connecting-state "started at" so
 * the App-level recovery driver can fire a 10s timeout to flip the flag
 * to ``recoveryFailed`` and surface a Reload CTA.
 */
import { create } from 'zustand';
import type { SessionId } from '@/api/types';

/**
 * Maximum recovery attempts allowed within ``RECOVERY_WINDOW_MS`` before the
 * session-recovery handler gives up and surfaces a hard error (the
 * RecoveryBadge flips to destructive styling and stays pinned). Exported so
 * tests can read the same value.
 */
export const MAX_RECOVERY_ATTEMPTS = 3;
/** Sliding window (ms) over which ``MAX_RECOVERY_ATTEMPTS`` is counted. */
export const RECOVERY_WINDOW_MS = 30_000;
/**
 * Maximum time (ms) the recovery state machine may stay in ``connecting``
 * before flipping to ``failed``. Picked at 10s because the substrate's own
 * session-create call settles in <500ms on a healthy host; anything past
 * 10s implies the substrate is unreachable, the network is offline, or
 * the worker is wedged. The user gets a Reload CTA via the badge + a
 * matching toast (Unit 2 of the v2.0 polish plan).
 */
export const RECOVERY_STUCK_TIMEOUT_MS = 10_000;

export interface SessionState {
  sessionId: SessionId | null;
  /**
   * True while the session-recovery handler is running (id cleared, waiting
   * for ``useCreateSession`` to resolve). The RecoveryBadge in the top bar
   * watches this flag and renders the "Reconnecting..." pill while it is
   * true. Auto-cleared by the recovery effect after the new session is
   * established.
   */
  recoveryInProgress: boolean;
  /**
   * Set to true once ``MAX_RECOVERY_ATTEMPTS`` recoveries have fired within
   * ``RECOVERY_WINDOW_MS``, OR once the connecting state has stayed up for
   * more than ``RECOVERY_STUCK_TIMEOUT_MS`` (Unit 2 of the v2.0 polish
   * plan). The badge flips to the destructive "Cannot reach substrate"
   * copy and stays pinned with a Reload CTA. The user must reload the
   * tab to recover; we deliberately do not clear this flag because doing
   * so would re-enter the same loop.
   */
  recoveryFailed: boolean;
  /**
   * Wall-clock timestamps (``Date.now()``) of recent recovery attempts.
   * Used to compute the sliding window for ``recoveryFailed``. Held inside
   * the store (rather than a module-level ref) so unit tests can clear it
   * via ``setState``.
   */
  recoveryAttempts: number[];
  /**
   * Wall-clock timestamp (``Date.now()``) at which the current
   * ``connecting`` state began. Null when not currently connecting (i.e.
   * idle or live or failed). Set by ``resetSession()``; cleared by
   * ``clearRecoveryInProgress()`` and by ``markRecoveryFailed()``. The
   * App-level recovery driver uses this as the start of its 10s
   * stuck-detection timeout.
   */
  recoveryStuckSince: number | null;
  setSessionId: (id: SessionId) => void;
  clearSession: () => void;
  /**
   * Initiate session recovery: clear the session id AND raise the
   * ``recoveryInProgress`` flag. Records the attempt timestamp; if more
   * than ``MAX_RECOVERY_ATTEMPTS`` have fired within
   * ``RECOVERY_WINDOW_MS``, also raises ``recoveryFailed``. Idempotent
   * when already in recovery (does not double-count attempts inside the
   * same recovery cycle — the caller is expected to debounce). Stamps
   * ``recoveryStuckSince`` with the current time on the first transition
   * into ``connecting`` (preserves an existing stamp on re-entrant
   * calls so the 10s timeout is measured from the first attempt, not
   * the most recent).
   */
  resetSession: () => void;
  /**
   * Clear the recovery flag (called by the recovery effect after the new
   * session id has been written via ``setSessionId``). Does NOT touch
   * ``recoveryFailed`` — that flag is terminal until a tab reload. Also
   * clears ``recoveryStuckSince`` so the next connecting cycle gets a
   * fresh stamp.
   */
  clearRecoveryInProgress: () => void;
  /**
   * Force the recovery state machine into ``failed``. Called by the
   * App-level recovery driver when its 10s stuck-detection timeout
   * elapses. Idempotent: if the state has already moved past connecting
   * (sessionId arrived, or recoveryFailed already set), this is a no-op
   * — no point flipping a healthy live state into failed because of a
   * stale timer that happened to fire after recovery succeeded.
   */
  markRecoveryFailed: () => void;
  /**
   * Hard reset: clear sessionStorage + reload the tab. The Reload CTA on
   * the failed-state badge calls this, and the cmdk "Reset session"
   * action will too once Unit 9 wires cmdk in. Exposed as a store action
   * (rather than letting each call site reach for ``window.location``)
   * so tests can stub it via ``setState`` and so the cleanup logic
   * stays centralised.
   */
  hardReset: () => void;
  /**
   * Test-only helper: reset the recovery counter. Production callers should
   * not use this; the recovery-failed branch is intentionally terminal.
   */
  __resetRecoveryAttempts: () => void;
}

/**
 * Performs the hard-reset side effects: clear sessionStorage, then reload
 * the tab. Pulled out of the store action so tests can swap the
 * implementation via ``setHardResetImpl`` (jsdom forbids redefining
 * ``window.location.reload`` directly).
 */
function defaultHardReset(): void {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      window.sessionStorage.clear();
    }
  } catch (err) {
    // Sandbox / privacy-mode browsers may throw on sessionStorage access.
    // Don't let that block the reload — the reload IS the recovery.
    console.warn('hardReset: sessionStorage clear threw, continuing to reload', err);
  }
  if (typeof window !== 'undefined' && window.location) {
    window.location.reload();
  }
}

let hardResetImpl: () => void = defaultHardReset;

/**
 * Test seam: swap the side-effect implementation invoked by
 * ``hardReset``. Production callers should never use this — the default
 * implementation is the entire contract. Tests use it because jsdom
 * does not allow redefining ``window.location.reload``.
 */
export function setHardResetImpl(impl: () => void): void {
  hardResetImpl = impl;
}

/** Test seam: restore the production hard-reset implementation. */
export function resetHardResetImpl(): void {
  hardResetImpl = defaultHardReset;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessionId: null,
  recoveryInProgress: false,
  recoveryFailed: false,
  recoveryAttempts: [],
  recoveryStuckSince: null,
  setSessionId: (id: SessionId) => set({ sessionId: id }),
  clearSession: () => set({ sessionId: null }),
  resetSession: () => {
    const now = Date.now();
    const cutoff = now - RECOVERY_WINDOW_MS;
    // Drop any attempts older than the sliding window, then append the new one.
    const recent = get().recoveryAttempts.filter((t) => t >= cutoff);
    recent.push(now);
    const failed = recent.length > MAX_RECOVERY_ATTEMPTS;
    // Preserve an existing ``recoveryStuckSince`` stamp on re-entrant calls
    // — the 10s stuck-detection timer measures from the first transition
    // into connecting, not the most recent attempt. A burst of 404s
    // shouldn't reset the user's perceived "how long has this been
    // connecting" clock.
    const prevStuckSince = get().recoveryStuckSince;
    set({
      sessionId: null,
      recoveryInProgress: true,
      recoveryFailed: failed,
      recoveryAttempts: recent,
      recoveryStuckSince: failed ? null : (prevStuckSince ?? now),
    });
  },
  clearRecoveryInProgress: () =>
    set({ recoveryInProgress: false, recoveryStuckSince: null }),
  markRecoveryFailed: () => {
    const state = get();
    // Idempotency: don't flip a state that's already past connecting.
    // (a) sessionId arrived → we're live now, the timer is stale.
    // (b) recoveryFailed already set → another path already failed us.
    // (c) recoveryInProgress is false → we're idle; nothing to fail.
    if (state.sessionId !== null) return;
    if (state.recoveryFailed) return;
    if (!state.recoveryInProgress) return;
    set({
      recoveryFailed: true,
      recoveryStuckSince: null,
    });
  },
  hardReset: () => hardResetImpl(),
  __resetRecoveryAttempts: () =>
    set({
      recoveryAttempts: [],
      recoveryFailed: false,
      recoveryInProgress: false,
      recoveryStuckSince: null,
    }),
}));
