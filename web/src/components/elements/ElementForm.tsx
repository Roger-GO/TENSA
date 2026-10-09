import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useCurrentTopology, useTopologyRefetching, useTopologySchema } from '@/api/queries';
import type { ParamValue, TopologyParamMeta, TopologySummary } from '@/api/types';
import { cn } from '@/lib/cn';
import { BusIdxSelect } from './BusIdxSelect';
import { GenIdxSelect } from './GenIdxSelect';
import { SynIdxSelect } from './SynIdxSelect';
import { elementHelp, elementWarnings, namedAfterIdx, systemBaseEquivalent } from './elementHelp';
import {
  checkElementValues,
  emptyValueFor,
  existingIdxSetFor,
  busRatedVoltage,
  nextAvailableIdx,
  pickTargets,
  ratedForBus,
  seedElementValues,
  withBusRating,
  withHeldValues,
} from './elementValues';
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
 * A device that is on a bus is rated for it: its `Vn` is taken from the bus
 * that is picked (`withBusRating`), with a line that says so, and follows the
 * bus until a rating is typed. The name opens as the idx, and follows it the
 * same way (`namedAfterIdx`).
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
 *
 * The form of a draft (`live`, `DraftInspector`) is the same form held
 * otherwise. It opens with the values the draft was given (`heldValues`) and
 * reports every field that is set (`onFieldsChange`), so the draft keeps
 * them. It is checked as it is typed and not when it is sent: an empty
 * required field says so from the start, the line above the buttons names
 * what is still missing, and the button that adds stays off until nothing is.
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
  /**
   * Check the form as it is typed, not when it is sent: what is wrong shows
   * under its field at once, and the submit button is off while anything is.
   */
  live?: boolean;
  /**
   * The values that were kept for the form, by field: it opens with them over
   * what it would open with, and takes each as set by the user.
   */
  heldValues?: Readonly<Record<string, ParamValue>>;
  /**
   * Fields were set, by the user or by a pick that set another with it: each
   * with its value, and `null` for one the form chose itself and gave up.
   */
  onFieldsChange?: (patch: Record<string, ParamValue | null>) => void;
  /**
   * The idx values the form does not propose though the case does not have
   * them: the ones of the drafts that were placed before this one.
   */
  reservedIdxs?: readonly string[];
  /** What the button that sends the form says. Default: `Add <model>`. */
  submitLabel?: string;
  /** What the button beside it says. Default: Cancel. */
  cancelLabel?: string;
  /** Why the form cannot be sent whatever it holds (a run has locked the system), or nothing. */
  blockedReason?: string | null;
  /**
   * A field to put the cursor in, asked for from outside the form (the Pick
   * a bus button of a notice). An object, so the same field can be asked for
   * again; `onFieldFocused` is called once the cursor is there.
   */
  focusField?: { name: string } | null;
  onFieldFocused?: () => void;
  className?: string;
}

const ADVANCED_THRESHOLD = 10;

/** A line under a field that a pick elsewhere set, saying why. */
interface LinkNote {
  field: string;
  text: string;
}

/** "En", "Sn and Vn", "Sn, Vn and p0". */
function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The line above the buttons after a submit that could not go, or while a
 * form that is checked as it is typed cannot: which fields are empty, and
 * which hold a value the form refuses, by name. `lead` says which of the two.
 */
