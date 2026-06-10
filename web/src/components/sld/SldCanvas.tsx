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
  NodeChange,
  NodePositionChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useCaseStore } from '@/store/case';
import { subKindForControllerClass } from '@/lib/controllers';
import type { ControllerSubKind } from '@/lib/controllers';
import { useSessionStore } from '@/store/session';
import { useConnectivityStore } from '@/store/connectivity';
import { useSldStore, __requestOpenSldSearch } from '@/store/sld';
import { useHotkeys } from '@/lib/useHotkeys';
import { SldNodeSearch } from './SldNodeSearch';
import { useGetSidecar, usePutSidecar, useCurrentTopology, useConnectivity } from '@/api/queries';
import type { TopologySummary, SidecarLayout } from '@/api/types';
import { ExportMenu } from '@/components/export/ExportMenu';
import { elementToPng } from '@/components/export/exportToPng';

import { COMPONENT_DND_MIME } from '@/components/shell/ComponentLibrary';
import { BusNode } from './nodes/BusNode';
import { LineNode } from './nodes/LineNode';
import { GeneratorNode } from './nodes/GeneratorNode';
import { LoadNode } from './nodes/LoadNode';
import { ShuntNode } from './nodes/ShuntNode';
import { ControllerNode } from './nodes/ControllerNode';
import { TopologyEdge } from './edges/TopologyEdge';
import { RoutedEdge } from './edges/RoutedEdge';
import { TransformerEdge } from './edges/TransformerEdge';
import { StubEdge } from './edges/StubEdge';
import { SldLayoutSkeleton } from './SldLayoutSkeleton';
import { SldEmptySystem } from './SldEmptySystem';
import { autoLayout } from './layout';
import {
  buildSidecarLayout,
  buildNonBusCoordinates,
  cancelPendingSidecarPut,
  debouncedPutSidecar,
  mergeWithDrift,
  nonBusCoordsAsMap,
  type CoordsByIdx,
  type NonBusOverride,
} from './sidecar';
import { curatedLayoutFor } from './curated';
import { buildGraph, computeHandleAssignments } from './graph';
import { cn } from '@/lib/cn';

const NODE_TYPES: NodeTypes = {
  bus: BusNode,
  line: LineNode,
  generator: GeneratorNode,
  load: LoadNode,
  shunt: ShuntNode,
  controller: ControllerNode,
};

const EDGE_TYPES: EdgeTypes = {
  topology: TopologyEdge,
  routed: RoutedEdge,
  transformer: TransformerEdge,
  stub: StubEdge,
};

/** Buses-count threshold for the >30 banner (per the plan). */
const LARGE_TOPOLOGY_THRESHOLD = 30;

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
  storedSidecar: SidecarLayout | null;
  putSidecar: (layout: SidecarLayout) => void;
}

/**
 * Inner SLD canvas — assumes a topology + selection are present. The
 * outer `SldCanvas` handles the empty / loading branches and forwards
 * here once all preconditions are met.
 *
 * The hook order is: pick curated layout (if any) → run ELK in parallel
 * (we still want a fallback for unmatched buses + drift detection) →
 * merge with stored sidecar coords → render.
 */
