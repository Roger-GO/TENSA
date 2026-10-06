/** Reads of the loaded case's topology, and the parameter names an ``Alter`` may take. */
import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { andesClient, TIMEOUTS } from '@/api/client';
import type { AlterableParamsResponse, SessionId, TopologySummary } from '@/api/types';
import { useSessionStore } from '@/store/session';
import { queryKeys } from './keys';
import { useCaseReady } from './caseReady';

/**
 * `GET /sessions/{id}/topology`. Disabled when `sessionId` is null; the
 * caller is responsible for guarding render until the session exists.
 */
export function useTopology(sessionId: SessionId | null): UseQueryResult<TopologySummary, Error> {
  // Gate on a LOADED CASE too: a fresh session with no case loaded has no
  // topology to fetch, so the auto-fetch 409s (red console noise on the
  // landing page). The load mutation ``setQueryData``s the topology directly
  // (see ``useLoadCase``), so the SLD still primes instantly on load without
  // relying on this auto-fetch.
  const hasCase = useCaseReady();
  return useQuery({
    queryKey: sessionId ? queryKeys.topology(sessionId) : ['topology', 'noop'],
    enabled: sessionId !== null && hasCase,
    queryFn: async () => {
      if (!sessionId) throw new Error('topology query enabled without a session id');
      return await andesClient.get<TopologySummary>(
        `/sessions/${encodeURIComponent(sessionId)}/topology`,
        { timeoutMs: TIMEOUTS.topology },
      );
    },
  });
}

/**
 * Convenience: subscribe to the current session's topology directly from
 * any component. Reads `sessionId` from the session store and forwards
 * to `useTopology`. Returns `null` when no session is active or the
 * query hasn't resolved yet — components should branch on `null` and
 * render their loading/empty state.
 *
 * The Zustand `case.topology` slot is intentionally NOT populated by
 * the load mutation; the TanStack Query cache is the canonical source
 * of truth so cache invalidation (PF run, reload) flows naturally.
 */
export function useCurrentTopology(): TopologySummary | null {
  const sessionId = useSessionStore((s) => s.sessionId);
  return useTopology(sessionId).data ?? null;
}

/**
 * Whether the current session's topology is being read again. Until the read
 * is back, `useCurrentTopology` returns the case as it was before whatever
 * asked for it: after an add, the case without the element just added. For a
 * component that would otherwise act on what the case no longer says.
 */
export function useTopologyRefetching(): boolean {
  const sessionId = useSessionStore((s) => s.sessionId);
  const queryKey = sessionId ? queryKeys.topology(sessionId) : ['topology', 'noop'];
  return useIsFetching({ queryKey }) > 0;
}

/**
 * Returns a function that marks a session's topology stale so it is read
 * again. For a routine that commits `setup()` on the substrate but returns no
 * topology (a streamed TDS run), which would otherwise leave the cached
 * `state`, and the case-store mirror of it, saying `pre-setup`.
 */
export function useRefreshTopology(): (sessionId: SessionId) => void {
  const queryClient = useQueryClient();
  return (sessionId) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.topology(sessionId) });
  };
}

/**
 * `GET /sessions/{id}/topology/models/{model}/alterable_params`. Returns
 * the ordered list of parameter names that ANDES will accept as ``src``
 * for the ``Alter`` disturbance on the given model.
 *
 * The hook is gated on a session id AND a non-empty model name; the
 * Unit 6 ``AlterSpecForm`` only fires it after the user has picked a
 * model from the dropdown, so an unmounted-while-empty render path stays
 * disabled and doesn't 404 the substrate. Long stale time — the
 * alterable-params set is a function of the model class, not the case
 * data, so it's stable across the session.
 */
export function useAlterableParams(
  model: string | null,
): UseQueryResult<AlterableParamsResponse, Error> {
  const sessionId = useSessionStore((s) => s.sessionId);
  const enabled = sessionId !== null && model !== null && model.length > 0;
  return useQuery({
    queryKey: enabled ? queryKeys.alterableParams(sessionId, model) : ['alterable-params', 'noop'],
    enabled,
    // The list is purely a function of the ANDES model class; it doesn't
    // change while the session is alive. Cache it for the session lifetime.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      if (!sessionId || !model) {
        throw new Error('useAlterableParams enabled without session or model');
      }
      return await andesClient.get<AlterableParamsResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/topology/models/${encodeURIComponent(model)}/alterable_params`,
        { timeoutMs: TIMEOUTS.topology },
      );
    },
  });
}
