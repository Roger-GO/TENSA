import { useState } from 'react';
import { useRunsStore } from '@/store/runs';
import { cn } from '@/lib/cn';
import { ProblemDetailsErrorSurface } from '@/components/error/ProblemDetailsErrorSurface';
import { numericalErrorDetail } from '@/components/error/routineErrorDetails';
import { NumericalErrorDetails } from './NumericalErrorDetails';

/**
 * NumericalErrorBanner — non-modal banner pinned above the right-dock regions
 * when the active TDS run terminated due to numerical instability (or a hard
 * stream error that wasn't a user abort). v3.1 Unit 9: now a THIN WRAPPER
 * around the single `<ProblemDetailsErrorSurface>` primitive's `banner`
 * variant.
 *
 * Visibility rules (per the v0.2 plan's state-inference table):
 *
 * - The active run's ``state`` is ``"error"``, OR
 * - The active run's ``state`` is ``"done"`` with ``tCurrent < tf`` AND
 *   ``abortedLocally === false`` (UI infers numerical instability from the
 *   local state — there's no ``aborted`` flag on the wire).
 *
 * Hidden when there's no active run, when the run completed cleanly, or when
 * the user aborted (the badge already conveys "aborted at t=X").
 *
 * The routine detail (final_t / tf / rows decoded / last reason / run_id +
 * Copy report) rides in the primitive's ``extras`` slot via
 * ``NumericalErrorDetails`` (the per-routine detail-formatter), behind the
 * bespoke "View details ▸" toggle. NOT a modal: inspector + scrub remain
 * accessible underneath.
 */

export interface NumericalErrorBannerProps {
  className?: string;
}

export function NumericalErrorBanner({ className }: NumericalErrorBannerProps) {
  const activeRunId = useRunsStore((s) => s.activeRunId);
  const run = useRunsStore((s) => (activeRunId === null ? null : (s.runs[activeRunId] ?? null)));

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
    run.state === 'error' || (run.state === 'done' && !run.abortedLocally && run.tCurrent < run.tf);
  if (!isNumericalError) return null;
  if (dismissedRunId === run.runId) return null;

  const onDismiss = () => {
    setDismissedRunId(run.runId);
  };

  return (
    <div
      role="region"
      aria-label="TDS numerical error"
      data-testid="numerical-error-banner"
      className={cn('pointer-events-auto', className)}
    >
      <ProblemDetailsErrorSurface
        variant="banner"
        testId="numerical-error"
        dismissLabel="Dismiss numerical error"
        hideRawDisclosure
        error={{
          title: `TDS halted at t=${run.tCurrent.toFixed(2)}s`,
          detail: numericalErrorDetail(),
          recovery: null,
        }}
        extras={<NumericalErrorDetails run={run} onDismiss={onDismiss} />}
        extrasCollapsible
        onDismiss={onDismiss}
      />
    </div>
  );
}