function problemSummary(
  missing: readonly string[],
  refused: readonly string[],
  lead: string,
): string {
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`${listOf(missing)} ${missing.length === 1 ? 'is' : 'are'} required and empty`);
  }
  if (refused.length > 0) {
    parts.push(
      `${listOf(refused)} ${refused.length === 1 ? 'holds' : 'hold'} a value that cannot be used`,
    );
  }
  return `${lead}: ${parts.join(', and ')}.`;
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
  live = false,
  heldValues,
  onFieldsChange,
  reservedIdxs,
  submitLabel,
  cancelLabel,
  blockedReason = null,
  focusField = null,
  onFieldFocused,
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
  // What the lists offer: a value that was kept can name something that has gone.
  const targets = useMemo(() => pickTargets(topology), [topology]);
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
    const init = withHeldValues(
      model,
      seedElementValues(model, metas, topo, defaults, reservedIdxs),
      heldValues ?? {},
    );
    // A line has two bus fields: the bus it was opened on is where it starts.
    const busField = metas.find((m) => m.kind === 'bus_idx');
    const onCase = (topo?.buses ?? []).some((b) => String(b.idx) === seedBus);
    const rated = (values: Record<string, ParamValue>) =>
      withBusRating(metas, values, heldValues ?? {}, topo);
    if (!seedBus || busField === undefined || !onCase) {
      return { values: rated(init), suggested: null, note: null };
    }
    init[busField.name] = seedBus;
    const plain = { values: rated(init), suggested: null, note: null };
    if (!linksGen || busField.name !== 'bus') return plain;
    // A seed is not a pick: the form opens like this again after each add, and
    // a second battery on the first one's generator is not a default. That
    // form is back before the case has been read again, when `topo` still
    // calls the generator free, so nothing is chosen until the read is in.
    const linked = refetching ? null : freeGeneratorOn(seedBus, staticGenerators(topo));
    if (linked === null) return plain;
    init.gen = linked.gen;
    return { values: rated(init), suggested: linked.gen, note: linked.note };
  };

  // One seed for both pieces of state: `useState` reads its argument once.
  const [opening] = useState(() => seed(params, topology, defaultParams));
  const [values, setValues] = useState<Record<string, ParamValue>>(opening.values);
  // The advanced fields are folded away, but for a form that was kept with
  // one of them set: what was entered there is shown, and so is what is
  // wrong with it.
  const heldAdvanced = (metas: readonly TopologyParamMeta[]): boolean =>
    metas.some((m) => !m.required && heldValues !== undefined && m.name in heldValues);
  const [showAdvanced, setShowAdvanced] = useState(() => heldAdvanced(params));
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  // Track which fields the USER has touched (vs. fields seeded by
  // prefill / defaults). Dirty state hangs off this rather than a
  // values-vs-empty comparison so prefilled idxs don't trip the
  // CancelConfirmDialog.
  const [touched, setTouched] = useState<Set<string>>(() => new Set(Object.keys(heldValues ?? {})));
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
    setShowAdvanced(heldAdvanced(params));
    setValidationErrors({});
    setTouched(new Set(Object.keys(heldValues ?? {})));
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

  // A field asked for from outside goes the same way, once the form has its
  // fields: one among the advanced ones has those opened first.
  const answered = useRef(onFieldFocused);
  useEffect(() => {
    answered.current = onFieldFocused;
  }, [onFieldFocused]);
  useEffect(() => {
    if (focusField === null) return;
    const meta = params.find((m) => m.name === focusField.name);
    if (meta === undefined) return;
    if (!meta.required) setShowAdvanced(true);
    setFocusRequest({ name: meta.name });
    answered.current?.();
  }, [focusField, params]);

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
  // By what it holds: the list is made anew with every render of the caller.
  const reservedKey = JSON.stringify(reservedIdxs ?? []);
  useEffect(() => {
    if (idxTouched) return;
    const proposed = nextAvailableIdx(model, topology, JSON.parse(reservedKey) as string[]);
    setValues((curr) => {
      if (!('idx' in curr) || curr.idx === proposed) return curr;
      const follows = namedAfterIdx(model) && 'name' in curr && !nameTouched;
      return follows ? { ...curr, idx: proposed, name: proposed } : { ...curr, idx: proposed };
    });
  }, [model, topology, idxTouched, nameTouched, reservedKey]);

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

  // The rated voltage goes with the bus until one is typed: picking another
  // bus, or the case gaining the rating of the one that is picked, sets it.
  const ratesFromBus = useMemo(() => ratedForBus(params), [params]);
  const vnTouched = touched.has('Vn');
  const busRating = ratesFromBus ? busRatedVoltage(topology, busValue) : null;
  useEffect(() => {
    if (vnTouched || busRating === null) return;
    setValues((curr) =>
      curr.Vn !== '' && Number(curr.Vn) === busRating ? curr : { ...curr, Vn: busRating },
    );
  }, [vnTouched, busRating]);
  // Said under the field while the value there is the bus's and not the user's.
  const ratedNote =
    !vnTouched && busRating !== null && values.Vn !== '' && Number(values.Vn) === busRating
      ? `Taken from bus ${busValue}, which is rated ${busRating} kV. Type another value for a device rated otherwise.`
      : undefined;

  // A draft is checked while its form is closed, from the values it holds: the
  // generator the form chose goes to it like one that was picked, though the
  // form goes on following the case for it while it is open.
  const reportFields = useRef(onFieldsChange);
  useEffect(() => {
    reportFields.current = onFieldsChange;
  }, [onFieldsChange]);
  const reportedGen = useRef<string | null>(null);
  useEffect(() => {
    if (!linksGen || genTouched) return;
    if (suggestedGen === null && reportedGen.current === null) return;
    if (suggestedGen === reportedGen.current) return;
    reportedGen.current = suggestedGen;
    reportFields.current?.({ gen: suggestedGen });
  }, [linksGen, genTouched, suggestedGen]);

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
    // What the change set: the field, and what went with it.
    const patch: Record<string, ParamValue | null> = { [name]: value };
    for (const also of ['bus', 'gen', 'name']) {
      if (also === name || next[also] === values[also]) continue;
      // One that was emptied along the way is no longer set by anyone.
      patch[also] = next[also] === '' || next[also] === undefined ? null : next[also];
    }
    // A name that only followed the idx is not one that was given.
    if (name === 'idx' && !touched.has('name')) delete patch.name;
    onFieldsChange?.(patch);
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
    if (blockedReason !== null) return;
    const { errors: errs, params: out } = checkElementValues(
      params,
      values,
      existingIdxs,
      live ? targets : undefined,
    );
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

  // What is wrong with each field: found when a submit was refused, or, for a
  // form that is checked as it is typed, with what it holds now.
  const shownErrors = live
    ? checkElementValues(params, values, existingIdxs, targets).errors
    : validationErrors;
  // Follows the fields as they are put right: an edit takes its field's error away.
  const problems = [...required, ...optional].filter((m) => m.name in shownErrors);
  const isEmpty = (m: TopologyParamMeta) => values[m.name] === '' || values[m.name] === undefined;
  const missing = problems.filter(isEmpty).map((m) => m.name);
  const refused = problems.filter((m) => !isEmpty(m)).map((m) => m.name);

  // A form that is checked as it is typed cannot be sent while anything is
  // wrong with it; no form can while the system takes no new element.
  const problemsId = `${baseId}-problems`;
  const blockedId = `${baseId}-blocked`;
  const submitOff = blockedReason !== null || (live && problems.length > 0);
  const submitOffBy =
    [blockedReason !== null ? blockedId : null, live && problems.length > 0 ? problemsId : null]
      .filter((id) => id !== null)
      .join(' ') || undefined;

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
    const error = shownErrors[m.name];
    const fieldHelp = help?.fields[m.name];
    const note =
      linkNote?.field === m.name ? linkNote.text : m.name === 'Vn' ? ratedNote : undefined;
    const warning = warnings[m.name];
    // A power per unit of the system base, in the unit a user thinks in.
    const equivalent = systemBaseEquivalent(model, m.name, value, { baseMva });
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
              // A name that still only follows the idx is the form's own: it
              // is picked whole when the field is entered, so that typing a
              // name of one's own takes its place.
              onFocus={
                m.name === 'name' && namedAfterIdx(model) && !nameTouched
                  ? (e) => e.currentTarget.select()
                  : undefined
              }
              aria-describedby={describedBy}
              aria-invalid={error ? true : undefined}
              className={cn(
                'bg-background h-7 w-32 rounded border px-2 font-mono text-xs',
                error ? 'border-danger' : 'border-border',
              )}
            />
          )}
          {m.unit ? <span className="text-muted-foreground text-[10px]">{m.unit}</span> : null}
          {equivalent !== null ? (
            <span
              data-testid={`field-equivalent-${m.name}`}
              className="text-muted-foreground font-mono text-[10px] whitespace-nowrap"
            >
              {equivalent}
            </span>
          ) : null}
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
            // Not for a form that is checked as it is typed: every field
            // still to fill would be read out at once when it opens.
            role={live ? undefined : 'alert'}
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
          id={problemsId}
          role="status"
          data-testid="form-problems"
          className={cn(
            'text-foreground rounded-[var(--radius-sm)] border px-2 py-1.5 text-xs',
            // While it is typed this is what is left to do, not a refusal.
            live ? 'border-warning/50 bg-warning/15' : 'border-danger/30 bg-danger/10',
          )}
        >
          {problemSummary(missing, refused, live ? 'Not ready to add' : 'Nothing was added')}
        </div>
      ) : null}
      {blockedReason !== null ? (
        <div
          id={blockedId}
          role="status"
          data-testid="form-blocked"
          className="border-warning/50 bg-warning/15 text-foreground rounded-[var(--radius-sm)] border px-2 py-1.5 text-xs"
        >
          {blockedReason}
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
          {cancelLabel ?? 'Cancel'}
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={saving || submitOff}
          // Why it is off is said in the lines above it.
          aria-describedby={submitOff ? submitOffBy : undefined}
          data-testid="element-form-submit"
        >
          {saving ? 'Saving…' : (submitLabel ?? `Add ${model}`)}
        </Button>
      </div>
    </form>
  );
}
