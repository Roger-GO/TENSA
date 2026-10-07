import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  SelectionMode,
  useReactFlow,
} from '@xyflow/react';
import type {
  Edge,
  Node,
  NodeTypes,
  EdgeTypes,
  NodeMouseHandler,
  EdgeMouseHandler,
  OnNodesChange,
  OnNodeDrag,
  NodeChange,
  NodeDimensionChange,
  NodePositionChange,
  NodeSelectionChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useCaseStore } from '@/store/case';
import type { DragOverrides, RouteOverride, RouteOverrides, SelectedElement } from '@/store/case';
import { useLayoutStore } from '@/store/layout';
import { useLayoutHistoryStore } from '@/store/layoutHistory';
import type { LayoutSnapshot } from '@/store/layoutHistory';
import { subKindForControllerClass } from '@/lib/controllers';
import type { ControllerSubKind } from '@/lib/controllers';
import { useSessionStore } from '@/store/session';
import { useConnectivityStore } from '@/store/connectivity';
import { usePflowStore } from '@/store/pflow';
import { useUiStore } from '@/store/ui';
import {
  useSldStore,
  __requestOpenSldSearch,
  subscribeRouteEdit,
  subscribeSldCommand,
  subscribeUnitExpanded,
} from '@/store/sld';
import type { SldCommand } from '@/store/sld';
import { useHotkeys } from '@/lib/useHotkeys';
import { SHORTCUTS } from '@/lib/shortcuts';
import { toast } from '@/lib/toast';
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { SldNodeSearch } from './SldNodeSearch';
import { SldContextMenuBody } from './SldContextMenu';
import {
  contextTargetAt,
  contextTargetFromEdge,
  contextTargetFromNode,
  sameContextTarget,
  type SldContextTarget,
} from './contextTarget';
import { useGetSidecar, usePutSidecar, useCurrentTopology, useConnectivity } from '@/api/queries';
import type { BusCoord, TopologySummary, SidecarLayout } from '@/api/types';
import { ExportMenu } from '@/components/export/ExportMenu';
import { useExportCaseName } from '@/components/export/useExportCaseName';
import { elementToPng } from '@/components/export/exportToPng';

import { COMPONENT_DND_MIME } from '@/components/shell/ComponentLibrary';
import { BusNode } from './nodes/BusNode';
import { LineNode } from './nodes/LineNode';
import { GeneratorNode } from './nodes/GeneratorNode';
import { LoadNode } from './nodes/LoadNode';
import { ShuntNode } from './nodes/ShuntNode';
import { ControllerNode } from './nodes/ControllerNode';
import { TopologyEdge } from './edges/TopologyEdge';
import { TransformerEdge } from './edges/TransformerEdge';
import { StubEdge } from './edges/StubEdge';
import { SldCanvasHint } from './SldCanvasHint';
import { SldArrangeControls, SldSelectionBar, type ArrangeCommand } from './SldArrangeControls';
import {
  ALIGN_LABEL,
  DISTRIBUTE_LABEL,
  alignBoxes,
  distributeBoxes,
  type AlignMode,
  type ArrangeBox,
  type DistributeAxis,
} from './arrange';
import { GRID_STEP } from './tidy';
import { branchesThroughSymbols, type TidyPlan } from './tidyPlan';
import { startTidy, type TidyJob } from './tidyClient';
import { drawsClear, pictureOf, routesDrawClear, type PictureOptions } from './picture';
import { routeChecker } from './routeCheck';
import { ROUTE_FOCUS_ATTR, routeEndsOf } from './routeEdit';
import { SldRouteEditor } from './SldRouteEditor';
import { DROP_PICTURES, clearDrop, type DropObstacle } from './dropPlace';
import { flowLabelWidth, readoutWidth } from './labels';
import { getDeviceOverlayState, getLineOverlayState } from './overlay';
import { SldLayoutSkeleton } from './SldLayoutSkeleton';
import { SldEmptySystem } from './SldEmptySystem';
import { SldVoltageLegend } from './SldVoltageLegend';
import { SldLimitsLegend } from './SldLimitsLegend';
import { useAutoLayout } from './useAutoLayout';
import {
  CONNECTOR_STYLE_SETTING,
  barLengthsOf,
  buildSidecarLayout,
  cancelPendingSidecarPut,
  captureLayout,
  connectorStyleOf,
  controllerCoordsAsMap,
  debouncedPutSidecar,
  flushPendingSidecarPut,
  hasSavedPositions,
  mergeWithDrift,
  resolveDeviceCoords,
  storedBranchRoutes,
  storedConnectorRoutes,
  unitStatesOf,
  type CoordsByIdx,
} from './sidecar';
import { curatedLayoutFor } from './curated';
import {
  buildGraph,
  defaultBarLengths,
  DEVICE_PORT,
  SOURCE_HANDLE,
  TARGET_HANDLE,
  type UnitNodeData,
} from './graph';
import {
  BAR_LENGTH,
  BAR_THICKNESS,
  DEFAULT_CONNECTOR_STYLE,
  routeMidpoint,
  type ConnectionEdge,
  type ConnectorRoute,
  type ConnectorStyle,
  type LabelPlace,
  type NodeSize,
  type Point,
} from './connections';
import { FULL_ZOOM, fitPadding, isTooSmallToRead, locateZoom, withinPane } from './zoom';
import { cn } from '@/lib/cn';

const NODE_TYPES: NodeTypes = {
  bus: BusNode,
  line: LineNode,
  generator: GeneratorNode,
  load: LoadNode,
  shunt: ShuntNode,
  controller: ControllerNode,
};

// A line that keeps a stored route (`routed`) is drawn like one that is routed
// from where its buses sit (`topology`): either reaches its component as the
// points to draw through.
const EDGE_TYPES: EdgeTypes = {
  topology: TopologyEdge,
  routed: TopologyEdge,
  transformer: TransformerEdge,
  stub: StubEdge,
};

/** Buses-count threshold for the >30 banner (per the plan). */
const LARGE_TOPOLOGY_THRESHOLD = 30;

/**
 * How far the diagram can be zoomed out, and so how small a fit can make it.
 * React Flow's default floor is 0.5, which a tall diagram in a short pane
 * overruns: the fit stops at half size, the rest of the diagram sits outside
 * the pane where nothing can be reached, and the zoom-out button is dead.
 */
const MIN_ZOOM = 0.1;

/**
 * How far a press on a node may travel, in pixels on screen, and still be a
 * click and not a drag (see `onNodesChange`).
 */
const DRAG_SLOP_PX = 2;

/** The grid a node snaps to while Snap to grid is on: the dots of the background. */
const SNAP_GRID: [number, number] = [GRID_STEP, GRID_STEP];

/** The most times in a row the canvas keeps the routes a picture made (see `settlingRef`). */
const SETTLING_ROUNDS = 4;

/** What the Undo of a toast says when its change is no longer the newest one. */
const CHANGED_SINCE_NOTICE = 'The diagram was changed since. Use Undo in the Edit menu to go back.';

/**
 * What a bus or device was dropped on, as the notice says it when the drop
 * is put in the nearest free place (`clearDrop`).
 */
const DROPPED_ON: Record<DropObstacle, string> = {
  'symbol-symbol': 'It was dropped on another symbol, or right beside one.',
  'symbol-bar': 'A symbol and the bar of a bus were on each other, or right beside each other.',
  'bar-bar': 'Two bars were too close to each other for a label or a line to fit between them.',
  connector: 'It was dropped on the connector of a device.',
  'bar-between': 'The bar of another bus stood between the device and its own bus.',
  'no-way':
    'Where it was dropped, its connector or a line beside it had no way that is clear of the symbols and the bars.',
};

/**
 * The most edges a diagram has for which every place a dropped node could
 * stand in is asked of the picture as often as `DROP_PICTURES`. A picture
 * of a larger diagram takes long enough to count, so fewer places are
 * asked about, and a node with no clear place among them goes back sooner.
 */
const DROP_PICTURES_UP_TO = 120;
const DROP_PICTURES_LARGE = 3;

/** What a command that arranges the diagram says, and does not do, while the lock is on. */
const LOCKED_NOTICE =
  'The diagram is locked. Unlock it with the padlock at its bottom left to change its layout.';

/**
 * React Flow's name for the lock button is "Toggle Interactivity", which does not
 * say that a locked diagram refuses drags and clicks. The name says what the next
 * click does, so it also tells the state: the padlock icon is the only other sign
 * of it on the button.
 */
const ARIA_LABELS_UNLOCKED = {
  'controls.interactive.ariaLabel': 'Lock the diagram (stops dragging and selecting)',
  // What a line that has the keyboard focus is described by: React Flow's own
  // words offer to delete it, which the diagram does not do.
  'edge.a11yDescription.default':
    'Press Enter or Space to move the route of this line by hand: its runs and bends then take the arrow keys, and Escape lets go of it.',
};
const ARIA_LABELS_LOCKED = {
  'controls.interactive.ariaLabel': 'Unlock the diagram (dragging and selecting are off)',
  'edge.a11yDescription.default':
    'The diagram is locked: the route of this line cannot be moved until it is unlocked.',
};

/**
 * Per-kind color hint for the React Flow MiniMap. Uses semantic CSS
 * tokens directly so dark-mode (Unit 12) tracks the rest of the app
 * without revisiting this map. Defined at module scope so the
 * function reference is stable across renders — React Flow's MiniMap
 * skips its internal recompute when `nodeColor` is referentially
 * equal to the previous value.
 */
function miniMapNodeColor(node: Node): string {
  switch (node.type) {
    case 'bus':
      return 'var(--color-foreground)';
    case 'generator':
      return 'var(--color-success)';
    case 'load':
      return 'var(--color-muted-foreground)';
    case 'shunt':
      return 'var(--color-warning)';
    case 'line':
      return 'var(--color-primary)';
    default:
      return 'var(--color-border)';
  }
}

/**
 * MiniMap surface styling. Forwarded via the `style` prop so the React
 * Flow defaults (which use hardcoded hex) don't bleed into dark mode.
 * Unit 12 will flip the underlying tokens; this object stays untouched.
 *
 * v3 Unit 6 — IDE-style chrome on the floating overlay: bordered card
 * with a soft drop shadow so the MiniMap visually separates from the
 * canvas in both light and dark themes. The chrome utilities are
 * appended via `MINIMAP_CHROME_CLASSNAME` rather than baked into the
 * style object so Tailwind's responsive + dark variants can apply.
 */
const MINIMAP_STYLE: React.CSSProperties = {
  backgroundColor: 'var(--color-background)',
};

/**
 * IDE-style chrome shared by MiniMap + Controls (v3 Unit 6). Token-driven
 * border + radius + shadow so dark mode tracks automatically. Both
 * components float over the canvas (per Phase 2 Unit 11), so the chrome
 * is purely cosmetic — no positional shift.
 */
const FLOATING_OVERLAY_CHROME = 'border border-border rounded-lg shadow-lg overflow-hidden';

/**
 * Dot-grid colour token consumed by React Flow's `<Background />` (v3
 * Unit 6). React Flow forwards `color` to the SVG `<circle fill>`, and
 * SVG paint accepts CSS variables natively — so the dark-mode swap from
 * tokens.css's `:where(.dark)` block applies without a JS branch.
 */
const DOT_GRID_COLOR = 'var(--color-dot-grid)';

/**
 * Viewport-rectangle styling. Stroke uses the primary accent so the
 * "what's currently visible" overlay reads at a glance against either
 * theme; the fill is a low-alpha primary so it doesn't drown the
 * minimap nodes underneath. We use rgba on a CSS variable via
 * `color-mix` so Unit 12 only has to swap the token values.
 */
const MINIMAP_MASK_STYLE: React.CSSProperties = {
  fill: 'color-mix(in srgb, var(--color-primary) 12%, transparent)',
  stroke: 'var(--color-primary)',
  strokeWidth: 1,
};

interface BannerProps {
  message: string;
  onDismiss: () => void;
  testId: string;
}

function CanvasBanner({ message, onDismiss, testId }: BannerProps) {
  return (
    <div
      role="status"
      data-testid={testId}
      className={cn(
        'flex items-center justify-between gap-3',
        'border-warning/30 bg-warning/10 text-foreground',
        'border-b px-3 py-2',
        'text-xs',
      )}
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className={cn(
          'text-foreground/70 hover:text-foreground',
          'rounded px-2 py-0.5 text-xs',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        )}
        aria-label="Dismiss"
      >
        Dismiss
      </button>
    </div>
  );
}

interface InnerProps {
  topology: TopologySummary;
  /** Workspace path for sidecar I/O. `null` for blank sessions. */
  primaryPath: string | null;
  /** The saved layout, or `null` when none holds a position (see `hasSavedPositions`). */
  storedSidecar: SidecarLayout | null;
  /**
   * The saved layout as it is on disk, positions or not. What the canvas does
   * not draw from (figure settings, say) is carried over from here into every
   * layout it writes.
   */
  savedLayout: SidecarLayout | null;
  putSidecar: PutSidecar;
}

/** Write the layout sidecar; the callbacks report how the write went. */
type PutSidecar = (
  layout: SidecarLayout,
  callbacks?: { onSuccess?: () => void; onError?: (err: Error) => void },
) => void;

/**
 * Inner SLD canvas — assumes a topology + selection are present. The
 * outer `SldCanvas` handles the empty / loading branches and forwards
 * here once all preconditions are met.
 *
 * The hook order is: pick curated layout (if any) → run ELK in parallel
 * (we still want a fallback for unmatched buses + drift detection) →
 * merge with stored sidecar coords → render.
 */
