import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useRunPflow } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
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
 * - Success → toast "PF converged in N iterations." (auto-dismiss 4s).
 * - Error → routed to the surface owned by R8 (banner / overlay /
 *   modal). The button itself returns to enabled.
 *
 * The error surface routing is handled by the ConvergenceErrorPanel +
 * RuntimeCrashModal components, which subscribe to `pflow.error`. This
 * component owns only the trigger + the success toast.
 */

interface ToastProps {
  message: string;
  onDismiss: () => void;
}

function SuccessToast({ message, onDismiss }: ToastProps) {
  return (
    <div
      role="status"
      data-testid="pflow-success-toast"
      className={cn(
        'fixed top-14 right-4 z-50 max-w-xs',
        'border-success/30 bg-success/10 text-foreground',
        'rounded-[var(--radius-md)] border px-3 py-2 shadow-md',
        'flex items-center gap-3 text-sm',
      )}
    >
      <span className="truncate">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className={cn(
          'text-muted-foreground hover:text-foreground',
          'inline-flex h-5 w-5 items-center justify-center rounded',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        )}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="10"
          height="10"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M4 4 L12 12 M12 4 L4 12" />
        </svg>
      </button>
    </div>
  );
}

export interface RunButtonProps {
  className?: string;
}

export function RunButton({ className }: RunButtonProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const selection = useCaseStore((s) => s.selection);
  const isRunning = usePflowStore((s) => s.isRunning);
  const runPflow = useRunPflow();

  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Auto-dismiss the success toast after 4s — matches the matrix.
  useEffect(() => {
    if (toastMessage === null) return;
    const id = setTimeout(() => setToastMessage(null), 4000);
    return () => clearTimeout(id);
  }, [toastMessage]);

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
          setToastMessage(`PF converged in ${data.iterations} iterations.`);
        } else {
          // Non-convergence is a 200 with converged=false.
          // ConvergenceErrorPanel reads from pflow.lastRun and surfaces.
          // Don't toast — the panel is the surface.
          setToastMessage(null);
        }
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

  return (
    <>
      {disabledReason ? (
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
      ) : (
        button
      )}
      {toastMessage !== null ? (
        <SuccessToast message={toastMessage} onDismiss={() => setToastMessage(null)} />
      ) : null}
    </>
  );
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
