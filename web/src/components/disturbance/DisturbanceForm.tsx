import { useEffect, useMemo, useState } from 'react';
import type { DisturbanceSpec } from '@/api/types';
import { blankAlterSpec, blankFaultSpec, blankToggleSpec } from '@/store/disturbance';
import { useSessionStore } from '@/store/session';
import {
  allowedSpecKinds,
  allowedToggleTargets,
  engineDisturbanceKinds,
  engineLabel,
} from '@/lib/engines';
import { cn } from '@/lib/cn';
import { FaultSpecForm } from './FaultSpecForm';
import { ToggleSpecForm } from './ToggleSpecForm';
import { AlterSpecForm } from './AlterSpecForm';

/**
 * DisturbanceForm — discriminated dispatcher over the substrate's
 * ``FaultSpec | ToggleSpec | AlterSpec`` union, keyed by ``spec.kind``.
 *
 * Mirrors the shape of ``ElementForm`` from Unit 6 of v0.1: a kind
 * picker at the top + a kind-specific subform below. When the user
 * changes kind, the form swaps to a fresh blank spec for the new kind
 * (the previous draft is discarded, matching the v0.1 ElementForm
 * pattern).
 */

const KIND_OPTIONS: ReadonlyArray<{ value: DisturbanceSpec['kind']; label: string }> = [
  { value: 'fault', label: 'Fault' },
  { value: 'toggle', label: 'Toggle' },
  { value: 'alter', label: 'Alter' },
];

export interface DisturbanceFormProps {
  /** Current draft spec. Owned by the parent (the dialog or panel). */
  spec: DisturbanceSpec;
  onChange: (next: DisturbanceSpec) => void;
  /** Called whenever the validity of the current sub-form changes. */
  onValidityChange?: (errors: Record<string, string>) => void;
  /** Optional: hide the kind picker (used in edit-existing mode). */
  hideKindPicker?: boolean;
  className?: string;
}

export function DisturbanceForm({
  spec,
  onChange,
  onValidityChange,
  hideKindPicker,
  className,
}: DisturbanceFormProps) {
  const [errors, setErrors] = useState<Record<string, string>>({});

  // What the session's engine accepts: null (ANDES, or a list not loaded)
  // offers every kind as today.
  const engine = useSessionStore((s) => s.engine);
  const engines = useSessionStore((s) => s.engines);
  const disturbanceKinds = engineDisturbanceKinds(engines, engine);
  const allowed = allowedSpecKinds(disturbanceKinds);
  const toggleTargets = allowedToggleTargets(disturbanceKinds);
  const kindAllowed = allowed.has(spec.kind);

  // Memoize the validity callback so the sub-forms' useEffect doesn't fire
  // on every parent render.
  const handleValidity = useMemo(() => (next: Record<string, string>) => setErrors(next), []);

  useEffect(() => {
    onValidityChange?.(errors);
  }, [errors, onValidityChange]);

  const onKindChange = (next: DisturbanceSpec['kind']) => {
    if (next === 'fault') onChange(blankFaultSpec());
    else if (next === 'toggle') onChange(blankToggleSpec());
    else onChange(blankAlterSpec());
  };

  return (
    <div data-testid="disturbance-form" className={cn('flex flex-col gap-3', className)}>
      {!hideKindPicker ? (
        <div className="flex flex-col gap-1">
          <label htmlFor="disturbance-kind" className="text-muted-foreground text-xs font-medium">
            Kind
          </label>
          <select
            id="disturbance-kind"
            data-testid="disturbance-kind"
            value={spec.kind}
            onChange={(e) => onKindChange(e.target.value as DisturbanceSpec['kind'])}
            className="bg-background border-border h-8 rounded border px-2 text-sm"
          >
            {KIND_OPTIONS.filter((k) => allowed.has(k.value) || k.value === spec.kind).map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {!kindAllowed ? (
        <p
          data-testid="disturbance-kind-not-available"
          className="text-muted-foreground text-[10px] leading-snug"
        >
          This disturbance kind is not available with the {engineLabel(engine ?? '')} engine.
        </p>
      ) : null}
      {kindAllowed && spec.kind === 'fault' ? (
        <FaultSpecForm
          spec={spec}
          onChange={(next) => onChange(next)}
          onValidityChange={handleValidity}
        />
      ) : null}
      {kindAllowed && spec.kind === 'toggle' ? (
        <ToggleSpecForm
          spec={spec}
          onChange={(next) => onChange(next)}
          onValidityChange={handleValidity}
          allowedTargets={toggleTargets ?? undefined}
        />
      ) : null}
      {kindAllowed && spec.kind === 'alter' ? (
        <AlterSpecForm
          spec={spec}
          onChange={(next) => onChange(next)}
          onValidityChange={handleValidity}
        />
      ) : null}
    </div>
  );
}
