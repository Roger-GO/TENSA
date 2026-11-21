import { useImperativeHandle, useState } from 'react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { ProblemDetailsErrorSurface } from '@/components/error/ProblemDetailsErrorSurface';
import {
  CPF_DIRECTIONS,
  CPF_PARAMETERIZATIONS,
  EMPTY_CUSTOM_DIRECTION,
  parseCustomDirection,
  validateCpfAdvanced,
  type CpfDirection,
  type CpfParameterization,
  type CpfRunOptions,
  type CustomDirection,
  type DirectionGeneratorRow,
  type DirectionLoadRow,
} from '@/lib/cpfOptions';
import { CpfDirectionEditor } from './CpfDirectionEditor';

/**
 * CpfConfigPanel — the Run-CPF affordance for the Analyze panel's
 * ``nose`` sub-mode (v3.1 Unit 13).
 *
 * What a run can be asked for sits in the open, because each of these
 * changes what the curve means:
 *
 * - **What grows**: loads and generation together (ANDES's default), the
 *   loads alone, generation alone, or a custom direction, whose two tables
 *   (``CpfDirectionEditor``) appear when it is chosen.
 * - **Generator Q limits**: the parent passes the switch (``limitsSwitch``),
 *   which is the power-flow options' own.
 * - **Where to stop**: at the nose, on along the lower branch back to the
 *   base load, or at a target lambda.
 *
 * The continuation step and the step cap stay behind the "Advanced"
 * disclosure (collapsed by default, mirroring the ``TdsConfigPanel``
 * Advanced shape): they tune the solver, not the study. So do the
 * parameterization, the corrector's tolerance and iteration count, and the
 * step bounds.
 *
 * The panel owns ONLY the form + the Run button; the parent
 * ``AnalyzeCpfSubMode`` owns the mutation, the readiness gate, the
 * result summary, and the post-run error/recovery banner. On Run the
 * panel hands the parent the validated settings via ``onRun``. What the
 * parent says about the last run sits by the Run button (``runStatus``,
 * ``renderRunFollowUp``), where the run was started: the curve is under
 * the options and out of sight in a short drawer.
 *
 * Validation: ``step`` and ``max_iter`` are optional. When provided
 * they must be finite and positive. ``tol`` must be positive and at
 * most 1e-4, ``corrector_max_iter`` an integer of at least 2, and
 * ``step_min`` not above ``step_max``. ``natural`` parameterization
 * with ``stop_at: 'full'`` is refused. A target λ must be positive.
 * A custom direction needs a number in every field that is filled and
 * an increase on at least one device. Invalid input renders an inline
 * ``<ProblemDetailsErrorSurface variant="banner">`` and blocks the Run
 * handler from firing — the parent never sees an invalid request.
 *
 * Test hooks:
 * - ``data-testid="cpf-config-panel"`` outer section.
 * - ``data-testid="cpf-config-direction-load|load-only|gen|custom"`` radios.
 * - ``data-testid="cpf-config-stop-at-nose|target"`` radios, and
 *   ``data-testid="cpf-config-lower-branch"`` the full-curve radio.
 * - ``data-testid="field-cpf-config-stop-at-lambda"`` target-λ input (when shown).
 * - ``data-testid="cpf-config-parameterization-natural|arclength|pseudo_arclength"`` radios.
 * - ``data-testid="cpf-config-parameterization-clear"`` clear button.
 * - ``data-testid="cpf-config-advanced-toggle"`` disclosure button.
 * - ``data-testid="cpf-config-advanced"`` disclosure body.
 * - ``data-testid="field-cpf-config-step"`` / ``-max-iter`` inputs.
 * - ``data-testid="field-cpf-config-tol"`` / ``-corrector-max-iter`` / ``-step-min`` / ``-step-max`` inputs.
 * - ``data-testid="cpf-config-error"`` validation banner.
 */

export type { CpfDirection } from '@/lib/cpfOptions';

/**
 * What the form hands the parent: the direction (with the lists of a custom
 * one), where to stop, and the solver settings, each left out when the user
 * left the field blank (substrate default).
 */
export type CpfRunOverrides = Omit<CpfRunOptions, 'enforceQLimits'>;

/** What a parent can ask of the form from outside it (`CpfConfigPanelProps.handle`). */
export interface CpfRunHandle {
  /** Start a run with the form as it stands, as a click on Run CPF does. */
  run: () => void;
}

