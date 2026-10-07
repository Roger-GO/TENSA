import { memo } from 'react';
import { BaseEdge } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import { usePflowStore } from '@/store/pflow';
import { useUiStore } from '@/store/ui';
import {
  routeMidpoint,
  routePath,
  type ConnectorRoute,
  type LabelPlace,
  type Point,
} from '../connections';
import { getLineOverlayState, lineStrokeStyle } from '../overlay';
import { EdgePickBox } from './EdgePickBox';
import { LineFlowArrow } from './LineFlowArrow';
import { LineFlowLabel } from './LineFlowLabel';
import { maxAbsFlowMw } from './lineFlowArrowMath';

/**
 * Topology edge: a line between two buses.
 *
 * It is drawn through the points `connections.ts` works out, with square
 * corners: the bends of the route the diagram keeps for it (the automatic
 * arrangement's, a saved layout's, or one made as the diagram was drawn:
 * `routing.ts`), or a route stepped from tap to tap where no way was found
 * for one. Either way its two ends are taps on the bars, which `BusNode`
 * marks with a dot, so both edge types that carry a line (`topology` and
 * `routed`) are drawn by this one component.
 *
 * After a power flow a line (`data.bucket === 'line'`) carries an arrow and
 * a magnitude label, at the place the canvas found for them on a straight run
 * of the route (`data.labelAt`; half way along without one). The label stands
 * on the line there, or beside it where the line has no room for it
 * (`data.labelAt.label`), turned to read upwards where only an upright
 * run has the room (`data.labelAt.turned`), and is left off where no place
 * has (`data.labelAt.hidden`: it would be drawn over a symbol, another label
 * or another line). The arrow lies along the run it sits on and points the
 * way the active power flows; the stroke turns amber or red, and heavier, as
 * the line nears or passes its rating.
 *
 * The box of the edge is centred on a point of the line (`EdgePickBox`), so
 * a click on the middle of the element is a click on the line, however the
 * line turns.
 */
interface EdgeData {
  idx?: string;
  name?: string;
  kind?: string;
  bucket?: 'line' | 'transformer';
  route?: ConnectorRoute;
  /** Where the arrow and the flow label stand on the route; absent: half way along. */
  labelAt?: LabelPlace;
}

export const TopologyEdge = memo(function TopologyEdge({
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
  // Without a route (the pass has not placed this line) fall back to the
  // two handles React Flow resolved.
  const points: Point[] = edgeData.route?.points ?? [
    [sourceX, sourceY],
    [targetX, targetY],
  ];
  const mid = edgeData.labelAt ?? routeMidpoint(points);
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
  // The arrow is sized against the largest branch flow of the case, not a fixed
  // 1000 MW, so a 100 MVA case gets arrows as telling as a 10 GW one.
  const lineFlowSatMw = pflowResult?.line_flows ? maxAbsFlowMw(pflowResult.line_flows) : undefined;

  // Style: a heavier stroke once we have flow data, amber or red as the line
  // nears or passes its rating; muted otherwise.
  const { stroke, strokeWidth } = lineStrokeStyle(overlay);

  return (
    <>
      <BaseEdge path={routePath(points)} markerEnd={markerEnd} style={{ stroke, strokeWidth }} />
      <EdgePickBox id={id} points={points} fromBar />
      {overlay && overlay.has_data && overlay.direction !== 'neutral' ? (
        <LineFlowArrow
          x={mid.x}
          y={mid.y}
          angleDeg={mid.angleDeg}
          direction={overlay.direction}
          absMw={lineFlowAbsMw}
          satMw={lineFlowSatMw}
          testid={`line-flow-arrow-${id}`}
        />
      ) : null}
      {overlay && edgeData.labelAt?.hidden !== true ? (
        <LineFlowLabel
          id={id}
          x={edgeData.labelAt?.label?.x ?? mid.x}
          y={edgeData.labelAt?.label?.y ?? mid.y}
          side={edgeData.labelAt?.label?.side}
          turned={edgeData.labelAt?.turned === true}
          overlay={overlay}
          hideLabels={hideLabels}
        />
      ) : null}
    </>
  );
});
