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
   * ``RECOVERY_WINDOW_MS``. The badge flips to the destructive
   * "Reconnection failed — reload the tab" copy and stays pinned. The user
   * must reload the tab to recover; we deliberately do not clear this flag
   * because doing so would re-enter the same loop.
   */
  recoveryFailed: boolean;
  /**
   * Wall-clock timestamps (``Date.now()``) of recent recovery attempts.
   * Used to compute the sliding window for ``recoveryFailed``. Held inside
   * the store (rather than a module-level ref) so unit tests can clear it
   * via ``setState``.
   */
  recoveryAttempts: number[];
  setSessionId: (id: SessionId) => void;
  clearSession: () => void;
  /**
   * Initiate session recovery: clear the session id AND raise the
   * ``recoveryInProgress`` flag. Records the attempt timestamp; if more
   * than ``MAX_RECOVERY_ATTEMPTS`` have fired within
   * ``RECOVERY_WINDOW_MS``, also raises ``recoveryFailed``. Idempotent
   * when already in recovery (does not double-count attempts inside the
   * same recovery cycle — the caller is expected to debounce).
   */
  resetSession: () => void;
  /**
   * Clear the recovery flag (called by the recovery effect after the new
   * session id has been written via ``setSessionId``). Does NOT touch
   * ``recoveryFailed`` — that flag is terminal until a tab reload.
   */
  clearRecoveryInProgress: () => void;
  /**
   * Test-only helper: reset the recovery counter. Production callers should
   * not use this; the recovery-failed branch is intentionally terminal.
   */
  __resetRecoveryAttempts: () => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessionId: null,
  recoveryInProgress: false,
  recoveryFailed: false,
  recoveryAttempts: [],
  setSessionId: (id: SessionId) => set({ sessionId: id }),
  clearSession: () => set({ sessionId: null }),
  resetSession: () => {
    const now = Date.now();
    const cutoff = now - RECOVERY_WINDOW_MS;
    // Drop any attempts older than the sliding window, then append the new one.
    const recent = get().recoveryAttempts.filter((t) => t >= cutoff);
    recent.push(now);
    const failed = recent.length > MAX_RECOVERY_ATTEMPTS;
    set({
      sessionId: null,
      recoveryInProgress: true,
      recoveryFailed: failed,
      recoveryAttempts: recent,
    });
  },
  clearRecoveryInProgress: () => set({ recoveryInProgress: false }),
  __resetRecoveryAttempts: () =>
    set({ recoveryAttempts: [], recoveryFailed: false, recoveryInProgress: false }),
}));
