/**
 * The limit violations of the open case's last power flow, as the Violations
 * table, its count in the drawer and the run toast list them (`violations.ts`
 * does the judging). `null` until a power flow has converged on the open case.
 *
 * The power flow is the last one that was solved (`lastSolved`), not whatever
 * the pflow slice holds as its latest result: after a time-domain run that is
 * the operating point the run ended at, which has no line flows and no
 * generator outputs, and judging it would report every line and generator as
 * within its limits.
 */
import { useMemo } from 'react';
import { useCurrentTopology } from '@/api/queries';
import { usePflowStore } from '@/store/pflow';
import { collectViolations, type ViolationReport } from '@/lib/violations';

export function useViolationReport(): ViolationReport | null {
  const topology = useCurrentTopology();
  const pflow = usePflowStore((s) => s.lastSolved);
  return useMemo(() => collectViolations(pflow, topology), [pflow, topology]);
}

/**
 * Whether a time-domain run has gone on from the power flow the report judges
 * (or from one this tab never saw): what the open case holds now is the end of
 * that run, which the report does not check.
 */
export function useRunFollowedPflow(): boolean {
  return usePflowStore((s) => s.lastRun !== null && s.lastRun !== s.lastSolved);
}
