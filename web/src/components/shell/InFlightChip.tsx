/**
 * InFlightChip (v3.1 Phase 3, Unit 11).
 *
 * A TopBar control summarising ACTIVE jobs (``pending`` / ``running``) from
 * ``useJobsStore``. The compact glance-able counterpart to the Activity
 * panel:
 *
 * - 0 active → hidden (renders nothing).
 * - 1 active → kind-aware label, e.g. "Running PF…".
 * - 2 active → "Running 2 jobs" (collapsed; the threshold is "more than one").
 * - ≥3 active → "Running N jobs" with a hover tooltip listing each job.
 *
 * Clicking the chip opens the Activity panel: it points the BottomDrawer at
 * the Activity tab, expands the drawer if collapsed, and selects the
 * "Active" sub-tab.
 *
 * The chip generalises nothing existing — it's the in-flight summary the
 * plan calls for — but mirrors the TopBar icon-button + tooltip pattern
 * (``BottomDrawerToggle`` / ``Tooltip``).
 */
import { useMemo } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';
import { useJobsStore, isTerminalStatus } from '@/store/jobs';
import { useLayoutStore } from '@/store/layout';
import { kindLabel, shortKindLabel } from '@/components/shell/jobLabels';

export function InFlightChip() {
  const jobs = useJobsStore((s) => s.jobs);
  const setActiveBottomDrawerTab = useLayoutStore((s) => s.setActiveBottomDrawerTab);
  const setBottomDrawerCollapsed = useLayoutStore((s) => s.setBottomDrawerCollapsed);
  const setActivityPanelTab = useLayoutStore((s) => s.setActivityPanelTab);
  const clearDrawerUnread = useLayoutStore((s) => s.clearDrawerUnread);

  // Memoize the filter+sort: this control is always mounted in the TopBar and
  // ``jobs`` gets a fresh reference on every JobStream event (incl. terminal
  // churn that doesn't touch the in-flight set). Without the memo a burst of
  // WS events re-allocates+re-sorts the full job array on each one.
  const active = useMemo(
    () =>
      Object.values(jobs)
        .filter((j) => !isTerminalStatus(j.status))
        .sort((a, b) => b.started_at - a.started_at),
    [jobs],
  );

  // 0 active → hidden.
  if (active.length === 0) return null;

  const count = active.length;
  const label =
    count === 1 ? `Running ${shortKindLabel(active[0]!.kind)}…` : `Running ${count} jobs`;

  const openActivity = () => {
    setActiveBottomDrawerTab('activity');
    setActivityPanelTab('active');
    setBottomDrawerCollapsed(false);
    clearDrawerUnread();
  };

  const chip = (
    <button
      type="button"
      onClick={openActivity}
      data-testid="in-flight-chip"
      data-count={count}
      aria-label={`${label}. Open Activity panel.`}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1',
        'border-primary/30 bg-primary/10 text-primary border text-xs font-medium',
        'hover:bg-primary/15',
        'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        'transition-colors duration-[var(--duration-fast)]',
      )}
    >
      <span
        aria-hidden="true"
        className="bg-primary inline-block h-1.5 w-1.5 animate-pulse rounded-full"
      />
      <span data-testid="in-flight-chip-label">{label}</span>
    </button>
  );

  // ≥3 active → hover tooltip listing each job. For 1-2 we keep the bare
  // chip (the label already names the single job; two is small enough to
  // read in the panel a click away).
  if (count < 3) return chip;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        <TooltipPortal>
          <TooltipContent data-testid="in-flight-chip-tooltip" side="bottom">
            <ul className="flex flex-col gap-0.5">
              {active.map((job) => (
                <li key={job.id} data-testid={`in-flight-chip-tooltip-item-${job.id}`}>
                  {kindLabel(job.kind)}
                  {job.status === 'running' ? '' : ` (${job.status})`}
                </li>
              ))}
            </ul>
          </TooltipContent>
        </TooltipPortal>
      </Tooltip>
    </TooltipProvider>
  );
}
