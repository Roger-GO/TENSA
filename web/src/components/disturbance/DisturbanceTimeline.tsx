import { useMemo, useRef } from 'react';
import type { DisturbanceLocal } from '@/store/disturbance';
import { disturbanceTime, sortedDisturbances } from '@/store/disturbance';
import { cn } from '@/lib/cn';
import { DisturbanceMarker } from './DisturbanceMarker';

/**
 * DisturbanceTimeline — horizontal t-axis strip with one marker per
 * disturbance. Sorted by time; ties broken by insertion order. Two
 * disturbances at the exact same t render as a vertical stack so
 * neither obscures the other.
 *
 * The visible time range is ``[0, tMax]``. ``tMax`` defaults to 10s
 * (matches the v0.2 plan's "Default tMax of 10s, user-editable in
 * TdsConfigPanel — Unit 8") but is configurable via the prop. If any
 * disturbance has a time beyond ``tMax``, the strip extends so the
 * marker is still visible (``Math.max(tMax, maxT * 1.05)``); this is
 * a safety belt — the user-editable tMax in Unit 8 will keep things
 * honest in production.
 *
 * Layout uses inline px positioning under a measured container; the
 * container's width comes from a ``ResizeObserver`` ref. We deliberately
 * skip ``ResizeObserver`` in jsdom (where it's undefined) by falling
 * back to a fixed 600 px width — that's the test-mode width referenced
 * in the timeline tests.
 */

const TEST_MODE_WIDTH = 600;
const STACK_OFFSET_PX = 14;

export interface DisturbanceTimelineProps {
  disturbances: DisturbanceLocal[];
  /** Maximum visible simulation time, in seconds. Default 10. */
  tMax?: number;
  /** Click handler — fires with the marker's id. */
  onMarkerClick?: (id: string) => void;
  className?: string;
}

export function DisturbanceTimeline({
  disturbances,
  tMax = 10,
  onMarkerClick,
  className,
}: DisturbanceTimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Effective tMax: extend if any disturbance lives past the requested
  // window. (Practical edge — keeps a marker visible if the user has
  // bumped a disturbance time beyond the current TdsConfigPanel value.)
  const effectiveTMax = useMemo(() => {
    if (disturbances.length === 0) return tMax;
    const maxT = disturbances.reduce((m, d) => Math.max(m, disturbanceTime(d.spec)), 0);
    return Math.max(tMax, maxT * 1.05);
  }, [disturbances, tMax]);

  const sorted = useMemo(() => sortedDisturbances(disturbances), [disturbances]);

  // Build per-marker (x, yOffset) coords. Stack ties by insertion order
  // along the y axis so they don't overlap visually.
  const positioned = useMemo(() => {
    // Width comes from the container ref at render time. Default to
    // TEST_MODE_WIDTH if the ref isn't measured yet (first paint, jsdom).
    const width = containerRef.current?.getBoundingClientRect().width ?? TEST_MODE_WIDTH;
    const seenT = new Map<number, number>();
    return sorted.map((d) => {
      const t = disturbanceTime(d.spec);
      const stackIdx = seenT.get(t) ?? 0;
      seenT.set(t, stackIdx + 1);
      const x = effectiveTMax === 0 ? 0 : (t / effectiveTMax) * width;
      return { d, x, yOffset: stackIdx * STACK_OFFSET_PX };
    });
  }, [sorted, effectiveTMax]);

  return (
    <div
      data-testid="disturbance-timeline"
      data-effective-tmax={effectiveTMax}
      className={cn('flex flex-col gap-1', className)}
    >
      <div className="text-muted-foreground flex justify-between font-mono text-[10px]">
        <span>0s</span>
        <span data-testid="disturbance-timeline-tmax">{effectiveTMax.toFixed(1)}s</span>
      </div>
      <div
        ref={containerRef}
        className="border-border bg-muted/20 relative h-12 rounded border"
        data-testid="disturbance-timeline-axis"
      >
        {/* Invisible spacer so the axis has a known measurable width even
         *  when there are no markers. */}
        <div className="h-full" />
        {positioned.map(({ d, x, yOffset }) => (
          <DisturbanceMarker
            key={d.id}
            disturbance={d}
            x={x}
            yOffset={yOffset}
            onClick={onMarkerClick}
          />
        ))}
      </div>
    </div>
  );
}