function SldCanvasInner({
  topology,
  primaryPath,
  storedSidecar,
  savedLayout,
  putSidecar,
}: InnerProps) {
  const setSelectedElement = useCaseStore((s) => s.setSelectedElement);
  const selectedElement = useCaseStore((s) => s.selectedElement);
  const selectedNodeId = useSldStore((s) => s.selectedNodeId);
  const setSelectedNodeId = useSldStore((s) => s.setSelectedNodeId);
  const canvasRef = useRef<HTMLDivElement>(null);
  // React Flow imperative API — used to pan the viewport when the
  // selected-node id flips (search popover pick or inspector row
  // click). The hook only resolves inside a `<ReactFlowProvider />`,
  // which `SldCanvas` mounts above this component.
  const rf = useReactFlow();
  // ⌘/ (Cmd-/) opens the search popover. `enableOnFormTags` so the
  // binding still fires when the inspector's filter input or the
  // canvas-toolbar buttons have focus — same escape hatch the global
  // ⌘K palette uses.
  useHotkeys(
    SHORTCUTS.searchNodes,
    (e) => {
      e.preventDefault();
      __requestOpenSldSearch();
    },
    { enableOnFormTags: ['INPUT', 'TEXTAREA'] },
    [],
  );
  const [coords, setCoords] = useState<CoordsByIdx | null>(null);
  // The topology `coords` was composed for, and the layout. A new topology
  // arrives a render before its coords do, and so does another layout (a
  // snapshot that is restored, a layout that is reset): the graph built in
  // between pairs the new elements, or the routes of the new layout, with
  // the old positions. Nothing is saved from that one, and no route is kept
  // from it.
  const [coordsTopology, setCoordsTopology] = useState<TopologySummary | null>(null);
  const [coordsSource, setCoordsSource] = useState<{
    layout: SidecarLayout | null;
    auto: CoordsByIdx | null;
  } | null>(null);
  const [showLargeBanner, setShowLargeBanner] = useState<boolean>(false);
  const [showDriftBanner, setShowDriftBanner] = useState<boolean>(false);
  // The lock button of the controls was pressed: React Flow refuses drags and
  // selection until it is pressed again. The toolbar says so in place of the
  // hint, which would promise a drag that does nothing.
  const [locked, setLocked] = useState<boolean>(false);
  const onInteractiveChange = useCallback((interactive: boolean) => setLocked(!interactive), []);
  // A tidy of a large diagram is being worked out (`tidy`, below): nothing
  // can be moved meanwhile.
  const [tidying, setTidying] = useState(false);
  // The commands that arrange the diagram are greyed out while it is locked,
  // wherever they are listed, so the lock is kept where they can read it.
  const setDiagramLocked = useSldStore((s) => s.setDiagramLocked);
  useEffect(() => {
    setDiagramLocked(locked);
    return () => setDiagramLocked(false);
  }, [locked, setDiagramLocked]);

  // Curated layout takes precedence over auto-layout. Computed once
  // per primaryPath; the result is folded into mergeWithDrift below.
  // Blank sessions (no primaryPath) get no curated match.
  const curated = useMemo(
    () => (primaryPath ? curatedLayoutFor(primaryPath) : null),
    [primaryPath],
  );

  // Run ELK (in a worker) when the graph's shape changes, not on every new
  // topology object, and not at all when the stored or curated layout
  // already places every bus. A layout that misses a bus still runs ELK so
  // that bus gets an auto-position.
  const baseSidecar = storedSidecar ?? curated;
  const {
    coords: autoCoords,
    arrangement: autoArrangement,
    needed: autoLayoutNeeded,
  } = useAutoLayout(topology, baseSidecar);

  // Compose the final coordinate map once auto-layout resolves (at once
  // when it is not needed).
  useEffect(() => {
    if (autoLayoutNeeded && autoCoords === null) return;
    const merged = mergeWithDrift(baseSidecar, topology, autoCoords ?? {});
    setCoords(merged.coords);
    setCoordsTopology(topology);
    setCoordsSource({ layout: baseSidecar, auto: autoCoords });
    setShowDriftBanner(merged.hasDrift);
    // >30-bus banner: only when there's no curated layout AND no
    // stored sidecar AND the case is large.
    const isLarge =
      topology.buses.length > LARGE_TOPOLOGY_THRESHOLD &&
      curated === null &&
      storedSidecar === null;
    setShowLargeBanner(isLarge);
  }, [autoCoords, autoLayoutNeeded, baseSidecar, storedSidecar, curated, topology]);

  // React Flow's controlled state. Maintained in `nodes`/`edges` so we
  // can mutate node positions on drag without losing other props.
  //
  // With no layout at all (no curated one, no sidecar) the diagram is the
  // automatic arrangement: its buses, its devices and its routes
  // (`useAutoLayout`). A saved layout brings its own routes instead: the
  // ones that were on screen when it was written, so a diagram saved from
  // the automatic arrangement comes back with the same lines.
  const usingAutoLayout = curated === null && storedSidecar === null;
  const storedRoutes = useMemo(
    () => storedBranchRoutes(storedSidecar, topology),
    [storedSidecar, topology],
  );
  // The connectors of devices the saved layout holds as drawn by hand.
  const storedConnectors = useMemo(
    () => storedConnectorRoutes(storedSidecar, topology),
    [storedSidecar, topology],
  );
  // The routes chosen in this visit (Tidy diagram, a route moved by hand, or
  // an undo that put an earlier arrangement back) sit on top of those, as
  // the drags sit on top of the positions; `null` takes a route away.
  const routeOverrides = useCaseStore((s) => s.routeOverrides);
  const branchRoutes = useMemo(() => {
    const bendPoints = new Map(
      usingAutoLayout
        ? (autoArrangement?.routes ?? [])
        : [...storedRoutes.polylines, ...storedConnectors.polylines],
    );
    const bendAnchors = new Map(
      usingAutoLayout
        ? (autoArrangement?.anchors ?? [])
        : [...storedRoutes.anchors, ...storedConnectors.anchors],
    );
    // The ones that were drawn by hand: the diagram keeps those as they are.
    const bendManual = new Set(
      usingAutoLayout ? [] : [...storedRoutes.manual, ...storedConnectors.polylines.keys()],
    );
    for (const [id, chosen] of Object.entries(routeOverrides)) {
      if (chosen === null) {
        bendPoints.delete(id);
        bendAnchors.delete(id);
        bendManual.delete(id);
      } else {
        bendPoints.set(id, chosen.points);
        bendAnchors.set(id, chosen.anchors);
        if (chosen.manual === true) bendManual.add(id);
        else bendManual.delete(id);
      }
    }
    return { bendPoints, bendAnchors, bendManual };
  }, [usingAutoLayout, autoArrangement, storedRoutes, storedConnectors, routeOverrides]);
  const controllerCoords = useMemo(() => controllerCoordsAsMap(storedSidecar), [storedSidecar]);
  // Drag overrides — per-node coordinate overrides applied AFTER
  // buildGraph so user drags persist across topology re-fetches (Unit 9
  // fix). Lives on the case store (Unit 13a) so the drags outlive this
  // component when the results view takes its place, and so a restored
  // snapshot can set them.
  const dragOverrides = useCaseStore((s) => s.dragOverrides);
  const setDragOverrides = useCaseStore((s) => s.setDragOverrides);
  // Animation bookkeeping for collision push-out (Unit 3, v0.1.y).
  //
  // - `priorPositionsRef` snapshots each node's last-rendered position.
  //   On the next render we diff against it to detect push-out moves.
  // - `relocatedIdsRef` is a sticky set of node ids that have ever
  //   been relocated by push-out. Once a node is in this set we keep
  //   `transition: transform` on its style for ALL future renders so
  //   the browser doesn't interrupt the in-flight CSS transition when
  //   React reconciles the next render (CSS spec: removing the
  //   `transition` property aborts any active transition). Cleared
  //   when the user explicitly drag-overrides the node.
  const priorPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const relocatedIdsRef = useRef<Set<string>>(new Set());
  // Where the saved layout puts each generator, load and shunt of this
  // topology, for the graph builder's `nonBusCoords` opt. An entry is found
  // by its idx (model class first, UI category as the fallback for a
  // kind-edited element) or, when the idx values have changed, by the bus it
  // was placed against.
  // With no layout, where the automatic arrangement puts them.
  const nonBusCoordsMap = useMemo(
    () =>
      usingAutoLayout
        ? (autoArrangement?.devices ?? new Map<string, BusCoord>())
        : resolveDeviceCoords(storedSidecar?.non_bus_coordinates, topology),
    [usingAutoLayout, autoArrangement, storedSidecar, topology],
  );
  // How long each bar is: as long as what connects to its bus needs
  // (`defaultBarLengths`), unless a layout gives it a length of its own. It
  // still grows to hold a tap that lands past its tip.
  const barLengths = useMemo(
    () => new Map([...defaultBarLengths(topology), ...barLengthsOf(savedLayout ?? curated)]),
    [topology, savedLayout, curated],
  );
  // The generating units whose control chain is drawn out: what was chosen
  // in this visit, over what the saved layout says.
  const chosenUnits = useCaseStore((s) => s.unitExpansion);
  const unitStates = useMemo(() => {
    const states = unitStatesOf(savedLayout);
    for (const [idx, expanded] of Object.entries(chosenUnits)) {
      states.set(idx, { expanded, bus: null });
    }
    return states;
  }, [savedLayout, chosenUnits]);
  const baseGraph = useMemo(() => {
    if (!coords) return null;
    const built = buildGraph(topology, coords, {
      bendPoints: branchRoutes.bendPoints,
      bendAnchors: branchRoutes.bendAnchors,
      bendManual: branchRoutes.bendManual,
      barLengths,
      nonBusCoords: nonBusCoordsMap,
      controllerCoords,
      unitStates,
      // Drag overrides flow into buildGraph so the push-out pass
      // treats user-placed nodes as stationary obstacles. The override
      // is also re-applied below as a defensive cosmetic — the
      // pushOutCollisions locked-id guarantee already keeps overridden
      // ids at their override coord.
      dragOverrides,
    });
    // Apply drag overrides on top of the freshly-derived positions.
    // (push-out's locked path keeps overridden ids stationary; this
    // is belt-and-braces for nodes that aren't push-out candidates.)
    let nextNodes = built.nodes;
    if (Object.keys(dragOverrides).length > 0) {
      nextNodes = built.nodes.map((n) => {
        const override = dragOverrides[n.id];
        return override !== undefined ? { ...n, position: override } : n;
      });
    }
    // Animation gating: detect which nodes moved since the prior
    // render and add them to the sticky `relocatedIdsRef` set. Drag
    // overrides clear the sticky bit so subsequent drags don't carry
    // the lingering transition style. Bus nodes never participate in
    // push-out so we don't tag them either.
    const prior = priorPositionsRef.current;
    const relocated = relocatedIdsRef.current;
    const ANIMATION_THRESHOLD_PX = 0.5;
    for (const n of nextNodes) {
      if (n.type === 'bus') continue;
      const previousPosition = prior.get(n.id);
      if (dragOverrides[n.id] !== undefined) {
        // User dragged it — the new position came from the user, not
        // from push-out. Clear the sticky bit so future renders don't
        // animate user-driven moves.
        relocated.delete(n.id);
        continue;
      }
      if (!previousPosition) continue; // newly-emitted, no animation
      const movedX = Math.abs(previousPosition.x - n.position.x);
      const movedY = Math.abs(previousPosition.y - n.position.y);
      if (movedX >= ANIMATION_THRESHOLD_PX || movedY >= ANIMATION_THRESHOLD_PX) {
        relocated.add(n.id);
      }
    }
    const animatedNodes = nextNodes.map((n) => {
      if (!relocated.has(n.id)) return n;
      return {
        ...n,
        style: {
          ...(n.style ?? {}),
          // React Flow renders `transform: translate(...)` on the node
          // wrapper; transitioning it animates the move. The
          // duration-base token (200ms) matches the rest of the app's
          // motion language. The style stays applied for all future
          // renders of this node so the browser-side CSS animation
          // isn't interrupted by React removing the property.
          transition: 'transform var(--duration-base, 200ms) ease-out',
        },
      };
    });
    // Snapshot the latest positions for the next render's diff.
    const nextPrior = new Map<string, { x: number; y: number }>();
    for (const n of animatedNodes) {
      nextPrior.set(n.id, { x: n.position.x, y: n.position.y });
    }
    priorPositionsRef.current = nextPrior;
    return { nodes: animatedNodes, edges: built.edges };
  }, [
    topology,
    coords,
    branchRoutes,
    controllerCoords,
    unitStates,
    dragOverrides,
    nonBusCoordsMap,
    barLengths,
  ]);

  // The node an id that was picked is drawn on. The models of a generating
  // unit are one node, and each is still picked by an id of its own
  // (`generator-<idx>` for a machine, `controller-<class>-<idx>` for a
  // controller: a row of a table, the search, the Inspector), so such an id
  // leads to the node of the unit. An id that is a node's own is that node.
  const drawnNodeIdOf = useMemo(() => {
    const own = new Set<string>();
    const ofUnit = new Map<string, string>();
    for (const n of baseGraph?.nodes ?? []) {
      own.add(n.id);
      const unit = (n.data as { unit?: UnitNodeData }).unit;
      for (const member of unit?.members ?? []) {
        if (!ofUnit.has(member.nodeId)) ofUnit.set(member.nodeId, n.id);
      }
    }
    return (id: string | null): string | null =>
      id === null || own.has(id) ? id : (ofUnit.get(id) ?? id);
  }, [baseGraph]);
  const selectedDrawnId = drawnNodeIdOf(selectedNodeId);

  // Prune drag overrides for nodes that no longer exist (user reloaded,
  // or removed an element via a future delete API). Keeps the override
  // map from growing unbounded.
  useEffect(() => {
    if (!baseGraph) return;
    const liveIds = new Set(baseGraph.nodes.map((n) => n.id));
    const curr = useCaseStore.getState().dragOverrides;
    const next: Record<string, { x: number; y: number }> = {};
    let changed = false;
    for (const [id, coord] of Object.entries(curr)) {
      if (liveIds.has(id)) next[id] = coord;
      else changed = true;
    }
    if (changed) setDragOverrides(next);
    // The same for the routes chosen for branches that are gone.
    const liveEdges = new Set(baseGraph.edges.map((e) => e.id));
    const routes = useCaseStore.getState().routeOverrides;
    const stale = Object.keys(routes).filter((id) => !liveEdges.has(id));
    if (stale.length > 0) {
      const kept = { ...routes };
      for (const id of stale) delete kept[id];
      useCaseStore.getState().setRouteOverrides(kept);
    }
  }, [baseGraph, setDragOverrides]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  // The nodes as last set, readable from an event handler before the render
  // that follows. `onNodesChange` builds on it, so that what a drag does
  // besides moving nodes (recording the overrides) happens in the handler and
  // not inside a state updater, which React runs while rendering.
  const nodesRef = useRef<Node[]>([]);
  // The graph those nodes came from, for a handler that needs its edges: how
  // each branch is routed is part of the arrangement an undo puts back.
  const baseGraphRef = useRef<{ nodes: Node[]; edges: Edge[] } | null>(null);
  // The size React Flow measured each node at. A device's box is as wide as
  // its name, and its connector leaves from the middle of a face, so the
  // connection pass below needs the real box and not the size hint.
  const [sizes, setSizes] = useState<ReadonlyMap<string, NodeSize>>(NO_SIZES);

  useEffect(() => {
    if (!baseGraph) return;
    nodesRef.current = baseGraph.nodes;
    baseGraphRef.current = baseGraph;
    setNodes(baseGraph.nodes);
    setEdges(baseGraph.edges);
  }, [baseGraph]);

  // How device connectors are drawn: what was chosen in this visit, else what
  // the saved layout says, else straight.
  const chosenConnectorStyle = useCaseStore((s) => s.connectorStyle);
  const connectorStyle: ConnectorStyle =
    chosenConnectorStyle ?? connectorStyleOf(savedLayout) ?? DEFAULT_CONNECTOR_STYLE;

  // The nodes under the pointer in a drag, from the press to the drop, and
  // whether a drag is moving nodes right now: React Flow reports the press
  // and the moves separately, and either says that the diagram is not at
  // rest.
  const [draggedIds, setDraggedIds] = useState<readonly string[]>(NO_IDS);
  const [moving, setMoving] = useState(false);
  const dragging = draggedIds.length > 0 || moving;

  // The diagram as it is drawn, from where the nodes are now (`picture.ts`):
  // where every connector attaches and runs and how long every bar is, the
  // route of every line and transformer, clear of everything else, and
  // where the labels stand. `nodes` changes on every move of a drag, so the
  // taps, the faces, the routes and the labels follow the pointer. The
  // labels of the buses are larger once a power flow has run, with a
  // voltage and an angle in them, and the readouts of the devices and the
  // flows of the lines show only then.
  const pflowShown = usePflowStore((s) => s.lastRun !== null);
  const labelsHidden = useUiStore((s) => s.hideLabels);
  const valuesShown = pflowShown && !labelsHidden;
  // How wide each readout and each flow label is with the values the power
  // flow gave: a label is looked for a place as large as it is drawn, not as
  // large as the longest value there could be.
  const pflowResult = usePflowStore((s) => s.lastRun);
  const labelWidths = useMemo(() => {
    if (!valuesShown || baseGraph === null) return undefined;
    const readouts = new Map<string, number>();
    for (const n of baseGraph.nodes) {
      if (n.type !== 'generator' && n.type !== 'load') continue;
      const data = n.data as { idx?: string; pflowIdx?: string | null };
      const key = data.pflowIdx === undefined ? (data.idx ?? null) : data.pflowIdx;
      const { p_label, q_label } = getDeviceOverlayState(n.type, key, pflowResult);
      readouts.set(n.id, readoutWidth(p_label, q_label));
    }
    const flows = new Map<string, number>();
    for (const e of baseGraph.edges) {
      const data = e.data as { idx?: string; bucket?: string } | undefined;
      if (data?.bucket !== 'line' || data.idx === undefined) continue;
      const { p_label, loading_label } = getLineOverlayState(data.idx, pflowResult);
      flows.set(e.id, flowLabelWidth(p_label, loading_label));
    }
    return { readouts, flows };
  }, [baseGraph, pflowResult, valuesShown]);
  // The routes the picture made in the moves of the drag in hand, by edge
  // id. The next move is drawn from them: on a large diagram a route follows
  // its bus from one move to the next (`routing.ts`), and a search that
  // found a way round something is not made again with every move. They are
  // let go of when the drag ends: the diagram at rest is routed from the
  // routes it keeps.
  const dragRoutesRef = useRef<Map<string, NonNullable<RouteOverrides[string]>>>(new Map());
  const picture = useMemo(() => {
    const carried = dragRoutesRef.current;
    const at = new Map(nodes.map((n) => [n.id, n.position]));
    const sits = (id: string, then: { x: number; y: number } | undefined): boolean => {
      const now = at.get(id);
      return (
        now !== undefined &&
        then !== undefined &&
        Math.abs(now.x - then.x) < 0.01 &&
        Math.abs(now.y - then.y) < 0.01
      );
    };
    const drawn =
      dragging && carried.size > 0
        ? (edges as ConnectionEdge[]).map((edge) => {
            const route = carried.get(edge.id);
            // Back where the route it keeps was made for, a branch is drawn
            // along that one again.
            const kept = edge.data?.bendAnchors as
              | NonNullable<RouteOverrides[string]>['anchors']
              | undefined;
            // A route that was drawn by hand is brought along from where it
            // was drawn at every move, so that what the drag shows is what
            // the drop gives.
            if (
              route === undefined ||
              edge.data?.bendManual === true ||
              (sits(edge.source, kept?.source) && sits(edge.target, kept?.target))
            ) {
              return edge;
            }
            return {
              ...edge,
              data: { ...edge.data, bendPoints: route.points, bendAnchors: route.anchors },
            };
          })
        : (edges as ConnectionEdge[]);
    const made = pictureOf(nodes, drawn, {
      sizes,
      connectorStyle,
      barLengths,
      values: valuesShown,
      labelWidths,
      dragging,
    });
    if (dragging) for (const [id, route] of made.changed) carried.set(id, route);
    else carried.clear();
    return made;
  }, [nodes, edges, sizes, connectorStyle, barLengths, valuesShown, labelWidths, dragging]);
  const connections = picture.connections;
  // The picture as it was last made, for a handler that asks it about a route.
  const pictureRef = useRef(picture);
  useEffect(() => {
    pictureRef.current = picture;
  }, [picture]);
  // The diagram as it was last drawn, for the handler that ends a move: where
  // a node may be dropped depends on the bars and the connectors around it.
  const drawnRef = useRef<{
    connections: typeof connections;
    sizes: typeof sizes;
    atRest: typeof connections;
    /** What the picture is made with, for asking it about a place. */
    options: PictureOptions;
  }>({ connections, sizes, atRest: connections, options: { values: false } });
  useEffect(() => {
    drawnRef.current = {
      connections,
      sizes,
      // As it stood before the drag in hand, while there is one.
      atRest: dragging ? drawnRef.current.atRest : connections,
      options: { sizes, connectorStyle, barLengths, values: valuesShown, labelWidths },
    };
  }, [connections, sizes, dragging, connectorStyle, barLengths, valuesShown, labelWidths]);
  // The lines and transformers that are drawn through a symbol or a bar:
  // the Tidy diagram button counts them. Not while a node is being dragged,
  // when a line passes through things on its way to where the node is
  // dropped.
  const untidyCount = useMemo(
    () => branchesThroughSymbols(nodes, picture.edges, connections, sizes).length,
    [nodes, picture, connections, sizes],
  );
  // The devices whose connector is picked out (`StubEdge`): the one that is
  // selected and the ones under the pointer in a drag, so it shows which
  // connector is the device's and that it follows the device to the bar.
  const activeDeviceIds = useMemo(() => {
    const ids = new Set(draggedIds);
    if (selectedDrawnId !== null) ids.add(selectedDrawnId);
    return ids;
  }, [draggedIds, selectedDrawnId]);
  // On drag stop, persist the updated coords. Two channels:
  //
  // - In-memory `dragOverrides`: applied to the next baseGraph derivation
  //   so the override survives topology re-fetches (the bug Unit 9
  //   fixes — previously every successful add() snapped dragged nodes
  //   back to their kind-default positions).
  // - Disk sidecar (only for sessions with a primaryPath): persists the
  //   whole diagram across page reloads. It is written by the effect below
  //   from the graph the overrides produce, not from here: the edges in
  //   hand at this point still carry the routes of the buses that just
  //   moved.
  //
  // A drag begins with the press (`nodeDragThreshold={0}` below), so that React
  // Flow moves a node the whole way the pointer went. With its default
  // threshold the first pointer move only starts the drag, measured from where
  // that move ended, and a drag that arrives as one move (a pointer driven by
  // a script, or by assistive technology that goes from the press to the drop
  // in one step) left the node where it was. What the threshold kept out is
  // kept out here: a press that slips a pixel or two is a click, so the node
  // goes back and nothing is recorded. `dragOriginRef` holds where the nodes of
  // the drag in hand started, between React Flow's drag-start and drag-stop; a
  // move by the arrow keys has neither and is always kept.
  //
  // A move can be taken back (Undo, Ctrl/Cmd+Z): when it ends, the
  // arrangement it started from goes into the layout history
  // (`store/layoutHistory.ts`). `moveStartRef` holds that arrangement, from
  // the first position change of a drag, or of a press of an arrow key, to
  // the change that ends it. Presses of the arrow keys on the same nodes in
  // quick succession are one move.
  const persistRequestedRef = useRef(false);
  // Whether the user has been told what a route drawn by hand is.
  const explainedByHandRef = useRef(false);
  // Whether a change of this visit was just written, and the routes the
  // diagram makes for it are still to come: they are written as well. Until
  // the diagram is at rest again with nothing left to route.
  const routesToFollowRef = useRef(false);
  const dragOriginRef = useRef<Map<string, { x: number; y: number }> | null>(null);
  const moveStartRef = useRef<{ nodes: Node[]; dragged: boolean } | null>(null);
  // What the last tidy came to, shown beside the Tidy diagram button until
  // the diagram is arranged some other way: a notice that fades after a few
  // seconds is easily missed, and "already tidy" changes nothing else that
  // could be seen.
  const [tidyNote, setTidyNote] = useState<string | null>(null);
  useEffect(() => setTidyNote(null), [topology]);
  const onNodeDragStart: OnNodeDrag = useCallback((_event, _node, dragged) => {
    dragOriginRef.current = new Map(dragged.map((n) => [n.id, { ...n.position }]));
    setDraggedIds(dragged.map((n) => n.id));
  }, []);
  const onNodeDragStop: OnNodeDrag = useCallback(() => {
    dragOriginRef.current = null;
    setDraggedIds(NO_IDS);
  }, []);
  const setPickedNodeIds = useSldStore((s) => s.setPickedNodeIds);
  // The ids the diagram last showed as selected, which React Flow's own
  // selection changes are applied to (see `nodesWithSelection`).
  const selectedIdsRef = useRef<readonly string[]>(NO_IDS);
  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      setSizes((held) => withMeasuredSizes(held, changes));
      // What React Flow selects (a box drawn with Shift held, a click with
      // Ctrl or Cmd held) is the set of nodes picked together. Its changes
      // are against the selection it was last given, which is the one the
      // diagram last showed.
      const selections = changes.filter((c): c is NodeSelectionChange => c.type === 'select');
      if (selections.length > 0) {
        const picked = new Set(selectedIdsRef.current);
        for (const c of selections) {
          if (c.selected) picked.add(c.id);
          else picked.delete(c.id);
        }
        setPickedNodeIds([...picked]);
      }
      const moving = changes.some((c) => c.type === 'position' && c.position !== undefined);
      if (!moving) return;
      setTidyNote(null);
      const start = (moveStartRef.current ??= { nodes: nodesRef.current, dragged: false });
      if (changes.some((c) => c.type === 'position' && c.dragging === true)) start.dragged = true;
      let next = applyPositionChanges(nodesRef.current, changes);
      const dragEnded = changes.some(
        (c): c is NodePositionChange =>
          c.type === 'position' && c.dragging === false && c.position !== undefined,
      );
      setMoving(start.dragged && !dragEnded);
      const origin = dragOriginRef.current;
      // To the nearest pixel: the positions are in flow units, and a pointer
      // that went two pixels comes back from them as a hair over or under two.
      const slipped =
        dragEnded &&
        origin !== null &&
        Math.round(farthestMove(origin, next) * rf.getZoom()) <= DRAG_SLOP_PX;
      // A press that slipped puts everything back, the devices its bus took
      // along as well.
      if (slipped) next = withPositions(next, new Map(start.nodes.map((n) => [n.id, n.position])));
      // Whether what was dropped went back where it stood, with no place
      // near where it was dropped that the diagram can be drawn with.
      let putBack = false;
      // What was dropped on a symbol, on a bar or on a connector, or with
      // its bar right under another, goes to the nearest place where it is
      // on nothing (`clearDrop`): the lines and the labels go round what
      // stands on the diagram, and two symbols on each other they cannot.
      // A place is also asked of the picture of the diagram (`drawsClear`):
      // one where a connector or a line would be drawn through something is
      // not taken, and with no clear place near, the nodes go back.
      if (dragEnded && !slipped && baseGraphRef.current !== null) {
        const letGo = movedNodes(start.nodes, next);
        const dropped = new Set(letGo.map((n) => n.id));
        // A badge that is docked follows its node when the graph is built
        // again: where it stands now is where that node was.
        const stands = (n: Node): boolean => {
          const data = n.data as { parentNodeId?: string; placed?: boolean };
          return !(
            n.type === 'controller' &&
            data.placed !== true &&
            dropped.has(data.parentNodeId ?? '')
          );
        };
        const standing = next.filter(stands);
        const stood = new Map(start.nodes.map((n) => [n.id, n.position]));
        const from = letGo[0] === undefined ? undefined : stood.get(letGo[0].id);
        const graphEdges = baseGraphRef.current.edges as ConnectionEdge[];
        const shift = clearDrop(standing, graphEdges, dropped, drawnRef.current.connections, {
          sizes: drawnRef.current.sizes,
          step: useLayoutStore.getState().sldSnapToGrid ? GRID_STEP : undefined,
          atRest: drawnRef.current.atRest,
          clear: drawsClear(start.nodes.filter(stands), graphEdges, drawnRef.current.options),
          pictures: graphEdges.length > DROP_PICTURES_UP_TO ? DROP_PICTURES_LARGE : DROP_PICTURES,
          back:
            from === undefined
              ? undefined
              : { dx: from.x - letGo[0]!.position.x, dy: from.y - letGo[0]!.position.y },
        });
        if (shift?.back === true) {
          // Each to where it stood: the nodes of one move need not all have
          // gone the same way (a grid they snap to).
          next = withPositions(next, stood);
          putBack = true;
          toast.info('Put back where it was', {
            description: `${DROPPED_ON[shift.onto]} No place near there is clear either, and nothing on the diagram is drawn over anything else, so the move was not made.`,
            duration: 8_000,
          });
        } else if (shift !== null) {
          next = withPositions(
            next,
            new Map(
              next
                .filter((n) => dropped.has(n.id))
                .map((n) => [n.id, { x: n.position.x + shift.dx, y: n.position.y + shift.dy }]),
            ),
          );
          toast.info('Moved to the nearest free place', {
            description: `${DROPPED_ON[shift.onto]} Nothing on the diagram is drawn over anything else, so it stands as near as it can. Undo puts it back where it was before the move.`,
            duration: 8_000,
          });
        }
      }
      if (next !== nodesRef.current) {
        nodesRef.current = next;
        setNodes(next);
      }
      if (!dragEnded) return;
      moveStartRef.current = null;
      // A move that was not made is no step for Undo, and nothing to write.
      if (slipped || putBack) return;
      // The move can be taken back: keep the arrangement it started from.
      const moved = movedNodes(start.nodes, next);
      if (moved.length > 0 && baseGraphRef.current !== null) {
        useLayoutHistoryStore.getState().record(
          moveLabel(moved),
          arrangementOf(start.nodes, baseGraphRef.current.edges),
          // A press of an arrow key has no drag in it.
          start.dragged ? null : `nudge:${moved.map((n) => n.id).join('|')}`,
        );
      }
      // Capture the current position of every node that can be dragged
      // into the override map. The map keys by React Flow node id (bus
      // idx for buses, `${kind}-${idx}` for non-bus nodes). A controller
      // badge cannot be dragged: its place follows from what it is docked
      // to, and an override would pin it where that used to be.
      setDragOverrides(positionsOf(next));
      persistRequestedRef.current = true;
    },
    [setDragOverrides, setPickedNodeIds, rf],
  );

  // Keep the layout of the diagram as drawn where a save can reach it
  // (`diagramLayout`), and write it beside the case after a drag. Loaded
  // sessions only for the write: a system built from scratch has no file to
  // keep a layout beside until it is saved.
  const setDiagramLayout = useCaseStore((s) => s.setDiagramLayout);
  const coordsAreCurrent =
    coordsTopology === topology &&
    coordsSource !== null &&
    coordsSource.layout === baseSidecar &&
    coordsSource.auto === autoCoords;
  useEffect(() => {
    // A graph whose coords belong to the topology or the layout of a render
    // ago is redrawn at once; a write asked for meanwhile waits for the
    // graph that follows.
    if (!baseGraph || !coordsAreCurrent) return;
    const layout = captureLayout(baseGraph, topology, savedLayout, {
      connectorStyle: chosenConnectorStyle,
    });
    setDiagramLayout(layout);
    if (!persistRequestedRef.current) return;
    persistRequestedRef.current = false;
    // The routes the diagram makes for this change are written after it.
    routesToFollowRef.current = true;
    if (primaryPath && hasSavedPositions(layout)) {
      debouncedPutSidecar(primaryPath, layout, putSidecar);
    }
  }, [
    baseGraph,
    coordsAreCurrent,
    topology,
    savedLayout,
    chosenConnectorStyle,
    primaryPath,
    putSidecar,
    setDiagramLayout,
  ]);

  // The routes the picture made while it was drawn (`picture.changed`: the
  // branches of a bus that was moved, a line a device was dropped on, the
  // lines of a layout that brought no routes) become the routes the diagram
  // keeps, once it is at rest: in a drag they are worked out afresh with
  // every move. The next picture then finds them in place and routes
  // nothing, they are part of the arrangement an Undo puts back, and they
  // are written beside the case with the positions that led to them.
  // How many times in a row routes were kept with nothing else changing in
  // between. Each time should leave the next picture with nothing to route;
  // should two routes ever keep unsettling each other, this ends it.
  const settlingRef = useRef(0);
  // Not from a graph whose positions are a render behind its layout (a
  // snapshot that was just restored, a layout that was just reset and whose
  // automatic arrangement is still on its way), and not from the edges of
  // the graph before (they are handed to React Flow a render after the
  // graph they come from is built): what is drawn until then is not the
  // diagram yet, and routes kept from it would stand in for the ones the
  // layout brings.
  useEffect(() => {
    if (dragging || !coordsAreCurrent) return;
    if (baseGraph === null || edges !== baseGraph.edges) return;
    // The routes that were drawn by hand and are no longer: what they are
    // attached to was moved to where they do not fit.
    const drawnByHand = new Set(
      edges.filter((edge) => edge.data?.bendManual === true).map((edge) => edge.id),
    );
    // One of them that is worked out again and has no route of its own now
    // (the connector of a device, a line no way was found for) has none to
    // keep: `null` says so over whatever the saved layout holds, so that the
    // diagram that is written is the one that is drawn.
    const letGo = picture.released.filter((id) => drawnByHand.has(id) && !picture.changed.has(id));
    if (picture.changed.size === 0 && letGo.length === 0) {
      settlingRef.current = 0;
      routesToFollowRef.current = false;
      return;
    }
    if (settlingRef.current >= SETTLING_ROUNDS) return;
    const held = useCaseStore.getState().routeOverrides;
    const next: RouteOverrides = { ...held };
    let changed = false;
    const givenUp: string[] = [];
    for (const [id, route] of picture.changed) {
      if (
        JSON.stringify(held[id]?.points ?? null) === JSON.stringify(route.points) &&
        (held[id]?.manual === true) === (route.manual === true)
      ) {
        continue;
      }
      next[id] = route;
      changed = true;
      if (drawnByHand.has(id) && route.manual !== true) givenUp.push(id);
    }
    for (const id of letGo) {
      next[id] = null;
      changed = true;
      givenUp.push(id);
    }
    if (!changed) return;
    settlingRef.current += 1;
    useCaseStore.getState().setRouteOverrides(next);
    if (givenUp.length > 0) {
      const first = edges.find((edge) => edge.id === givenUp[0]);
      toast.info(
        givenUp.length === 1 && first !== undefined
          ? `The route you drew for ${routeNameOf(first)} no longer fits`
          : `${givenUp.length} routes you drew no longer fit`,
        {
          description:
            'Where its ends stand now it would run over something, fold back on itself or run along its own symbol, so it is routed automatically again. If a move led to this, Undo takes the move back and the route with it.',
          duration: 8_000,
        },
      );
    }
    // They are written with the change that led to them (`routesToFollowRef`):
    // a move, or anything else that was just written for this diagram. A
    // diagram that was only opened is not written for being drawn, whether
    // it stands in its automatic arrangement or came from a layout saved
    // without routes; its routes are made again the next time, and saved
    // with the next change. Nor is the system of a case that is just being
    // opened: its topology arrives a moment before the store lets go of the
    // case that was open, and what is drawn for that moment is the new
    // system under the name of the old one.
    if (routesToFollowRef.current) persistRequestedRef.current = true;
  }, [picture, dragging, coordsAreCurrent, baseGraph, edges]);

  // The lines that are routed by hand, counted for the commands that reset
  // them, and gone with the diagram.
  const manualRoutes = useMemo(
    () => edges.filter((edge) => edge.data?.bendManual === true).length,
    [edges],
  );
  const setManualRouteCount = useSldStore((s) => s.setManualRouteCount);
  useEffect(() => {
    setManualRouteCount(manualRoutes);
  }, [manualRoutes, setManualRouteCount]);
  useEffect(() => () => setManualRouteCount(0), [setManualRouteCount]);
  // The lines and transformers among them, which the Inspector of one reads.
  const setManualBranchIdxes = useSldStore((s) => s.setManualBranchIdxes);
  useEffect(() => {
    setManualBranchIdxes(
      edges
        .filter((edge) => edge.type !== 'stub' && edge.data?.bendManual === true)
        .map((edge) => String((edge.data as { idx?: unknown }).idx)),
    );
  }, [edges, setManualBranchIdxes]);
  useEffect(() => () => setManualBranchIdxes([]), [setManualBranchIdxes]);

  // A write still waiting out its delay when the canvas goes away (another
  // view, another case) is sent then, not dropped: the drag stays on screen
  // through `dragOverrides`, and the file would otherwise be a drag behind
  // the diagram until the next one.
  useEffect(() => {
    if (!primaryPath) return;
    const path = primaryPath;
    return () => flushPendingSidecarPut(path);
  }, [primaryPath]);

  // The line, transformer or device connector whose route is being moved by
  // hand, by the id of its edge: the one that was last clicked. It shows its
  // handles (`SldRouteEditor`) until something else is clicked.
  const [routeEditId, setRouteEditId] = useState<string | null>(null);
  // Where the bar of that line is drawn: in the row above the diagram, in
  // the place of the line that says what can be done on it.
  const [routeBarSlot, setRouteBarSlot] = useState<HTMLDivElement | null>(null);
  const onNodeClick: NodeMouseHandler = useCallback(
    (_e, node) => {
      setRouteEditId(null);
      const data = node.data as { idx?: string; kind?: string };
      const idx = data.idx ?? node.id;
      // Map the React Flow nodeType back to the inspector's element-kind
      // taxonomy. Validate against the registered NODE_TYPES keys before
      // narrowing — an unknown `node.type` would otherwise silently route
      // to the wrong inspector bucket.
      const rawKind = node.type ?? 'bus';
      if (!Object.prototype.hasOwnProperty.call(NODE_TYPES, rawKind)) {
        console.warn(`SldCanvas: ignoring click on node with unknown type ${String(rawKind)}`);
        return;
      }
      // Controllers carry a sub-kind on the `'controller'` SelectedElement
      // variant (Unit 18). Prefer the sub-kind already stamped on the node
      // by buildGraph; fall back to re-deriving from the model class.
      if (rawKind === 'controller') {
        const cd = node.data as { kind?: string; subKind?: ControllerSubKind };
        const modelClass = cd.kind ?? '';
        const subKind = cd.subKind ?? subKindForControllerClass(modelClass);
        setSelectedElement({ kind: 'controller', subKind, modelClass, idx: String(idx) });
        setSelectedNodeId(node.id, 'diagram');
        return;
      }
      const kind = rawKind as 'bus' | 'line' | 'generator' | 'load' | 'shunt';
      // A generator names its model: the symbol stands for a whole unit, whose
      // static generator and machine can have the same idx.
      setSelectedElement(
        kind === 'generator' && typeof data.kind === 'string'
          ? { kind, idx: String(idx), modelClass: data.kind }
          : { kind, idx: String(idx) },
      );
      // Unit 11: also write the SLD store's selectedNodeId so the
      // canvas + bus-node visual highlight follow the click. The
      // inspector-row → SLD-pan path goes through the same slot, without
      // the `'diagram'` that says the user is already looking at the node.
      setSelectedNodeId(node.id, 'diagram');
    },
    [setSelectedElement, setSelectedNodeId],
  );

  const pickEdge = useCallback(
    (edge: Edge) => {
      const edgeType = edge.type ?? 'topology';
      // A click picks the line to move its route by hand, the connector of
      // a device included. Not while nothing can be moved.
      setRouteEditId(locked || tidying ? null : edge.id);
      // A connector is not an element of its own: the Inspector keeps what
      // it shows.
      if (edgeType === 'stub') return;
      const data = edge.data as { idx?: string; bucket?: string } | undefined;
      const idx = data?.idx;
      if (!idx) return;
      const kind: 'line' | 'transformer' = edgeType === 'transformer' ? 'transformer' : 'line';
      setSelectedElement({ kind, idx: String(idx) });
      // The line is what is selected now, not the node that was before it.
      useSldStore.getState().clearSelectedNodeId();
    },
    [setSelectedElement, locked, tidying],
  );
  const onEdgeClick: EdgeMouseHandler = useCallback((_e, edge) => pickEdge(edge), [pickEdge]);
  const onPaneClick = useCallback(() => setRouteEditId(null), []);
  // Set where the line that is picked next takes the keyboard focus on its
  // longest run: one that was picked with the keys is moved with the keys.
  const focusRouteRef = useRef(false);
  // Enter or Space on a line that has the keyboard focus picks it, as a
  // click on it does. React Flow only marks it selected for those keys.
  // Escape lets go of the line that is picked, wherever on the diagram the
  // focus is: a line that was clicked has it on the line, not on a handle.
  const onSurfaceKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        setRouteEditId(null);
        return;
      }
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (!(e.target instanceof Element) || !e.target.classList.contains('react-flow__edge')) {
        return;
      }
      const id = e.target.getAttribute('data-id');
      const edge = baseGraphRef.current?.edges.find((held) => held.id === id);
      if (edge === undefined) return;
      // Space would scroll the page.
      e.preventDefault();
      if (locked) {
        toast.info(LOCKED_NOTICE);
        return;
      }
      focusRouteRef.current = true;
      pickEdge(edge);
    },
    [pickEdge, locked],
  );

  // Connectivity / island-detection overlay (Unit 17). Subscribes to
  // the connectivity slice; when a result is present we flag every
  // bus that is NOT in a non-trivial island as "de-energised" so the
  // canvas can grey it out. Subscribing to `result` (rather than
  // `energisedBusIdxes` directly) keeps the membership check
  // referentially stable while the user navigates around the canvas.
  const connectivityResult = useConnectivityStore((s) => s.result);
  const energisedBusIdxes = useConnectivityStore((s) => s.energisedBusIdxes);

  // The buses and devices picked together (`pickedNodeIds`), when there are
  // two or more of them that are still on the diagram and can be moved.
  const pickedNodeIds = useSldStore((s) => s.pickedNodeIds);
  const pickedSet = useMemo(() => {
    if (pickedNodeIds.length < 2) return null;
    const movable = new Set(nodes.filter((n) => n.draggable !== false).map((n) => n.id));
    const picked = pickedNodeIds.filter((id) => movable.has(id));
    return picked.length >= 2 ? new Set(picked) : null;
  }, [pickedNodeIds, nodes]);
  const pickedCount = pickedSet?.size ?? 0;
  // The commands that line the picked nodes up are listed by how many there
  // are to line up, so that count is kept where they can read it. The picked
  // nodes are this diagram's: they go when it does.
  const setPickedCount = useSldStore((s) => s.setPickedCount);
  useEffect(() => {
    setPickedCount(pickedCount);
  }, [pickedCount, setPickedCount]);
  useEffect(
    () => () => {
      setPickedNodeIds([]);
      setPickedCount(0);
    },
    [setPickedNodeIds, setPickedCount],
  );

  // Sync React Flow's `selected` state with the case store so a
  // selection driven from the results table (Unit 9) reflects on the
  // canvas without needing a callback round-trip. Also threads the
  // Unit 17 connectivity overlay: bus nodes whose idx is NOT in the
  // current energised-set get a `de-energised` class on the React
  // Flow node wrapper. The class is consumed by Tailwind below
  // (opacity + grayscale) so the visual greying is a single CSS
  // change, not a per-node prop drill into BusNode.
  const nodesWithSelection = useMemo(
    () =>
      nodes.map((n) => {
        // Two paths produce a "selected" highlight:
        //
        //  1. The case-store `selectedElement` (driven by node clicks +
        //     inspector deeper interactions — the v0.1 path).
        //  2. The SLD-store `selectedNodeId` (driven by the search
        //     popover and the inspector results-table row click — Unit
        //     11). Either one alone is enough; we union them so the
        //     visual stays consistent regardless of which channel
        //     wrote.
        // Nodes picked together take the place of both: while two or more
        // are picked, they are the selection.
        const selected =
          pickedSet !== null
            ? pickedSet.has(n.id)
            : isSelectedNode(n, selectedElement, selectedDrawnId);
        // Greying only applies to bus nodes — non-bus device nodes are
        // children of buses for the purposes of energisation, but
        // their own grey-out cascade is handled by the connectivity
        // result's bus membership. (Future: extend to PV/PQ devices
        // anchored to greyed buses; deferred to v2.5.)
        const isBus = (n.type ?? 'bus') === 'bus';
        const isDeEnergised = isBus && connectivityResult !== null && !energisedBusIdxes.has(n.id);
        const baseClassName = (n as { className?: string }).className ?? '';
        const className = isDeEnergised
          ? `${baseClassName} sld-bus-de-energised opacity-40 grayscale`.trim()
          : baseClassName || undefined;
        // What the connection pass worked out for this node: the bar of a
        // bus with its taps, and the face a device's connector leaves by.
        const bar = isBus ? connections.bars.get(n.id) : undefined;
        // Where the label of the bus stands: under its bar, clear of what
        // lands and passes there, or over the bar, or beside a tip of it.
        const label = isBus ? picture.busLabels.get(n.id) : undefined;
        const connector = isBus ? undefined : connections.routes.get(`stub-${n.id}`);
        const connectorFace = connector?.sourceSide;
        // Which way the connector goes from that face: to the left, to the
        // right, or neither (straight out of it).
        const connectorLean =
          connector === undefined
            ? 0
            : Math.sign(Math.round(connector.points[1]![0] - connector.points[0]![0]));
        // A node object without its measured size makes React Flow measure
        // the node again, and report the size again, each time the object is
        // replaced. Handing the size back keeps one measurement per node.
        const measured = sizes.get(n.id);
        // The P / Q readout of a generator or load stands right of a
        // connector that runs straight out of the face it hangs off. Where
        // another connector runs through it there (a line lands on the bar
        // just right of the device), or something stands there, it stands
        // somewhere else (`placeReadouts`), and the node is told where; with
        // no place at all it is left off.
        const spot = picture.readouts.get(n.id)?.spot;
        const readoutSpot =
          spot === undefined ||
          spot === 'right' ||
          spot === 'centre' ||
          (spot === 'left' && connectorLean === 1)
            ? undefined
            : spot;
        // The side the chain of a unit is drawn out on, where that is not
        // the one `buildGraph` gave it.
        const unit = (n.data as { unit?: UnitNodeData }).unit;
        const chain = picture.chains.get(n.id);
        const drawnOut =
          unit !== undefined && chain !== undefined && chain.side !== unit.side
            ? { unit: { ...unit, side: chain.side } }
            : undefined;
        return {
          ...n,
          ...(measured !== undefined ? { measured } : {}),
          selected,
          className,
          data: {
            ...(n.data as Record<string, unknown>),
            ...(bar !== undefined ? { bar } : {}),
            ...(label !== undefined
              ? {
                  labelAt: {
                    offset: label.offset,
                    side: label.side,
                    ...(label.side === 'away' ? { top: label.box.top - n.position.y } : {}),
                    ...(label.compact === true ? { compact: true } : {}),
                  },
                }
              : {}),
            ...(connectorFace !== undefined ? { connectorFace } : {}),
            ...(connectorLean !== 0 ? { connectorLean } : {}),
            ...(readoutSpot !== undefined ? { readoutSpot } : {}),
            ...drawnOut,
            // Attribute echoed onto BusNode's wrapper via the spread
            // pattern in the React Flow node mapping; tests assert on
            // this exact attribute rather than the className so the
            // assertion survives any future visual-styling tweak.
            energised: isDeEnergised ? false : true,
            // Unit 11: forwarded to BusNode so its `data-selected`
            // attribute can light up when the user picks a row from
            // the search popover or the inspector. The `selected`
            // boolean above already satisfies React Flow's own
            // selection semantics; this dedicated flag lets the node
            // component branch on the search-driven channel without
            // re-deriving the union.
            sldSelected: selectedDrawnId === n.id,
          },
        };
      }),
    [
      nodes,
      selectedElement,
      selectedDrawnId,
      pickedSet,
      connectivityResult,
      energisedBusIdxes,
      connections,
      picture,
      sizes,
    ],
  );
  // What the handlers read of the diagram as it was last drawn: which nodes
  // show as selected, and where the chains that are drawn out stand.
  const drawnNodesRef = useRef<Node[]>([]);
  useEffect(() => {
    drawnNodesRef.current = nodesWithSelection;
    selectedIdsRef.current = nodesWithSelection.filter((n) => n.selected).map((n) => n.id);
  }, [nodesWithSelection]);

  // Where each line carries its flow label and each transformer its symbol
  // (`labels.ts`): on a straight run of its route, or beside one, clear of
  // the symbols, of the labels of the buses, of the P / Q readouts of the
  // devices, and of each other.
  const labelPlaces = picture.labelPlaces;
  // The edges with their routes. An edge whose route did not change keeps its
  // object, so React Flow redraws only the connectors that moved.
  const routedEdgesRef = useRef<Map<string, RoutedEdgeEntry>>(new Map());
  const routedEdges = useMemo(() => {
    const next = new Map<string, RoutedEdgeEntry>();
    const out = edges.map((edge) => {
      const route = connections.routes.get(edge.id);
      if (!route) return edge;
      const active = edge.type === 'stub' && activeDeviceIds.has(edge.source);
      const labelAt = labelPlaces.get(edge.id);
      const signature = `${active ? 'active' : ''}${JSON.stringify(route)}${JSON.stringify(labelAt ?? null)}`;
      const held = routedEdgesRef.current.get(edge.id);
      const entry =
        held !== undefined && held.base === edge && held.signature === signature
          ? held
          : { base: edge, signature, edge: withRoute(edge, route, active, labelAt) };
      next.set(edge.id, entry);
      return entry.edge;
    });
    routedEdgesRef.current = next;
    return out;
  }, [edges, connections, activeDeviceIds, labelPlaces]);

  // Pan-on-selection effect (Unit 11). When `selectedNodeId` flips,
  // centre the React Flow viewport on the matching node — keeping the
  // current zoom level so users don't lose context. The one exception
  // is a node picked away from the diagram (a table row, the search)
  // while the diagram is too small to read: the pick asks where the
  // node is, and a highlight a few pixels across does not answer that,
  // so the view goes to full size as well (`locateZoom`). A click on
  // the diagram itself keeps the zoom whatever it is. The effect runs
  // for every change including the canvas's own click writes, but
  // panning to a node that's already centred is a no-op so the cost
  // is negligible. Skipped when the selected id doesn't match a
  // mounted node (e.g., topology changed since the id was set).
  useEffect(() => {
    if (selectedDrawnId === null) return;
    // A click that adds a node to the ones already picked is not a request
    // to be shown it: the view stays where the selection is being made.
    if (useSldStore.getState().pickedNodeIds.length >= 2) return;
    const node = nodes.find((n) => n.id === selectedDrawnId);
    if (!node) return;
    const currentZoom = rf.getZoom();
    const centre = centreOf(node, sizes.get(node.id));
    rf.setCenter(centre.x, centre.y, {
      zoom: useSldStore.getState().selectedOnDiagram ? currentZoom : locateZoom(currentZoom),
      duration: 250,
    });
    // We intentionally depend on `selectedNodeId` only — re-running on
    // every node-position diff (drag) would yank the viewport on each
    // mouse move. The user's last "select" intent is what should
    // drive the pan, not subsequent layout adjustments.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNodeId]);

  // ---- Component Library drag-and-drop (v3 Unit 5) -----------------------
  //
  // The LeftSidebar's ComponentLibrary tiles are HTML5-draggable; the
  // canvas accepts drops via the matching MIME type. The drop handler
  // computes a flow-space coordinate via `useReactFlow().screenToFlowPosition`
  // and routes through `useCaseStore.openAddPanel(kind, dropCoord)` so
  // AddElementPanel can pre-fill the bus form's position seed when the
  // dropped kind is "Bus". Non-Bus kinds get the panel opened with the
  // kind pre-selected; the dropCoord is informational only (non-Bus
  // elements anchor to a parent bus).
  //
  // F-DESIGN-1 cleanup: HTML5 dragend ALWAYS fires after a drop (whether
  // successful or canceled / Escape / out-of-bounds). The drop handler
  // does the productive work; the dragend handler is a no-op cleanup
  // placeholder. We don't need to clear `addPanelDropCoord` from
  // dragend because (a) on a successful drop the AddElementPanel close
  // path already nulls the field via `closeAddPanel`, and (b) on a
  // canceled drop the drop handler never ran so nothing was set in the
  // first place. The `closeAddPanelDropCoord` action exists for the
  // odd case where the drop handler ran but `openAddPanel` was rejected
  // mid-flight by another action — defensive plumbing that's currently
  // unreachable but documented for future contributors.
  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Required to make the area a valid drop target. Without this the
    // browser shows the "no-drop" cursor and onDrop never fires.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const kind = e.dataTransfer.getData(COMPONENT_DND_MIME);
      // Empty payload → some other DnD interaction (file drop, image
      // drag, etc.). Bail without preventDefault so the browser can
      // handle the original behaviour.
      if (!kind) return;
      e.preventDefault();
      const flowCoord = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      useCaseStore.getState().openAddPanel(kind, { x: flowCoord.x, y: flowCoord.y });
    },
    [rf],
  );
  const onDragEnd = useCallback(() => {
    // No-op cleanup placeholder per F-DESIGN-1. dragend always fires
    // after drop (successful or canceled). The drop handler did the
    // productive work; on cancel/escape it never ran. Nothing to clean
    // up here. Comment is intentional — drops the noise from
    // disappearing onDragEnd silently in code review.
  }, []);

  // ---- Fit view and Reset to auto-layout ---------------------------------
  //
  // Commands of the palette and of the right-click menu; the registry reaches
  // the canvas through the bridge in ``store/sld.ts``.
  // A fit shows the whole diagram clear of the minimap and the zoom controls
  // (`fitPadding`).
  const fitWithin = useCallback(
    (duration: number) => {
      const surface = canvasRef.current;
      const bounds = rf.getNodesBounds(nodesRef.current);
      const padding =
        surface === null
          ? undefined
          : fitPadding({ width: surface.clientWidth, height: surface.clientHeight }, bounds);
      void rf.fitView({ duration, ...(padding !== undefined ? { padding } : {}) });
    },
    [rf],
  );
  const fitView = useCallback(() => fitWithin(250), [fitWithin]);
  // React Flow fits a diagram when it first draws it, to the edges of the
  // pane. Once every node has been measured it is fitted again, clear of
  // what floats over the corners.
  const fittedRef = useRef(false);
  useEffect(() => {
    if (fittedRef.current || nodes.length === 0 || !nodes.every((n) => sizes.has(n.id))) return;
    fittedRef.current = true;
    fitWithin(0);
  }, [nodes, sizes, fitWithin]);

  // The button above a diagram that is too small to read (`SldCanvasHint`):
  // full size, on the selected bus or device when there is one, and about
  // the middle of the view otherwise.
  const selectedName = useMemo(() => {
    const node = baseGraph?.nodes.find((n) => isSelectedNode(n, selectedElement, selectedDrawnId));
    if (!node) return null;
    const data = node.data as { name?: string; idx?: string };
    return data.name || data.idx || node.id;
  }, [baseGraph, selectedElement, selectedDrawnId]);
  const zoomToFullSize = useCallback(() => {
    const node = nodesRef.current.find((n) =>
      isSelectedNode(
        n,
        useCaseStore.getState().selectedElement,
        drawnNodeIdOf(useSldStore.getState().selectedNodeId),
      ),
    );
    if (!node) {
      void rf.zoomTo(FULL_ZOOM, { duration: 250 });
      return;
    }
    const centre = centreOf(node, sizes.get(node.id));
    void rf.setCenter(centre.x, centre.y, { zoom: FULL_ZOOM, duration: 250 });
  }, [rf, sizes, drawnNodeIdOf]);

  // Forget where things were put: the drags of this visit (``dragOverrides``),
  // the control chains drawn out in it, and the layout saved beside the case.
  // The diagram is then laid out as when the case first opened, with the case's
  // own curated layout if it has one and ELK otherwise. The server has no way to
  // delete a sidecar, so it is replaced by one with no placement in it, which the
  // canvas reads as none (``hasSavedPositions``); the figure settings are not
  // placement and stay. A layout placed by hand is work, so the toast offers
  // Undo, which puts all of it back.
  const resetLayout = useCallback(() => {
    const previousOverrides = useCaseStore.getState().dragOverrides;
    const previousRoutes = useCaseStore.getState().routeOverrides;
    const previousUnits = useCaseStore.getState().unitExpansion;
    // What the file holds that a reset takes back: positions, or the chains
    // it says are drawn out.
    const previousSaved =
      storedSidecar ??
      (savedLayout !== null && Object.keys(savedLayout.units ?? {}).length > 0
        ? savedLayout
        : null);
    if (
      Object.keys(previousOverrides).length === 0 &&
      Object.keys(previousRoutes).length === 0 &&
      Object.keys(previousUnits).length === 0 &&
      previousSaved === null
    ) {
      toast.info('The diagram is already in its automatic layout.');
      return;
    }
    if (primaryPath) cancelPendingSidecarPut(primaryPath);
    // The arrangement as it is drawn, chains and all, for Undo (Ctrl/Cmd+Z)
    // to put back once the toast below is gone.
    const history = useLayoutHistoryStore.getState();
    const step =
      baseGraphRef.current === null
        ? null
        : history.record(
            'reset to auto-layout',
            arrangementOf(nodesRef.current, baseGraphRef.current.edges, true),
          );
    // A chain that is drawn out is part of how the diagram was arranged: the
    // units go back to their symbols, in this visit and in the file.
    const setArrangement = useCaseStore.getState().setArrangement;
    setArrangement({ dragOverrides: {}, routeOverrides: {}, unitExpansion: {} });
    const putBack = () => {
      setArrangement({
        dragOverrides: previousOverrides,
        routeOverrides: previousRoutes,
        unitExpansion: previousUnits,
      });
      // Taken back here, so there is no step left for Undo to take back.
      if (step !== null) useLayoutHistoryStore.getState().discard(step);
    };
    // The Undo of the toast takes the reset back while it is still the
    // newest change. After a move or a tidy made since, putting the old
    // arrangement back would overwrite that and leave the history telling
    // of steps that no longer match the diagram, so it says where to go.
    const reported = () =>
      toast.success('Layout reset to auto-layout', {
        action: {
          label: 'Undo',
          onClick: () => {
            const past = useLayoutHistoryStore.getState().past;
            if (step !== null && past[past.length - 1]?.id !== step) {
              toast.info(CHANGED_SINCE_NOTICE);
              return;
            }
            putBack();
            if (previousSaved !== null) putSidecar(previousSaved);
          },
        },
      });
    if (previousSaved === null) {
      // Nothing saved to replace (a blank system, or only drags of this visit).
      reported();
      return;
    }
    // The connector style is a figure setting too; one chosen in this visit
    // may not have reached the file yet.
    const chosen = useCaseStore.getState().connectorStyle;
    const figure = {
      ...(previousSaved.figure ?? {}),
      ...(chosen !== null ? { [CONNECTOR_STYLE_SETTING]: chosen } : {}),
    };
    putSidecar(buildSidecarLayout({}, { sections: { figure } }), {
      onSuccess: reported,
      onError: (err) => {
        putBack();
        toast.error(`Could not reset the saved layout: ${err.message}`);
      },
    });
  }, [primaryPath, storedSidecar, savedLayout, putSidecar]);

  // ---- Tidy, align and distribute, and taking a change back ---------------
  //
  // Each of these puts a new arrangement in place: where the nodes stand
  // (`dragOverrides`) and how the branches run (`routeOverrides`), in one
  // step, and asks for it to be written beside the case as a drag is. The
  // arrangement it replaces goes into the layout history first, so one Undo
  // takes the whole change back.
  const arrange = useCallback(
    (label: string, positions: DragOverrides, routes: RouteOverrides): number | null => {
      const graph = baseGraphRef.current;
      if (graph === null) return null;
      const step = useLayoutHistoryStore
        .getState()
        .record(label, arrangementOf(nodesRef.current, graph.edges));
      useCaseStore.getState().setArrangement({ dragOverrides: positions, routeOverrides: routes });
      persistRequestedRef.current = true;
      setTidyNote(null);
      return step;
    },
    [],
  );

  // Put an arrangement from the layout history back.
  const applyArrangement = useCallback((snapshot: LayoutSnapshot) => {
    useCaseStore.getState().setArrangement({
      dragOverrides: snapshot.positions,
      routeOverrides: snapshot.routes,
      unitExpansion: snapshot.units,
    });
    persistRequestedRef.current = true;
    setTidyNote(null);
  }, []);
  const stepThroughHistory = useCallback(
    (way: 'undo' | 'redo') => {
      const graph = baseGraphRef.current;
      const history = useLayoutHistoryStore.getState();
      const stack = way === 'undo' ? history.past : history.future;
      const newest = stack[stack.length - 1];
      if (graph === null || newest === undefined) {
        toast.info(
          way === 'undo' ? 'Nothing to undo on the diagram.' : 'Nothing to redo on the diagram.',
        );
        return;
      }
      if (locked) {
        toast.info(LOCKED_NOTICE);
        return;
      }
      // What comes back holds the chains only for a change that folded them.
      const current = arrangementOf(
        nodesRef.current,
        graph.edges,
        newest.snapshot.units !== undefined,
      );
      const step = way === 'undo' ? history.undo(current) : history.redo(current);
      if (step === null) return;
      applyArrangement(step.snapshot);
      toast.info(`${way === 'undo' ? 'Undone' : 'Redone'}: ${step.label}`);
    },
    [applyArrangement, locked],
  );
  // The Undo of a toast: takes its own change back while that is still the
  // newest, and says so when something was arranged since.
  const undoStep = useCallback(
    (step: number | null) => {
      const past = useLayoutHistoryStore.getState().past;
      if (step !== null && past[past.length - 1]?.id === step) stepThroughHistory('undo');
      else toast.info(CHANGED_SINCE_NOTICE);
    },
    [stepThroughHistory],
  );

  // ---- Moving a line by hand ------------------------------------------------
  //
  // The line that is picked shows its handles (`SldRouteEditor`), which hand
  // a route here when a move of them ends. The route is the user's from then
  // on (`manual`): a tidy routes the other lines around it, and it follows
  // its ends when they are moved. It is kept like a route a tidy chose, in
  // `routeOverrides`, with the arrangement it replaces in the layout history
  // and a write of the layout beside the case.
  const editedEdge = useMemo(
    () => (routeEditId === null ? null : (edges.find((edge) => edge.id === routeEditId) ?? null)),
    [edges, routeEditId],
  );
  // Nothing is picked while nothing can be moved, while several nodes are
  // picked together (their bar takes the place of this one), or once the
  // line is gone.
  useEffect(() => {
    if (routeEditId === null) return;
    if (locked || tidying || pickedSet !== null || (baseGraph !== null && editedEdge === null)) {
      setRouteEditId(null);
    }
  }, [routeEditId, locked, tidying, pickedSet, baseGraph, editedEdge]);
  const commitRoute = useCallback(
    (edgeId: string, points: Point[], what: string, coalesce: string | null): string | null => {
      const graph = baseGraphRef.current;
      const edge = graph?.edges.find((e) => e.id === edgeId);
      const at = new Map(nodesRef.current.map((n) => [n.id, n.position]));
      const source = edge === undefined ? undefined : at.get(edge.source);
      const target = edge === undefined ? undefined : at.get(edge.target);
      if (!graph || !edge || !source || !target) return 'the line is no longer on the diagram';
      if (locked) return 'the diagram is locked';
      const route: RouteOverride = {
        points: points.map(([x, y]): [number, number] => [x, y]),
        anchors: { source: { ...source }, target: { ...target } },
        manual: true,
      };
      // The whole picture with the route in place: the taps as they are
      // handed out with it, the symbol of a transformer on it, the labels
      // around it. A route that leaves something drawn over something else
      // is not kept.
      const before = graph.edges as ConnectionEdge[];
      const after = before.map((e) =>
        e.id === edgeId
          ? {
              ...e,
              data: {
                ...e.data,
                bendPoints: route.points,
                bendAnchors: route.anchors,
                bendManual: true,
              },
            }
          : e,
      );
      if (!routesDrawClear(nodesRef.current, before, drawnRef.current.options)(after)) {
        return 'with the line there, something on the diagram would be drawn over something else';
      }
      const name = routeNameOf(edge);
      useLayoutHistoryStore
        .getState()
        .record(`${what} ${name}`, arrangementOf(nodesRef.current, graph.edges), coalesce);
      useCaseStore
        .getState()
        .setRouteOverrides({ ...useCaseStore.getState().routeOverrides, [edgeId]: route });
      persistRequestedRef.current = true;
      setTidyNote(null);
      // What that means is said once: after that the bar of the line says
      // which lines are the user's, and a notice for each would be noise.
      if (edge.data?.bendManual !== true && !explainedByHandRef.current) {
        explainedByHandRef.current = true;
        toast.info(`${name.charAt(0).toUpperCase()}${name.slice(1)} is now routed by hand`, {
          description:
            'Tidy diagram leaves it as it is, and it follows its ends when they are moved. Reset route gives it back to the automatic routing. Saved with the layout.',
          duration: 8_000,
        });
      }
      return null;
    },
    [locked],
  );
  // Give routes that were drawn by hand back to the automatic routing: the
  // one of `only`, or all of them. One step for Undo.
  const resetRoutes = useCallback(
    (only: string | null) => {
      const graph = baseGraphRef.current;
      if (graph === null) return;
      if (locked) {
        toast.info(LOCKED_NOTICE);
        return;
      }
      const drawnByHand = graph.edges.filter(
        (edge) => edge.data?.bendManual === true && (only === null || edge.id === only),
      );
      const one = drawnByHand.length === 1 ? drawnByHand[0] : undefined;
      if (drawnByHand.length === 0) {
        toast.info(
          only === null
            ? 'No line is routed by hand.'
            : 'This line is routed automatically already.',
          {
            description:
              'To draw a route by hand, click a line on the diagram and drag its runs and bends.',
          },
        );
        return;
      }
      const step = useLayoutHistoryStore
        .getState()
        .record(
          one !== undefined
            ? `reset the route of ${routeNameOf(one)}`
            : `reset ${drawnByHand.length} manual routes`,
          arrangementOf(nodesRef.current, graph.edges),
        );
      // `null`: no route of its own, whatever the saved layout holds for it.
      const next: RouteOverrides = { ...useCaseStore.getState().routeOverrides };
      for (const edge of drawnByHand) next[edge.id] = null;
      useCaseStore.getState().setRouteOverrides(next);
      persistRequestedRef.current = true;
      setTidyNote(null);
      const name = one === undefined ? '' : routeNameOf(one);
      toast.success(
        one !== undefined
          ? `${name.charAt(0).toUpperCase()}${name.slice(1)} is routed automatically again`
          : `${drawnByHand.length} routes are routed automatically again`,
        {
          description: `Tidy diagram can now route ${one !== undefined ? 'it' : 'them'} with the rest. Saved with the layout.`,
          action: { label: 'Undo', onClick: () => undoStep(step) },
        },
      );
    },
    [locked, undoStep],
  );
  const makeRouteCheck = useCallback(() => {
    const edge = baseGraphRef.current?.edges.find((e) => e.id === routeEditId);
    if (edge === undefined) return () => 'the line is no longer on the diagram';
    const { options } = drawnRef.current;
    return routeChecker(nodesRef.current, pictureRef.current, edge as ConnectionEdge, {
      sizes: options.sizes,
      values: options.values,
      labelWidths: options.labelWidths,
    });
  }, [routeEditId]);
  // What the editor draws from: the route as it is drawn now, and what its
  // two ends are attached to.
  const editedRoute = useMemo(() => {
    if (editedEdge === null) return null;
    const points = connections.routes.get(editedEdge.id)?.points;
    if (points === undefined) return null;
    const at = new Map(nodes.map((n) => [n.id, n.position]));
    return {
      points,
      ends: routeEndsOf(editedEdge as ConnectionEdge, points, at, connections.bars),
      name: routeNameOf(editedEdge),
      manual: editedEdge.data?.bendManual === true,
    };
  }, [editedEdge, connections, nodes]);
  const commitEditedRoute = useCallback(
    (points: Point[], what: string, coalesce: string | null) =>
      routeEditId === null ? 'no line is picked' : commitRoute(routeEditId, points, what, coalesce),
    [routeEditId, commitRoute],
  );
  const resetEditedRoute = useCallback(() => resetRoutes(routeEditId), [routeEditId, resetRoutes]);
  const resetAllRoutes = useCallback(() => resetRoutes(null), [resetRoutes]);
  const endRouteEdit = useCallback(() => setRouteEditId(null), []);
  // Pick a line from its right-click menu, as a click on it does.
  const editRoute = useCallback(
    (edgeId: string) => {
      if (locked) {
        toast.info(LOCKED_NOTICE);
        return;
      }
      setRouteEditId(edgeId);
    },
    [locked],
  );
  // A line picked away from the diagram (its row in the Lines table, its
  // Inspector): its handles show as after a click on it, and the view goes
  // to it, at a size the handles can be used at, unless the whole line
  // shows at such a size already: a row that was clicked to read a value
  // leaves the view where it is. A locked diagram picks none, and says
  // nothing: the row was picked to look at the line.
  const pickRouteOf = useCallback(
    (branchIdx: string) => {
      if (locked || tidying) return;
      const edge = baseGraphRef.current?.edges.find(
        (held) =>
          held.type !== 'stub' && String((held.data as { idx?: unknown }).idx) === branchIdx,
      );
      if (edge === undefined) return;
      setRouteEditId(edge.id);
      const points = pictureRef.current.connections.routes.get(edge.id)?.points;
      if (points === undefined || points.length < 2) return;
      const zoom = rf.getZoom();
      const pane = canvasRef.current?.querySelector('.react-flow')?.getBoundingClientRect();
      const shown =
        pane !== undefined &&
        !isTooSmallToRead(zoom) &&
        withinPane(
          points.map(([x, y]) => rf.flowToScreenPosition({ x, y })),
          pane,
        );
      if (shown) return;
      const middle = routeMidpoint(points);
      void rf.setCenter(middle.x, middle.y, { zoom: locateZoom(zoom), duration: 250 });
    },
    [locked, tidying, rf],
  );
  // The same line given back to the automatic routing, as Reset route on its bar does.
  const resetRouteOf = useCallback(
    (branchIdx: string) => {
      const edge = baseGraphRef.current?.edges.find(
        (held) =>
          held.type !== 'stub' && String((held.data as { idx?: unknown }).idx) === branchIdx,
      );
      if (edge !== undefined) resetRoutes(edge.id);
    },
    [resetRoutes],
  );
  useEffect(
    () =>
      subscribeRouteEdit((branchIdx, what) =>
        what === 'reset' ? resetRouteOf(branchIdx) : pickRouteOf(branchIdx),
      ),
    [pickRouteOf, resetRouteOf],
  );
  // The line that was picked with the keys takes the focus on its longest
  // run, once its handles are drawn.
  useEffect(() => {
    if (!focusRouteRef.current || routeEditId === null || editedRoute === null) return;
    focusRouteRef.current = false;
    canvasRef.current?.querySelector<SVGElement>(`[${ROUTE_FOCUS_ATTR}]`)?.focus();
  }, [routeEditId, editedRoute]);

  // Tidy diagram: route every line and transformer afresh (`tidy.ts`). With
  // `relayout` the buses are first lined up on the grid and every generator,
  // load and shunt is put back beside its bus, where the diagram places one
  // that was never moved. `applyTidy` puts a plan in place (`planTidy`).
  const applyTidy = useCallback(
    (plan: TidyPlan, relayout: boolean) => {
      const { nodes: placedNodes, edges: placedEdges, tidied, refused } = plan;
      // The routes that were drawn by hand: the ones that stay as they are,
      // the connectors that go along with their devices, and the ones a
      // re-layout left no room for.
      const byHand = plan.byHand ?? new Map<string, Point[]>();
      const connectorsByHand = plan.connectorsByHand ?? new Map<string, Point[]>();
      const released = plan.released ?? [];
      const graph = baseGraphRef.current;
      if (graph === null) return;
      // How many routes drawn by hand the plan leaves the user's: the lines
      // and transformers, and the connectors of devices with them.
      const keptByHand =
        byHand.size +
        graph.edges.filter(
          (edge) =>
            edge.type === 'stub' && edge.data?.bendManual === true && !released.includes(edge.id),
        ).length;
      /** The lines `ids` by name, the first few of them: `line Line_4 and the connector of PQ_3`. */
      const named = (ids: readonly string[]): string => {
        const names = ids
          .map((id) => graph.edges.find((edge) => edge.id === id))
          .filter((edge): edge is Edge => edge !== undefined)
          .map(routeNameOf);
        const shown = names.slice(0, 3);
        const more = names.length - shown.length;
        if (more > 0) return `${shown.join(', ')} and ${more} more`;
        return shown.length <= 1
          ? (shown[0] ?? '')
          : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
      };
      const branches = placedEdges.filter((e) => e.type !== 'stub');
      if (branches.length === 0 && !relayout) {
        toast.info('Nothing to tidy: the diagram has no lines or transformers.');
        return;
      }
      if (tidied.tooLarge) {
        toast.info('This diagram is too large to tidy', {
          description:
            'It spreads over more room than Tidy diagram routes lines across. Nothing was changed.',
        });
        return;
      }
      if (refused !== undefined) {
        // The plan would have drawn something over something else that the
        // diagram keeps clear of as it stands (`planTidy`): it says which
        // lines, and what the user can do about the ones that are theirs.
        const blamed = named(plan.blamed ?? []);
        const what = blamed === '' ? 'something on the diagram' : blamed;
        const reset =
          keptByHand === 0
            ? ''
            : ` ${keptByHand} ${keptByHand === 1 ? 'line is' : 'lines are'} routed by hand and left as ${keptByHand === 1 ? 'it is' : 'they are'}: Reset manual routes, in the Arrange menu, lets the tidy route ${keptByHand === 1 ? 'it' : 'them'} as well.`;
        setTidyNote('Not tidied: nothing was changed');
        toast.info('Nothing was changed', {
          description: relayout
            ? `Laid out again, ${what} would have been drawn over something else, so the diagram keeps the arrangement it has.${reset}`
            : `With the lines routed afresh, ${what} would have been drawn over something else: mostly the connector of a device that stands away from its bus, which would have run through a symbol. The diagram keeps the routes it has. Tidy and re-layout puts every device back beside its bus.${reset}`,
          duration: 10_000,
        });
        return;
      }
      const { routes, unrouted } = tidied;
      const before = arrangementOf(nodesRef.current, graph.edges);
      // The routes as routes chosen for the buses where they now stand. A
      // branch that got none keeps the one it had, while its buses stand
      // where they stood. After a re-layout it has none: the picture routes
      // it on its own if it finds a way, and draws it from bar to bar if not.
      const at = new Map(placedNodes.map((n) => [n.id, n.position]));
      const chosen: RouteOverrides = {};
      for (const edge of branches) {
        const kept = byHand.get(edge.id);
        const points = kept ?? routes.get(edge.id);
        const source = at.get(edge.source);
        const target = at.get(edge.target);
        chosen[edge.id] =
          points === undefined || source === undefined || target === undefined
            ? ((relayout ? null : before.routes[edge.id]) ?? null)
            : {
                points: points.map(([x, y]): [number, number] => [x, y]),
                anchors: { source: { ...source }, target: { ...target } },
                ...(kept !== undefined ? { manual: true as const } : {}),
              };
      }
      // The connector of a device that was drawn by hand stays with its
      // device: as it is drawn where a re-layout has put the two, and as it
      // was where nothing has moved. One the plan gave up has no route of
      // its own any more.
      for (const edge of placedEdges) {
        if (edge.type !== 'stub') continue;
        const kept = connectorsByHand.get(edge.id);
        const source = at.get(edge.source);
        const target = at.get(edge.target);
        chosen[edge.id] = released.includes(edge.id)
          ? null
          : kept !== undefined && source !== undefined && target !== undefined
            ? {
                points: kept.map(([x, y]): [number, number] => [x, y]),
                anchors: { source: { ...source }, target: { ...target } },
                manual: true,
              }
            : (before.routes[edge.id] ?? null);
      }
      const positions = positionsOf(placedNodes);
      if (sameArrangement(before, { positions, routes: chosen })) {
        const handNote =
          keptByHand === 0
            ? ''
            : ` ${keptByHand} routed by hand ${keptByHand === 1 ? 'is' : 'are'} left as ${keptByHand === 1 ? 'it is' : 'they are'}: Reset manual routes, in the Arrange menu, gives ${keptByHand === 1 ? 'it' : 'them'} back to the tidy.`;
        setTidyNote('Already tidy: nothing was changed');
        toast.info('The diagram is already tidy.', {
          description: relayout
            ? `Every bus is on the grid, every device beside its bus, and no line would be routed differently. Nothing was changed.${handNote}`
            : `No line or transformer would be routed differently. Nothing was changed.${handNote}`,
          duration: 8_000,
        });
        return;
      }
      const step = arrange(relayout ? 'tidy and re-layout' : 'tidy diagram', positions, chosen);
      const rerouted = branches.length - byHand.size - unrouted.length;
      const lines = `${rerouted} ${rerouted === 1 ? 'line or transformer' : 'lines and transformers'} re-routed`;
      // What became of the routes that were drawn by hand.
      const hand =
        (keptByHand === 0
          ? ''
          : ` ${keptByHand} routed by hand ${keptByHand === 1 ? 'was left as it is' : 'were left as they are'}: Reset manual routes, in the Arrange menu, gives ${keptByHand === 1 ? 'it' : 'them'} back to the tidy.`) +
        (released.length === 0
          ? ''
          : ` The ${released.length === 1 ? 'route' : 'routes'} you drew for ${named(released)} no longer fitted where ${released.length === 1 ? 'its ends' : 'their ends'} now stand, and ${released.length === 1 ? 'is' : 'are'} routed automatically again.`);
      const one = unrouted.length === 1;
      const why = tidied.outOfSteps
        ? `${unrouted.length} could not be routed in the time a tidy takes`
        : `No way was found for ${unrouted.length}`;
      const then = relayout
        ? `${one ? 'it is' : 'they are'} drawn the most direct way, which may cross a symbol or a bar`
        : one
          ? 'it keeps the route it had'
          : 'they keep the routes they had';
      const left = unrouted.length === 0 ? '' : ` ${why}: ${then}.`;
      setTidyNote(
        keptByHand === 0 ? `Tidied: ${lines}` : `Tidied: ${lines}, ${keptByHand} by hand kept`,
      );
      toast.success(relayout ? 'Diagram tidied and laid out again' : 'Diagram tidied', {
        description: relayout
          ? `Buses lined up on the grid, devices put back beside their buses, ${lines}.${hand}${left} Saved with the layout.`
          : `${lines}. Nothing was moved.${hand}${left} Saved with the layout.`,
        duration: 8_000,
        action: { label: 'Undo', onClick: () => undoStep(step) },
      });
    },
    [arrange, undoStep],
  );
  // A diagram of a few dozen branches is tidied within the press that asked
  // for it. A large one takes up to about a second, and is worked out off
  // the main thread (`tidyClient.ts`): the button says what is going on, the
  // diagram keeps answering, and the work can be called off. Nothing can be
  // dragged meanwhile, so the plan fits the diagram it is put on.
  const tidyJobRef = useRef<TidyJob | null>(null);
  useEffect(
    () => () => {
      tidyJobRef.current?.cancel();
      tidyJobRef.current = null;
    },
    [],
  );
  const tidy = useCallback(
    (relayout: boolean) => {
      const graph = baseGraphRef.current;
      if (graph === null || tidyJobRef.current !== null) return;
      if (locked) {
        toast.info(LOCKED_NOTICE);
        return;
      }
      const job = startTidy({ nodes: nodesRef.current, edges: graph.edges }, topology, {
        relayout,
        sizes,
        connectorStyle,
        barLengths,
        controllerCoords,
        unitStates,
        drawn: drawnNodesRef.current,
        shown: { values: valuesShown, labelWidths },
      });
      if (job.plan !== undefined) {
        applyTidy(job.plan, relayout);
        return;
      }
      tidyJobRef.current = job;
      setTidying(true);
      const finished = (): boolean => {
        if (tidyJobRef.current !== job) return false;
        tidyJobRef.current = null;
        setTidying(false);
        return true;
      };
      job.done.then(
        (plan) => {
          if (finished()) applyTidy(plan, relayout);
        },
        (err: unknown) => {
          if (!finished()) return;
          toast.error('The diagram could not be tidied', {
            description: `${err instanceof Error ? err.message : String(err)}. Nothing was changed.`,
          });
        },
      );
    },
    [
      topology,
      barLengths,
      controllerCoords,
      unitStates,
      sizes,
      connectorStyle,
      locked,
      applyTidy,
      valuesShown,
      labelWidths,
    ],
  );
  const cancelTidy = useCallback(() => {
    const job = tidyJobRef.current;
    if (job === null) return;
    job.cancel();
    tidyJobRef.current = null;
    setTidying(false);
    toast.info('Tidy stopped. Nothing was changed.');
  }, []);

  // Align or distribute the nodes that are picked together. They are lined
  // up by their boxes (`arrangeBoxOf`: a bus by its bar), and one step of Undo
  // takes it back.
  const arrangePicked = useCallback(
    (command: `align-${AlignMode}` | `distribute-${DistributeAxis}`) => {
      const graph = baseGraphRef.current;
      if (graph === null) return;
      if (locked) {
        toast.info(LOCKED_NOTICE);
        return;
      }
      const picked = nodesRef.current.filter(
        (n) => pickedSet?.has(n.id) === true && n.draggable !== false,
      );
      const [verb, how] = command.split('-') as ['align' | 'distribute', string];
      const needed = verb === 'align' ? 2 : 3;
      if (picked.length < needed) {
        toast.info(
          verb === 'align'
            ? 'Pick two or more buses or devices to align.'
            : 'Pick three or more buses or devices to distribute.',
          {
            description:
              'Hold Shift and drag a box around them, or hold Ctrl (Cmd on a Mac) and click each.',
          },
        );
        return;
      }
      const boxes = picked.map((n) => arrangeBoxOf(n, sizes));
      const snap = useLayoutStore.getState().sldSnapToGrid ? GRID_STEP : null;
      const label =
        verb === 'align' ? ALIGN_LABEL[how as AlignMode] : DISTRIBUTE_LABEL[how as DistributeAxis];
      const moves =
        verb === 'align'
          ? alignBoxes(boxes, how as AlignMode, snap)
          : distributeBoxes(boxes, how as DistributeAxis, snap);
      const count = Object.keys(moves).length;
      if (count === 0) {
        toast.info(`${label}: nothing to move.`, {
          description: `The ${picked.length} picked elements are already arranged that way.`,
        });
        return;
      }
      // A bus that moves takes its devices along, as in a drag. Every other
      // node keeps its place, and a branch whose bus moved is routed from
      // where it stands now.
      const carried = new Map(Object.entries(moves));
      carryDevices(nodesRef.current, carried);
      const positions = { ...positionsOf(nodesRef.current), ...Object.fromEntries(carried) };
      const step = arrange(
        `${label.toLowerCase()} (${picked.length} elements)`,
        positions,
        useCaseStore.getState().routeOverrides,
      );
      toast.success(`${label}: ${count} of ${picked.length} moved`, {
        description: 'Saved with the layout.',
        action: { label: 'Undo', onClick: () => undoStep(step) },
      });
    },
    [pickedSet, sizes, locked, arrange, undoStep],
  );

  const snapToGrid = useLayoutStore((s) => s.sldSnapToGrid);
  const changeSnap = useCallback((snap: boolean) => {
    useLayoutStore.getState().setSldSnapToGrid(snap);
    toast.info(snap ? 'Snap to grid is on' : 'Snap to grid is off', {
      description: snap
        ? `What you drag, or move with the arrow keys, lands on the ${GRID_STEP} px grid of the background dots. Nothing moves until you move it; Tidy and re-layout lines everything up at once.`
        : 'A bus or device stays exactly where you drop it.',
    });
  }, []);

  // Draw the device connectors straight, or with a right angle. The choice is
  // a setting of the diagram and is kept like a drag: in the store for this
  // visit, in the layout every save sends, and in the file beside the case.
  const setConnectorStyle = useCaseStore((s) => s.setConnectorStyle);
  const chooseConnectorStyle = useCallback(
    (style: ConnectorStyle) => {
      if (style === connectorStyle) return;
      setConnectorStyle(style);
      persistRequestedRef.current = true;
      toast.info(
        style === 'elbow'
          ? 'Device connectors turn at a right angle'
          : 'Device connectors are drawn straight',
        {
          description:
            style === 'elbow'
              ? 'A connector turns once where its device does not sit square to the bar. Saved with the layout.'
              : 'A connector runs in one line from the device to the bar. Saved with the layout.',
        },
      );
    },
    [connectorStyle, setConnectorStyle],
  );

  const runCommand = useCallback(
    (command: SldCommand) => {
      switch (command) {
        case 'fit-view':
          fitView();
          break;
        case 'reset-layout':
          resetLayout();
          break;
        case 'connectors-straight':
          chooseConnectorStyle('straight');
          break;
        case 'connectors-elbow':
          chooseConnectorStyle('elbow');
          break;
        case 'tidy':
          tidy(false);
          break;
        case 'tidy-relayout':
          tidy(true);
          break;
        case 'undo-layout':
          stepThroughHistory('undo');
          break;
        case 'redo-layout':
          stepThroughHistory('redo');
          break;
        case 'reset-manual-routes':
          resetRoutes(null);
          break;
        default:
          arrangePicked(command);
      }
    },
    [
      fitView,
      resetLayout,
      chooseConnectorStyle,
      tidy,
      stepThroughHistory,
      resetRoutes,
      arrangePicked,
    ],
  );
  useEffect(() => subscribeSldCommand(runCommand), [runCommand]);
  const runArrangeCommand = useCallback(
    (command: ArrangeCommand) => runCommand(command),
    [runCommand],
  );

  // Draw the control chain of a generating unit out, or fold it away: asked
  // for by the control on the unit's symbol and by its right-click menu.
  // Kept like a drag and the connector style: in the store for this visit,
  // in the layout every save sends, and in the file beside the case.
  const setUnitExpanded = useCallback((unitIdx: string, expanded: boolean) => {
    const held = useCaseStore.getState().unitExpansion;
    useCaseStore.getState().setUnitExpansion({ ...held, [unitIdx]: expanded });
    persistRequestedRef.current = true;
  }, []);
  useEffect(() => subscribeUnitExpanded(setUnitExpanded), [setUnitExpanded]);

  // ---- Right-click menu ----------------------------------------------------
  //
  // What the menu offers depends on what was clicked (``SldContextMenu``). Every
  // right-click starts as the canvas's, in the capture phase; React Flow's node
  // and edge handlers run later in the same event and replace it when the click
  // was on one. Radix opens the menu from the trigger's own handler, after both.
  //
  // Touch and pen open the menu from a long press instead, which iOS reports with
  // no ``contextmenu`` event, so a press on the diagram sets the target from what
  // was pressed. Not while the menu is open: a press that dismisses it would
  // change its items as it fades out.
  const [contextTarget, setContextTarget] = useState<SldContextTarget>({ kind: 'canvas' });
  const contextMenuOpenRef = useRef(false);
  const editedEdgeRef = useRef<Edge | null>(null);
  useEffect(() => {
    editedEdgeRef.current = editedEdge;
  }, [editedEdge]);
  const onContextMenuOpenChange = useCallback((open: boolean) => {
    contextMenuOpenRef.current = open;
  }, []);
  const onSurfaceContextMenuCapture = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // React events bubble through portals, so a right-click in the node search's
    // popover arrives here though it is not on the diagram. Stopped in the capture
    // phase, it never reaches the trigger, which would open this menu in place of
    // the browser's own (Copy, Paste) over the search field.
    if (e.target instanceof Node && !e.currentTarget.contains(e.target)) {
      e.stopPropagation();
      return;
    }
    // The handles of the line that is picked lie over it: a right-click on
    // one is on that line.
    const picked =
      e.target instanceof Element && e.target.closest('[data-testid="sld-route-editor"]') !== null
        ? editedEdgeRef.current
        : null;
    setContextTarget(picked === null ? { kind: 'canvas' } : contextTargetFromEdge(picked));
  }, []);
  const onSurfacePointerDownCapture = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === 'mouse' || contextMenuOpenRef.current) return;
      if (!(e.target instanceof Element) || !e.currentTarget.contains(e.target)) return;
      const next = contextTargetAt(e.target, nodesWithSelection, routedEdges);
      setContextTarget((held) => (sameContextTarget(held, next) ? held : next));
    },
    [nodesWithSelection, routedEdges],
  );
  const onNodeContextMenu: NodeMouseHandler = useCallback(
    (_e, node) => {
      // A right-click on one of several picked nodes is on the selection.
      setContextTarget(
        pickedSet?.has(node.id) === true
          ? { kind: 'selection', count: pickedSet.size }
          : contextTargetFromNode(node),
      );
    },
    [pickedSet],
  );
  // After a box is drawn with Shift held, React Flow lays a frame over the
  // picked nodes, and a right-click on it is on the selection as well.
  const onSelectionContextMenu = useCallback((_e: React.MouseEvent, picked: Node[]) => {
    const count = picked.filter((n) => n.draggable !== false).length;
    if (count >= 2) setContextTarget({ kind: 'selection', count });
  }, []);
  const onEdgeContextMenu: EdgeMouseHandler = useCallback((_e, edge) => {
    setContextTarget(contextTargetFromEdge(edge));
  }, []);

  // PNG export rasterises the entire canvas container (the ReactFlow
  // root + its embedded SVG). The SLD is rendered as a mix of HTML
  // overlays (banners, MiniMap controls) and SVG (edges) so we use
  // the html-to-image path rather than a pure SVG → canvas pipeline.
  // ExportMenu calls this through onExportPng on the menu trigger.
  const onExportPng = useCallback(async () => {
    const el = canvasRef.current;
    if (!el) return null;
    return await elementToPng(el, { backgroundColor: '#ffffff' });
  }, []);

  // Blank sessions fall back to "case" so the file still has a sensible name.
  const caseName = useExportCaseName();

  if (coords === null) {
    return <SldLayoutSkeleton />;
  }

  return (
    <div className="flex h-full w-full flex-col" data-testid="sld-canvas">
      <div className="flex items-center gap-2 px-2 py-1">
        <SldCanvasHint
          locked={locked}
          selectedName={selectedName}
          onZoomIn={zoomToFullSize}
          routeBarSlot={routeEditId !== null && editedRoute !== null ? setRouteBarSlot : null}
        />
        <SldArrangeControls
          locked={locked}
          busy={tidying}
          onCancel={cancelTidy}
          note={tidyNote}
          untidy={draggedIds.length > 0 ? 0 : untidyCount}
          pickedCount={pickedCount}
          manualRoutes={manualRoutes}
          snap={snapToGrid}
          onSnapChange={changeSnap}
          onCommand={runArrangeCommand}
        />
        <ConnectivityRecomputeButton />
        <ExportMenu formats={['png']} panel="sld" caseName={caseName} onExportPng={onExportPng} />
      </div>
      {showLargeBanner ? (
        <CanvasBanner
          testId="sld-large-banner"
          message="Auto-layout on cases this size is best-effort. Drag elements to clean up; your layout is saved per-case."
          onDismiss={() => setShowLargeBanner(false)}
        />
      ) : null}
      {showDriftBanner ? (
        <CanvasBanner
          testId="sld-drift-banner"
          message="Topology changed since this layout was saved. Some elements were re-arranged automatically."
          onDismiss={() => setShowDriftBanner(false)}
        />
      ) : null}
      {/* ``modal={false}``: Fault here and Trip line open a dialog from a menu
          item, and a modal menu would leave the page unclickable after it. */}
      <ContextMenu modal={false} onOpenChange={onContextMenuOpenChange}>
        <ContextMenuTrigger asChild>
          <div
            ref={canvasRef}
            className="relative min-h-0 flex-1"
            data-testid="sld-canvas-surface"
            onDragOver={onDragOver}
            onDrop={onDrop}
            onDragEnd={onDragEnd}
            onContextMenuCapture={onSurfaceContextMenuCapture}
            onPointerDownCapture={onSurfacePointerDownCapture}
            onKeyDown={onSurfaceKeyDown}
          >
            <ReactFlow
              nodes={nodesWithSelection}
              edges={routedEdges}
              onNodesChange={onNodesChange}
              onNodeDragStart={onNodeDragStart}
              onNodeDragStop={onNodeDragStop}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              onNodeClick={onNodeClick}
              onEdgeClick={onEdgeClick}
              onPaneClick={onPaneClick}
              onNodeContextMenu={onNodeContextMenu}
              onEdgeContextMenu={onEdgeContextMenu}
              onSelectionContextMenu={onSelectionContextMenu}
              fitView
              minZoom={MIN_ZOOM}
              ariaLabelConfig={locked ? ARIA_LABELS_LOCKED : ARIA_LABELS_UNLOCKED}
              // The padlock of the controls sets this in React Flow's own
              // state; a tidy that ends must not unlock a diagram that was
              // locked meanwhile.
              nodesDraggable={!tidying && !locked}
              nodeDragThreshold={0}
              snapToGrid={snapToGrid}
              snapGrid={SNAP_GRID}
              selectionMode={SelectionMode.Partial}
              proOptions={{ hideAttribution: true }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={GRID_STEP}
                size={1}
                color={DOT_GRID_COLOR}
                data-testid="sld-canvas-dot-grid"
              />
              <Controls
                className={FLOATING_OVERLAY_CHROME}
                onInteractiveChange={onInteractiveChange}
              />
              <MiniMap
                pannable
                zoomable
                nodeColor={miniMapNodeColor}
                style={MINIMAP_STYLE}
                className={FLOATING_OVERLAY_CHROME}
                maskColor={MINIMAP_MASK_STYLE.fill as string}
                maskStrokeColor={MINIMAP_MASK_STYLE.stroke as string}
                maskStrokeWidth={MINIMAP_MASK_STYLE.strokeWidth as number}
              />
              {/* The handles of the line whose route is moved by hand, and
                  the bar that goes with them. Not while a node is dragged:
                  the line is on its way to where the node is dropped. */}
              {routeEditId !== null && editedRoute !== null && !dragging ? (
                <SldRouteEditor
                  edgeId={routeEditId}
                  name={editedRoute.name}
                  points={editedRoute.points}
                  manual={editedRoute.manual}
                  ends={editedRoute.ends}
                  makeCheck={makeRouteCheck}
                  grid={snapToGrid ? GRID_STEP : null}
                  onCommit={commitEditedRoute}
                  onReset={resetEditedRoute}
                  onDone={endRouteEdit}
                  barSlot={routeBarSlot}
                />
              ) : null}
            </ReactFlow>
            {/* Keys to the bus colours and limit markers, and to the line
            loading and generator limit markers. Inside the surface so the PNG
            export carries them; each draws nothing until a power flow or a
            run has put what it explains on the diagram. */}
            <div className="pointer-events-none absolute top-2 left-2 z-10 flex w-[200px] flex-col gap-1.5">
              <SldVoltageLegend />
              <SldLimitsLegend />
            </div>
            {/* Align and Distribute, while several nodes are picked together. */}
            <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
              <SldSelectionBar count={pickedCount} locked={locked} onCommand={runArrangeCommand} />
            </div>
            {/* Floating search affordance — sits inside the canvas surface
            so it overlays the React Flow chrome rather than displacing
            it. Bottom-right matches the React Flow Controls position
            convention; the popover anchors above the trigger so it
            doesn't hide the rest of the canvas. */}
            <div
              className="pointer-events-none absolute right-2 bottom-2 z-10 flex gap-2"
              data-testid="sld-canvas-affordances"
            >
              <div className="pointer-events-auto">
                <SldNodeSearch />
              </div>
            </div>
          </div>
        </ContextMenuTrigger>
        <SldContextMenuBody
          target={contextTarget}
          locked={locked}
          onFitView={fitView}
          onResetLayout={resetLayout}
          connectorStyle={connectorStyle}
          onConnectorStyle={chooseConnectorStyle}
          onArrange={runArrangeCommand}
          snap={snapToGrid}
          onSnapChange={changeSnap}
          onEditRoute={editRoute}
          onResetRoute={resetRoutes}
          manualRoutes={manualRoutes}
          onResetManualRoutes={resetAllRoutes}
        />
      </ContextMenu>
    </div>
  );
}

