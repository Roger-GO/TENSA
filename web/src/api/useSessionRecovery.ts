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
 *
 * v2.0 polish Unit 2 — stuck-detection + transition telemetry:
 *
 * 5. **Stuck timer:** on the ``connecting`` entry edge, schedule a 10s
 *    timeout that flips the state to ``failed`` if the new sessionId
 *    hasn't arrived. Cancelled on a clean exit (live or already failed).
 * 6. **Transition toasts (per Unit 3 toast policy):**
 *      - ``failed → connecting → live`` ⇒ ``toast.success("Reconnected")``.
 *        The user just saw the failed badge; surface the recovery so
 *        they know the app is usable again.
 *      - ``connecting → failed`` ⇒ ``toast.error("Cannot reach
 *        substrate", { action: { label: "Reload", ... } })``. The
 *        Reload action calls the store's ``hardReset`` (sessionStorage
 *        clear + tab reload) so the user has one click to recover.
 *      - The initial ``idle → connecting → live`` cold-start is silent.
 *        The user expects an app to start; toasting "Connected" for
 *        every session boot is noise.
 * 7. **Transition logger:** every state transition is forwarded to
 *    ``console.info`` (overridable via ``setRecoveryLogger`` for tests
 *    + future telemetry sinks). The logger gives us a paper trail for
 *    "the badge said failed but I never saw a toast" diagnosis and is
 *    where a future analytics integration would tap in.
 */
import { useEffect, useRef } from 'react';
import { useCreateSession, useLoadCase } from './queries';
import { useSessionStore, RECOVERY_STUCK_TIMEOUT_MS } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { useAuthStore } from '@/store/auth';
import { toast } from '@/lib/toast';

const CREATE_DEBOUNCE_MS = 1_000;

/**
 * Recovery state surfaced to the UI / logger. Derived from the session
 * store: 'idle' when nothing is going on, 'connecting' during recovery
 * (or initial cold-start before sessionId arrives), 'live' once a session
 * id is present, 'failed' when the recovery state machine has given up.
 */
export type RecoveryState = 'idle' | 'connecting' | 'live' | 'failed';

/**
 * Pure reducer for the surface state. Keeps the derivation logic next to
 * the documented state-machine diagram in ``session.ts`` and makes the
 * transitions trivially unit-testable.
 */
export function deriveRecoveryState(args: {
  sessionId: unknown;
  recoveryInProgress: boolean;
  recoveryFailed: boolean;
}): RecoveryState {
  if (args.recoveryFailed) return 'failed';
  if (args.recoveryInProgress) return 'connecting';
  if (args.sessionId !== null) return 'live';
  return 'idle';
}

/**
 * Logger sink for recovery transitions. Defaults to ``console.info``
 * with a stable prefix; tests override it via ``setRecoveryLogger`` to
 * assert on the emitted transitions without parsing console output. A
 * future telemetry integration (Sentry / structured analytics) would
 * also plug in here.
 */
export type RecoveryLogger = (
  transition: { from: RecoveryState; to: RecoveryState; at: number },
) => void;

let recoveryLogger: RecoveryLogger = ({ from, to, at }) => {
  // eslint-disable-next-line no-console
  console.info(`[session-recovery] ${from} → ${to} at ${new Date(at).toISOString()}`);
};

export function setRecoveryLogger(logger: RecoveryLogger): void {
  recoveryLogger = logger;
}

export function resetRecoveryLogger(): void {
  recoveryLogger = ({ from, to, at }) => {
    // eslint-disable-next-line no-console
    console.info(`[session-recovery] ${from} → ${to} at ${new Date(at).toISOString()}`);
  };
}

