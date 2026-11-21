import { useEffect, useMemo, useRef, useState } from 'react';
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
import { CpfConfigPanel, type CpfRunHandle } from './CpfConfigPanel';
import { CpfGeneratorPanel } from './CpfGeneratorPanel';
import { CpfQLimitsSwitch } from './CpfQLimitsSwitch';
import { CpfQvCurvePanel } from './CpfQvCurvePanel';
import { CpfStepLimitNote } from './CpfStepLimitNote';
import { RunReadinessNote } from './RunReadinessNote';
import { EigSweepPanel } from './EigSweepPanel';
import { EIGScatter } from './EIGScatter';
import { EIGParticipationTable } from './EIGParticipationTable';
import { EIGDampingChart } from './EIGDampingChart';
import { SEResidualChart } from './SEResidualChart';
import { useAnalyzeStore } from '@/store/analyze';
import {
  useCpfRun,
  useCurrentTopology,
  useEigRun,
  useSeGenerateMeasurements,
  useSeRun,
} from '@/api/queries';
import type { SeRunVars } from '@/api/queries';
import type { SeResult } from '@/api/types';
import { formatSignificant } from '@/lib/series';
import { directionRows } from '@/lib/cpfOptions';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { runReadinessNow, useRunReadiness, type RunRoutine } from '@/lib/useRunReadiness';
import { useRequestedRun } from '@/lib/useRequestedRun';
import { EIG_THEN_RELOAD, reloadAfterEigNote } from '@/lib/runLock';
import { useReloadDiscardsEdits } from '@/lib/useResetRunAction';
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
 * prerequisite-error banner with a "Run power flow" CTA after a failed
 * click. The Run-readiness hook now gates the click *proactively* —
 * the user sees the same "Run PFlow first" reason on hover before they
 * click, and as visible text from the sub-mode's ``RunReadinessNote``
 * (which this button names in ``aria-describedby``). The post-click 409
 * banner stays in place as a fallback for the case where the substrate
 * disagrees with the client's view of readiness (e.g., the PF result we
 * trust was actually invalidated server-side).
 */
