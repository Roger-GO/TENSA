/**
 * The limit violations of the open case's last power flow, as the Violations
 * table, its count in the drawer and the run toast list them (`violations.ts`
 * does the judging). `null` until a power flow has converged on the open case.
 */
import { useMemo } from 'react';
import { useCurrentTopology } from '@/api/queries';
import { usePflowStore } from '@/store/pflow';
import { collectViolations, type ViolationReport } from '@/lib/violations';

export function useViolationReport(): ViolationReport | null {
  const topology = useCurrentTopology();
  const pflow = usePflowStore((s) => s.lastRun);
  return useMemo(() => collectViolations(pflow, topology), [pflow, topology]);
}
