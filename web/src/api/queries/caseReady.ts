/**
 * Whether the queries that read a case may run. Shared by the topology, snapshot, PMU
 * and profile hooks; internal, so ``index.ts`` does not re-export it.
 */
import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';

/**
 * True when a case is loaded AND the session is not mid-recovery. The queries that
 * read a case (topology, snapshots, PMUs, profiles) gate on this, not on the
 * selection alone: during a recovery the replacement session has no case yet, and
 * a query that reaches it first holds the session while the recovery's own load or
 * replay is refused with a 409 "session is busy". They are enabled again, and fetch
 * against the restored session, when the recovery ends.
 */
export function useCaseReady(): boolean {
  const hasCase = useCaseStore((s) => s.selection !== null);
  const recovering = useSessionStore((s) => s.recoveryInProgress);
  return hasCase && !recovering;
}