function SldCanvasInner({ topology, primaryPath, storedSidecar, putSidecar }: InnerProps) {
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
    'meta+slash, ctrl+slash',
    (e) => {
      e.preventDefault();
      __requestOpenSldSearch();
    },
    { enableOnFormTags: ['INPUT', 'TEXTAREA'] },
    [],
  );
  const [autoCoords, setAutoCoords] = useState<CoordsByIdx | null>(null);
  const [autoBendPoints, setAutoBendPoints] = useState<Map<string, [number, number][]> | null>(
    null,
  );
  const [coords, setCoords] = useState<CoordsByIdx | null>(null);
  const [showLargeBanner, setShowLargeBanner] = useState<boolean>(false);
  const [showDriftBanner, setShowDriftBanner] = useState<boolean>(false);
  // Track the latest topology -> ignore stale ELK resolutions for a
  // prior topology when the user changes case mid-flight.
  const topologyRef = useRef(topology);
  topologyRef.current = topology;

  // Curated layout takes precedence over auto-layout. Computed once
  // per primaryPath; the result is folded into mergeWithDrift below.
  // Blank sessions (no primaryPath) get no curated match.
  const curated = useMemo(
    () => (primaryPath ? curatedLayoutFor(primaryPath) : null),
    [primaryPath],
  );

  // Run ELK on mount + topology change. Curated layouts skip the ELK
  // fallback when ALL buses are covered, but we still run ELK so any
  // bus the curated layout missed gets an auto-position.
  useEffect(() => {
    let cancelled = false;
    setAutoCoords(null);
    setAutoBendPoints(null);
    void autoLayout(topology).then((computed) => {
      if (cancelled) return;
      if (topologyRef.current !== topology) return;
      setAutoCoords(computed.coords);
      setAutoBendPoints(computed.bendPoints);
    });
    return () => {
      cancelled = true;
    };
  }, [topology]);

  // Compose the final coordinate map once auto-layout resolves.
  useEffect(() => {
    if (autoCoords === null) return;
    const baseSidecar = storedSidecar ?? curated ?? null;
    const merged = mergeWithDrift(baseSidecar, topology, autoCoords);
    setCoords(merged.coords);
    setShowDriftBanner(merged.hasDrift);
    // >30-bus banner: only when there's no curated layout AND no
    // stored sidecar AND the case is large.
    const isLarge =
      topology.buses.length > LARGE_TOPOLOGY_THRESHOLD &&
      curated === null &&
      storedSidecar === null;
    setShowLargeBanner(isLarge);
  }, [autoCoords, storedSidecar, curated, topology]);

  // React Flow's controlled state. Maintained in `nodes`/`edges` so we
  // can mutate node positions on drag without losing other props.
  //
  // Unit 1: only feed ELK bend points to buildGraph when the canvas is
  // running on auto-layout (no curated, no sidecar) — otherwise the
  // bend points reference pass-2 ELK coords that diverge from the
  // curated/sidecar coords React Flow renders, and the polyline would
  // hang in mid-air. The handle assignments still flow through both
  // paths so co-handle stride works for curated cases too.
  const usingAutoLayout = curated === null && storedSidecar === null;
  // Drag overrides — per-node coordinate overrides applied AFTER
  // buildGraph so user drags persist across topology re-fetches (Unit 9
  // fix). Lives on the case store (Unit 13a) so the SaveSystemButton
  // can snapshot the current layout into the auto-saved sidecar
  // alongside the case file.
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
  // Merge the sidecar's `non_bus_coordinates` (curated layout OR
  // user-saved on disk) into the graph builder's `nonBusCoords` opt.
  // The merge prefers model-class keys but folds UI-category keys
  // alongside, so a kind-edited element resolves via the fallback.
  const nonBusCoordsMap = useMemo(
    () => nonBusCoordsAsMap(storedSidecar?.non_bus_coordinates),
    [storedSidecar],
  );
  const baseGraph = useMemo(() => {
    if (!coords) return null;
    // Effective coords = the layout coords with user drag-overrides folded
    // in for buses. The handle assignment (which side of each bus an edge
    // leaves from) must be computed against where the bus ACTUALLY sits, or
    // a moved bus's edges leave from the wrong side and look disconnected.
    const effectiveCoords =
      Object.keys(dragOverrides).length === 0
        ? coords
        : (() => {
            const merged: typeof coords = { ...coords };
            for (const [id, pos] of Object.entries(dragOverrides)) {
              if (merged[id] !== undefined) merged[id] = pos; // bus coords only
            }
            return merged;
          })();
    const { branches, stubs } = computeHandleAssignments(topology, effectiveCoords);
    const bendPoints = usingAutoLayout && autoBendPoints ? autoBendPoints : undefined;
    const built = buildGraph(topology, coords, {
      handleAssignments: branches,
      stubAssignments: stubs,
      bendPoints,
      nonBusCoords: nonBusCoordsMap,
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
  }, [topology, coords, autoBendPoints, usingAutoLayout, dragOverrides, nonBusCoordsMap]);

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
  }, [baseGraph, setDragOverrides]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  useEffect(() => {
    if (!baseGraph) return;
    setNodes(baseGraph.nodes);
    setEdges(baseGraph.edges);
  }, [baseGraph]);

  // On drag stop, persist the updated coords. Two channels:
  //
  // - In-memory `dragOverrides`: applied to the next baseGraph derivation
  //   so the override survives topology re-fetches (the bug Unit 9
  //   fixes — previously every successful add() snapped dragged nodes
  //   back to their kind-default positions).
  // - Disk sidecar (only for sessions with a primaryPath): persists
  //   bus coordinates AND non-bus coordinates across page reloads. The
  //   non-bus entries are written under the dual-key shape (model
  //   class + UI category) per the sidecar schema (Unit 4, v0.1.y).
  //
  // Look up the model class per non-bus idx by walking the topology
  // buckets. The map is rebuilt on every render to track topology
  // edits (kind-changes, idx remappings); the work is O(non-bus
  // count) so the cost is negligible.
  const nonBusModelByCategoryIdx = useMemo(() => {
    const map = new Map<string, string>();
    const fold = (entries: ReadonlyArray<{ idx: number | string; kind: string }>, cat: string) => {
      for (const e of entries) {
        map.set(`${cat}-${String(e.idx)}`, e.kind);
      }
    };
    fold(topology.generators ?? [], 'generator');
    fold(topology.loads ?? [], 'load');
    fold(topology.shunts ?? [], 'shunt');
    return map;
  }, [topology]);
  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      setNodes((curr) => {
        const next = applyPositionChanges(curr, changes);
        const dragEnded = changes.some(
          (c): c is NodePositionChange =>
            c.type === 'position' && c.dragging === false && c.position !== undefined,
        );
        if (dragEnded) {
          // Capture every node's current position into the override map.
          // The map keys by React Flow node id (bus idx for buses,
          // `${kind}-${idx}` for non-bus nodes).
          const overrides: Record<string, { x: number; y: number }> = {};
          for (const n of next) {
            overrides[n.id] = { x: n.position.x, y: n.position.y };
          }
          setDragOverrides(overrides);

          // Persist to the disk sidecar. Loaded sessions only.
          if (primaryPath) {
            const busCoords: CoordsByIdx = {};
            const nonBusOverrides: NonBusOverride[] = [];
            for (const n of next) {
              if (n.type === 'bus') {
                busCoords[n.id] = { x: n.position.x, y: n.position.y };
                continue;
              }
              if (n.type === 'generator' || n.type === 'load' || n.type === 'shunt') {
                const data = n.data as { idx?: string };
                const idx = data.idx ?? n.id.replace(/^(generator|load|shunt)-/, '');
                const modelClass = nonBusModelByCategoryIdx.get(n.id) ?? null;
                nonBusOverrides.push({
                  uiCategory: n.type,
                  idx: String(idx),
                  modelClass,
                  coord: { x: n.position.x, y: n.position.y },
                });
              }
            }
            if (Object.keys(busCoords).length > 0 || nonBusOverrides.length > 0) {
              const layout = buildSidecarLayout(busCoords, {
                nonBusCoords: buildNonBusCoordinates(nonBusOverrides),
              });
              debouncedPutSidecar(primaryPath, layout, putSidecar);
            }
          }
        }
        return next;
      });
    },
    [primaryPath, putSidecar, setDragOverrides, nonBusModelByCategoryIdx],
  );

  // Cleanup pending PUT on unmount.
  useEffect(() => {
    if (!primaryPath) return;
    const path = primaryPath;
    return () => cancelPendingSidecarPut(path);
  }, [primaryPath]);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_e, node) => {
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
        setSelectedNodeId(node.id);
        return;
      }
      const kind = rawKind as 'bus' | 'line' | 'generator' | 'load' | 'shunt';
      setSelectedElement({ kind, idx: String(idx) });
      // Unit 11: also write the SLD store's selectedNodeId so the
      // canvas + bus-node visual highlight follow the click. The
      // inspector-row → SLD-pan path goes through the same slot.
      setSelectedNodeId(node.id);
    },
    [setSelectedElement, setSelectedNodeId],
  );

  const onEdgeClick: EdgeMouseHandler = useCallback(
    (_e, edge) => {
      const data = edge.data as { idx?: string; bucket?: string } | undefined;
      const idx = data?.idx;
      if (!idx) return;
      // Stub edges (non-bus → bus connectors) aren't independently
      // selectable — clicking one routes to the bus side, but in
      // practice the user clicks the device or bus node instead.
      const edgeType = edge.type ?? 'topology';
      if (edgeType === 'stub') return;
      const kind: 'line' | 'transformer' = edgeType === 'transformer' ? 'transformer' : 'line';
      setSelectedElement({ kind, idx: String(idx) });
    },
    [setSelectedElement],
  );

  // Connectivity / island-detection overlay (Unit 17). Subscribes to
  // the connectivity slice; when a result is present we flag every
  // bus that is NOT in a non-trivial island as "de-energised" so the
  // canvas can grey it out. Subscribing to `result` (rather than
  // `energisedBusIdxes` directly) keeps the membership check
  // referentially stable while the user navigates around the canvas.
  const connectivityResult = useConnectivityStore((s) => s.result);
  const energisedBusIdxes = useConnectivityStore((s) => s.energisedBusIdxes);

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
        const selected =
          (selectedElement !== null &&
            selectedElement.idx === n.id &&
            selectedElement.kind === (n.type ?? 'bus')) ||
          selectedNodeId === n.id;
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
        return {
          ...n,
          selected,
          className,
          data: {
            ...(n.data as Record<string, unknown>),
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
            sldSelected: selectedNodeId === n.id,
          },
        };
      }),
    [nodes, selectedElement, selectedNodeId, connectivityResult, energisedBusIdxes],
  );

  // Pan-on-selection effect (Unit 11). When `selectedNodeId` flips,
  // centre the React Flow viewport on the matching node — keeping the
  // current zoom level so users don't lose context. The effect runs
  // for every change including the canvas's own click writes, but
  // panning to a node that's already centred is a no-op so the cost
  // is negligible. Skipped when the selected id doesn't match a
  // mounted node (e.g., topology changed since the id was set).
  useEffect(() => {
    if (selectedNodeId === null) return;
    const node = nodes.find((n) => n.id === selectedNodeId);
    if (!node) return;
    const currentZoom = rf.getZoom();
    rf.setCenter(node.position.x, node.position.y, {
      zoom: currentZoom,
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

  // Derive a stable case-name slug from the primary path, mirroring
  // the helper used in the plot panels. Blank sessions fall back to
  // "case" so the file still has a sensible name.
  const caseName = (() => {
    if (!primaryPath) return 'case';
    const base = primaryPath.split(/[\\/]/).pop() ?? primaryPath;
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(0, dot) : base;
  })();

  if (coords === null) {
    return <SldLayoutSkeleton />;
  }

  return (
    <div className="flex h-full w-full flex-col" data-testid="sld-canvas">
      <div className="flex items-center justify-end gap-2 px-2 py-1">
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
      <div
        ref={canvasRef}
        className="relative min-h-0 flex-1"
        data-testid="sld-canvas-surface"
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
      >
        <ReactFlow
          nodes={nodesWithSelection}
          edges={edges}
          onNodesChange={onNodesChange}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          fitView
          nodesDraggable
          selectionMode={SelectionMode.Partial}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={16}
            size={1}
            color={DOT_GRID_COLOR}
            data-testid="sld-canvas-dot-grid"
          />
          <Controls className={FLOATING_OVERLAY_CHROME} />
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
        </ReactFlow>
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

/** Apply React Flow position changes to a node array. */
function applyPositionChanges(nodes: Node[], changes: NodeChange[]): Node[] {
  const positionById = new Map<string, { x: number; y: number }>();
  for (const c of changes) {
    if (c.type === 'position' && c.position) {
      positionById.set(c.id, c.position);
    }
  }
  if (positionById.size === 0) return nodes;
  return nodes.map((n) => {
    const p = positionById.get(n.id);
    return p ? { ...n, position: p } : n;
  });
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

  // TanStack Query v5 recreates the mutation result object every render but
  // guarantees `.mutate` is referentially stable; depend on it directly so
  // this callback isn't recreated on each render.
  const putSidecarMutate = putSidecarMutation.mutate;
  const putSidecar = useCallback(
    (layout: SidecarLayout) => {
      if (!primaryPath) return;
      // primaryPath is already a branded WorkspacePath.
      putSidecarMutate({ casePath: primaryPath, layout });
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
        storedSidecar={sidecarQuery.data ?? null}
        putSidecar={putSidecar}
      />
    </ReactFlowProvider>
  );
}