export interface CpfConfigPanelProps {
  /** Fired with the validated overrides when the user clicks Run CPF. */
  onRun: (overrides: CpfRunOverrides) => void;
  /** Set while the form is mounted: how a command starts a run from it. */
  handle?: React.Ref<CpfRunHandle>;
  /** Disables the Run button (readiness gate + pending state). */
  runDisabled?: boolean;
  /** Run button label (swaps to a pending label while the run is in flight). */
  runLabel: string;
  /** data-testid for the Run button (parent wires its readiness tooltip). */
  runButtonTestId: string;
  /**
   * Render-prop for the Run button so the parent can wrap it in its own
   * readiness-tooltip ``AnalyzeRunButton``. When omitted the panel
   * renders a plain Button. ``onRun`` is always invoked through the
   * panel's ``handleRun`` (which gates on validation) regardless.
   */
  renderRunButton?: (props: { onClick: () => void; disabled: boolean }) => React.ReactNode;
  /** Shown beside the Run button: the parent's one line on the last run. */
  runStatus?: React.ReactNode;
  /**
   * Shown directly under the Run button, above the options. The
   * parent passes the visible "why Run CPF is off" note here.
   */
  runNote?: React.ReactNode;
  /**
   * Shown after ``runNote``: what the parent has to say about the last run
   * that the form can act on. ``runWithMaxSteps`` writes the number into
   * the Max steps field, opens Advanced so that it shows, and starts a run
   * with the form as it stands.
   */
  renderRunFollowUp?: (actions: { runWithMaxSteps: (maxSteps: number) => void }) => React.ReactNode;
  /** The PQ loads a custom direction can move, with their solved power. */
  loads?: readonly DirectionLoadRow[];
  /** The PV generators a custom direction can move, with their solved power. */
  generators?: readonly DirectionGeneratorRow[];
  /** The "Enforce generator Q limits" switch, which the parent owns. */
  limitsSwitch?: React.ReactNode;
  className?: string;
}

/** The fields behind the Advanced disclosure, by the keys of their errors. */
const ADVANCED_FIELDS: ReadonlySet<string> = new Set([
  'step',
  'maxIter',
  'parameterization',
  'tol',
  'correctorMaxIter',
  'stepMin',
  'stepMax',
]);

const NO_LOADS: readonly DirectionLoadRow[] = [];
const NO_GENERATORS: readonly DirectionGeneratorRow[] = [];

