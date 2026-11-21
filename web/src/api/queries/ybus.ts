/**
 * The bus admittance matrix of the loaded case: ``GET /sessions/{id}/ybus``.
 */
import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { andesClient, TIMEOUTS } from '@/api/client';
import type { components } from '@/api/generated';
import { useSessionStore } from '@/store/session';
import { queryKeys } from './keys';

/** The bus admittance matrix of the loaded case, as sparse triplets. */
export type YbusResponse = components['schemas']['YbusResponse'];

/**
 * ``GET /api/sessions/{id}/ybus``: the bus admittance matrix ANDES builds
 * from the case's lines, transformers and shunts, in per unit on the system
 * base, as sparse triplets.
 *
 * **Manual trigger only.** Gating: ``enabled: false`` so the query never
 * auto-fires; the dialog calls ``query.refetch()`` from its "Read matrix"
 * button. Nothing is asked of the server until the user asks, because the
 * read has a side effect the dialog states first: ANDES builds the matrix
 * only on a System that is set up, so the wrapper sets it up first when it
 * is not, as the connectivity check does; after that no disturbance can be
 * added until the case is reloaded. No power flow is needed.
 *
 * No write-through to any store: the dialog consumes ``data`` directly.
 *
 * Errors:
 *
 * - 404: session not found or already closed.
 * - 409: no case has been loaded into this session yet.
 * - 422: ANDES setup() failed before the matrix could be built (recovery
 *   reload-case: ``POST /api/sessions/{id}/reload``), or the matrix has more
 *   than MAX_YBUS_ENTRIES nonzero entries, the most one answer carries.
 */
export function useYbus(): UseQueryResult<YbusResponse, Error> {
  const sessionId = useSessionStore((s) => s.sessionId);
  return useQuery({
    queryKey: sessionId ? queryKeys.ybus(sessionId) : ['ybus', 'noop'],
    enabled: false,
    queryFn: async () => {
      if (!sessionId) {
        throw new Error('useYbus refetched without a session');
      }
      return await andesClient.get<YbusResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/ybus`,
        { timeoutMs: TIMEOUTS.workspace },
      );
    },
  });
}

/**
 * Forget the matrix that was read, in every session: the dialog calls it when
 * it closes, so the next time it opens it says what the read does again and
 * reads the case as it is then (another case, or the same one edited), not a
 * copy of an earlier one. A reset query has no observer that fetches on its
 * own (``enabled: false``), so nothing is sent.
 */
export function useForgetYbus(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.resetQueries({ queryKey: ['ybus'] });
  }, [queryClient]);
}