/**
 * Unit 17 — connectivity / island-detection recompute button.
 *
 * Per the v2.0 plan's Unit 17 auto-fix this is the **manual trigger**
 * for the connectivity overlay (no per-streaming-frame recomputation).
 * The button calls ``query.refetch()`` on the ``useConnectivity`` hook;
 * the hook's ``queryFn`` writes through to the connectivity Zustand
 * slice, which drives the bus-greying logic in ``nodesWithSelection``.
 *
 * Disabled when no session exists (the user has not loaded a case
 * yet); the route would 409 otherwise. The "running" / "error" inline
 * states are surfaced via ``data-status`` so styling and tests can
 * branch deterministically without waiting on toast plumbing.
 */
function ConnectivityRecomputeButton() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const connectivityQuery = useConnectivity();
  const islandCount = useConnectivityStore((s) => s.result?.island_count ?? null);
  const onClick = useCallback(() => {
    if (sessionId === null) return;
    void connectivityQuery.refetch();
  }, [sessionId, connectivityQuery]);
  const isFetching = connectivityQuery.isFetching;
  const isError = connectivityQuery.isError;
  const status: 'idle' | 'fetching' | 'error' | 'success' = isFetching
    ? 'fetching'
    : isError
      ? 'error'
      : islandCount !== null
        ? 'success'
        : 'idle';
  return (
    <button
      type="button"
      data-testid="sld-recompute-connectivity"
      data-status={status}
      data-island-count={islandCount ?? undefined}
      onClick={onClick}
      disabled={sessionId === null || isFetching}
      className={cn(
        'rounded border px-2 py-0.5 text-xs',
        'border-border bg-background text-foreground',
        'hover:bg-muted/40',
        'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
      )}
    >
      {isFetching
        ? 'Computing connectivity…'
        : islandCount !== null
          ? `Recompute connectivity (${islandCount} island${islandCount === 1 ? '' : 's'})`
          : 'Recompute connectivity'}
    </button>
  );
}

