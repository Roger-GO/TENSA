import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { FaultSpec } from '@/api/types';
import { BusIdxSelect } from '@/components/elements/BusIdxSelect';
import { BoltedFaultWarning } from '@/components/disturbance/BoltedFaultWarning';
import { cn } from '@/lib/cn';

/**
 * FaultSpecForm — fields for the substrate's ``FaultSpec`` shape (see
 * ``server/src/andes_app/core/disturbance.py``):
 *
 * - ``bus_idx``: bus dropdown from the active topology.
 * - ``tf``: fault-applied time (seconds).
 * - ``tc``: fault-cleared time (seconds). Must be > tf.
 * - ``xf``: fault reactance (pu, optional in the form sense — defaults
 *   to 0.05; see ``docs/spikes/2026-05-09-xf-default-empirical.md`` for the
 *   empirical justification of that default). When the user pushes ``xf``
 *   below 0.01 the ``BoltedFaultWarning`` advisory is rendered under the
 *   field — submit is still allowed (warn, don't block).
 * - ``rf``: fault resistance (pu, optional in the form sense — defaults
 *   to 0).
 *
 * NOTE: the plan's prose uses ``bus`` / ``t`` / ``tf`` for these field
 * names; the substrate uses ``bus_idx`` / ``tf`` / ``tc``. This form
 * follows the substrate (single source of truth — the wire shape).
 *
 * Validation:
 *
 * - ``bus_idx`` required.
 * - ``tf`` finite + ``tf >= 0``.
 * - ``tc`` finite + ``tc > tf``.
 * - ``xf``, ``rf`` finite if entered.
 *
 * The form is controlled — the parent (``DisturbanceForm``) owns the
 * spec value, this component only renders the inputs. ``onChange`` fires
 * on every keystroke; ``errors`` is recomputed on every render so the
 * parent can disable Save based on validity.
 */

export interface FaultSpecFormProps {
  spec: FaultSpec;
  onChange: (next: FaultSpec) => void;
  /** Surface validation errors to the parent so it can disable submit. */
  onValidityChange?: (errors: Record<string, string>) => void;
  className?: string;
}

export function FaultSpecForm({
  spec,
  onChange,
  onValidityChange,
  className,
}: FaultSpecFormProps) {
  // Keep the raw text inputs in local state so the user can clear a field
  // and re-type without it snapping back to the last-valid number on
  // every keystroke. The numeric values flow back into ``spec`` only on
  // successful parse.
  const [tfText, setTfText] = useState(String(spec.tf));
  const [tcText, setTcText] = useState(String(spec.tc));
  const [xfText, setXfText] = useState(String(spec.xf));
  const [rfText, setRfText] = useState(String(spec.rf));

  // Sync local text state when the spec is reset externally (e.g., on
  // edit-existing dialog open).
  useEffect(() => {
    setTfText(String(spec.tf));
    setTcText(String(spec.tc));
    setXfText(String(spec.xf));
    setRfText(String(spec.rf));
  }, [spec.bus_idx, spec.tf, spec.tc, spec.xf, spec.rf]);

  const errors = useMemo(() => {
    const out: Record<string, string> = {};
    if (!spec.bus_idx || String(spec.bus_idx).length === 0) {
      out.bus_idx = 'Required';
    }
    if (!Number.isFinite(spec.tf)) {
      out.tf = 'Enter a finite number';
    } else if (spec.tf < 0) {
      out.tf = 'Must be ≥ 0';
    }
    if (!Number.isFinite(spec.tc)) {
      out.tc = 'Enter a finite number';
    } else if (spec.tc <= spec.tf) {
      out.tc = 'Must be > tf';
    }
    if (!Number.isFinite(spec.xf)) {
      out.xf = 'Enter a finite number';
    }
    if (!Number.isFinite(spec.rf)) {
      out.rf = 'Enter a finite number';
    }
    return out;
  }, [spec]);

  useEffect(() => {
    onValidityChange?.(errors);
  }, [errors, onValidityChange]);

  const setNumber = (key: 'tf' | 'tc' | 'xf' | 'rf', text: string) => {
    if (key === 'tf') setTfText(text);
    else if (key === 'tc') setTcText(text);
    else if (key === 'xf') setXfText(text);
    else setRfText(text);
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      onChange({ ...spec, [key]: Number.NaN });
      return;
    }
    const parsed = Number(trimmed);
    onChange({ ...spec, [key]: parsed });
  };

  return (
    <div
      data-testid="fault-spec-form"
      className={cn('flex flex-col gap-3', className)}
    >
      <FieldRow
        id="fault-bus-idx"
        label="Bus"
        error={errors.bus_idx}
      >
        <BusIdxSelect
          id="fault-bus-idx"
          value={String(spec.bus_idx ?? '')}
          required
          onChange={(value) =>
            onChange({
              ...spec,
              // Coerce numeric bus idxes back to int so ANDES's setup() can
              // match against integer Bus.idx values. Most cases (IEEE 14,
              // IEEE 39, etc.) use integer idxes; sending the raw string
              // "16" makes setup() fail with "not exist with idx=16."
              // because ANDES does an exact-type compare. Non-numeric idxes
              // (e.g., user-named "BUS_X") pass through as strings.
              bus_idx: /^-?\d+$/.test(value) ? Number(value) : value,
            })
          }
        />
      </FieldRow>
      <NumberField
        id="fault-tf"
        label="tf — fault applied (s)"
        value={tfText}
        onChange={(t) => setNumber('tf', t)}
        error={errors.tf}
      />
      <NumberField
        id="fault-tc"
        label="tc — fault cleared (s)"
        value={tcText}
        onChange={(t) => setNumber('tc', t)}
        error={errors.tc}
      />
      <NumberField
        id="fault-xf"
        label="xf — fault reactance (pu)"
        value={xfText}
        onChange={(t) => setNumber('xf', t)}
        error={errors.xf}
      />
      <BoltedFaultWarning xf={spec.xf} />
      <NumberField
        id="fault-rf"
        label="rf — fault resistance (pu)"
        value={rfText}
        onChange={(t) => setNumber('rf', t)}
        error={errors.rf}
      />
    </div>
  );
}

interface FieldRowProps {
  id: string;
  label: string;
  error?: string;
  children: ReactNode;
}

function FieldRow({ id, label, error, children }: FieldRowProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-muted-foreground text-xs font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <span
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
}

function NumberField({ id, label, value, onChange, error }: NumberFieldProps) {
  return (
    <FieldRow id={id} label={label} error={error}>
      <input
        id={id}
        data-testid={`field-${id}`}
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'bg-background border-border h-7 rounded border px-2 font-mono text-xs',
          error ? 'border-destructive' : '',
        )}
      />
    </FieldRow>
  );
}
