/**
 * The ``QueryClient`` the app runs on and the global recovery from a session the
 * substrate has forgotten.
 */
import { QueryClient } from '@tanstack/react-query';
import { ProblemDetailsError } from '@/api/client';
import { useSessionStore } from '@/store/session';
import { toast } from '@/lib/toast';

/**
 * Construct a QueryClient with the project's defaults. Exported so tests
 * can mint their own client without the global recovery wiring if they
 * want to isolate a single hook.
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          // Don't retry auth / client errors. Retry network blips once.
          if (error instanceof ProblemDetailsError) return false;
          return failureCount < 1;
        },
      },
      mutations: {
        retry: false,
      },
    },
  });
}

/**
 * Regex matching session-scoped API paths. A 404 on any of these is
 * interpreted as "the substrate doesn't know our session id any more"
 * (typical after a substrate restart, idle-timeout, or a blip that
 * reaped the worker process) and triggers the auto-recovery path. The
 * pattern intentionally allows the trailing segment to be missing so a
 * 404 on ``/api/sessions/{id}`` itself (a session-describe call) also
 * recovers.
 *
 * Non-session 404s (``/api/workspace/file/missing.raw``,
 * ``/api/topology/schema``, etc.) skip recovery and surface their error
 * normally — those are real "the resource doesn't exist" 404s, not
 * stale-session 404s.
 */
const SESSION_SCOPED_PATH_RE = /\/api\/sessions\/[^/]+(?:\/.*)?$/;

/**
 * Per-second debounce on session-recovery firings. A burst of 404s from
 * concurrent queries (e.g., topology + sidecar both fire and both 404 on a
 * stale session) should trigger only one recovery — the rest piggyback on
 * the same recovery flag and refetch against the new session id once it
 * lands. The timestamp lives at module scope (not inside the QueryClient)
 * so multiple QueryClient instances in tests don't bypass the debounce.
 */
const RECOVERY_DEBOUNCE_MS = 1000;
let lastRecoveryAttemptTs = 0;

/** Test-only helper: reset the debounce timestamp between cases. */
export function __resetRecoveryDebounceForTests(): void {
  lastRecoveryAttemptTs = 0;
}

function isSessionScopedPath(path: string | undefined): boolean {
  if (!path) return false;
  return SESSION_SCOPED_PATH_RE.test(path);
}

/**
 * Pure handler invoked by both cache subscribers (and exported for unit
 * tests). Inspects an unknown error; if it's a recognized
 * ``ProblemDetailsError`` shape, mutates the session store as
 * ``wireGlobalErrorRecovery`` describes. Returns the action it took (or
 * ``'noop'``) for test assertions.
 */
export function handleGlobalRecoveryError(err: unknown): 'session-recovery' | 'noop' {
  if (!(err instanceof ProblemDetailsError)) return 'noop';

  if (err.status === 404 && isSessionScopedPath(err.requestPath)) {
    const now = Date.now();
    // Debounce: skip if we already fired a recovery within the past
    // second. The first 404 in a burst raises ``recoveryInProgress``;
    // subsequent ones are no-ops because the flag is already up.
    if (now - lastRecoveryAttemptTs < RECOVERY_DEBOUNCE_MS) return 'noop';
    const sessionState = useSessionStore.getState();
    // Don't fire recovery if we never had a session id and recovery is
    // already in flight (no point double-firing).
    if (sessionState.sessionId === null && sessionState.recoveryInProgress) return 'noop';
    // Don't loop: once recovery has failed (>3 attempts in 30s), stay
    // pinned in the failed state until tab reload.
    if (sessionState.recoveryFailed) return 'noop';
    lastRecoveryAttemptTs = now;
    sessionState.resetSession();
    // v0.2 polish Unit 1: surface the recovery transition as a toast so
    // the user sees what's happening when their click silently 404s and
    // we auto-recover behind the scenes. Includes a Reload action because
    // the underlying state may not survive the recovery (e.g., a TDS run
    // mid-stream loses its frames; reload gets the user a clean slate).
    // The RecoveryBadge already shows the "Reconnecting..." pill — the
    // toast complements it by being more prominent than a corner badge
    // for an event the user didn't initiate.
    toast.error('Session expired — reconnecting', {
      description: 'The substrate forgot our session. Reconnecting now.',
      action: {
        label: 'Reload',
        onClick: () => {
          window.location.reload();
        },
      },
    });
    return 'session-recovery';
  }

  return 'noop';
}

/**
 * Wire global error recovery on the QueryClient's caches. One path is
 * handled here:
 *
 * **404 on ``/api/sessions/{id}/...``** — the substrate has forgotten
 *    our session (worker restart, idle-timeout). Fire
 *    ``useSessionStore.resetSession()`` which clears the id AND raises
 *    the ``recoveryInProgress`` flag. ``useEnsureSession`` (in
 *    ``WorkspaceFilePicker``) watches the flag, calls ``mutation.reset()``
 *    locally, and the gate re-fires ``useCreateSession.mutate()`` against
 *    the new session id. Topology + sidecar queries are gated on
 *    ``sessionId !== null`` so they auto-pause during the recovery window
 *    and resume against the new id once it lands. Per-second debounced so
 *    a burst of 404s only fires recovery once.
 *
 * **Forward-compat caveat (security):** v0.1.y's recovery is safe under
 * the current "no session-revocation policy" trust model. A future SaaS
 * phase that adds server-side session revocation must inspect a
 * revocation-reason header before auto-recreating; otherwise auto-recovery
 * would defeat revocation. Not a blocker for the current local-trusted-user
 * model — see Risks in the v0.1.y plan.
 *
 * Called once from `App.tsx` after `makeQueryClient`. Tests can opt out
 * by skipping the call.
 */
export function wireGlobalErrorRecovery(client: QueryClient): void {
  client.getQueryCache().subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'error') {
      handleGlobalRecoveryError(event.action.error);
    }
  });
  client.getMutationCache().subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'error') {
      handleGlobalRecoveryError(event.action.error);
    }
  });
}
