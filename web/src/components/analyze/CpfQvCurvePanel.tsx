import { useState } from 'react';
import { cn } from '@/lib/cn';
import { useCpfQvRun } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { useRunReadiness } from '@/lib/useRunReadiness';
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { BusIdxSelect } from '@/components/elements/BusIdxSelect';
import { CPFCurveChart } from './CPFCurveChart';
import { ProblemDetailsError } from '@/api/client';
import { ProblemDetailsErrorSurface } from '@/components/error/ProblemDetailsErrorSurface';
import type { RecoveryDescriptor } from '@/lib/recovery';
import type { CpfResult } from '@/api/types';

/**
 * CpfQvCurvePanel — the entirely-new CPF QV-curve UI (v3.1 Unit 13).
 *
 * Mounts as the ``qv`` sub-mode under the Analyze panel's CPF sub-tab.
 * Drives the EXISTING ``useCpfQvRun`` hook: the user picks a bus
 * (reusing ``BusIdxSelect``), clicks Run, and a single-bus QV-curve
 * (V vs reactive injection Q) renders via the shared ``CPFCurveChart``
 * (which already relabels its X-axis to "Q injection" when the result's
 * ``mode === 'qv'``).
 *
 * Error / recovery routing:
 *
 * - **409 prerequisite** (no converged PF) — renders the warning-toned
 *   recovery banner via ``<ProblemDetailsErrorSurface>`` carrying the
 *   substrate's ``run-pflow`` recovery descriptor (or a synthesised one
 *   during the staged rollout). The ``<RecoveryActionButton>`` routes
 *   the user back to the PF view.
 * - **generic 4xx / 5xx** — danger-toned banner with the ProblemDetails
 *   detail copy.
 *
 * The panel owns its own QV result locally rather than threading
 * through ``useAnalyzeStore.cpfResult`` so the nose-curve sub-mode and
 * the QV sub-mode don't clobber each other's last render when the user
 * switches between them. (``useCpfQvRun`` ALSO writes the shared store
 * + query cache as a side-effect — that's the hook's existing
 * behaviour — but this panel reads from its own mutation data so the
 * QV chart is stable regardless.)
 *
 * Test hooks:
 * - ``data-testid="cpf-qv-panel"`` outer section.
 * - ``data-testid="cpf-qv-bus-select"`` bus picker (BusIdxSelect's
 *   own ``bus-idx-select`` testid is also present).
 * - ``data-testid="cpf-qv-run"`` Run button.
 * - ``data-testid="cpf-qv-prerequisite-error"`` 409 recovery banner.
 * - ``data-testid="cpf-qv-error"`` generic error banner.
 * - the chart surfaces via ``CPFCurveChart``'s ``cpf-curve`` testid.
 */

export interface CpfQvCurvePanelProps {
  className?: string;
}

