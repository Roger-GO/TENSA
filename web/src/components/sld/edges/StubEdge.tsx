import { memo } from 'react';
import { BaseEdge } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import { routePath, type ConnectorRoute, type Point } from '../connections';
import { draftStrokeStyle } from '../drafts';
import { lineStrokeStyle } from '../overlay';
import { EdgePickBox } from './EdgePickBox';

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
 * The connector of a device that is selected, or under the pointer in a
 * drag, is picked out (`data.active`): heavier, and in the accent colour,
 * the one the ring of a selected node is a tint of. Among the connectors of
 * a crowded bus that shows which one is the device's, and during a drag
 * that it follows the device and where on the bar it lands.
 *
 * The connector of a draft (`data.draft`) is dashed, in the colour of the
 * draft's badge: it is not a conductor of the system yet.
 *
 * No flow overlay, no arrow, no label. Its box is centred on a point of
 * the connector (`EdgePickBox`), so a click on the middle of the element is
 * a click on the connector.
 */
interface StubData {
  kind?: string;
  bucket?: 'generator' | 'load' | 'shunt';
  route?: ConnectorRoute;
  active?: boolean;
  /** Set on the connector of a draft, with whether the draft can be added. */
  draft?: boolean;
  ready?: boolean;
}

const STROKE = lineStrokeStyle(null);
const ACTIVE_STROKE = { stroke: 'var(--color-primary)', strokeWidth: 2.5 };

export const StubEdge = memo(function StubEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps) {
  const stub = data as StubData | undefined;
  const route = stub?.route;
  // Without a route (the pass has not placed this connector) fall back to
  // the two handles React Flow resolved.
  const points: Point[] = route?.points ?? [
    [sourceX, sourceY],
    [targetX, targetY],
  ];
  return (
    <>
      <BaseEdge
        path={routePath(points)}
        style={
          stub?.draft === true
            ? draftStrokeStyle(stub.ready === true, stub.active === true)
            : stub?.active
              ? ACTIVE_STROKE
              : STROKE
        }
      />
      <EdgePickBox id={id} points={points} fromBar={false} />
    </>
  );
});
