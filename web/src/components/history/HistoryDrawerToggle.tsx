import { Button } from '@/components/ui/button';
import { useHistoryStore } from '@/store/history';
import { useRunsStore } from '@/store/runs';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';

/**
 * Trigger for the run-history drawer, mounted in the TopBar. It is a module of
 * its own so the TopBar can render it without loading ``HistoryDrawer``, which
 * is fetched the first time the drawer opens.
 */
export function HistoryDrawerToggle({ className }: { className?: string }) {
  const open = useHistoryStore((s) => s.drawerOpen);
  const openDrawer = useHistoryStore((s) => s.openDrawer);
  const closeDrawer = useHistoryStore((s) => s.closeDrawer);
  const runCount = useRunsStore((s) => Object.keys(s.runs).length);
  // Gate on session+case loaded — consistent with the other TopBar
  // controls (BundleExport, Report, Snapshot). Runs to list open it too:
  // the finished runs are kept across a reload of the page, so they can be
  // there before any case is opened.
  const sessionId = useSessionStore((s) => s.sessionId);
  const caseSelection = useCaseStore((s) => s.selection);
  const enabled = (sessionId !== null && caseSelection !== null) || runCount > 0;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={!enabled}
      onClick={() => (open ? closeDrawer() : openDrawer())}
      data-testid="history-drawer-toggle"
      className={className}
      aria-pressed={open}
      aria-label="Toggle run history"
      title={
        enabled
          ? 'Run history: rename, pin or drop your runs'
          : 'No runs yet. Load a case and run a TDS to fill the history.'
      }
    >
      History{' '}
      {runCount > 0 ? (
        <span className="text-muted-foreground ml-1 text-[10px]">({runCount})</span>
      ) : null}
    </Button>
  );
}
