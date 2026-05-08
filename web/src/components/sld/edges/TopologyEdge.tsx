import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import { usePflowStore } from '@/store/pflow';
import { useUiStore } from '@/store/ui';
import { getLineOverlayState } from '../overlay';

/**
 * Topology edge. Connects two bus nodes via a polyline (orthogonal
 * smooth-step path — NOT bezier).
 *
 * Unit 9: when post-PF + the edge's bucket is `line`, render a
 * directional arrow + a magnitude label at the midpoint. Color encoding
 * stays neutral; the directional arrow itself is the dominant visual
 * cue. The edge `data.bucket` field (set in `graph.ts`) tells us
 * whether to look the line up in `pflowResult.line_flows`.
 */
interface EdgeData {
  idx?: string;
  name?: string;
  kind?: string;
  bucket?: 'line' | 'transformer';
}

export const TopologyEdge = memo(function TopologyEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps) {
  const pflowResult = usePflowStore((s) => s.lastRun);
  const hideLabels = useUiStore((s) => s.hideLabels);
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 4,
  });
  const edgeData = (data ?? {}) as EdgeData;
  const isLine = edgeData.bucket === 'line';
  const lineIdx = edgeData.idx;
  const overlay = isLine && lineIdx ? getLineOverlayState(lineIdx, pflowResult, hideLabels) : null;

  // Style: thicker / colored stroke when we have flow data; neutral
  // otherwise. The arrow direction is encoded via the marker plus a
  // small inline glyph in the label (forward vs. reverse).
  const stroke = overlay?.has_data ? 'var(--color-foreground)' : 'var(--color-border)';
  const strokeWidth = overlay?.has_data ? 1.8 : 1.5;

  return (
    <>
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={{ stroke, strokeWidth }} />
      {overlay && overlay.has_data && (overlay.p_label !== null || overlay.q_label !== null) ? (
        <EdgeLabelRenderer>
          <div
            data-testid={`line-flow-label-${id}`}
            data-direction={overlay.direction}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'none',
            }}
            className="bg-background/80 text-foreground border-border rounded-[var(--radius-sm)] border px-1.5 py-0.5 font-mono text-[10px] leading-tight shadow-sm"
          >
            <div className="flex items-center gap-1">
              <span aria-hidden="true">
                {overlay.direction === 'forward' ? '→' : overlay.direction === 'reverse' ? '←' : ''}
              </span>
              {overlay.p_label !== null ? <span>{overlay.p_label}</span> : null}
            </div>
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
});
