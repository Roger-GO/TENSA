/**
 * HistoryJobRow (v3.1 Phase 3, Unit 12).
 *
 * A SIMPLE history row for non-run job kinds (pflow / eig / cpf / se /
 * snapshot / bundle / element / …). Surfaced in the HistoryDrawer's "All"
 * view (and the per-kind filtered views) alongside the rich TDS/sweep
 * ``HistoryRunRow``.
 *
 * Deliberately minimal vs. ``ActivityRow``: the HistoryDrawer is the older,
 * compact surface. Each row shows the kind label, a status badge, the
 * started timestamp, the elapsed duration, and — for ``failed`` rows — a
 * "View error" button that hands the captured ``problem`` up to the
 * drawer's shared error modal. No Retry / Cancel here (those live on the
 * Activity panel, Unit 11) — the HistoryDrawer is a read-mostly log.
 *
 * Tokens: ``danger`` for the failed-state accents (NEVER ``destructive`` —
 * a lint rule enforces this).
 */
import { isTerminalStatus, type JobRecord, type JobStatus } from '@/store/jobs';
import { Button } from '@/components/ui/button';
import { kindLabel } from '@/components/shell/jobLabels';
import { cn } from '@/lib/cn';

export interface HistoryJobRowProps {
  job: JobRecord;
  /** Open the shared error modal for a failed job. */
  onViewError?: (job: JobRecord) => void;
  className?: string;
}

const STATUS_LABELS: Record<JobStatus, string> = {
  pending: 'pending',
  running: 'running',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

const STATUS_CLASS: Record<JobStatus, string> = {
  pending: 'bg-muted text-muted-foreground',
  running: 'bg-primary/15 text-foreground',
  done: 'bg-success/15 text-foreground',
  failed: 'bg-danger/15 text-foreground',
  cancelled: 'bg-muted text-muted-foreground',
};

/** Format a wall-clock timestamp (epoch seconds) as ``HH:MM:SS``. */
function formatTime(epochSeconds: number): string {
  try {
    const d = new Date(epochSeconds * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  } catch {
    return '—';
  }
}

/** Compact elapsed duration (seconds): ``1.2s`` / ``3m 04s``. */
function formatElapsed(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function elapsedFor(job: JobRecord): number {
  const end = isTerminalStatus(job.status) ? (job.ended_at ?? job.updated_at) : Date.now() / 1000;
  return end - job.started_at;
}

export function HistoryJobRow({ job, onViewError, className }: HistoryJobRowProps) {
  const failed = job.status === 'failed';

  return (
    <div
      data-testid={`history-job-row-${job.id}`}
      data-job-id={job.id}
      data-kind={job.kind}
      data-status={job.status}
      className={cn(
        'border-border flex items-center gap-2 rounded border px-2 py-1.5',
        failed ? 'border-danger/40' : '',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-foreground truncate text-xs font-medium">{kindLabel(job.kind)}</span>
          {job.repeated_count > 1 ? (
            <span className="text-muted-foreground text-[10px]">×{job.repeated_count}</span>
          ) : null}
          <span
            data-testid={`history-job-row-status-${job.id}`}
            className={cn(
              'rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[10px]',
              STATUS_CLASS[job.status],
            )}
          >
            {STATUS_LABELS[job.status]}
          </span>
        </div>
        <div className="text-muted-foreground flex items-center gap-2 text-[10px]">
          <span data-testid={`history-job-row-timestamp-${job.id}`}>
            {formatTime(job.started_at)}
          </span>
          <span data-testid={`history-job-row-elapsed-${job.id}`}>
            {formatElapsed(elapsedFor(job))}
          </span>
        </div>
      </div>
      {failed && onViewError ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onViewError(job)}
          data-testid={`history-job-row-view-error-${job.id}`}
        >
          View error
        </Button>
      ) : null}
    </div>
  );
}
