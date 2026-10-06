/** What the server says about itself and the models it takes, which needs no session. */
import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { andesClient, TIMEOUTS } from '@/api/client';
import type { TopologySchema, VersionInfo } from '@/api/types';
import { queryKeys } from './keys';

/**
 * `GET /topology/schema`. Per-model parameter metadata. Driven by the
 * server-side `_PARAMS_BY_MODEL` table; rarely changes — long stale time.
 */
export function useTopologySchema(): UseQueryResult<TopologySchema, Error> {
  return useQuery({
    queryKey: queryKeys.topologySchema,
    staleTime: 24 * 60 * 60 * 1000,
    queryFn: async () => {
      return await andesClient.get<TopologySchema>('/topology/schema', {
        timeoutMs: TIMEOUTS.workspace,
      });
    },
  });
}

/**
 * `GET /version`. The tensa and ANDES versions the server runs. They cannot
 * change while it runs, so this is fetched once per page.
 */
export function useVersionInfo(): UseQueryResult<VersionInfo, Error> {
  return useQuery({
    queryKey: queryKeys.version,
    staleTime: Infinity,
    queryFn: async () => {
      return await andesClient.get<VersionInfo>('/version', {
        timeoutMs: TIMEOUTS.sessionLifecycle,
      });
    },
  });
}
