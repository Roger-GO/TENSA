import { memo } from 'react';
import { BaseEdge } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import { routePath, type ConnectorRoute, type Point } from '../connections';
import { lineStrokeStyle } from '../overlay';

/**
 * Stub edge: the connector of a generator, load or shunt to its bus.
 *
 * It is drawn through the points `connections.ts` works out: from the
 * middle of the face of the device that points at the bus to the tap on the
 * bar, straight or with one right angle. The stroke is the one a branch
 * has while it carries no flow to show, solid, so a connector and a line
 * read as the same kind of conductor. The dot where it lands is the bar's
 * (`BusNode` draws every tap), which keeps it on top of the bar.
 *
 * No flow overlay, no arrow, no label.
 */
interface StubData {
  kind?: string;
  bucket?: 'generator' | 'load' | 'shunt';
  route?: ConnectorRoute;
}

const STROKE = lineStrokeStyle(null);

export const StubEdge = memo(function StubEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps) {
  const route = (data as StubData | undefined)?.route;
  // Without a route (the pass has not placed this connector) fall back to
  // the two handles React Flow resolved.
  const points: Point[] = route?.points ?? [
    [sourceX, sourceY],
    [targetX, targetY],
  ];
  return <BaseEdge path={routePath(points)} style={STROKE} />;
});
