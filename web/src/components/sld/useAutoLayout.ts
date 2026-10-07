/**
 * The automatic arrangement of the SLD canvas, worked out only when it can
 * change what is drawn.
 *
 * A case with no saved layout is arranged in two steps: ELK places the
 * buses (`layout.ts`), and the diagram is then arranged around them as Tidy
 * and re-layout arranges it (`planTidy`): the buses on the grid, every
 * generator, load and shunt beside its bus, and every line and transformer
 * routed clear of all of it and of each other. So a case opens as a diagram
 * on which nothing is drawn over anything else, and the first Tidy has
 * nothing left to do. Both steps run off the main thread on a large case
 * (the ELK worker, the tidy worker).
 *
 * A new `topology` object arrives after every power-flow run, reload and
 * parameter edit, and none of those move a bus. This hook starts a layout
 * only when the graph's shape changes (`layoutSignature`: bus idx values
 * and branch terminals), and not at all when the stored or curated layout
 * already places every bus, since `mergeWithDrift` then never reads an
 * auto-layout coordinate.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BusCoord, TopologySummary, SidecarLayout } from '@/api/types';
import { buildGraph, defaultBarLengths } from './graph';
import { autoLayout, layoutSignature } from './layout';
import type { RouteAnchors } from './routing';
import { sidecarCoversBuses, type CoordsByIdx } from './sidecar';
import { startTidy } from './tidyClient';

/** The diagram as it is arranged when no layout says otherwise. */
export interface AutoArrangement {
  /** Where each generator, load and shunt stands, by `<model class>|<idx>`. */
  devices: Map<string, BusCoord>;
  /** The route of each line and transformer, by edge id, and the bus positions it is for. */
  routes: Map<string, [number, number][]>;
  anchors: Map<string, RouteAnchors>;
}

export interface AutoLayoutState {
  /** The bus coordinates for the current graph shape; `null` while they are computed. */
  coords: CoordsByIdx | null;
  /**
   * The devices and the routes that go with those coordinates, when the
   * whole diagram is arranged here (`base` is `null`); `null` while it is
   * worked out, and where a layout places some of the buses itself.
   */
  arrangement: AutoArrangement | null;
  /**
   * False when `base` already covers every bus. Then `coords` stays `null`
   * for good, and the caller should merge with an empty auto-layout.
   */
  needed: boolean;
}

interface Resolved {
  coords: CoordsByIdx;
  arrangement: AutoArrangement | null;
  signature: string;
}

/**
 * Arrange the diagram of `topology` around the bus coordinates ELK gave:
 * what Tidy and re-layout would make of it. `onJob` is handed the way to
 * call the work off.
 */
export async function arrangeDiagram(
  topology: TopologySummary,
  elkCoords: CoordsByIdx,
  onJob: (cancel: () => void) => void = () => {},
): Promise<{ coords: CoordsByIdx; arrangement: AutoArrangement }> {
  const barLengths = defaultBarLengths(topology);
  const graph = buildGraph(topology, elkCoords, { barLengths });
  const job = startTidy(graph, topology, { relayout: true, barLengths });
  onJob(job.cancel);
  const plan = job.plan ?? (await job.done);
  const coords: CoordsByIdx = {};
  const devices = new Map<string, BusCoord>();
  for (const node of plan.nodes) {
    const place = { x: node.position.x, y: node.position.y };
    const data = node.data as { idx?: unknown; kind?: unknown };
    if (node.type === 'bus') coords[node.id] = place;
    else if (node.type === 'generator' || node.type === 'load' || node.type === 'shunt') {
      devices.set(`${String(data.kind)}|${String(data.idx)}`, place);
    }
  }
  const routes = new Map<string, [number, number][]>();
  const anchors = new Map<string, RouteAnchors>();
  for (const edge of plan.edges) {
    const points = plan.tidied.routes.get(edge.id);
    const source = coords[edge.source];
    const target = coords[edge.target];
    if (points === undefined || source === undefined || target === undefined) continue;
    routes.set(
      edge.id,
      points.map(([x, y]): [number, number] => [x, y]),
    );
    anchors.set(edge.id, { source: { ...source }, target: { ...target } });
  }
  return { coords, arrangement: { devices, routes, anchors } };
}

/**
 * @param topology Current topology; only its graph shape matters here.
 * @param base The stored sidecar, or the curated layout when there is none.
 */
export function useAutoLayout(
  topology: TopologySummary,
  base: SidecarLayout | null,
): AutoLayoutState {
  const signature = useMemo(() => layoutSignature(topology), [topology]);
  const needed = useMemo(() => !sidecarCoversBuses(base, topology), [base, topology]);
  // With no layout at all the whole diagram is arranged here; with one that
  // misses a bus only that bus gets a place.
  const whole = base === null;
  const [resolved, setResolved] = useState<Resolved | null>(null);
  // The effect starts a layout for the render that changed `signature`;
  // later renders carry newer topology objects of the same shape.
  const topologyRef = useRef(topology);
  topologyRef.current = topology;

  useEffect(() => {
    if (!needed) return;
    let cancelled = false;
    let cancelJob = (): void => {};
    void autoLayout(topologyRef.current, undefined, { routes: false }).then(async (computed) => {
      if (cancelled) return;
      if (!whole) {
        setResolved({ coords: computed.coords, arrangement: null, signature });
        return;
      }
      try {
        const arranged = await arrangeDiagram(topologyRef.current, computed.coords, (cancel) => {
          cancelJob = cancel;
        });
        if (!cancelled) setResolved({ ...arranged, signature });
      } catch (err) {
        // The diagram still opens: the buses where ELK put them, the rest
        // placed and routed by the canvas as it draws.
        console.warn('SLD auto-layout: arranging the diagram failed', err);
        if (!cancelled) setResolved({ coords: computed.coords, arrangement: null, signature });
      }
    });
    return () => {
      cancelled = true;
      cancelJob();
    };
  }, [needed, whole, signature]);

  const current = needed && resolved?.signature === signature ? resolved : null;
  return {
    coords: current?.coords ?? null,
    arrangement: whole ? (current?.arrangement ?? null) : null,
    needed,
  };
}