const NO_SIZES: ReadonlyMap<string, NodeSize> = new Map();
const NO_IDS: readonly string[] = [];

/**
 * Whether `node` is the one that is selected: the element the inspector shows
 * (`element`, which names a bus by its node id), or the node the diagram's own
 * selection holds (`nodeId`: a click, the search, a table row).
 */
function isSelectedNode(
  node: Node,
  element: SelectedElement | null,
  nodeId: string | null,
): boolean {
  return (
    (element !== null && element.idx === node.id && element.kind === (node.type ?? 'bus')) ||
    nodeId === node.id
  );
}

/**
 * The middle of `node`'s box, which is what the view is centred on: its
 * measured size when React Flow has reported one, its size hint until then.
 */
function centreOf(node: Node, size: NodeSize | undefined): { x: number; y: number } {
  const width = size?.width ?? node.initialWidth ?? 0;
  const height = size?.height ?? node.initialHeight ?? 0;
  return { x: node.position.x + width / 2, y: node.position.y + height / 2 };
}

/** An edge as the canvas last handed it to React Flow, and what it was made from. */
interface RoutedEdgeEntry {
  base: Edge;
  signature: string;
  edge: Edge;
}

/**
 * `edge` with its route, and attached to the handles on the sides the route
 * leaves and lands by: the port of the device's face, the face or end of the
 * bar. The components draw from the route; the handles keep what React Flow
 * itself knows of the edge true to the picture. `active` marks the connector
 * of a device that is selected or being dragged, which is drawn picked out,
 * and `labelAt` is where a branch carries its label.
 */