export function AnalyzeRunButton({
  routine,
  label,
  pendingLabel,
  isPending,
  onClick,
  testId,
  disabledOverride,
  hint,
}: {
  routine: RunRoutine;
  label: string;
  pendingLabel: string;
  isPending: boolean;
  onClick: () => void;
  testId: string;
  /**
   * What a press leaves behind, for a routine whose run changes what can be
   * run after it (EIG): the hover text of the button while it can be pressed,
   * and its description for a screen reader.
   */
  hint?: string;
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
      aria-describedby={
        readiness.disabledReason !== null && !isPending ? `${testId}-hint` : undefined
      }
      aria-description={hint}
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
  if (hint !== undefined && !disabled) {
    return (
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipPortal>
            <TooltipContent data-testid={`${testId}-press-hint`} className="max-w-xs">
              {hint}
            </TooltipContent>
          </TooltipPortal>
        </Tooltip>
      </TooltipProvider>
    );
  }
  return button;
}

/**
 * SeGenerateButton — the "Generate Measurements" button + its pre-click
 * disabled-reason tooltip. Unlike ``AnalyzeRunButton`` it can't use
 * ``useRunReadiness('se')`` directly (that gate also requires measurements to
 * exist, which is exactly what this button creates — circular). The caller
 * passes a PF-only ``disabledReason``; when set the button is wrapped in a
 * tooltip so the prerequisite shows on hover, matching the run buttons.
 */
function SeGenerateButton({
  disabled,
  isPending,
  hasMeasurements,
  onClick,
  disabledReason,
}: {
  disabled: boolean;
  isPending: boolean;
  hasMeasurements: boolean;
  onClick: () => void;
  disabledReason: string | null;
}) {
  const button = (
    <Button
      type="button"
      // The next step is the primary action: Generate until there are
      // measurements, then the Run SE button beside it.
      variant={hasMeasurements ? 'outline' : 'primary'}
      size="sm"
      disabled={disabled}
      onClick={onClick}
      data-testid="analyze-se-generate-measurements"
      aria-describedby={disabledReason !== null ? 'analyze-se-run-hint' : undefined}
    >
      {isPending
        ? 'Generating…'
        : hasMeasurements
          ? 'Re-generate Measurements'
          : 'Generate Measurements'}
    </Button>
  );

  if (disabledReason === null) return button;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} aria-disabled="true" className="inline-block">
            {button}
          </span>
        </TooltipTrigger>
        <TooltipPortal>
          <TooltipContent data-testid="analyze-se-generate-measurements-disabled-reason">
            {disabledReason}
          </TooltipContent>
        </TooltipPortal>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * AnalyzeRoutineError — the per-routine error surface for EIG / CPF / SE,
 * migrated onto the single ``<ProblemDetailsErrorSurface>`` primitive
 * (v3.1 Unit 9). Replaces the three bespoke inline ``role="alert"`` banners.
 *
 * Branch → recovery mapping:
 *
 * - **409 prerequisite** (the routine needs a converged operating point):
 *   warning-toned banner + a ``run-pflow`` recovery (label "Run power flow")
 *   whose ``<RecoveryActionButton>`` routes the user to the PF run mode +
 *   Analyze PF sub-mode and runs the power flow. The substrate's own
 *   ``recovery`` descriptor is used when present; otherwise we synthesise the
 *   canonical ``run-pflow`` CTA so the affordance is preserved during the
 *   staged rollout.
 * - **generic 4xx / 5xx**: danger-toned banner carrying whatever ``recovery``
 *   the substrate attached (``null`` → dismiss-only, per the staged-rollout
 *   fallback). The detail is the ProblemDetails ``detail`` (falling back to
 *   ``title`` / ``message``), preserving the bespoke copy.
 *
 * ``error`` is the live mutation error (a ``ProblemDetailsError`` or a plain
 * ``Error``). ``null`` renders nothing.
 */
export function AnalyzeRoutineError({
  routine,
  error,
  testIdPrefix,
}: {
  routine: RunRoutine;
  error: Error | null;
  /**
   * The test-id stem of the banner, defaulting to the routine. A second
   * surface of the same routine on one screen (the EIG sweep beside the
   * single run) passes its own so the two do not collide.
   */
  testIdPrefix?: string;
}) {
  if (error === null) return null;

  const prefix = testIdPrefix ?? routine;
  const isPrerequisite = error instanceof ProblemDetailsError && error.status === 409;

  if (isPrerequisite) {
    // Prefer the substrate's typed recovery; otherwise synthesise the
    // canonical run-pflow CTA so the "Run power flow" affordance survives the
    // staged rollout (legacy 409s with no recovery field).
    const recovery: RecoveryDescriptor = error.recovery ?? {
      kind: 'run-pflow',
      label: 'Run power flow',
    };
    return (
      <ProblemDetailsErrorSurface
        variant="banner"
        tone="warning"
        testId={`${prefix}-prerequisite-error`}
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
      testId={`${prefix}-error`}
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
  const reloadDiscardsEdits = useReloadDiscardsEdits();
  // The sweep form starts over with each case, as the power-flow options do:
  // a parameter typed for one case's devices means nothing on another's.
  const casePath = useCaseStore((s) => s.selection?.primaryPath ?? null);

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
  // "Run eigenvalue analysis (EIG)" in the Run menu and the palette.
  useRequestedRun(['eig'], () => {
    if (!eigRun.isPending && runReadinessNow('eig').ready) onRun();
  });

  const eigError = eigRun.error;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <AnalyzeRunButton
          routine="eig"
          label="Run EIG"
          pendingLabel="Running EIG…"
          isPending={eigRun.isPending}
          onClick={onRun}
          testId="analyze-run-eig"
          hint={EIG_THEN_RELOAD}
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
            Running EIG initialised the dynamic state. To run power flow again, reload the case
            first (Reload case, in the top bar). {reloadAfterEigNote(reloadDiscardsEdits)}
          </span>
        ) : null}
      </div>

      <RunReadinessNote routine="eig" testId="analyze-run-eig" />

      <AnalyzeRoutineError routine="eig" error={eigError} />

      <EIGScatter className="min-h-[260px] flex-shrink-0" />
      <EIGParticipationTable className="min-h-[140px] flex-shrink-0" />
      <EIGDampingChart className="min-h-[140px] flex-shrink-0" />
      <EigSweepPanel key={casePath ?? 'no-case'} className="flex-shrink-0" />
    </div>
  );
}

