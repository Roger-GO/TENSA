import { memo } from 'react';
import { BaseEdge, getStraightPath } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import type { Side } from '../graph';

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

const STRIDE_PIXELS = 14;

function strideShift(side: Side | undefined, stride: number): { dx: number; dy: number } {
  if (!side || stride === 0) return { dx: 0, dy: 0 };
  const sign = stride % 2 === 1 ? 1 : -1;
  const magnitude = Math.ceil(stride / 2);
  const offset = sign * magnitude * STRIDE_PIXELS;
  if (side === 'north' || side === 'south') return { dx: offset, dy: 0 };
  return { dx: 0, dy: offset };
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