function withRoute(
  edge: Edge,
  route: ConnectorRoute,
  active: boolean,
  labelAt: LabelPlace | undefined,
): Edge {
  return {
    ...edge,
    sourceHandle:
      edge.type === 'stub' ? DEVICE_PORT[route.sourceSide] : SOURCE_HANDLE[route.sourceSide],
    targetHandle: TARGET_HANDLE[route.targetSide],
    data: {
      ...(edge.data as Record<string, unknown> | undefined),
      route,
      ...(active ? { active: true } : {}),
      ...(labelAt !== undefined ? { labelAt } : {}),
    },
  };
}

/**
 * `held` with the sizes React Flow reports in `changes`; `held` itself when
 * none of them is new, so a measurement that changes nothing redraws nothing.
 */
function withMeasuredSizes(
  held: ReadonlyMap<string, NodeSize>,
  changes: NodeChange[],
): ReadonlyMap<string, NodeSize> {
  let next: Map<string, NodeSize> | null = null;
  for (const c of changes) {
    if (c.type !== 'dimensions') continue;
    const measured = (c as NodeDimensionChange).dimensions;
    if (!measured || !(measured.width > 0) || !(measured.height > 0)) continue;
    const known = (next ?? held).get(c.id);
    if (known && known.width === measured.width && known.height === measured.height) continue;
    next ??= new Map(held);
    next.set(c.id, { width: measured.width, height: measured.height });
  }
  return next ?? held;
}

