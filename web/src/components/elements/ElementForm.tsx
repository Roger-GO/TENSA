import { useEffect, useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useCurrentTopology, useTopologyRefetching, useTopologySchema } from '@/api/queries';
import type { ParamValue, TopologyEntry, TopologyParamMeta, TopologySummary } from '@/api/types';
import { cn } from '@/lib/cn';
import { BusIdxSelect } from './BusIdxSelect';
import { GenIdxSelect } from './GenIdxSelect';
import { SynIdxSelect } from './SynIdxSelect';
import { elementHelp, elementWarnings, namedAfterIdx } from './elementHelp';
import {
  followLink,
  freeGeneratorOn,
  generatorsByBus,
  linkWarnings,
  staticGenerators,
} from './genLink';

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
 * A model whose parameters need more than a name (`elementHelp`) gets a note
 * above the fields, a line under the fields it explains, and a warning under a
 * field whose value is allowed but worth a second look.
 *
 * A model that takes over a static generator has a `bus` and a `gen` that must
 * agree (`genLink`). Its bus list names the generator on each bus, picking one
 * of the two sets the other with a line that says so, and a bus without a
 * generator or a generator a device already uses gets a warning. Under the
 * warning of a bus without a generator is a button that goes and adds one
 * there (`onAddGenerator`), which is the only way on for a device meant for
 * that bus.
 *
 * Validation is the form's own (`noValidate`): the browser's bubble on the
 * first empty field is gone the moment it is clicked away, says nothing of
 * the other fields, and never reaches a reader that works from the page's
 * text. A submit that cannot go says "Required" under each empty field,
 * names the fields in one line above the buttons, and puts the cursor in
 * the first of them, which scrolls it into view. What the server refuses
 * (422 ProblemDetails) is the caller's to show, via `serverError`.
 *
 * `seedBus` opens the form on a bus (the diagram's "Add element here"): the
 * first bus field starts there, and a device tied to a static generator gets
 * the one on that bus while no device uses it. A generator the form chose
 * that way is given up once the case says a device took it, so the form that
 * comes back after a battery was added there asks for a generator again.
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
  /** A field was changed: what `serverError` says is about values no longer in the form. */
  onEdit?: () => void;
  /** The bus the form opens on, or nothing. A bus the case does not have is ignored. */
  seedBus?: string | null;
  /**
   * The user asked for a static generator on `bus`, from the form of a device
   * that needs one there and found none. Without it the form only warns.
   */
  onAddGenerator?: (bus: string) => void;
  className?: string;
}

const ADVANCED_THRESHOLD = 10;

/** A line under a field that a pick elsewhere set, saying why. */
interface LinkNote {
  field: string;
  text: string;
}

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
  // Everything else the form adds is a controller: an exciter, a governor, a
  // battery. They are listed together, each under its own model.
  return (topology.controllers ?? []).filter((c) => c.kind === model);
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

/** Whether the field is a list to pick from, not a box to type in. */
function isPick(meta: TopologyParamMeta): boolean {
  return meta.kind === 'bus_idx' || meta.kind === 'gen_idx' || meta.kind === 'syn_idx';
}

/** What an empty required field says under itself. */
function missingText(meta: TopologyParamMeta): string {
  return isPick(meta) ? 'Required. Pick one from the list.' : 'Required. Enter a value.';
}

/** "En", "Sn and Vn", "Sn, Vn and p0". */
function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The line above the buttons after a submit that could not go: which fields
 * are empty, and which hold a value the form refuses, by name.
 */
