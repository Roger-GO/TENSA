import { useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { RunReadinessNote } from '@/components/analyze/RunReadinessNote';
import { usePflowStore } from '@/store/pflow';
import { usePflowOptionsStore } from '@/store/pflowOptions';
import { useRunReadiness } from '@/lib/useRunReadiness';
import { usePflowRunAction } from '@/lib/usePflowRunAction';
import {
  ANDES_PFLOW_DEFAULTS,
  PFLOW_LIMITS,
  formatTolerance,
  isDefaultPflowOptions,
  parseMaxIterations,
  parseTolerance,
  shownSwitch,
  type ParsedField,
} from '@/lib/pflowOptions';

/**
 * PflowOptionsForm: the settings of the next power-flow run.
 *
 * - Tolerance and Max iterations: blank keeps the case's own value (ANDES's
 *   default unless the case file sets one). Text that is not a valid value is
 *   not sent: the field says so, and the run uses the case's own value until it
 *   is fixed, so a run never goes out with a stale number beside a red field.
 * - Flat start and Enforce generator Q limits: left alone they keep the case's own
 *   (a case can turn either on itself), and once touched they are sent either way,
 *   so a case that turns Q limits on can be run without. The box shows what the
 *   case sets once a run has shown it.
 *
 * The values live in `usePflowOptionsStore`, which every control that starts a
 * power flow reads, and they reset when another case is opened. The text of the
 * two number fields is a draft kept here, shown while it still means what the
 * store holds; once the store changes from elsewhere (a retry button on the
 * non-convergence banner, a case change) the field follows the store.
 */

export interface PflowOptionsFormProps {
  className?: string;
}

/** The text to show: the draft while it still parses to what the store holds. */
function shownText(
  draft: string | null,
  stored: number | null,
  parse: (text: string) => ParsedField<number | null>,
  format: (value: number) => string,
): string {
  if (draft !== null) {
    const parsed = parse(draft);
    if ((parsed.ok ? parsed.value : null) === stored) return draft;
  }
  return stored === null ? '' : format(stored);
}

/** What to say of a switch the case file turns on itself, or `undefined` when it does not. */
function caseNote(choice: boolean | null, caseOwn: boolean | null): string | undefined {
  if (caseOwn !== true) return undefined;
  return choice === false
    ? 'The case itself turns this on. Runs go without it while this is unticked.'
    : 'The case itself turns this on. Untick it to run without.';
}

export function PflowOptionsForm({ className }: PflowOptionsFormProps) {
  const options = usePflowOptionsStore((s) => s.options);
  const caseSettings = usePflowOptionsStore((s) => s.caseSettings);
  const setOptions = usePflowOptionsStore((s) => s.setOptions);
  const resetOptions = usePflowOptionsStore((s) => s.resetOptions);
  const isRunning = usePflowStore((s) => s.isRunning);
  const readiness = useRunReadiness('pflow');
  const runPflow = usePflowRunAction();

  const [tolDraft, setTolDraft] = useState<string | null>(null);
  const [iterDraft, setIterDraft] = useState<string | null>(null);

  const tolText = shownText(tolDraft, options.tolerance, parseTolerance, formatTolerance);
  const iterText = shownText(iterDraft, options.maxIterations, parseMaxIterations, String);
  const tolParsed = parseTolerance(tolText);
  const iterParsed = parseMaxIterations(iterText);

  const onTolerance = (text: string) => {
    setTolDraft(text);
    const parsed = parseTolerance(text);
    setOptions({ tolerance: parsed.ok ? parsed.value : null });
  };
  const onMaxIterations = (text: string) => {
    setIterDraft(text);
    const parsed = parseMaxIterations(text);
    setOptions({ maxIterations: parsed.ok ? parsed.value : null });
  };
  const onReset = () => {
    resetOptions();
    setTolDraft(null);
    setIterDraft(null);
  };

  const runDisabled = !readiness.ready || isRunning;

  return (
    <section
      data-testid="pflow-options-form"
      aria-label="Power flow options"
      className={cn('flex flex-col gap-3', className)}
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-foreground text-sm font-semibold">Power flow options</h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onReset}
          disabled={isDefaultPflowOptions(options) && tolDraft === null && iterDraft === null}
          data-testid="pflow-options-reset"
        >
          Reset
        </Button>
      </header>

      <p className="text-muted-foreground text-xs leading-snug">
        Used by <strong>Run PF</strong>, and kept until you open another case. A time-domain run
        starts from the last converged power flow, so run PF first; one that has to solve it itself
        uses the case&apos;s own settings.
      </p>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] items-start gap-x-4 gap-y-3">
        <FieldRow
          id="pflow-tolerance"
          label="Tolerance (pu)"
          hint={`Stop when the largest mismatch is below this, from ${formatTolerance(PFLOW_LIMITS.toleranceMin)} to ${formatTolerance(PFLOW_LIMITS.toleranceMax)}. Blank keeps the case's own (ANDES: ${formatTolerance(ANDES_PFLOW_DEFAULTS.tolerance)}).`}
          error={tolParsed.ok ? undefined : `${tolParsed.error} The case's own tolerance is used.`}
        >
          <TextInput
            id="pflow-tolerance"
            value={tolText}
            placeholder={formatTolerance(ANDES_PFLOW_DEFAULTS.tolerance)}
            invalid={!tolParsed.ok}
            onChange={onTolerance}
            onBlur={() => tolParsed.ok && setTolDraft(null)}
          />
        </FieldRow>

        <FieldRow
          id="pflow-max-iterations"
          label="Max iterations"
          hint={`Give up after this many, from ${PFLOW_LIMITS.maxIterationsMin} to ${PFLOW_LIMITS.maxIterationsMax}. Blank keeps the case's own (ANDES: ${ANDES_PFLOW_DEFAULTS.maxIterations}).`}
          error={iterParsed.ok ? undefined : `${iterParsed.error} The case's own limit is used.`}
        >
          <TextInput
            id="pflow-max-iterations"
            value={iterText}
            placeholder={String(ANDES_PFLOW_DEFAULTS.maxIterations)}
            invalid={!iterParsed.ok}
            onChange={onMaxIterations}
            onBlur={() => iterParsed.ok && setIterDraft(null)}
          />
        </FieldRow>

        <CheckRow
          id="pflow-flat-start"
          label="Flat start"
          hint="Start every bus from 1 pu at angle 0 instead of the case's own voltages and angles. Try it when a run does not converge."
          checked={shownSwitch(options.flatStart, caseSettings.flatStart)}
          onChange={(checked) => setOptions({ flatStart: checked })}
          note={caseNote(options.flatStart, caseSettings.flatStart)}
        />

        <CheckRow
          id="pflow-enforce-q-limits"
          label="Enforce generator Q limits"
          hint="Hold a generator at its Qmin or Qmax when its reactive power goes past one, and let its voltage give; the Messages tab then names each generator held. Without it the limits are only reported, in the Violations tab."
          checked={shownSwitch(options.enforceQLimits, caseSettings.enforceQLimits)}
          onChange={(checked) => setOptions({ enforceQLimits: checked })}
          note={caseNote(options.enforceQLimits, caseSettings.enforceQLimits)}
        />
      </div>

      <div className="flex flex-col gap-2 pt-1">
        <div>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={runDisabled}
            onClick={runPflow}
            data-testid="pflow-options-run"
            aria-describedby={readiness.disabledReason ? 'pflow-options-run-hint' : undefined}
          >
            {isRunning ? 'Running PF…' : 'Run PF'}
          </Button>
        </div>
        <RunReadinessNote routine="pflow" testId="pflow-options-run" />
      </div>
    </section>
  );
}