/**
 * AnalyzeCpfSubMode — CPF home (Unit 12, extended Unit 13).
 *
 * Hosts a ``nose`` / ``qv`` sub-mode strip. ``nose`` is the full
 * PV-curve sweep driven by ``CpfConfigPanel`` (what grows, Q limits, the
 * lower branch, and step + max_iter behind an Advanced disclosure); ``qv``
 * is the single-bus QV-curve driven by ``CpfQvCurvePanel`` (bus picker +
 * Run). The strip + both flows live under one Analyze ``cpf`` sub-tab so
 * every CPF endpoint variant is reachable from the GUI.
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
    {
      value: 'nose',
      label: 'Nose curve',
      hint: 'PV-curve sweep: loads, generation or a custom direction',
    },
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
 * ``CpfConfigPanel`` (direction, lower branch, step + max_iter) into
 * ``useCpfRun``, wrapping the panel's Run button in the
 * readiness-tooltip ``AnalyzeRunButton`` via the panel's
 * ``renderRunButton`` prop. The Q-limit switch is the power-flow
 * options' own (``CpfQLimitsSwitch``), which the run hook reads. The
 * curve is followed by what the generators did along it
 * (``CpfGeneratorPanel``).
 *
 * The one-line summary of the last run sits beside the Run button, and a
 * run that used up its steps is answered under it (``CpfStepLimitNote``):
 * the options are between the button and the curve, so in a short drawer
 * the curve is not on screen when the run ends.
 */
