import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import { iconForModel } from '@/icons/iec60617/manifest';
import { cn } from '@/lib/cn';
import { usePflowStore } from '@/store/pflow';
import { useUiStore } from '@/store/ui';
import {
  routeMidpoint,
  routePath,
  type ConnectorRoute,
  type LabelPlace,
  type Point,
} from '../connections';
import { draftStrokeStyle } from '../drafts';
import { getLineOverlayState, lineStrokeStyle } from '../overlay';
import { EdgePickBox } from './EdgePickBox';

/**
 * Transformer edge: a branch between two buses with the IEC 60617 2W or
 * 3W glyph half way along.
 *
 * The path is drawn as a line's is (`TopologyEdge`): through the points
 * `connections.ts` works out, its two ends on the bars. The difference is
 * the icon, which is also the transformer's click target. It stands where
 * the canvas found room for it on a straight run of the route
 * (`data.labelAt`), and half way along without one.
 *
 * Click on the icon sets `selectedElement.kind = 'transformer'` so the
 * inspector shows transformer params (Unit 5b populated `_PARAMS_BY_MODEL`
 * for Lines, which carry tap/phi).
 */
interface EdgeData {
  idx?: string;
  name?: string;
  kind?: string;
  bucket?: 'line' | 'transformer';
  route?: ConnectorRoute;
  /** Where the symbol stands on the route; absent: half way along. */
  labelAt?: LabelPlace;
  winding?: '2w' | '3w';
  /** Set on the branch of a draft, with whether the draft can be added and whether it is picked. */
  draft?: boolean;
  ready?: boolean;
  active?: boolean;
}

const ICON_SIZE = 24;

export const TransformerEdge = memo(function TransformerEdge({
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
  // Without a route (the pass has not placed this branch) fall back to the
  // two handles React Flow resolved.
  const points: Point[] = edgeData.route?.points ?? [
    [sourceX, sourceY],
    [targetX, targetY],
  ];
  const path = routePath(points);
  const mid = edgeData.labelAt ?? routeMidpoint(points);

  // Transformers ARE lines on the substrate side; the line-flow
  // computation runs over every Line device regardless of which bucket
  // (lines vs transformers) the substrate routes the entry into. So
  // we read the overlay for both bucket values.
  const branchIdx = edgeData.idx;
  const overlay = branchIdx ? getLineOverlayState(branchIdx, pflowResult, hideLabels) : null;
  // The branch of a draft (a transformer that was placed and names both its
  // buses, but is not in the system yet) is dashed, and so is its symbol.
  const isDraft = edgeData.draft === true;
  const style = isDraft
    ? draftStrokeStyle(edgeData.ready === true, edgeData.active === true)
    : lineStrokeStyle(overlay);
  // A transformer is rated like a line: its icon takes the same outline when it
  // is near or past its rating, and says so to assistive tooling.
  const loadingBand = overlay?.loading_band ?? 'neutral';

  const winding = edgeData.winding ?? '2w';
  const iconSrc = iconForModel(winding === '3w' ? 'Transformer3W' : 'Transformer');

  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={style} />
      {/* Off the icon, which is drawn over the line and takes its own clicks. */}
      <EdgePickBox
        id={id}
        points={points}
        fromBar
        avoid={mid}
        values={pflowResult !== null && !hideLabels}
      />
      <EdgeLabelRenderer>
        <div
          data-testid={`transformer-edge-icon-${id}`}
          data-winding={winding}
          data-loading-band={loadingBand}
          data-draft={isDraft ? 'true' : undefined}
          title={
            isDraft
              ? 'A draft: not in the system yet.'
              : overlay?.loading_status && overlay.loading_label
                ? `${overlay.loading_status}: ${overlay.loading_label} of its rating`
                : undefined
          }
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)`,
            pointerEvents: 'all',
            zIndex: 20,
          }}
          className={cn(
            'bg-background flex h-7 w-7 items-center justify-center rounded-full border',
            isDraft
              ? edgeData.ready === true
                ? 'border-success border-dashed'
                : 'border-warning border-dashed'
              : loadingBand === 'danger'
                ? 'border-danger border-2'
                : loadingBand === 'warning'
                  ? 'border-warning border-2'
                  : 'border-border',
          )}
        >
          <img
            src={iconSrc}
            alt=""
            aria-hidden="true"
            draggable={false}
            style={{ height: ICON_SIZE, width: ICON_SIZE, objectFit: 'contain' }}
          />
          {winding === '3w' ? (
            <span className="bg-warning/20 text-foreground absolute -top-1 -right-1 rounded-[var(--radius-sm)] px-1 font-mono text-[8px] leading-tight">
              3w
            </span>
          ) : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
});
