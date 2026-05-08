/**
 * Top-level session-recovery hook. Mounted once from ``App.tsx`` so the
 * recovery cycle is alive for the lifetime of the tab — including the
 * common case where the user has already loaded a case and the
 * ``WorkspaceFilePicker`` is no longer mounted (and therefore can't run
 * its own version of this effect).
 *
 * Bug history: v0.1.y Unit 5 originally placed the recovery effect inside
 * ``WorkspaceFilePicker.useEnsureSession``. That works for the
 * "stale-session-on-first-paint" path, but the picker unmounts once a
 * case is loaded — so a 404 raised mid-session left the badge pinned on
 * "Reconnecting..." forever with no effect to drive the cycle. The fix
 * is to mount the recovery driver from the App root.
 *
 * Responsibilities:
 *
 * 1. On the ``recoveryInProgress`` ``false → true`` edge: clear any
 *    in-flight ``createSession`` error/state and fire a fresh
 *    ``createSession.mutate()``.
 * 2. After the new session id lands AND a previously-loaded case path is
 *    still in the case slice: re-fire ``loadCase`` against the new id
 *    so the workspace returns to its pre-recovery state.
 * 3. Clear ``recoveryInProgress`` once the re-load settles (success OR
 *    error — a failed re-load surfaces normally rather than pinning the
 *    spinner forever).
 *
 * The picker keeps its own initial-create cycle (for the "first-paint
 * before any case is loaded" path); this hook handles everything that
 * happens after.
 */
import { useEffect, useRef } from 'react';
import { useCreateSession, useLoadCase } from './queries';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';

export function useSessionRecovery(): void {
  const recoveryInProgress = useSessionStore((s) => s.recoveryInProgress);
  const sessionId = useSessionStore((s) => s.sessionId);
  const clearRecoveryInProgress = useSessionStore((s) => s.clearRecoveryInProgress);
  const caseSelection = useCaseStore((s) => s.selection);
  const createSession = useCreateSession();
  const loadCase = useLoadCase();

  // Edge tracker: only act on the false → true transition.
  const recoveryStartedRef = useRef(false);
  const reloadFiredRef = useRef(false);

  useEffect(() => {
    if (recoveryInProgress && !recoveryStartedRef.current) {
      recoveryStartedRef.current = true;
      reloadFiredRef.current = false;
      // Clear any prior error state on the create mutation so a fresh
      // attempt can fire.
      createSession.reset();
      // Trigger the create cycle. ``mutate`` is idempotent against an
      // already-in-flight call (TanStack Query coalesces).
      createSession.mutate();
    }
    if (!recoveryInProgress) {
      recoveryStartedRef.current = false;
      reloadFiredRef.current = false;
    }
    // ``createSession`` is intentionally excluded from deps (mutation
    // objects aren't referentially stable across renders).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoveryInProgress]);

  useEffect(() => {
    // Bridge step 2 + 3: once the new session id has been written and a
    // case path is still in the case slice, re-issue ``loadCase``.
    if (!recoveryInProgress) return;
    if (sessionId === null) return;
    if (reloadFiredRef.current) return;

    if (caseSelection === null || caseSelection.primaryPath === null) {
      // Blank session pre-recovery; nothing to re-load.
      reloadFiredRef.current = true;
      clearRecoveryInProgress();
      return;
    }

    reloadFiredRef.current = true;
    loadCase.mutate(
      {
        sessionId,
        request: {
          primary_path: caseSelection.primaryPath,
          addfiles: caseSelection.addfiles.length > 0 ? caseSelection.addfiles : null,
        },
      },
      {
        onSettled: () => {
          // Settled — drop out of the recovery state regardless of
          // success/error so the user sees the load error normally.
          clearRecoveryInProgress();
        },
      },
    );
    // ``loadCase`` excluded for the same stability reason as createSession.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoveryInProgress, sessionId, caseSelection, clearRecoveryInProgress]);
}
