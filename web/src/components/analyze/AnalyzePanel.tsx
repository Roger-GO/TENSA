import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/Input';
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
import { CpfConfigPanel } from './CpfConfigPanel';
import { CpfQvCurvePanel } from './CpfQvCurvePanel';
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
import { ProblemDetailsErrorSurface } from '@/components/error/ProblemDetailsErrorSurface';
import type { RecoveryDescriptor } from '@/lib/recovery';

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

/**
 * AnalyzeRoutineError — the per-routine error surface for EIG / CPF / SE,
 * migrated onto the single ``<ProblemDetailsErrorSurface>`` primitive
 * (v3.1 Unit 9). Replaces the three bespoke inline ``role="alert"`` banners.
 *
 * Branch → recovery mapping:
 *
 * - **409 prerequisite** (the routine needs a converged operating point):
 *   warning-toned banner + a ``run-pflow`` recovery (label "Open PF view")
 *   whose ``<RecoveryActionButton>`` routes the user to the PF run mode +
 *   Analyze PF sub-mode. The substrate's own ``recovery`` descriptor is used
 *   when present; otherwise we synthesise the canonical ``run-pflow`` CTA so
 *   the affordance is preserved during the staged rollout.
 * - **generic 4xx / 5xx**: danger-toned banner carrying whatever ``recovery``
 *   the substrate attached (``null`` → dismiss-only, per the staged-rollout
 *   fallback). The detail is the ProblemDetails ``detail`` (falling back to
 *   ``title`` / ``message``), preserving the bespoke copy.
 *
 * ``error`` is the live mutation error (a ``ProblemDetailsError`` or a plain
 * ``Error``). ``null`` renders nothing.
 */