export function CpfQvCurvePanel({ className }: CpfQvCurvePanelProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const cpfQvRun = useCpfQvRun();
  const [busIdx, setBusIdx] = useState('');

  // The QV result is read off the mutation directly so switching CPF
  // sub-modes doesn't clobber the chart with the nose-curve result.
  const qvResult: CpfResult | null = cpfQvRun.data ?? null;

  // CPF (and its QV-curve mode) needs a converged operating point. Mirror
  // the EIG/CPF-nose/SE-Run pattern: gate on readiness and surface a
  // pre-click tooltip ("Run PFlow first…") instead of only a post-click 409.
  const readiness = useRunReadiness('cpf');

  const onRun = () => {
    if (!sessionId || busIdx === '' || !readiness.ready) return;
    cpfQvRun.mutate({ sessionId, busIdx });
  };

  const busMissing = busIdx === '';
  const runDisabled = !readiness.ready || busMissing || cpfQvRun.isPending;

  return (
    <section
      data-testid="cpf-qv-panel"
      aria-label="CPF QV-curve"
      className={cn('flex flex-col gap-3', className)}
    >
      <p className="text-muted-foreground text-xs leading-snug">
        Pick a bus and run a single-bus QV-curve continuation. The chart plots bus voltage against
        reactive injection (Q) to show the bus's reactive margin.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="cpf-qv-bus-select" className="text-muted-foreground text-xs font-medium">
            Bus
          </label>
          <BusIdxSelect
            id="cpf-qv-bus-select"
            value={busIdx}
            onChange={setBusIdx}
            className="min-w-[160px]"
          />
        </div>
        <CpfQvRunButton
          disabled={runDisabled}
          isPending={cpfQvRun.isPending}
          onClick={onRun}
          // Surface the PF-readiness reason on hover; the bus-not-picked
          // gate stays silent (an inline affordance, not an error).
          disabledReason={busMissing || cpfQvRun.isPending ? null : readiness.disabledReason}
        />
        {qvResult !== null ? (
          <span data-testid="cpf-qv-summary" className="text-muted-foreground text-[10px]">
            QV-curve — {qvResult.lambdas.length} steps; max Q = {qvResult.max_lam.toFixed(4)}
          </span>
        ) : null}
      </div>

      <CpfQvError error={cpfQvRun.error} />

      <CPFCurveChart result={qvResult} className="min-h-[300px] flex-shrink-0" />
    </section>
  );
}

/**
 * CpfQvRunButton — the Run button + its pre-click disabled-reason tooltip.
 * When ``disabledReason`` is set (PF not converged) the button is wrapped in
 * a Radix tooltip so hovering explains why it's disabled and how to fix it,
 * matching EIG/CPF-nose/SE-Run (AnalyzeRunButton). The bus-not-picked gate is
 * passed as a plain ``disabled`` with no reason (silent inline affordance).
 */
function CpfQvRunButton({
  disabled,
  isPending,
  onClick,
  disabledReason,
}: {
  disabled: boolean;
  isPending: boolean;
  onClick: () => void;
  disabledReason: string | null;
}) {
  const button = (
    <button
      type="button"
      data-testid="cpf-qv-run"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'bg-primary text-primary-foreground h-7 rounded px-3 text-xs font-medium',
        'hover:bg-primary/90 transition-colors',
        'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
      )}
    >
      {isPending ? 'Running QV…' : 'Run QV-curve'}
    </button>
  );

  if (disabledReason === null) return button;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-block">
            {button}
          </span>
        </TooltipTrigger>
        <TooltipPortal>
          <TooltipContent data-testid="cpf-qv-run-disabled-reason">{disabledReason}</TooltipContent>
        </TooltipPortal>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * CpfQvError — the QV-specific error surface. Mirrors the AnalyzePanel
 * ``AnalyzeRoutineError`` 409 → run-pflow recovery branch so a QV run
 * with no converged PF lands the user on the same "Open PF view" CTA.
 */
function CpfQvError({ error }: { error: Error | null }) {
  if (error === null) return null;

  const isPrerequisite = error instanceof ProblemDetailsError && error.status === 409;

  if (isPrerequisite) {
    const recovery: RecoveryDescriptor = error.recovery ?? {
      kind: 'run-pflow',
      label: 'Open PF view',
    };
    return (
      <ProblemDetailsErrorSurface
        variant="banner"
        tone="warning"
        testId="cpf-qv-prerequisite-error"
        hideRawDisclosure
        error={{
          title: error.detail ?? 'Run PFlow first.',
          recovery,
        }}
      />
    );
  }

  const detail =
    error instanceof ProblemDetailsError ? (error.detail ?? error.title) : error.message;
  const recovery = error instanceof ProblemDetailsError ? error.recovery : null;
  return (
    <ProblemDetailsErrorSurface
      variant="banner"
      tone="danger"
      testId="cpf-qv-error"
      hideRawDisclosure
      error={{ title: detail, recovery }}
    />
  );
}