function problemSummary(missing: readonly string[], refused: readonly string[]): string {
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`${listOf(missing)} ${missing.length === 1 ? 'is' : 'are'} required and empty`);
  }
  if (refused.length > 0) {
    parts.push(
      `${listOf(refused)} ${refused.length === 1 ? 'holds' : 'hold'} a value that cannot be used`,
    );
  }
  return `Nothing was added: ${parts.join(', and ')}.`;
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
  onEdit,
  seedBus,
  onAddGenerator,
  className,
}: ElementFormProps) {
  const baseId = useId();
  const schema = useTopologySchema();
  const topology = useCurrentTopology();
  // The case is being read again, so `topology` may be behind it.
  const refetching = useTopologyRefetching();
  const params: TopologyParamMeta[] = useMemo(
    () => schema.data?.models[model] ?? [],
    [schema.data, model],
  );

  const existingIdxs = useMemo(() => existingIdxSetFor(topology, model), [topology, model]);
  const baseMva = topology?.base_mva ?? null;
  const help = useMemo(() => elementHelp(model, { baseMva }), [model, baseMva]);
  // Only a form with both fields ties them: a PV has a bus and no `gen`.
  const linksGen =
    params.some((m) => m.name === 'bus' && m.kind === 'bus_idx') &&
    params.some((m) => m.name === 'gen' && m.kind === 'gen_idx');
  const staticGens = useMemo(
    () => (linksGen ? staticGenerators(topology) : []),
    [linksGen, topology],
  );
  const busNotes = useMemo(() => generatorsByBus(staticGens), [staticGens]);

  // What the form opens with: the values, the generator a seeded bus brought
  // along (`suggested`), and what to say under it.
  const seed = (
    metas: TopologyParamMeta[],
    topo: TopologySummary | null,
    defaults: Record<string, string | number | boolean> | undefined,
  ): { values: Record<string, ParamValue>; suggested: string | null; note: LinkNote | null } => {
    const init: Record<string, ParamValue> = {};
    for (const m of metas) {
      if (m.name === 'idx') {
        init[m.name] = nextAvailableIdx(model, topo);
      } else {
        init[m.name] = emptyValueFor(m);
      }
    }
    if (namedAfterIdx(model) && 'idx' in init && 'name' in init) init.name = init.idx;
    if (defaults) {
      for (const [k, v] of Object.entries(defaults)) init[k] = v;
    }
    // A line has two bus fields: the bus it was opened on is where it starts.
    const busField = metas.find((m) => m.kind === 'bus_idx');
    const onCase = (topo?.buses ?? []).some((b) => String(b.idx) === seedBus);
    const plain = { values: init, suggested: null, note: null };
    if (!seedBus || busField === undefined || !onCase) return plain;
    init[busField.name] = seedBus;
    if (!linksGen || busField.name !== 'bus') return plain;
    // A seed is not a pick: the form opens like this again after each add, and
    // a second battery on the first one's generator is not a default. That
    // form is back before the case has been read again, when `topo` still
    // calls the generator free, so nothing is chosen until the read is in.
    const linked = refetching ? null : freeGeneratorOn(seedBus, staticGenerators(topo));
    if (linked === null) return plain;
    init.gen = linked.gen;
    return { values: init, suggested: linked.gen, note: linked.note };
  };

  // One seed for both pieces of state: `useState` reads its argument once.
  const [opening] = useState(() => seed(params, topology, defaultParams));
  const [values, setValues] = useState<Record<string, ParamValue>>(opening.values);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  // Track which fields the USER has touched (vs. fields seeded by
  // prefill / defaults). Dirty state hangs off this rather than a
  // values-vs-empty comparison so prefilled idxs don't trip the
  // CancelConfirmDialog.
  const [touched, setTouched] = useState<Set<string>>(new Set());
  // The field a pick of `bus` or `gen` set besides itself, and why.
  const [linkNote, setLinkNote] = useState<LinkNote | null>(opening.note);
  // The generator the form chose itself, for a bus it opened on or a bus that
  // gained one, until the user picks a bus or a generator.
  const [suggestedGen, setSuggestedGen] = useState<string | null>(opening.suggested);
  // The field a refused submit puts the cursor in. An object, so that a second
  // refusal of the same field moves the cursor back to it.
  const [focusRequest, setFocusRequest] = useState<{ name: string } | null>(null);

  // Re-seed values when the model OR kindHint changes — kindHint
  // changes when the user picks a different option in the kind picker
  // (e.g., Bus → Line) so the form should reset rather than keep stale
  // bus-form values.
  useEffect(() => {
    const fresh = seed(params, topology, defaultParams);
    setValues(fresh.values);
    setShowAdvanced(false);
    setValidationErrors({});
    setTouched(new Set());
    setLinkNote(fresh.note);
    setSuggestedGen(fresh.suggested);
    setFocusRequest(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, model, kindHint]);

  // After the render that shows the errors (and opens the advanced fields when
  // the first of them is there), so the field exists and can take the cursor.
  useEffect(() => {
    if (focusRequest === null) return;
    document.getElementById(`${baseId}-${focusRequest.name}`)?.focus();
  }, [focusRequest, baseId]);

  const dirty = touched.size > 0;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // The idx proposed is the next free one, and the case can gain an element
  // while the form is open: the form is reset after an add a moment before the
  // topology has the new element. The proposal follows the case until the
  // user types an idx of their own.
  const idxTouched = touched.has('idx');
  const nameTouched = touched.has('name');
  useEffect(() => {
    if (idxTouched) return;
    const proposed = nextAvailableIdx(model, topology);
    setValues((curr) => {
      if (!('idx' in curr) || curr.idx === proposed) return curr;
      const follows = namedAfterIdx(model) && 'name' in curr && !nameTouched;
      return follows ? { ...curr, idx: proposed, name: proposed } : { ...curr, idx: proposed };
    });
  }, [model, topology, idxTouched, nameTouched]);

  // The same goes for the generator of the bus: a PV added for this device is
  // in the case a moment after the form that asked for it is back. A generator
  // nobody picked yet follows the case both ways. It goes to the free one on
  // the bus once the case has it, though not while the case is being read
  // again (`seed`). And it leaves the one the form chose once a device has
  // taken it, so the field is empty and the add refused until the user picks.
  // A generator the user picked, by itself or with its bus, stays.
  const genTouched = touched.has('gen');
  const busValue = String(values.bus ?? '');
  const genValue = String(values.gen ?? '');
  useEffect(() => {
    if (!linksGen || genTouched || busValue === '') return;
    if (genValue === '') {
      if (refetching) return;
      const linked = freeGeneratorOn(busValue, staticGens);
      if (linked === null) return;
      setValues((curr) => ({ ...curr, gen: linked.gen }));
      setLinkNote(linked.note);
      setSuggestedGen(linked.gen);
      return;
    }
    if (genValue !== suggestedGen) return;
    if (!staticGens.some((g) => g.idx === genValue && g.takenBy.length > 0)) return;
    setValues((curr) => ({ ...curr, gen: '' }));
    setLinkNote(null);
    setSuggestedGen(null);
  }, [linksGen, refetching, genTouched, busValue, genValue, suggestedGen, staticGens]);

  const warnings = useMemo<Record<string, string>>(
    () => ({
      ...(linksGen
        ? linkWarnings({ bus: String(values.bus ?? ''), gen: String(values.gen ?? '') }, staticGens)
        : {}),
      ...elementWarnings(model, values, { baseMva }),
    }),
    [model, values, baseMva, linksGen, staticGens],
  );

  // The device needs a static generator on its bus, and the bus picked has none.
  const busLacksGenerator =
    linksGen && busValue !== '' && !staticGens.some((g) => g.bus === busValue);

  const required = params.filter((m) => m.required);
  const optional = params.filter((m) => !m.required);
  const hasAdvanced = optional.length > 0;
  const useDivider = params.length > ADVANCED_THRESHOLD;

  const setField = (name: string, value: ParamValue) => {
    onEdit?.();
    const next = { ...values, [name]: value };
    // The name goes with the idx until the user gives it one of its own.
    if (name === 'idx' && namedAfterIdx(model) && 'name' in values && !touched.has('name')) {
      next.name = value;
    }
    if (linksGen && (name === 'bus' || name === 'gen')) {
      const linked = followLink(
        name,
        { bus: String(next.bus ?? ''), gen: String(next.gen ?? '') },
        staticGens,
      );
      next.bus = linked.bus;
      next.gen = linked.gen;
      setLinkNote(linked.note);
      // From here on the generator is the user's, whichever field was picked.
      setSuggestedGen(null);
    }
    setValues(next);
    setTouched((curr) => {
      if (curr.has(name)) return curr;
      const marked = new Set(curr);
      marked.add(name);
      return marked;
    });
    setValidationErrors((curr) => {
      if (!(name in curr)) return curr;
      const kept = { ...curr };
      delete kept[name];
      return kept;
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
          errs[m.name] = missingText(m);
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
      // In the order the fields are shown: the required ones, then the advanced.
      const first = [...required, ...optional].find((m) => m.name in errs);
      if (first !== undefined) {
        if (!first.required) setShowAdvanced(true);
        setFocusRequest({ name: first.name });
      }
      return;
    }
    onSubmit(out);
  };

  // Follows the fields as they are put right: an edit takes its field's error away.
  const problems = [...required, ...optional].filter((m) => m.name in validationErrors);
  const isEmpty = (m: TopologyParamMeta) => values[m.name] === '' || values[m.name] === undefined;
  const missing = problems.filter(isEmpty).map((m) => m.name);
  const refused = problems.filter((m) => !isEmpty(m)).map((m) => m.name);

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
    const helpId = `${inputId}-help`;
    const noteId = `${inputId}-note`;
    const warningId = `${inputId}-warning`;
    const value = values[m.name] ?? emptyValueFor(m);
    const error = validationErrors[m.name];
    const fieldHelp = help?.fields[m.name];
    const note = linkNote?.field === m.name ? linkNote.text : undefined;
    const warning = warnings[m.name];
    // Everything said about the field is read out with it.
    const describedBy =
      [
        fieldHelp ? helpId : null,
        note ? noteId : null,
        warning ? warningId : null,
        error ? errorId : null,
      ]
        .filter((id) => id !== null)
        .join(' ') || undefined;
    const field = (
      <label htmlFor={inputId} className="flex flex-col gap-0.5" data-testid={`field-${m.name}`}>
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
              aria-describedby={describedBy}
              aria-invalid={error !== undefined}
              notes={linksGen && m.name === 'bus' ? busNotes : undefined}
            />
          ) : m.kind === 'gen_idx' ? (
            <GenIdxSelect
              id={inputId}
              value={String(value)}
              onChange={(v) => setField(m.name, v)}
              required={m.required}
              aria-describedby={describedBy}
              aria-invalid={error !== undefined}
            />
          ) : m.kind === 'syn_idx' ? (
            <SynIdxSelect
              id={inputId}
              value={String(value)}
              onChange={(v) => setField(m.name, v)}
              required={m.required}
              aria-describedby={describedBy}
              aria-invalid={error !== undefined}
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
              aria-describedby={describedBy}
              aria-invalid={error ? true : undefined}
              className={cn(
                'bg-background h-7 w-32 rounded border px-2 font-mono text-xs',
                error ? 'border-danger' : 'border-border',
              )}
            />
          )}
          {m.unit ? <span className="text-muted-foreground text-[10px]">{m.unit}</span> : null}
        </span>
      </label>
    );
    // Beside the label, not in it: what is said here describes the field and
    // is not part of its name, the refusal of a submit included. The wrapper is
    // there for every field, so that a line that turns up while a field is in
    // use does not rebuild its input.
    return (
      <div key={m.name} className="flex flex-col gap-0.5">
        {field}
        {error ? (
          <p
            id={errorId}
            role="alert"
            data-testid={`field-error-${m.name}`}
            className="text-danger text-[10px] leading-snug"
          >
            {error}
          </p>
        ) : null}
        {fieldHelp ? (
          <p
            id={helpId}
            data-testid={`field-help-${m.name}`}
            className="text-muted-foreground text-[10px] leading-snug"
          >
            {fieldHelp}
          </p>
        ) : null}
        {note ? (
          <p
            id={noteId}
            role="status"
            data-testid={`field-note-${m.name}`}
            className="text-foreground text-[10px] leading-snug"
          >
            {note}
          </p>
        ) : null}
        {warning ? (
          <p
            id={warningId}
            role="status"
            data-testid={`field-warning-${m.name}`}
            className={cn(
              'border-warning/30 bg-warning/10 text-foreground',
              'rounded-[var(--radius-sm)] border px-1.5 py-1 text-[10px] leading-snug',
            )}
          >
            {warning}
          </p>
        ) : null}
        {m.name === 'bus' && busLacksGenerator && onAddGenerator ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => onAddGenerator(busValue)}
            data-testid="field-action-add-generator"
            className="self-start"
          >
            Add a PV generator on bus {busValue}
          </Button>
        ) : null}
      </div>
    );
  };

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className={cn('flex flex-col gap-3', className)}
      data-testid={`element-form-${model}`}
    >
      {help && help.note.length > 0 ? (
        <div
          role="note"
          data-testid="element-form-note"
          className={cn(
            'border-border bg-muted/40 text-foreground',
            'flex flex-col gap-1.5 rounded-[var(--radius-sm)] border px-2 py-1.5',
            'text-[11px] leading-snug',
          )}
        >
          {help.note.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
      ) : null}
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
      {problems.length > 0 ? (
        <div
          role="status"
          data-testid="form-problems"
          className="border-danger/30 bg-danger/10 text-foreground rounded-[var(--radius-sm)] border px-2 py-1.5 text-xs"
        >
          {problemSummary(missing, refused)}
        </div>
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