export function AnalyzeCpfNoseSubMode() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const lastPf = usePflowStore((s) => s.lastRun);
  const cpfResult = useAnalyzeStore((s) => s.cpfResult);
  const cpfRun = useCpfRun();
  const readiness = useRunReadiness('cpf');
  const topology = useCurrentTopology();
  // The devices a custom direction can name, with their solved power.
  const devices = useMemo(() => directionRows(topology, lastPf), [topology, lastPf]);
  // The form starts over with each case, as the power-flow options do: a
  // direction typed for one case's loads means nothing on another's.
  const casePath = useCaseStore((s) => s.selection?.primaryPath ?? null);

  // When PF clears (case change cascade), drop the stale CPF result so
  // the empty-state shows.
  useEffect(() => {
    if (lastPf === null && cpfResult !== null) {
      useAnalyzeStore.getState().clearCpfResult();
    }
  }, [lastPf, cpfResult]);

  // A run refused for the state of the power flow (409) is answered by solving
  // the power flow again. Once that has happened the refusal no longer
  // describes the session, so it is not shown.
  const [pfAtRun, setPfAtRun] = useState(lastPf);
  const refused = cpfRun.error instanceof ProblemDetailsError && cpfRun.error.status === 409;
  const cpfError = refused && lastPf !== pfAtRun ? null : cpfRun.error;

  // "Run continuation power flow (CPF)" in the Run menu and the palette: the
  // run is made from the form as it stands, as by a click on Run CPF.
  const form = useRef<CpfRunHandle | null>(null);
  useRequestedRun(['cpf'], () => {
    if (!cpfRun.isPending && runReadinessNow('cpf').ready) form.current?.run();
  });

  return (
    <div className="flex flex-col gap-3">
      <CpfConfigPanel
        key={casePath ?? 'no-case'}
        handle={form}
        runLabel={cpfRun.isPending ? 'Running CPF…' : 'Run CPF'}
        runButtonTestId="analyze-run-cpf"
        runNote={<RunReadinessNote routine="cpf" testId="analyze-run-cpf" />}
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
        runStatus={
          cpfResult !== null ? (
            <span data-testid="cpf-summary" role="status" className="text-muted-foreground text-xs">
              {cpfResult.mode === 'qv' ? 'QV-curve' : 'PV-curve'} — {cpfResult.lambdas.length}{' '}
              steps; max {cpfResult.mode === 'qv' ? 'Q' : 'lambda'} = {cpfResult.max_lam.toFixed(4)}{' '}
              (the curve is below the options)
            </span>
          ) : null
        }
        renderRunFollowUp={({ runWithMaxSteps }) => (
          <CpfStepLimitNote
            result={cpfResult}
            onRunAgain={runWithMaxSteps}
            disabled={!readiness.ready || cpfRun.isPending}
          />
        )}
        loads={devices.loads}
        generators={devices.generators}
        limitsSwitch={
          <CpfQLimitsSwitch
            idPrefix="cpf-config"
            thenRun={{
              label: 'Run CPF (runs the power flow with Q limits first)',
              // Once the power flow is in, the form is run as it stands.
              run: () => form.current?.run(),
            }}
          />
        }
        onRun={(overrides) => {
          if (!sessionId) return;
          setPfAtRun(lastPf);
          cpfRun.mutate({ sessionId, ...overrides });
        }}
      />

      <AnalyzeRoutineError routine="cpf" error={cpfError} />

      <CPFCurveChart className="min-h-[300px] flex-shrink-0" />
      <CpfGeneratorPanel className="flex-shrink-0" />
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
  // The substrate requires a NON-NEGATIVE int seed (numpy's
  // ``default_rng`` raises ``ValueError`` on negatives). Reject anything
  // that isn't a base-10 non-negative integer (no leading '-', no
  // decimals, no exponent, no stray characters) so a bad seed surfaces
  // inline rather than as a misleading "non-convergent" run error.
  if (!/^\+?\d+$/.test(trimmed)) {
    return 'Enter a non-negative whole number (integer) seed, or leave blank.';
  }
  if (!Number.isSafeInteger(Number(trimmed))) {
    return 'Seed is too large — use a smaller integer.';
  }
  return null;
}

/**
 * Validate the optional SE run ``tol`` text input. The substrate requires
 * a tolerance above 0; blank (the default) omits ``tol`` from the request
 * so the case's own setting is kept. Returns ``null`` when valid or a
 * form-level error string otherwise. Module-local like
 * ``validateSeNoiseSeed``; behaviour is covered through the AnalyzePanel
 * SE-sub-mode tests.
 */
function validateSeTol(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    return 'Enter a tolerance above 0, or leave blank.';
  }
  return null;
}

/**
 * Validate the optional SE run ``max_iter`` text input. The substrate
 * requires a whole number of at least 1; blank omits ``max_iter`` so the
 * case's own setting is kept. Returns ``null`` when valid or a form-level
 * error string otherwise.
 */
function validateSeMaxIter(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (!/^\+?\d+$/.test(trimmed) || Number(trimmed) < 1 || !Number.isSafeInteger(Number(trimmed))) {
    return 'Enter a whole number of at least 1, or leave blank.';
  }
  return null;
}

/** The options of one SE run, as ``useSeRun`` takes them, without the session. */
type SeRunOptions = Omit<SeRunVars, 'sessionId'>;

/**
 * The options the SE form asks for: only what was set, so a form left as it
 * is gives ``{}`` and the request body stays empty. ``null`` while a field is
 * invalid, when no run may be sent.
 */
