/**
 * `<ErrorHistoryRow>` (v3.1 Phase 3, Unit 7).
 *
 * Compact terminal-error row for the Activity panel's history tab (Unit 11).
 * Renders, on one tight row: the failed job's kind badge + error title, an
 * optional recovery action (`<RecoveryActionButton>`), and a collapsible
 * raw-JSON disclosure for the full ProblemDetails body.
 *
 * Unlike the `banner` / `modal` variants of `<ProblemDetailsErrorSurface>`,
 * this row is list-density: no dismiss affordance (the Activity panel owns
 * dismissal via `useJobsStore.dismissJob`), no large headline — it's a
 * scannable history entry that still offers the same one-click recovery.
 *
 * Tokens: danger-tokened (`text-danger`, `border-danger`). NEVER
 * `destructive`.
 */
import { useState } from 'react';
import { cn } from '@/lib/cn';
import { parseRecoveryDescriptor } from '@/lib/recovery';
import type { JobKind, JobProblem } from '@/store/jobs';
import { RecoveryActionButton } from './RecoveryActionButton';

export interface ErrorHistoryRowProps {
  /** The failed job's id (selects it in the panel; threads `wait-for-*`). */
  jobId: string;
  /** The job kind — rendered as a leading badge. */
  kind: JobKind;
  /** The ProblemDetails envelope carried on the failed `JobRecord`. */
  problem: JobProblem | null | undefined;
  /** `retry`-kind re-run callback (re-fires the failed mutation). */
  onRetry?: () => void;
  /** Optional className passthrough. */
  className?: string;
  /** data-testid root; defaults to `error-history-row`. */
  testId?: string;
}

export function ErrorHistoryRow({
  jobId,
  kind,
  problem,
  onRetry,
  className,
  testId = 'error-history-row',
}: ErrorHistoryRowProps) {
  const [showRaw, setShowRaw] = useState(false);

  const title = problem?.title ?? 'Operation failed';
  const detail = typeof problem?.detail === 'string' ? problem.detail : null;
  const recovery = parseRecoveryDescriptor(problem?.recovery);
  const rawJson = JSON.stringify(problem ?? { title }, null, 2);
  const hasCta = recovery !== null && recovery.kind !== 'none';

  return (
    <div
      role="listitem"
      data-testid={testId}
      data-job-id={jobId}
      className={cn(
        'border-danger/30 bg-danger/5 text-foreground',
        'flex flex-col gap-1.5 rounded-[var(--radius-sm)] border p-2 text-xs',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <span
          data-testid={`${testId}-kind`}
          className={cn(
            'border-danger/40 text-danger',
            'inline-flex shrink-0 items-center rounded-[var(--radius-sm)] border px-1.5 py-0.5',
            'font-mono text-[10px] tracking-tight uppercase',
          )}
        >
          {kind}
        </span>
        <span className="text-danger truncate font-medium" title={title}>
          {title}
        </span>
        {hasCta ? (
          <span className="ml-auto shrink-0">
            <RecoveryActionButton
              recovery={recovery}
              onRetry={onRetry}
              jobId={jobId}
              testId={`${testId}-recovery`}
            />
          </span>
        ) : null}
      </div>

      {detail ? <p className="text-muted-foreground">{detail}</p> : null}

      <button
        type="button"
        onClick={() => setShowRaw((v) => !v)}
        aria-expanded={showRaw}
        data-testid={`${testId}-raw-toggle`}
        className={cn(
          'text-muted-foreground hover:text-foreground',
          'self-start text-[11px] underline',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        )}
      >
        {showRaw ? 'Hide raw error' : 'View raw error'}
      </button>
      {showRaw ? (
        <pre
          data-testid={`${testId}-raw`}
          className={cn(
            'bg-muted text-foreground',
            'overflow-auto rounded-[var(--radius-sm)] p-2',
            'font-mono text-[11px] whitespace-pre-wrap',
            'max-h-40',
          )}
        >
          {rawJson}
        </pre>
      ) : null}
    </div>
  );
}
