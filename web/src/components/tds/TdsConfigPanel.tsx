import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import {
  DEFAULT_TDS_CONFIG,
  DEFAULT_TDS_TOLERANCE_OVERRIDES,
  TDS_VAR_GROUPS,
  useUiStore,
  validateTdsConfig,
  validateTdsToleranceOverrides,
} from '@/store/ui';
import type {
  TdsConfig,
  TdsIntegrator,
  TdsToleranceOverrides,
  TdsVarGroup,
} from '@/store/ui';
import { Button } from '@/components/ui/button';
import { useRunsStore, MAX_RETENTION_LIMIT } from '@/store/runs';

/**
 * TdsConfigPanel — compact form for the TDS run parameters.
 *
 * Owned fields (per the v0.2 plan, Unit 8):
 * - ``tf`` (final time, sec): required, > 0. Default 10.
 * - ``h`` (integration step, sec): optional override. Blank → substrate
 *   chooses adaptively. Default blank.
 * - ``vars`` (variable groups to stream): multi-select of ``bus_v`` /
 *   ``gen_state`` / ``line_flow``. At least one required. Default
 *   ``["bus_v"]`` — ``gen_state`` opt-in keeps default memory + plot
 *   clutter low.
 * - ``max_rate_hz`` (UI clamp): default 30. Power-users only.
 *
 * Persistence: writes through ``useUiStore.setTdsConfig`` so the value
 * survives panel swaps and is available to ``RunButton`` at start time.
 *
 * The form is local-draft + commit-on-blur. We keep raw text for the
 * numeric fields so users can clear and re-type without snapping back
 * to the last-valid number on every keystroke (mirrors
 * ``FaultSpecForm``'s pattern).
 */

export interface TdsConfigPanelProps {
  className?: string;
}

const VAR_GROUP_LABELS: Record<TdsVarGroup, string> = {
  bus_v: 'Bus voltage (|V|)',
  gen_state: 'Generator state (ω, δ)',
  line_flow: 'Line flow (P, Q)',
};

const VAR_GROUP_HINTS: Record<TdsVarGroup, string> = {
  bus_v: 'One column per bus.',
  gen_state: 'One column per synchronous generator. Opt-in for transient analysis.',
  line_flow: 'One column per line. Opt-in for flow studies.',
};

const INTEGRATOR_OPTIONS: ReadonlyArray<{
  value: TdsIntegrator;
  label: string;
  hint: string;
}> = [
  {
    value: 'trapezoidal',
    label: 'Trapezoidal (fixed-step)',
    hint: 'ANDES default. Uses h above; ignores rtol / atol.',
  },
  {
    value: 'qndf-auto',
    label: 'QNDF (adaptive, Auto)',
    hint: 'Variable-step NDF with sensible tolerances (rtol=1e-3, atol=1e-6, max_step=0.05).',
  },
  {
    value: 'qndf-manual',
    label: 'QNDF (adaptive, Manual)',
    hint: 'Variable-step NDF with hand-tuned tolerances.',
  },
];