interface FieldRowProps {
  id: string;
  label: string;
  hint: string;
  error?: string;
  children: ReactNode;
}

function FieldRow({ id, label, hint, error, children }: FieldRowProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-muted-foreground text-xs font-medium">
        {label}
      </label>
      {children}
      <span id={`${id}-hint`} className="text-muted-foreground text-[10px] leading-snug">
        {hint}
      </span>
      {error ? (
        <span
          id={`${id}-error`}
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

interface TextInputProps {
  id: string;
  value: string;
  placeholder: string;
  invalid: boolean;
  onChange: (next: string) => void;
  onBlur: () => void;
}

function TextInput({ id, value, placeholder, invalid, onChange, onBlur }: TextInputProps) {
  return (
    <input
      id={id}
      data-testid={`field-${id}`}
      type="text"
      inputMode="decimal"
      value={value}
      placeholder={placeholder}
      aria-invalid={invalid ? true : undefined}
      aria-describedby={invalid ? `${id}-hint ${id}-error` : `${id}-hint`}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      className={cn(
        'bg-background border-border h-7 rounded border px-2 font-mono text-xs',
        'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        invalid ? 'border-danger' : '',
      )}
    />
  );
}

interface CheckRowProps {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Said under the hint when the case file sets this itself. */
  note?: string | undefined;
}

function CheckRow({ id, label, hint, checked, onChange, note }: CheckRowProps) {
  return (
    <label
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
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className={cn(
          'border-border mt-0.5 h-3.5 w-3.5 rounded border',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        )}
      />
      <span className="flex flex-col">
        <span className="text-foreground text-xs">{label}</span>
        <span className="text-muted-foreground text-[10px] leading-snug">{hint}</span>
        {note !== undefined ? (
          <span
            data-testid={`${id}-case-note`}
            className="text-muted-foreground text-[10px] leading-snug"
          >
            {note}
          </span>
        ) : null}
      </span>
    </label>
  );
}
