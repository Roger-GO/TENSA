/**
 * ActivityPanel (v3.1 Phase 3, Unit 11).
 *
 * The first big VISIBLE job UI — a BottomDrawer tab (the 7th, alongside
 * Buses | Lines | … | Analysis) that surfaces every action's progress +
 * outcome in ONE consistent surface, reading from ``useJobsStore``.
 *
 * Two sub-tabs:
 *
 * - **Active** — in-flight jobs (``pending`` / ``running``) ordered by
 *   ``started_at`` desc. Each row shows kind, status, live progress, and a
 *   Cancel button when ``can_cancel`` (fires ``DELETE /sessions/{id}/jobs/{job_id}``
 *   via ``useCancelJob``).
 * - **History** — terminal jobs (``done`` / ``failed`` / ``cancelled``)
 *   ordered by ``ended_at`` desc. ``failed`` rows show an error icon + a
 *   "Retry" button (re-fires the original mutation from
 *   ``JobRecord.request_summary`` + kind) and a "View error" button that
 *   opens ``<ProblemDetailsErrorSurface variant="modal">`` with the
 *   captured ``problem``.
 *
 * This generalises ``HistoryDrawer``'s rows-of-runs pattern. The store is
 * the single source of truth; the panel never re-implements job state.
 *
 * Tokens: ``danger`` for the failed-state accents (NEVER ``destructive`` —
 * a lint rule enforces this).
 */
import { useEffect, useMemo, useState } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { EmptyState, InboxIcon, HistoryIcon } from '@/components/ui/EmptyState';
import { ProblemDetailsErrorSurface } from '@/components/error/ProblemDetailsErrorSurface';
import {
  useJobsStore,
  isTerminalStatus,
  LOCAL_ID_PREFIX,
  type JobRecord,
  type JobStatus,
} from '@/store/jobs';
import { useLayoutStore, ACTIVITY_PANEL_TABS, type ActivityPanelTab } from '@/store/layout';
import { useSessionStore } from '@/store/session';
import { useCancelJob, useRunPflow, useEigRun, useSeRun, useReloadCase } from '@/api/queries';
import { kindLabel } from '@/components/shell/jobLabels';

