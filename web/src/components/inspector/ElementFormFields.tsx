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
import { usePflowStore } from '@/store/pflow';
import { useRunsStore } from '@/store/runs';
import { useSessionStore } from '@/store/session';
import {
  useCloneDiff,
  useCloneEdit,
  useCurrentTopology,
  useReloadCase,
  useTopologySchema,
} from '@/api/queries';
import type { CloneDiffPair, ParamValue, TopologyEntry, TopologyParamMeta } from '@/api/types';
import type { SelectedElement } from '@/store/case';
import { findTopologyEntry } from '@/lib/topology';
import { cn } from '@/lib/cn';
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
 * is in flight; on success the value updates from the substrate's ``new_value``;
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
}

function PropertiesBody({
  entry,
  selected,
  editable,
  cloneEditable,
  streamingLock,
  paramMetas,
  diffByParam,
}: PropertiesBodyProps) {
  // Local optimistic mirror so an edited value is reflected immediately
  // without waiting for the topology re-fetch round-trip.
  const [overrides, setOverrides] = useState<Record<string, ParamValue>>({});

  if (!entry) {
    return (
      <p className="text-muted-foreground text-xs">
        No parameters available for {selected.kind} {selected.idx}.
      </p>
    );
  }
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
      {entries.length === 0 ? (
        <p className="text-muted-foreground col-span-2 mt-2 text-xs">
          No additional parameters reported by ANDES.
        </p>
      ) : (
        entries.map(([key, value]) => {
          const meta = paramMetas.get(key);
          const isIdentifierField = key === 'idx' || key === 'name' || meta?.kind === 'bus_idx';
          // Clone-edit path (Unit 22): whitelisted controller params become
          // editable inputs that commit via the clone-on-write endpoint. The
          // substrate is whitelist-first, so a non-editable param simply 422s
          // — but we still gate the UI to identifier fields to avoid surfacing
          // an input that would always fail.
          const canCloneEdit = cloneEditable && !isIdentifierField;
          // Static-element edit path (unchanged): per-field EditElementButton.
          const canEditThisField = editable && meta !== undefined && !isIdentifierField;
          return (
            <div key={key} className="contents">
              <dt className="text-muted-foreground flex items-center gap-1 font-mono text-xs">
                {key}
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
                    onUpdated={(next) => setOverrides((curr) => ({ ...curr, [key]: next }))}
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
}

function ResetBanner({ onReset, resetting }: ResetBannerProps) {
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
      <span>Run has committed setup. Reset to edit.</span>
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
  const sessionId = useSessionStore((s) => s.sessionId);
  const reloadCase = useReloadCase();
  const schema = useTopologySchema();

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

  if (!selectedElement) return null;

  const isPreSetup = topology?.state === 'pre-setup';
  const isCommitted = topology?.state === 'committed';
  const editable = isPreSetup && !isPflowRunning;
  // Clone-edit is available for controllers in Edit mode. Unlike the static
  // edit path it does NOT require a pre-setup System — the clone endpoint
  // re-loads + re-setups from the edited files on every commit.
  const cloneEditable = editMode === 'edit' && isController;

  const onResetRun = () => {
    if (!sessionId) return;
    reloadCase.mutate(sessionId);
  };

  return (
    <div data-testid="element-form-fields" className={cn('flex min-h-0 flex-col gap-2', className)}>
      {isCommitted && !cloneEditable ? (
        <ResetBanner onReset={onResetRun} resetting={reloadCase.isPending} />
      ) : null}
      <PropertiesBody
        entry={entry}
        selected={selectedElement}
        editable={editable}
        cloneEditable={cloneEditable}
        streamingLock={tdsStreaming}
        paramMetas={paramMetas}
        diffByParam={diffByParam}
      />
    </div>
  );
}

// ResetBanner + PropertiesBody + the helpers above are intentionally
// kept private. Tests exercise behaviour through the public component
// shape; the back-compat ``ElementInspector`` wrapper composes
// ``ElementFormFields`` directly without reaching into helpers.
