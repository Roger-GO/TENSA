import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/Input';
import { EditElementButton } from '@/components/elements/EditElementButton';
import { ProblemDetailsErrorSurface } from '@/components/error/ProblemDetailsErrorSurface';
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useCaseStore } from '@/store/case';
import { editedParams, useEditJournalStore } from '@/store/editJournal';
import { usePflowStore } from '@/store/pflow';
import { useRunsStore } from '@/store/runs';
import { useSessionStore } from '@/store/session';
import { useUnitsStore } from '@/store/units';
import { useCloneDiff, useCloneEdit, useCurrentTopology, useTopologySchema } from '@/api/queries';
import type { CloneDiffPair, ParamValue, TopologyEntry, TopologyParamMeta } from '@/api/types';
import type { SelectedElement } from '@/store/case';
import { findTopologyEntry } from '@/lib/topology';
import { announceEdit } from '@/lib/announceEdit';
import { cn } from '@/lib/cn';
import { entryBaseKv, formatDisplayed, unratedBusIdx, voltageDisplay } from '@/lib/units';
import { systemBaseEquivalent } from '@/components/elements/elementHelp';
import { runLockNotice } from '@/lib/runLock';
import { UNDO } from '@/lib/undoWording';
import { useReloadDiscardsEdits, useResetRunAction } from '@/lib/useResetRunAction';
import { assessVoltage, busVoltageLimits, voltageStatusText } from '@/components/sld/voltage';
import { formatLoading, loadingCheckText } from '@/components/sld/loading';
import { ModifiedFromOriginalDot } from './ModifiedFromOriginalDot';

/**
 * ElementFormFields (v3 Unit 8 — extracted from ElementInspector).
 *
 * Renders the per-element-kind property form for the currently selected
 * element. Mounted by both the legacy ``ElementInspector`` (back-compat
 * wrapper) and the new v3 ``PropertiesAccordion`` section so the v3
 * inspector accordion shares behaviour with the v2 tabbed inspector.
 *
 * Three render branches:
 *
 * 1. No case loaded → minimal placeholder text.
 * 2. Case loaded but no selection → minimal placeholder text.
 * 3. Element selected → ``ResetBanner`` (when committed) +
 *    ``PropertiesTab`` body (definition-list of params with optional
 *    inline edit affordances).
 *
 * Edit-affordance gating mirrors v2 behaviour: editable when topology is
 * pre-setup AND no PF run is in flight.
 */

/**
 * Format a single parameter value for display. Numbers get a fixed-
 * decimal representation; booleans become "true"/"false"; strings pass
 * through unchanged.
 */
function formatValue(v: number | string | boolean): string {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v);
    if (Number.isInteger(v)) return String(v);
    return v.toPrecision(6);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v;
}

