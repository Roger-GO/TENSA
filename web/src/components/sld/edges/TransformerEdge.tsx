import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import { iconForModel } from '@/icons/iec60617/manifest';
import { usePflowStore } from '@/store/pflow';
import { useUiStore } from '@/store/ui';
import type { Side } from '../graph';
import { getLineOverlayState } from '../overlay';

/**
 * Transformer edge — bus-to-bus polyline (or smooth-step path) with the
 * IEC 60617 2W or 3W glyph rendered at the path midpoint.
 *
 * Mirrors `TopologyEdge`/`RoutedEdge`'s stride + bend-point handling so
 * the path itself reads identically to a regular line; the difference
 * is purely the midpoint icon plus a transformer-specific click target.
 *
 * Click on the icon sets `selectedElement.kind = 'transformer'` so the
 * inspector shows transformer params (Unit 5b populated `_PARAMS_BY_MODEL`
 * for Lines, which carry tap/phi).
 */
interface EdgeData {
  idx?: string;
  name?: string;
  kind?: string;
  bucket?: 'line' | 'transformer';
  sourceSide?: Side;
  targetSide?: Side;
  sourceStride?: number;
  targetStride?: number;
  bendPoints?: [number, number][];
  winding?: '2w' | '3w';
}

const STRIDE_PIXELS = 14;
const ICON_SIZE = 24;

function strideShift(side: Side | undefined, stride: number): { dx: number; dy: number } {
  if (!side || stride === 0) return { dx: 0, dy: 0 };
  const sign = stride % 2 === 1 ? 1 : -1;
  const magnitude = Math.ceil(stride / 2);
  const offset = sign * magnitude * STRIDE_PIXELS;
  if (side === 'north' || side === 'south') return { dx: offset, dy: 0 };
  return { dx: 0, dy: offset };
}

function buildPolyline(points: [number, number][]): string {
  if (points.length < 2) return '';
  const [first, ...rest] = points as [[number, number], ...[number, number][]];
  return `M${first[0]},${first[1]} ` + rest.map(([x, y]) => `L${x},${y}`).join(' ');
}

function midpointOfPolyline(points: [number, number][]): { x: number; y: number } | null {
  if (points.length < 2) return null;
  let total = 0;
  const segments: { ax: number; ay: number; bx: number; by: number; len: number }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i] as [number, number];
    const b = points[i + 1] as [number, number];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    total += len;
    segments.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1], len });
  }
  if (total === 0) return { x: points[0]![0], y: points[0]![1] };
  let traveled = 0;
  const target = total / 2;
  for (const s of segments) {
    if (traveled + s.len >= target) {
      const t = s.len > 0 ? (target - traveled) / s.len : 0;
      return { x: s.ax + t * (s.bx - s.ax), y: s.ay + t * (s.by - s.ay) };
    }
    traveled += s.len;
  }
  const last = segments[segments.length - 1]!;
  return { x: last.bx, y: last.by };
}

export const TransformerEdge = memo(function TransformerEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps) {
  const pflowResult = usePflowStore((s) => s.lastRun);
  const hideLabels = useUiStore((s) => s.hideLabels);
  const edgeData = (data ?? {}) as EdgeData;
  const sourceShift = strideShift(edgeData.sourceSide, edgeData.sourceStride ?? 0);
  const targetShift = strideShift(edgeData.targetSide, edgeData.targetStride ?? 0);
  const polyline = edgeData.bendPoints ?? [];

  let path: string;
  let mid: { x: number; y: number };
  if (polyline.length >= 2) {
    path = buildPolyline(polyline);
    mid = midpointOfPolyline(polyline) ?? {
      x: (sourceX + targetX) / 2,
      y: (sourceY + targetY) / 2,
    };
  } else {
    const [smoothPath, labelX, labelY] = getSmoothStepPath({
      sourceX: sourceX + sourceShift.dx,
      sourceY: sourceY + sourceShift.dy,
      sourcePosition,
      targetX: targetX + targetShift.dx,
      targetY: targetY + targetShift.dy,
      targetPosition,
      borderRadius: 4,
    });
    path = smoothPath;
    mid = { x: labelX, y: labelY };
  }

  // Transformers ARE lines on the substrate side; the line-flow
  // computation runs over every Line device regardless of which bucket
  // (lines vs transformers) the substrate routes the entry into. So
  // we read the overlay for both bucket values.
  const branchIdx = edgeData.idx;
  const overlay = branchIdx ? getLineOverlayState(branchIdx, pflowResult, hideLabels) : null;
  const stroke = overlay?.has_data ? 'var(--color-foreground)' : 'var(--color-muted-foreground)';
  const strokeWidth = overlay?.has_data ? 1.8 : 1.5;
  const dotRadius = 3.5;
  const dotFill = 'var(--color-foreground)';

  const winding = edgeData.winding ?? '2w';
  const iconSrc = iconForModel(winding === '3w' ? 'Transformer3W' : 'Transformer');

  const sourcePoint = { x: sourceX + sourceShift.dx, y: sourceY + sourceShift.dy };
  const targetPoint = { x: targetX + targetShift.dx, y: targetY + targetShift.dy };

  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={{ stroke, strokeWidth }} />
      <circle cx={sourcePoint.x} cy={sourcePoint.y} r={dotRadius} fill={dotFill} />
      <circle cx={targetPoint.x} cy={targetPoint.y} r={dotRadius} fill={dotFill} />
      <EdgeLabelRenderer>
        <div
          data-testid={`transformer-edge-icon-${id}`}
          data-winding={winding}
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)`,
            pointerEvents: 'all',
          }}
          className="bg-background border-border flex h-7 w-7 items-center justify-center rounded-full border"
        >
          <img
            src={iconSrc}
            alt=""
            aria-hidden="true"
            draggable={false}
            style={{ height: ICON_SIZE, width: ICON_SIZE, objectFit: 'contain' }}
          />
          {winding === '3w' ? (
            <span className="bg-warning/20 text-foreground absolute -top-1 -right-1 rounded-[var(--radius-sm)] px-1 font-mono text-[8px] leading-tight">
              3w
            </span>
          ) : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
});
