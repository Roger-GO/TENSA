import { useEffect, useMemo, useState } from 'react';
import type { ToggleSpec } from '@/api/types';
import { useCurrentTopology } from '@/api/queries';
import { cn } from '@/lib/cn';

/**
 * ToggleSpecForm — fields for the substrate's ``ToggleSpec`` shape (see
 * ``server/src/andes_app/core/disturbance.py``):
 *
 * - ``model``: ANDES model class name (Line, GENROU, GENCLS, PV, Slack,
 *   PQ, ZIP, Shunt). Picker uses a fixed whitelist that matches the
 *   substrate's element-add whitelist.
 * - ``dev_idx``: ANDES idx of the device. Filtered from the active
 *   topology by the chosen ``model``.
 * - ``t``: time the toggle fires (seconds, must be ≥ 0).
 *
 * NOTE: the plan's prose uses ``dev`` for the field name; the substrate
 * uses ``dev_idx``. This form follows the substrate.
 */

const TOGGLEABLE_MODELS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'Line', label: 'Line' },
  { value: 'PV', label: 'PV generator' },
  { value: 'Slack', label: 'Slack generator' },
  { value: 'GENROU', label: 'GENROU (synchronous)' },
  { value: 'GENCLS', label: 'GENCLS (classic)' },
  { value: 'PQ', label: 'PQ load' },
  { value: 'ZIP', label: 'ZIP load' },
  { value: 'Shunt', label: 'Shunt' },
  // Unit 8 dynamic-model whitelist additions. Devices populate from the
  // ``controllers`` topology bucket added in Unit 8.1.
  { value: 'IEEEX1', label: 'IEEEX1 (DC type-1 exciter)' },
  { value: 'ESDC2A', label: 'ESDC2A (PSS/E exciter)' },
  { value: 'SEXS', label: 'SEXS (simplified exciter)' },
  { value: 'IEEEG1', label: 'IEEEG1 (steam governor)' },
  { value: 'TGOV1', label: 'TGOV1 (single-lag governor)' },
  { value: 'IEEEST', label: 'IEEEST (PSS)' },
  { value: 'REGCA1', label: 'REGCA1 (renewable converter)' },
];

const CONTROLLER_MODELS: ReadonlySet<string> = new Set([
  'IEEEX1',
  'ESDC2A',
  'SEXS',
  'IEEEG1',
  'TGOV1',
  'IEEEST',
  'REGCA1',
]);

export interface ToggleSpecFormProps {
  spec: ToggleSpec;
  onChange: (next: ToggleSpec) => void;
  onValidityChange?: (errors: Record<string, string>) => void;
  className?: string;
}

/**
 * Look up the topology bucket(s) that hold devices of ``model``. Returns
 * an array of ``TopologyEntry`` arrays so the dropdown can list them all
 * — generators live in the ``generators`` bucket regardless of subtype.
 */
function devicesForModel(
  topology: ReturnType<typeof useCurrentTopology>,
  model: string,
): Array<{ idx: string; name: string }> {
  if (!topology) return [];
  let bucket: typeof topology.lines = [];
  if (model === 'Line') bucket = [...topology.lines, ...topology.transformers];
  else if (model === 'Bus') bucket = topology.buses;
  else if (model === 'PV' || model === 'Slack' || model === 'GENROU' || model === 'GENCLS') {
    bucket = topology.generators.filter((g) => g.kind === model);
  } else if (model === 'PQ' || model === 'ZIP') {
    bucket = topology.loads.filter((l) => l.kind === model);
  } else if (model === 'Shunt') {
    bucket = topology.shunts ?? [];
  } else if (CONTROLLER_MODELS.has(model)) {
    bucket = (topology.controllers ?? []).filter((c) => c.kind === model);
  }
  return bucket.map((e) => ({ idx: String(e.idx), name: e.name }));
}

export function ToggleSpecForm({
  spec,
  onChange,
  onValidityChange,
  className,
}: ToggleSpecFormProps) {
  const topology = useCurrentTopology();
  const devices = useMemo(() => devicesForModel(topology, spec.model), [topology, spec.model]);
  const [tText, setTText] = useState(String(spec.t));

  useEffect(() => {
    setTText(String(spec.t));
  }, [spec.t]);

  const errors = useMemo(() => {
    const out: Record<string, string> = {};
    if (!spec.model) out.model = 'Required';
    if (!spec.dev_idx || String(spec.dev_idx).length === 0) {
      out.dev_idx = 'Required';
    }
    if (!Number.isFinite(spec.t)) out.t = 'Enter a finite number';
    else if (spec.t < 0) out.t = 'Must be ≥ 0';
    return out;
  }, [spec]);

  useEffect(() => {
    onValidityChange?.(errors);
  }, [errors, onValidityChange]);

  const setT = (text: string) => {
    setTText(text);
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      onChange({ ...spec, t: Number.NaN });
      return;
    }
    onChange({ ...spec, t: Number(trimmed) });
  };

  return (
    <div data-testid="toggle-spec-form" className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-col gap-1">
        <label htmlFor="toggle-model" className="text-muted-foreground text-xs font-medium">
          Model
        </label>
        <select
          id="toggle-model"
          data-testid="toggle-model"
          value={spec.model}
          onChange={(e) => onChange({ ...spec, model: e.target.value, dev_idx: '' })}
          className="bg-background border-border h-7 rounded border px-2 text-xs"
        >
          {TOGGLEABLE_MODELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="toggle-dev-idx" className="text-muted-foreground text-xs font-medium">
          Device
        </label>
        <select
          id="toggle-dev-idx"
          data-testid="toggle-dev-idx"
          value={String(spec.dev_idx ?? '')}
          onChange={(e) => {
            const v = e.target.value;
            // Coerce numeric idxes back to int — ANDES exact-type-matches
            // dev_idx against the model's idx values, which are integers
            // for Bus, Line, generators, etc.
            onChange({ ...spec, dev_idx: /^-?\d+$/.test(v) ? Number(v) : v });
          }}
          className={cn(
            'bg-background border-border h-7 rounded border px-2 font-mono text-xs',
            errors.dev_idx ? 'border-danger' : '',
          )}
          disabled={devices.length === 0}
        >
          <option value="" disabled>
            {devices.length === 0 ? `No ${spec.model}s in topology` : 'Pick a device…'}
          </option>
          {devices.map((d) => (
            <option key={d.idx} value={d.idx}>
              {d.idx} — {d.name}
            </option>
          ))}
        </select>
        {errors.dev_idx ? (
          <span role="alert" data-testid="error-toggle-dev-idx" className="text-danger text-[10px]">
            {errors.dev_idx}
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="toggle-t" className="text-muted-foreground text-xs font-medium">
          t — toggle time (s)
        </label>
        <input
          id="toggle-t"
          data-testid="field-toggle-t"
          type="text"
          inputMode="decimal"
          value={tText}
          onChange={(e) => setT(e.target.value)}
          className={cn(
            'bg-background border-border h-7 rounded border px-2 font-mono text-xs',
            errors.t ? 'border-danger' : '',
          )}
        />
        {errors.t ? (
          <span role="alert" data-testid="error-toggle-t" className="text-danger text-[10px]">
            {errors.t}
          </span>
        ) : null}
      </div>
    </div>
  );
}
