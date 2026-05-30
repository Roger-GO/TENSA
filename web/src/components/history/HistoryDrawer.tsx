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
import { useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { EmptyState, HistoryIcon } from '@/components/ui/EmptyState';
import { ProblemDetailsErrorSurface } from '@/components/error/ProblemDetailsErrorSurface';
import { useRunModeStore } from '@/store/runMode';
import { useHistoryStore } from '@/store/history';
import { useRunsStore } from '@/store/runs';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { useJobsStore, type JobRecord } from '@/store/jobs';
import { useLayoutStore, type HistoryKindFilter } from '@/store/layout';
import type { RunRecord } from '@/store/runs';
import { HistoryRunRow } from './HistoryRunRow';
import { HistoryJobRow } from './HistoryJobRow';
import { kindLabel } from '@/components/shell/jobLabels';
import { SweepProgressPanel } from '@/components/sweep/SweepProgressPanel';
import { useSweepStore } from '@/store/sweep';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/cn';

/**
 * The "run-like" job kinds that carry TDS-specific affordances (scrub /
 * overlay) when joined to a ``RunRecord`` in ``useRunsStore``. The default
 * "Runs" filter view renders these; everything else renders as a simple
 * ``HistoryJobRow``.
 */
const RUN_LIKE_KINDS = new Set<JobRecord['kind']>(['tds-stream', 'tds-batch', 'sweep']);

/**
 * The kind-filter selector options. ``runs`` (default) keeps the historical
 * TDS-runs view; ``all`` surfaces every job kind chronologically; the
 * remaining entries filter the job list down to a single kind. Kept a
 * curated list (not the full ``JobKind`` union) so the selector stays
 * compact — an unknown kind still renders in the ``all`` view.
 */
const FILTER_OPTIONS: readonly { value: HistoryKindFilter; label: string }[] = [
  { value: 'runs', label: 'Runs' },
  { value: 'all', label: 'All jobs' },
  { value: 'pflow', label: kindLabel('pflow') },
  { value: 'eig', label: kindLabel('eig') },
  { value: 'cpf', label: kindLabel('cpf') },
  { value: 'se', label: kindLabel('se') },
];

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
      History{' '}
      {runCount > 0 ? (
        <span className="text-muted-foreground ml-1 text-[10px]">({runCount})</span>
      ) : null}
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
  const jobs = useJobsStore((s) => s.jobs);
  const filter = useLayoutStore((s) => s.historyKindFilter);
  const setFilter = useLayoutStore((s) => s.setHistoryKindFilter);
  const setActiveRoutine = useRunModeStore((s) => s.setActiveRoutine);
  const closeDrawer = useHistoryStore((s) => s.closeDrawer);
  // Unit 18: only render the sweep progress panel when a sweep is
  // actively in progress (or just finished and still cleaning up).
  // The panel renders an empty-state otherwise; we suppress its
  // mount entirely when there's no sweep so the drawer stays compact.
  const activeSweepId = useSweepStore((s) => s.activeSweepId);
  const sweeps = useSweepStore((s) => s.sweeps);
  const showSweepPanel = activeSweepId !== null || Object.keys(sweeps).length > 0;

  // Shared error modal (clone-on-write: panel-local React state, never
  // mutated through the store) for "View error" on failed non-run rows.
  const [errorJob, setErrorJob] = useState<JobRecord | null>(null);

  // The default "Runs" view is the historical TDS-runs surface. It sources
  // DIRECTLY from ``useRunsStore`` (not via ``useJobsStore``) so every
  // TDS-specific affordance — scrub, overlay pin/unpin, reset, per-run
  // colour — keeps working unchanged. This is the no-regression path.
  const isRunsView = filter === 'runs';

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

  // The "All" / per-kind job views source from ``useJobsStore`` (every job
  // kind, terminal + in-flight) in reverse-chronological order. ``all``
  // shows everything; a concrete kind narrows to that kind.
  const orderedJobs = useMemo<readonly JobRecord[]>(() => {
    if (isRunsView) return [];
    const list = Object.values(jobs);
    const filtered = filter === 'all' ? list : list.filter((j) => j.kind === filter);
    return filtered.sort((a, b) => b.started_at - a.started_at);
  }, [jobs, filter, isRunsView]);

  const handleClearOverlay = () => {
    setOverlayRuns([]);
    // Per Unit 3 of the v2.0 polish plan: transient action results live
    // on the global toast surface (`@/lib/toast`) so they survive the
    // unmount of this drawer (the user often closes the drawer right
    // after acting on a row).
    toast.info('Overlay cleared');
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
      <DialogTitle>{isRunsView ? 'Run history' : 'Job history'}</DialogTitle>
      <DialogDescription>
        {isRunsView
          ? 'Pin runs to the multi-run overlay or drop them to free memory. The active run anchors the SLD animation regardless of the overlay set.'
          : 'Every job kind in one chronological list. TDS runs keep their scrub + overlay controls on the Runs filter.'}
      </DialogDescription>

      <div className="flex items-center justify-between gap-2">
        <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <span>Show</span>
          <select
            data-testid="history-drawer-kind-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value as HistoryKindFilter)}
            className="border-border bg-background text-foreground rounded border px-1.5 py-0.5 text-xs"
          >
            {FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        {isRunsView ? (
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
        ) : null}
      </div>

      {isRunsView ? (
        <div className="flex items-center justify-between gap-2">
          <span
            data-testid="history-drawer-overlay-count"
            className="text-muted-foreground text-xs"
          >
            {overlayCount === 0 ? 'No runs pinned' : `${overlayCount} pinned to overlay`}
          </span>
        </div>
      ) : null}

      {/* Per-row pin/unpin/reset toasts now route through the global
          toast surface (Unit 3 of the v2.0 polish plan). The previous
          inline `history-drawer-toast` div has been retired. */}

      {showSweepPanel ? (
        <div
          data-testid="history-drawer-sweep-section"
          className="border-border rounded border p-2"
        >
          <SweepProgressPanel />
        </div>
      ) : null}

      <div
        data-testid="history-drawer-list"
        className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto"
      >
        {isRunsView ? (
          orderedRuns.length === 0 ? (
            <div data-testid="history-drawer-empty">
              <EmptyState
                icon={<HistoryIcon />}
                title="No runs yet"
                description="Run a TDS to populate the history."
                action={{
                  label: 'Run TDS',
                  onClick: () => {
                    // Flip the active routine so the topbar Run button
                    // becomes "Run TDS" and the cmd palette routes to
                    // it; close the drawer so the user sees the change.
                    setActiveRoutine('tds');
                    closeDrawer();
                  },
                }}
                emptyStateKey="history-drawer"
              />
            </div>
          ) : (
            orderedRuns.map((r) => (
              <HistoryRunRow
                key={r.runId}
                run={r}
                isActive={r.runId === activeRunId}
                isOverlayPinned={overlayRunIds.has(r.runId)}
                onTogglePin={(_id, willBePinned) =>
                  toast.info(willBePinned ? 'Pinned to overlay' : 'Unpinned from overlay')
                }
                onReset={() => toast.info('Run dropped from history')}
              />
            ))
          )
        ) : orderedJobs.length === 0 ? (
          <div data-testid="history-drawer-empty">
            <EmptyState
              icon={<HistoryIcon />}
              title="No jobs yet"
              description="Routines and edits appear here once you run them."
              emptyStateKey="history-drawer-jobs"
            />
          </div>
        ) : (
          orderedJobs.map((job) =>
            // Run-like kinds that still have a live RunRecord keep their rich
            // TDS row (scrub/overlay/reset). We join JobRecord → RunRecord by
            // ``runId === job_id`` (run_id aliases job_id from Unit 5c). When
            // the RunRecord has been evicted (or this is a batch/sweep without
            // streamed frames), fall back to the simple job row.
            RUN_LIKE_KINDS.has(job.kind) && runs[job.id] ? (
              <HistoryRunRow
                key={job.id}
                run={runs[job.id]!}
                isActive={job.id === activeRunId}
                isOverlayPinned={overlayRunIds.has(job.id)}
                onTogglePin={(_id, willBePinned) =>
                  toast.info(willBePinned ? 'Pinned to overlay' : 'Unpinned from overlay')
                }
                onReset={() => toast.info('Run dropped from history')}
              />
            ) : (
              <HistoryJobRow key={job.id} job={job} onViewError={(j) => setErrorJob(j)} />
            ),
          )
        )}
      </div>

      {errorJob !== null ? (
        <ProblemDetailsErrorSurface
          variant="modal"
          testId="history-drawer-error-modal"
          // ``JobProblem`` is a structurally-open ProblemDetails carrier; the
          // surface's normaliser reads title/detail/recovery off it.
          error={
            (errorJob.problem ?? {
              title: 'Job failed',
              detail: kindLabel(errorJob.kind),
            }) as Record<string, unknown>
          }
          jobId={errorJob.id}
          onDismiss={() => setErrorJob(null)}
        />
      ) : null}
    </DialogContent>
  );
}
