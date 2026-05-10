import { useState } from 'react';
import { useSessionStore } from '@/store/session';
import { usePflowStore } from '@/store/pflow';
import { useRunPflow } from '@/api/queries';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

/**
 * ConvergenceErrorPanel. Surfaces non-convergence per R8.
 *
 * Two render branches:
 *
 * 1. Banner at the top of the right dock (above inspector + results).
 *    Shows "PF did not converge in {N} iterations. View details ▸".
 * 2. Click-to-expand non-modal slide-out, anchored under the banner.
 *    Inside: iteration count, last mismatch, "Run again" + "Dismiss".
 *
 * NOT a modal. NOT a takeover. Inspector + results table stay visible
 * underneath. Banner persists until the user explicitly dismisses or
 * a new PF run replaces `lastRun`.
 *
 * Visibility logic:
 *
 * - Render when `pflow.lastRun !== null && pflow.lastRun.converged === false`.
 * - Hide when the user dismisses (`dismissed = true` local state).
 * - Re-show when `pflow.lastRun` changes (the dismissed flag resets via
 *   the `useState` initializer keyed on `runId`).
 */

interface ConvergencePanelProps {
  className?: string;
}

export function ConvergenceErrorPanel({ className }: ConvergencePanelProps) {
  const lastRun = usePflowStore((s) => s.lastRun);
  const sessionId = useSessionStore((s) => s.sessionId);
  const runPflow = useRunPflow();

  const [expanded, setExpanded] = useState(false);
  // `dismissedFor` carries the run_id we dismissed. When `lastRun.run_id`
  // changes (a new PF run), the dismissed flag is no longer matched and
  // the banner re-appears.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);

  // Render only if we have a non-converged PF result and the user hasn't
  // dismissed it for this specific run.
  if (!lastRun || lastRun.converged) return null;
  if (dismissedFor === lastRun.run_id) return null;

  const onDismiss = () => {
    setDismissedFor(lastRun.run_id);
    setExpanded(false);
  };

  const onRunAgain = () => {
    if (!sessionId) return;
    setExpanded(false);
    runPflow.mutate(sessionId);
  };

  return (
    <div
      role="region"
      aria-label="Power flow convergence error"
      data-testid="convergence-error-panel"
      className={cn('border-warning/40 bg-warning/10 text-foreground', 'border-b', className)}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <p className="flex-1 text-sm">
          <span className="font-medium">PF did not converge</span>{' '}
          <span className="text-muted-foreground">
            in {lastRun.iterations} iteration{lastRun.iterations === 1 ? '' : 's'}.
          </span>
        </p>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
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
          aria-label="Dismiss convergence error"
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

      {expanded ? (
        <div
          data-testid="convergence-error-details"
          className={cn(
            'border-warning/30 bg-background/50 border-t',
            'flex flex-col gap-2 px-3 py-2',
          )}
        >
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground font-mono">iterations</dt>
            <dd className="text-foreground font-mono">{lastRun.iterations}</dd>
            <dt className="text-muted-foreground font-mono">last mismatch</dt>
            <dd className="text-foreground font-mono">
              {Number.isFinite(lastRun.mismatch) ? lastRun.mismatch.toExponential(3) : '—'}
            </dd>
            <dt className="text-muted-foreground font-mono">run_id</dt>
            <dd className="text-foreground truncate font-mono">{lastRun.run_id}</dd>
          </dl>
          <p className="text-muted-foreground text-xs leading-relaxed">
            The Newton-Raphson iteration did not reach the convergence threshold. Inspect bus
            voltages + adjust the case (slack bus, generator setpoints, line impedance) and retry.
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" size="sm" variant="outline" onClick={onDismiss}>
              Dismiss
            </Button>
            <Button
              type="button"
              size="sm"
              variant="primary"
              disabled={!sessionId || runPflow.isPending}
              onClick={onRunAgain}
            >
              {runPflow.isPending ? 'Running…' : 'Run again'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
