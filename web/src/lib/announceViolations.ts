/**
 * Tell the user, right after a power flow, that it broke a limit, with a
 * button to the list. A converged run that breaks none says nothing (the
 * "PF converged" toast is enough), and so does a warning on its own: a bus
 * near a limit, a line near its rating or a generator on a Q limit shows in
 * the Violations tab's count and on the diagram, and is not worth interrupting
 * for. Every power flow the UI starts goes through `useRunPflow`, which calls
 * this, so the notice does not depend on which button ran it.
 */
import type { PflowResult, TopologySummary } from '@/api/types';
import { toast } from '@/lib/toast';
import { collectViolations, summarizeViolations } from '@/lib/violations';
import { useLayoutStore } from '@/store/layout';

/** Open the bottom drawer on the Violations tab, leaving the full-space results view if it is up. */
export function showViolations(): void {
  const layout = useLayoutStore.getState();
  layout.setResultsViewActive(false);
  layout.setActiveBottomDrawerTab('violations');
  layout.setBottomDrawerCollapsed(false);
}

export function announceViolations(
  result: PflowResult,
  topology: TopologySummary | undefined,
): void {
  if (topology === undefined) return;
  const report = collectViolations(result, topology);
  if (report === null || report.violationCount === 0) return;
  toast.warning(`${summarizeViolations(report)} after the power flow.`, {
    description: 'Voltage, loading and reactive power limits are listed in the Violations tab.',
    action: { label: 'Show violations', onClick: showViolations },
  });
}
