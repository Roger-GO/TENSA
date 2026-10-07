/**
 * Right-click menu of the single-line diagram.
 *
 * What it offers depends on what was clicked:
 *
 *  - **A bus**: Inspect, Move with arrow keys, Add element here (opens the Add
 *    element panel with this bus chosen in the form), Fault here (opens the Add
 *    disturbance dialog with a fault on this bus), Plot voltage (puts the bus's
 *    voltage on the time-series plot of the active run).
 *  - **A line or transformer**: Inspect, Trip line (the dialog with a toggle on
 *    this branch), Move route by hand (picks the line, which shows its handles
 *    and the bar that goes with them: `SldRouteEditor`), and Reset route, which
 *    gives a route that was drawn by hand back to the automatic routing.
 *  - **The connector of a generator, load or shunt**: Move route by hand and
 *    Reset route, as for a line.
 *  - **A generator, load or shunt**: Inspect, Move with arrow keys. A generator
 *    that stands for a unit of several models (a machine, its exciter, its
 *    governor) also has Show control chain, or Hide control chain once it is
 *    drawn out: the same as the control at the end of the unit's name.
 *  - **A controller**: Inspect. Its badge is placed from what it acts on and
 *    cannot be moved on its own. (A controller of a generating unit has no
 *    badge: the symbol of the unit names it.)
 *  - **The canvas**: Add element, Fit view, Tidy diagram, Tidy and re-layout,
 *    Reset manual routes (every line that was routed by hand, at once) and
 *    Reset to auto-layout (the same commands the palette has), Snap to grid, how
 *    the connectors of generators, loads and shunts are drawn (straight, or with
 *    a right angle), and Save snapshot, which keeps the diagram as it is placed
 *    with the operating point.
 *  - **Several nodes picked together** (a box drawn with Shift held, or clicks
 *    with Ctrl held): Align and Distribute, the same as the bar over the diagram.
 *
 * Move with arrow keys is the way to place something without a drag: it selects
 * the element and gives it the keyboard focus, where React Flow moves a selected
 * node by the arrow keys (Shift for bigger steps). A move by the keys is saved as
 * a drag is.
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
import { useRef, useState } from 'react';

import type { DisturbanceSpec } from '@/api/types';
import { AddEventDialog } from '@/components/disturbance/AddEventDialog';
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
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
import { __requestUnitExpanded, useSldStore } from '@/store/sld';
import { useSnapshotStore } from '@/store/snapshot';
import { ALIGN_LABEL, DISTRIBUTE_LABEL, type AlignMode, type DistributeAxis } from './arrange';
import type { ArrangeCommand } from './SldArrangeControls';
import type { ConnectorStyle } from './connections';
import type { SldContextTarget } from './contextTarget';
import { ROUTE_FOCUS_ATTR } from './routeEdit';

const ALIGN_MODES: readonly AlignMode[] = ['left', 'centre', 'right', 'top', 'middle', 'bottom'];
const DISTRIBUTE_AXES: readonly DistributeAxis[] = ['horizontal', 'vertical'];

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
    case 'selection':
      return `${target.count} elements picked`;
    case 'bus':
      return `Bus ${labelOf(target.idx, target.name)}`;
    case 'branch':
      return `${target.transformer ? 'Transformer' : 'Line'} ${labelOf(target.idx, target.name)}`;
    case 'connector':
      return `Connector of ${target.name}`;
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
  if (nodeId !== null) useSldStore.getState().setSelectedNodeId(nodeId, 'diagram');
  useLayoutStore.getState().setRightInspectorCollapsed(false);
}

/** The handle of the line that is picked which takes the keyboard focus: its longest run. */
function routeHandle(): SVGElement | null {
  return document.querySelector<SVGElement>(`[${ROUTE_FOCUS_ATTR}]`);
}

/** The React Flow wrapper of a node, which is what takes the keyboard focus. */
function nodeElement(nodeId: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>('.react-flow__node')) {
    if (el.getAttribute('data-id') === nodeId) return el;
  }
  return null;
}

/**
 * "Move with arrow keys": selects the node, so that the keys move it once it has
 * the focus (`onMove` notes which node the menu hands the focus to as it closes),
 * and says which keys. Greyed out, with the reason, while the diagram is locked.
 */
