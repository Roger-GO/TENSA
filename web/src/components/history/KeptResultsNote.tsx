import { Button } from '@/components/ui/button';
import { openPflowComparePanel } from '@/lib/openPflowPanel';
import { openRunHistory } from '@/lib/runHistory';
import { usePflowHistoryStore } from '@/store/pflowHistory';
import { useRunsStore } from '@/store/runs';

function counted(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

/**
 * Says what the browser kept, on the page shown before a case is opened.
 *
 * A reload starts with no case, an empty plot and an empty job list, and the
 * runs and power flows the browser kept (``store/resultsPersistence.ts``) were
 * behind controls that said nothing of them, so the page read as if the reload
 * had lost them. This names them where the eye lands and opens them. It draws
 * nothing when nothing is kept.
 */
export function KeptResultsNote() {
  const runCount = useRunsStore((s) => Object.keys(s.runs).length);
  const pflowCount = usePflowHistoryStore((s) => s.snapshots.length);
  if (runCount === 0 && pflowCount === 0) return null;
  const kept = [
    ...(runCount > 0 ? [counted(runCount, 'time-domain run', 'time-domain runs')] : []),
    ...(pflowCount > 0 ? [counted(pflowCount, 'power flow', 'power flows')] : []),
  ].join(' and ');
  return (
    <div
      data-testid="kept-results-note"
      className="border-border bg-muted/30 mt-1 flex max-w-sm flex-col items-center gap-2 rounded border px-3 py-2.5"
    >
      <p className="text-foreground text-[13px] leading-relaxed">
        Kept in this browser: {kept}. A reload does not lose them, and they open without a case.
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {runCount > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={openRunHistory}
            data-testid="kept-results-open-history"
          >
            Open run history
          </Button>
        ) : null}
        {pflowCount > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={openPflowComparePanel}
            data-testid="kept-results-open-compare"
          >
            Open the Compare tab
          </Button>
        ) : null}
      </div>
    </div>
  );
}
