import { memo } from 'react';
import type { Point } from '../connections';
import { pickBox, pickPoint, type PickOptions } from './pickPoint';

/**
 * The box of an edge, centred on a point of its line (`pickPoint.ts`): a
 * rectangle that is not drawn and takes no click itself. With it the box
 * the browser reports for the edge has its middle on the line, so whatever
 * clicks the middle of the element (an assistive tool, a test, an assistant
 * that drives the page) clicks the line, and a straight line has a box at
 * all.
 */
export const EdgePickBox = memo(function EdgePickBox({
  id,
  points,
  fromBar,
  avoid,
  values,
}: { id: string; points: readonly Point[] } & PickOptions) {
  const at = pickPoint(points, { fromBar, avoid, values });
  return (
    <rect
      data-testid={`edge-pick-box-${id}`}
      data-pick-at={`${at[0]},${at[1]}`}
      {...pickBox(points, at)}
      fill="none"
      stroke="none"
      pointerEvents="none"
    />
  );
});
