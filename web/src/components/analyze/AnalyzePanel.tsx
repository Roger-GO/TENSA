import { useEffect } from 'react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { TdsConfigPanel } from '@/components/tds/TdsConfigPanel';
import { AnalyzeSubModePicker } from './AnalyzeSubModePicker';
import { CPFCurveChart } from './CPFCurveChart';
import { EIGScatter } from './EIGScatter';
import { EIGParticipationTable } from './EIGParticipationTable';
import { EIGDampingChart } from './EIGDampingChart';
import { SEResidualChart } from './SEResidualChart';
import { useAnalyzeStore } from '@/store/analyze';
import { useCpfRun, useEigRun, useSeGenerateMeasurements, useSeRun } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { usePflowStore } from '@/store/pflow';
import { useRunReadiness, type RunRoutine } from '@/lib/useRunReadiness';
import { ProblemDetailsError } from '@/api/client';

/**
 * AnalyzePanel — Unit 6's new right-dock tab. Hosts a sub-mode picker
 * (PF / TDS / EIG) plus the per-routine result view (per KTD-6).
 *
 * Sub-mode views:
 *
 * - ``pflow`` — placeholder note pointing the user at the existing
 *   results table / Inspector for PF results (the existing v0.1
 *   results panel surface is unchanged).
 * - ``tds`` — wraps the existing ``TdsConfigPanel`` so the TDS
 *   config form (tf, h, vars, max_rate_hz) lives inside Analyze. The
 *   ``tds-config`` right-dock tab was retired in favour of this
 *   nested home (per KTD-6).
 * - ``eig`` — Run-EIG button + three result views stacked
 *   vertically: ``EIGScatter`` (real / imag), ``EIGParticipationTable``
 *   (per selected mode), ``EIGDampingChart`` (per-mode bars). Linked
 *   selection: scatter / chart click → table populates + bar
 *   highlights.
 *
 * EIG run gating: per the plan, Analyze does NOT auto-run EIG when
 * the user opens the tab — the user must click "Run EIG". This is
 * because ``EIG.run()`` mutates dae state (sets
 * ``TDS.initialized=True``, advances ``dae.t`` to 0); the plan
 * resolves this as "accept and document" via an info banner that
 * appears after the run.
 */

export interface AnalyzePanelProps {
  className?: string;
}

export function AnalyzePanel({ className }: AnalyzePanelProps) {
  const subMode = useAnalyzeStore((s) => s.subMode);

  return (
    <section
      data-testid="analyze-panel"
      aria-label="Analyze panel"
      className={cn('flex h-full min-h-0 flex-col', className)}
    >
      <header className="border-border flex items-center justify-between border-b p-2">
        <h2 className="text-foreground text-sm font-semibold">Analyze</h2>
        <AnalyzeSubModePicker />
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {subMode === 'pflow' ? <AnalyzePflowSubMode /> : null}
        {subMode === 'tds' ? <TdsConfigPanel /> : null}
        {subMode === 'eig' ? <AnalyzeEigSubMode /> : null}
        {subMode === 'cpf' ? <AnalyzeCpfSubMode /> : null}
        {subMode === 'se' ? <AnalyzeSeSubMode /> : null}
      </div>
    </section>
  );
}

/**
 * AnalyzeRunButton — small wrapper around the per-routine run button so
 * EIG / CPF / SE share the same "Run-readiness hook + tooltip on
 * disabled" surface. Each sub-mode passes its own label, mutation
 * pending state, click handler, and routine id; the wrapper handles
 * the disabled merge (readiness + pending) and the tooltip wrap.
 *
 * Plan-divergence: the AnalyzePanel sub-modes already render a 409
 * prerequisite-error banner with an "Open PF view" CTA after a failed
 * click. The Run-readiness hook now gates the click *proactively* —
 * the user sees the same "Run PFlow first" reason on hover before they
 * click. The post-click 409 banner stays in place as a fallback for
 * the case where the substrate disagrees with the client's view of
 * readiness (e.g., the PF result we trust was actually invalidated
 * server-side).
 */
function AnalyzeRunButton({
  routine,
  label,
  pendingLabel,
  isPending,
  onClick,
  testId,
  disabledOverride,
}: {
  routine: RunRoutine;
  label: string;
  pendingLabel: string;
  isPending: boolean;
  onClick: () => void;
  testId: string;
  /**
   * Sub-mode-specific extra disabled gate. SE for example also gates
   * "Run SE" on a measurement count — the readiness hook covers that
   * case too, but Generate Measurements has its own readiness gate.
   * Passing ``true`` here disables the button without surfacing a
   * tooltip (the sub-mode keeps its existing inline UI for the
   * specific gate).
   */
  disabledOverride?: boolean;
}) {
  const readiness = useRunReadiness(routine);
  const disabled = !readiness.ready || isPending || disabledOverride === true;

  const button = (
    <Button
      type="button"
      variant="primary"
      size="sm"
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
    >
      {isPending ? pendingLabel : label}
    </Button>
  );

  if (readiness.disabledReason !== null && !isPending) {
    return (
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="inline-block">
              {button}
            </span>
          </TooltipTrigger>
          <TooltipPortal>
            <TooltipContent data-testid={`${testId}-disabled-reason`}>
              {readiness.disabledReason}
            </TooltipContent>
          </TooltipPortal>
        </Tooltip>
      </TooltipProvider>
    );
  }
  return button;
}

