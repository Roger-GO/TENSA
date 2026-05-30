import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { RunRecord } from '@/store/runs';
import { cn } from '@/lib/cn';
import { numericalErrorReport, numericalErrorRows } from '@/components/error/routineErrorDetails';
import { RoutineDetailGrid } from '@/components/error/routineErrorExtras';

/**
 * NumericalErrorDetails — the routine detail-formatter (extras renderer) the
 * migrated ``NumericalErrorBanner`` passes to the single
 * ``<ProblemDetailsErrorSurface>`` primitive's ``extras`` slot (v3.1 Unit 9).
 * It is no longer a standalone error surface — the primitive owns the banner
 * chrome; this file renders ONLY the diagnostic block (grid + note + Copy /
 * Dismiss footer) inside it. The grid rows + report blob come from the shared
 * ``routineErrorDetails`` formatter so the numbers match across surfaces.
 *
 * Per the v0.2 plan's "non-modal slide-out" mandate (R8 → R18), the host
 * banner is NOT a modal dialog: the inspector + scrub controls remain
 * accessible underneath so the researcher can keep diagnosing the partial
 * buffer at the moment of failure.
 *
 * Visible content (per the unit-7 brief):
 *
 * - Sim time at failure (``tCurrent`` — the last frame received before
 *   the substrate's TDS loop exited).
 * - Iteration count (``seqCount`` — the row count at exit, useful as a
 *   sanity check that the wire format actually delivered frames).
 * - Last mismatch hint (``errorReason`` from the runs slice, populated
 *   by ``RunStream``'s ``markRunError`` call when the ``done`` arrived
 *   with ``final_t < tf`` or a stream error fired).
 * - ``run_id`` (substrate-assigned, useful when filing an issue against
 *   the substrate's logs).
 * - "Copy report" button — JSON blob of the above for issue filing.
 *
 * The component is purely presentational; the parent (``NumericalErrorBanner``)
 * owns dismiss + reset-run actions to keep this file focused on rendering
 * the diagnostic snapshot.
 */

export interface NumericalErrorDetailsProps {
  /** The active run record at the moment of failure. */
  run: RunRecord;
  /** Optional dismiss handler (closes the slide-out). */
  onDismiss?: () => void;
  className?: string;
}

export function NumericalErrorDetails({ run, onDismiss, className }: NumericalErrorDetailsProps) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    const report = numericalErrorReport(run);
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(report);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      console.error('Could not copy numerical-error report:', report);
    }
  };

  return (
    <div
      role="region"
      aria-label="Numerical error details"
      data-testid="numerical-error-details"
      className={cn(
        'border-warning/30 bg-background/80 border-t',
        'flex flex-col gap-3 px-3 py-3',
        className,
      )}
    >
      <p className="text-foreground text-xs leading-relaxed">
        The TDS integration exited before reaching the requested final time. This usually means the
        Newton iteration diverged on a per-step solve (numerical instability). The partial buffer is
        preserved — scrub through it to inspect bus state at the moment of failure.
      </p>
      <RoutineDetailGrid rows={numericalErrorRows(run)} />
      <div className="flex justify-end gap-2 pt-1">
        {onDismiss ? (
          <Button type="button" size="sm" variant="outline" onClick={onDismiss}>
            Dismiss
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="primary"
          onClick={() => {
            void onCopy();
          }}
          data-testid="numerical-error-copy"
        >
          {copied ? 'Copied' : 'Copy report'}
        </Button>
      </div>
    </div>
  );
}
