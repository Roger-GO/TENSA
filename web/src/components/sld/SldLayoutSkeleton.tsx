import { cn } from '@/lib/cn';

/**
 * SldLayoutSkeleton. Renders while `autoLayout()` is in flight on the
 * SLD canvas. Per the interaction-state matrix:
 *
 * - 5-7 grey rounded-rectangle placeholder nodes (`bg-muted`, `--radius-md`)
 *   arranged in a vague 3-row layered pattern that mimics the eventual
 *   SLD's hierarchical bus banding.
 * - "Computing layout…" caption below.
 * - Soft fade-in over 300ms (`--duration-slow`).
 *
 * Visual intent: the user sees that the canvas is "thinking", not that
 * it is empty — the EmptyState ("No case loaded") is reserved for the
 * pre-load state and would be misleading here.
 */
export interface SldLayoutSkeletonProps {
  className?: string;
}

const ROW_LAYOUTS: readonly { x: number; y: number }[][] = [
  [
    { x: 80, y: 30 },
    { x: 220, y: 30 },
    { x: 360, y: 30 },
  ],
  [
    { x: 130, y: 110 },
    { x: 290, y: 110 },
  ],
  [
    { x: 80, y: 190 },
    { x: 360, y: 190 },
  ],
];

export function SldLayoutSkeleton({ className }: SldLayoutSkeletonProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Computing layout"
      data-testid="sld-layout-skeleton"
      className={cn(
        'flex h-full w-full flex-col items-center justify-center gap-4',
        'p-6 text-center',
        // Soft fade-in so the skeleton doesn't pop in jarringly.
        'animate-[skeleton-fade_300ms_ease-out]',
        className,
      )}
    >
      <svg
        viewBox="0 0 480 270"
        className="text-muted h-[180px] w-[320px] max-w-full"
        aria-hidden="true"
      >
        {ROW_LAYOUTS.flatMap((row, rowIdx) =>
          row.map((node, nodeIdx) => (
            <rect
              key={`${rowIdx}-${nodeIdx}`}
              x={node.x}
              y={node.y}
              width={60}
              height={40}
              rx={6}
              ry={6}
              className="fill-muted"
            />
          )),
        )}
      </svg>
      <p className="text-muted-foreground text-xs">Computing layout…</p>
    </div>
  );
}
