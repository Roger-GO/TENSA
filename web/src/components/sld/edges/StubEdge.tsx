import { memo } from 'react';
import { BaseEdge, getStraightPath } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';

/**
 * Stub edge — short straight line connecting a non-bus device
 * (generator / load / shunt) to its parent bus's cardinal handle.
 *
 * No flow overlay, no arrow, no label — just a thin line. Visually
 * distinct from topology edges (lines + transformers) so the reader
 * can tell branch connections apart from device anchors.
 */
export const StubEdge = memo(function StubEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
}: EdgeProps) {
  const [path] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  return (
    <BaseEdge
      path={path}
      style={{
        stroke: 'var(--color-muted-foreground)',
        strokeWidth: 1,
        strokeDasharray: '4 3',
      }}
    />
  );
});
