import type { ReactNode } from 'react';
import type { DisturbanceLocal } from '@/store/disturbance';
import { disturbanceTime } from '@/store/disturbance';
import { cn } from '@/lib/cn';

/**
 * DisturbanceMarker — single SVG glyph on the timeline. Glyph varies by
 * kind (fault = filled circle, toggle = diamond, alter = triangle) so
 * the user can scan the strip and parse what's at each position.
 *
 * Click → fires ``onClick(id)`` so the parent timeline can open the
 * edit dialog. The marker doesn't own the dialog state directly — that
 * belongs to ``DisturbancePanel``.
 *
 * The drag-to-reposition behavior described in the plan's prose is NOT
 * implemented in Unit 6 — the plan calls it out as a "power-user
 * accelerator" and the test scenarios for this unit only require the
 * static marker + click-to-edit pattern. The marker stays simple here so
 * a future Unit can layer drag without a rewrite.
 */

export interface DisturbanceMarkerProps {
  disturbance: DisturbanceLocal;
  /** X position on the timeline (px from the left edge of the t-axis). */
  x: number;
  /**
   * Y offset (px) for stacking when two disturbances share the same time.
   * The first marker at a time renders at offset 0; subsequent ones step
   * upward by ``stackOffset`` * the marker's index in the stack.
   */
  yOffset?: number;
  onClick?: (id: string) => void;
  className?: string;
}

const GLYPH_SIZE = 12;

function glyphForKind(kind: 'fault' | 'toggle' | 'alter'): ReactNode {
  if (kind === 'fault') {
    return (
      <circle
        cx={GLYPH_SIZE / 2}
        cy={GLYPH_SIZE / 2}
        r={GLYPH_SIZE / 2 - 1}
        className="fill-danger"
      />
    );
  }
  if (kind === 'toggle') {
    const half = GLYPH_SIZE / 2;
    return (
      <polygon
        points={`${half},1 ${GLYPH_SIZE - 1},${half} ${half},${GLYPH_SIZE - 1} 1,${half}`}
        className="fill-primary"
      />
    );
  }
  // alter
  return (
    <polygon
      points={`${GLYPH_SIZE / 2},1 ${GLYPH_SIZE - 1},${GLYPH_SIZE - 1} 1,${GLYPH_SIZE - 1}`}
      className="fill-warning"
    />
  );
}

export function DisturbanceMarker({
  disturbance,
  x,
  yOffset = 0,
  onClick,
  className,
}: DisturbanceMarkerProps) {
  const kind = disturbance.spec.kind;
  return (
    <button
      type="button"
      onClick={() => onClick?.(disturbance.id)}
      data-testid={`disturbance-marker-${disturbance.id}`}
      data-kind={kind}
      data-t={disturbanceTime(disturbance.spec)}
      aria-label={`Edit ${kind} at t=${disturbanceTime(disturbance.spec).toFixed(3)}s`}
      title={`${kind} at t=${disturbanceTime(disturbance.spec).toFixed(3)}s`}
      style={{
        position: 'absolute',
        left: x - GLYPH_SIZE / 2,
        bottom: yOffset,
        width: GLYPH_SIZE,
        height: GLYPH_SIZE,
      }}
      className={cn(
        'rounded-full p-0',
        'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        className,
      )}
    >
      <svg viewBox={`0 0 ${GLYPH_SIZE} ${GLYPH_SIZE}`} width={GLYPH_SIZE} height={GLYPH_SIZE}>
        {glyphForKind(kind)}
      </svg>
    </button>
  );
}
