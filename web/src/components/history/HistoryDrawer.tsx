/**
 * HistoryDrawer (Unit 9 of the v2.0 plan, basic version).
 *
 * Slide-out panel anchored to the right edge of the viewport. Lists
 * every retained run from ``useRunsStore`` (most-recent first) with
 * the ``HistoryRunRow`` component. Per-row actions:
 *
 * - "Pin" / "Unpin" — toggles the run in/out of the multi-run overlay.
 * - "Reset" — drops the run from the runs slice.
 *
 * Sweep progress + bundle re-export-per-run are deferred to Unit 18
 * (the basic version only owns the run list + pin/unpin).
 *
 * Wiring:
 *
 * - Trigger: ``<HistoryDrawerToggle />`` (mounted in the TopBar). On
 *   click, opens the drawer via ``useHistoryStore.openDrawer()``.
 * - The drawer mounts conditionally on ``drawerOpen`` so it doesn't
 *   leak listeners when closed.
 *
 * Why a Dialog rather than a custom slide-out: the Radix Dialog gives
 * us focus trap, Esc-to-close, scroll lock, and accessible labelling
 * for free. We swap out the centered-modal positioning for a right-
 * docked sheet via ``widthClassName`` + custom positioning class.
 */
import { useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useHistoryStore } from '@/store/history';
import { useRunsStore } from '@/store/runs';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import type { RunRecord } from '@/store/runs';
import { HistoryRunRow } from './HistoryRunRow';
import { cn } from '@/lib/cn';

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
    >
      History {runCount > 0 ? <span className="text-muted-foreground ml-1 text-[10px]">({runCount})</span> : null}
    </Button>
  );
}

/**
 * Outer wrapper. Defers the inner drawer body until the user opens it,
 * matching the Unit 3 BundleExportDialog pattern. The deferred mount
 * keeps test renderings of TopBar (which don't necessarily mount a
 * QueryClientProvider) green even when this drawer ships.
 */
export function HistoryDrawer() {
  const open = useHistoryStore((s) => s.drawerOpen);
  const closeDrawer = useHistoryStore((s) => s.closeDrawer);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeDrawer();
      }}
    >
      {open ? <HistoryDrawerInner /> : null}
    </Dialog>
  );
}

function HistoryDrawerInner() {
  const runs = useRunsStore((s) => s.runs);
  const activeRunId = useRunsStore((s) => s.activeRunId);
  const overlayRunIds = useRunsStore((s) => s.overlayRunIds);
  const setOverlayRuns = useRunsStore((s) => s.setOverlayRuns);
  const toastMessage = useHistoryStore((s) => s.toastMessage);
  const setToast = useHistoryStore((s) => s.setToast);

  // Most-recent first: reverse insertion order. Insertion is
  // chronological; the user's mental model is "the latest run is at
  // the top".
  const orderedRuns = useMemo<readonly RunRecord[]>(() => {
    const ids = Object.keys(runs);
    const out: RunRecord[] = [];
    for (let i = ids.length - 1; i >= 0; i -= 1) {
      const r = runs[ids[i]!];
      if (r) out.push(r);
    }
    return out;
  }, [runs]);

  const handleClearOverlay = () => {
    setOverlayRuns([]);
    setToast('Overlay cleared');
  };

  const overlayCount = overlayRunIds.size;

  return (
    <DialogContent
      data-testid="history-drawer"
      // Override the centered-modal positioning with a right-docked sheet.
      // ``!`` prefix forces priority over the base classes inside DialogContent.
      widthClassName="!w-96 !max-w-md"
      className={cn(
        '!fixed !top-0 !right-0 !bottom-0 !left-auto !translate-x-0 !translate-y-0',
        '!h-full !rounded-none',
        'flex flex-col gap-3',
        'data-[state=open]:slide-in-from-right',
        'data-[state=closed]:slide-out-to-right',
      )}
    >
      <DialogTitle>Run history</DialogTitle>
      <DialogDescription>
        Pin runs to the multi-run overlay or drop them to free memory.
        The active run anchors the SLD animation regardless of the
        overlay set.
      </DialogDescription>

      <div className="flex items-center justify-between gap-2">
        <span data-testid="history-drawer-overlay-count" className="text-muted-foreground text-xs">
          {overlayCount === 0
            ? 'No runs pinned'
            : `${overlayCount} pinned to overlay`}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleClearOverlay}
          disabled={overlayCount === 0}
          data-testid="history-drawer-clear-overlay"
        >
          Clear overlay
        </Button>
      </div>

      {toastMessage !== null ? (
        <div
          role="status"
          data-testid="history-drawer-toast"
          className={cn(
            'border-border bg-muted/40 text-foreground',
            'rounded-[var(--radius-sm)] border px-2 py-1.5 text-xs',
          )}
        >
          {toastMessage}
        </div>
      ) : null}

      <div
        data-testid="history-drawer-list"
        className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto"
      >
        {orderedRuns.length === 0 ? (
          <div
            data-testid="history-drawer-empty"
            className="text-muted-foreground p-3 text-center text-xs"
          >
            No runs yet. Run a TDS to populate the history.
          </div>
        ) : (
          orderedRuns.map((r) => (
            <HistoryRunRow
              key={r.runId}
              run={r}
              isActive={r.runId === activeRunId}
              isOverlayPinned={overlayRunIds.has(r.runId)}
              onTogglePin={(_id, willBePinned) =>
                setToast(willBePinned ? 'Pinned to overlay' : 'Unpinned from overlay')
              }
              onReset={() => setToast('Run dropped from history')}
            />
          ))
        )}
      </div>
    </DialogContent>
  );
}