function seRunOptionsOf(
  algorithm: 'wls' | 'lav',
  tolText: string,
  maxIterText: string,
  runNoiseSeedText: string,
): SeRunOptions | null {
  if (
    validateSeTol(tolText) !== null ||
    validateSeMaxIter(maxIterText) !== null ||
    validateSeNoiseSeed(runNoiseSeedText) !== null
  ) {
    return null;
  }
  const tol = tolText.trim();
  const maxIter = maxIterText.trim();
  const seed = runNoiseSeedText.trim();
  return {
    ...(algorithm === 'wls' ? {} : { algorithm }),
    ...(tol.length === 0 ? {} : { tol: Number(tol) }),
    ...(maxIter.length === 0 ? {} : { maxIter: Number(maxIter) }),
    ...(seed.length === 0 ? {} : { noiseSeed: Number(seed) }),
  };
}

/** Whether two sets of SE run options ask for the same run. */
function sameSeRunOptions(a: SeRunOptions, b: SeRunOptions): boolean {
  return (
    a.algorithm === b.algorithm &&
    a.tol === b.tol &&
    a.maxIter === b.maxIter &&
    a.noiseSeed === b.noiseSeed
  );
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

  // The estimator and the per-run settings (SE-2). Each defaults to
  // "unset" so a run with nothing changed sends the empty body it always
  // did and the case's own settings hold: ``'wls'`` is the server's
  // default estimator and is not sent, and a blank field omits its key.
  const [algorithm, setAlgorithm] = useState<'wls' | 'lav'>('wls');
  const [tolText, setTolText] = useState('');
  const [maxIterText, setMaxIterText] = useState('');
  const [runNoiseSeedText, setRunNoiseSeedText] = useState('');
  const tolError = validateSeTol(tolText);
  const maxIterError = validateSeMaxIter(maxIterText);
  const runNoiseSeedError = validateSeNoiseSeed(runNoiseSeedText);

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
  const runOptions = seRunOptionsOf(algorithm, tolText, maxIterText, runNoiseSeedText);
  const onRun = () => {
    if (!sessionId) return;
    // An invalid field shows its error inline and sends nothing.
    if (runOptions === null) return;
    seRun.mutate({ sessionId, ...runOptions });
  };
  // "Run state estimation (SE)" in the Run menu and the palette.
  useRequestedRun(['se'], () => {
    if (!seRun.isPending && !seGenerate.isPending && runReadinessNow('se').ready) onRun();
  });

  // The bad-data test belongs to the run that made it. It is not shown while
  // a run is under way or after the last one failed, nor once the form asks
  // for another run than the one that made it (known when that run was
  // started here: its result is this hook's own).
  const shownRun = seRun.data === seResult ? seRun.variables : undefined;
  const optionsChanged =
    shownRun !== undefined && (runOptions === null || !sameSeRunOptions(runOptions, shownRun));
  const showBadDataTest =
    seResult !== null && !seRun.isPending && !seRun.isError && !optionsChanged;

  // The currently-active error (generate has priority — if it failed,
  // the run button is disabled and the error came from generate).
  const activeError = seGenerate.error ?? seRun.error;

  // SE measurements are synthesised from a converged operating point, so the
  // Generate button is PF-dependent. Gate it on PF-converged directly (NOT the
  // full ``se`` readiness, whose "Generate measurements first" sub-gate would
  // be circular here) and surface the same pre-click reason its siblings show.
  const pfConverged = lastPf !== null && lastPf.converged;
  const generateDisabledReason = pfConverged
    ? null
    : 'Run PFlow first; SE requires a converged operating point.';
  const canGenerate =
    sessionId !== null && !seGenerate.isPending && noiseSeedError === null && pfConverged;
  // SE is two steps and Run SE stays greyed out until the first is done. The
  // measurements are synthesised from the solved power flow (nothing to
  // import), which a first-time user cannot know, so spell it out beside the
  // reason instead of leaving them to guess that SE needs a data file.
  const needsMeasurements =
    pfConverged && !(seMeasurementsCount !== null && seMeasurementsCount > 0);

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <SeGenerateButton
          disabled={!canGenerate}
          isPending={seGenerate.isPending}
          hasMeasurements={seMeasurementsCount !== null}
          onClick={onGenerate}
          // PF-readiness reason shows on hover; the noise-seed validation
          // error is an inline form error, so it stays silent here.
          disabledReason={
            noiseSeedError !== null || seGenerate.isPending ? null : generateDisabledReason
          }
        />
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

      <SeAlgorithmPicker algorithm={algorithm} onChange={setAlgorithm} />
      {algorithm === 'lav' ? (
        <span
          data-testid="se-lav-max-iter-hint"
          className="text-muted-foreground text-[10px] leading-snug"
        >
          LAV is for a measurement set that may hold a bad measurement: it weighs large residuals
          less than WLS does, so one bad value can pull the estimate less. It often needs more
          iterations; raise max_iter under Advanced if the run does not converge.
        </span>
      ) : null}

      <RunReadinessNote
        routine="se"
        testId="analyze-se-run"
        extra={
          needsMeasurements
            ? 'Generate Measurements builds the set from the solved power flow, so no measurement file is required. Then click Run SE.'
            : null
        }
      />

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
            aria-describedby={noiseSeedError ? 'se-noise-seed-error' : 'se-noise-seed-hint'}
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
            <span
              id="se-noise-seed-hint"
              className="text-muted-foreground text-[10px] leading-snug"
            >
              Fix the noise draw for reproducible measurements. Leave blank to let the substrate
              choose.
            </span>
          )}
        </div>
        <div className="mt-2 flex flex-col gap-1">
          <label htmlFor="se-tol" className="text-muted-foreground text-xs font-medium">
            tol: convergence tolerance (optional)
          </label>
          <Input
            id="se-tol"
            data-testid="field-se-tol"
            value={tolText}
            onChange={setTolText}
            placeholder="substrate default"
            aria-invalid={tolError ? true : undefined}
            aria-describedby={tolError ? 'se-tol-error' : 'se-tol-hint'}
            className="h-7 font-mono text-xs"
          />
          {tolError ? (
            <span
              id="se-tol-error"
              role="alert"
              data-testid="error-se-tol"
              className="text-danger text-[10px]"
            >
              {tolError}
            </span>
          ) : (
            <span id="se-tol-hint" className="text-muted-foreground text-[10px] leading-snug">
              Convergence tolerance on the state correction for this run. Leave blank to keep the
              case setting (ANDES default 1e-4).
            </span>
          )}
        </div>
        <div className="mt-2 flex flex-col gap-1">
          <label htmlFor="se-max-iter" className="text-muted-foreground text-xs font-medium">
            max_iter: iteration limit (optional)
          </label>
          <Input
            id="se-max-iter"
            data-testid="field-se-max-iter"
            inputMode="numeric"
            value={maxIterText}
            onChange={setMaxIterText}
            placeholder="substrate default"
            aria-invalid={maxIterError ? true : undefined}
            aria-describedby={maxIterError ? 'se-max-iter-error' : 'se-max-iter-hint'}
            className="h-7 font-mono text-xs"
          />
          {maxIterError ? (
            <span
              id="se-max-iter-error"
              role="alert"
              data-testid="error-se-max-iter"
              className="text-danger text-[10px]"
            >
              {maxIterError}
            </span>
          ) : (
            <span id="se-max-iter-hint" className="text-muted-foreground text-[10px] leading-snug">
              Maximum iterations for this run. Leave blank to keep the case setting (ANDES default
              100).
            </span>
          )}
        </div>
        <div className="mt-2 flex flex-col gap-1">
          <label htmlFor="se-run-noise-seed" className="text-muted-foreground text-xs font-medium">
            noise_seed for this run only (optional)
          </label>
          <Input
            id="se-run-noise-seed"
            data-testid="field-se-run-noise-seed"
            inputMode="numeric"
            value={runNoiseSeedText}
            onChange={setRunNoiseSeedText}
            placeholder="generated measurements"
            aria-invalid={runNoiseSeedError ? true : undefined}
            aria-describedby={
              runNoiseSeedError ? 'se-run-noise-seed-error' : 'se-run-noise-seed-hint'
            }
            className="h-7 font-mono text-xs"
          />
          {runNoiseSeedError ? (
            <span
              id="se-run-noise-seed-error"
              role="alert"
              data-testid="error-se-run-noise-seed"
              className="text-danger text-[10px]"
            >
              {runNoiseSeedError}
            </span>
          ) : (
            <span
              id="se-run-noise-seed-hint"
              className="text-muted-foreground text-[10px] leading-snug"
            >
              Draws new measurement noise for this run only, with this seed; the same seed gives the
              same run. The measurements Generate Measurements made (with the noise_seed above) are
              kept, and a run with this left blank uses them.
            </span>
          )}
        </div>
      </details>

      <AnalyzeRoutineError routine="se" error={activeError ?? null} />

      {showBadDataTest && seResult !== null ? <SeBadDataTest result={seResult} /> : null}

      <SEResidualChart className="min-h-[260px] flex-shrink-0" />
    </div>
  );
}

