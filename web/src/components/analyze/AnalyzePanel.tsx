import { useEffect } from 'react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { TdsConfigPanel } from '@/components/tds/TdsConfigPanel';
import { AnalyzeSubModePicker } from './AnalyzeSubModePicker';
import { EIGScatter } from './EIGScatter';
import { EIGParticipationTable } from './EIGParticipationTable';
import { EIGDampingChart } from './EIGDampingChart';
import { useAnalyzeStore } from '@/store/analyze';
import { useEigRun } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { usePflowStore } from '@/store/pflow';
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
      </div>
    </section>
  );
}

function AnalyzePflowSubMode() {
  const lastRun = usePflowStore((s) => s.lastRun);
  return (
    <div
      data-testid="analyze-sub-mode-pflow-content"
      className="text-muted-foreground flex flex-col gap-2 p-3 text-xs"
    >
      <p>
        Power-flow results land in the Inspector and the bottom Results
        table. Use the top-bar Run button (PF mode) to refresh the PF
        solution.
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

function AnalyzeEigSubMode() {
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
  const isPrerequisite =
    eigError instanceof ProblemDetailsError && eigError.status === 409;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={!sessionId || eigRun.isPending}
          onClick={onRun}
          data-testid="analyze-run-eig"
        >
          {eigRun.isPending ? 'Running EIG…' : 'Run EIG'}
        </Button>
        {eigResult !== null && eigResult.tds_initialized ? (
          <span
            role="status"
            data-testid="eig-info-tds-initialized"
            className={cn(
              'border-warning/40 bg-warning/10 text-foreground',
              'rounded border px-2 py-1 text-[10px] leading-snug',
            )}
          >
            Running EIG initialised the dynamic state. Subsequent TDS or
            re-run PF will start from this initialised dae.
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
          className={cn(
            'border-destructive/40 bg-destructive/10 text-destructive',
            'rounded border p-3 text-xs',
          )}
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
