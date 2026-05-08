import { memo } from 'react';
import { BaseEdge, getSmoothStepPath } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';

/**
 * Topology edge. Connects two bus nodes via a polyline (orthogonal
 * smooth-step path — NOT bezier). After-PF directional arrows + flow
 * magnitude labels are added by Unit 9 (`overlay.ts`); for Unit 8 the
 * edge renders as a plain stroke in the `border` color token.
 *
 * Smooth-step is preferred over straight-line because it joins to the
 * bus handles cleanly even when the source/target are at the same x or
 * y coordinate — exactly the case that arises in the IEEE 14 standard
 * layout (multiple buses per band).
 */
export const TopologyEdge = memo(function TopologyEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
}: EdgeProps) {
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 4,
  });
  return (
    <BaseEdge
      path={edgePath}
      markerEnd={markerEnd}
      style={{ stroke: 'var(--color-border)', strokeWidth: 1.5 }}
    />
  );
});
