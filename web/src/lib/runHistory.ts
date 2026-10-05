/**
 * The ways into the run history that are not the top bar's History button.
 *
 * That button is in the More menu on all but the widest windows, so the runs
 * kept across a reload had nothing on screen that led to them, and the one
 * list that did say "History" (the Activity tab's log of this page load's
 * jobs) was empty after a reload. The Run menu, the plot, the Activity tab and
 * the page shown before a case is opened now each have a control that opens
 * the run history; what they share is here.
 */
import { useCaseStore } from '@/store/case';
import { useHistoryStore } from '@/store/history';
import { useLayoutStore } from '@/store/layout';
import { useRunsStore } from '@/store/runs';
import { useSessionStore } from '@/store/session';

/**
 * Open the run history on its list of runs.
 *
 * The History drawer remembers what it was last set to show, and that can be
 * the job list of this page load, which is empty after a reload. A control
 * that says "Run history" promises the runs, so it sets the drawer to them
 * before it opens it. The top bar's History button toggles the drawer as it
 * was left.
 */
export function openRunHistory(): void {
  useLayoutStore.getState().setHistoryKindFilter('runs');
  useHistoryStore.getState().openDrawer();
}

/** "Run history", with the number of runs it lists once there are some. */
export function runHistoryLabel(runCount: number): string {
  return runCount > 0 ? `Run history (${runCount})` : 'Run history';
}

/** What the run history is for, as the hover text of a control that opens it. */
export const RUN_HISTORY_HINT =
  'The time-domain runs kept in this browser, also after the page is reloaded. Pin a run there to plot it, pin several to compare them, or rename and delete them.';

/** Why the run history cannot be opened yet, shown under a menu item that is off. */
export const NO_RUNS_YET = 'No runs yet. Load a case and run a time-domain simulation first.';

/**
 * How many runs the history lists, and whether it can be opened: once a case
 * is loaded, or before one is when there are runs to list (the finished runs
 * are kept across a reload of the page, so they can be there first).
 */
export function useRunHistory(): { runCount: number; available: boolean } {
  const runCount = useRunsStore((s) => Object.keys(s.runs).length);
  const sessionId = useSessionStore((s) => s.sessionId);
  const caseSelection = useCaseStore((s) => s.selection);
  return {
    runCount,
    available: (sessionId !== null && caseSelection !== null) || runCount > 0,
  };
}