/**
 * The chi-squared bad-data test of one SE result, or the line that says the
 * run has none (an LAV run, or no more measurements than states). Passed
 * means the test found no bad data at its confidence, which is not proof
 * that every measurement is good; failed means the residuals are larger than
 * measurement noise alone explains, so at least one measurement is suspect.
 */
function SeBadDataTest({ result }: { result: SeResult }) {
  const test = result.chi_squared;
  return (
    <div data-testid="se-chi-squared" className="text-muted-foreground text-xs">
      {test != null ? (
        <div className="flex flex-col gap-1">
          <span
            data-testid="se-chi-squared-verdict"
            className={test.passed ? undefined : 'text-danger'}
          >
            Bad-data test (chi-squared, {formatSignificant(test.confidence * 100, 3)}% confidence):{' '}
            {test.passed ? 'passed' : 'failed'}
          </span>
          <span data-testid="se-chi-squared-meaning">
            {test.passed
              ? 'No bad data detected at this confidence. That does not show every measurement is good.'
              : 'The residuals are larger than measurement noise alone explains at this confidence, so at least one measurement is suspect.'}
          </span>
          <span data-testid="se-chi-squared-numbers">
            J = {formatSignificant(test.J, 3)}, threshold {formatSignificant(test.threshold, 3)},{' '}
            {test.dof} degrees of freedom
          </span>
        </div>
      ) : (
        <span data-testid="se-chi-squared-none">
          No bad-data test: it needs weighted least squares and more measurements than states.
        </span>
      )}
    </div>
  );
}

/**
 * SeAlgorithmPicker — the WLS / LAV estimator segmented control (SE-2).
 * Mirrors the ``CpfSubModePicker`` visual: one radio per estimator with
 * its hint on hover. ``'wls'`` is the server's default, so picking it
 * leaves ``algorithm`` out of the run request.
 */
function SeAlgorithmPicker({
  algorithm,
  onChange,
}: {
  algorithm: 'wls' | 'lav';
  onChange: (next: 'wls' | 'lav') => void;
}) {
  const options: ReadonlyArray<{ value: 'wls' | 'lav'; label: string; hint: string }> = [
    { value: 'wls', label: 'WLS', hint: 'Weighted least squares (Gauss-Newton)' },
    {
      value: 'lav',
      label: 'LAV',
      hint: 'Least absolute value: weighs a bad measurement less than WLS does',
    },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="SE estimator"
      data-testid="se-algorithm-picker"
      className={cn(
        'inline-flex self-start overflow-hidden rounded-[var(--radius-md)]',
        'border-border border text-xs',
      )}
    >
      {options.map((opt, idx) => {
        const isActive = algorithm === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            data-testid={`se-algorithm-${opt.value}`}
            title={opt.hint}
            onClick={() => onChange(opt.value)}
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
