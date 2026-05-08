import { useEffect, useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTopologySchema } from '@/api/queries';
import type { ParamValue, TopologyParamMeta } from '@/api/types';
import { cn } from '@/lib/cn';
import { BusIdxSelect } from './BusIdxSelect';

/**
 * ElementForm — polymorphic form generated from `_PARAMS_BY_MODEL`
 * (server-side; consumed via `GET /api/topology/schema`).
 *
 * Layout:
 *
 * - Required fields render first under a "Required" header.
 * - Optional fields collapse under a "Show advanced ▾" disclosure.
 * - Forms with >10 fields get a section divider between groups.
 *
 * Each numeric input shows its `unit` suffix inline. Each `bus_idx`
 * field renders BusIdxSelect (dropdown of existing buses). Each `bool`
 * field renders a checkbox.
 *
 * Validation: client-side required checks before submit; the surface
 * for server-side rejections (422 ProblemDetails) is supplied by the
 * caller via `onError`.
 */
export interface ElementFormProps {
  model: string;
  saving: boolean;
  serverError: string | null;
  onSubmit: (params: Record<string, ParamValue>) => void;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  className?: string;
}

const ADVANCED_THRESHOLD = 10;

function emptyValueFor(meta: TopologyParamMeta): ParamValue {
  if (meta.kind === 'bool') return false;
  if (meta.kind === 'number') return '';
  return '';
}

export function ElementForm({
  model,
  saving,
  serverError,
  onSubmit,
  onCancel,
  onDirtyChange,
  className,
}: ElementFormProps) {
  const baseId = useId();
  const schema = useTopologySchema();
  const params: TopologyParamMeta[] = useMemo(
    () => schema.data?.models[model] ?? [],
    [schema.data, model],
  );

  const [values, setValues] = useState<Record<string, ParamValue>>(() => {
    const init: Record<string, ParamValue> = {};
    for (const m of params) init[m.name] = emptyValueFor(m);
    return init;
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

  // Re-seed values when the model changes — schema lookup may resolve
  // after the panel mounts.
  useEffect(() => {
    const next: Record<string, ParamValue> = {};
    for (const m of params) next[m.name] = emptyValueFor(m);
    setValues(next);
    setShowAdvanced(false);
    setValidationErrors({});
  }, [params, model]);

  const dirty = useMemo(() => {
    for (const m of params) {
      const v = values[m.name];
      if (m.kind === 'bool') {
        if (v !== false) return true;
      } else {
        if (v !== '' && v !== undefined) return true;
      }
    }
    return false;
  }, [values, params]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const required = params.filter((m) => m.required);
  const optional = params.filter((m) => !m.required);
  const hasAdvanced = optional.length > 0;
  const useDivider = params.length > ADVANCED_THRESHOLD;

  const setField = (name: string, value: ParamValue) => {
    setValues((curr) => ({ ...curr, [name]: value }));
    setValidationErrors((curr) => {
      if (!(name in curr)) return curr;
      const next = { ...curr };
      delete next[name];
      return next;
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const errs: Record<string, string> = {};
    const out: Record<string, ParamValue> = {};
    for (const m of params) {
      const v = values[m.name];
      if (m.required) {
        if (m.kind === 'bool') {
          // Booleans always have a value; nothing to validate.
        } else if (v === '' || v === undefined) {
          errs[m.name] = 'Required';
          continue;
        }
      }
      // Skip empty optional fields entirely so the substrate falls
      // back to ANDES's own defaults instead of receiving "" / NaN.
      if (!m.required && (v === '' || v === undefined)) continue;
      if (m.kind === 'number') {
        const n = Number(v);
        if (!Number.isFinite(n)) {
          errs[m.name] = 'Enter a finite number';
          continue;
        }
        out[m.name] = n;
      } else if (m.kind === 'bool') {
        out[m.name] = Boolean(v);
      } else {
        out[m.name] = String(v);
      }
    }
    if (Object.keys(errs).length > 0) {
      setValidationErrors(errs);
      return;
    }
    onSubmit(out);
  };

  if (schema.isLoading || params.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        {schema.isLoading ? 'Loading model schema…' : `No schema for model "${model}".`}
      </p>
    );
  }

  const renderField = (m: TopologyParamMeta) => {
    const inputId = `${baseId}-${m.name}`;
    const errorId = `${inputId}-error`;
    const value = values[m.name] ?? emptyValueFor(m);
    const error = validationErrors[m.name];
    return (
      <label
        key={m.name}
        htmlFor={inputId}
        className="flex flex-col gap-0.5"
        data-testid={`field-${m.name}`}
      >
        <span className="text-muted-foreground flex items-center gap-1 font-mono text-xs">
          <span>{m.name}</span>
          {m.required ? (
            <span className="text-destructive" aria-hidden="true">
              *
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-1">
          {m.kind === 'bus_idx' ? (
            <BusIdxSelect
              id={inputId}
              value={String(value)}
              onChange={(v) => setField(m.name, v)}
              required={m.required}
              aria-describedby={error ? errorId : undefined}
            />
          ) : m.kind === 'bool' ? (
            <input
              id={inputId}
              type="checkbox"
              checked={Boolean(value)}
              disabled={saving}
              onChange={(e) => setField(m.name, e.target.checked)}
              className="h-4 w-4"
            />
          ) : (
            <input
              id={inputId}
              type={m.kind === 'number' ? 'number' : 'text'}
              inputMode={m.kind === 'number' ? 'decimal' : 'text'}
              step="any"
              value={String(value)}
              required={m.required}
              disabled={saving}
              onChange={(e) => setField(m.name, e.target.value)}
              aria-describedby={error ? errorId : undefined}
              className="bg-background border-border h-7 w-32 rounded border px-2 font-mono text-xs"
            />
          )}
          {m.unit ? (
            <span className="text-muted-foreground text-[10px]">{m.unit}</span>
          ) : null}
        </span>
        {error ? (
          <span id={errorId} role="alert" className="text-destructive text-[10px]">
            {error}
          </span>
        ) : null}
      </label>
    );
  };

  return (
    <form
      onSubmit={handleSubmit}
      className={cn('flex flex-col gap-3', className)}
      data-testid={`element-form-${model}`}
    >
      {required.length > 0 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-foreground text-xs font-semibold">Required</legend>
          {required.map(renderField)}
        </fieldset>
      ) : null}
      {hasAdvanced ? (
        <details
          open={showAdvanced}
          className={useDivider ? 'border-border border-t pt-2' : undefined}
          onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}
          data-testid="form-advanced-disclosure"
        >
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs font-medium">
            Show advanced ▾
          </summary>
          <fieldset className="mt-2 flex flex-col gap-2">
            {optional.map(renderField)}
          </fieldset>
        </details>
      ) : null}
      {serverError ? (
        <div
          role="alert"
          data-testid="form-server-error"
          className="border-destructive/30 bg-destructive/10 text-foreground rounded-[var(--radius-sm)] border px-2 py-1.5 text-xs"
        >
          {serverError}
        </div>
      ) : null}
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={saving}>
          {saving ? 'Saving…' : `Add ${model}`}
        </Button>
      </div>
    </form>
  );
}
