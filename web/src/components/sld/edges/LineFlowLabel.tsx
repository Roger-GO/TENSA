import { EdgeLabelRenderer } from '@xyflow/react';
import { cn } from '@/lib/cn';
import type { LineOverlayState } from '../overlay';

export interface LineFlowLabelProps {
  /** The edge id; the test hooks hang off it. */
  id: string;
  /**
   * Where the label is hung (canvas units): its middle on the line, or with
   * `side` the middle of the edge it turns to the line it stands beside.
   */
  x: number;
  y: number;
  /** The side of its line the label stands on; absent: on the line. */
  side?: 'left' | 'right' | 'above' | 'below';
  overlay: LineOverlayState;
  hideLabels: boolean;
}

/** How a label hung at a point is moved so that the point is where it should be on it. */
const HUNG_BY: Record<NonNullable<LineFlowLabelProps['side']> | 'on', string> = {
  on: 'translate(-50%, -50%)',
  left: 'translate(-100%, -50%)',
  right: 'translate(0, -50%)',
  above: 'translate(-50%, -100%)',
  below: 'translate(-50%, 0)',
};

/**
 * The label of a line: the direction of the flow with its MW, and, for a line
 * the case rates, its loading in percent of the rating. It stands on the line
 * at the place the canvas found for it, or beside the line there (`side`),
 * hung by the edge it turns to the line. The
 * label outlines in amber or red when the line is near or past its rating, and
 * the percentage is the colour-free sign of it. It follows the Labels / Hide
 * toggle, except that a line near or past its rating keeps its percentage, as
 * a bus near a voltage limit keeps its marker.
 */
export function LineFlowLabel({ id, x, y, side, overlay, hideLabels }: LineFlowLabelProps) {
  const flagged = overlay.loading_status !== null;
  const showLoading = overlay.loading_label !== null && (!hideLabels || flagged);
  if (!overlay.has_data || (overlay.p_label === null && !showLoading)) return null;
  const band = overlay.loading_band;
  return (
    <EdgeLabelRenderer>
      <div
        data-testid={`line-flow-label-${id}`}
        data-direction={overlay.direction}
        data-loading-band={band}
        data-beside={side}
        style={{
          position: 'absolute',
          transform: `${HUNG_BY[side ?? 'on']} translate(${x}px, ${y}px)`,
          pointerEvents: 'none',
          zIndex: 20,
        }}
        className={cn(
          'bg-background text-foreground rounded-[var(--radius-sm)] border px-1.5 py-0.5',
          'font-mono text-[10px] leading-tight shadow-sm',
          band === 'danger'
            ? 'border-danger'
            : band === 'warning'
              ? 'border-warning'
              : 'border-border',
        )}
      >
        <div className="flex items-center gap-1">
          {overlay.p_label !== null ? (
            <>
              <span aria-hidden="true">
                {overlay.direction === 'forward' ? '→' : overlay.direction === 'reverse' ? '←' : ''}
              </span>
              <span>{overlay.p_label}</span>
            </>
          ) : null}
          {showLoading ? (
            <span
              data-testid={`line-loading-${id}`}
              title={overlay.loading_status ?? undefined}
              className={cn(
                overlay.p_label !== null ? 'text-muted-foreground' : '',
                flagged ? 'text-foreground font-semibold' : '',
              )}
            >
              {overlay.loading_label}
            </span>
          ) : null}
        </div>
      </div>
    </EdgeLabelRenderer>
  );
}