export function TdsConfigPanel({ className }: TdsConfigPanelProps) {
  const tdsConfig = useUiStore((s) => s.tdsConfig);
  const setTdsConfig = useUiStore((s) => s.setTdsConfig);
  const resetTdsConfig = useUiStore((s) => s.resetTdsConfig);
  // Unit 16 — integrator preset + adaptive overrides.
  const tdsIntegrator = useUiStore((s) => s.tdsIntegrator);
  const setTdsIntegrator = useUiStore((s) => s.setTdsIntegrator);
  const tdsToleranceOverrides = useUiStore((s) => s.tdsToleranceOverrides);
  const setTdsToleranceOverrides = useUiStore((s) => s.setTdsToleranceOverrides);
  const resetTdsToleranceOverrides = useUiStore((s) => s.resetTdsToleranceOverrides);
  const retentionLimit = useRunsStore((s) => s.retentionLimit);
  const setRetentionLimit = useRunsStore((s) => s.setRetentionLimit);

  // Raw text inputs so users can clear + re-type without clobbering.
  // We intentionally do NOT re-sync from the store on every render — if
  // the user clears a field we set ``tf=NaN`` in the store, and a
  // re-sync would clobber the empty input back to ``"NaN"``. The Reset
  // button is the one external write path; it sets these directly.
  const [tfText, setTfText] = useState(String(tdsConfig.tf));
  const [hText, setHText] = useState(tdsConfig.h === null ? '' : String(tdsConfig.h));
  const [maxRateText, setMaxRateText] = useState(String(tdsConfig.maxRateHz));

  // Manual-mode tolerance text inputs (Unit 16). Same local-draft
  // pattern: typing in the field updates the store immediately so a
  // mid-edit refresh-or-Run captures the latest value, but the input's
  // raw text is preserved so the user can clear + re-type without the
  // store snapping it back to ``NaN``.
  const [rtolText, setRtolText] = useState(String(tdsToleranceOverrides.rtol));
  const [atolText, setAtolText] = useState(String(tdsToleranceOverrides.atol));
  const [maxStepText, setMaxStepText] = useState(String(tdsToleranceOverrides.maxStep));

  const errors = useMemo<Record<string, string>>(
    () => validateTdsConfig(tdsConfig),
    [tdsConfig],
  );

  // Tolerance errors only surface in Manual mode — Auto mode reads
  // ``DEFAULT_TDS_TOLERANCE_OVERRIDES`` directly and the inputs are
  // hidden, so validation noise from a mid-edit Manual draft would be
  // misleading.
  const toleranceErrors = useMemo<Record<string, string>>(
    () =>
      tdsIntegrator === 'qndf-manual'
        ? validateTdsToleranceOverrides(tdsToleranceOverrides)
        : {},
    [tdsIntegrator, tdsToleranceOverrides],
  );

  const setNumber = (key: 'tf' | 'maxRateHz', text: string) => {
    if (key === 'tf') setTfText(text);
    else setMaxRateText(text);
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      setTdsConfig({ [key]: Number.NaN } as Partial<TdsConfig>);
      return;
    }
    setTdsConfig({ [key]: Number(trimmed) } as Partial<TdsConfig>);
  };

  const setHValue = (text: string) => {
    setHText(text);
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      setTdsConfig({ h: null });
      return;
    }
    setTdsConfig({ h: Number(trimmed) });
  };

  const toggleVar = (group: TdsVarGroup) => {
    const has = tdsConfig.vars.includes(group);
    const next: TdsVarGroup[] = has
      ? tdsConfig.vars.filter((g) => g !== group)
      : [...tdsConfig.vars, group];
    setTdsConfig({ vars: next });
  };

  const setToleranceNumber = (key: keyof TdsToleranceOverrides, text: string) => {
    if (key === 'rtol') setRtolText(text);
    else if (key === 'atol') setAtolText(text);
    else setMaxStepText(text);
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      setTdsToleranceOverrides({ [key]: Number.NaN } as Partial<TdsToleranceOverrides>);
      return;
    }
    setTdsToleranceOverrides({ [key]: Number(trimmed) } as Partial<TdsToleranceOverrides>);
  };

  const onReset = () => {
    resetTdsConfig();
    resetTdsToleranceOverrides();
    setTdsIntegrator('trapezoidal');
    setTfText(String(DEFAULT_TDS_CONFIG.tf));
    setHText(DEFAULT_TDS_CONFIG.h === null ? '' : String(DEFAULT_TDS_CONFIG.h));
    setMaxRateText(String(DEFAULT_TDS_CONFIG.maxRateHz));
    setRtolText(String(DEFAULT_TDS_TOLERANCE_OVERRIDES.rtol));
    setAtolText(String(DEFAULT_TDS_TOLERANCE_OVERRIDES.atol));
    setMaxStepText(String(DEFAULT_TDS_TOLERANCE_OVERRIDES.maxStep));
  };

  return (
    <section
      data-testid="tds-config-panel"
      aria-label="TDS run configuration"
      className={cn('flex h-full flex-col gap-3 p-3', className)}
    >
      <header className="flex items-center justify-between">
        <h2 className="text-foreground text-sm font-semibold">TDS configuration</h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onReset}
          data-testid="tds-config-reset"
        >
          Reset
        </Button>
      </header>

      <p className="text-muted-foreground text-xs leading-snug">
        Parameters forwarded to the substrate when you click <strong>Run TDS</strong>.
      </p>

      <NumberField
        id="tds-config-tf"
        label="tf — final time (s)"
        value={tfText}
        onChange={(t) => setNumber('tf', t)}
        error={errors.tf}
        hint="Simulation horizon in seconds."
      />

      <NumberField
        id="tds-config-h"
        label="h — fixed step (s, optional)"
        value={hText}
        onChange={setHValue}
        error={errors.h}
        hint="Leave blank to let the substrate pick adaptively."
        placeholder="adaptive"
      />

      <fieldset
        className="flex flex-col gap-1.5"
        data-testid="tds-config-integrator"
      >
        <legend className="text-muted-foreground text-xs font-medium">
          Integrator
        </legend>
        {INTEGRATOR_OPTIONS.map((opt) => {
          const id = `tds-config-integrator-${opt.value}`;
          const checked = tdsIntegrator === opt.value;
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
                name="tds-config-integrator"
                checked={checked}
                onChange={() => setTdsIntegrator(opt.value)}
                className={cn(
                  'mt-0.5 h-3.5 w-3.5 border border-border',
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

      {tdsIntegrator === 'qndf-manual' ? (
        <div
          data-testid="tds-config-tolerance-overrides"
          className="flex flex-col gap-2 rounded border border-border/60 bg-muted/30 p-2"
        >
          <p className="text-muted-foreground text-[10px] leading-snug">
            QNDF tolerances. Tighter values give more accuracy at the cost
            of step count; too tight and the run may fail to advance.
          </p>
          <NumberField
            id="tds-config-rtol"
            label="rtol — relative tolerance"
            value={rtolText}
            onChange={(t) => setToleranceNumber('rtol', t)}
            error={toleranceErrors.rtol}
            hint="Maps to ANDES reltol."
          />
          <NumberField
            id="tds-config-atol"
            label="atol — absolute tolerance"
            value={atolText}
            onChange={(t) => setToleranceNumber('atol', t)}
            error={toleranceErrors.atol}
            hint="Maps to ANDES abstol."
          />
          <NumberField
            id="tds-config-max-step"
            label="max_step — upper bound on step (s)"
            value={maxStepText}
            onChange={(t) => setToleranceNumber('maxStep', t)}
            error={toleranceErrors.maxStep}
            hint="Maps to ANDES dtmax."
          />
        </div>
      ) : null}

      <fieldset
        className="flex flex-col gap-1.5"
        data-testid="tds-config-vars"
        aria-describedby="tds-config-vars-error"
      >
        <legend className="text-muted-foreground text-xs font-medium">
          Variable groups to stream
        </legend>
        {TDS_VAR_GROUPS.map((group) => {
          const id = `tds-config-var-${group}`;
          const checked = tdsConfig.vars.includes(group);
          return (
            <label
              key={group}
              htmlFor={id}
              className={cn(
                'flex items-start gap-2',
                'cursor-pointer rounded px-1 py-1',
                'hover:bg-muted/40 transition-colors',
              )}
            >
              <input
                id={id}
                data-testid={`tds-config-var-${group}`}
                type="checkbox"
                checked={checked}
                onChange={() => toggleVar(group)}
                className={cn(
                  'mt-0.5 h-3.5 w-3.5 rounded border border-border',
                  'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
                )}
              />
              <span className="flex flex-col">
                <span className="text-foreground text-xs">{VAR_GROUP_LABELS[group]}</span>
                <span className="text-muted-foreground text-[10px] leading-snug">
                  {VAR_GROUP_HINTS[group]}
                </span>
              </span>
            </label>
          );
        })}
        {errors.vars ? (
          <span
            id="tds-config-vars-error"
            role="alert"
            data-testid="error-tds-config-vars"
            className="text-destructive text-[10px]"
          >
            {errors.vars}
          </span>
        ) : null}
      </fieldset>

      <NumberField
        id="tds-config-max-rate"
        label="max_rate_hz — UI output clamp"
        value={maxRateText}
        onChange={(t) => setNumber('maxRateHz', t)}
        error={errors.maxRateHz}
        hint="Power-user override. Higher values raise memory + redraw cost."
      />

      <FieldRow
        id="tds-config-retention"
        label={`Retention — completed runs to keep (max ${MAX_RETENTION_LIMIT})`}
        hint={`The active run is always kept on top. Per-run memory budget shrinks as you raise this; default ${5}.`}
      >
        <div className="flex items-center gap-2">
          <input
            id="tds-config-retention"
            data-testid="field-tds-config-retention"
            type="range"
            min={1}
            max={MAX_RETENTION_LIMIT}
            step={1}
            value={retentionLimit}
            onChange={(e) => setRetentionLimit(Number(e.target.value))}
            aria-label="Retention limit"
            aria-valuemin={1}
            aria-valuemax={MAX_RETENTION_LIMIT}
            aria-valuenow={retentionLimit}
            className="flex-1"
          />
          <span
            data-testid="tds-config-retention-value"
            className="text-foreground w-8 text-right font-mono text-xs"
          >
            {retentionLimit}
          </span>
        </div>
      </FieldRow>
    </section>
  );
}

interface FieldRowProps {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}

function FieldRow({ id, label, error, hint, children }: FieldRowProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-muted-foreground text-xs font-medium">
        {label}
      </label>
      {children}
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
          className="text-destructive text-[10px]"
        >
          {error}
        </span>
      ) : null}
    </div>
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
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ') || undefined;
  return (
    <FieldRow id={id} label={label} error={error} hint={hint}>
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
          error ? 'border-destructive' : '',
        )}
      />
    </FieldRow>
  );
}