/** Where every node that can be moved stands, by node id: the form the drags are kept in. */
function positionsOf(nodes: readonly Node[]): DragOverrides {
  const positions: DragOverrides = {};
  for (const n of nodes) {
    if (n.draggable === false) continue;
    positions[n.id] = { x: n.position.x, y: n.position.y };
  }
  return positions;
}

/**
 * The arrangement of the diagram as drawn, for the layout history: where
 * `nodes` stand, and how each branch and connector among `edges` is routed
 * (the points and anchors `buildGraph` gave the edge, marked `manual` for a
 * route drawn by hand, or `null` for one routed from where its ends stand).
 * With `withUnits`, also which control chains are drawn out.
 */
function arrangementOf(
  nodes: readonly Node[],
  edges: readonly Edge[],
  withUnits = false,
): LayoutSnapshot {
  const routes: RouteOverrides = {};
  for (const edge of edges) {
    const data = edge.data as
      | {
          bendPoints?: [number, number][];
          bendAnchors?: NonNullable<RouteOverrides[string]>['anchors'];
          bendManual?: boolean;
        }
      | undefined;
    // A connector has a route to keep only where one was drawn for it by
    // hand; `null` for the others puts them back to being worked out.
    routes[edge.id] =
      data?.bendPoints !== undefined && data.bendAnchors !== undefined
        ? {
            points: data.bendPoints,
            anchors: data.bendAnchors,
            ...(data.bendManual === true ? { manual: true as const } : {}),
          }
        : null;
  }
  const snapshot: LayoutSnapshot = { positions: positionsOf(nodes), routes };
  if (!withUnits) return snapshot;
  const units: Record<string, boolean> = {};
  for (const n of nodes) {
    const data = n.data as { idx?: string; unit?: UnitNodeData };
    if (n.type === 'generator' && data.unit !== undefined && typeof data.idx === 'string') {
      units[data.idx] = data.unit.expanded;
    }
  }
  return { ...snapshot, units };
}

