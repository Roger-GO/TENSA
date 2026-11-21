/**
 * Mirrors the engines query into the session store.
 *
 * Mounted once from `App.tsx`, like `useSessionRecovery`. It is the only
 * place the engines query is started for the readiness gate: the gate reads
 * the list from the store (`engines`), so a reader that is not a hook
 * (`runReadinessNow`) and a component without a QueryClientProvider see the
 * same answer.
 */
import { useEffect } from 'react';
import { useEngines } from '@/api/queries';
import { useSessionStore } from '@/store/session';

export function useEnginesSync(): void {
  const { data } = useEngines();
  const setEngines = useSessionStore((s) => s.setEngines);
  useEffect(() => {
    if (data !== undefined) setEngines(data);
  }, [data, setEngines]);
}
