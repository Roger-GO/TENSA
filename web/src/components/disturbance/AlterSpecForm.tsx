import { useEffect, useMemo, useState } from 'react';
import type { AlterSpec } from '@/api/types';
import { useAlterableParams, useCurrentTopology } from '@/api/queries';
import { cn } from '@/lib/cn';

/**
 * AlterSpecForm — fields for the substrate's ``AlterSpec`` shape (see
 * ``server/src/andes_app/core/disturbance.py``):
 *
 * - ``model``: ANDES model class name.
 * - ``dev_idx``: device idx, filtered from topology.
 * - ``src``: parameter name, populated from
 *   ``GET /sessions/{id}/topology/models/{model}/alterable_params``
 *   (Unit 1b endpoint, hook ``useAlterableParams``).
 * - ``t``: time the alter fires (seconds, must be ≥ 0).
 * - ``value``: new value (finite number).
 *
 * NOTE: the plan's prose uses ``dev`` for the field name; the substrate
 * uses ``dev_idx``.
 */

const ALTERABLE_MODELS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'Bus', label: 'Bus' },
  { value: 'Line', label: 'Line' },
  { value: 'PQ', label: 'PQ load' },
  { value: 'ZIP', label: 'ZIP load' },
  { value: 'PV', label: 'PV generator' },
  { value: 'Slack', label: 'Slack generator' },
  { value: 'GENROU', label: 'GENROU (synchronous)' },
  { value: 'GENCLS', label: 'GENCLS (classic)' },
  { value: 'Shunt', label: 'Shunt' },
  // Unit 8 dynamic-model whitelist additions. Until the topology endpoint
  // surfaces controller buckets, the device picker for these will read as
  // empty even on cases that contain instances; the parameter picker
  // (driven by useAlterableParams) populates correctly once a device is
  // selected by other means (idx pasted in via API, or follow-up unit
  // exposes a dynamic-device bucket).
  { value: 'IEEEX1', label: 'IEEEX1 (DC type-1 exciter)' },
  { value: 'ESDC2A', label: 'ESDC2A (PSS/E exciter)' },
  { value: 'SEXS', label: 'SEXS (simplified exciter)' },
  { value: 'IEEEG1', label: 'IEEEG1 (steam governor)' },
  { value: 'TGOV1', label: 'TGOV1 (single-lag governor)' },
  { value: 'IEEEST', label: 'IEEEST (PSS)' },
  { value: 'REGCA1', label: 'REGCA1 (renewable converter)' },
];

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
  }
  return bucket.map((e) => ({ idx: String(e.idx), name: e.name }));
}

export interface AlterSpecFormProps {
  spec: AlterSpec;
  onChange: (next: AlterSpec) => void;
  onValidityChange?: (errors: Record<string, string>) => void;
  className?: string;
}

