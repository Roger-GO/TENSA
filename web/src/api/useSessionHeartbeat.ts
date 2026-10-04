/**
 * Keeps the active session from being reaped while this tab is open.
 *
 * The substrate closes a session that has seen no request for its idle timeout
 * (three minutes by default). A user who stops to think, or steps away with a case
 * half built, sends none, and came back to a session without that case. Polling
 * ``GET /sessions/{id}`` counts as activity on the substrate, so this hook does it
 * every ``SESSION_HEARTBEAT_INTERVAL_MS`` while a session exists.
 *
 * The poll is an ordinary TanStack query rather than a bare ``fetch`` so its
 * failures go through the global recovery handler: a 404 means the substrate has
 * lost the session (an idle reap after the tab slept, a server restart), and the
 * recovery cycle in ``useSessionRecovery`` starts at once instead of on the user's
 * next click. ``refetchOnWindowFocus`` makes a tab that was frozen in the
 * background check straight away when it comes back.
 *
 * Mounted once from ``App.tsx``, beside ``useSessionRecovery``.
 */
import { useQuery } from '@tanstack/react-query';
import { andesClient, TIMEOUTS } from './client';
import { queryKeys } from './queries';
import type { SessionDescriptor } from './types';
import { useSessionStore } from '@/store/session';

/**
 * How often the tab checks in. Well under the idle timeout's 180 s default, and
 * under its documented floor of 60 s even when a browser slows a background tab's
 * timers to one tick a minute.
 */
export const SESSION_HEARTBEAT_INTERVAL_MS = 30_000;

export function useSessionHeartbeat(): void {
  const sessionId = useSessionStore((s) => s.sessionId);
  useQuery({
    queryKey: sessionId === null ? ['session-heartbeat'] : queryKeys.sessionHeartbeat(sessionId),
    enabled: sessionId !== null,
    queryFn: async () => {
      // ``enabled`` keeps this from running without an id.
      return await andesClient.get<SessionDescriptor>(
        `/sessions/${encodeURIComponent(sessionId ?? '')}`,
        { timeoutMs: TIMEOUTS.sessionLifecycle },
      );
    },
    refetchInterval: SESSION_HEARTBEAT_INTERVAL_MS,
    // Background tabs are the ones that need it most.
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    // Always due, so a focus event checks in rather than waiting out a stale time.
    staleTime: 0,
    // A heartbeat that fails is not worth retrying: the next one is 30 s away, and
    // a 404 must reach the recovery handler on the first failure.
    retry: false,
  });
}
