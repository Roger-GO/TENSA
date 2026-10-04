import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { RecoveryActionButton } from '@/components/error/RecoveryActionButton';
import { useRunReadiness, type RunRoutine } from '@/lib/useRunReadiness';

/**
 * RunReadinessNote — the always-visible "why can't I run this yet" line that
 * sits under an Analyze Run button.
 *
 * The disabled Run buttons already explain themselves in a tooltip, but a
 * tooltip only opens on hover or focus: a first-time user sees a greyed-out
 * button, and a screen reader or a keyboard user never gets the reason at all.
 * This renders the same reason from the same ``useRunReadiness`` hook as
 * visible text, with the one-click recovery next to it (Run power flow, Reset
 * run). Nothing renders once the routine is ready.
 *
 * ``extra`` is routine-specific guidance shown with the reason. The note's id
 * is ``<testId>-hint``, which the Run button names in ``aria-describedby`` so
 * the reason is also its accessible description.
 */

export interface RunReadinessNoteProps {
  routine: RunRoutine;
  /** The Run button's test id; the note's id and test id derive from it. */
  testId: string;
  extra?: ReactNode;
  className?: string;
}

export function RunReadinessNote({ routine, testId, extra, className }: RunReadinessNoteProps) {
  const readiness = useRunReadiness(routine);
  if (readiness.ready || readiness.disabledReason === null) return null;

  return (
    <div
      id={`${testId}-hint`}
      data-testid={`${testId}-hint`}
      className={cn(
        'border-border bg-muted/30 text-muted-foreground flex flex-wrap items-center gap-x-3',
        'gap-y-1.5 rounded border px-2.5 py-1.5 text-xs leading-snug',
        className,
      )}
    >
      <span className="min-w-0">
        {readiness.disabledReason}
        {extra !== undefined && extra !== null ? <> {extra}</> : null}
      </span>
      <RecoveryActionButton
        recovery={readiness.recovery}
        variant="outline"
        testId={`${testId}-hint-action`}
      />
    </div>
  );
}
