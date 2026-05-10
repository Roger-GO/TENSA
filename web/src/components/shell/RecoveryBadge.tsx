/**
 * RecoveryBadge. Top-bar pill that surfaces session-recovery state.
 *
 * Three visual modes, driven by ``useSessionStore``:
 *
 * - ``recoveryInProgress === true`` (and ``recoveryFailed === false``) →
 *   warning-styled pill with a small spinner + "Reconnecting..." copy.
 *   Auto-hides when ``recoveryInProgress`` flips back to false (which the
 *   App-level recovery driver does once the new session id is written).
 *
 * - ``recoveryFailed === true`` → danger-styled pill with a "Cannot
 *   reach substrate" message AND an inline "Reload" button. Stays
 *   pinned until the user reloads the tab; the ``recoveryFailed`` flag
 *   is intentionally terminal so the user is forced into a clean
 *   recovery rather than re-entering the same failure loop. The Reload
 *   button calls the store's ``hardReset`` action (sessionStorage clear
 *   + tab reload) so the user has a one-click affordance for the same
 *   "Reload" instruction the toast surfaces.
 *
 * - hidden — neither flag set; nothing to surface.
 *
 * Non-blocking — the badge is a sibling of the other top-bar buttons, not
 * an overlay; the user can keep panning the canvas, opening modals, etc.
 * Session-scoped queries (``useTopology``, sidecar GET) are gated on
 * ``sessionId !== null`` and auto-pause during the recovery window, so no
 * additional input blocking is required.
 *
 * v2.0 polish Unit 2 — extended the failed branch with an inline Reload
 * affordance. The previous copy ("Reconnection failed — reload the tab")
 * told the user what to do but gave them nothing to click; the toast
 * fired by the recovery driver is the louder surface, and this badge
 * matches it so a user who dismissed the toast still has the recovery
 * path one click away.
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
  const hardReset = useSessionStore((s) => s.hardReset);

  // Failed branch: danger pill, stays pinned. We surface this even
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
          'inline-flex items-center gap-2 rounded-full border px-2 py-1 text-xs',
          'bg-danger/10 border-danger/40 text-danger',
        )}
      >
        <span>Cannot reach substrate</span>
        <button
          type="button"
          data-testid="recovery-badge-reload"
          onClick={() => hardReset()}
          className={cn(
            'border-danger/40 bg-danger/10 rounded-full border px-2 py-0.5 text-xs',
            'hover:bg-danger/20 focus:ring-danger/40 focus:ring-2 focus:outline-none',
          )}
        >
          Reload
        </button>
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
