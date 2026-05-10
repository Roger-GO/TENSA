/**
 * Top-level session lifecycle driver. Mounted once from ``App.tsx`` so the
 * "I need a session" cycle is owned by exactly one place — including the
 * common case where the user has already loaded a case and the
 * ``WorkspaceFilePicker`` is no longer mounted (and therefore can't run
 * its own version of this effect).
 *
 * Single source of truth: this hook is the ONLY caller of
 * ``useCreateSession.mutate()`` in the app. Every other consumer reads
 * ``sessionId`` from the session store and waits. The picker, the case
 * nav's "Change case" flow, and the global 404-recovery handler all rely
 * on this hook to fire the create.
 *
 * Bug history:
 *
 * - v0.1.y Unit 5 originally placed the recovery effect inside
 *   ``WorkspaceFilePicker.useEnsureSession``. That worked for the
 *   "stale-session-on-first-paint" path but the picker unmounts once a
 *   case is loaded — so a 404 raised mid-session left the badge pinned on
 *   "Reconnecting..." forever with no effect to drive the cycle. The fix
 *   was to mount the recovery driver from the App root.
 *
 * - v0.2 polish Unit 1: the picker still owned its own initial-create
 *   cycle (a separate ``useCreateSession`` instance from the one fired by
 *   ``CaseNav.onConfirmChangeCase``). The two instances would race during
 *   the change-case flow — both would fire ``POST /sessions``, the
 *   substrate would mint two sessions, and only one ``setSessionId`` call
 *   won. The picker frequently rendered against the loser, so the next
 *   ``loadCase.mutate`` posted to a 404'd session id and the Load click
 *   silently failed (recovered by the global 404 handler, which restarted
 *   the whole cycle). Phase-1-smoke Issue 2 reproduced this every time.
 *
 *   The fix consolidates ALL ``useCreateSession`` calls into this single
 *   App-level driver. The picker no longer creates; it just reads
 *   ``sessionId`` from the store. CaseNav's change-case flow no longer
 *   calls ``createSession.mutate()`` after delete; it just relies on
 *   sessionId becoming null and the auto-create branch below noticing.
 *
 * Responsibilities (post-v0.2-Unit-1):
 *
 * 1. **Auto-create** when ``tokenPresent && sessionId === null`` and we
 *    are NOT currently in a recovery cycle. This covers (a) first paint
 *    after auth, and (b) the post-change-case window where CaseNav has
 *    fired DELETE and the session has been cleared.
 * 2. **Recovery edge:** on the ``recoveryInProgress`` ``false → true``
 *    edge, clear any in-flight ``createSession`` error and fire a fresh
 *    ``createSession.mutate()``. (Same code path as #1, but the recovery
 *    flag tracks the bridge from "had a session, lost it to 404" to
 *    "got a fresh one and need to re-load the case".)
 * 3. **Re-load:** after the new session id lands AND a previously-loaded
 *    case path is still in the case slice, re-fire ``loadCase`` against
 *    the new id so the workspace returns to its pre-recovery state.
 * 4. **Clear flag:** clear ``recoveryInProgress`` once the re-load
 *    settles (success OR error — a failed re-load surfaces normally
 *    rather than pinning the spinner forever).
 *
 * Per-instance debounce: prevent rapid-fire create attempts from
 * re-render loops. Allows at most one mutate() call per second from this
 * hook. The recovery handler in queries.ts has its own module-level
 * debounce for the 404→reset path.
 */
import { useEffect, useRef } from 'react';
import { useCreateSession, useLoadCase } from './queries';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { useAuthStore } from '@/store/auth';

const CREATE_DEBOUNCE_MS = 1_000;

export function useSessionRecovery(): void {
  const tokenPresent = useAuthStore((s) => s.token !== null);
  const recoveryInProgress = useSessionStore((s) => s.recoveryInProgress);
  const recoveryFailed = useSessionStore((s) => s.recoveryFailed);
  const sessionId = useSessionStore((s) => s.sessionId);
  const clearRecoveryInProgress = useSessionStore((s) => s.clearRecoveryInProgress);
  const caseSelection = useCaseStore((s) => s.selection);
  const createSession = useCreateSession();
  const loadCase = useLoadCase();

  // Edge tracker for recovery: only act on the false → true transition.
  const recoveryStartedRef = useRef(false);
  const reloadFiredRef = useRef(false);
  // Per-instance debounce timestamp for the auto-create branch — guards
  // against re-render storms firing back-to-back mutate() calls within the
  // same second.
  const lastCreateAttemptRef = useRef<number>(0);

  // ---- Branch (1+2): auto-create + recovery-edge create -------------------
  //
  // The two branches share the same mutate() call but trigger on different
  // edges. Auto-create fires whenever sessionId is null and we have a
  // token; recovery-edge clears any prior error first so a stuck
  // ``isError`` doesn't pin the cycle.
  const createIsError = createSession.isError;
  const createIsPending = createSession.isPending;

  useEffect(() => {
    // Recovery edge: false → true. Reset stale error state so the
    // subsequent auto-create branch's gate can re-evaluate cleanly.
    if (recoveryInProgress && !recoveryStartedRef.current) {
      recoveryStartedRef.current = true;
      reloadFiredRef.current = false;
      createSession.reset();
    }
    if (!recoveryInProgress) {
      recoveryStartedRef.current = false;
      reloadFiredRef.current = false;
    }
    // ``createSession`` excluded from deps (TanStack mutation objects are
    // not referentially stable across renders).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoveryInProgress]);

  useEffect(() => {
    // Auto-create. Fires whenever:
    //
    // - the user is authed
    // - we have no session id
    // - no create is in flight
    // - we are not in a permanent recovery-failed state (the badge tells
    //   the user to reload the tab; firing more creates won't help)
    //
    // Includes a 1s per-instance debounce so a re-render burst can't fire
    // multiple POSTs within the same window. Note the gate intentionally
    // does NOT exclude ``createSession.isError``: a previous failure
    // should not permanently block the cycle. The recovery edge above
    // calls ``createSession.reset()`` to scrub stale error state for UI;
    // this gate just allows the next attempt as soon as nothing is in
    // flight.
    if (!tokenPresent) return;
    if (sessionId !== null) return;
    if (createIsPending) return;
    if (recoveryFailed) return;
    const now = Date.now();
    if (now - lastCreateAttemptRef.current < CREATE_DEBOUNCE_MS) return;
    lastCreateAttemptRef.current = now;
    createSession.mutate();
    // ``createSession`` excluded from deps for the same reason as above.
    // The dep array tracks the gate's primitive inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenPresent, sessionId, createIsPending, createIsError, recoveryFailed, recoveryInProgress]);

  // ---- Branch (3+4): re-load case after recovery --------------------------
  useEffect(() => {
    // Once the new session id has been written and a case path is still
    // in the case slice, re-issue ``loadCase``.
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
