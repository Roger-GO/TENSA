import { RUN_HISTORY_HINT, openRunHistory, runHistoryLabel } from '@/lib/runHistory';
import { useRunsStore } from '@/store/runs';
import { cn } from '@/lib/cn';

/**
 * A button that opens the run history, for the places a first-time user looks
 * for an earlier run: beside the plot and in the Activity tab (see
 * ``lib/runHistory.ts``). It names how many runs there are to find.
 *
 * It is a module of its own, like ``HistoryDrawerToggle``, so that what shows
 * it does not load the drawer.
 */
export function RunHistoryButton({ testId, className }: { testId: string; className?: string }) {
  const runCount = useRunsStore((s) => Object.keys(s.runs).length);
  return (
    <button
      type="button"
      onClick={openRunHistory}
      data-testid={testId}
      title={RUN_HISTORY_HINT}
      className={cn(
        'border-border bg-background rounded border px-2 py-0.5 text-xs whitespace-nowrap',
        'hover:bg-muted transition-colors',
        'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        className,
      )}
    >
      {runHistoryLabel(runCount)}
    </button>
  );
}