function AnalyzePflowSubMode() {
  const lastRun = usePflowStore((s) => s.lastRun);
  return (
    <div
      data-testid="analyze-sub-mode-pflow-content"
      className="text-muted-foreground flex flex-col gap-2 p-3 text-xs"
    >
      <p>
        Power-flow results land in the Inspector and the bottom Results table. Use the top-bar Run
        button (PF mode) to refresh the PF solution.
      </p>
      {lastRun !== null ? (
        <div className="border-border bg-muted/20 rounded border p-2 font-mono">
          <div>converged: {String(lastRun.converged)}</div>
          <div>iterations: {lastRun.iterations}</div>
          <div>mismatch: {lastRun.mismatch.toExponential(3)}</div>
        </div>
      ) : (
        <p className="italic">No PF result yet on this session.</p>
      )}
    </div>
  );
}

export function AnalyzeEigSubMode() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const lastPf = usePflowStore((s) => s.lastRun);
  const eigResult = useAnalyzeStore((s) => s.eigResult);
  const setSubMode = useAnalyzeStore((s) => s.setSubMode);
  const eigRun = useEigRun();

  // When the case changes (PF cleared on case-load via cross-slice
  // cascade), drop the stale EIG result so the empty-state shows.
  useEffect(() => {
    if (lastPf === null && eigResult !== null) {
      useAnalyzeStore.getState().clearEigResult();
    }
  }, [lastPf, eigResult]);

  const onRun = () => {
    if (!sessionId) return;
    eigRun.mutate(sessionId);
  };

  const eigError = eigRun.error;
  const isPrerequisite = eigError instanceof ProblemDetailsError && eigError.status === 409;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2">
        <AnalyzeRunButton
          routine="eig"
          label="Run EIG"
          pendingLabel="Running EIG…"
          isPending={eigRun.isPending}
          onClick={onRun}
          testId="analyze-run-eig"
        />
        {eigResult !== null && eigResult.tds_initialized ? (
          <span
            role="status"
            data-testid="eig-info-tds-initialized"
            className={cn(
              'border-warning/40 bg-warning/10 text-foreground',
              'rounded border px-2 py-1 text-[10px] leading-snug',
            )}
          >
            Running EIG initialised the dynamic state. Subsequent TDS or re-run PF will start from
            this initialised dae.
          </span>
        ) : null}
      </div>

      {isPrerequisite ? (
        <div
          role="alert"
          data-testid="eig-prerequisite-error"
          className={cn(
            'border-warning/40 bg-warning/10 text-foreground',
            'flex flex-col gap-2 rounded border p-3 text-xs',
          )}
        >
          <span>{eigError.detail ?? 'Run PFlow first.'}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="eig-prerequisite-cta"
            onClick={() => setSubMode('pflow')}
          >
            Open PF view
          </Button>
        </div>
      ) : null}

      {eigError !== null && !isPrerequisite ? (
        <div
          role="alert"
          className={cn('border-danger/40 bg-danger/10 text-danger', 'rounded border p-3 text-xs')}
        >
          {eigError instanceof ProblemDetailsError
            ? (eigError.detail ?? eigError.title)
            : eigError.message}
        </div>
      ) : null}

      <EIGScatter className="min-h-[260px] flex-shrink-0" />
      <EIGParticipationTable className="min-h-[140px] flex-shrink-0" />
      <EIGDampingChart className="min-h-[140px] flex-shrink-0" />
    </div>
  );
}

export function AnalyzeCpfSubMode() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const lastPf = usePflowStore((s) => s.lastRun);
  const cpfResult = useAnalyzeStore((s) => s.cpfResult);
  const setSubMode = useAnalyzeStore((s) => s.setSubMode);
  const cpfRun = useCpfRun();

  // When PF clears (case change cascade), drop the stale CPF result so
  // the empty-state shows.
  useEffect(() => {
    if (lastPf === null && cpfResult !== null) {
      useAnalyzeStore.getState().clearCpfResult();
    }
  }, [lastPf, cpfResult]);

  const onRun = () => {
    if (!sessionId) return;
    cpfRun.mutate({ sessionId, direction: 'load' });
  };

  const cpfError = cpfRun.error;
  const isPrerequisite = cpfError instanceof ProblemDetailsError && cpfError.status === 409;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2">
        <AnalyzeRunButton
          routine="cpf"
          label="Run CPF"
          pendingLabel="Running CPF…"
          isPending={cpfRun.isPending}
          onClick={onRun}
          testId="analyze-run-cpf"
        />
        {cpfResult !== null ? (
          <span data-testid="cpf-summary" className="text-muted-foreground text-[10px]">
            {cpfResult.mode === 'qv' ? 'QV-curve' : 'PV-curve'} — {cpfResult.lambdas.length} steps;
            max {cpfResult.mode === 'qv' ? 'Q' : 'lambda'} = {cpfResult.max_lam.toFixed(4)}
          </span>
        ) : null}
      </div>

      {isPrerequisite ? (
        <div
          role="alert"
          data-testid="cpf-prerequisite-error"
          className={cn(
            'border-warning/40 bg-warning/10 text-foreground',
            'flex flex-col gap-2 rounded border p-3 text-xs',
          )}
        >
          <span>{cpfError.detail ?? 'Run PFlow first.'}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="cpf-prerequisite-cta"
            onClick={() => setSubMode('pflow')}
          >
            Open PF view
          </Button>
        </div>
      ) : null}

      {cpfError !== null && !isPrerequisite ? (
        <div
          role="alert"
          className={cn('border-danger/40 bg-danger/10 text-danger', 'rounded border p-3 text-xs')}
        >
          {cpfError instanceof ProblemDetailsError
            ? (cpfError.detail ?? cpfError.title)
            : cpfError.message}
        </div>
      ) : null}

      <CPFCurveChart className="min-h-[300px] flex-shrink-0" />
    </div>
  );
}

