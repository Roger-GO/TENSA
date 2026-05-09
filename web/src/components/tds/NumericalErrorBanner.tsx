import { useState } from 'react';
import { useRunsStore } from '@/store/runs';
import { cn } from '@/lib/cn';
import { NumericalErrorDetails } from './NumericalErrorDetails';

/**
 * NumericalErrorBanner — non-modal banner pinned above the right-dock
 * regions when the active TDS run terminated due to numerical instability
 * (or a hard stream error that wasn't a user abort).
 *
 * Visibility rules (per the v0.2 plan's state-inference table):
 *
 * - The active run's ``state`` is ``"error"``, OR
 * - The active run's ``state`` is ``"done"`` with ``tCurrent < tf`` AND
 *   ``abortedLocally === false`` (UI infers numerical instability from
 *   the local state — there's no ``aborted`` flag on the wire).
 *
 * Hidden when there's no active run, when the run completed cleanly, or
 * when the user aborted (the badge already conveys "aborted at t=X" —
 * surfacing both the badge and a banner is double-noise).
 *
 * The banner mirrors the visual + interaction pattern of
 * ``ConvergenceErrorPanel`` (the v0.1 PF-non-convergence surface) — a
 * one-line summary above the dock with a "View details" toggle that
 * expands the slide-out below. NOT a modal: inspector + scrub remain
 * accessible underneath, which matters for the researcher workflow
 * (inspect bus voltages at the moment of failure).
 */

export interface NumericalErrorBannerProps {
  className?: string;
}

export function NumericalErrorBanner({ className }: NumericalErrorBannerProps) {
  const activeRunId = useRunsStore((s) => s.activeRunId);
  const run = useRunsStore((s) => (activeRunId === null ? null : s.runs[activeRunId] ?? null));

  const [expanded, setExpanded] = useState(false);
  // ``dismissedRunId`` records the run we dismissed. A new run (different
  // ``runId``) re-shows the banner because the dismissed flag is per-run.
  const [dismissedRunId, setDismissedRunId] = useState<string | null>(null);

  if (run === null) return null;
  // Per the v0.2 plan's state-inference table:
  // - ``state === "error"`` → numerical-instability surface.
  // - ``state === "done"`` with ``final_t < tf`` AND no local abort →
  //   numerical-instability (the substrate's ``done`` has no aborted
  //   flag; the UI infers).
  const isNumericalError =
    run.state === 'error' ||
    (run.state === 'done' && !run.abortedLocally && run.tCurrent < run.tf);
  if (!isNumericalError) return null;
  if (dismissedRunId === run.runId) return null;

  const onDismiss = () => {
    setDismissedRunId(run.runId);
    setExpanded(false);
  };

  return (
    <div
      role="region"
      aria-label="TDS numerical error"
      data-testid="numerical-error-banner"
      className={cn(
        'border-destructive/40 bg-destructive/10 text-foreground',
        'border-b',
        className,
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <p className="flex-1 text-sm">
          <span className="font-medium">TDS halted at t={run.tCurrent.toFixed(2)}s</span>{' '}
          <span className="text-muted-foreground">— numerical instability.</span>
        </p>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          data-testid="numerical-error-toggle"
          className={cn(
            'text-muted-foreground hover:text-foreground',
            'rounded-[var(--radius-sm)] px-2 py-0.5 text-xs',
            'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          )}
        >
          {expanded ? 'Hide details' : 'View details ▸'}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss numerical error"
          data-testid="numerical-error-dismiss"
          className={cn(
            'text-muted-foreground hover:text-foreground',
            'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)]',
            'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          )}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M4 4 L12 12 M12 4 L4 12" />
          </svg>
        </button>
      </div>

      {expanded ? <NumericalErrorDetails run={run} onDismiss={onDismiss} /> : null}
    </div>
  );
}