/** Coerce raw input text back to the param's value type (number / bool / str). */
function coerceInput(raw: string, sample: ParamValue): ParamValue {
  if (typeof sample === 'number') {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (typeof sample === 'boolean') {
    return raw === 'true' || raw === '1';
  }
  return raw;
}

interface CloneEditFieldProps {
  model: string;
  idx: string;
  param: string;
  value: ParamValue;
  /** Disabled (e.g. a TDS run is streaming) — input is locked with a tooltip. */
  streamingLock: boolean;
  /** This param's clone-vs-original diff pair, when it differs. */
  diff?: CloneDiffPair;
}

/**
 * One clone-editable controller param (Unit 22). Commits via ``useCloneEdit``
 * on blur / Enter; shows a spinner while the write + reload + setup round-trip
 * is in flight; on success the value updates from the substrate's ``new_value``
 * and a toast confirms it (``announceEdit``);
 * on failure the local edit reverts and an inline ``ProblemDetailsErrorSurface``
 * banner renders below the input. While a TDS run streams the input is disabled
 * with a tooltip.
 */
function CloneEditField({ model, idx, param, value, streamingLock, diff }: CloneEditFieldProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const cloneEdit = useCloneEdit();
  // Local mirror of the committed value (seeded from the topology value, then
  // updated from the substrate's read-back on a successful edit).
  const [committed, setCommitted] = useState<ParamValue>(value);
  const [draft, setDraft] = useState<string>(String(value));
  const [error, setError] = useState<Error | null>(null);

  const inFlight = cloneEdit.isPending;
  const disabled = streamingLock || sessionId === null;

  // Re-sync to the upstream value when it changes EXTERNALLY (undo / redo /
  // reset / a topology re-fetch) and no commit is in flight, so the input
  // reflects the current clone-file value rather than a stale local draft.
  // Without this, an undo reverts the substrate but the field keeps showing
  // the just-undone value.
  useEffect(() => {
    if (!inFlight) {
      setCommitted(value);
      setDraft(String(value));
    }
    // `inFlight` intentionally excluded — only re-sync on an upstream value
    // change, not when a commit toggles the pending flag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = () => {
    if (disabled || inFlight) return;
    const next = coerceInput(draft, committed);
    if (next === committed) return; // no-op edit
    if (sessionId === null) return;
    setError(null);
    cloneEdit.mutate(
      { sessionId, model, idx, param, value: next },
      {
        onSuccess: (resp) => {
          // ``new_value`` is the post-setup read-back (may differ from the
          // file value under per-unit normalisation) — surface it verbatim.
          const applied = resp.new_value ?? next;
          setCommitted(applied);
          setDraft(String(applied));
          announceEdit(model, idx, [param], 'copy');
        },
        onError: (err) => {
          // Revert the draft to the last committed value + surface the banner.
          setDraft(String(committed));
          setError(err);
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        {streamingLock ? (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                {/* tabIndex+role+aria-label make the lock reason reachable by
                    keyboard (a disabled input can't be focused, so the tooltip
                    would otherwise never open without a pointer). */}
                <span
                  tabIndex={0}
                  role="group"
                  aria-label={`${param} — TDS streaming, editing available when the run completes`}
                  className="focus-visible:ring-ring inline-block w-full rounded-[var(--radius-sm)] focus-visible:ring-2 focus-visible:outline-none"
                >
                  <Input
                    type="text"
                    data-testid={`clone-edit-input-${param}`}
                    value={draft}
                    onChange={setDraft}
                    disabled
                    className="h-6 text-xs"
                  />
                </span>
              </TooltipTrigger>
              <TooltipPortal>
                <TooltipContent data-testid={`clone-edit-tds-tooltip-${param}`}>
                  TDS streaming — edit available when the run completes.
                </TooltipContent>
              </TooltipPortal>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <Input
            type="text"
            data-testid={`clone-edit-input-${param}`}
            value={draft}
            onChange={setDraft}
            disabled={disabled || inFlight}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              }
            }}
            className="h-6 text-xs"
          />
        )}
        {inFlight ? (
          <span
            data-testid={`clone-edit-spinner-${param}`}
            role="status"
            aria-live="polite"
            aria-label={`Saving ${param}`}
            className="border-muted-foreground border-t-foreground inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2"
          />
        ) : null}
        {diff ? (
          <ModifiedFromOriginalDot model={model} idx={idx} param={param} diff={diff} />
        ) : null}
      </div>
      {error ? (
        <ProblemDetailsErrorSurface
          variant="banner"
          error={error}
          testId={`clone-edit-error-${param}`}
          onDismiss={() => setError(null)}
          className="text-xs"
        />
      ) : null}
    </div>
  );
}

/** What the Inspector says about the selected bus once a power flow has solved it. */
interface BusReading {
  v: number;
  /** Where `v` stands against the bus's own limits, in words. */
  status: string | null;
  /** The bus's rated voltage in kV when the case gives one, else `null`. */
  baseKv: number | null;
}

/** What the Inspector says about the selected line or transformer once a power flow has solved it. */
interface BranchReading {
  /** The loading against the rating, in percent, and the rating in MVA; `null` when the case sets none. */
  loading: { pct: number; ratingMva: number } | null;
  /** Where the loading stands against the rating, in words. */
  check: string | null;
}

/** A parameter that names the element or links it to a bus is not edited in place. */
function isIdentifierParam(key: string, meta: TopologyParamMeta | undefined): boolean {
  return key === 'idx' || key === 'name' || meta?.kind === 'bus_idx';
}

const EMPTY_OVERRIDES: Readonly<Record<string, ParamValue>> = {};

const EDIT_HINT = 'Click the pencil beside a value to change it.';
const POWER_EDIT_HINT =
  'The powers here (p0, q0, the limits) are set in per unit of the system base, whatever the display units; the line under each is what it comes to in MW or MVAr. Click the pencil beside a value to change it.';
/** The models whose set-points are powers on the system base (`systemBaseEquivalent`). */
const SET_IN_SYSTEM_PU: ReadonlySet<string> = new Set(['PQ', 'PV', 'Slack']);
const BUS_EDIT_HINT =
  'vmin and vmax are the limits this bus is judged on. Click the pencil beside one to change it.';
const LINE_EDIT_HINT =
  'rate_a is the rating the loading is judged on, and 0 means none. Click the pencil beside a value to change it.';

/** The line of guidance under the Properties heading for an element of this model. */
function editHint(kind: string): string {
  if (kind === 'Bus') return BUS_EDIT_HINT;
  if (kind === 'Line') return LINE_EDIT_HINT;
  if (SET_IN_SYSTEM_PU.has(kind)) return POWER_EDIT_HINT;
  return EDIT_HINT;
}

interface PropertiesBodyProps {
  entry: TopologyEntry | null;
  selected: SelectedElement;
  /** Whether per-field edit affordances (static-element path) should render. */
  editable: boolean;
  /**
   * Whether the clone-on-write edit path is active (Edit mode + a
   * clone-editable controller selection). When true, whitelisted controller
   * params render a ``CloneEditField`` instead of read-only text.
   */
  cloneEditable: boolean;
  /** A TDS run is streaming — clone inputs are locked with a tooltip. */
  streamingLock: boolean;
  /** Per-field metadata from the topology schema; falls back to read-only when missing. */
  paramMetas: Map<string, TopologyParamMeta>;
  /** Per-param clone-vs-original diff pairs (Unit 23), keyed by param name. */
  diffByParam: Map<string, CloneDiffPair>;
  /** A bus's solved voltage and where it stands against its limits, after a power flow. */
  busReading: BusReading | null;
  /** A line's solved loading against its rating, after a power flow. */
  branchReading: BranchReading | null;
  /** The system base in MVA, for what a per-unit power is in MW; `null` when the case gives none. */
  baseMva: number | null;
}

function PropertiesBody({
  entry,
  selected,
  editable,
  cloneEditable,
  streamingLock,
  paramMetas,
  diffByParam,
  busReading,
  branchReading,
  baseMva,
}: PropertiesBodyProps) {
  // Local optimistic mirror so an edited value is reflected immediately
  // without waiting for the topology re-fetch round-trip. It belongs to the
  // topology entry it was made on: once that entry is replaced (the re-fetch
  // after the edit, a reload that put the file's values back) or another
  // element is selected, the topology is the truth again and the mirror is
  // ignored, so the Inspector never shows a value the case no longer holds.
  const [mirror, setMirror] = useState<{
    source: TopologyEntry | null;
    values: Readonly<Record<string, ParamValue>>;
  }>({ source: null, values: EMPTY_OVERRIDES });
  const unitMode = useUnitsStore((s) => s.mode);
  // The params changed since the case was opened, by an edit of the user's or
  // by one the app made with it (the Vn that goes with a device to another
  // bus): each is marked, where a notice that said so is gone in seconds.
  const journal = useEditJournalStore((s) => s.entries);
  const edited = useMemo(
    () => new Set(entry ? editedParams(journal, entry.kind, String(entry.idx)) : []),
    [journal, entry],
  );

  if (!entry) {
    return (
      <p className="text-muted-foreground text-xs">
        No parameters available for {selected.kind} {selected.idx}.
      </p>
    );
  }
  const overrides = mirror.source === entry ? mirror.values : EMPTY_OVERRIDES;
  const params = { ...(entry.params ?? {}), ...overrides };
  const entries = Object.entries(params);
  return (
    <dl
      data-testid="inspector-properties"
      className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm"
    >
      <dt className="text-muted-foreground font-mono text-xs">idx</dt>
      <dd className="text-foreground font-mono text-xs">{String(entry.idx)}</dd>
      <dt className="text-muted-foreground font-mono text-xs">name</dt>
      <dd className="text-foreground truncate text-xs">{entry.name}</dd>
      <dt className="text-muted-foreground font-mono text-xs">kind</dt>
      <dd className="text-foreground font-mono text-xs">{entry.kind}</dd>
      {busReading !== null ? (
        <>
          <dt className="text-muted-foreground font-mono text-xs">voltage</dt>
          <dd data-testid="inspector-bus-voltage" className="text-foreground font-mono text-xs">
            {formatDisplayed(busReading.v, voltageDisplay(unitMode, busReading.baseKv), 4)}
          </dd>
          {busReading.status !== null ? (
            <>
              <dt className="text-muted-foreground font-mono text-xs">limit check</dt>
              <dd
                data-testid="inspector-bus-limit-check"
                className="text-foreground font-mono text-xs"
              >
                {busReading.status}
              </dd>
            </>
          ) : null}
        </>
      ) : null}
      {branchReading !== null ? (
        <>
          <dt className="text-muted-foreground font-mono text-xs">loading</dt>
          <dd data-testid="inspector-line-loading" className="text-foreground font-mono text-xs">
            {branchReading.loading === null
              ? 'no rating (rate_a is 0)'
              : `${formatLoading(branchReading.loading.pct)} of ${branchReading.loading.ratingMva.toFixed(1)} MVA`}
          </dd>
          {branchReading.check !== null ? (
            <>
              <dt className="text-muted-foreground font-mono text-xs">loading check</dt>
              <dd
                data-testid="inspector-line-loading-check"
                className="text-foreground font-mono text-xs"
              >
                {branchReading.check}
              </dd>
            </>
          ) : null}
        </>
      ) : null}
      {entries.length === 0 ? (
        <p className="text-muted-foreground col-span-2 mt-2 text-xs">
          No additional parameters reported by ANDES.
        </p>
      ) : (
        entries.map(([key, value]) => {
          const meta = paramMetas.get(key);
          const isIdentifierField = isIdentifierParam(key, meta);
          // Clone-edit path (Unit 22): whitelisted controller params become
          // editable inputs that commit via the clone-on-write endpoint. The
          // substrate is whitelist-first, so a non-editable param simply 422s
          // — but we still gate the UI to identifier fields to avoid surfacing
          // an input that would always fail.
          const canCloneEdit = cloneEditable && !isIdentifierField;
          // Static-element edit path (unchanged): per-field EditElementButton.
          const canEditThisField = editable && meta !== undefined && !isIdentifierField;
          // A power per unit of the system base, in the unit a user thinks in:
          // at rest too, since the value is typed in pu whatever the display units.
          const equivalent = systemBaseEquivalent(entry.kind, key, value, { baseMva });
          return (
            <div key={key} className="contents">
              <dt className="text-muted-foreground flex items-center gap-1 font-mono text-xs">
                {key}
                {edited.has(key) ? (
                  <span
                    role="img"
                    aria-label="changed since the case was opened"
                    title={`${key} was changed since the case was opened. ${UNDO} takes the change back.`}
                    data-testid={`inspector-edited-${key}`}
                    className="bg-primary inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                  />
                ) : null}
              </dt>
              <dd className="text-foreground font-mono text-xs">
                {canCloneEdit ? (
                  <CloneEditField
                    model={entry.kind}
                    idx={String(entry.idx)}
                    param={key}
                    value={value}
                    streamingLock={streamingLock}
                    diff={diffByParam.get(key)}
                  />
                ) : canEditThisField && meta ? (
                  <EditElementButton
                    model={entry.kind}
                    idx={String(entry.idx)}
                    meta={meta}
                    value={value}
                    enabled
                    onUpdated={(next) =>
                      setMirror((curr) => ({
                        source: entry,
                        values: { ...(curr.source === entry ? curr.values : {}), [key]: next },
                      }))
                    }
                  />
                ) : (
                  <span className="flex items-center gap-1.5">
                    <span>
                      {formatValue(value)}
                      {meta?.unit ? (
                        <span className="text-muted-foreground ml-1 text-[10px]">{meta.unit}</span>
                      ) : null}
                    </span>
                    {/* Read-only mode still surfaces the Modified-from-Original
                        dot so a user in Run mode can see what they changed. */}
                    {diffByParam.has(key) ? (
                      <ModifiedFromOriginalDot
                        model={entry.kind}
                        idx={String(entry.idx)}
                        param={key}
                        diff={diffByParam.get(key)!}
                      />
                    ) : null}
                  </span>
                )}
                {equivalent !== null ? (
                  <span
                    data-testid={`inspector-equivalent-${key}`}
                    className="text-muted-foreground block text-[10px]"
                  >
                    {equivalent}
                  </span>
                ) : null}
              </dd>
            </div>
          );
        })
      )}
    </dl>
  );
}

interface ResetBannerProps {
  onReset: () => void;
  resetting: boolean;
  /** Whether the reset would lose edits that were not saved (`useReloadDiscardsEdits`). */
  discardsEdits: boolean;
  /** The selection is a controller, whose parameters Edit mode can change on a locked case. */
  controller: boolean;
}

function ResetBanner({ onReset, resetting, discardsEdits, controller }: ResetBannerProps) {
  return (
    <div
      role="status"
      data-testid="inspector-reset-banner"
      className={cn(
        'border-warning/30 bg-warning/10 text-foreground',
        'flex items-center justify-between gap-2 rounded-[var(--radius-sm)] border px-2 py-1.5',
        'text-xs',
      )}
    >
      <span>
        {runLockNotice(
          discardsEdits,
          controller
            ? 'Edit mode, above, changes controller parameters without a reset.'
            : undefined,
        )}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={resetting}
        onClick={onReset}
        className="text-xs"
      >
        {resetting ? 'Resetting…' : 'Reset run'}
      </Button>
    </div>
  );
}

export interface ElementFormFieldsProps {
  className?: string;
}

/**
 * Renders the form-by-type body for the currently selected element.
 * Self-contained — reads topology, selection, and pflow state directly
 * from the relevant stores. Renders nothing when no case is loaded or no
 * selection exists; the parent (PropertiesAccordion or
 * ElementInspector) surfaces empty-state copy in those cases.
 */
export function ElementFormFields({ className }: ElementFormFieldsProps) {
  const selectedElement = useCaseStore((s) => s.selectedElement);
  const editMode = useCaseStore((s) => s.editMode);
  const topology = useCurrentTopology();
  const isPflowRunning = usePflowStore((s) => s.isRunning);
  const tdsStreaming = useRunsStore((s) =>
    Object.values(s.runs).some((r) => r.state === 'starting' || r.state === 'streaming'),
  );
  // The reset says what the top bar's does, and that it happened: the banner is
  // gone once the case is unlocked.
  const resetRun = useResetRunAction({ errorTitle: 'Reset run', confirm: true });
  const discardsEdits = useReloadDiscardsEdits();
  const schema = useTopologySchema();
  const pflow = usePflowStore((s) => s.lastRun);

  const entry = useMemo(() => {
    if (!topology || !selectedElement) return null;
    return findTopologyEntry(topology, selectedElement);
  }, [topology, selectedElement]);

  // Clone diff (Unit 23) — gated inside the hook on cloneInitialized + a
  // non-empty (model, idx). For controllers the model is the ANDES class; for
  // static elements there is no clone editing, so we pass nulls (disabled).
  const isController = selectedElement?.kind === 'controller';
  const diffModel = isController && entry ? entry.kind : null;
  const diffIdx = isController && entry ? String(entry.idx) : null;
  const cloneDiff = useCloneDiff(diffModel, diffIdx);

  const diffByParam = useMemo(() => {
    const map = new Map<string, CloneDiffPair>();
    const params = cloneDiff.data?.params;
    if (!params) return map;
    for (const [name, pair] of Object.entries(params)) map.set(name, pair);
    return map;
  }, [cloneDiff.data]);

  const paramMetas = useMemo(() => {
    const map = new Map<string, TopologyParamMeta>();
    if (!entry || !schema.data) return map;
    const list = schema.data.models[entry.kind] ?? [];
    for (const meta of list) map.set(meta.name, meta);
    return map;
  }, [entry, schema.data]);

  // A bus's solved voltage and the verdict on it, so the limits it is edited
  // against sit beside what they are judged on.
  const busReading = useMemo<BusReading | null>(() => {
    if (selectedElement?.kind !== 'bus' || !entry || !pflow?.converged) return null;
    const v = pflow.bus_voltages[String(entry.idx)];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    return {
      v,
      status: voltageStatusText(assessVoltage(v, busVoltageLimits(entry))),
      baseKv: entryBaseKv(entry, unratedBusIdx(topology)),
    };
  }, [selectedElement, entry, pflow, topology]);

  // A line's or a transformer's loading against its rating, so the rating it is
  // edited against sits beside what it is judged on.
  const branchReading = useMemo<BranchReading | null>(() => {
    if (
      (selectedElement?.kind !== 'line' && selectedElement?.kind !== 'transformer') ||
      !entry ||
      !pflow?.converged
    ) {
      return null;
    }
    const flow = pflow.line_flows?.[String(entry.idx)];
    if (!flow) return null;
    const pct = flow.loading_pct;
    const ratingMva = flow.rate_a;
    const loading =
      typeof pct === 'number' &&
      Number.isFinite(pct) &&
      typeof ratingMva === 'number' &&
      Number.isFinite(ratingMva)
        ? { pct, ratingMva }
        : null;
    return { loading, check: loadingCheckText(loading?.pct) };
  }, [selectedElement, entry, pflow]);

  if (!selectedElement) return null;

  const isPreSetup = topology?.state === 'pre-setup';
  const isCommitted = topology?.state === 'committed';
  const editable = isPreSetup && !isPflowRunning;
  // Clone-edit is available for controllers in Edit mode. Unlike the static
  // edit path it does NOT require a pre-setup System — the clone endpoint
  // re-loads + re-setups from the edited files on every commit.
  const cloneEditable = editMode === 'edit' && isController;
  // Say how to edit, once, where it can be done: the pencils are small, and a
  // first-time user has no other cue that the values are editable.
  const showEditHint =
    editable &&
    !cloneEditable &&
    entry !== null &&
    Object.keys(entry.params ?? {}).some((key) => {
      const meta = paramMetas.get(key);
      return meta !== undefined && !isIdentifierParam(key, meta);
    });

  return (
    <div data-testid="element-form-fields" className={cn('flex min-h-0 flex-col gap-2', className)}>
      {isCommitted && !cloneEditable ? (
        <ResetBanner
          onReset={resetRun.reset}
          resetting={resetRun.isPending}
          discardsEdits={discardsEdits}
          controller={isController}
        />
      ) : null}
      {showEditHint ? (
        <p data-testid="inspector-edit-hint" className="text-muted-foreground text-xs">
          {editHint(entry.kind)}
        </p>
      ) : null}
      <PropertiesBody
        entry={entry}
        selected={selectedElement}
        editable={editable}
        cloneEditable={cloneEditable}
        streamingLock={tdsStreaming}
        paramMetas={paramMetas}
        diffByParam={diffByParam}
        busReading={busReading}
        branchReading={branchReading}
        baseMva={topology?.base_mva ?? null}
      />
    </div>
  );
}

// ResetBanner + PropertiesBody + the helpers above are intentionally
// kept private. Tests exercise behaviour through the public component
// shape; the back-compat ``ElementInspector`` wrapper composes
// ``ElementFormFields`` directly without reaching into helpers.
