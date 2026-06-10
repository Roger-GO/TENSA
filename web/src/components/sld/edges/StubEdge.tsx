import { memo } from 'react';
import { BaseEdge, getStraightPath } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import { type Side, strideShift } from '../graph';

/**
 * Stub edge — short straight line connecting a non-bus device
 * (generator / load / shunt) to its parent bus's cardinal handle.
 *
 * No flow overlay, no arrow, no label. Stride lateral-offsets the
 * bus-end endpoint so two stubs (or a stub and a branch) connecting
 * to the same cardinal side don't collide on the bus boundary.
 *
 * Connection-dot match: an explicit foreground dot at the bus end
 * mirrors the dots on regular edges so the user sees a consistent
 * "this is a real connection" marker at every device anchor.
 */
interface StubData {
  kind?: string;
  bucket?: 'generator' | 'load' | 'shunt';
  busSide?: Side;
  targetStride?: number;
}

export const StubEdge = memo(function StubEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps) {
  const d = (data ?? {}) as StubData;
  const targetShift = strideShift(d.busSide, d.targetStride ?? 0);
  const tx = targetX + targetShift.dx;
  const ty = targetY + targetShift.dy;
  const [path] = getStraightPath({ sourceX, sourceY, targetX: tx, targetY: ty });
  return (
    <>
      <BaseEdge
        path={path}
        style={{
          stroke: 'var(--color-muted-foreground)',
          strokeWidth: 1,
          strokeDasharray: '4 3',
        }}
      />
      <circle cx={tx} cy={ty} r={2.5} fill="var(--color-foreground)" />
    </>
  );
});