/**
 * AnalyzeSeSubMode — two-step SE workflow (Unit 13):
 *
 * 1. **Generate Measurements** button — calls
 *    ``POST /se/measurements/generate`` to build the default measurement
 *    set from the converged PF solution. On success, the measurement
 *    count is shown and the "Run SE" button becomes enabled.
 * 2. **Run SE** button — calls ``POST /se`` to run WLS Gauss-Newton
 *    against the cached measurement set. On success the residual
 *    histogram renders.
 *
 * The two-step split surfaces the measurement count to the user before
 * committing to the SE iteration cost (and lets them re-run SE without
 * regenerating noise — useful when comparing algorithms in a follow-up
 * unit). Both buttons are disabled until PFlow has converged; if
 * either call returns 409 the user is shown a CTA back to the PF view.
 *
 * Cleanup: when the case changes (PF cleared by the cross-slice
 * cascade), drop any stale SE result + measurement count so the empty
 * state shows on first paint.
 */
export function AnalyzeSeSubMode() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const lastPf = usePflowStore((s) => s.lastRun);
  const seResult = useAnalyzeStore((s) => s.seResult);
  const seMeasurementsCount = useAnalyzeStore((s) => s.seMeasurementsCount);
  const setSubMode = useAnalyzeStore((s) => s.setSubMode);
  const seGenerate = useSeGenerateMeasurements();
  const seRun = useSeRun();

  // Cross-slice cascade cleanup — same shape as the EIG / CPF panels.
  useEffect(() => {
    if (lastPf === null && (seResult !== null || seMeasurementsCount !== null)) {
      useAnalyzeStore.getState().clearSeResult();
    }
  }, [lastPf, seResult, seMeasurementsCount]);

  const onGenerate = () => {
    if (!sessionId) return;
    seGenerate.mutate({ sessionId });
  };
  const onRun = () => {
    if (!sessionId) return;
    seRun.mutate(sessionId);
  };

  // The currently-active error (generate has priority — if it failed,
  // the run button is disabled and the error came from generate).
  const activeError = seGenerate.error ?? seRun.error;
  const isPrerequisite = activeError instanceof ProblemDetailsError && activeError.status === 409;

  const canGenerate = sessionId !== null && !seGenerate.isPending;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canGenerate}
          onClick={onGenerate}
          data-testid="analyze-se-generate-measurements"
        >
          {seGenerate.isPending
            ? 'Generating…'
            : seMeasurementsCount !== null
              ? 'Re-generate Measurements'
              : 'Generate Measurements'}
        </Button>
        <AnalyzeRunButton
          routine="se"
          label="Run SE"
          pendingLabel="Running SE…"
          isPending={seRun.isPending}
          onClick={onRun}
          testId="analyze-se-run"
        />
        {seMeasurementsCount !== null ? (
          <span data-testid="se-measurements-count" className="text-muted-foreground text-[10px]">
            {seMeasurementsCount} measurements ready
          </span>
        ) : null}
      </div>

      {isPrerequisite ? (
        <div
          role="alert"
          data-testid="se-prerequisite-error"
          className={cn(
            'border-warning/40 bg-warning/10 text-foreground',
            'flex flex-col gap-2 rounded border p-3 text-xs',
          )}
        >
          <span>
            {activeError instanceof ProblemDetailsError
              ? (activeError.detail ?? 'Run PFlow first.')
              : 'Run PFlow first.'}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="se-prerequisite-cta"
            onClick={() => setSubMode('pflow')}
          >
            Open PF view
          </Button>
        </div>
      ) : null}

      {activeError !== null && !isPrerequisite ? (
        <div
          role="alert"
          className={cn('border-danger/40 bg-danger/10 text-danger', 'rounded border p-3 text-xs')}
        >
          {activeError instanceof ProblemDetailsError
            ? (activeError.detail ?? activeError.title)
            : activeError.message}
        </div>
      ) : null}

      <SEResidualChart className="min-h-[260px] flex-shrink-0" />
    </div>
  );
}
