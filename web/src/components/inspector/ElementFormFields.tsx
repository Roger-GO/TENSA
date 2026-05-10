import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { EditElementButton } from '@/components/elements/EditElementButton';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useSessionStore } from '@/store/session';
import { useCurrentTopology, useReloadCase, useTopologySchema } from '@/api/queries';
import type { ParamValue, TopologyEntry, TopologyParamMeta, TopologySummary } from '@/api/types';
import type { SelectedElement } from '@/store/case';
import { cn } from '@/lib/cn';

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

/** Look up an entry in a topology bucket by idx-as-string. */
function findEntry(topology: TopologySummary, selected: SelectedElement): TopologyEntry | null {
  const bucket = bucketFor(topology, selected.kind);
  if (!bucket) return null;
  return bucket.find((e) => String(e.idx) === selected.idx) ?? null;
}

function bucketFor(
  topology: TopologySummary,
  kind: SelectedElement['kind'],
): TopologyEntry[] | null {
  switch (kind) {
    case 'bus':
      return topology.buses;
    case 'line':
      return topology.lines;
    case 'transformer':
      return topology.transformers;
    case 'generator':
      return topology.generators;
    case 'load':
      return topology.loads;
    case 'shunt':
      return topology.shunts ?? [];
    default:
      return null;
  }
}

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

interface PropertiesBodyProps {
  entry: TopologyEntry | null;
  selected: SelectedElement;
  /** Whether per-field edit affordances should render. */
  editable: boolean;
  /** Per-field metadata from the topology schema; falls back to read-only when missing. */
  paramMetas: Map<string, TopologyParamMeta>;
}

function PropertiesBody({ entry, selected, editable, paramMetas }: PropertiesBodyProps) {
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
          // bus_idx fields aren't editable in v0.1.x (structural-link
          // edits are deferred); render read-only.
          const canEditThisField =
            editable &&
            meta !== undefined &&
            meta.kind !== 'bus_idx' &&
            key !== 'idx' &&
            key !== 'name';
          return (
            <div key={key} className="contents">
              <dt className="text-muted-foreground font-mono text-xs">{key}</dt>
              <dd className="text-foreground font-mono text-xs">
                {canEditThisField && meta ? (
                  <EditElementButton
                    model={entry.kind}
                    idx={String(entry.idx)}
                    meta={meta}
                    value={value}
                    enabled
                    onUpdated={(next) => setOverrides((curr) => ({ ...curr, [key]: next }))}
                  />
                ) : (
                  <>
                    {formatValue(value)}
                    {meta?.unit ? (
                      <span className="text-muted-foreground ml-1 text-[10px]">{meta.unit}</span>
                    ) : null}
                  </>
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
  const topology = useCurrentTopology();
  const isPflowRunning = usePflowStore((s) => s.isRunning);
  const sessionId = useSessionStore((s) => s.sessionId);
  const reloadCase = useReloadCase();
  const schema = useTopologySchema();

  const entry = useMemo(() => {
    if (!topology || !selectedElement) return null;
    return findEntry(topology, selectedElement);
  }, [topology, selectedElement]);

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

  const onResetRun = () => {
    if (!sessionId) return;
    reloadCase.mutate(sessionId);
  };

  return (
    <div data-testid="element-form-fields" className={cn('flex min-h-0 flex-col gap-2', className)}>
      {isCommitted ? <ResetBanner onReset={onResetRun} resetting={reloadCase.isPending} /> : null}
      <PropertiesBody
        entry={entry}
        selected={selectedElement}
        editable={editable}
        paramMetas={paramMetas}
      />
    </div>
  );
}

// ResetBanner + PropertiesBody + the helpers above are intentionally
// kept private. Tests exercise behaviour through the public component
// shape; the back-compat ``ElementInspector`` wrapper composes
// ``ElementFormFields`` directly without reaching into helpers.