export function useSessionRecovery(): void {
  const tokenPresent = useAuthStore((s) => s.token !== null);
  const recoveryInProgress = useSessionStore((s) => s.recoveryInProgress);
  const recoveryFailed = useSessionStore((s) => s.recoveryFailed);
  const sessionId = useSessionStore((s) => s.sessionId);
  const clearRecoveryInProgress = useSessionStore((s) => s.clearRecoveryInProgress);
  const markRecoveryFailed = useSessionStore((s) => s.markRecoveryFailed);
  const hardReset = useSessionStore((s) => s.hardReset);
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

  // ---- v2.0 Unit 2: surface state machine + transition telemetry ----------
  //
  // Track the previous derived state across renders so we can fire the
  // logger + transition-specific toasts on the actual edge (rather than
  // on every render where the inputs happen to match the target). The
  // initial value is 'idle' so the cold-start path emits an
  // ``idle → connecting`` transition rather than a phantom ``unknown →
  // connecting``.
  const prevStateRef = useRef<RecoveryState>(
    deriveRecoveryState({ sessionId, recoveryInProgress, recoveryFailed }),
  );
  // Track whether the most recent ``connecting`` cycle started from the
  // ``failed`` state. We only emit ``toast.success("Reconnected")`` on
  // the ``failed → connecting → live`` arc — not on the initial cold
  // start (no value; the user expects an app to start).
  const wasFailedRef = useRef<boolean>(false);

  // Stuck-detection: 10s after entering ``connecting``, flip the store
  // to ``failed`` so the badge surfaces the Reload CTA. The timeout id
  // lives in a ref so we can cancel it if the state moves away from
  // ``connecting`` before it fires.
  const stuckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const next = deriveRecoveryState({ sessionId, recoveryInProgress, recoveryFailed });
    const prev = prevStateRef.current;
    if (next === prev) return;

    // Logger fires on every transition, including transitions the toast
    // policy ignores. Easier to debug "badge says X, why" with a
    // complete trail than a sampled one.
    try {
      recoveryLogger({ from: prev, to: next, at: Date.now() });
    } catch (err) {
      // Logger is fire-and-forget; a thrown logger must not break the
      // recovery state machine.
      console.warn('[session-recovery] logger threw', err);
    }

    // Toast policy. Only the explicit recovery arcs surface a toast; the
    // cold-start path (idle → connecting → live) is silent.
    if (next === 'connecting') {
      // Remember whether we just came from failed; gates the
      // "Reconnected" success toast on the next live transition.
      // (failed → connecting only happens via __resetRecoveryAttempts
      // or a manual store action; the production flow into connecting
      // from failed is rare but supported.)
      wasFailedRef.current = prev === 'failed';
    } else if (next === 'live') {
      if (wasFailedRef.current || prev === 'failed') {
        toast.success('Reconnected');
      }
      wasFailedRef.current = false;
    } else if (next === 'failed') {
      toast.error('Cannot reach substrate', {
        description:
          'The session-create call has been retrying for more than 10 seconds. Reload the tab to start fresh.',
        action: {
          label: 'Reload',
          onClick: () => hardReset(),
        },
      });
      wasFailedRef.current = false;
    }

    prevStateRef.current = next;
    // ``hardReset`` is a store-derived ref; it's stable across renders
    // (Zustand snapshots are referentially stable for actions). Toast
    // helper has no dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, recoveryInProgress, recoveryFailed]);

  // Stuck timer. Mounted whenever the surface state is ``connecting``;
  // cleared on any other state. The store's ``markRecoveryFailed`` is
  // idempotent against late firings (it short-circuits if sessionId
  // arrived first) so a benign race with a successful create isn't a
  // problem.
  useEffect(() => {
    const surface = deriveRecoveryState({ sessionId, recoveryInProgress, recoveryFailed });
    if (surface !== 'connecting') {
      if (stuckTimerRef.current !== null) {
        clearTimeout(stuckTimerRef.current);
        stuckTimerRef.current = null;
      }
      return;
    }
    if (stuckTimerRef.current !== null) {
      // Already armed; let it run to completion (the timer measures from
      // the first connecting entry, not the latest re-render). The
      // session store also preserves ``recoveryStuckSince`` across
      // re-entrant ``resetSession`` calls so the wall-clock is consistent
      // with this timer.
      return;
    }
    stuckTimerRef.current = setTimeout(() => {
      stuckTimerRef.current = null;
      markRecoveryFailed();
    }, RECOVERY_STUCK_TIMEOUT_MS);
    return () => {
      if (stuckTimerRef.current !== null) {
        clearTimeout(stuckTimerRef.current);
        stuckTimerRef.current = null;
      }
    };
    // ``markRecoveryFailed`` is a store-derived action; stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, recoveryInProgress, recoveryFailed]);

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