function MoveItem({
  label,
  locked,
  onMove,
}: {
  label: string;
  locked: boolean;
  onMove: () => void;
}) {
  const move = () => {
    onMove();
    toast.info(`Press the arrow keys to move ${label}`, {
      description: 'Hold Shift for bigger steps. Your layout is saved with the case.',
    });
  };
  return (
    <ContextMenuItem data-testid="sld-context-move" disabled={locked} onSelect={move}>
      <span>Move with arrow keys</span>
      {locked ? (
        <span className="text-muted-foreground ml-auto pl-3 text-xs">diagram is locked</span>
      ) : null}
    </ContextMenuItem>
  );
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
  /** The diagram's lock is on: nothing can be moved until it is off again. */
  locked?: boolean;
  onFitView: () => void;
  onResetLayout: () => void;
  /** How the connectors of devices are drawn now, and the way to change it. */
  connectorStyle?: ConnectorStyle;
  onConnectorStyle?: (style: ConnectorStyle) => void;
  /** Tidy the diagram, or align and distribute what is picked. */
  onArrange?: (command: ArrangeCommand) => void;
  /** Whether a moved node snaps to the grid, and the way to change it. */
  snap?: boolean;
  onSnapChange?: (snap: boolean) => void;
  /** Pick a line or a connector, by the id of its edge, to move its route by hand. */
  onEditRoute?: (edgeId: string) => void;
  /** Give the route of one back to the automatic routing. */
  onResetRoute?: (edgeId: string) => void;
  /** How many routes of the diagram are drawn by hand, and the way to reset them all. */
  manualRoutes?: number;
  onResetManualRoutes?: () => void;
}

/**
 * "Move route by hand" and "Reset route", for a line, a transformer or the
 * connector of a device. The first picks the line, which shows its handles;
 * the second is greyed out, with the reason, for a route the diagram made.
 */
function RouteItems({
  edgeId,
  manual,
  locked,
  onEditRoute,
  onResetRoute,
}: {
  edgeId: string;
  manual: boolean;
  locked: boolean;
  onEditRoute?: (edgeId: string) => void;
  onResetRoute?: (edgeId: string) => void;
}) {
  return (
    <>
      <ContextMenuItem
        data-testid="sld-context-edit-route"
        disabled={locked}
        onSelect={() => onEditRoute?.(edgeId)}
      >
        <span>Move route by hand</span>
        {locked ? <LockedNote /> : null}
      </ContextMenuItem>
      <ContextMenuItem
        data-testid="sld-context-reset-route"
        disabled={locked || !manual}
        onSelect={() => onResetRoute?.(edgeId)}
      >
        <span>Reset route</span>
        {locked ? (
          <LockedNote />
        ) : manual ? null : (
          <span className="text-muted-foreground ml-auto pl-3 text-xs">routed automatically</span>
        )}
      </ContextMenuItem>
    </>
  );
}

/** The note a greyed-out item carries while the diagram is locked. */
function LockedNote() {
  return <span className="text-muted-foreground ml-auto pl-3 text-xs">diagram is locked</span>;
}

/**
 * The menu's content and the dialog its Fault and Trip items open. Render it inside
 * the `ContextMenu` root, beside the trigger.
 */
