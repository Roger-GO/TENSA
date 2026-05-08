/**
 * ELK auto-layout for the SLD canvas.
 *
 * Builds an ELK graph from a topology summary (each bus → ELK node;
 * each line/transformer → ELK edge between its two terminal buses) and
 * runs `elkjs`'s `layered` algorithm with orthogonal edge routing. The
 * result is a `{busIdx → {x, y}}` map the canvas applies to its
 * React Flow node positions.
 *
 * Design choices:
 *
 * - `elk.layered` + `BRANDES_KOEPF` node placement gives the cleanest
 *   single-line-diagram look on IEEE 14 / 39 (textbook hierarchical
 *   bus banding); other algorithms produce graph-blob output that
 *   loses the visible "wedge" against PowerWorld.
 * - `elk.direction = DOWN` puts the slack bus near the top — matches
 *   the canonical IEEE 14 / 39 reference layouts so the auto-layout
 *   degrades gracefully when no curated layout exists.
 * - Spacing chosen empirically: `nodeNode=60` + `nodeNodeBetweenLayers
 *   =80` gives buses room to render their IEC 60617 icons + name
 *   labels without overlap, while still fitting IEEE 39 in a single
 *   viewport at default zoom.
 * - Fallback: if ELK throws (rare; bundle problem or pathological
 *   graph), fall back to a plain sqrt(n)-wide grid + warn. The canvas
 *   still renders — just less prettily — so the user is never left
 *   staring at a blank pane.
 */
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode, LayoutOptions } from 'elkjs/lib/elk-api';
import type { TopologySummary } from '@/api/types';
import type { CoordsByIdx } from './sidecar';

/** Lazy ELK instance — `elkjs` reads `Worker` on construction in some bundles. */
let elkInstance: InstanceType<typeof ELK> | null = null;

function getElk(): InstanceType<typeof ELK> {
  if (!elkInstance) {
    elkInstance = new ELK();
  }
  return elkInstance;
}

/**
 * Tunable layout options. Exported so tests can vary spacing without
 * editing the production constants. Production callers should pass no
 * argument and inherit the defaults below.
 */
export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.spacing.nodeNode': '60',
  'elk.layered.spacing.nodeNodeBetweenLayers': '80',
  'elk.edgeRouting': 'ORTHOGONAL',
};

/** Default node footprint passed to ELK (icon + label). */
const NODE_WIDTH = 60;
const NODE_HEIGHT = 40;

/** Grid fallback constants. */
const GRID_CELL_WIDTH = 120;
const GRID_CELL_HEIGHT = 100;

/**
 * Pull the bus1/bus2 idx values out of a Line / Transformer entry.
 * Both live inside the `params` dict per the Unit 5b extension.
 *
 * Returns `null` if the entry is missing one or both terminal idx
 * values — the caller filters these out (a topologically invalid edge
 * cannot be auto-routed and would crash ELK if passed in).
 */
function extractTerminals(
  entry: { params?: Record<string, number | string | boolean> } | undefined,
): { from: string; to: string } | null {
  const params = entry?.params;
  if (!params) return null;
  const bus1 = params.bus1;
  const bus2 = params.bus2;
  if (bus1 === undefined || bus2 === undefined) return null;
  if (typeof bus1 === 'boolean' || typeof bus2 === 'boolean') return null;
  return { from: String(bus1), to: String(bus2) };
}

/**
 * Run ELK on the topology and return per-bus coordinates.
 *
 * The function is async — ELK's bundled.js path runs synchronously
 * under the hood for small graphs but exposes a Promise API. Callers
 * should `await` and render `<SldLayoutSkeleton />` while pending.
 */
export async function autoLayout(
  topology: TopologySummary,
  options: LayoutOptions = DEFAULT_LAYOUT_OPTIONS,
): Promise<CoordsByIdx> {
  const buses = topology.buses;
  if (buses.length === 0) {
    return {};
  }

  // Collect every "edge" between two buses — both Line entries and
  // Transformer entries (per the topology shape; the substrate emits
  // transformers as a separate bucket even though ANDES models them
  // within the Line class).
  const branches: { id: string; from: string; to: string }[] = [];
  for (const line of topology.lines) {
    const terminals = extractTerminals(line);
    if (terminals) {
      branches.push({ id: `line-${String(line.idx)}`, ...terminals });
    }
  }
  for (const trafo of topology.transformers) {
    const terminals = extractTerminals(trafo);
    if (terminals) {
      branches.push({ id: `trafo-${String(trafo.idx)}`, ...terminals });
    }
  }

  // Filter out edges that reference a bus not in the topology — ELK
  // would throw otherwise. Defensive; should not happen with a
  // well-formed substrate response, but the cost is one Set lookup.
  const busIdSet = new Set(buses.map((b) => String(b.idx)));
  const validBranches = branches.filter((b) => busIdSet.has(b.from) && busIdSet.has(b.to));

  const elkGraph: ElkNode = {
    id: 'root',
    layoutOptions: options,
    children: buses.map((b) => ({
      id: String(b.idx),
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    edges: validBranches.map((b) => ({
      id: b.id,
      sources: [b.from],
      targets: [b.to],
    })),
  };

  try {
    const result = await getElk().layout(elkGraph);
    const coords: CoordsByIdx = {};
    for (const child of result.children ?? []) {
      coords[child.id] = { x: child.x ?? 0, y: child.y ?? 0 };
    }
    return coords;
  } catch (err) {
    console.warn('SLD auto-layout: ELK failed, using grid fallback', err);
    return gridLayout(buses.map((b) => String(b.idx)));
  }
}

/**
 * Grid-layout fallback. sqrt(n) wide, row-major ordering of bus idxs.
 * Used when ELK throws and as a last-resort when no auto-layout has run.
 */
export function gridLayout(busIds: readonly string[]): CoordsByIdx {
  const cols = Math.max(1, Math.ceil(Math.sqrt(busIds.length)));
  const out: CoordsByIdx = {};
  for (let i = 0; i < busIds.length; i++) {
    const id = busIds[i];
    if (!id) continue;
    const col = i % cols;
    const row = Math.floor(i / cols);
    out[id] = { x: col * GRID_CELL_WIDTH, y: row * GRID_CELL_HEIGHT };
  }
  return out;
}