/** Whether two arrangements draw the same diagram: every node in one place, every branch on one route. */
function sameArrangement(
  a: Pick<LayoutSnapshot, 'positions' | 'routes'>,
  b: Pick<LayoutSnapshot, 'positions' | 'routes'>,
): boolean {
  const ids = new Set([...Object.keys(a.positions), ...Object.keys(b.positions)]);
  for (const id of ids) {
    const [p, q] = [a.positions[id], b.positions[id]];
    if (p === undefined || q === undefined || p.x !== q.x || p.y !== q.y) return false;
  }
  const edges = new Set([...Object.keys(a.routes), ...Object.keys(b.routes)]);
  for (const id of edges) {
    if (
      JSON.stringify(a.routes[id]?.points ?? null) !== JSON.stringify(b.routes[id]?.points ?? null)
    ) {
      return false;
    }
    if ((a.routes[id]?.manual === true) !== (b.routes[id]?.manual === true)) return false;
  }
  return true;
}

/**
 * What the line of `edge` is called in a notice and in the Edit menu:
 * `line Line_3`, `transformer T1`, `the connector of PQ_2`.
 */
function routeNameOf(edge: Pick<Edge, 'id' | 'type' | 'data'>): string {
  const data = edge.data as { name?: string; idx?: string } | undefined;
  const name = data?.name || data?.idx || edge.id;
  if (edge.type === 'stub') return `the connector of ${name}`;
  return `${edge.type === 'transformer' ? 'transformer' : 'line'} ${name}`;
}

