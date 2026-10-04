import { useState } from 'react';
import { useSessionStore } from '@/store/session';
import { usePflowStore } from '@/store/pflow';
import { usePflowOptionsStore } from '@/store/pflowOptions';
import { useRunPflow } from '@/api/queries';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { describeSettings, pflowRetries, settingsOrAssumed } from '@/lib/pflowOptions';
import { openPflowPanel } from '@/lib/openPflowPanel';
import { usePflowRunAction } from '@/lib/usePflowRunAction';
import { ProblemDetailsErrorSurface } from '@/components/error/ProblemDetailsErrorSurface';
import { pflowConvergenceDetail } from '@/components/error/routineErrorDetails';
import { PflowConvergenceExtras } from '@/components/error/routineErrorExtras';
import type { RecoveryDescriptor } from '@/lib/recovery';

/**
 * ConvergenceErrorPanel. Surfaces PF non-convergence per R8 — now a THIN
 * WRAPPER around the single `<ProblemDetailsErrorSurface>` primitive
 * (v3.1 Unit 9 migration).
 *
 * The bespoke banner + slide-out is reproduced by the primitive's `banner`
 * variant:
 *
 * - `tone="warning"` keeps the warning chrome (non-convergence is a
 *   recoverable numerical outcome, not a server fault).
 * - `extras` carries the routine detail grid (iterations / last mismatch /
 *   run_id) via `PflowConvergenceExtras`, behind the bespoke "View details ▸"
 *   toggle (`extrasCollapsible`).
 * - the "Run again" CTA is a `recovery.kind: 'retry'` descriptor whose
 *   `onRetry` re-fires the PF mutation for the current session.
 * - the footer also offers the adjusted retries worth trying for how this run
 *   ended (more iterations, a flat start, a looser tolerance, Q limits off;
 *   see `pflowRetries`). A retry writes its change into the power-flow options,
 *   which the next run, and the PF tab, then show, and runs. "Adjust options"
 *   opens that tab.
 *
 * NOT a modal. NOT a takeover. Inspector + results table stay visible
 * underneath. The banner persists until the user dismisses it or a new PF
 * run replaces `lastRun` (per-run dismiss, keyed on `run_id`).
 */

interface ConvergencePanelProps {
  className?: string;
}

export function ConvergenceErrorPanel({ className }: ConvergencePanelProps) {
  const lastRun = usePflowStore((s) => s.lastRun);
  const sessionId = useSessionStore((s) => s.sessionId);
  const runPflow = useRunPflow();
  const runAndSay = usePflowRunAction();
  const options = usePflowOptionsStore((s) => s.options);

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
  };

  const onRunAgain = () => {
    if (!sessionId || runPflow.isPending) return;
    runAndSay();
  };

  // What the run used, from the server; a server that does not say is taken at
  // the options form's word. The retries follow from it and from how it ended.
  const settings = settingsOrAssumed(lastRun.settings, options);
  const retries = pflowRetries({
    iterations: lastRun.iterations,
    mismatch: lastRun.mismatch,
    settings,
  });

  const onRetry = (changes: (typeof retries)[number]['changes']) => {
    if (!sessionId || runPflow.isPending) return;
    usePflowOptionsStore.getState().setOptions(changes);
    runAndSay();
  };

  // "Run again" → retry: re-fire the PF mutation. The original PF run's
  // request_summary is captured by Unit 6's job store; here the variable is
  // simply the session id (PF takes an empty body).
  const recovery: RecoveryDescriptor = {
    kind: 'retry',
    label: runPflow.isPending ? 'Running…' : 'Run again',
  };

  return (
    <div
      role="region"
      aria-label="Power flow convergence error"
      // The overlay slot spans the whole window, so the banner sits as a card at the
      // top of it: opaque, so the sidebar and canvas under it do not show through the
      // warning tint, and no wider than its buttons need.
      className={cn(
        'pointer-events-auto mx-auto mt-2 max-w-3xl rounded-[var(--radius-md)] shadow-lg',
        'bg-background',
        className,
      )}
    >
      <ProblemDetailsErrorSurface
        variant="banner"
        tone="warning"
        testId="convergence-error-panel"
        dismissLabel="Dismiss convergence error"
        error={{
          title: 'PF did not converge',
          detail: pflowConvergenceDetail(lastRun.iterations),
          recovery,
        }}
        extras={
          <PflowConvergenceExtras
            hasRetries={retries.length > 0}
            data={{
              iterations: lastRun.iterations,
              mismatch: lastRun.mismatch,
              runId: lastRun.run_id,
              ...(lastRun.settings ? { settings: describeSettings(lastRun.settings) } : {}),
            }}
          />
        }
        extrasCollapsible
        hideRawDisclosure
        actions={
          <>
            {retries.map((retry) => (
              <Button
                key={retry.id}
                type="button"
                variant="outline"
                size="sm"
                title={retry.hint}
                disabled={runPflow.isPending}
                onClick={() => onRetry(retry.changes)}
                data-testid={`convergence-retry-${retry.id}`}
              >
                {retry.label}
              </Button>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={openPflowPanel}
              data-testid="convergence-adjust-options"
            >
              Adjust options
            </Button>
          </>
        }
        onDismiss={onDismiss}
        onRetry={onRunAgain}
      />
    </div>
  );
}