/**
 * Pure validator. Returns a field→message map; an empty object means
 * the overrides are submittable. Exported for tests so the gate logic
 * has one source of truth.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function validateCpfOverrides(
  stepText: string,
  maxIterText: string,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const stepTrim = stepText.trim();
  if (stepTrim.length > 0) {
    const step = Number(stepTrim);
    if (!Number.isFinite(step) || step <= 0) {
      errors.step = 'Step must be a positive number.';
    }
  }
  const maxIterTrim = maxIterText.trim();
  if (maxIterTrim.length > 0) {
    const maxIter = Number(maxIterTrim);
    if (!Number.isInteger(maxIter) || maxIter <= 0) {
      errors.maxIter = 'Max steps must be a positive integer.';
    }
  }
  return errors;
}

export function CpfConfigPanel({
  onRun,
  handle,
  runDisabled = false,
  runLabel,
  runButtonTestId,
  renderRunButton,
  runStatus,
  runNote,
  renderRunFollowUp,
  loads = NO_LOADS,
  generators = NO_GENERATORS,
  limitsSwitch,
  className,
}: CpfConfigPanelProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [direction, setDirection] = useState<CpfDirection>('load');
  const [custom, setCustom] = useState<CustomDirection>(EMPTY_CUSTOM_DIRECTION);
  const [stepText, setStepText] = useState('');
  const [maxIterText, setMaxIterText] = useState('');
  const [parameterization, setParameterization] = useState<CpfParameterization | ''>('');
  const [stopAtChoice, setStopAtChoice] = useState<'nose' | 'full' | 'target'>('nose');
  const [stopAtLambdaText, setStopAtLambdaText] = useState('');
  const [tolText, setTolText] = useState('');
  const [correctorMaxIterText, setCorrectorMaxIterText] = useState('');
  const [stepMinText, setStepMinText] = useState('');
  const [stepMaxText, setStepMaxText] = useState('');
  // Validation only surfaces after a Run attempt so a mid-edit draft
  // doesn't flash a banner on every keystroke.
  const [showErrors, setShowErrors] = useState(false);

  const parsedCustom =
    direction === 'custom'
      ? parseCustomDirection(
          custom,
          loads.map((row) => row.idx),
          generators.map((row) => row.idx),
        )
      : null;
  const fieldErrors = validateCpfOverrides(stepText, maxIterText);
  const advancedErrors = validateCpfAdvanced(
    parameterization,
    stopAtChoice,
    stopAtLambdaText,
    tolText,
    correctorMaxIterText,
    stepMinText,
    stepMaxText,
  );
  const allFieldErrors = { ...fieldErrors, ...advancedErrors };
  const errors: Record<string, string> =
    parsedCustom !== null && !parsedCustom.ok
      ? { ...allFieldErrors, direction: parsedCustom.error }
      : allFieldErrors;
  const hasErrors = Object.keys(errors).length > 0;

  // ``maxIter`` is the Max steps field as this run reads it: what it holds,
  // or the number "run again with more steps" is writing into it.
  const startRun = (maxIter: string) => {
    const runFieldErrors = {
      ...validateCpfOverrides(stepText, maxIter),
      ...validateCpfAdvanced(
        parameterization,
        stopAtChoice,
        stopAtLambdaText,
        tolText,
        correctorMaxIterText,
        stepMinText,
        stepMaxText,
      ),
    };
    const customRefused = parsedCustom !== null && !parsedCustom.ok;
    if (customRefused || Object.keys(runFieldErrors).length > 0) {
      setShowErrors(true);
      // Open the disclosure when the offending field is inside it.
      if (Object.keys(runFieldErrors).some((key) => ADVANCED_FIELDS.has(key))) {
        setAdvancedOpen(true);
      }
      return;
    }
    setShowErrors(false);
    const overrides: CpfRunOverrides = { direction };
    if (parsedCustom !== null && parsedCustom.ok) {
      overrides.loadIncrease = parsedCustom.loadIncrease;
      overrides.generatorIncrease = parsedCustom.generatorIncrease;
    }
    if (stopAtChoice === 'full') overrides.stopAt = 'full';
    if (stopAtChoice === 'target') overrides.stopAtLambda = Number(stopAtLambdaText.trim());
    const stepTrim = stepText.trim();
    if (stepTrim.length > 0) overrides.step = Number(stepTrim);
    const maxIterTrim = maxIter.trim();
    if (maxIterTrim.length > 0) overrides.maxIter = Number(maxIterTrim);
    if (parameterization !== '') overrides.parameterization = parameterization;
    const tolTrim = tolText.trim();
    if (tolTrim.length > 0) overrides.tol = Number(tolTrim);
    const cmiTrim = correctorMaxIterText.trim();
    if (cmiTrim.length > 0) overrides.correctorMaxIter = Number(cmiTrim);
    const stepMinTrim = stepMinText.trim();
    if (stepMinTrim.length > 0) overrides.stepMin = Number(stepMinTrim);
    const stepMaxTrim = stepMaxText.trim();
    if (stepMaxTrim.length > 0) overrides.stepMax = Number(stepMaxTrim);
    onRun(overrides);
  };

  const handleRun = () => startRun(maxIterText);
  useImperativeHandle(handle, () => ({ run: handleRun }));

  const runWithMaxSteps = (maxSteps: number) => {
    const maxIter = String(maxSteps);
    setMaxIterText(maxIter);
    setAdvancedOpen(true);
    startRun(maxIter);
  };

  const errorMessages = Object.values(errors);
  const parameterizationErrorId =
    showErrors && errors.parameterization ? 'cpf-config-parameterization-error' : undefined;

  return (
    <section
      data-testid="cpf-config-panel"
      aria-label="CPF run configuration"
      className={cn('flex flex-col gap-3', className)}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {renderRunButton ? (
          renderRunButton({ onClick: handleRun, disabled: runDisabled })
        ) : (
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={runDisabled}
            onClick={handleRun}
            data-testid={runButtonTestId}
          >
            {runLabel}
          </Button>
        )}
        {runStatus}
      </div>

      {runNote}

      {renderRunFollowUp ? renderRunFollowUp({ runWithMaxSteps }) : null}

      <fieldset className="flex flex-col gap-1.5" data-testid="cpf-config-direction">
        <legend className="text-muted-foreground text-xs font-medium">What grows with λ</legend>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] items-start gap-x-4 gap-y-1">
          {CPF_DIRECTIONS.map((opt) => {
            const id = `cpf-config-direction-${opt.value}`;
            const checked = direction === opt.value;
            return (
              <label
                key={opt.value}
                htmlFor={id}
                className={cn(
                  'flex items-start gap-2',
                  'cursor-pointer rounded px-1 py-1',
                  'hover:bg-muted/40 transition-colors',
                )}
              >
                <input
                  id={id}
                  data-testid={id}
                  type="radio"
                  name="cpf-config-direction"
                  checked={checked}
                  onChange={() => setDirection(opt.value)}
                  className={cn(
                    'border-border mt-0.5 h-3.5 w-3.5 border',
                    'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
                  )}
                />
                <span className="flex flex-col">
                  <span className="text-foreground text-xs">{opt.label}</span>
                  <span className="text-muted-foreground text-[10px] leading-snug">{opt.hint}</span>
                </span>
              </label>
            );
          })}
        </div>
        {direction === 'custom' ? (
          <CpfDirectionEditor
            loads={loads}
            generators={generators}
            value={custom}
            onChange={setCustom}
          />
        ) : null}
      </fieldset>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] items-start gap-x-4 gap-y-1">
        {limitsSwitch}

        <fieldset className="flex flex-col gap-1.5" data-testid="cpf-config-stop-at">
          <legend className="text-muted-foreground text-xs font-medium">Where to stop</legend>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] items-start gap-x-4 gap-y-1">
            {(
              [
                {
                  value: 'nose' as const,
                  label: 'At the nose',
                  hint: 'Stop at the voltage-collapse margin.',
                  testId: 'cpf-config-stop-at-nose',
                },
                {
                  value: 'full' as const,
                  label: 'Full curve',
                  hint: 'Go on past the nose and follow the low-voltage solutions back to the base load.',
                  testId: 'cpf-config-lower-branch',
                },
                {
                  value: 'target' as const,
                  label: 'At a target λ',
                  hint: 'Stop when λ reaches the value given. A target past the nose ends at the nose.',
                  testId: 'cpf-config-stop-at-target',
                },
              ] as const
            ).map((opt) => {
              const id = `cpf-config-stop-at-${opt.value}`;
              const checked = stopAtChoice === opt.value;
              return (
                <label
                  key={opt.value}
                  htmlFor={id}
                  className={cn(
                    'flex items-start gap-2',
                    'cursor-pointer rounded px-1 py-1',
                    'hover:bg-muted/40 transition-colors',
                  )}
                >
                  <input
                    id={id}
                    data-testid={opt.testId}
                    type="radio"
                    name="cpf-config-stop-at"
                    checked={checked}
                    onChange={() => setStopAtChoice(opt.value)}
                    className={cn(
                      'border-border mt-0.5 h-3.5 w-3.5 border',
                      'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
                    )}
                  />
                  <span className="flex flex-col">
                    <span className="text-foreground text-xs">{opt.label}</span>
                    <span className="text-muted-foreground text-[10px] leading-snug">
                      {opt.hint}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {stopAtChoice === 'target' ? (
            <NumberField
              id="cpf-config-stop-at-lambda"
              label="Target λ"
              value={stopAtLambdaText}
              onChange={setStopAtLambdaText}
              error={showErrors ? errors.stopAtLambda : undefined}
              hint="The load level to stop at. The run ends there; a target past the nose ends at the nose."
              placeholder="e.g. 2.5"
            />
          ) : null}
        </fieldset>
      </div>

      {/* Advanced disclosure — collapsed by default (mirrors TdsConfigPanel). */}
      <div className="border-border/60 flex flex-col rounded border">
        <button
          type="button"
          data-testid="cpf-config-advanced-toggle"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((v) => !v)}
          className={cn(
            'text-muted-foreground hover:text-foreground flex items-center gap-1.5',
            'px-2 py-1.5 text-left text-xs font-medium',
            'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          )}
        >
          <span
            aria-hidden
            className={cn('inline-block transition-transform', advancedOpen ? 'rotate-90' : '')}
          >
            ▸
          </span>
          Advanced
        </button>

        {advancedOpen ? (
          <div
            data-testid="cpf-config-advanced"
            className="border-border/60 flex flex-col gap-3 border-t p-2"
          >
            <NumberField
              id="cpf-config-step"
              label="Step (optional)"
              value={stepText}
              onChange={setStepText}
              error={showErrors ? errors.step : undefined}
              hint="The first step in λ (step in the API, ANDES CPF.config.step). ANDES sizes the steps after it itself, half a unit of λ at most, so a larger value does not shorten a long run. Blank is its default, 0.1."
              placeholder="default"
            />

            <NumberField
              id="cpf-config-max-iter"
              label="Max steps (optional)"
              value={maxIterText}
              onChange={setMaxIterText}
              error={showErrors ? errors.maxIter : undefined}
              hint="The most steps one run may take (max_iter in the API). A run that gets there before it is done stops short and says so; raise this to go further. Blank is ANDES's default, 500."
              placeholder="default"
            />

            <fieldset className="flex flex-col gap-1.5" data-testid="cpf-config-parameterization">
              <legend className="text-muted-foreground text-xs font-medium">
                Parameterization (optional)
              </legend>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] items-start gap-x-4 gap-y-1">
                {CPF_PARAMETERIZATIONS.map((opt) => {
                  const id = `cpf-config-parameterization-${opt.value}`;
                  const checked = parameterization === opt.value;
                  return (
                    <label
                      key={opt.value}
                      htmlFor={id}
                      className={cn(
                        'flex items-start gap-2',
                        'cursor-pointer rounded px-1 py-1',
                        'hover:bg-muted/40 transition-colors',
                      )}
                    >
                      <input
                        id={id}
                        data-testid={id}
                        type="radio"
                        name="cpf-config-parameterization"
                        checked={checked}
                        aria-describedby={parameterizationErrorId}
                        onChange={() => setParameterization(opt.value)}
                        className={cn(
                          'border-border mt-0.5 h-3.5 w-3.5 border',
                          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
                        )}
                      />
                      <span className="flex flex-col">
                        <span className="text-foreground text-xs">{opt.label}</span>
                        <span className="text-muted-foreground text-[10px] leading-snug">
                          {opt.hint}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
              {parameterization !== '' ? (
                <button
                  type="button"
                  data-testid="cpf-config-parameterization-clear"
                  onClick={() => setParameterization('')}
                  className={cn(
                    'text-muted-foreground hover:text-foreground self-start text-[10px]',
                    'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
                  )}
                >
                  Clear (use the case's setting)
                </button>
              ) : null}
              {parameterizationErrorId !== undefined ? (
                <span
                  id={parameterizationErrorId}
                  role="alert"
                  data-testid="error-cpf-config-parameterization"
                  className="text-danger text-[10px]"
                >
                  {errors.parameterization}
                </span>
              ) : null}
            </fieldset>

            <NumberField
              id="cpf-config-tol"
              label="Tolerance (optional)"
              value={tolText}
              onChange={setTolText}
              error={showErrors ? errors.tol : undefined}
              hint="The corrector's tolerance on the mismatch, in pu (tol in the API, ANDES CPF.config.tol). At most 1e-4: a looser one moves the nose. Blank keeps the case's setting, ANDES's default being 1e-6."
              placeholder="default"
            />

            <NumberField
              id="cpf-config-corrector-max-iter"
              label="Corrector iterations (optional)"
              value={correctorMaxIterText}
              onChange={setCorrectorMaxIterText}
              error={showErrors ? errors.correctorMaxIter : undefined}
              hint="The Newton iterations the corrector takes per continuation step (corrector_max_iter in the API, ANDES CPF.config.max_iter). At least 2: fewer calls the nose too early. Blank keeps the case's setting, ANDES's default being 20."
              placeholder="default"
            />

            <NumberField
              id="cpf-config-step-min"
              label="Minimum step (optional)"
              value={stepMinText}
              onChange={setStepMinText}
              error={showErrors ? errors.stepMin : undefined}
              hint="The smallest continuation step (step_min in the API, ANDES CPF.config.step_min). Not above the maximum step. Blank keeps the case's setting, ANDES's default being 1e-4."
              placeholder="default"
            />

            <NumberField
              id="cpf-config-step-max"
              label="Maximum step (optional)"
              value={stepMaxText}
              onChange={setStepMaxText}
              error={showErrors ? errors.stepMax : undefined}
              hint="The largest step the routine grows its adaptive step to (step_max in the API, ANDES CPF.config.step_max): smaller draws the curve with more points. Blank keeps the case's setting, ANDES's default being 0.5."
              placeholder="default"
            />
          </div>
        ) : null}
      </div>

      {showErrors && hasErrors ? (
        <ProblemDetailsErrorSurface
          variant="banner"
          testId="cpf-config-error"
          hideRawDisclosure
          error={{
            title: 'Invalid CPF configuration',
            detail: errorMessages.join(' '),
          }}
        />
      ) : null}
    </section>
  );
}

interface NumberFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  error?: string;
  hint?: string;
  placeholder?: string;
}

function NumberField({ id, label, value, onChange, error, hint, placeholder }: NumberFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-muted-foreground text-xs font-medium">
        {label}
      </label>
      <input
        id={id}
        data-testid={`field-${id}`}
        type="text"
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'bg-background border-border h-7 rounded border px-2 font-mono text-xs',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          error ? 'border-danger' : '',
        )}
      />
      {hint ? (
        <span id={hintId} className="text-muted-foreground text-[10px] leading-snug">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span
          id={errorId}
          role="alert"
          data-testid={`error-${id}`}
          className="text-danger text-[10px]"
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}