/** The nodes of `after` that stand somewhere else than in `before`. */
function movedNodes(before: readonly Node[], after: readonly Node[]): Node[] {
  const was = new Map(before.map((n) => [n.id, n.position]));
  return after.filter((n) => {
    const from = was.get(n.id);
    return from !== undefined && (from.x !== n.position.x || from.y !== n.position.y);
  });
}

/**
 * What a move of `moved` is called in the Edit menu: `move bus BUS3`,
 * `move 4 elements`. The devices a bus took along are part of its move.
 */
function moveLabel(moved: readonly Node[]): string {
  const ids = new Set(moved.map((n) => n.id));
  const own = moved.filter((n) => {
    const parent = (n.data as { parentBus?: unknown }).parentBus;
    return typeof parent !== 'string' || !ids.has(parent);
  });
  const only = own[0];
  if (own.length !== 1 || only === undefined) return `move ${own.length} elements`;
  const data = only.data as { name?: string; idx?: string };
  const noun = (only.type ?? 'bus') === 'bus' ? 'bus' : (only.type ?? 'element');
  return `move ${noun} ${data.name || data.idx || only.id}`;
}

/**
 * The box of `node` that Align and Distribute line up: the bar of a bus (not
 * the label under it), the box a device is drawn in.
 */
function arrangeBoxOf(node: Node, sizes: ReadonlyMap<string, NodeSize>): ArrangeBox {
  const { x, y } = node.position;
  if ((node.type ?? 'bus') === 'bus') {
    return { id: node.id, x, y, left: 0, top: 0, width: BAR_LENGTH, height: BAR_THICKNESS };
  }
  const size = sizes.get(node.id);
  return {
    id: node.id,
    x,
    y,
    left: 0,
    top: 0,
    width: size?.width ?? node.initialWidth ?? 0,
    height: size?.height ?? node.initialHeight ?? 0,
  };
}

/**
 * Apply React Flow position changes to a node array. A bus that moves takes
 * its generators, loads and shunts along (`carryDevices`).
 */
function applyPositionChanges(nodes: Node[], changes: NodeChange[]): Node[] {
  const positionById = new Map<string, { x: number; y: number }>();
  for (const c of changes) {
    if (c.type === 'position' && c.position) {
      positionById.set(c.id, c.position);
    }
  }
  carryDevices(nodes, positionById);
  return withPositions(nodes, positionById);
}

/**
 * Add to `moves` the devices of each bus that `moves` moves, shifted as far
 * as their bus: a generator, load or shunt hangs off its bus, and a bus that
 * is dragged, nudged or lined up leaves them where they hang. A device that
 * `moves` moves itself (it is picked along with its bus) goes where that
 * says.
 */
function carryDevices(nodes: readonly Node[], moves: Map<string, { x: number; y: number }>): void {
  const shift = new Map<string, { dx: number; dy: number }>();
  for (const n of nodes) {
    const to = n.type === 'bus' ? moves.get(n.id) : undefined;
    if (to === undefined) continue;
    const [dx, dy] = [to.x - n.position.x, to.y - n.position.y];
    if (dx !== 0 || dy !== 0) shift.set(n.id, { dx, dy });
  }
  if (shift.size === 0) return;
  for (const n of nodes) {
    const parent = (n.data as { parentBus?: unknown }).parentBus;
    if (n.type === 'bus' || typeof parent !== 'string' || moves.has(n.id)) continue;
    const by = shift.get(parent);
    if (by !== undefined && n.draggable !== false) {
      moves.set(n.id, { x: n.position.x + by.dx, y: n.position.y + by.dy });
    }
  }
}

/** `nodes` with each node that `positionById` names put at its position there. */
function withPositions(nodes: Node[], positionById: Map<string, { x: number; y: number }>): Node[] {
  if (positionById.size === 0) return nodes;
  return nodes.map((n) => {
    const p = positionById.get(n.id);
    return p ? { ...n, position: p } : n;
  });
}

/** How far the node that moved the most is from where `origin` has it, in flow units. */
function farthestMove(origin: Map<string, { x: number; y: number }>, nodes: Node[]): number {
  let farthest = 0;
  for (const n of nodes) {
    const from = origin.get(n.id);
    if (from === undefined) continue;
    farthest = Math.max(farthest, Math.hypot(n.position.x - from.x, n.position.y - from.y));
  }
  return farthest;
}

/**
 * SldCanvas. Top-level entry that consumes the case slice + sidecar
 * hooks and renders either the skeleton (while ELK runs), the canvas
 * (once positions are known), or nothing (if no case is loaded —
 * `AppShell`'s EmptyState fills that role).
 */
export function SldCanvas() {
  const selection = useCaseStore((s) => s.selection);
  // Read topology from the TanStack Query cache (the canonical source of
  // truth — `useLoadCase.onSuccess` seeds it). The Zustand `case.topology`
  // slot is a holdover from an earlier design and stays null in v0.1.
  const topology = useCurrentTopology();
  const primaryPath = selection?.primaryPath ?? null;
  const sidecarQuery = useGetSidecar(primaryPath);
  const putSidecarMutation = usePutSidecar();
  const savedSidecar = sidecarQuery.data ?? null;

  // TanStack Query v5 recreates the mutation result object every render but
  // guarantees `.mutate` is referentially stable; depend on it directly so
  // this callback isn't recreated on each render.
  const putSidecarMutate = putSidecarMutation.mutate;
  const putSidecar = useCallback<PutSidecar>(
    (layout, callbacks) => {
      if (!primaryPath) return;
      // primaryPath is already a branded WorkspacePath.
      putSidecarMutate({ casePath: primaryPath, layout }, callbacks);
    },
    [primaryPath, putSidecarMutate],
  );

  if (selection === null) return null;
  // Topology fetch in flight or sidecar GET in flight → skeleton.
  if (topology === null || sidecarQuery.isLoading) {
    return <SldLayoutSkeleton />;
  }
  // No buses yet (blank session, or a case loaded from a file with no
  // buses — rare but possible on a malformed case) → empty-state CTA.
  if (topology.buses.length === 0) {
    return <SldEmptySystem />;
  }

  return (
    <ReactFlowProvider>
      <SldCanvasInner
        topology={topology}
        primaryPath={selection.primaryPath}
        storedSidecar={hasSavedPositions(savedSidecar) ? savedSidecar : null}
        savedLayout={savedSidecar}
        putSidecar={putSidecar}
      />
    </ReactFlowProvider>
  );
}
