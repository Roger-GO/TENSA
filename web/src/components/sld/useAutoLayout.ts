/**
 * ELK auto-layout for the SLD canvas, run only when it can change what is
 * drawn.
 *
 * A new `topology` object arrives after every power-flow run, reload and
 * parameter edit, and none of those move a bus. This hook starts a layout
 * only when the graph's shape changes (`layoutSignature`: bus idx values
 * and branch terminals), and not at all when the stored or curated layout
 * already places every bus, since `mergeWithDrift` then never reads an
 * auto-layout coordinate.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TopologySummary, SidecarLayout } from '@/api/types';
import { autoLayout, layoutSignature, type LayoutResult } from './layout';
import { sidecarCoversBuses } from './sidecar';

export interface AutoLayoutState {
  /** ELK bus coordinates for the current graph shape; `null` while they are computed. */
  coords: LayoutResult['coords'] | null;
  /** ELK edge polylines for the current graph shape; `null` while they are computed. */
  bendPoints: LayoutResult['bendPoints'] | null;
  /**
   * False when `base` already covers every bus. Then `coords` stays `null`
   * for good, and the caller should merge with an empty auto-layout.
   */
  needed: boolean;
}

interface Resolved extends LayoutResult {
  signature: string;
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
  const [resolved, setResolved] = useState<Resolved | null>(null);
  // The effect starts a layout for the render that changed `signature`;
  // later renders carry newer topology objects of the same shape.
  const topologyRef = useRef(topology);
  topologyRef.current = topology;

  useEffect(() => {
    if (!needed) return;
    let cancelled = false;
    void autoLayout(topologyRef.current).then((computed) => {
      if (!cancelled) setResolved({ ...computed, signature });
    });
    return () => {
      cancelled = true;
    };
  }, [needed, signature]);

  const current = needed && resolved?.signature === signature ? resolved : null;
  return {
    coords: current?.coords ?? null,
    bendPoints: current?.bendPoints ?? null,
    needed,
  };
}
