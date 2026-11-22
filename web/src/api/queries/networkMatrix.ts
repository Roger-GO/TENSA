/**
 * ``GET /api/sessions/{id}/network-matrix?kind=``: one network matrix of the
 * loaded case of a Sienna session (the PTDF, the LODF, the bus admittance
 * matrix or the incidence matrix), built by PowerNetworkMatrices.
 */
import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { andesClient, TIMEOUTS } from '@/api/client';
import type { components } from '@/api/generated';
import { useSessionStore } from '@/store/session';

/** The matrices the route builds. */
export type NetworkMatrixKind = 'ptdf' | 'lodf' | 'ybus' | 'incidence';

/** What the route answers: one network matrix of the loaded case. */
export type NetworkMatrixResponse = components['schemas']['NetworkMatrixResponse'];

/**
 * The matrix of `kind` of the session's case. A matrix is of the committed
 * case, so it does not go stale while the case stands; `gcTime: 0` keeps four
 * kinds of a few hundred buses from piling in the cache once the dialog
 * closes.
 */
export function useNetworkMatrix(
  kind: NetworkMatrixKind,
  enabled: boolean,
): UseQueryResult<NetworkMatrixResponse, Error> {
  const sessionId = useSessionStore((s) => s.sessionId);
  return useQuery({
    queryKey: ['network-matrix', sessionId, kind],
    enabled: enabled && sessionId !== null,
    queryFn: async () => {
      if (sessionId === null) {
        throw new Error('useNetworkMatrix fetched without a session');
      }
      return await andesClient.get<NetworkMatrixResponse>(
        `/sessions/${encodeURIComponent(sessionId)}/network-matrix?kind=${kind}`,
        { timeoutMs: TIMEOUTS.workspace },
      );
    },
    staleTime: Infinity,
    gcTime: 0,
  });
}
