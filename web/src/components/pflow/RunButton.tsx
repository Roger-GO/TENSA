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
import { usePflowStore } from '@/store/pflow';
import { useRunReadiness } from '@/lib/useRunReadiness';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/cn';

/**
 * RunButton. Top-bar primary action. Click → `useRunPflow().mutate()`.
 *
 * State machine (per the interaction-states matrix "Run controls" cell):
 *
 * - Idle (no case loaded) → button disabled with tooltip "No case
 *   loaded." (R20: tooltip explains the disabled cause; mirrors CaseNav).
 * - Idle (case loaded) → enabled, primary style.
 * - EIG-mutated dae → button disabled with tooltip "EIG initialised the
 *   dynamic state; reload case to re-run PF." + an inline "Reload case"
 *   recovery button. Reading the disabled-state contract from a single
 *   hook (`useRunReadiness`) so the same reasons surface across every
 *   Run button (Unit 4 of the v2.0 polish plan).
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
  const isRunning = usePflowStore((s) => s.isRunning);
  const runPflow = useRunPflow();
  const reloadCase = useReloadCase();
  const readiness = useRunReadiness('pflow');

  // The hook's ``disabledReason`` is the canonical "why" text. The
  // ``isRunning`` flag is an in-flight gate that the hook deliberately
  // doesn't track (it's a transient UI state, not a prerequisite). We
  // OR the two so the button is disabled while a run is in progress
  // OR while the hook reports a prerequisite gap.
  const disabled = !readiness.ready || isRunning;
  const disabledReason = readiness.disabledReason;

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

  /**
   * Inline recovery CTA. The hook surfaces a single recovery descriptor
   * per disabled state; we render it as a small button next to the
   * tooltip-wrapped Run button. Today the only kind we render here is
   * ``"reload-case"`` (the EIG-mutated-dae path); the ``"open-pf"``
   * recovery is owned by the Analyze panel where the affected button
   * lives, not by the top-bar PF button itself.
   */
  const onRecoveryClick = () => {
    if (readiness.recovery?.kind === 'reload-case') {
      onReloadAndRetry();
    }
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

  // When the hook surfaces a reload-case recovery, render an inline
  // button next to the disabled Run button so the user has the recovery
  // affordance on the same surface (R20 of the plan: every disabled
  // control with a recovery shows the recovery inline, not behind a
  // toast that may have already auto-dismissed).
  const inlineRecovery =
    readiness.recovery?.kind === 'reload-case' ? (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onRecoveryClick}
        disabled={reloadCase.isPending}
        data-testid="run-pflow-recovery-reload"
      >
        {reloadCase.isPending ? 'Reloading…' : readiness.recovery.label}
      </Button>
    ) : null;

  if (disabledReason) {
    return (
      <div className="flex items-center gap-2">
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
        {inlineRecovery}
      </div>
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
