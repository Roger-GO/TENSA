import { useState } from 'react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { ProblemDetailsErrorSurface } from '@/components/error/ProblemDetailsErrorSurface';
import {
  CPF_DIRECTIONS,
  EMPTY_CUSTOM_DIRECTION,
  parseCustomDirection,
  type CpfDirection,
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
 * - **The lower branch**: go on past the nose back to the base load.
 *
 * The continuation step and the step cap stay behind the "Advanced"
 * disclosure (collapsed by default, mirroring the ``TdsConfigPanel``
 * Advanced shape): they tune the solver, not the study.
 *
 * The panel owns ONLY the form + the Run button; the parent
 * ``AnalyzeCpfSubMode`` owns the mutation, the readiness gate, the
 * result summary, and the post-run error/recovery banner. On Run the
 * panel hands the parent the validated settings via ``onRun``.
 *
 * Validation: ``step`` and ``max_iter`` are optional. When provided
 * they must be finite and positive (a negative / zero / NaN step makes
 * no physical sense for a continuation step). A custom direction needs a
 * number in every field that is filled and an increase on at least one
 * device. Invalid input renders an inline
 * ``<ProblemDetailsErrorSurface variant="banner">`` and blocks the Run
 * handler from firing — the parent never sees an invalid request.
 *
 * Test hooks:
 * - ``data-testid="cpf-config-panel"`` outer section.
 * - ``data-testid="cpf-config-direction-load|load-only|gen|custom"`` radios.
 * - ``data-testid="cpf-config-lower-branch"`` the full-curve checkbox.
 * - ``data-testid="cpf-config-advanced-toggle"`` disclosure button.
 * - ``data-testid="cpf-config-advanced"`` disclosure body.
 * - ``data-testid="field-cpf-config-step"`` / ``-max-iter`` inputs.
 * - ``data-testid="cpf-config-error"`` validation banner.
 */

export type { CpfDirection } from '@/lib/cpfOptions';

/**
 * What the form hands the parent: the direction (with the lists of a custom
 * one), whether to trace the lower branch, and the two solver settings, each
 * left out when the user left the field blank (substrate default).
 */
export type CpfRunOverrides = Omit<CpfRunOptions, 'enforceQLimits'>;

export interface CpfConfigPanelProps {
  /** Fired with the validated overrides when the user clicks Run CPF. */
  onRun: (overrides: CpfRunOverrides) => void;
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
  /**
   * Shown directly under the Run button, above the options. The
   * parent passes the visible "why Run CPF is off" note here.
   */
  runNote?: React.ReactNode;
  /** The PQ loads a custom direction can move, with their solved power. */
  loads?: readonly DirectionLoadRow[];
  /** The PV generators a custom direction can move, with their solved power. */
  generators?: readonly DirectionGeneratorRow[];
  /** The "Enforce generator Q limits" switch, which the parent owns. */
  limitsSwitch?: React.ReactNode;
  className?: string;
}

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
  runDisabled = false,
  runLabel,
  runButtonTestId,
  renderRunButton,
  runNote,
  loads = NO_LOADS,
  generators = NO_GENERATORS,
  limitsSwitch,
  className,
}: CpfConfigPanelProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [direction, setDirection] = useState<CpfDirection>('load');
  const [custom, setCustom] = useState<CustomDirection>(EMPTY_CUSTOM_DIRECTION);
  const [lowerBranch, setLowerBranch] = useState(false);
  const [stepText, setStepText] = useState('');
  const [maxIterText, setMaxIterText] = useState('');
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
  const errors: Record<string, string> =
    parsedCustom !== null && !parsedCustom.ok
      ? { ...fieldErrors, direction: parsedCustom.error }
      : fieldErrors;
  const hasErrors = Object.keys(errors).length > 0;

  const handleRun = () => {
    if (hasErrors) {
      setShowErrors(true);
      // Open the disclosure when the offending field is inside it.
      if (Object.keys(fieldErrors).length > 0) setAdvancedOpen(true);
      return;
    }
    setShowErrors(false);
    const overrides: CpfRunOverrides = { direction };
    if (parsedCustom !== null && parsedCustom.ok) {
      overrides.loadIncrease = parsedCustom.loadIncrease;
      overrides.generatorIncrease = parsedCustom.generatorIncrease;
    }
    if (lowerBranch) overrides.stopAt = 'full';
    const stepTrim = stepText.trim();
    if (stepTrim.length > 0) overrides.step = Number(stepTrim);
    const maxIterTrim = maxIterText.trim();
    if (maxIterTrim.length > 0) overrides.maxIter = Number(maxIterTrim);
    onRun(overrides);
  };

  const errorMessages = Object.values(errors);

  return (
    <section
      data-testid="cpf-config-panel"
      aria-label="CPF run configuration"
      className={cn('flex flex-col gap-3', className)}
    >
      <div className="flex items-center gap-2">
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
      </div>

      {runNote}

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

        <label
          htmlFor="cpf-config-lower-branch"
          className={cn(
            'flex items-start gap-2',
            'cursor-pointer rounded px-1 py-1',
            'hover:bg-muted/40 transition-colors',
          )}
        >
          <input
            id="cpf-config-lower-branch"
            data-testid="cpf-config-lower-branch"
            type="checkbox"
            checked={lowerBranch}
            onChange={(e) => setLowerBranch(e.target.checked)}
            className={cn(
              'border-border mt-0.5 h-3.5 w-3.5 rounded border',
              'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
            )}
          />
          <span className="flex flex-col">
            <span className="text-foreground text-xs">Trace the lower branch too</span>
            <span className="text-muted-foreground text-[10px] leading-snug">
              Go on past the nose and follow the low-voltage solutions back to the base load, for
              the whole curve. Left off, the run stops at the nose.
            </span>
          </span>
        </label>
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
              label="step — continuation step size (optional)"
              value={stepText}
              onChange={setStepText}
              error={showErrors ? errors.step : undefined}
              hint="Maps to ANDES CPF.config.step. Leave blank for the substrate default."
              placeholder="default"
            />

            <NumberField
              id="cpf-config-max-iter"
              label="max_iter — max continuation steps (optional)"
              value={maxIterText}
              onChange={setMaxIterText}
              error={showErrors ? errors.maxIter : undefined}
              hint="Caps the number of continuation steps before truncation. Leave blank for the substrate default."
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