export function AlterSpecForm({
  spec,
  onChange,
  onValidityChange,
  className,
}: AlterSpecFormProps) {
  const topology = useCurrentTopology();
  const devices = useMemo(
    () => devicesForModel(topology, spec.model),
    [topology, spec.model],
  );
  const paramsQuery = useAlterableParams(spec.model || null);
  const params = paramsQuery.data?.params ?? [];

  const [tText, setTText] = useState(String(spec.t));
  const [valueText, setValueText] = useState(String(spec.value));

  useEffect(() => {
    setTText(String(spec.t));
  }, [spec.t]);
  useEffect(() => {
    setValueText(String(spec.value));
  }, [spec.value]);

  const errors = useMemo(() => {
    const out: Record<string, string> = {};
    if (!spec.model) out.model = 'Required';
    if (!spec.dev_idx || String(spec.dev_idx).length === 0) {
      out.dev_idx = 'Required';
    }
    if (!spec.src || spec.src.length === 0) out.src = 'Required';
    if (!Number.isFinite(spec.t)) out.t = 'Enter a finite number';
    else if (spec.t < 0) out.t = 'Must be ≥ 0';
    if (!Number.isFinite(spec.value)) out.value = 'Enter a finite number';
    return out;
  }, [spec]);

  useEffect(() => {
    onValidityChange?.(errors);
  }, [errors, onValidityChange]);

  const setT = (text: string) => {
    setTText(text);
    const trimmed = text.trim();
    onChange({ ...spec, t: trimmed.length === 0 ? Number.NaN : Number(trimmed) });
  };
  const setValue = (text: string) => {
    setValueText(text);
    const trimmed = text.trim();
    onChange({ ...spec, value: trimmed.length === 0 ? Number.NaN : Number(trimmed) });
  };

  return (
    <div
      data-testid="alter-spec-form"
      className={cn('flex flex-col gap-3', className)}
    >
      <div className="flex flex-col gap-1">
        <label
          htmlFor="alter-model"
          className="text-muted-foreground text-xs font-medium"
        >
          Model
        </label>
        <select
          id="alter-model"
          data-testid="alter-model"
          value={spec.model}
          onChange={(e) =>
            // Reset dev_idx + src when the model changes — the device list
            // and the alterable-params list both depend on it.
            onChange({ ...spec, model: e.target.value, dev_idx: '', src: '' })
          }
          className="bg-background border-border h-7 rounded border px-2 text-xs"
        >
          {ALTERABLE_MODELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label
          htmlFor="alter-dev-idx"
          className="text-muted-foreground text-xs font-medium"
        >
          Device
        </label>
        <select
          id="alter-dev-idx"
          data-testid="alter-dev-idx"
          value={String(spec.dev_idx ?? '')}
          onChange={(e) => {
            const v = e.target.value;
            onChange({ ...spec, dev_idx: /^-?\d+$/.test(v) ? Number(v) : v });
          }}
          className={cn(
            'bg-background border-border h-7 rounded border px-2 font-mono text-xs',
            errors.dev_idx ? 'border-destructive' : '',
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
          <span
            role="alert"
            data-testid="error-alter-dev-idx"
            className="text-destructive text-[10px]"
          >
            {errors.dev_idx}
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <label
          htmlFor="alter-src"
          className="text-muted-foreground text-xs font-medium"
        >
          Parameter (src)
        </label>
        <select
          id="alter-src"
          data-testid="alter-src"
          value={spec.src}
          onChange={(e) => onChange({ ...spec, src: e.target.value })}
          disabled={paramsQuery.isLoading || params.length === 0}
          className={cn(
            'bg-background border-border h-7 rounded border px-2 font-mono text-xs',
            errors.src ? 'border-destructive' : '',
          )}
        >
          <option value="" disabled>
            {paramsQuery.isLoading
              ? 'Loading params…'
              : params.length === 0
                ? 'No alterable params for this model'
                : 'Pick a parameter…'}
          </option>
          {params.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        {errors.src ? (
          <span
            role="alert"
            data-testid="error-alter-src"
            className="text-destructive text-[10px]"
          >
            {errors.src}
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <label
          htmlFor="alter-t"
          className="text-muted-foreground text-xs font-medium"
        >
          t — apply at (s)
        </label>
        <input
          id="alter-t"
          data-testid="field-alter-t"
          type="text"
          inputMode="decimal"
          value={tText}
          onChange={(e) => setT(e.target.value)}
          className={cn(
            'bg-background border-border h-7 rounded border px-2 font-mono text-xs',
            errors.t ? 'border-destructive' : '',
          )}
        />
        {errors.t ? (
          <span
            role="alert"
            data-testid="error-alter-t"
            className="text-destructive text-[10px]"
          >
            {errors.t}
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <label
          htmlFor="alter-value"
          className="text-muted-foreground text-xs font-medium"
        >
          New value
        </label>
        <input
          id="alter-value"
          data-testid="field-alter-value"
          type="text"
          inputMode="decimal"
          value={valueText}
          onChange={(e) => setValue(e.target.value)}
          className={cn(
            'bg-background border-border h-7 rounded border px-2 font-mono text-xs',
            errors.value ? 'border-destructive' : '',
          )}
        />
        {errors.value ? (
          <span
            role="alert"
            data-testid="error-alter-value"
            className="text-destructive text-[10px]"
          >
            {errors.value}
          </span>
        ) : null}
      </div>
    </div>
  );
}