function AnalyzeRoutineError({ routine, error }: { routine: RunRoutine; error: Error | null }) {
  if (error === null) return null;

  const isPrerequisite = error instanceof ProblemDetailsError && error.status === 409;

  if (isPrerequisite) {
    // Prefer the substrate's typed recovery; otherwise synthesise the
    // canonical run-pflow CTA so the "Open PF view" affordance survives the
    // staged rollout (legacy 409s with no recovery field).
    const recovery: RecoveryDescriptor = error.recovery ?? {
      kind: 'run-pflow',
      label: 'Open PF view',
    };
    return (
      <ProblemDetailsErrorSurface
        variant="banner"
        tone="warning"
        testId={`${routine}-prerequisite-error`}
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
      testId={`${routine}-error`}
      hideRawDisclosure
      error={{ title: detail, recovery }}
    />
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

      <AnalyzeRoutineError routine="eig" error={eigError} />

      <EIGScatter className="min-h-[260px] flex-shrink-0" />
      <EIGParticipationTable className="min-h-[140px] flex-shrink-0" />
      <EIGDampingChart className="min-h-[140px] flex-shrink-0" />
    </div>
  );
}

/**
 * AnalyzeCpfSubMode — CPF home (Unit 12, extended Unit 13).
 *
 * Hosts a ``nose`` / ``qv`` sub-mode strip. ``nose`` is the full
 * PV-curve sweep driven by ``CpfConfigPanel`` (direction load|gen +
 * step + max_iter behind an Advanced disclosure); ``qv`` is the
 * single-bus QV-curve driven by ``CpfQvCurvePanel`` (bus picker + Run).
 * The strip + both flows live under one Analyze ``cpf`` sub-tab so all
 * three CPF endpoint variants (load nose, gen nose, QV) are reachable
 * from the GUI.
 */
export function AnalyzeCpfSubMode() {
  const activeCpfSubMode = useAnalyzeStore((s) => s.activeCpfSubMode);

  return (
    <div className="flex flex-col gap-3 p-3">
      <CpfSubModePicker />
      {activeCpfSubMode === 'nose' ? <AnalyzeCpfNoseSubMode /> : <CpfQvCurvePanel />}
    </div>
  );
}

/**
 * CpfSubModePicker — segmented control swapping the CPF nose / QV flow
 * (Unit 13). Mirrors the AnalyzeSubModePicker visual.
 */
function CpfSubModePicker() {
  const activeCpfSubMode = useAnalyzeStore((s) => s.activeCpfSubMode);
  const setActiveCpfSubMode = useAnalyzeStore((s) => s.setActiveCpfSubMode);
  const options: ReadonlyArray<{ value: 'nose' | 'qv'; label: string; hint: string }> = [
    { value: 'nose', label: 'Nose curve', hint: 'PV-curve sweep (load or generation direction)' },
    { value: 'qv', label: 'QV curve', hint: 'Single-bus reactive-margin curve' },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="CPF sub-mode"
      data-testid="cpf-sub-mode-picker"
      className={cn(
        'inline-flex self-start overflow-hidden rounded-[var(--radius-md)]',
        'border-border border text-xs',
      )}
    >
      {options.map((opt, idx) => {
        const isActive = activeCpfSubMode === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            data-testid={`cpf-sub-mode-${opt.value}`}
            title={opt.hint}
            onClick={() => setActiveCpfSubMode(opt.value)}
            className={cn(
              'px-3 py-1 transition-colors',
              idx > 0 && 'border-border border-l',
              isActive
                ? 'bg-primary/15 text-foreground'
                : 'text-muted-foreground hover:text-foreground',
              'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * AnalyzeCpfNoseSubMode — the full PV-curve / nose-curve flow. Wires
 * ``CpfConfigPanel`` (direction + step + max_iter) into ``useCpfRun``,
 * wrapping the panel's Run button in the readiness-tooltip
 * ``AnalyzeRunButton`` via the panel's ``renderRunButton`` prop.
 */
export function AnalyzeCpfNoseSubMode() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const lastPf = usePflowStore((s) => s.lastRun);
  const cpfResult = useAnalyzeStore((s) => s.cpfResult);
  const cpfRun = useCpfRun();

  // When PF clears (case change cascade), drop the stale CPF result so
  // the empty-state shows.
  useEffect(() => {
    if (lastPf === null && cpfResult !== null) {
      useAnalyzeStore.getState().clearCpfResult();
    }
  }, [lastPf, cpfResult]);

  const cpfError = cpfRun.error;

  return (
    <div className="flex flex-col gap-3">
      <CpfConfigPanel
        runLabel={cpfRun.isPending ? 'Running CPF…' : 'Run CPF'}
        runButtonTestId="analyze-run-cpf"
        renderRunButton={({ onClick, disabled }) => (
          <AnalyzeRunButton
            routine="cpf"
            label="Run CPF"
            pendingLabel="Running CPF…"
            isPending={cpfRun.isPending}
            onClick={onClick}
            testId="analyze-run-cpf"
            disabledOverride={disabled}
          />
        )}
        onRun={({ direction, step, maxIter }) => {
          if (!sessionId) return;
          cpfRun.mutate({ sessionId, direction, step, maxIter });
        }}
      />

      {cpfResult !== null ? (
        <span data-testid="cpf-summary" className="text-muted-foreground text-[10px]">
          {cpfResult.mode === 'qv' ? 'QV-curve' : 'PV-curve'} — {cpfResult.lambdas.length} steps; max{' '}
          {cpfResult.mode === 'qv' ? 'Q' : 'lambda'} = {cpfResult.max_lam.toFixed(4)}
        </span>
      ) : null}

      <AnalyzeRoutineError routine="cpf" error={cpfError} />

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
/**
 * Validate the optional SE ``noise_seed`` text input. The substrate
 * draws the measurement noise from a seeded RNG and requires an integer
 * seed; the GUI exposes it as an optional override (blank → the
 * substrate picks its own seed). Returns ``null`` when valid (blank or a
 * parseable integer) or a form-level error string otherwise. Behaviour
 * is covered through the AnalyzePanel SE-sub-mode tests (driven via the
 * DOM), so this stays a module-local helper.
 */
function validateSeNoiseSeed(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  // The substrate requires an int seed — reject anything that isn't a
  // base-10 integer (no decimals, no exponent, no stray characters).
  if (!/^[-+]?\d+$/.test(trimmed)) {
    return 'Enter a whole number (integer) seed, or leave blank.';
  }
  if (!Number.isSafeInteger(Number(trimmed))) {
    return 'Seed is too large — use a smaller integer.';
  }
  return null;
}

export function AnalyzeSeSubMode() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const lastPf = usePflowStore((s) => s.lastRun);
  const seResult = useAnalyzeStore((s) => s.seResult);
  const seMeasurementsCount = useAnalyzeStore((s) => s.seMeasurementsCount);
  const seGenerate = useSeGenerateMeasurements();
  const seRun = useSeRun();

  // Optional integer noise seed forwarded to the measurement-generation
  // request (Unit 14). Blank (the default) → omit ``noise_seed`` from
  // the body so the substrate picks its own seed (unchanged behaviour).
  const [noiseSeedText, setNoiseSeedText] = useState('');
  const noiseSeedError = validateSeNoiseSeed(noiseSeedText);

  // Cross-slice cascade cleanup — same shape as the EIG / CPF panels.
  useEffect(() => {
    if (lastPf === null && (seResult !== null || seMeasurementsCount !== null)) {
      useAnalyzeStore.getState().clearSeResult();
    }
  }, [lastPf, seResult, seMeasurementsCount]);

  const onGenerate = () => {
    if (!sessionId) return;
    if (noiseSeedError !== null) return;
    const trimmed = noiseSeedText.trim();
    seGenerate.mutate({
      sessionId,
      ...(trimmed.length === 0 ? {} : { noiseSeed: Number(trimmed) }),
    });
  };
  const onRun = () => {
    if (!sessionId) return;
    seRun.mutate(sessionId);
  };

  // The currently-active error (generate has priority — if it failed,
  // the run button is disabled and the error came from generate).
  const activeError = seGenerate.error ?? seRun.error;

  const canGenerate = sessionId !== null && !seGenerate.isPending && noiseSeedError === null;

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

      <details className="group" data-testid="se-advanced">
        <summary
          className={cn(
            'text-muted-foreground hover:text-foreground cursor-pointer text-[11px] font-medium',
            'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          )}
        >
          Advanced
        </summary>
        <div className="mt-2 flex flex-col gap-1">
          <label htmlFor="se-noise-seed" className="text-muted-foreground text-xs font-medium">
            noise_seed — RNG seed (optional)
          </label>
          <Input
            id="se-noise-seed"
            data-testid="field-se-noise-seed"
            inputMode="numeric"
            value={noiseSeedText}
            onChange={setNoiseSeedText}
            placeholder="substrate default"
            aria-invalid={noiseSeedError ? true : undefined}
            aria-describedby={
              noiseSeedError ? 'se-noise-seed-error' : 'se-noise-seed-hint'
            }
            className="h-7 font-mono text-xs"
          />
          {noiseSeedError ? (
            <span
              id="se-noise-seed-error"
              role="alert"
              data-testid="error-se-noise-seed"
              className="text-danger text-[10px]"
            >
              {noiseSeedError}
            </span>
          ) : (
            <span id="se-noise-seed-hint" className="text-muted-foreground text-[10px] leading-snug">
              Fix the noise draw for reproducible measurements. Leave blank to let the substrate
              choose.
            </span>
          )}
        </div>
      </details>

      <AnalyzeRoutineError routine="se" error={activeError ?? null} />

      <SEResidualChart className="min-h-[260px] flex-shrink-0" />
    </div>
  );
}
