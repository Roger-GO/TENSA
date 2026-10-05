/**
 * Right-click menu of the single-line diagram.
 *
 * What it offers depends on what was clicked:
 *
 *  - **A bus**: Inspect, Add element here (opens the Add element panel with this
 *    bus chosen in the form), Fault here (opens the Add disturbance dialog with a
 *    fault on this bus), Plot voltage (puts the bus's voltage on the time-series
 *    plot of the active run).
 *  - **A line or transformer**: Inspect, Trip line (the dialog with a toggle on
 *    this branch).
 *  - **A generator, load, shunt or controller**: Inspect.
 *  - **The canvas**: Add element, and Fit view and Reset to auto-layout, the same
 *    two commands the palette has.
 *
 * A right-click on the diagram is where a first-time user looks for a way to add
 * to it, and the Component library is at the foot of the sidebar, below the fold
 * of a short window. While nothing can be added (a run has locked the system),
 * the item is greyed out and says why.
 *
 * `SldCanvas` finds out what was right-clicked from React Flow's
 * `onNodeContextMenu` / `onEdgeContextMenu`, and what was pressed by touch or pen
 * (a long press, which iOS reports with no `contextmenu` event) from the DOM, and
 * keeps it as an `SldContextTarget` (`contextTarget.ts` turns a node or an edge
 * into one). The menu is Radix's (`@/components/ui/context-menu`), whose trigger
 * wraps the canvas surface.
 *
 * Fault and Trip add to the same disturbance list the sidebar shows and the next
 * TDS run applies, through the same dialog the sidebar's button opens, so the
 * time and the fault impedance are the user's to set before anything is added.
 */
import { useState } from 'react';

import type { DisturbanceSpec } from '@/api/types';
import { AddEventDialog } from '@/components/disturbance/AddEventDialog';
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from '@/components/ui/context-menu';
import { toast } from '@/lib/toast';
import { useAddComponent } from '@/lib/useAddComponent';
import { useCaseStore } from '@/store/case';
import type { SelectedElement } from '@/store/case';
import { blankFaultSpec, blankToggleSpec, disturbanceSummary } from '@/store/disturbance';
import { useDisturbanceStore } from '@/store/disturbance';
import { useLayoutStore } from '@/store/layout';
import { usePlotStore } from '@/store/plot';
import { useRunsStore } from '@/store/runs';
import { useSldStore } from '@/store/sld';
import type { SldContextTarget } from './contextTarget';

/**
 * A node id is the idx as text, but the substrate matches an idx by type, so a
 * numeric one goes back to a number, as the forms do when a bus or device is picked.
 */
function asIdx(idx: string): number | string {
  return /^-?\d+$/.test(idx) ? Number(idx) : idx;
}

/** `name (idx 7)` when the diagram's label differs from the idx the forms use. */
function labelOf(idx: string, name: string): string {
  return name !== idx ? `${name} (idx ${idx})` : idx;
}

function titleOf(target: SldContextTarget): string {
  switch (target.kind) {
    case 'canvas':
      return 'Diagram';
    case 'bus':
      return `Bus ${labelOf(target.idx, target.name)}`;
    case 'branch':
      return `${target.transformer ? 'Transformer' : 'Line'} ${labelOf(target.idx, target.name)}`;
    case 'device': {
      const kind = target.element.kind;
      const noun =
        kind === 'controller' ? 'Controller' : kind.charAt(0).toUpperCase() + kind.slice(1);
      return `${noun} ${labelOf(target.element.idx, target.name)}`;
    }
  }
}

/** Show `element` in the Inspector, opening the Inspector if it is folded away. */
function inspect(element: SelectedElement, nodeId: string | null): void {
  useCaseStore.getState().setSelectedElement(element);
  if (nodeId !== null) useSldStore.getState().setSelectedNodeId(nodeId);
  useLayoutStore.getState().setRightInspectorCollapsed(false);
}

/** The column the run records a bus voltage in; see `parseColumnName` in `store/plot`. */
function voltageColumn(busIdx: string): string {
  return `Bus_${busIdx}_v`;
}

/**
 * "Plot voltage": adds the bus's voltage to the plot of the active run and brings
 * the plot up. Its own component so the run subscriptions are only live while the
 * menu is open (the menu content is unmounted otherwise), not on every streamed
 * frame.
 */
