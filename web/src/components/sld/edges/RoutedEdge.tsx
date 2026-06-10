import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import { usePflowStore } from '@/store/pflow';
import { useUiStore } from '@/store/ui';
import { getLineOverlayState } from '../overlay';
import { LineFlowArrow } from './LineFlowArrow';

/**
 * Routed edge — used by the auto-layout case where ELK supplied a
 * polyline through `data.bendPoints`. Each entry is `[x, y]` in canvas
 * units; the polyline includes the start point, every bend, and the
 * end point in order.
 *
 * The path is `M start L bend1 L bend2 ... L end` — pure polyline, no
 * smoothing. ELK already produced an orthogonal route through the
 * declared cardinal port, so the polyline naturally aligns with the
 * bus's cardinal handle on each end.
 *
 * If `data.bendPoints` is unset (defensive — `graph.ts` only sets the
 * edge type to `'routed'` when bend points are present), we degrade to
 * a simple `M source L target` line using React Flow's source/target
 * coords. This shouldn't happen in practice; the canvas falls through
 * to `TopologyEdge` for edges without a polyline.
 */
interface EdgeData {
  idx?: string;
  name?: string;
  kind?: string;
  bucket?: 'line' | 'transformer';
  bendPoints?: [number, number][];
}

function buildPath(points: [number, number][], fallback: string): string {
  if (points.length < 2) return fallback;
  const [first, ...rest] = points as [[number, number], ...[number, number][]];
  return `M${first[0]},${first[1]} ` + rest.map(([x, y]) => `L${x},${y}`).join(' ');
}

interface MidpointWithTangent {
  x: number;
  y: number;
  /** Segment tangent in degrees (CW from +X). Used to align flow arrows. */
  angleDeg: number;
}

function midpointOf(points: [number, number][]): MidpointWithTangent | null {
  if (points.length < 2) return null;
  // Walk the polyline, find the segment containing the half-length
  // mark, return its interior point + that segment's tangent angle.
  // Cheap O(n) for the small N (typically 2-5 points) ELK emits.
  let total = 0;
  const segments: { ax: number; ay: number; bx: number; by: number; len: number }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i] as [number, number];
    const b = points[i + 1] as [number, number];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    total += len;
    segments.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1], len });
  }
  if (total === 0) return { x: points[0]![0], y: points[0]![1], angleDeg: 0 };
  let traveled = 0;
  const target = total / 2;
  for (const s of segments) {
    if (traveled + s.len >= target) {
      const t = s.len > 0 ? (target - traveled) / s.len : 0;
      return {
        x: s.ax + t * (s.bx - s.ax),
        y: s.ay + t * (s.by - s.ay),
        angleDeg: (Math.atan2(s.by - s.ay, s.bx - s.ax) * 180) / Math.PI,
      };
    }
    traveled += s.len;
  }
  const last = segments[segments.length - 1]!;
  return {
    x: last.bx,
    y: last.by,
    angleDeg: (Math.atan2(last.by - last.ay, last.bx - last.ax) * 180) / Math.PI,
  };
}

export const RoutedEdge = memo(function RoutedEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  data,
}: EdgeProps) {
  const pflowResult = usePflowStore((s) => s.lastRun);
  const hideLabels = useUiStore((s) => s.hideLabels);
  const edgeData = (data ?? {}) as EdgeData;
  const polyline = edgeData.bendPoints ?? [];
  const fallbackPath = `M${sourceX},${sourceY} L${targetX},${targetY}`;
  const path = buildPath(polyline, fallbackPath);
  const fallbackAngle = (Math.atan2(targetY - sourceY, targetX - sourceX) * 180) / Math.PI;
  const mid = midpointOf(polyline) ?? {
    x: (sourceX + targetX) / 2,
    y: (sourceY + targetY) / 2,
    angleDeg: fallbackAngle,
  };
  const isLine = edgeData.bucket === 'line';
  const lineIdx = edgeData.idx;
  const overlay = isLine && lineIdx ? getLineOverlayState(lineIdx, pflowResult, hideLabels) : null;
  // Pull the raw |P| out of the PF result so the arrow size scales with
  // magnitude. The overlay state only carries a formatted label string;
  // we read the underlying number directly to avoid re-parsing it.
  const lineFlowAbsMw =
    isLine && lineIdx && pflowResult?.line_flows
      ? Math.abs(pflowResult.line_flows[lineIdx]?.p ?? 0)
      : 0;
  const stroke = overlay?.has_data ? 'var(--color-foreground)' : 'var(--color-muted-foreground)';
  const strokeWidth = overlay?.has_data ? 1.8 : 1.5;
  // Endpoint dots — explicit markers at the polyline's start and end
  // so the reader can tell which lines actually connect to a bus vs.
  // ones that pass behind it. Match the conventions from TopologyEdge.
  const start = polyline[0] ?? [sourceX, sourceY];
  const end = polyline[polyline.length - 1] ?? [targetX, targetY];
  const dotRadius = 3.5;
  const dotFill = 'var(--color-foreground)';

  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={{ stroke, strokeWidth }} />
      <circle cx={start[0]} cy={start[1]} r={dotRadius} fill={dotFill} />
      <circle cx={end[0]} cy={end[1]} r={dotRadius} fill={dotFill} />
      {overlay && overlay.has_data && overlay.direction !== 'neutral' ? (
        <LineFlowArrow
          x={mid.x}
          y={mid.y}
          angleDeg={mid.angleDeg}
          direction={overlay.direction}
          absMw={lineFlowAbsMw}
          testid={`line-flow-arrow-${id}`}
        />
      ) : null}
      {overlay && overlay.has_data && (overlay.p_label !== null || overlay.q_label !== null) ? (
        <EdgeLabelRenderer>
          <div
            data-testid={`line-flow-label-${id}`}
            data-direction={overlay.direction}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)`,
              pointerEvents: 'none',
              zIndex: 20,
            }}
            className="bg-background text-foreground border-border rounded-[var(--radius-sm)] border px-1.5 py-0.5 font-mono text-[10px] leading-tight shadow-sm"
          >
            <div className="flex items-center gap-1">
              <span aria-hidden="true">
                {overlay.direction === 'forward' ? '→' : overlay.direction === 'reverse' ? '←' : ''}
              </span>
              {overlay.p_label !== null ? <span>{overlay.p_label}</span> : null}
            </div>
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
});
