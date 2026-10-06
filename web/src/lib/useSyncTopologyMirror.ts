/**
 * Mirror the topology query into the case store on every change. The store
 * holds a synchronous `topology` mirror that non-query consumers read (the
 * dynamic-content badge + the run-readiness dynamic gate, Unit 24). The plain
 * topology query is often served from the TanStack cache (seeded by the load
 * mutation), so its `queryFn` doesn't re-run to set the mirror: this effect
 * keeps the mirror faithful to `useCurrentTopology()` whether the data came
 * from a fetch or the cache. Mounted once at the app root.
 *
 * The mirror is also filled again when it is found empty while the query has
 * the case. `setCase` empties it, and what opens a case calls `setCase` once
 * the load has answered, after the load itself filled the mirror. Whether this
 * effect had already run by then depended on how the caller waited for the
 * load: the saved-cases list and the palette (`useOpenCase`) wait on a promise,
 * which resolved after it, and the mirror stayed empty, the case's badge on
 * "Loading..." and its own events off the Disturbances list.
 *
 * While the topology is being read again the query still holds the case as it
 * was (after a bundle import, the case the bundle replaced), so nothing is
 * mirrored until the read is back.
 */
import { useEffect } from 'react';
import { useCurrentTopology, useTopologyRefetching } from '@/api/queries';
import { useCaseStore } from '@/store/case';

export function useSyncTopologyMirror(): void {
  const topology = useCurrentTopology();
  const refetching = useTopologyRefetching();
  const setTopology = useCaseStore((s) => s.setTopology);
  const mirrorEmpty = useCaseStore((s) => s.selection !== null && s.topology === null);
  useEffect(() => {
    if (topology === null || refetching) return;
    if (useCaseStore.getState().topology !== topology) setTopology(topology);
  }, [topology, refetching, mirrorEmpty, setTopology]);
}