function PlotVoltageItem({ busIdx }: { busIdx: string }) {
  const column = voltageColumn(busIdx);
  const hasRun = useRunsStore((s) => s.activeRunId !== null && s.runs[s.activeRunId] !== undefined);
  // The run to plot into, or null when there is none or it did not record this bus.
  const runId = useRunsStore((s) => {
    const id = s.activeRunId;
    if (id === null) return null;
    const run = s.runs[id];
    return run !== undefined && run.columnNames.includes(column) ? id : null;
  });

  const plot = () => {
    if (runId === null) return;
    const selected = usePlotStore.getState().selectedByRun[runId] ?? new Set<string>();
    usePlotStore.getState().setSelection(runId, new Set([...selected, column]));
    const layout = useLayoutStore.getState();
    layout.setActiveBottomDrawerTab('analysis');
    layout.setActiveAnalysisSubTab('plot');
    layout.setBottomDrawerCollapsed(false);
    layout.clearDrawerUnread();
  };

  return (
    <ContextMenuItem
      data-testid="sld-context-plot-voltage"
      disabled={runId === null}
      onSelect={plot}
    >
      <span>Plot voltage</span>
      {runId === null ? (
        <span className="text-muted-foreground ml-auto pl-3 text-xs">
          {hasRun ? 'not in this run' : 'run TDS first'}
        </span>
      ) : null}
    </ContextMenuItem>
  );
}

/**
 * "Add element here" on a bus, "Add element" on the canvas: opens the Add element
 * panel, on that bus when there is one. Its own component for the same reason as
 * `PlotVoltageItem`: what it reads is only read while the menu is open.
 */
function AddElementItem({ busIdx }: { busIdx: string | null }) {
  const { blockedReason } = useAddComponent();
  const blocked = blockedReason !== null;

  const open = () => {
    if (blocked) return;
    if (busIdx === null) useCaseStore.getState().openAddPanel(null);
    else useCaseStore.getState().openAddPanelOnBus(busIdx);
  };

  return (
    <ContextMenuItem
      data-testid="sld-context-add-element"
      disabled={blocked}
      onSelect={open}
      className="flex-col items-start gap-0.5"
    >
      <span>{busIdx === null ? 'Add element…' : 'Add element here…'}</span>
      {blocked ? (
        <span className="text-muted-foreground max-w-[16rem] text-xs leading-snug">
          {blockedReason}
        </span>
      ) : null}
    </ContextMenuItem>
  );
}

export interface SldContextMenuBodyProps {
  target: SldContextTarget;
  onFitView: () => void;
  onResetLayout: () => void;
}

/**
 * The menu's content and the dialog its Fault and Trip items open. Render it inside
 * the `ContextMenu` root, beside the trigger.
 */
export function SldContextMenuBody({ target, onFitView, onResetLayout }: SldContextMenuBodyProps) {
  const addDisturbance = useDisturbanceStore((s) => s.addDisturbance);
  // The spec the Add disturbance dialog opens with, or null while it is closed.
  // Kept in state, so its reference is stable for as long as the dialog is open.
  const [seed, setSeed] = useState<DisturbanceSpec | null>(null);

  const save = (spec: DisturbanceSpec) => {
    addDisturbance(spec);
    toast.success(disturbanceSummary(spec), {
      description:
        'Added to Disturbances in the left sidebar. It applies the next time you run TDS.',
    });
  };

  return (
    <>
      <ContextMenuContent data-testid="sld-context-menu" className="min-w-[13rem]">
        <ContextMenuLabel data-testid="sld-context-menu-title">{titleOf(target)}</ContextMenuLabel>
        <ContextMenuSeparator />
        {target.kind === 'bus' ? (
          <>
            <ContextMenuItem
              data-testid="sld-context-inspect"
              onSelect={() => inspect({ kind: 'bus', idx: target.idx }, target.nodeId)}
            >
              Inspect
            </ContextMenuItem>
            <AddElementItem busIdx={target.idx} />
            <ContextMenuItem
              data-testid="sld-context-fault"
              onSelect={() => setSeed({ ...blankFaultSpec(), bus_idx: asIdx(target.idx) })}
            >
              Fault here…
            </ContextMenuItem>
            <PlotVoltageItem busIdx={target.idx} />
          </>
        ) : null}
        {target.kind === 'branch' ? (
          <>
            <ContextMenuItem
              data-testid="sld-context-inspect"
              onSelect={() =>
                inspect(
                  { kind: target.transformer ? 'transformer' : 'line', idx: target.idx },
                  null,
                )
              }
            >
              Inspect
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="sld-context-trip-line"
              onSelect={() =>
                setSeed({ ...blankToggleSpec(), model: 'Line', dev_idx: asIdx(target.idx) })
              }
            >
              Trip line…
            </ContextMenuItem>
          </>
        ) : null}
        {target.kind === 'device' ? (
          <ContextMenuItem
            data-testid="sld-context-inspect"
            onSelect={() => inspect(target.element, target.nodeId)}
          >
            Inspect
          </ContextMenuItem>
        ) : null}
        {target.kind === 'canvas' ? (
          <>
            <AddElementItem busIdx={null} />
            <ContextMenuItem data-testid="sld-context-fit-view" onSelect={onFitView}>
              Fit view
            </ContextMenuItem>
            <ContextMenuItem data-testid="sld-context-reset-layout" onSelect={onResetLayout}>
              Reset to auto-layout
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
      <AddEventDialog
        open={seed !== null}
        onOpenChange={(next) => {
          if (!next) setSeed(null);
        }}
        seedSpec={seed}
        onSave={save}
      />
    </>
  );
}
