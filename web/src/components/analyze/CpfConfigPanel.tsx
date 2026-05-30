import { useState } from 'react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { ProblemDetailsErrorSurface } from '@/components/error/ProblemDetailsErrorSurface';

/**
 * CpfConfigPanel — the Run-CPF affordance for the Analyze panel's
 * ``nose`` sub-mode (v3.1 Unit 13).
 *
 * Phases 1-2 of CPF (Unit 12) hardcoded ``direction: 'load'`` with no
 * way to drive a generation-direction nose curve or to override the
 * continuation step / step cap. This panel exposes those three knobs
 * — ``direction`` (load | gen), ``step``, ``max_iter`` — behind an
 * "Advanced" disclosure (collapsed by default, mirroring the
 * ``TdsConfigPanel`` Advanced shape) so the common case (load nose,
 * defaults) stays a single click.
 *
 * The panel owns ONLY the form + the Run button; the parent
 * ``AnalyzeCpfSubMode`` owns the mutation, the readiness gate, the
 * result summary, and the post-run error/recovery banner. On Run the
 * panel hands the parent the validated overrides via ``onRun``.
 *
 * Validation: ``step`` and ``max_iter`` are optional. When provided
 * they must be finite and positive (a negative / zero / NaN step makes
 * no physical sense for a continuation step). Invalid input renders an
 * inline ``<ProblemDetailsErrorSurface variant="banner">`` and blocks
 * the Run handler from firing — the parent never sees an invalid
 * request.
 *
 * Test hooks:
 * - ``data-testid="cpf-config-panel"`` outer section.
 * - ``data-testid="cpf-config-advanced-toggle"`` disclosure button.
 * - ``data-testid="cpf-config-advanced"`` disclosure body.
 * - ``data-testid="cpf-config-direction-load|gen"`` direction radios.
 * - ``data-testid="field-cpf-config-step"`` / ``-max-iter`` inputs.
 * - ``data-testid="cpf-config-error"`` validation banner.
 */

export type CpfDirection = 'load' | 'gen';

export interface CpfRunOverrides {
  direction: CpfDirection;
  /** Undefined when the user left the field blank (substrate default). */
  step?: number;
  /** Undefined when the user left the field blank (substrate default). */
  maxIter?: number;
}

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
  className?: string;
}

const DIRECTION_OPTIONS: ReadonlyArray<{ value: CpfDirection; label: string; hint: string }> = [
  {
    value: 'load',
    label: 'Load (P up)',
    hint: 'Scale loads up toward the voltage-collapse nose. ANDES default.',
  },
  {
    value: 'gen',
    label: 'Generation (P up)',
    hint: 'Scale generation up — the generation-direction nose curve.',
  },
];

/**
 * Pure validator. Returns a field→message map; an empty object means
 * the overrides are submittable. Exported for tests so the gate logic
 * has one source of truth.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function validateCpfOverrides(stepText: string, maxIterText: string): Record<string, string> {
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
  className,
}: CpfConfigPanelProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [direction, setDirection] = useState<CpfDirection>('load');
  const [stepText, setStepText] = useState('');
  const [maxIterText, setMaxIterText] = useState('');
  // Validation only surfaces after a Run attempt so a mid-edit draft
  // doesn't flash a banner on every keystroke.
  const [showErrors, setShowErrors] = useState(false);

  const errors = validateCpfOverrides(stepText, maxIterText);
  const hasErrors = Object.keys(errors).length > 0;

  const handleRun = () => {
    if (hasErrors) {
      setShowErrors(true);
      // Open the disclosure so the offending field is visible.
      setAdvancedOpen(true);
      return;
    }
    setShowErrors(false);
    const overrides: CpfRunOverrides = { direction };
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
            <fieldset className="flex flex-col gap-1.5" data-testid="cpf-config-direction">
              <legend className="text-muted-foreground text-xs font-medium">Direction</legend>
              {DIRECTION_OPTIONS.map((opt) => {
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
                      <span className="text-muted-foreground text-[10px] leading-snug">
                        {opt.hint}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>

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
        <span id={errorId} role="alert" data-testid={`error-${id}`} className="text-danger text-[10px]">
          {error}
        </span>
      ) : null}
    </div>
  );
}