export function SldContextMenuBody({
  target,
  locked = false,
  onFitView,
  onResetLayout,
  connectorStyle = 'straight',
  onConnectorStyle,
  onArrange,
  snap = false,
  onSnapChange,
  onEditRoute,
  onResetRoute,
  manualRoutes = 0,
  onResetManualRoutes,
}: SldContextMenuBodyProps) {
  const addDisturbance = useDisturbanceStore((s) => s.addDisturbance);
  // The spec the Add disturbance dialog opens with, or null while it is closed.
  // Kept in state, so its reference is stable for as long as the dialog is open.
  const [seed, setSeed] = useState<DisturbanceSpec | null>(null);

  // The node Move with arrow keys was chosen for, until the menu has closed and
  // handed it the focus. Radix otherwise gives the focus back to whatever had it
  // before the menu opened, which is the node only when the right-click put it there.
  const moveNodeRef = useRef<string | null>(null);
  const move = (element: SelectedElement, nodeId: string) => {
    useCaseStore.getState().setSelectedElement(element);
    useSldStore.getState().setSelectedNodeId(nodeId, 'diagram');
    moveNodeRef.current = nodeId;
  };
  // The same for Move route by hand: the longest run of the line takes the
  // focus as the menu closes, so that the arrow keys slide it at once and
  // Tab goes on to its other handles.
  const editRouteRef = useRef(false);
  const editRoute = (edgeId: string) => {
    editRouteRef.current = true;
    onEditRoute?.(edgeId);
  };

  const save = (spec: DisturbanceSpec) => {
    addDisturbance(spec);
    toast.success(disturbanceSummary(spec), {
      description:
        'Added to Disturbances in the left sidebar. It applies the next time you run TDS.',
    });
  };

  return (
    <>
      <ContextMenuContent
        data-testid="sld-context-menu"
        className="min-w-[13rem]"
        onCloseAutoFocus={(event) => {
          const node = moveNodeRef.current === null ? null : nodeElement(moveNodeRef.current);
          moveNodeRef.current = null;
          const to = node ?? (editRouteRef.current ? routeHandle() : null);
          editRouteRef.current = false;
          if (to === null) return;
          event.preventDefault();
          to.focus();
        }}
      >
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
            <MoveItem
              label={titleOf(target)}
              locked={locked}
              onMove={() => move({ kind: 'bus', idx: target.idx }, target.nodeId)}
            />
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
            {target.edgeId !== undefined ? (
              <>
                <ContextMenuSeparator />
                <RouteItems
                  edgeId={target.edgeId}
                  manual={target.manual === true}
                  locked={locked}
                  onEditRoute={editRoute}
                  onResetRoute={onResetRoute}
                />
              </>
            ) : null}
          </>
        ) : null}
        {target.kind === 'connector' ? (
          <RouteItems
            edgeId={target.edgeId}
            manual={target.manual}
            locked={locked}
            onEditRoute={editRoute}
            onResetRoute={onResetRoute}
          />
        ) : null}
        {target.kind === 'device' ? (
          <>
            <ContextMenuItem
              data-testid="sld-context-inspect"
              onSelect={() => inspect(target.element, target.nodeId)}
            >
              Inspect
            </ContextMenuItem>
            {target.element.kind === 'controller' ? null : (
              <MoveItem
                label={titleOf(target)}
                locked={locked}
                onMove={() => move(target.element, target.nodeId)}
              />
            )}
            {target.unit !== undefined ? (
              <ContextMenuItem
                data-testid="sld-context-unit-chain"
                onSelect={() => {
                  const { idx, expanded } = target.unit!;
                  __requestUnitExpanded(idx, !expanded);
                }}
              >
                {target.unit.expanded ? 'Hide control chain' : 'Show control chain'}
              </ContextMenuItem>
            ) : null}
          </>
        ) : null}
        {target.kind === 'selection' ? (
          <>
            {ALIGN_MODES.map((mode) => (
              <ContextMenuItem
                key={mode}
                data-testid={`sld-context-align-${mode}`}
                disabled={locked}
                onSelect={() => onArrange?.(`align-${mode}`)}
              >
                <span>{ALIGN_LABEL[mode]}</span>
                {locked ? <LockedNote /> : null}
              </ContextMenuItem>
            ))}
            <ContextMenuSeparator />
            {DISTRIBUTE_AXES.map((axis) => (
              <ContextMenuItem
                key={axis}
                data-testid={`sld-context-distribute-${axis}`}
                disabled={locked || target.count < 3}
                onSelect={() => onArrange?.(`distribute-${axis}`)}
              >
                <span>{DISTRIBUTE_LABEL[axis]}</span>
                {locked ? (
                  <LockedNote />
                ) : target.count < 3 ? (
                  <span className="text-muted-foreground ml-auto pl-3 text-xs">
                    needs three or more
                  </span>
                ) : null}
              </ContextMenuItem>
            ))}
          </>
        ) : null}
        {target.kind === 'canvas' ? (
          <>
            <AddElementItem busIdx={null} />
            <ContextMenuItem data-testid="sld-context-fit-view" onSelect={onFitView}>
              Fit view
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              data-testid="sld-context-tidy"
              disabled={locked}
              onSelect={() => onArrange?.('tidy')}
            >
              <span>Tidy diagram</span>
              {locked ? <LockedNote /> : null}
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="sld-context-tidy-relayout"
              disabled={locked}
              onSelect={() => onArrange?.('tidy-relayout')}
            >
              <span>Tidy and re-layout</span>
              {locked ? <LockedNote /> : null}
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="sld-context-reset-manual-routes"
              disabled={locked || manualRoutes === 0}
              onSelect={() => onResetManualRoutes?.()}
            >
              <span>
                {manualRoutes > 0 ? `Reset manual routes (${manualRoutes})` : 'Reset manual routes'}
              </span>
              {locked ? (
                <LockedNote />
              ) : manualRoutes === 0 ? (
                <span className="text-muted-foreground ml-auto pl-3 text-xs">
                  no line is routed by hand
                </span>
              ) : null}
            </ContextMenuItem>
            <ContextMenuItem data-testid="sld-context-reset-layout" onSelect={onResetLayout}>
              Reset to auto-layout
            </ContextMenuItem>
            <ContextMenuItem
              data-testid="sld-context-snap"
              data-state={snap ? 'checked' : 'unchecked'}
              onSelect={() => onSnapChange?.(!snap)}
            >
              <span>{snap ? 'Snap to grid: on' : 'Snap to grid: off'}</span>
              <span className="text-muted-foreground ml-auto pl-3 text-xs">
                {snap ? 'turn off' : 'turn on'}
              </span>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuLabel>Device connectors</ContextMenuLabel>
            <ContextMenuRadioGroup
              value={connectorStyle}
              onValueChange={(value) =>
                onConnectorStyle?.(value === 'elbow' ? 'elbow' : 'straight')
              }
            >
              <ContextMenuRadioItem data-testid="sld-context-connectors-straight" value="straight">
                Straight
              </ContextMenuRadioItem>
              <ContextMenuRadioItem data-testid="sld-context-connectors-elbow" value="elbow">
                Right angle
              </ContextMenuRadioItem>
            </ContextMenuRadioGroup>
            <ContextMenuSeparator />
            <ContextMenuItem
              data-testid="sld-context-save-snapshot"
              onSelect={() => useSnapshotStore.getState().openSaveDialog()}
            >
              Save snapshot…
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
