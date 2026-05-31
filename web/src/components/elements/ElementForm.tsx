import { useEffect, useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useCurrentTopology, useTopologySchema } from '@/api/queries';
import type { ParamValue, TopologyEntry, TopologyParamMeta, TopologySummary } from '@/api/types';
import { cn } from '@/lib/cn';
import { BusIdxSelect } from './BusIdxSelect';
import { GenIdxSelect } from './GenIdxSelect';
import { SynIdxSelect } from './SynIdxSelect';

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
  /** Optional UI-side kind label distinct from `model`; used for the
   *  Submit button label and for prefill keying (e.g., the kind picker
   *  shows "Transformer2W" but the model is "Line"). */
  kindHint?: string;
  /** Initial values applied when the form mounts and the user hasn't
   *  touched a field yet (e.g., transformer adds default tap to 1.05). */
  defaultParams?: Record<string, string | number | boolean>;
  saving: boolean;
  serverError: string | null;
  onSubmit: (params: Record<string, ParamValue>) => void;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  className?: string;
}

const ADVANCED_THRESHOLD = 10;

/**
 * Compute the next-available idx for a given model, used to prefill the
 * `idx` field on Add. Looks at the existing topology and returns either
 * a numeric next or a kind-prefixed next, depending on how the existing
 * idxs are shaped.
 */
function nextAvailableIdx(model: string, topology: TopologySummary | null): string {
  if (!topology) return '1';
  const bucket = bucketForModel(topology, model);
  const existing = bucket.map((e) => String(e.idx));
  if (existing.length === 0) {
    return defaultPrefixFor(model) + '1';
  }
  // If every existing idx is purely numeric, return max + 1 as numeric.
  const allNumeric = existing.every((s) => /^\d+$/.test(s));
  if (allNumeric) {
    const max = Math.max(...existing.map((s) => Number.parseInt(s, 10)));
    return String(max + 1);
  }
  // Otherwise look for a shared alphabetic prefix; bump the numeric tail.
  const prefixes = new Set(existing.map((s) => s.replace(/\d+$/, '')));
  if (prefixes.size === 1) {
    const prefix = [...prefixes][0]!;
    let max = 0;
    for (const s of existing) {
      const m = /(\d+)$/.exec(s);
      if (m) max = Math.max(max, Number.parseInt(m[1]!, 10));
    }
    return `${prefix}${max + 1}`;
  }
  // Heterogeneous idxs — fall back to a kind-prefixed counter.
  return defaultPrefixFor(model) + (existing.length + 1);
}

function bucketForModel(topology: TopologySummary, model: string): TopologyEntry[] {
  if (model === 'Bus') return topology.buses;
  if (model === 'Line') return [...(topology.lines ?? []), ...(topology.transformers ?? [])];
  if (['PV', 'Slack', 'GENROU', 'GENCLS'].includes(model))
    return (topology.generators ?? []).filter((g) => g.kind === model);
  if (['PQ', 'ZIP'].includes(model)) return (topology.loads ?? []).filter((l) => l.kind === model);
  if (model === 'Shunt') return topology.shunts ?? [];
  return [];
}

function defaultPrefixFor(model: string): string {
  if (model === 'Bus') return '';
  if (model === 'Line') return 'L';
  if (model === 'Shunt') return 'SH';
  // Generators / loads use the model name as prefix.
  return `${model}_`;
}

function existingIdxSetFor(topology: TopologySummary | null, model: string): Set<string> {
  if (!topology) return new Set();
  return new Set(bucketForModel(topology, model).map((e) => String(e.idx)));
}

function emptyValueFor(meta: TopologyParamMeta): ParamValue {
  if (meta.kind === 'bool') return false;
  if (meta.kind === 'number') return '';
  return '';
}

export function ElementForm({
  model,
  kindHint,
  defaultParams,
  saving,
  serverError,
  onSubmit,
  onCancel,
  onDirtyChange,
  className,
}: ElementFormProps) {
  const baseId = useId();
  const schema = useTopologySchema();
  const topology = useCurrentTopology();
  const params: TopologyParamMeta[] = useMemo(
    () => schema.data?.models[model] ?? [],
    [schema.data, model],
  );

  const existingIdxs = useMemo(() => existingIdxSetFor(topology, model), [topology, model]);

  const seedValues = (
    metas: TopologyParamMeta[],
    topo: TopologySummary | null,
    defaults: Record<string, string | number | boolean> | undefined,
  ): Record<string, ParamValue> => {
    const init: Record<string, ParamValue> = {};
    for (const m of metas) {
      if (m.name === 'idx') {
        init[m.name] = nextAvailableIdx(model, topo);
      } else {
        init[m.name] = emptyValueFor(m);
      }
    }
    if (defaults) {
      for (const [k, v] of Object.entries(defaults)) init[k] = v;
    }
    return init;
  };

  const [values, setValues] = useState<Record<string, ParamValue>>(() =>
    seedValues(params, topology, defaultParams),
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  // Track which fields the USER has touched (vs. fields seeded by
  // prefill / defaults). Dirty state hangs off this rather than a
  // values-vs-empty comparison so prefilled idxs don't trip the
  // CancelConfirmDialog.
  const [touched, setTouched] = useState<Set<string>>(new Set());

  // Re-seed values when the model OR kindHint changes — kindHint
  // changes when the user picks a different option in the kind picker
  // (e.g., Bus → Line) so the form should reset rather than keep stale
  // bus-form values.
  useEffect(() => {
    setValues(seedValues(params, topology, defaultParams));
    setShowAdvanced(false);
    setValidationErrors({});
    setTouched(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, model, kindHint]);

  const dirty = touched.size > 0;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const required = params.filter((m) => m.required);
  const optional = params.filter((m) => !m.required);
  const hasAdvanced = optional.length > 0;
  const useDivider = params.length > ADVANCED_THRESHOLD;

  const setField = (name: string, value: ParamValue) => {
    setValues((curr) => ({ ...curr, [name]: value }));
    setTouched((curr) => {
      if (curr.has(name)) return curr;
      const next = new Set(curr);
      next.add(name);
      return next;
    });
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
      // Reject duplicate idx client-side so the user sees the conflict
      // before the server roundtrip rejects it (Issue 6).
      if (m.name === 'idx' && typeof v === 'string' && v !== '') {
        if (existingIdxs.has(v)) {
          errs[m.name] = `idx "${v}" is already taken`;
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
            <span className="text-danger" aria-hidden="true">
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
          ) : m.kind === 'gen_idx' ? (
            <GenIdxSelect
              id={inputId}
              value={String(value)}
              onChange={(v) => setField(m.name, v)}
              required={m.required}
              aria-describedby={error ? errorId : undefined}
            />
          ) : m.kind === 'syn_idx' ? (
            <SynIdxSelect
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
          {m.unit ? <span className="text-muted-foreground text-[10px]">{m.unit}</span> : null}
        </span>
        {error ? (
          <span id={errorId} role="alert" className="text-danger text-[10px]">
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
          <fieldset className="mt-2 flex flex-col gap-2">{optional.map(renderField)}</fieldset>
        </details>
      ) : null}
      {serverError ? (
        <div
          role="alert"
          data-testid="form-server-error"
          className="border-danger/30 bg-danger/10 text-foreground rounded-[var(--radius-sm)] border px-2 py-1.5 text-xs"
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
