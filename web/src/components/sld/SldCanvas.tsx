import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  SelectionMode,
} from '@xyflow/react';
import type {
  Edge,
  Node,
  NodeTypes,
  EdgeTypes,
  NodeMouseHandler,
  OnNodesChange,
  NodeChange,
  NodePositionChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useCaseStore } from '@/store/case';
import { useGetSidecar, usePutSidecar, useCurrentTopology } from '@/api/queries';
import type { TopologySummary, SidecarLayout } from '@/api/types';

import { BusNode } from './nodes/BusNode';
import { LineNode } from './nodes/LineNode';
import { TransformerNode } from './nodes/TransformerNode';
import { GeneratorNode } from './nodes/GeneratorNode';
import { LoadNode } from './nodes/LoadNode';
import { ShuntNode } from './nodes/ShuntNode';
import { TopologyEdge } from './edges/TopologyEdge';
import { RoutedEdge } from './edges/RoutedEdge';
import { SldLayoutSkeleton } from './SldLayoutSkeleton';
import { autoLayout } from './layout';
import {
  buildSidecarLayout,
  cancelPendingSidecarPut,
  debouncedPutSidecar,
  mergeWithDrift,
  type CoordsByIdx,
} from './sidecar';
import { curatedLayoutFor } from './curated';
import { buildGraph, computeHandleAssignments } from './graph';
import { cn } from '@/lib/cn';

const NODE_TYPES: NodeTypes = {
  bus: BusNode,
  line: LineNode,
  transformer: TransformerNode,
  generator: GeneratorNode,
  load: LoadNode,
  shunt: ShuntNode,
};

const EDGE_TYPES: EdgeTypes = {
  topology: TopologyEdge,
  routed: RoutedEdge,
};

/** Buses-count threshold for the >30 banner (per the plan). */
const LARGE_TOPOLOGY_THRESHOLD = 30;

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
  primaryPath: string;
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
  const curated = useMemo(() => curatedLayoutFor(primaryPath), [primaryPath]);

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
  const baseGraph = useMemo(() => {
    if (!coords) return null;
    const handleAssignments = computeHandleAssignments(topology, coords);
    const bendPoints = usingAutoLayout && autoBendPoints ? autoBendPoints : undefined;
    return buildGraph(topology, coords, { handleAssignments, bendPoints });
  }, [topology, coords, autoBendPoints, usingAutoLayout]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  useEffect(() => {
    if (!baseGraph) return;
    setNodes(baseGraph.nodes);
    setEdges(baseGraph.edges);
  }, [baseGraph]);

  // On drag stop, persist the updated coords via debounced PUT.
  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      setNodes((curr) => {
        const next = applyPositionChanges(curr, changes);
        // Only persist on the final position-with-dragging:false event so
        // intermediate positions don't trigger a PUT each frame.
        const dragEnded = changes.some(
          (c): c is NodePositionChange =>
            c.type === 'position' && c.dragging === false && c.position !== undefined,
        );
        if (dragEnded) {
          const updatedCoords: CoordsByIdx = {};
          for (const n of next) {
            updatedCoords[n.id] = { x: n.position.x, y: n.position.y };
          }
          const layout = buildSidecarLayout(updatedCoords);
          debouncedPutSidecar(primaryPath, layout, putSidecar);
        }
        return next;
      });
    },
    [primaryPath, putSidecar],
  );

  // Cleanup pending PUT on unmount.
  useEffect(() => {
    return () => cancelPendingSidecarPut(primaryPath);
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
      const kind = rawKind as 'bus' | 'line' | 'transformer' | 'generator' | 'load' | 'shunt';
      setSelectedElement({ kind, idx: String(idx) });
    },
    [setSelectedElement],
  );

  // Sync React Flow's `selected` state with the case store so a
  // selection driven from the results table (Unit 9) reflects on the
  // canvas without needing a callback round-trip.
  const nodesWithSelection = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        selected:
          selectedElement !== null &&
          selectedElement.idx === n.id &&
          selectedElement.kind === (n.type ?? 'bus'),
      })),
    [nodes, selectedElement],
  );

  if (coords === null) {
    return <SldLayoutSkeleton />;
  }

  return (
    <div className="flex h-full w-full flex-col" data-testid="sld-canvas">
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
      <div className="min-h-0 flex-1">
        <ReactFlow
          nodes={nodesWithSelection}
          edges={edges}
          onNodesChange={onNodesChange}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodeClick={onNodeClick}
          fitView
          nodesDraggable
          selectionMode={SelectionMode.Partial}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
    </div>
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
