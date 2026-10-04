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
export function HistoryDrawerToggle() {
  const open = useHistoryStore((s) => s.drawerOpen);
  const openDrawer = useHistoryStore((s) => s.openDrawer);
  const closeDrawer = useHistoryStore((s) => s.closeDrawer);
  const runCount = useRunsStore((s) => Object.keys(s.runs).length);
  // Gate on session+case loaded — consistent with the other TopBar
  // controls (BundleExport, Report, Snapshot). The History drawer's
  // run list is session-scoped (the runs slice clears on session
  // change), so an unloaded session would always show empty.
  const sessionId = useSessionStore((s) => s.sessionId);
  const caseSelection = useCaseStore((s) => s.selection);
  const enabled = sessionId !== null && caseSelection !== null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={!enabled}
      onClick={() => (open ? closeDrawer() : openDrawer())}
      data-testid="history-drawer-toggle"
      aria-pressed={open}
      aria-label="Toggle run history"
      title={
        enabled
          ? 'Run history: rename, pin or drop your runs'
          : 'Load a case to see the runs of its session'
      }
    >
      History{' '}
      {runCount > 0 ? (
        <span className="text-muted-foreground ml-1 text-[10px]">({runCount})</span>
      ) : null}
    </Button>
  );
}
