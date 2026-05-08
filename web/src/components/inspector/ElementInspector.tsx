import { useMemo, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/shell/EmptyState';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import type { TopologyEntry, TopologySummary, PflowResult } from '@/api/types';
import type { SelectedElement } from '@/store/case';
import { cn } from '@/lib/cn';

/**
 * ElementInspector. Right-dock top region tabbed panel (R10).
 *
 * Two states feed the inspector:
 *
 * - `case.selectedElement` — what the user has clicked (SLD canvas or
 *   Results table row).
 * - `pflow.lastRun` — the most recent PF result. Drives the Results tab.
 *
 * Three render branches:
 *
 * 1. No case loaded → EmptyState ("Load a case to inspect elements.")
 * 2. Case loaded, nothing selected → EmptyState ("Click an element on
 *    the diagram to inspect it.")
 * 3. Element selected → Tabs: Properties | Results.
 *
 * The Results tab shows an EmptyState pre-PF and a definition list of
 * computed values post-PF. Tab default selection follows the
 * interaction-states matrix: Properties pre-PF, Results post-PF.
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
      // The substrate's TopologySummary doesn't currently expose a
      // separate shunts bucket; v0.1 shunts are surfaced via the loads
      // / generators buckets depending on model. Return an empty bucket
      // so the inspector falls back to "no parameters" without crashing.
      return [];
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
    // Use a sensible default precision: integers stay integers, floats
    // get up to 6 significant digits.
    if (Number.isInteger(v)) return String(v);
    return v.toPrecision(6);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v;
}

interface PropertiesTabProps {
  entry: TopologyEntry | null;
  selected: SelectedElement;
}

function PropertiesTab({ entry, selected }: PropertiesTabProps) {
  if (!entry) {
    return (
      <p className="text-muted-foreground text-xs">
        No parameters available for {selected.kind} {selected.idx}.
      </p>
    );
  }
  const params = entry.params ?? {};
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
        entries.map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="text-muted-foreground font-mono text-xs">{key}</dt>
            <dd className="text-foreground font-mono text-xs">{formatValue(value)}</dd>
          </div>
        ))
      )}
    </dl>
  );
}

interface ResultsTabProps {
  selected: SelectedElement;
  pflowResult: PflowResult | null;
}

function ResultsTab({ selected, pflowResult }: ResultsTabProps) {
  if (!pflowResult) {
    return (
      <EmptyState
        title="No results yet"
        description="Run power flow to see results."
        className="py-6"
      />
    );
  }
  if (!pflowResult.converged) {
    return (
      <p className="text-muted-foreground text-xs">
        PF did not converge — no results to display for this element.
      </p>
    );
  }
  if (selected.kind === 'bus') {
    const v = pflowResult.bus_voltages[selected.idx];
    const a = pflowResult.bus_angles[selected.idx];
    if (v === undefined) {
      return <p className="text-muted-foreground text-xs">No PF result for bus {selected.idx}.</p>;
    }
    const angleDeg = a !== undefined && Number.isFinite(a) ? ((a * 180) / Math.PI).toFixed(2) : '—';
    return (
      <dl
        data-testid="inspector-results"
        className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm"
      >
        <dt className="text-muted-foreground font-mono text-xs">voltage</dt>
        <dd className="text-foreground font-mono text-xs">{v.toFixed(4)} pu</dd>
        <dt className="text-muted-foreground font-mono text-xs">angle</dt>
        <dd className="text-foreground font-mono text-xs">{angleDeg}°</dd>
      </dl>
    );
  }
  if (selected.kind === 'line') {
    const flow = pflowResult.line_flows?.[selected.idx];
    if (!flow) {
      return <p className="text-muted-foreground text-xs">No PF result for line {selected.idx}.</p>;
    }
    return (
      <dl
        data-testid="inspector-results"
        className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm"
      >
        <dt className="text-muted-foreground font-mono text-xs">p_flow</dt>
        <dd className="text-foreground font-mono text-xs">{flow.p.toFixed(2)} MW</dd>
        <dt className="text-muted-foreground font-mono text-xs">q_flow</dt>
        <dd className="text-foreground font-mono text-xs">{flow.q.toFixed(2)} MVAr</dd>
        <dt className="text-muted-foreground font-mono text-xs">from_idx</dt>
        <dd className="text-foreground font-mono text-xs">{String(flow.from_idx)}</dd>
        <dt className="text-muted-foreground font-mono text-xs">to_idx</dt>
        <dd className="text-foreground font-mono text-xs">{String(flow.to_idx)}</dd>
      </dl>
    );
  }
  // Generators / loads / transformers / shunts: v0.1 substrate doesn't
  // surface PF outputs for these per-element directly. The Results tab
  // falls back to a hint pointing at the related bus.
  return (
    <p className="text-muted-foreground text-xs">
      Per-element PF results for {selected.kind} not surfaced in v0.1; check the connected bus in
      the Results table.
    </p>
  );
}

export interface ElementInspectorProps {
  className?: string;
}

export function ElementInspector({ className }: ElementInspectorProps) {
  const selection = useCaseStore((s) => s.selection);
  const topology = useCaseStore((s) => s.topology);
  const selectedElement = useCaseStore((s) => s.selectedElement);
  const pflowResult = usePflowStore((s) => s.lastRun);

  // Tab default selection follows the interaction-states matrix: pre-PF
  // Properties, post-PF Results. We track via local state so the user
  // can switch and stay on their pick within the same render scope.
  const initialTab: 'properties' | 'results' = pflowResult ? 'results' : 'properties';
  const [tab, setTab] = useState<'properties' | 'results'>(initialTab);

  const entry = useMemo(() => {
    if (!topology || !selectedElement) return null;
    return findEntry(topology, selectedElement);
  }, [topology, selectedElement]);

  // ---- empty branches --------------------------------------------------
  if (selection === null) {
    return (
      <div className={cn('flex h-full flex-col', className)}>
        <EmptyState title="No case loaded" description="Load a case to inspect elements." />
      </div>
    );
  }
  if (selectedElement === null) {
    return (
      <div className={cn('flex h-full flex-col', className)}>
        <EmptyState
          title="No element selected"
          description="Click an element on the diagram to inspect it."
        />
      </div>
    );
  }

  return (
    <div
      data-testid="element-inspector"
      className={cn('flex h-full min-h-0 flex-col gap-2 p-3', className)}
    >
      <header className="flex flex-col gap-0.5">
        <p className="text-muted-foreground text-xs font-medium">Inspecting</p>
        <p className="text-foreground truncate font-mono text-sm">
          {selectedElement.kind} {selectedElement.idx}
        </p>
      </header>

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as 'properties' | 'results')}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList aria-label="Inspector tabs">
          <TabsTrigger value="properties">Properties</TabsTrigger>
          <TabsTrigger value="results">Results</TabsTrigger>
        </TabsList>
        <TabsContent value="properties" className="min-h-0 flex-1 overflow-auto">
          <PropertiesTab entry={entry} selected={selectedElement} />
        </TabsContent>
        <TabsContent value="results" className="min-h-0 flex-1 overflow-auto">
          <ResultsTab selected={selectedElement} pflowResult={pflowResult} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
