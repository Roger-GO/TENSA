import { memo } from 'react';
import { BaseEdge, getSmoothStepPath } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import { usePflowStore } from '@/store/pflow';
import { useUiStore } from '@/store/ui';
import { type Side, strideShift } from '../graph';
import { getLineOverlayState, lineStrokeStyle } from '../overlay';
import { LineFlowArrow } from './LineFlowArrow';
import { LineFlowLabel } from './LineFlowLabel';
import { maxAbsFlowMw } from './lineFlowArrowMath';

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
 * directional arrow + a magnitude label at the midpoint. The arrow is the
 * dominant cue for the direction; the stroke turns amber or red, and heavier,
 * as the line nears or passes its rating. The edge `data.bucket` field (set in `graph.ts`) tells us
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
  // The arrow is sized against the largest branch flow of the case, not a fixed
  // 1000 MW, so a 100 MVA case gets arrows as telling as a 10 GW one.
  const lineFlowSatMw = pflowResult?.line_flows ? maxAbsFlowMw(pflowResult.line_flows) : undefined;

  // Style: a heavier stroke once we have flow data, amber or red as the line
  // nears or passes its rating; muted otherwise. The arrow direction is encoded
  // via the marker plus a small inline glyph in the label (forward vs. reverse).
  const { stroke, strokeWidth } = lineStrokeStyle(overlay);

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
          satMw={lineFlowSatMw}
          testid={`line-flow-arrow-${id}`}
        />
      ) : null}
      {overlay ? (
        <LineFlowLabel id={id} x={labelX} y={labelY} overlay={overlay} hideLabels={hideLabels} />
      ) : null}
    </>
  );
});
