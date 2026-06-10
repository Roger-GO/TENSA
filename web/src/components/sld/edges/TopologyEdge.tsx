import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import { usePflowStore } from '@/store/pflow';
import { useUiStore } from '@/store/ui';
import { type Side, strideShift } from '../graph';
import { getLineOverlayState } from '../overlay';
import { LineFlowArrow } from './LineFlowArrow';

/**
 * Topology edge. Connects two bus nodes via a polyline (orthogonal
 * smooth-step path — NOT bezier).
 *
 * Unit 1: when the edge carries a `data.stride > 0`, lateral-offset the
 * source endpoint along the perpendicular to the source side. This
 * separates edges that share a single bus's cardinal handle into
 * distinct corridors, eliminating the visual merge the polish loop
 * surfaced on IEEE 14.
 *
 * Unit 9: when post-PF + the edge's bucket is `line`, render a
 * directional arrow + a magnitude label at the midpoint. Color encoding
 * stays neutral; the directional arrow itself is the dominant visual
 * cue. The edge `data.bucket` field (set in `graph.ts`) tells us
 * whether to look the line up in `pflowResult.line_flows`.
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
}

export const TopologyEdge = memo(function TopologyEdge({
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
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX: sourceX + sourceShift.dx,
    sourceY: sourceY + sourceShift.dy,
    sourcePosition,
    targetX: targetX + targetShift.dx,
    targetY: targetY + targetShift.dy,
    targetPosition,
    borderRadius: 4,
  });
  const isLine = edgeData.bucket === 'line';
  const lineIdx = edgeData.idx;
  const overlay = isLine && lineIdx ? getLineOverlayState(lineIdx, pflowResult, hideLabels) : null;
  // Tangent at the label point. The smooth-step path bends, but for the
  // arrow we use the gross source→target direction — orthogonal segments
  // make any midpoint tangent feel arbitrary, and the gross direction
  // matches the user's mental model of the line's "from → to".
  const arrowAngleDeg = (Math.atan2(targetY - sourceY, targetX - sourceX) * 180) / Math.PI;
  const lineFlowAbsMw =
    isLine && lineIdx && pflowResult?.line_flows
      ? Math.abs(pflowResult.line_flows[lineIdx]?.p ?? 0)
      : 0;

  // Style: thicker / colored stroke when we have flow data; neutral
  // otherwise. The arrow direction is encoded via the marker plus a
  // small inline glyph in the label (forward vs. reverse).
  const stroke = overlay?.has_data ? 'var(--color-foreground)' : 'var(--color-muted-foreground)';
  const strokeWidth = overlay?.has_data ? 1.8 : 1.5;

  // Endpoint dots — explicit visual marker at each bus boundary so the
  // reader can tell which edges actually connect to a bus vs. ones
  // that pass behind it. Drawn after BaseEdge so they sit on top of
  // the path. Coords use the post-stride source/target points (the
  // edge's actual visual entry into the bus). Color is the foreground
  // tone — darker than the line stroke — so the dot reads as a
  // deliberate connection node, not part of the line itself.
  const dotRadius = 3.5;
  const dotFill = 'var(--color-foreground)';
  const sourcePoint = { x: sourceX + sourceShift.dx, y: sourceY + sourceShift.dy };
  const targetPoint = { x: targetX + targetShift.dx, y: targetY + targetShift.dy };

  return (
    <>
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={{ stroke, strokeWidth }} />
      <circle cx={sourcePoint.x} cy={sourcePoint.y} r={dotRadius} fill={dotFill} />
      <circle cx={targetPoint.x} cy={targetPoint.y} r={dotRadius} fill={dotFill} />
      {overlay && overlay.has_data && overlay.direction !== 'neutral' ? (
        <LineFlowArrow
          x={labelX}
          y={labelY}
          angleDeg={arrowAngleDeg}
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
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
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
