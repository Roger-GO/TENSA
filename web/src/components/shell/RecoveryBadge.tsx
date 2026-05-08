/**
 * RecoveryBadge. Top-bar pill that surfaces session-recovery state (Unit 5
 * of the v0.1.y plan).
 *
 * Two visual modes, driven by ``useSessionStore``:
 *
 * - ``recoveryInProgress === true`` (and ``recoveryFailed === false``) →
 *   warning-styled pill with a small spinner + "Reconnecting..." copy.
 *   Auto-hides when ``recoveryInProgress`` flips back to false (which the
 *   ``useEnsureSession`` recovery effect does once the new session id is
 *   written).
 *
 * - ``recoveryFailed === true`` → destructive-styled pill with
 *   "Reconnection failed — reload the tab" copy. Stays pinned until the
 *   user reloads the tab; the ``recoveryFailed`` flag is intentionally
 *   terminal so the user is forced into a clean recovery rather than
 *   re-entering the same failure loop.
 *
 * Non-blocking — the badge is a sibling of the other top-bar buttons, not
 * an overlay; the user can keep panning the canvas, opening modals, etc.
 * Session-scoped queries (``useTopology``, sidecar GET) are gated on
 * ``sessionId !== null`` and auto-pause during the recovery window, so no
 * additional input blocking is required.
 */
import { useSessionStore } from '@/store/session';
import { cn } from '@/lib/cn';

function Spinner() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="animate-spin"
      data-testid="recovery-badge-spinner"
    >
      <path d="M8 1.5 A6.5 6.5 0 1 1 1.5 8" />
    </svg>
  );
}

export function RecoveryBadge() {
  const recoveryInProgress = useSessionStore((s) => s.recoveryInProgress);
  const recoveryFailed = useSessionStore((s) => s.recoveryFailed);

  // Failed branch: destructive pill, stays pinned. We surface this even
  // when ``recoveryInProgress`` toggles, because the failed state is
  // terminal — the badge should not flip back to "Reconnecting..." on a
  // subsequent retry attempt.
  if (recoveryFailed) {
    return (
      <span
        role="status"
        aria-live="assertive"
        data-testid="recovery-badge-failed"
        className={cn(
          'inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs',
          'bg-destructive/10 border-destructive/40 text-destructive',
        )}
      >
        Reconnection failed — reload the tab
      </span>
    );
  }

  if (!recoveryInProgress) return null;

  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="recovery-badge"
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs',
        'bg-warning/10 border-warning/40 text-warning',
      )}
    >
      <Spinner />
      Reconnecting...
    </span>
  );
}
