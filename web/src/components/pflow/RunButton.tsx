import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useReloadCase, useRunPflow } from '@/api/queries';
import { ProblemDetailsError } from '@/api/client';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/cn';

/**
 * RunButton. Top-bar primary action. Click → `useRunPflow().mutate()`.
 *
 * State machine (per the interaction-states matrix "Run controls" cell):
 *
 * - Idle (no case loaded) → button disabled with tooltip "Load a case
 *   first." (R20: tooltip explains the disabled cause; mirrors CaseNav).
 * - Idle (case loaded) → enabled, primary style.
 * - Running → spinner + "Running PF…" + disabled.
 * - Success → toast "PF converged in N iterations." (auto-dismiss 4s
 *   — sonner default). Lives on the global toast surface (Unit 3 of
 *   the v2.0 polish plan), so the toast survives this component's
 *   unmount.
 * - Error (5xx) → routed to RuntimeCrashModal via `pflow.error`. The
 *   button itself returns to enabled.
 * - Error (4xx) → toast.error with a Reload-and-retry action when the
 *   substrate's detail hints at a System-state recovery path.
 */

export interface RunButtonProps {
  className?: string;
}

export function RunButton({ className }: RunButtonProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const selection = useCaseStore((s) => s.selection);
  const isRunning = usePflowStore((s) => s.isRunning);
  const runPflow = useRunPflow();
  const reloadCase = useReloadCase();

  const disabled = !selection || !sessionId || isRunning;
  const disabledReason = !selection
    ? 'Load a case first.'
    : !sessionId
      ? 'Connecting to substrate…'
      : null;

  const onClick = () => {
    if (!sessionId) return;
    runPflow.mutate(sessionId, {
      onSuccess: (data) => {
        if (data.converged) {
          toast.success(`PF converged in ${data.iterations} iterations.`);
        }
        // Non-convergence is a 200 with converged=false. The
        // ConvergenceErrorPanel subscribes to `pflow.lastRun` and
        // surfaces it inline — no toast.
      },
      onError: (err) => {
        // 4xx errors aren't picked up by RuntimeCrashModal (it gates on
        // ServerError = 5xx) or ConvergenceErrorPanel (it gates on
        // lastRun). Surface them as a global toast so the user knows
        // the request returned a real error rather than silently doing
        // nothing.
        if (err instanceof ProblemDetailsError) {
          const detail = err.detail ?? err.title ?? `HTTP ${err.status}`;
          // Substrate's pflow handler returns a "call /reload to
          // recover" hint when the System is in a bad state after a
          // failed setup(). Surface that as a Reload-and-retry action.
          const recoverViaReload = /reload/i.test(detail);
          if (recoverViaReload) {
            toast.error('Run PF failed', {
              description: detail,
              action: { label: 'Reload case + retry', onClick: onReloadAndRetry },
            });
          } else {
            toast.error('Run PF failed', { description: detail });
          }
        } else {
          toast.error('Run PF failed', {
            description: err.message ?? 'Run PF failed',
          });
        }
      },
    });
  };

  const onReloadAndRetry = () => {
    if (!sessionId) return;
    reloadCase.mutate(sessionId, {
      onSuccess: () => {
        // Auto-retry PF after a successful reload — that's why the user
        // clicked Reload-and-retry.
        runPflow.mutate(sessionId, {
          onSuccess: (data) => {
            if (data.converged) {
              toast.success(`PF converged in ${data.iterations} iterations.`);
            }
          },
          onError: (err) => {
            const detail =
              err instanceof ProblemDetailsError
                ? (err.detail ?? err.title ?? `HTTP ${err.status}`)
                : (err.message ?? 'Run PF failed');
            toast.error('Run PF failed', { description: detail });
          },
        });
      },
      onError: (err) => {
        const detail =
          err instanceof ProblemDetailsError
            ? (err.detail ?? err.title ?? `HTTP ${err.status}`)
            : (err.message ?? 'Reload failed');
        toast.error('Reload failed', { description: detail });
      },
    });
  };

  const button = (
    <Button
      type="button"
      variant="primary"
      size="md"
      disabled={disabled}
      onClick={onClick}
      data-testid="run-pflow-button"
      aria-describedby={disabledReason ? 'run-pf-disabled-reason' : undefined}
      className={cn('min-w-[120px]', className)}
    >
      {isRunning ? (
        <>
          <Spinner />
          <span>Running PF…</span>
        </>
      ) : (
        <span>Run PF</span>
      )}
    </Button>
  );

  if (disabledReason) {
    return (
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            {/* Wrap the disabled button in a span so the tooltip trigger
                still fires on hover/focus (disabled buttons swallow
                pointer events). */}
            <span tabIndex={0} className="inline-block">
              {button}
            </span>
          </TooltipTrigger>
          <TooltipPortal>
            <TooltipContent id="run-pf-disabled-reason">{disabledReason}</TooltipContent>
          </TooltipPortal>
        </Tooltip>
      </TooltipProvider>
    );
  }
  return button;
}

function Spinner() {
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
      className="animate-spin"
    >
      <path d="M8 1.5 A6.5 6.5 0 1 1 1.5 8" />
    </svg>
  );
}
