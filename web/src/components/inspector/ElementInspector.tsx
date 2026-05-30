import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ChartLineIcon, CursorIcon, EmptyState, FolderIcon } from '@/components/ui/EmptyState';
import { useRunModeStore } from '@/store/runMode';
import { DeleteElementButton } from '@/components/elements/DeleteElementButton';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useCurrentTopology } from '@/api/queries';
import type { PflowResult } from '@/api/types';
import type { SelectedElement } from '@/store/case';
import { findTopologyEntry } from '@/lib/topology';
import { cn } from '@/lib/cn';
import { ElementFormFields } from './ElementFormFields';

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
 *
 * v3 note: this component is preserved as a back-compat wrapper. The v3
 * RightInspector accordion mounts ``ElementFormFields`` directly inside
 * ``PropertiesAccordion``; the form-by-type rendering body lives in
 * ``ElementFormFields.tsx`` for shared use.
 */

interface ResultsTabProps {
  selected: SelectedElement;
  pflowResult: PflowResult | null;
}

function ResultsTab({ selected, pflowResult }: ResultsTabProps) {
  const setActiveRoutine = useRunModeStore((s) => s.setActiveRoutine);
  if (!pflowResult) {
    return (
      <EmptyState
        icon={<ChartLineIcon />}
        title="No results yet"
        description="Run power flow to see results."
        action={{ label: 'Run PF', onClick: () => setActiveRoutine('pflow') }}
        emptyStateKey="inspector-results-no-pf"
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
  if (selected.kind === 'generator') {
    const gen = pflowResult.generator_outputs?.[selected.idx];
    if (!gen) {
      return (
        <p className="text-muted-foreground text-xs">No PF output for generator {selected.idx}.</p>
      );
    }
    return (
      <dl
        data-testid="inspector-results"
        className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm"
      >
        <dt className="text-muted-foreground font-mono text-xs">P</dt>
        <dd className="text-foreground font-mono text-xs">{gen.p.toFixed(2)} MW</dd>
        <dt className="text-muted-foreground font-mono text-xs">Q</dt>
        <dd className="text-foreground font-mono text-xs">{gen.q.toFixed(2)} MVAr</dd>
        <dt className="text-muted-foreground font-mono text-xs">V_term</dt>
        <dd className="text-foreground font-mono text-xs">{gen.v.toFixed(4)} pu</dd>
        <dt className="text-muted-foreground font-mono text-xs">bus</dt>
        <dd className="text-foreground font-mono text-xs">{String(gen.bus)}</dd>
      </dl>
    );
  }
  if (selected.kind === 'load') {
    const ld = pflowResult.load_consumption?.[selected.idx];
    if (!ld) {
      return <p className="text-muted-foreground text-xs">No PF result for load {selected.idx}.</p>;
    }
    return (
      <dl
        data-testid="inspector-results"
        className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm"
      >
        <dt className="text-muted-foreground font-mono text-xs">P</dt>
        <dd className="text-foreground font-mono text-xs">{ld.p.toFixed(2)} MW</dd>
        <dt className="text-muted-foreground font-mono text-xs">Q</dt>
        <dd className="text-foreground font-mono text-xs">{ld.q.toFixed(2)} MVAr</dd>
        <dt className="text-muted-foreground font-mono text-xs">bus</dt>
        <dd className="text-foreground font-mono text-xs">{String(ld.bus)}</dd>
      </dl>
    );
  }
  if (selected.kind === 'transformer') {
    // Transformers are Lines on the substrate side — read the line_flows
    // dict by idx.
    const flow = pflowResult.line_flows?.[selected.idx];
    if (!flow) {
      return (
        <p className="text-muted-foreground text-xs">
          No PF result for transformer {selected.idx}.
        </p>
      );
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
      </dl>
    );
  }
  // Shunts: ANDES doesn't expose per-shunt PF outputs directly. Hint
  // toward the connected bus.
  return (
    <p className="text-muted-foreground text-xs">
      Per-element PF results for {selected.kind} not surfaced; check the connected bus in the
      Results table.
    </p>
  );
}

export interface ElementInspectorProps {
  className?: string;
}

export function ElementInspector({ className }: ElementInspectorProps) {
  const selection = useCaseStore((s) => s.selection);
  const topology = useCurrentTopology();
  const selectedElement = useCaseStore((s) => s.selectedElement);
  const pflowResult = usePflowStore((s) => s.lastRun);
  const isPflowRunning = usePflowStore((s) => s.isRunning);

  // Tab default selection follows the interaction-states matrix: pre-PF
  // Properties, post-PF Results. We track via local state so the user
  // can switch and stay on their pick within the same render scope.
  const initialTab: 'properties' | 'results' = pflowResult ? 'results' : 'properties';
  const [tab, setTab] = useState<'properties' | 'results'>(initialTab);

  const entry = topology && selectedElement ? findTopologyEntry(topology, selectedElement) : null;

  const isPreSetup = topology?.state === 'pre-setup';
  // Edit affordances disabled mid-PF so the user can't fire a write
  // while the substrate is mid-commit.
  const editable = isPreSetup && !isPflowRunning;

  // ---- empty branches --------------------------------------------------
  if (selection === null) {
    return (
      <div className={cn('flex h-full flex-col', className)}>
        <EmptyState
          icon={<FolderIcon />}
          title="No case loaded"
          description="Load a case to inspect elements."
          emptyStateKey="inspector-no-case"
        />
      </div>
    );
  }
  if (selectedElement === null) {
    return (
      <div className={cn('flex h-full flex-col', className)}>
        <EmptyState
          icon={<CursorIcon />}
          title="No element selected"
          description="Click an element on the diagram to inspect it."
          emptyStateKey="inspector-no-selection"
        />
      </div>
    );
  }

  return (
    <div
      data-testid="element-inspector"
      className={cn('flex h-full min-h-0 flex-col gap-2 p-3', className)}
    >
      <header className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-muted-foreground text-xs font-medium">Inspecting</p>
          <p className="text-foreground truncate font-mono text-sm">
            {selectedElement.kind} {selectedElement.idx}
          </p>
        </div>
        {editable && entry ? (
          <DeleteElementButton
            model={entry.kind}
            idx={String(entry.idx)}
            kind={selectedElement.kind}
          />
        ) : null}
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
        <TabsContent value="properties" className="min-h-0 flex-1 space-y-2 overflow-auto">
          <ElementFormFields />
        </TabsContent>
        <TabsContent value="results" className="min-h-0 flex-1 overflow-auto">
          <ResultsTab selected={selectedElement} pflowResult={pflowResult} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
