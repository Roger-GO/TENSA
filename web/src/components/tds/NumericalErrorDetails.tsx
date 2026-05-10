import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { RunRecord } from '@/store/runs';
import { cn } from '@/lib/cn';

/**
 * NumericalErrorDetails — slide-out body content surfaced when the user
 * clicks "View details" on the ``NumericalErrorBanner``. Per the v0.2
 * plan's "non-modal slide-out" mandate (R8 → R18), this is NOT a modal
 * dialog: the inspector + scrub controls remain accessible underneath so
 * the researcher can keep diagnosing the partial buffer at the moment of
 * failure.
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
    const report = JSON.stringify(
      {
        run_id: run.runId,
        final_t: run.tCurrent,
        tf: run.tf,
        seq_count: run.seqCount,
        error_reason: run.errorReason ?? null,
        timestamp: new Date().toISOString(),
        user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      },
      null,
      2,
    );
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
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground font-mono">final_t</dt>
        <dd className="text-foreground font-mono">{run.tCurrent.toFixed(4)} s</dd>
        <dt className="text-muted-foreground font-mono">tf (requested)</dt>
        <dd className="text-foreground font-mono">{run.tf.toFixed(4)} s</dd>
        <dt className="text-muted-foreground font-mono">rows decoded</dt>
        <dd className="text-foreground font-mono">{run.seqCount}</dd>
        <dt className="text-muted-foreground font-mono">last reason</dt>
        <dd className="text-foreground font-mono break-words">{run.errorReason ?? '—'}</dd>
        <dt className="text-muted-foreground font-mono">run_id</dt>
        <dd className="text-foreground truncate font-mono">{run.runId}</dd>
      </dl>
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