const STATUS_LABELS: Record<JobStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** Format an elapsed duration (seconds) compactly: ``1.2s`` / ``3m 04s``. */
function formatElapsed(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/** Elapsed for a terminal row (ended − started) or in-flight (now − started). */
function elapsedFor(job: JobRecord): number {
  const end = isTerminalStatus(job.status) ? (job.ended_at ?? job.updated_at) : Date.now() / 1000;
  return end - job.started_at;
}

interface RowActions {
  /** Fire a Cancel for a cancellable in-flight job. */
  onCancel?: (job: JobRecord) => void;
  /** Re-fire the original mutation for a failed job. Undefined → no Retry. */
  onRetry?: (job: JobRecord) => void;
  /** Open the error modal for a failed job. */
  onViewError?: (job: JobRecord) => void;
}

/** A single job row. Generalises ``HistoryRunRow`` for the job-record shape. */
function ActivityRow({ job, actions }: { job: JobRecord; actions: RowActions }) {
  const failed = job.status === 'failed';
  // Cancel targets ``DELETE /jobs/{job_id}`` verbatim. A ``local:``
  // placeholder has no server-side job yet (the canonical id only lands in
  // the mutation ``onSuccess``), so a DELETE on it would 404 — and the
  // optimistic ``cancelled`` flip would be a lie while the real job keeps
  // running. Gate Cancel on a reconciled (non-placeholder) id.
  const cancellable =
    job.can_cancel && !isTerminalStatus(job.status) && !job.id.startsWith(LOCAL_ID_PREFIX);
  const progressPct =
    job.progress !== undefined ? Math.round(Math.max(0, Math.min(1, job.progress)) * 100) : null;

  return (
    <div
      data-testid={`activity-row-${job.id}`}
      data-status={job.status}
      className={cn(
        'border-border flex flex-col gap-1.5 rounded-[var(--radius-sm)] border p-2 text-sm',
        failed && 'border-danger/40 bg-danger/5',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {failed ? (
            <span
              data-testid={`activity-row-error-icon-${job.id}`}
              className="text-danger shrink-0"
            >
              <ErrorIcon />
            </span>
          ) : null}
          <span className="text-foreground truncate font-medium">{kindLabel(job.kind)}</span>
          {job.repeated_count > 1 ? (
            <span className="text-muted-foreground text-[10px]">×{job.repeated_count}</span>
          ) : null}
        </div>
        <span
          data-testid={`activity-row-status-${job.id}`}
          className={cn(
            'shrink-0 rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[10px] font-medium',
            job.status === 'done' && 'bg-muted text-muted-foreground',
            (job.status === 'pending' || job.status === 'running') && 'bg-primary/15 text-primary',
            job.status === 'failed' && 'bg-danger/15 text-danger',
            job.status === 'cancelled' && 'bg-muted text-muted-foreground',
          )}
        >
          {STATUS_LABELS[job.status]}
        </span>
      </div>

      {progressPct !== null && !isTerminalStatus(job.status) ? (
        <div
          data-testid={`activity-row-progress-${job.id}`}
          role="progressbar"
          aria-label={`Progress ${progressPct}%`}
          aria-valuenow={progressPct}
          aria-valuemin={0}
          aria-valuemax={100}
          className="bg-muted h-1 w-full overflow-hidden rounded-full"
        >
          <div
            className="bg-primary h-full transition-[width] duration-[var(--duration-fast)]"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      ) : null}

      <div className="text-muted-foreground flex items-center justify-between gap-2 text-[11px]">
        <span data-testid={`activity-row-elapsed-${job.id}`}>{formatElapsed(elapsedFor(job))}</span>
        <div className="flex items-center gap-1.5">
          {cancellable && actions.onCancel ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              data-testid={`activity-row-cancel-${job.id}`}
              onClick={() => actions.onCancel?.(job)}
            >
              Cancel
            </Button>
          ) : null}
          {failed && actions.onViewError ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              data-testid={`activity-row-view-error-${job.id}`}
              onClick={() => actions.onViewError?.(job)}
            >
              View error
            </Button>
          ) : null}
          {failed && actions.onRetry ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 text-xs"
              data-testid={`activity-row-retry-${job.id}`}
              onClick={() => actions.onRetry?.(job)}
            >
              Retry
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function ActivityPanel() {
  const jobs = useJobsStore((s) => s.jobs);
  const activeTab = useLayoutStore((s) => s.activityPanelTab);
  const setActiveTab = useLayoutStore((s) => s.setActivityPanelTab);
  const sessionId = useSessionStore((s) => s.sessionId);

  const cancelJob = useCancelJob();
  // Retry re-fires the ORIGINAL mutation. We map the small set of
  // session-scoped routine/edit kinds that retry sensibly without extra
  // vars; richer kinds (cpf/sweep/bundle) carry vars in request_summary and
  // are out of scope for the in-place Retry (the user re-runs them from
  // their owning surface). Unknown kinds simply render no Retry button.
  const runPflow = useRunPflow();
  const runEig = useEigRun();
  const runSe = useSeRun();
  const reloadCase = useReloadCase();

  // Modal state for "View error" — holds the failed job whose problem is
  // being inspected. The clone-on-write rule (panel state is local React,
  // never mutated through the store) keeps this independent of the store.
  const [errorJob, setErrorJob] = useState<JobRecord | null>(null);

  const { active, history } = useMemo(() => {
    const list = Object.values(jobs);
    const inFlight = list
      .filter((j) => !isTerminalStatus(j.status))
      .sort((a, b) => b.started_at - a.started_at);
    const terminal = list
      .filter((j) => isTerminalStatus(j.status))
      .sort((a, b) => (b.ended_at ?? b.updated_at) - (a.ended_at ?? a.updated_at));
    return { active: inFlight, history: terminal };
  }, [jobs]);

  // Tick once a second WHILE any job is in flight so the per-row elapsed
  // label advances even when a long-running job emits no progress/status
  // events (``elapsedFor`` reads ``Date.now()`` at render). Gated on
  // ``active.length`` so there are no idle re-renders when nothing is running;
  // ``_tick`` is intentionally unused beyond forcing the re-render.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (active.length === 0) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [active.length]);

  const retryFor = (job: JobRecord): (() => void) | undefined => {
    if (sessionId === null) return undefined;
    switch (job.kind) {
      case 'pflow':
        return () => runPflow.mutate(sessionId);
      case 'eig':
        return () => runEig.mutate(sessionId);
      case 'se':
        return () => runSe.mutate(sessionId);
      case 'case-reload':
        return () => reloadCase.mutate(sessionId);
      default:
        return undefined;
    }
  };

  const activeActions: RowActions = {
    onCancel: (job) => {
      if (sessionId === null) return;
      // Swallow the rejection: the job may have completed between render and
      // click; the JobStream remains authoritative for the real terminal
      // state.
      cancelJob.mutate({ sessionId, jobId: job.id }, { onError: () => {} });
    },
  };

  const historyActions = (job: JobRecord): RowActions => {
    const retry = retryFor(job);
    const acts: RowActions = { onViewError: (j) => setErrorJob(j) };
    if (retry) acts.onRetry = () => retry();
    return acts;
  };

  return (
    <TabsPrimitive.Root
      value={activeTab}
      onValueChange={(next) => setActiveTab(next as ActivityPanelTab)}
      data-testid="activity-panel"
      className="flex min-h-0 flex-1 flex-col"
    >
      <TabsPrimitive.List
        aria-label="Activity panel tabs"
        className="border-border bg-muted/30 flex h-7 shrink-0 items-stretch border-b"
      >
        {ACTIVITY_PANEL_TABS.map((tab) => (
          <TabsPrimitive.Trigger
            key={tab}
            value={tab}
            data-testid={`activity-panel-subtab-${tab}`}
            className={cn(
              'relative inline-flex items-center gap-1.5 px-3 text-xs font-medium capitalize',
              'text-muted-foreground hover:text-foreground',
              'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
              'data-[state=active]:bg-background data-[state=active]:text-foreground',
              'data-[state=active]:shadow-[inset_0_2px_0_0_var(--color-primary)]',
              'transition-colors duration-[var(--duration-fast)]',
            )}
          >
            {tab}
            {tab === 'active' && active.length > 0 ? (
              <span
                data-testid="activity-panel-active-count"
                className="bg-primary/15 text-primary rounded-full px-1.5 text-[10px] font-semibold"
              >
                {active.length}
              </span>
            ) : null}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>

      <TabsPrimitive.Content
        value="active"
        data-testid="activity-panel-content-active"
        className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2"
      >
        {active.length === 0 ? (
          <div
            data-testid="activity-panel-active-empty"
            className="flex flex-1 items-center justify-center"
          >
            <EmptyState
              icon={<InboxIcon />}
              title="No active jobs"
              description="Running routines and edits appear here while they're in flight."
              emptyStateKey="activity-active"
            />
          </div>
        ) : (
          active.map((job) => <ActivityRow key={job.id} job={job} actions={activeActions} />)
        )}
      </TabsPrimitive.Content>

      <TabsPrimitive.Content
        value="history"
        data-testid="activity-panel-content-history"
        className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2"
      >
        {history.length === 0 ? (
          <div
            data-testid="activity-panel-history-empty"
            className="flex flex-1 items-center justify-center"
          >
            <EmptyState
              icon={<HistoryIcon />}
              title="No history yet"
              description="Completed, failed, and cancelled jobs land here."
              emptyStateKey="activity-history"
            />
          </div>
        ) : (
          history.map((job) => <ActivityRow key={job.id} job={job} actions={historyActions(job)} />)
        )}
      </TabsPrimitive.Content>

      {errorJob !== null ? (
        <ProblemDetailsErrorSurface
          variant="modal"
          testId="activity-error-modal"
          // ``JobProblem`` is a structurally-open ProblemDetails carrier; the
          // surface's normaliser reads title/detail/recovery off it. The
          // ``recovery`` field is ``unknown`` on the store type vs. a typed
          // descriptor here, so a narrowing cast bridges the two open shapes.
          error={
            (errorJob.problem ?? {
              title: 'Job failed',
              detail: kindLabel(errorJob.kind),
            }) as Record<string, unknown>
          }
          jobId={errorJob.id}
          onDismiss={() => setErrorJob(null)}
          onRetry={() => {
            const retry = retryFor(errorJob);
            retry?.();
            setErrorJob(null);
          }}
        />
      ) : null}
    </TabsPrimitive.Root>
  );
}

/** Small inline error glyph (matches the house SVG style). */
function ErrorIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className={className}
    >
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 5v3.5M8 11h.01" />
    </svg>
  );
}
